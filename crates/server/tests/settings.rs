//! Per-user settings and public configuration via the API: defaults, changes
//! with version and conflict, validated values, `public/config` without
//! sign-in, and mails in the recipient's time zone and format.

mod fake_stalwart;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use fake_stalwart::{MAIL_PASSWORD, MAIL_USER, Options, Server};
use http_body_util::BodyExt as _;
use jiff::Timestamp;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::{
        device,
        password::{Hasher, Params},
        session,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            servers as server_repo,
            users::{self, NewUser, Role},
        },
    },
    i18n,
    instance::{self, Branding},
    mailer::{
        format::{DateFormat, Format, TimeFormat},
        system_mail::{self, SystemMail},
    },
    settings::Language,
    web::{maintenance::Mode, static_files::WebAssets},
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const CHROME_MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 \
                      (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
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

/// With a sending account on the test server.
async fn env_with_mail() -> (Env, Server) {
    let env = env().await;
    let server = Server::start(Options::default()).await;
    let (secrets, url) = (env.state.secrets.clone(), server.url.clone());
    db::call(&env.state.db, move |conn| {
        server_repo::insert(
            conn,
            "s1",
            &server_repo::Fields {
                label: "Test",
                base_url: &url,
                domains: &[],
                client_id: Some("c"),
            },
            None,
        )?;
        let mail = SystemMail::new(&secrets, "s1", MAIL_USER, MAIL_PASSWORD, Some("i1".into()))?;
        system_mail::save(conn, &mail)?;
        Ok(())
    })
    .await
    .unwrap();
    (env, server)
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                let value = c
                    .to_str()
                    .unwrap()
                    .strip_prefix(&format!("{name}="))?
                    .split(';')
                    .next()?;
                (!value.is_empty()).then(|| value.to_owned())
            })
    }
}

