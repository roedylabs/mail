//! Mail server registry, token broker and system mails against a real
//! Stalwart v1: DCR with the admin's app password, taking over the secret
//! (proven by a sign-in whose code the backend exchanges with it),
//! diagnostics, registration errors, manually created clients; strict
//! rotation, revocation on removal, new sign-in after the migration and system
//! mails with app password; "check connection" with `Quota/get`, revoking the
//! old grant on re-sign-in and on deleting the app account; job `quota_check`
//! with "storage almost full"; notifications by email via the job
//! `notification_mailer`.
//!
//! The tests need the local Stalwart from `scripts/dev/stalwart.sh` and
//! therefore only run on request (not in CI):
//!
//! ```sh
//! scripts/dev/stalwart.sh run \
//!   cargo test -p roedy-mail-server --test stalwart_v1 -- --ignored
//! ```
//!
//! URL and credentials come from `STALWART_URL` and `STALWART_CREDENTIALS`
//! (fields in the header of `scripts/dev/stalwart.mjs`); none of them
//! appears in a message.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::session::{self, Client},
    broker::{crypto::SecretKey, dcr, http_client, oauth},
    config::Config,
    db::{
        self, Db,
        repo::{
            mail_accounts, notification_deliveries, notifications,
            servers::{self, SECRET_PURPOSE},
            users::{self, NewUser, Role},
        },
    },
    events::{self, Account, schedule::Schedule},
    jobs::{notification_mailer, quota_check},
    mailer::{
        self, Mail, Mailer,
        system_mail::{self, SystemMail},
    },
    random,
    settings::{self, Digest as Rhythm, Settings},
    web::static_files::WebAssets,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tower::ServiceExt as _;
use url::Url;

/// Public URL of the app; Stalwart only accepts `http://` for loopback.
const APP: &str = "http://127.0.0.1:8080";

#[derive(Deserialize)]
struct Access {
    url: String,
    admin: Login,
    user: Login,
    #[serde(rename = "oauthClient")]
    oauth_client: OAuthClient,
}

#[derive(Deserialize)]
struct Login {
    login: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    password: String,
    #[serde(rename = "appPassword")]
    app_password: String,
    #[serde(default, rename = "accountId")]
    account_id: String,
}

#[derive(Deserialize)]
struct OAuthClient {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "clientSecret")]
    client_secret: String,
}

fn access() -> Access {
    let path = std::env::var("STALWART_CREDENTIALS")
        .expect("STALWART_CREDENTIALS missing – start via scripts/dev/stalwart.sh run");
    let text = std::fs::read_to_string(path).expect("credentials not readable");
    let access: Access = serde_json::from_str(&text).expect("credentials invalid");
    assert_eq!(
        std::env::var("STALWART_URL").ok().as_deref(),
        Some(access.url.as_str())
    );
    access
}

struct Setup {
    _tmp: tempfile::TempDir,
    state: AppState,
    admin: String,
}

async fn setup() -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    let config = Config::default();
    let state = AppState::new(
        db,
        Arc::new(WebAssets::None),
        &config,
        Url::parse(APP).unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.load().await.unwrap();
    let admin = db::call(&state.db, |conn| {
        let id = users::insert(
            conn,
            &NewUser {
                username: "admin",
                email: "admin@example.com",
                display_name: "Erika Muster",
                role: Role::Admin,
                password_hash: "$argon2id$test",
            },
        )?;
        start_session(conn, &id)
    })
    .await
    .unwrap();
    Setup {
        _tmp: tmp,
        state,
        admin,
    }
}

/// Starts a session of the user; the token from the cookie.
fn start_session(conn: &rusqlite::Connection, user_id: &str) -> anyhow::Result<String> {
    let started = session::start(conn, user_id, &Client::default(), true)?;
    let cookie = started.cookie.to_str()?.to_owned();
    Ok(cookie
        .strip_prefix(&format!("{}=", session::COOKIE))
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_owned())
}

