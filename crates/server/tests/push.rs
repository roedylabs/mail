//! Web Push against a push service in the test: API with
//! VAPID key, subscriptions and test message, job `push_sender` with texts
//! from the event catalog, quiet hours (security immediately), retries and
//! unsubscribed browsers. The "browser" decrypts every message like a real
//! one (RFC 8291).

use std::{
    collections::VecDeque,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{State, connect_info::MockConnectInfo},
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt as _;
use jiff::Timestamp;
use ring::{
    agreement::{self, ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey},
    rand::{SecureRandom as _, SystemRandom},
};
use roedy_mail_server::{
    api::{self, push::test_text},
    app::{AppState, router},
    auth::{
        device::Device,
        password::{Hasher, Params},
        session,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            notification_deliveries::{self, Channel, Pending},
            notifications, push_subscriptions,
            users::{self, NewUser, Role},
        },
    },
    events::{self, Account, Outbox, Security, texts},
    jobs::push_sender::{self, RETRY},
    push::ece,
    settings::{self, Language, Settings},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const ENDPOINT: &str = "https://push.example.com/wpush/v2/device-1";
/// 23:30 in Berlin (default quiet hours: 22:00 to 07:00).
const NIGHT: &str = "2026-11-04T22:30:00Z";
/// 08:30 in Berlin.
const MORNING: &str = "2026-11-05T07:30:00Z";

/// What arrives at the push service.
struct Received {
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// Push service in the test: accepts everything (201) unless `answers`
/// names something else in turn.
#[derive(Clone, Default)]
struct PushService {
    received: Arc<Mutex<Vec<Received>>>,
    answers: Arc<Mutex<VecDeque<StatusCode>>>,
}

impl PushService {
    async fn start() -> (Self, String) {
        let service = Self::default();
        let app = Router::new().fallback(receive).with_state(service.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (service, url)
    }

    fn answer(&self, status: StatusCode) {
        self.answers.lock().unwrap().push_back(status);
    }

    fn count(&self) -> usize {
        self.received.lock().unwrap().len()
    }

    fn take(&self) -> Vec<Received> {
        std::mem::take(&mut *self.received.lock().unwrap())
    }
}

async fn receive(State(service): State<PushService>, request: Request<Body>) -> StatusCode {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let body: Bytes = request.into_body().collect().await.unwrap().to_bytes();
    service.received.lock().unwrap().push(Received {
        path,
        headers,
        body: body.to_vec(),
    });
    service
        .answers
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or(StatusCode::CREATED)
}

/// A browser with key pair and secret; `ring` allows one key exchange per
/// key, so one message to read.
struct Browser {
    key: Option<EphemeralPrivateKey>,
    public: Vec<u8>,
    auth: [u8; 16],
}

impl Browser {
    fn new() -> Self {
        let rng = SystemRandom::new();
        let key = EphemeralPrivateKey::generate(&ECDH_P256, &rng).unwrap();
        let public = key.compute_public_key().unwrap().as_ref().to_vec();
        let mut auth = [0; 16];
        rng.fill(&mut auth).unwrap();
        Self {
            key: Some(key),
            public,
            auth,
        }
    }

    fn json(&self, endpoint: &str) -> Value {
        json!({
            "endpoint": endpoint,
            "expirationTime": null,
            "keys": {
                "p256dh": URL_SAFE_NO_PAD.encode(&self.public),
                "auth": URL_SAFE_NO_PAD.encode(self.auth),
            },
        })
    }

    fn read(&mut self, body: &[u8]) -> Value {
        let peer = UnparsedPublicKey::new(&ECDH_P256, ece::sender_key(body).unwrap().to_vec());
        let ecdh =
            agreement::agree_ephemeral(self.key.take().unwrap(), &peer, <[u8]>::to_vec).unwrap();
        let plain = ece::decrypt(&ecdh, &self.auth, &self.public, body).unwrap();
        serde_json::from_slice(&plain).unwrap()
    }
}

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
}

struct Reply {
    status: StatusCode,
    body: String,
    cookie: Option<String>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let config = Config {
        public_url: Some(Url::parse("https://app.example.com").unwrap()),
        ..Config::default()
    };
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    Env { _tmp: tmp, state }
}

impl Env {
    async fn sql<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut rusqlite::Connection) -> anyhow::Result<T> + Send + 'static,
    ) -> T {
        db::call(&self.state.db, f).await.unwrap()
    }

    /// Creates `username` with the settings from `adjust`.
    async fn add(&self, username: &str, adjust: impl FnOnce(&mut Settings)) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let mut wanted = Settings::default();
        adjust(&mut wanted);
        let username = username.to_owned();
        self.sql(move |conn| {
            let id = users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &format!("{username}@example.com"),
                    display_name: "Max Mustermann",
                    role: Role::User,
                    password_hash: &hash,
                },
            )?;
            settings::save(conn, &id, 0, &wanted)?;
            Ok(id)
        })
        .await
    }

    /// Subscribes `browser` for `user` at the push service `url` (own session).
    async fn subscribe(&self, user: &str, url: &str, browser: &Browser) -> String {
        let (user, endpoint) = (
            user.to_owned(),
            format!("{url}/wpush/{}", db::new_id().unwrap()),
        );
        let (p256dh, auth) = (browser.public.clone(), browser.auth);
        self.sql(move |conn| {
            let session = db::new_id()?;
            conn.execute(
                "INSERT INTO sessions (id, user_id, token_hash, expires_at) \
                 VALUES (?1, ?2, randomblob(32), '2999-01-01T00:00:00Z')",
                [&session, &user],
            )?;
            let new = push_subscriptions::New {
                endpoint: &endpoint,
                p256dh: &p256dh,
                auth: &auth,
                expires_at: None,
            };
            Ok(push_subscriptions::upsert(conn, &user, &session, &new)?.0)
        })
        .await
    }

    async fn pending(&self, user: &str) -> Vec<Pending> {
        let user = user.to_owned();
        self.sql(move |conn| {
            notification_deliveries::pending(conn, Channel::Push, &user, "2999-01-01T00:00:00Z")
        })
        .await
    }

    async fn run(&self, now: &str) {
        push_sender::run_at(&self.state, now.parse().unwrap())
            .await
            .unwrap();
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, FIREFOX);
        if let Some(session) = session {
            builder = builder.header(header::COOKIE, format!("{}={session}", session::COOKIE));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .unwrap();
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let prefix = format!("{}=", session::COOKIE);
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                let value = c.to_str().ok()?.strip_prefix(&prefix)?;
                Some(value.split(';').next()?.to_owned())
            });
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            cookie,
        }
    }

    async fn session(&self, username: &str) -> String {
        let reply = self
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({ "login": username, "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie.unwrap()
    }
}

fn header<'a>(received: &'a Received, name: &str) -> &'a str {
    received.headers.get(name).unwrap().to_str().unwrap()
}