impl Env {
    async fn add_user(&self, username: &str, email: &str, role: Role) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (username, email) = (username.to_owned(), email.to_owned());
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: "Max Mustermann",
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap()
    }

    async fn request(
        &self,
        agent: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, agent);
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
        let ip = if agent == IPHONE {
            [91, 64, 1, 2]
        } else {
            [89, 12, 34, 56]
        };
        let app: Router =
            router(self.state.clone()).layer(MockConnectInfo(SocketAddr::from((ip, 4711))));
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn session(&self, agent: &str, login: &str) -> String {
        let reply = self
            .request(
                agent,
                Method::POST,
                "/auth/login",
                Some(json!({ "login": login, "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    async fn get_settings(&self, session: &str) -> Value {
        let reply = self
            .request(FIREFOX, Method::GET, "/settings", None, Some(session))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn put_settings(&self, session: &str, version: i64, settings: Value) -> Reply {
        self.request(
            FIREFOX,
            Method::PUT,
            "/settings",
            Some(json!({ "version": version, "settings": settings })),
            Some(session),
        )
        .await
    }
}

async fn mails(server: &Server, n: usize) -> Vec<Value> {
    for _ in 0..300 {
        if server.mail().submitted.len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let submitted = server.mail().submitted;
    assert_eq!(submitted.len(), n, "{submitted:#?}");
    submitted
}

fn time_line(mail: &Value) -> String {
    let text = mail["bodyValues"]["text"]["value"].as_str().unwrap();
    text.lines()
        .find(|line| line.starts_with("Time: "))
        .unwrap_or_else(|| panic!("without time: {text}"))
        .to_owned()
}

#[tokio::test]
async fn settings_need_a_session() {
    let env = env().await;
    for method in [Method::GET, Method::PUT] {
        let body = (method == Method::PUT).then(|| json!({ "version": 0, "settings": {} }));
        let reply = env.request(FIREFOX, method, "/settings", body, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
    }
}

#[tokio::test]
async fn defaults_then_changes_with_version() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;

    // Never stored: version 0 with the defaults.
    let first = env.get_settings(&max).await;
    assert_eq!(first["version"], 0);
    let settings = &first["settings"];
    assert_eq!(settings["mode"], Value::Null);
    assert_eq!(settings["fontSize"], "medium");
    assert_eq!(settings["gUndo"], "5 s");
    assert_eq!(settings["swL"], "move");
    assert_eq!(settings["nDigest"], "daily");
    assert_eq!(
        settings["nMx"]["team"],
        json!({ "app": true, "mail": false, "push": false })
    );
    assert_eq!(settings["tz"], "Europe/Berlin");
    assert_eq!(settings["extMode"], "ask");
    assert_eq!(settings["extAllow"], json!([]));
    assert_eq!(settings["defaultAccount"], Value::Null);
    assert_eq!(settings["bannerDismissedRev"], Value::Null);
    assert_eq!(settings["advanced"], false);

    // Only the named fields change.
    let saved = env
        .put_settings(&max, 0, json!({ "mode": "light", "density": "compact" }))
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.json()["version"], 1);
    let now = env.get_settings(&max).await;
    assert_eq!(now["version"], 1);
    assert_eq!(now["settings"]["mode"], "light");
    assert_eq!(now["settings"]["density"], "compact");
    assert_eq!(now["settings"]["fontSize"], "medium");

    // Without a change the version stays.
    let same = env.put_settings(&max, 1, json!({ "mode": "light" })).await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.body);
    assert_eq!(same.json()["version"], 1);

    // Another user has their own.
    env.add_user("eva", "eva@example.com", Role::User).await;
    let eva = env.session(FIREFOX, "eva").await;
    let other = env.get_settings(&eva).await;
    assert_eq!(other["version"], 0);
    assert_eq!(other["settings"]["mode"], Value::Null);
}

#[tokio::test]
async fn stale_version_is_a_conflict() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;
    let tab = env.put_settings(&max, 0, json!({ "accent": "sage" })).await;
    assert_eq!(tab.status, StatusCode::OK, "{}", tab.body);

    // A second tab still knows version 0: conflict with the current state.
    let late = env.put_settings(&max, 0, json!({ "gKeys": false })).await;
    assert_eq!(late.status, StatusCode::CONFLICT, "{}", late.body);
    let body = late.json();
    assert_eq!(body["error"], "version_conflict");
    assert_eq!(body["version"], 1);
    assert_eq!(body["settings"]["accent"], "sage");
    assert_eq!(body["settings"]["gKeys"], true);

    // Applied again on top of it, the change takes effect.
    let again = env.put_settings(&max, 1, json!({ "gKeys": false })).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    let now = again.json();
    assert_eq!(now["version"], 2);
    assert_eq!(now["settings"]["accent"], "sage");
    assert_eq!(now["settings"]["gKeys"], false);
}

#[tokio::test]
async fn foreign_values_change_nothing() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;
    let reply = env
        .put_settings(
            &max,
            0,
            json!({
                "mode": "dark",
                "fontSize": "Huge",
                "tz": "Mars/Olympus",
                "extAllow": ["not-an-address"],
                "loadSim": true,
            }),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    let body = reply.json();
    assert_eq!(body["error"], "invalid");
    assert_eq!(
        body["fields"],
        json!({
            "settings.fontSize": { "code": "invalid" },
            "settings.tz": { "code": "invalid" },
            "settings.extAllow": { "code": "invalid" },
            "settings.loadSim": { "code": "unknown" },
        })
    );
    // The valid field is not stored either.
    let now = env.get_settings(&max).await;
    assert_eq!(now["version"], 0);
    assert_eq!(now["settings"]["mode"], Value::Null);

    // No object, wrong version: 400.
    let bad = env
        .request(
            FIREFOX,
            Method::PUT,
            "/settings",
            Some(json!({ "version": "1", "settings": [] })),
            Some(&max),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{}", bad.body);
}

#[tokio::test]
async fn outdated_fields_go_with_the_next_save() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;
    // A field of another version and a value this version does not know.
    let doc = r#"{"mode":"light","later":true,"density":"Huge"}"#;
    db::call(&env.state.db, move |conn| {
        conn.execute(
            "INSERT INTO user_settings (user_id, json, version) VALUES (?1, ?2, 3)",
            (&id, doc),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let now = env.get_settings(&max).await;
    assert_eq!(now["version"], 3);
    assert_eq!(now["settings"]["mode"], "light");
    assert_eq!(now["settings"]["density"], "normal");
    assert!(now["settings"].get("later").is_none(), "{now}");

    // Without a change, but with leftovers: the document is rewritten.
    let same = env.put_settings(&max, 3, json!({ "mode": "light" })).await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.body);
    assert_eq!(same.json()["version"], 4);
    let raw: String = db::call(&env.state.db, |conn| {
        Ok(conn.query_row("SELECT json FROM user_settings", [], |row| row.get(0))?)
    })
    .await
    .unwrap();
    assert!(!raw.contains("later") && !raw.contains("Huge"), "{raw}");
    // After that the version stays without a change.
    let again = env.put_settings(&max, 4, json!({ "mode": "light" })).await;
    assert_eq!(again.json()["version"], 4);
}

#[tokio::test]
async fn security_channels_stay_on() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;
    let off = json!({ "app": false, "mail": false, "push": false });
    let reply = env
        .put_settings(
            &max,
            0,
            json!({
                "nCh": off,
                "nMx": { "security": off, "account": off, "team": off, "system": off, "news": off },
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let settings = &reply.json()["settings"];
    assert_eq!(settings["nCh"], off);
    // Security notices stay on in the app and by email.
    assert_eq!(
        settings["nMx"]["security"],
        json!({ "app": true, "mail": true, "push": false })
    );
    assert_eq!(settings["nMx"]["account"], off);
}

#[tokio::test]
async fn security_mails_use_the_recipients_zone_and_format() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let desktop = env.session(FIREFOX, "max").await;
    let first = mails(&server, 1).await.pop().unwrap();
    // 24-hour clock by default.
    let line = time_line(&first);
    assert!(!line.ends_with(" AM") && !line.ends_with(" PM"), "{line}");

    let reply = env
        .put_settings(
            &desktop,
            0,
            json!({ "tz": "America/New_York", "timeFmt": "12h", "dateFmt": "us" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    // "New sign-in" from the phone: time in New York with 12 hours.
    let before = Timestamp::now();
    env.session(IPHONE, "max").await;
    let login = mails(&server, 2).await.pop().unwrap();
    let after = Timestamp::now();
    assert_eq!(login["subject"], "New sign-in to Roedy Mail");
    let format = Format::new(
        "America/New_York",
        DateFormat::Us,
        TimeFormat::H12,
        Language::English,
    );
    let expected = [before, after].map(|at| format!("Time: {}", format.when(at, at)));
    let line = time_line(&login);
    assert!(expected.contains(&line), "{line} instead of {expected:?}");

    // Switched to German: subject, text and device in the new language,
    // formats stay.
    let reply = env.put_settings(&desktop, 1, json!({ "lang": "de" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // Another unknown device (the iPhone is known by now).
    env.session(CHROME_MAC, "max").await;
    let german = mails(&server, 3).await.pop().unwrap();
    let subject = i18n::tf(
        Language::German,
        "mail.security_login.subject",
        &[("app", &"Roedy Mail")],
    );
    assert_eq!(german["subject"], subject);
    let text = german["bodyValues"]["text"]["value"].as_str().unwrap();
    assert!(!text.starts_with("Hi "), "{text}");
    let chrome = device::label(Some("Chrome"), Some("macOS"), Language::German);
    assert_ne!(chrome, "Chrome on macOS");
    assert!(text.contains(&format!(": {chrome}\n")), "{text}");
    assert!(text.contains(" PM\n") || text.contains(" AM\n"), "{text}");
}

#[tokio::test]
async fn public_config_without_login() {
    let env = env().await;
    let reply = env
        .request(FIREFOX, Method::GET, "/public/config", None, None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.headers.get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let config = reply.json();
    assert_eq!(config["name"], "Roedy Mail");
    assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(config["setup_required"], true);
    assert_eq!(config["branding"]["loginTitle"], instance::LOGIN_TITLE);
    assert_eq!(
        config["branding"]["loginText"],
        Branding::default().login_text
    );
    assert_eq!(config["branding"]["loginArt"], true);
    assert_eq!(config["branding"]["color"], "apricot");
    assert_eq!(config["branding"]["image"], Value::Null);
    assert_eq!(config["org"]["imprint"], Value::Null);
    assert_eq!(
        config["maintenance"],
        json!({ "on": false, "message": null })
    );
    assert_eq!(config["update"], Value::Null);
    // Nothing that only concerns administrators.
    assert!(config.get("system_mail_configured").is_none(), "{config}");

    // After setup and in maintenance mode with its own notice.
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    env.state.maintenance.set(Mode {
        on: true,
        message: Some("Until 2 pm".into()),
    });
    let config = env
        .request(FIREFOX, Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(config["setup_required"], false);
    assert_eq!(
        config["maintenance"],
        json!({ "on": true, "message": "Until 2 pm" })
    );

    // Switched off, a stored notice stays hidden.
    env.state.maintenance.set(Mode {
        on: false,
        message: Some("Draft".into()),
    });
    let config = env
        .request(FIREFOX, Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(
        config["maintenance"],
        json!({ "on": false, "message": null })
    );
}

/// Audit log entries `(action, details)` with this prefix, oldest first; all
/// in the category settings.
async fn logged(env: &Env, prefix: &'static str) -> Vec<(String, Value)> {
    let rows = db::call(&env.state.db, move |conn| {
        let mut statement = conn.prepare(
            "SELECT action, category, details FROM audit_log WHERE action LIKE ?1 || '%' \
             ORDER BY id",
        )?;
        let rows = statement
            .query_map([prefix], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<(String, String, String)>, _>>()?;
        Ok(rows)
    })
    .await
    .unwrap();
    rows.into_iter()
        .map(|(action, category, details)| {
            assert_eq!(category, "settings", "{action}");
            (action, serde_json::from_str(&details).unwrap())
        })
        .collect()
}

/// Organization, banner and branding belong to the administration.
#[tokio::test]
async fn org_and_banner_only_for_admins() {
    let env = env().await;
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    env.add_user("max", "max@example.com", Role::User).await;
    let max = env.session(FIREFOX, "max").await;
    for path in ["/admin/org", "/admin/banner", "/admin/branding"] {
        let guest = env.request(FIREFOX, Method::GET, path, None, None).await;
        assert_eq!(guest.status, StatusCode::UNAUTHORIZED, "{path}");
        let user = env
            .request(FIREFOX, Method::GET, path, None, Some(&max))
            .await;
        assert_eq!(user.status, StatusCode::FORBIDDEN, "{path}");
        let put = env
            .request(FIREFOX, Method::PUT, path, Some(json!({})), Some(&max))
            .await;
        assert_eq!(put.status, StatusCode::FORBIDDEN, "{path}");
    }
}

/// Organization: validated on save, only named fields, `null` and
/// empty texts delete; `public/config` and the mails name it.
#[tokio::test]
async fn org_is_checked_saved_logged_and_public() {
    let (env, server) = env_with_mail().await;
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    let anna = env.session(FIREFOX, "anna").await;
    mails(&server, 1).await;
    let get = env
        .request(FIREFOX, Method::GET, "/admin/org", None, Some(&anna))
        .await;
    assert_eq!(get.status, StatusCode::OK, "{}", get.body);
    let empty = json!({
        "name": null, "website": null, "help": null, "email": null,
        "imprint": null, "privacy": null, "terms": null, "source": null,
    });
    assert_eq!(get.json(), empty);

    let bad = env
        .request(
            FIREFOX,
            Method::PUT,
            "/admin/org",
            Some(json!({
                "name": "x".repeat(121),
                "website": "javascript:alert(1)",
                "help": "example.com/hilfe",
                "email": "support@example.com?subject=x",
                "imprint": "https://example.com/ imprint",
                "privacy": "data:text/html,x",
                "terms": "ftp://example.com",
                "source": "https://",
            })),
            Some(&anna),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", bad.body);
    let fields = &bad.json()["fields"];
    assert_eq!(fields["name"]["code"], "too_long");
    for field in [
        "website", "help", "email", "imprint", "privacy", "terms", "source",
    ] {
        assert_eq!(fields[field]["code"], "invalid", "{field}");
    }
    let unknown = env
        .request(
            FIREFOX,
            Method::PUT,
            "/admin/org",
            Some(json!({ "fax": "0" })),
            Some(&anna),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert!(logged(&env, "org.").await.is_empty());

    let saved = env
        .request(
            FIREFOX,
            Method::PUT,
            "/admin/org",
            Some(json!({
                "name": "  Example Ltd ",
                "website": "https://example.com",
                "email": "support@example.com",
                "imprint": "https://example.com/imprint",
                "privacy": "http://example.com/privacy",
                "terms": "",
                "source": null,
            })),
            Some(&anna),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let org = json!({
        "name": "Example Ltd", "website": "https://example.com", "help": null,
        "email": "support@example.com", "imprint": "https://example.com/imprint",
        "privacy": "http://example.com/privacy", "terms": null, "source": null,
    });
    assert_eq!(saved.json(), org);
    let config = env
        .request(FIREFOX, Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(config["org"], org);
    assert_eq!(config["name"], "Roedy Mail");

    // Only named fields; `null` deletes; without a change no entry.
    let partial = env
        .request(
            FIREFOX,
            Method::PUT,
            "/admin/org",
            Some(json!({ "help": "https://example.com/hilfe", "website": null })),
            Some(&anna),
        )
        .await
        .json();
    assert_eq!(partial["help"], "https://example.com/hilfe");
    assert_eq!(partial["website"], Value::Null);
    assert_eq!(partial["name"], "Example Ltd");
    let same = env
        .request(
            FIREFOX,
            Method::PUT,
            "/admin/org",
            Some(json!({ "name": "Example Ltd" })),
            Some(&anna),
        )
        .await;
    assert_eq!(same.status, StatusCode::OK);
    let entries = logged(&env, "org.").await;
    assert_eq!(
        entries,
        [
            (
                "org.update".to_owned(),
                json!({ "fields": ["name", "website", "email", "imprint", "privacy"] })
            ),
            (
                "org.update".to_owned(),
                json!({ "fields": ["website", "help"] })
            ),
        ]
    );

    // The mails' footer names the organization.
    env.session(IPHONE, "anna").await;
    let login = mails(&server, 2).await.pop().unwrap();
    let text = login["bodyValues"]["text"]["value"].as_str().unwrap();
    assert!(text.contains("Example Ltd · support@example.com"), "{text}");
    assert!(
        text.contains("Legal notice: https://example.com/imprint"),
        "{text}"
    );
    assert!(
        text.contains("Privacy policy: http://example.com/privacy"),
        "{text}"
    );
    let html = login["bodyValues"]["html"]["value"].as_str().unwrap();
    assert!(
        html.contains("href=\"mailto:support@example.com\""),
        "{html}"
    );
    assert!(
        html.contains("href=\"https://example.com/imprint\""),
        "{html}"
    );

    // After a restart from the database.
    let restarted = AppState::new(
        env.state.db.clone(),
        Arc::new(WebAssets::None),
        &Config::default(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    restarted.load().await.unwrap();
    assert_eq!(restarted.brand().org.as_deref(), Some("Example Ltd"));
    assert_eq!(
        restarted.instance.org().help.as_deref(),
        Some("https://example.com/hilfe")
    );
}

/// Banner: title, text and link with display on/off; every change
/// increments `revision`; `public/config` only names it while it is on.
#[tokio::test]
async fn banner_revision_log_and_public_config() {
    let env = env().await;
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    let anna = env.session(FIREFOX, "anna").await;
    let put = |body: Value| {
        env.request(
            FIREFOX,
            Method::PUT,
            "/admin/banner",
            Some(body),
            Some(&anna),
        )
    };
    let public = || async {
        env.request(FIREFOX, Method::GET, "/public/config", None, None)
            .await
            .json()["banner"]
            .clone()
    };

    let get = env
        .request(FIREFOX, Method::GET, "/admin/banner", None, Some(&anna))
        .await;
    assert_eq!(get.status, StatusCode::OK, "{}", get.body);
    assert_eq!(
        get.json(),
        json!({
            "on": false, "title": "", "text": "", "link": "", "linkLabel": "",
            "tone": "accent", "icon": "ti-speakerphone", "closable": true,
            "revision": 0,
        })
    );
    assert_eq!(public().await, Value::Null);

    // Shown only with a title.
    let untitled = put(json!({ "on": true, "title": "  " })).await;
    assert_eq!(untitled.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(untitled.json()["fields"]["title"]["code"], "required");
    let bad = put(json!({
        "title": "x".repeat(41),
        "text": "x".repeat(141),
        "linkLabel": "x".repeat(25),
        "link": "javascript:alert(1)",
        "tone": "Neon",
        "icon": "ti-bomb",
    }))
    .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    let fields = &bad.json()["fields"];
    for (field, code) in [
        ("title", "too_long"),
        ("text", "too_long"),
        ("linkLabel", "too_long"),
        ("link", "invalid"),
        ("tone", "invalid"),
        ("icon", "invalid"),
    ] {
        assert_eq!(fields[field]["code"], code, "{field}");
    }
    let control = put(json!({ "title": "a\nb" })).await;
    assert_eq!(control.json()["fields"]["title"]["code"], "invalid");
    assert_eq!(
        put(json!({ "revision": 9 })).await.status,
        StatusCode::BAD_REQUEST
    );

    // Draft with the banner switched off: new revision, no entry.
    let draft = put(json!({ "title": " New feature ", "tone": "soft" })).await;
    assert_eq!(draft.status, StatusCode::OK, "{}", draft.body);
    assert_eq!(draft.json()["title"], "New feature");
    assert_eq!(draft.json()["revision"], 1);
    assert_eq!(public().await, Value::Null);

    let on = put(json!({
        "on": true,
        "text": "With a banner from today.",
        "link": "https://example.com/new",
        "icon": "ti-sparkles",
        "closable": false,
    }))
    .await
    .json();
    assert_eq!(on["revision"], 2);
    assert_eq!(
        public().await,
        json!({
            "title": "New feature", "text": "With a banner from today.",
            "link": "https://example.com/new", "linkLabel": "", "tone": "soft",
            "icon": "ti-sparkles", "closable": false, "revision": 2,
        })
    );
    // The same again changes nothing.
    let same = put(json!({ "on": true, "title": "New feature" }))
        .await
        .json();
    assert_eq!(same["revision"], 2);
    let changed = put(json!({ "linkLabel": "View", "link": "" })).await.json();
    assert_eq!(changed["revision"], 3);
    assert_eq!(public().await["link"], "");
    let off = put(json!({ "on": false })).await.json();
    assert_eq!(off["revision"], 4);
    assert_eq!(off["linkLabel"], "View");
    assert_eq!(public().await, Value::Null);
    assert_eq!(env.state.instance.banner().revision, 4);

    let entries: Vec<(String, Value)> = logged(&env, "banner.").await;
    assert_eq!(
        entries,
        [
            (
                "banner.enable".to_owned(),
                json!({ "title": "New feature", "revision": 2 })
            ),
            (
                "banner.update".to_owned(),
                json!({ "title": "New feature", "revision": 3 })
            ),
            (
                "banner.disable".to_owned(),
                json!({ "title": "New feature", "revision": 4 })
            ),
        ]
    );
}

fn svg_data_url(svg: &str) -> String {
    use base64::Engine as _;
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

/// Response for a file outside `/api`.
async fn file(env: &Env, path: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let request = Request::builder().uri(path).body(Body::empty()).unwrap();
    let response = router(env.state.clone()).oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

/// Branding: name, logo, colors and login texts, logo as data URL validated and
/// sanitized, `public/config`, mail logo and mails from the same source,
/// from the database after a restart.
#[tokio::test]
async fn branding_is_checked_saved_drawn_and_public() {
    let (env, server) = env_with_mail().await;
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    let anna = env.session(FIREFOX, "anna").await;
    mails(&server, 1).await;
    let put = |body: Value| {
        let (env, anna) = (&env, &anna);
        async move {
            env.request(
                FIREFOX,
                Method::PUT,
                "/admin/branding",
                Some(body),
                Some(anna),
            )
            .await
        }
    };
    let brand0 = json!({
        "name": null, "kind": "standard", "letter": "", "icon": "ti-mountain", "image": null,
        "imageName": "", "imageMeta": "", "fit": "padded", "plate": "accent",
        "tilt": true, "color": "apricot", "userAccent": true,
        "loginTitle": instance::LOGIN_TITLE,
        "loginText": Branding::default().login_text, "loginArt": true,
    });
    let get = env
        .request(FIREFOX, Method::GET, "/admin/branding", None, Some(&anna))
        .await;
    assert_eq!(get.status, StatusCode::OK, "{}", get.body);
    assert_eq!(get.json(), brand0);
    let (_, _, standard_logo) = file(&env, "/branding/mail-logo.png").await;
    let standard_logos = env.state.brand().logos.clone().unwrap();

    // Validated per field; unknown fields are 400.
    let invalid = put(json!({ "name": "x".repeat(33), "color": "Grass", "icon": "ti-mail" })).await;
    assert_eq!(
        invalid.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        invalid.body
    );
    let fields = &invalid.json()["fields"];
    assert_eq!(fields["name"]["code"], "too_long");
    assert_eq!(fields["color"]["code"], "invalid");
    assert_eq!(fields["icon"]["code"], "invalid");
    assert_eq!(
        put(json!({ "imgMeta": "x" })).await.status,
        StatusCode::BAD_REQUEST
    );
    let required = put(json!({ "kind": "image" })).await;
    assert_eq!(required.json()["fields"]["image"]["code"], "required");
    for (url, code) in [
        ("data:image/gif;base64,R0lGODlh".to_owned(), "unsupported"),
        (
            svg_data_url(r#"<svg xmlns="http://www.w3.org/2000/svg"><text>Post</text></svg>"#),
            "svg_text",
        ),
        ("/branding/image/foreign.png".to_owned(), "invalid"),
    ] {
        let reply = put(json!({ "kind": "image", "image": url })).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{code}");
        assert_eq!(reply.json()["fields"]["image"]["code"], code);
    }
    assert!(logged(&env, "branding.").await.is_empty());

    // An SVG with a script is stored sanitized.
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#ff0000" onclick="alert(2)"/></svg>"##;
    let saved = put(json!({
        "name": " Post ", "kind": "image", "image": svg_data_url(svg), "imageName": "logo.svg",
        "imageMeta": "SVG · 1 KB", "fit": "fill", "plate": "dark", "color": "sage",
        "userAccent": false, "loginTitle": " ", "loginText": "Sign in with your company account.",
    }))
    .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let saved = saved.json();
    let image = saved["image"].as_str().unwrap().to_owned();
    assert!(
        image.starts_with("/branding/image/") && image.ends_with(".svg"),
        "{image}"
    );
    assert_eq!(saved["name"], "Post");
    assert_eq!(saved["loginTitle"], instance::LOGIN_TITLE);
    assert_eq!(saved["imageName"], "logo.svg");
    let (status, headers, body) = file(&env, &image).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/svg+xml");
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert!(
        headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .starts_with("default-src 'none'")
    );
    let body = String::from_utf8(body).unwrap();
    assert!(!body.contains("alert") && body.contains("<path"), "{body}");
    assert_eq!(
        file(&env, "/branding/image/0000.svg").await.0,
        StatusCode::NOT_FOUND
    );

    // public/config without details of the file, mail logo rendered anew.
    let config = env
        .request(FIREFOX, Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(config["name"], "Post");
    assert_eq!(config["branding"]["image"], image);
    assert_eq!(config["branding"]["userAccent"], false);
    assert_eq!(config["branding"]["plate"], "dark");
    assert!(config["branding"].get("imageName").is_none(), "{config}");
    let (status, _, logo) = file(&env, "/branding/mail-logo.png").await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(logo, standard_logo);
    assert_eq!(logo, env.state.brand().mail_logo().unwrap().bytes);

    // Web manifest: app name, colors and new icons with version.
    let (status, _, manifest) = file(&env, "/manifest.webmanifest").await;
    assert_eq!(status, StatusCode::OK);
    let manifest: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(manifest["name"], "Post");
    assert_eq!(manifest["short_name"], "Post");
    assert_eq!(manifest["background_color"], "#2b221c");
    assert_eq!(manifest["theme_color"], "#94c48d");
    let brand = env.state.brand();
    let logos = brand.logos.as_ref().unwrap();
    assert_eq!(
        manifest["icons"][1]["src"],
        format!("/branding/app-icon.png?v={}", logos.icon.version)
    );
    assert_ne!(logos.icon, standard_logos.icon);
    let (status, _, icon) = file(&env, "/branding/app-icon.png").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(icon, logos.icon.bytes);

    // The mails: app name, plate and the new logo with version.
    env.session(IPHONE, "anna").await;
    let login = mails(&server, 2).await.pop().unwrap();
    assert_eq!(login["subject"], "New sign-in to Post");
    let html = login["bodyValues"]["html"]["value"].as_str().unwrap();
    let version = env.state.brand().mail_logo().unwrap().version.clone();
    assert!(
        html.contains(&format!(
            r##"bgcolor="#2b221c" aria-hidden="true" style="width:40px;height:40px;padding:0;border-radius:12px;background:#2b221c;vertical-align:middle"><img src="https://app.example.com/branding/mail-logo.png?v={version}""##
        )),
        "{html}"
    );
    // The button stays in the brand color.
    assert!(html.contains("background:#94c48d"), "{html}");

    // Previous URL: the logo stays; without a change no entry.
    let kept = put(json!({ "image": image, "tilt": false })).await.json();
    assert_eq!(kept["image"], image);
    assert_eq!(kept["imageName"], "logo.svg");
    let same = put(json!({ "tilt": false, "name": "Post" })).await;
    assert_eq!(same.status, StatusCode::OK);

    // After a restart from the database, with the same logo.
    let restarted = AppState::new(
        env.state.db.clone(),
        Arc::new(WebAssets::None),
        &Config::default(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    restarted.load().await.unwrap();
    assert_eq!(restarted.brand().app, "Post");
    assert_eq!(
        restarted.instance.branding().image_path(),
        Some(image.clone())
    );
    assert_eq!(restarted.brand().mail_logo(), env.state.brand().mail_logo());

    // Reset to the defaults: logo gone, also from `assets`.
    let reset = put(brand0.clone()).await.json();
    assert_eq!(reset, brand0);
    assert_eq!(file(&env, &image).await.0, StatusCode::NOT_FOUND);
    assert_eq!(file(&env, "/branding/mail-logo.png").await.2, standard_logo);
    let left: i64 = db::call(&env.state.db, |conn| {
        Ok(conn.query_row("SELECT count(*) FROM assets", [], |row| row.get(0))?)
    })
    .await
    .unwrap();
    assert_eq!(left, 0);

    let entries = logged(&env, "branding.").await;
    let fields: Vec<Value> = entries
        .iter()
        .map(|(action, details)| {
            assert_eq!(action, "branding.update");
            details["fields"].clone()
        })
        .collect();
    assert_eq!(
        fields,
        [
            json!([
                "color",
                "fit",
                "image",
                "imageMeta",
                "imageName",
                "kind",
                "loginText",
                "name",
                "plate",
                "userAccent"
            ]),
            json!(["tilt"]),
            json!([
                "color",
                "fit",
                "image",
                "imageMeta",
                "imageName",
                "kind",
                "loginText",
                "name",
                "plate",
                "tilt",
                "userAccent"
            ]),
        ]
    );
}