impl Setup {
    /// Request to the API as administrator; status and JSON of the response.
    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1/{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(
                header::COOKIE,
                format!("{}={}", session::COOKIE, self.admin),
            );
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4711))));
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    async fn register(&self, url: &str, login: &Login) -> (StatusCode, Value) {
        self.send(
            Method::POST,
            "admin/servers/register-client",
            Some(json!({ "url": url, "username": login.login, "password": login.app_password })),
        )
        .await
    }

    /// "Test connection": the three rows and the reasons.
    async fn test(&self, id: &str) -> (Value, Value) {
        let (status, reply) = self
            .send(Method::POST, &format!("admin/servers/{id}/test"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        let server = &reply["server"];
        (
            json!([server["reach"], server["cors"], server["oauth"]]),
            reply["reasons"].clone(),
        )
    }

    async fn stored_secret(&self, id: &str) -> Option<String> {
        let lookup = id.to_owned();
        let sealed: Option<Vec<u8>> = db::call(&self.state.db, move |conn| {
            Ok(conn.query_row(
                "SELECT oauth_client_secret_enc FROM servers WHERE id = ?1",
                [lookup],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
        sealed.map(|sealed| {
            let secret = self.state.secrets.open(SECRET_PURPOSE, id, &sealed);
            String::from_utf8(secret.unwrap()).unwrap()
        })
    }
}

impl Setup {
    /// Registers a confidential client, creates the server and connects the
    /// user's account via a real sign-in (code exchange in the backend); IDs of
    /// server and mail account and the client ID.
    async fn connect(&self, access: &Access) -> (String, String, String) {
        let (status, reply) = self.register(&access.url, &access.admin).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        let client_id = reply["client_id"].as_str().unwrap().to_owned();
        let (status, server) = self
            .send(
                Method::POST,
                "admin/servers",
                Some(json!({ "label": "Local", "url": access.url, "client_id": client_id })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{server}");
        let server = server["id"].as_str().unwrap().to_owned();
        let account = self.sign_in(access, &server, &client_id).await;
        (server, account, client_id)
    }

    /// Connects the user's account with a new sign-in.
    async fn sign_in(&self, access: &Access, server: &str, client_id: &str) -> String {
        let (code, verifier) = authorize(&access.url, client_id, &access.user).await;
        let (status, account) = self
            .send(
                Method::POST,
                "mail-accounts",
                Some(json!({
                    "email": access.user.email,
                    "server_id": server,
                    "auth_kind": "oauth",
                    "code": code,
                    "code_verifier": verifier,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{account}");
        account["id"].as_str().unwrap().to_owned()
    }

    /// `GET mail-accounts/:id/token`.
    async fn token(&self, id: &str, refresh: bool) -> (StatusCode, Value) {
        let query = if refresh { "?refresh=true" } else { "" };
        self.send(
            Method::GET,
            &format!("mail-accounts/{id}/token{query}"),
            None,
        )
        .await
    }

    /// Stored refresh token of the mail account, decrypted.
    async fn refresh_token(&self, id: &str) -> String {
        let lookup = id.to_owned();
        let sealed: Vec<u8> = db::call(&self.state.db, move |conn| {
            Ok(conn.query_row(
                "SELECT secret_enc FROM mail_accounts WHERE id = ?1",
                [lookup],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
        let plain = self
            .state
            .secrets
            .open(mail_accounts::SECRET_PURPOSE, id, &sealed);
        String::from_utf8(plain.unwrap()).unwrap()
    }

    /// Replaces the stored refresh token and lets the access token expire.
    async fn replace_refresh_token(&self, id: &str, token: &str) {
        let sealed = self
            .state
            .secrets
            .seal(mail_accounts::SECRET_PURPOSE, id, token.as_bytes())
            .unwrap();
        let row = id.to_owned();
        db::call(&self.state.db, move |conn| {
            conn.execute(
                "UPDATE mail_accounts SET secret_enc = ?2, access_expires_at = NULL WHERE id = ?1",
                (&row, sealed),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    /// Lets the access token of the mail account expire.
    async fn expire(&self, id: &str) {
        let row = id.to_owned();
        db::call(&self.state.db, move |conn| {
            conn.execute(
                "UPDATE mail_accounts SET access_expires_at = NULL WHERE id = ?1",
                [row],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    /// Refresh at the token endpoint bypassing the broker, as the registry's client.
    async fn refresh_directly(
        &self,
        access: &Access,
        server: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<oauth::Tokens, oauth::Error> {
        let secret = self.stored_secret(server).await;
        oauth::request(
            &http_client().unwrap(),
            &Url::parse(&access.url).unwrap(),
            oauth::Client {
                id: client_id,
                secret: secret.as_deref(),
            },
            oauth::Grant::Refresh(refresh_token),
        )
        .await
    }
}

/// Does the JMAP session accept the access token, or does Stalwart reject it?
async fn session_accepts(url: &str, access_token: &str) -> bool {
    let auth = roedy_jmap::Auth::Bearer(access_token.to_owned());
    match roedy_jmap::Client::connect(&http_client().unwrap(), &Url::parse(url).unwrap(), auth)
        .await
    {
        Ok(client) => !client.session().primary_accounts.is_empty(),
        Err(roedy_jmap::Error::AuthFailed) => false,
        Err(error) => panic!("session: {error:?}"),
    }
}

/// Code of a sign-in of `account` at the client `client_id` with the PKCE
/// verifier for it – like Stalwart's sign-in page via `/api/auth` (sign-in,
/// then consent). Stalwart only checks the secret when exchanging a real
/// code.
async fn authorize(url: &str, client_id: &str, account: &Login) -> (String, String) {
    let verifier = URL_SAFE_NO_PAD.encode(random::bytes::<32>().unwrap());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = URL_SAFE_NO_PAD.encode(random::bytes::<32>().unwrap());
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &format!("{APP}/oauth/callback"))
        .append_pair("scope", dcr::SCOPE)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .finish();
    let http = http_client().unwrap();
    let api_auth = |body: Value| {
        let http = http.clone();
        async move {
            let response = http
                .post(format!("{url}/api/auth"))
                .json(&body)
                .send()
                .await
                .unwrap();
            response.json::<Value>().await.unwrap()
        }
    };
    let mut reply = api_auth(json!({
        "type": "authCode",
        "accountName": account.login,
        "accountSecret": account.password,
        "query": query,
    }))
    .await;
    if reply["type"] == "consentRequired" {
        reply = api_auth(json!({
            "type": "authConsent",
            "token": reply["token"],
            "query": query,
            "consent": true,
        }))
        .await;
    }
    assert_eq!(reply["type"], "authenticated", "sign-in: {}", reply["type"]);
    let location = Url::parse(reply["location"].as_str().unwrap()).unwrap();
    let param = |name: &str| {
        location
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    assert_eq!(param("state").as_deref(), Some(state.as_str()));
    (param("code").expect("code missing"), verifier)
}

#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn registers_confidential_client_and_diagnoses_stalwart_v1() {
    let access = access();
    let s = setup().await;

    // "Register automatically" with the admin's app password.
    let (status, reply) = s.register(&access.url, &access.admin).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["has_secret"], true);
    assert_eq!(reply["redirect_uri"], format!("{APP}/oauth/callback"));
    let client_id = reply["client_id"].as_str().unwrap().to_owned();

    // "Add" takes over the secret that Stalwart accepts.
    let (status, server) = s
        .send(
            Method::POST,
            "admin/servers",
            Some(json!({ "label": "Local", "url": access.url, "client_id": client_id })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{server}");
    assert_eq!(server["has_secret"], true);
    let id = server["id"].as_str().unwrap().to_owned();
    assert!(s.stored_secret(&id).await.is_some());

    // The backend exchanges the sign-in with this client using the secret.
    let (status, servers) = s.send(Method::GET, "servers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(servers["servers"][0]["backend_exchange"], true);
    let (code, verifier) = authorize(&access.url, &client_id, &access.user).await;
    let (status, account) = s
        .send(
            Method::POST,
            "mail-accounts",
            Some(json!({
                "email": access.user.email,
                "server_id": id,
                "auth_kind": "oauth",
                "code": code,
                "code_verifier": verifier,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{account}");
    assert_eq!(account["email"], access.user.email);

    // Diagnostics: OK three times.
    let ok = json!(["ok", "ok", "ok"]);
    assert_eq!(s.test(&id).await, (ok.clone(), json!({})));

    // Created by hand: confidential (ID and secret) …
    let manual = &access.oauth_client;
    let (status, reply) = s
        .send(
            Method::PATCH,
            &format!("admin/servers/{id}"),
            Some(json!({ "client_id": manual.client_id, "client_secret": manual.client_secret })),
        )
        .await;
    assert_eq!(
        (status, &reply["has_secret"]),
        (StatusCode::OK, &json!(true))
    );
    assert_eq!(s.test(&id).await, (ok.clone(), json!({})));
    // … or public (ID only); Stalwart still names `none`.
    let (status, reply) = s
        .send(
            Method::PATCH,
            &format!("admin/servers/{id}"),
            Some(json!({ "client_id": "public-by-hand" })),
        )
        .await;
    assert_eq!(
        (status, &reply["has_secret"]),
        (StatusCode::OK, &json!(false))
    );
    assert_eq!(s.test(&id).await, (ok, json!({})));
}

#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn registration_errors_of_stalwart_v1() {
    let access = access();
    let s = setup().await;

    // Wrong password: 401.
    let wrong = Login {
        app_password: "incorrect".into(),
        ..access.admin
    };
    let (status, reply) = s.register(&access.url, &wrong).await;
    assert_eq!(
        (status, reply),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "registration_failed", "reason": "auth_failed" })
        )
    );

    // Account without `SysOAuthClientCreate`: 403.
    let (status, reply) = s.register(&access.url, &access.user).await;
    assert_eq!(
        (status, reply),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "registration_failed", "reason": "forbidden" })
        )
    );
}

/// Strict rotation: the broker stores the new refresh token;
/// the previous one is valid as long as the new one is unused (a lost
/// response is harmless). If a replaced token comes back after the new one
/// was used, Stalwart revokes the whole grant – the account then shows
/// "sign-in required".
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn rotates_strictly_and_reuse_revokes_the_grant() {
    let access = access();
    let s = setup().await;
    let (server, id, client_id) = s.connect(&access).await;
    let first = s.refresh_token(&id).await;

    // Refresh via the broker: new refresh token stored, the new access token is
    // valid.
    s.expire(&id).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let renewed = reply["accessToken"].as_str().unwrap().to_owned();
    assert!(session_accepts(&access.url, &renewed).await);
    let second = s.refresh_token(&id).await;
    assert_ne!(second, first);

    // The previous one is still valid as long as the new one is unused – this
    // is how the broker repeats a refresh whose response got lost.
    s.refresh_directly(&access, &server, &client_id, &first)
        .await
        .expect("retry with the previous refresh token");

    // The broker takes the stored one; after that the first one is replaced.
    let (status, reply) = s.token(&id, true).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let latest = reply["accessToken"].as_str().unwrap().to_owned();
    assert_ne!(s.refresh_token(&id).await, second);

    // Reused: Stalwart revokes the whole grant.
    assert_eq!(
        s.refresh_directly(&access, &server, &client_id, &first)
            .await,
        Err(oauth::Error::InvalidGrant)
    );
    assert!(!session_accepts(&access.url, &latest).await);
    let (status, reply) = s.token(&id, true).await;
    assert_eq!(
        (status, &reply["error"]),
        (StatusCode::CONFLICT, &json!("needs_reauth"))
    );
}

/// When a mail account is removed the backend revokes the grant
/// (`/auth/revoke` with the secret via Basic); afterwards neither access nor
/// refresh token is valid.
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn removing_an_account_revokes_the_grant() {
    let access = access();
    let s = setup().await;
    let (server, id, client_id) = s.connect(&access).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let access_token = reply["accessToken"].as_str().unwrap().to_owned();
    assert!(session_accepts(&access.url, &access_token).await);
    let refresh = s.refresh_token(&id).await;

    let (status, _) = s
        .send(Method::DELETE, &format!("mail-accounts/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // The revocation runs in the background.
    let mut revoked = false;
    for _ in 0..100 {
        if !session_accepts(&access.url, &access_token).await {
            revoked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(revoked, "access token still valid after removal");
    assert_eq!(
        s.refresh_directly(&access, &server, &client_id, &refresh)
            .await,
        Err(oauth::Error::InvalidGrant)
    );
}

/// After the migration to v1 Stalwart no longer knows the tokens:
/// a refresh token the server did not issue (like one with the old
/// installation's key) ends in "sign-in required" at the first
/// refresh; a new sign-in works.
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn accounts_need_a_new_login_after_the_migration() {
    let access = access();
    let s = setup().await;
    let (_, id, client_id) = s.connect(&access).await;
    let foreign = URL_SAFE_NO_PAD.encode(random::bytes::<48>().unwrap());
    s.replace_refresh_token(&id, &foreign).await;

    let (status, reply) = s.token(&id, false).await;
    assert_eq!(
        (status, &reply["error"]),
        (StatusCode::CONFLICT, &json!("needs_reauth"))
    );
    let (status, accounts) = s.send(Method::GET, "mail-accounts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accounts["accounts"][0]["state"], "needs_reauth");

    // "Sign in again" with a new code.
    let (code, verifier) = authorize(&access.url, &client_id, &access.user).await;
    let (status, reply) = s
        .send(
            Method::POST,
            &format!("mail-accounts/{id}/reauth"),
            Some(json!({ "code": code, "code_verifier": verifier })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["state"], "ok");
    s.expire(&id).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
}

/// System mails with the app password via HTTP Basic:
/// check of the sending account, sending to an address in `example.test`,
/// delivery to the inbox and a copy in "Sent".
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn sends_system_mails_with_an_app_password() {
    let access = access();
    let _mailbox = lock_mailbox(&access).await;
    let base_url = Url::parse(&access.url).unwrap();
    let auth = roedy_jmap::Auth::Basic {
        username: access.user.login.clone(),
        password: access.user.app_password.clone(),
    };
    let account = mailer::Account {
        base_url: base_url.clone(),
        auth: auth.clone(),
        identity_id: None,
        sender_name: Some("Roedy Mail".into()),
        reply_to: None,
        keep_sent: true,
    };
    let mailer = Mailer::new(http_client().unwrap());
    let identities = mailer.test(&account).await.expect("sending account");
    assert!(
        identities
            .iter()
            .any(|identity| identity.email == access.user.email)
    );

    let subject = format!(
        "Roedy-Test {}",
        URL_SAFE_NO_PAD.encode(random::bytes::<9>().unwrap())
    );
    mailer
        .send(
            &account,
            &Mail {
                template: "test",
                to: access.user.email.clone(),
                subject: subject.clone(),
                html: "<p>Hello from the test.</p>".into(),
                text: "Hello from the test.".into(),
            },
        )
        .await
        .expect("System-Mail");

    // Delivered (inbox) and filed (Sent).
    let roles = mailbox_roles(&access, &subject, &["inbox", "sent"]).await;
    assert!(
        roles.contains(&"inbox".to_owned()),
        "not delivered: {roles:?}"
    );
    assert!(roles.contains(&"sent".to_owned()), "not filed: {roles:?}");
}

/// The tests share one Stalwart user. Whoever sets its storage limit or puts
/// mails into its mailbox holds this lock, otherwise a mail delivered in
/// parallel fails at the quota test's limit (`overQuota`).
static MAILBOX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Locks the user's mailbox and lifts a leftover limit (e.g. after a failed
/// quota test).
async fn lock_mailbox(access: &Access) -> tokio::sync::MutexGuard<'static, ()> {
    let guard = MAILBOX.lock().await;
    set_quota(access, 0).await;
    guard
}

/// Sets the storage limit of the user (as admin via `x:Account/set`, like
/// `scripts/dev/stalwart.mjs`).
async fn set_quota(access: &Access, bytes: u64) {
    let reply: Value = http_client()
        .unwrap()
        .post(format!("{}/jmap/", access.url))
        .basic_auth(&access.admin.login, Some(&access.admin.app_password))
        .json(&json!({
            "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            "methodCalls": [["x:Account/set", {
                "update": { (access.user.account_id.as_str()): { "quotas": { "maxDiskQuota": bytes } } },
            }, "q"]],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        reply["methodResponses"][0][1]["updated"]
            .as_object()
            .is_some_and(|updated| updated.contains_key(&access.user.account_id)),
        "quota not set: {}",
        reply["methodResponses"][0][0]
    );
}

/// Waits until Stalwart no longer accepts the access token (the revocation
/// runs in the background).
async fn wait_revoked(url: &str, access_token: &str) {
    for _ in 0..100 {
        if !session_accepts(url, access_token).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("access token still valid after revocation");
}

/// "Check connection": without a limit no storage (empty list from
/// `Quota/get`), with a limit `used` and `hardLimit` of the account; then the
/// job `quota_check` with "storage almost full".
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn check_and_quota_job_read_the_storage_of_stalwart_v1() {
    let access = access();
    let _mailbox = lock_mailbox(&access).await;
    let s = setup().await;
    let (_, id, _) = s.connect(&access).await;

    let (status, unlimited) = s
        .send(Method::POST, &format!("mail-accounts/{id}/check"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{}", unlimited["error"]);
    assert_eq!(unlimited["state"], "ok");
    assert_eq!(unlimited["quota_total"], Value::Null);
    assert!(unlimited["last_check_at"].is_string());

    set_quota(&access, 104_857_600).await;
    let (status, limited) = s
        .send(Method::POST, &format!("mail-accounts/{id}/check"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{}", limited["error"]);
    assert_eq!(limited["quota_total"], 104_857_600);
    assert!(limited["quota_used"].as_i64().is_some_and(|used| used >= 0));

    // Job `quota_check` in the same test, because both set the limit
    // of the same user: with a token of the broker, from 90 % "storage almost
    // full" with address, bytes and share; the account does not count as active
    // in the process.
    add_mail(&access).await;
    // What the job leaves behind: storage, the browser's last fetch and the
    // notifications.
    let row = || {
        let (state, id) = (s.state.clone(), id.clone());
        async move {
            db::call(&state.db, move |conn| {
                let (user_id, used, total, token_used): (
                    String,
                    Option<i64>,
                    Option<i64>,
                    Option<String>,
                ) = conn.query_row(
                    "SELECT user_id, quota_used, quota_total, token_used_at \
                     FROM mail_accounts WHERE id = ?1",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let events = notifications::list(conn, &user_id)?;
                Ok((used, total, token_used, events))
            })
            .await
            .unwrap()
        }
    };
    // A run as if the last attempt was a day ago.
    let run = || {
        let (state, id) = (s.state.clone(), id.clone());
        async move {
            let reset = state.clone();
            db::call(&reset.db, move |conn| {
                conn.execute(
                    "UPDATE mail_accounts SET quota_job_at = NULL WHERE id = ?1",
                    [&id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
            (quota_check::job().run)(state).await.unwrap();
        }
    };
    let (_, _, token_used_before, _) = row().await;

    // Stalwart may count the storage of the new mail a bit later.
    let mut used = 0;
    for _ in 0..50 {
        run().await;
        let (stored, total, _, events) = row().await;
        assert_eq!(total, Some(104_857_600));
        assert!(events.is_empty());
        used = stored.unwrap();
        if used > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(used > 0, "no storage used");

    // The limit just above what is used: about 95 %.
    let limit = u64::try_from(used * 100 / 95).unwrap();
    set_quota(&access, limit).await;
    run().await;
    let (stored, total, token_used, events) = row().await;
    assert_eq!(total, Some(i64::try_from(limit).unwrap()));
    assert_eq!(
        token_used, token_used_before,
        "does not count as a fetch by the browser"
    );
    assert_eq!(events.len(), 1);
    let params = &events[0].params;
    assert_eq!(events[0].kind, "account.quota");
    assert_eq!(params["account"], access.user.email.as_str());
    assert_eq!(params["used"], stored.unwrap());
    assert_eq!(params["limit"], limit);
    assert!(
        (90..=100).contains(&params["percent"].as_u64().unwrap()),
        "{params}"
    );

    // If it stays full: no second notification.
    run().await;
    assert_eq!(row().await.3.len(), 1);

    // Lift the limit again (0 = no limit) for tests without the lock.
    set_quota(&access, 0).await;
}

/// Creates a mail in the user's inbox so that its storage is used.
async fn add_mail(access: &Access) {
    let auth = roedy_jmap::Auth::Basic {
        username: access.user.login.clone(),
        password: access.user.app_password.clone(),
    };
    let base_url = Url::parse(&access.url).unwrap();
    let client = roedy_jmap::Client::connect(&http_client().unwrap(), &base_url, auth)
        .await
        .unwrap();
    let account_id = client
        .session()
        .primary_account(roedy_jmap::MAIL)
        .unwrap()
        .to_owned();
    let mut request = roedy_jmap::Request::new(&[roedy_jmap::CORE, roedy_jmap::MAIL]);
    let query = request.call(
        "Mailbox/query",
        json!({ "accountId": account_id, "filter": { "role": "inbox" } }),
    );
    let found: Value = client
        .call(&request)
        .await
        .unwrap()
        .get(&query, "Mailbox/query")
        .unwrap();
    let inbox = found["ids"][0].as_str().unwrap();
    let mut request = roedy_jmap::Request::new(&[roedy_jmap::CORE, roedy_jmap::MAIL]);
    let set = request.call(
        "Email/set",
        json!({
            "accountId": account_id,
            "create": { "m": {
                "mailboxIds": { (inbox): true },
                "from": [{ "email": access.user.email }],
                "subject": "Storage",
                "bodyValues": { "t": { "value": "x".repeat(8192) } },
                "textBody": [{ "partId": "t", "type": "text/plain" }],
            } },
        }),
    );
    let set: Value = client
        .call(&request)
        .await
        .unwrap()
        .get(&set, "Email/set")
        .unwrap();
    assert!(set["created"]["m"].is_object(), "{}", set["notCreated"]);
}

/// "Sign in again" revokes the previous grant; the new one stays valid.
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn reauth_revokes_only_the_previous_grant() {
    let access = access();
    let s = setup().await;
    let (server, id, client_id) = s.connect(&access).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let previous_access = reply["accessToken"].as_str().unwrap().to_owned();
    let previous = s.refresh_token(&id).await;

    let (code, verifier) = authorize(&access.url, &client_id, &access.user).await;
    let (status, account) = s
        .send(
            Method::POST,
            &format!("mail-accounts/{id}/reauth"),
            Some(json!({ "code": code, "code_verifier": verifier })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{account}");
    wait_revoked(&access.url, &previous_access).await;
    assert_eq!(
        s.refresh_directly(&access, &server, &client_id, &previous)
            .await,
        Err(oauth::Error::InvalidGrant)
    );

    // The new grant: refresh via the broker, the access token is valid.
    let (status, reply) = s.token(&id, true).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    assert!(session_accepts(&access.url, reply["accessToken"].as_str().unwrap()).await);
}

/// "Delete account" revokes the grants of the mail accounts.
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn deleting_the_app_account_revokes_the_grants() {
    let access = access();
    let s = setup().await;
    let (server, id, client_id) = s.connect(&access).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let access_token = reply["accessToken"].as_str().unwrap().to_owned();
    let refresh = s.refresh_token(&id).await;
    // A second administrator, otherwise 409 `last_admin`.
    db::call(&s.state.db, |conn| {
        users::insert(
            conn,
            &NewUser {
                username: "eva",
                email: "eva@example.com",
                display_name: "Eva Muster",
                role: Role::Admin,
                password_hash: "$argon2id$test",
            },
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (status, reply) = s
        .send(
            Method::DELETE,
            "auth/me",
            Some(json!({ "confirm": "delete" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{reply}");
    wait_revoked(&access.url, &access_token).await;
    assert_eq!(
        s.refresh_directly(&access, &server, &client_id, &refresh)
            .await,
        Err(oauth::Error::InvalidGrant)
    );
}

/// If another administrator removes the user, the backend revokes the grants
/// of their mail accounts as with "delete account".
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn removing_a_user_revokes_the_grants() {
    let access = access();
    let mut s = setup().await;
    let (server, id, client_id) = s.connect(&access).await;
    let (status, reply) = s.token(&id, false).await;
    assert_eq!(status, StatusCode::OK, "{}", reply["error"]);
    let access_token = reply["accessToken"].as_str().unwrap().to_owned();
    let refresh = s.refresh_token(&id).await;
    // Eva, a second administrator, removes the account's owner.
    let (owner, eva) = db::call(&s.state.db, |conn| {
        let owner: String =
            conn.query_row("SELECT id FROM users WHERE username = 'admin'", [], |row| {
                row.get(0)
            })?;
        let eva = users::insert(
            conn,
            &NewUser {
                username: "eva",
                email: "eva@example.com",
                display_name: "Eva Muster",
                role: Role::Admin,
                password_hash: "$argon2id$test",
            },
        )?;
        Ok((owner, start_session(conn, &eva)?))
    })
    .await
    .unwrap();
    s.admin = eva;

    let (status, reply) = s
        .send(Method::DELETE, &format!("users/{owner}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{reply}");
    wait_revoked(&access.url, &access_token).await;
    assert_eq!(
        s.refresh_directly(&access, &server, &client_id, &refresh)
            .await,
        Err(oauth::Error::InvalidGrant)
    );
}

/// Roles of the mailboxes holding mails with the subject `subject`; waits up
/// to 10 s until all from `wanted` are there.
async fn mailbox_roles(access: &Access, subject: &str, wanted: &[&str]) -> Vec<String> {
    let base_url = Url::parse(&access.url).unwrap();
    let auth = roedy_jmap::Auth::Basic {
        username: access.user.login.clone(),
        password: access.user.app_password.clone(),
    };
    let client = roedy_jmap::Client::connect(&http_client().unwrap(), &base_url, auth)
        .await
        .unwrap();
    let account_id = client
        .session()
        .primary_account(roedy_jmap::MAIL)
        .unwrap()
        .to_owned();
    let mut roles = Vec::new();
    for _ in 0..100 {
        let mut request = roedy_jmap::Request::new(&[roedy_jmap::CORE, roedy_jmap::MAIL]);
        request.call(
            "Email/query",
            json!({ "accountId": account_id, "filter": { "subject": subject } }),
        );
        let emails = request.call(
            "Email/get",
            json!({
                "accountId": account_id,
                "#ids": { "resultOf": "0", "name": "Email/query", "path": "/ids" },
                "properties": ["mailboxIds", "subject"],
            }),
        );
        let mailboxes = request.call(
            "Mailbox/get",
            json!({ "accountId": account_id, "properties": ["role"] }),
        );
        let response = client.call(&request).await.unwrap();
        let emails: Value = response.get(&emails, "Email/get").unwrap();
        let mailboxes: Value = response.get(&mailboxes, "Mailbox/get").unwrap();
        roles = emails["list"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|email| email["subject"] == subject)
            .flat_map(|email| email["mailboxIds"].as_object().unwrap().keys())
            .filter_map(|id| {
                mailboxes["list"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|mailbox| mailbox["id"] == id.as_str())
                    .and_then(|mailbox| mailbox["role"].as_str())
                    .map(str::to_owned)
            })
            .collect();
        if wanted
            .iter()
            .all(|want| roles.iter().any(|role| role == want))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    roles
}

#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn notification_mails_go_out_through_stalwart_v1() {
    let access = access();
    let _mailbox = lock_mailbox(&access).await;
    let s = setup().await;
    let (secrets, url) = (s.state.secrets.clone(), access.url.clone());
    let (login, password) = (access.user.login.clone(), access.user.app_password.clone());
    let email = access.user.email.clone();
    // The app account has the Stalwart user's address: the mails go from its
    // account to itself.
    let user = db::call(&s.state.db, move |conn| {
        let fields = servers::Fields {
            label: "Local",
            base_url: &url,
            domains: &[],
            client_id: None,
        };
        servers::insert(conn, "s1", &fields, None)?;
        system_mail::save(
            conn,
            &SystemMail::new(&secrets, "s1", &login, &password, None)?,
        )?;
        let id = users::insert(
            conn,
            &NewUser {
                username: "max",
                email: &email,
                display_name: "Max Mustermann",
                role: Role::User,
                password_hash: "$argon2id$test",
            },
        )?;
        let instant = Settings {
            n_digest: Rhythm::Instant,
            ..Settings::default()
        };
        settings::save(conn, &id, 0, &instant)?;
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)?;
        Ok(id)
    })
    .await
    .unwrap();

    // "Instant": subject = title.
    notification_mailer::run_at(&s.state, jiff::Timestamp::now())
        .await
        .unwrap();
    let roles = mailbox_roles(&access, "Profile changed", &["inbox"]).await;
    assert!(
        roles.contains(&"inbox".to_owned()),
        "not delivered: {roles:?}"
    );

    // Daily: the digest at the next 07:00 in Berlin.
    let daily = Settings::default();
    let (id, wanted) = (user.clone(), daily.clone());
    let pending = db::call(&s.state.db, move |conn| {
        settings::save(conn, &id, 1, &wanted)?;
        let event = Account::Profile {
            name: false,
            username: true,
        };
        events::account(conn, &id, event)?;
        notification_deliveries::pending(
            conn,
            notification_deliveries::Channel::Mail,
            &id,
            "2999-01-01T00:00:00Z",
        )
    })
    .await
    .unwrap();
    assert_eq!(pending.len(), 1);
    let due = Schedule::of(&daily).due(pending[0].created_at.parse().unwrap());
    notification_mailer::run_at(&s.state, due).await.unwrap();
    let subject = "Your Roedy Mail digest";
    let roles = mailbox_roles(&access, subject, &["inbox"]).await;
    assert!(
        roles.contains(&"inbox".to_owned()),
        "not delivered: {roles:?}"
    );
}

/// Administration › Email against Stalwart v1: create and check a
/// sending account with app password, a wrong password in the draft, test
/// email with delivery, then sign-in via token (an OAuth access token of the
/// user) with check and test email.
#[tokio::test]
#[ignore = "needs the local Stalwart v1 (scripts/dev/stalwart.sh run …)"]
async fn administration_system_mail_with_stalwart_v1() {
    let access = access();
    let _mailbox = lock_mailbox(&access).await;
    let s = setup().await;
    let (server, account, _) = s.connect(&access).await;

    let (status, view) = s.send(Method::GET, "admin/system-mail", None).await;
    assert_eq!(
        (status, view["status"].as_str()),
        (StatusCode::OK, Some("none"))
    );

    let (status, view) = s
        .send(
            Method::PUT,
            "admin/system-mail",
            Some(json!({
                "server_id": server,
                "user": access.user.login,
                "app_password": access.user.app_password,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", view["error"]);
    assert_eq!(view["status"], "ok", "{}", view["reason"]);
    assert_eq!(view["auth"], "password");
    let emails: Vec<&str> = view["identities"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|identity| identity["email"].as_str())
        .collect();
    assert!(emails.contains(&access.user.email.as_str()), "{emails:?}");

    // A wrong password in the draft: rejected, status stays.
    let (status, reply) = s
        .send(
            Method::POST,
            "admin/system-mail/test",
            Some(json!({ "app_password": "incorrect-0123456789" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply["reason"], "auth_failed");
    let (_, after) = s.send(Method::GET, "admin/system-mail", None).await;
    assert_eq!(after["status"], "ok");

    // Test email to the user themselves: delivered and filed.
    let (status, reply) = s
        .send(
            Method::POST,
            "admin/system-mail/test",
            Some(json!({ "to": access.user.email })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", reply["reason"]);
    assert_eq!(reply["sent"], true);
    let roles = mailbox_roles(&access, "Test email from Roedy Mail", &["inbox", "sent"]).await;
    assert!(
        roles.contains(&"inbox".to_owned()) && roles.contains(&"sent".to_owned()),
        "{roles:?}"
    );

    // Sign-in via token: the access token of the connected mail account.
    let (status, token) = s.token(&account, false).await;
    assert_eq!(status, StatusCode::OK, "{}", token["error"]);
    let token = token["accessToken"].as_str().unwrap().to_owned();
    let (status, view) = s
        .send(
            Method::PUT,
            "admin/system-mail",
            Some(json!({ "auth": "token", "token": token })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", view["error"]);
    assert_eq!(view["auth"], "token");
    assert_eq!(view["status"], "ok", "{}", view["reason"]);
    let (status, reply) = s
        .send(
            Method::POST,
            "admin/system-mail/test",
            Some(json!({ "to": access.user.email, "sender_name": "Roedy Token" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", reply["reason"]);
    assert_eq!(reply["sent"], true);
}