/// Push on globally, for account and security.
fn push_on(settings: &mut Settings) {
    settings.n_ch.push = true;
    settings.n_mx.account.push = true;
}

/// URL of the push icon with version.
fn push_icon(state: &AppState) -> String {
    format!(
        "/branding/push-icon.png?v={}",
        state.brand().push_icon().unwrap().version
    )
}

#[tokio::test]
async fn api_registers_lists_and_removes_browsers() {
    let env = env().await;
    env.add("max", |_| {}).await;
    env.add("eva", |_| {}).await;
    let max = env.session("max").await;
    let eva = env.session("eva").await;

    let reply = env
        .request(Method::GET, "/push/vapid-public-key", None, None)
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = env
        .request(Method::GET, "/push/vapid-public-key", None, Some(&max))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let key = reply.json()["key"].as_str().unwrap().to_owned();
    let raw = URL_SAFE_NO_PAD.decode(&key).unwrap();
    assert_eq!((raw.len(), raw[0]), (65, 4));
    let again = env
        .request(Method::GET, "/push/vapid-public-key", None, Some(&eva))
        .await;
    assert_eq!(again.json()["key"], json!(key), "one key per instance");

    let browser = Browser::new();
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(browser.json(ENDPOINT)),
            Some(&max),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let created = reply.json();
    assert_eq!(created["endpoint"], json!(ENDPOINT));
    assert_eq!(created["current"], json!(true));
    assert_eq!(created["device"], json!("Firefox on Linux"));
    let id = created["id"].as_str().unwrap().to_owned();
    // The same browser subscribes again: the same subscription.
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(browser.json(ENDPOINT)),
            Some(&max),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["id"], json!(id));

    let mut wrong = browser.json("http://push.example.com/x");
    wrong["keys"]["p256dh"] = json!(URL_SAFE_NO_PAD.encode([4; 65]));
    wrong["keys"]["auth"] = json!("short");
    let reply = env
        .request(Method::POST, "/push/subscriptions", Some(wrong), Some(&max))
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let fields = &reply.json()["fields"];
    for field in ["endpoint", "keys.p256dh", "keys.auth"] {
        assert_eq!(fields[field]["code"], json!("invalid"), "{field}");
    }
    let mut expired = browser.json(ENDPOINT);
    expired["expirationTime"] = json!(1_000_000_000_000_i64);
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(expired),
            Some(&max),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"]["expirationTime"]["code"],
        json!("expired")
    );
    let private = browser.json("https://192.168.1.10/x");
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(private),
            Some(&max),
        )
        .await;
    assert_eq!(reply.json()["fields"]["endpoint"]["code"], json!("private"));

    let list = env
        .request(Method::GET, "/push/subscriptions", None, Some(&max))
        .await
        .json();
    assert_eq!(list["subscriptions"].as_array().unwrap().len(), 1);
    let list = env
        .request(Method::GET, "/push/subscriptions", None, Some(&eva))
        .await
        .json();
    assert_eq!(list["subscriptions"], json!([]));

    let path = format!("/push/subscriptions/{id}");
    let reply = env.request(Method::DELETE, &path, None, Some(&eva)).await;
    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "another user's subscription"
    );
    let reply = env.request(Method::DELETE, &path, None, Some(&max)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = env.request(Method::DELETE, &path, None, Some(&max)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn subscription_ends_with_the_session() {
    let env = env().await;
    env.add("max", |_| {}).await;
    let max = env.session("max").await;
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(Browser::new().json(ENDPOINT)),
            Some(&max),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let reply = env
        .request(Method::POST, "/auth/logout", None, Some(&max))
        .await;
    assert!(reply.status.is_success(), "{}", reply.body);
    let count = env
        .sql(|conn| {
            Ok(
                conn.query_row("SELECT count(*) FROM push_subscriptions", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            )
        })
        .await;
    assert_eq!(count, 0);
}

#[tokio::test]
async fn test_message_reaches_this_device() {
    let env = env().await;
    let (service, url) = PushService::start().await;
    // In the person's language (not the default), the device name too.
    env.add("max", |s| s.lang = Language::German).await;
    let max = env.session("max").await;
    let reply = env
        .request(Method::POST, "/push/test", None, Some(&max))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"], json!("no_subscription"));

    let mut browser = Browser::new();
    let reply = env
        .request(
            Method::POST,
            "/push/subscriptions",
            Some(browser.json(ENDPOINT)),
            Some(&max),
        )
        .await;
    // The test service runs on 127.0.0.1, which the API rightly rejects.
    let endpoint = format!("{url}/wpush/device-1");
    let id = reply.json()["id"].as_str().unwrap().to_owned();
    let stored = endpoint.clone();
    env.sql(move |conn| {
        conn.execute(
            "UPDATE push_subscriptions SET endpoint = ?1 WHERE id = ?2",
            [&stored, &id],
        )?;
        Ok(())
    })
    .await;
    let key = env
        .request(Method::GET, "/push/vapid-public-key", None, Some(&max))
        .await
        .json()["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let reply = env
        .request(Method::POST, "/push/test", None, Some(&max))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), json!({ "sent": 1 }));
    let received = service.take();
    assert_eq!(received.len(), 1);
    let one = &received[0];
    assert_eq!(one.path, "/wpush/device-1");
    assert_eq!(header(one, "content-encoding"), "aes128gcm");
    assert_eq!(header(one, "ttl"), "300");
    assert_eq!(header(one, "urgency"), "high");
    let auth = header(one, "authorization");
    assert!(auth.starts_with("vapid t="), "{auth}");
    assert!(auth.ends_with(&format!(", k={key}")), "{auth}");
    let claims = auth
        .strip_prefix("vapid t=")
        .unwrap()
        .split('.')
        .nth(1)
        .unwrap();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
    assert_eq!(claims["aud"], json!(url));
    assert_eq!(claims["sub"], json!("https://app.example.com"));
    assert_eq!(
        browser.read(&one.body),
        json!({
            "title": "Roedy Mail",
            "body": test_text(Language::German),
            "icon": push_icon(&env.state),
            "tag": "push-test",
            "data": { "url": "/start" },
        })
    );

    let list = env
        .request(Method::GET, "/push/subscriptions", None, Some(&max))
        .await
        .json();
    let device = list["subscriptions"][0]["device"].as_str().unwrap();
    assert_eq!(
        device,
        Device::parse(Some(FIREFOX)).label(Language::German),
        "{device}"
    );

    // The browser has unsubscribed at the push service.
    service.answer(StatusCode::GONE);
    let reply = env
        .request(Method::POST, "/push/test", None, Some(&max))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    let list = env
        .request(Method::GET, "/push/subscriptions", None, Some(&max))
        .await
        .json();
    assert_eq!(list["subscriptions"], json!([]));
}

#[tokio::test]
async fn job_sends_events_with_text_target_and_tag() {
    let env = env().await;
    let (service, url) = PushService::start().await;
    let max = env.add("max", push_on).await;
    let mut browser = Browser::new();
    env.subscribe(&max, &url, &browser).await;

    let id = max.clone();
    let notification = env
        .sql(move |conn| {
            let event = Account::Profile {
                name: true,
                username: false,
            };
            assert!(events::account(conn, &id, event)?);
            Ok(notifications::list(conn, &id)?.remove(0))
        })
        .await;
    let pending = env.pending(&max).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].notification_id.as_deref(),
        Some(notification.id.as_str())
    );

    env.run(MORNING).await;
    let received = service.take();
    assert_eq!(received.len(), 1);
    assert_eq!(header(&received[0], "urgency"), "normal");
    assert_eq!(header(&received[0], "ttl"), "86400");
    let shown = texts::render(
        &notification.topic,
        &notification.kind,
        &notification.params,
        &texts::Context {
            lang: Settings::default().lang,
            app: "Roedy Mail",
        },
    );
    assert!(!shown.text.is_empty());
    assert_eq!(
        browser.read(&received[0].body),
        json!({
            "title": shown.title,
            "body": shown.text,
            "icon": push_icon(&env.state),
            "tag": notification.id,
            "data": { "url": shown.target.unwrap().path() },
        })
    );
    assert!(env.pending(&max).await.is_empty());

    // Without the app the ID of the pending entry is the `tag`.
    let without_app = env
        .add("eva", |s| {
            push_on(s);
            s.n_mx.account.app = false;
        })
        .await;
    let mut other = Browser::new();
    env.subscribe(&without_app, &url, &other).await;
    let id = without_app.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: false,
            username: true,
        };
        events::account(conn, &id, event)
    })
    .await;
    let queued = env.pending(&without_app).await.remove(0);
    assert_eq!(queued.notification_id, None);
    env.run(MORNING).await;
    let message = other.read(&service.take()[0].body);
    assert_eq!(message["tag"], json!(queued.id));
}

#[tokio::test]
async fn quiet_hours_hold_back_all_but_security() {
    let env = env().await;
    let (service, url) = PushService::start().await;
    let max = env
        .add("max", |s| {
            push_on(s);
            s.n_quiet = true;
        })
        .await;
    env.subscribe(&max, &url, &Browser::new()).await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)?;
        let to = events::Recipient {
            id: &id,
            email: "max@example.com",
            name: "Max Mustermann",
        };
        events::security(
            conn,
            &mut Outbox::default(),
            to,
            Security::MfaReset { by: "Anna Becker" },
        )?;
        Ok(())
    })
    .await;
    assert_eq!(env.pending(&max).await.len(), 2);

    env.run(NIGHT).await;
    let received = service.take();
    assert_eq!(received.len(), 1, "security arrives immediately");
    assert_eq!(header(&received[0], "urgency"), "high");
    let left = env.pending(&max).await;
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].topic, "account");

    env.run(MORNING).await;
    let received = service.take();
    assert_eq!(received.len(), 1, "at the end of the quiet hours");
    assert_eq!(header(&received[0], "urgency"), "normal");
    assert!(env.pending(&max).await.is_empty());
}

#[tokio::test]
async fn retries_later_and_removes_gone_browsers() {
    let env = env().await;
    let (service, url) = PushService::start().await;
    let max = env.add("max", push_on).await;
    let browser = Browser::new();
    env.subscribe(&max, &url, &browser).await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)
    })
    .await;

    service.answer(StatusCode::SERVICE_UNAVAILABLE);
    env.run(MORNING).await;
    assert_eq!(service.count(), 1);
    let pending = env.pending(&max).await;
    assert_eq!(pending[0].attempts, 1);
    let morning: Timestamp = MORNING.parse().unwrap();
    let soon = morning.checked_add(RETRY).unwrap();
    env.run(
        &soon
            .checked_sub(jiff::SignedDuration::from_secs(1))
            .unwrap()
            .to_string(),
    )
    .await;
    assert_eq!(service.count(), 1, "waits {RETRY:?}");

    service.answer(StatusCode::GONE);
    env.run(&soon.to_string()).await;
    assert_eq!(service.count(), 2);
    assert!(env.pending(&max).await.is_empty());
    let id = max.clone();
    let left = env
        .sql(move |conn| Ok(push_subscriptions::of_user(conn, &id)?))
        .await;
    assert!(left.is_empty(), "unsubscribed browser removed");

    // Without a browser `events` no longer queues anything.
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)
    })
    .await;
    assert!(env.pending(&max).await.is_empty());
}

/// Expired sessions (idle or lifetime) get nothing any more, even before
/// `session_cleanup` deletes them.
#[tokio::test]
async fn expired_sessions_get_no_push() {
    let env = env().await;
    let (service, url) = PushService::start().await;
    let max = env.add("max", push_on).await;
    env.subscribe(&max, &url, &Browser::new()).await;
    let id = max.clone();
    env.sql(move |conn| {
        conn.execute(
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?1",
            [&id],
        )?;
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)
    })
    .await;

    env.run(MORNING).await;
    assert_eq!(service.count(), 0);
}

#[tokio::test]
async fn expired_browsers_are_removed() {
    let env = env().await;
    let max = env.add("max", push_on).await;
    let (_service, url) = PushService::start().await;
    let subscription = env.subscribe(&max, &url, &Browser::new()).await;
    env.sql(move |conn| {
        conn.execute(
            "UPDATE push_subscriptions SET expires_at = '2026-11-05T07:00:00.000Z' WHERE id = ?1",
            [&subscription],
        )?;
        Ok(())
    })
    .await;
    env.run(NIGHT).await;
    let id = max.clone();
    assert_eq!(
        env.sql(move |conn| Ok(push_subscriptions::of_user(conn, &id)?))
            .await
            .len(),
        1
    );
    env.run(MORNING).await;
    let id = max.clone();
    assert!(
        env.sql(move |conn| Ok(push_subscriptions::of_user(conn, &id)?))
            .await
            .is_empty()
    );
}
