//! Serving the web app via the router (`ROEDY_WEB_DIR`, without network).
//! The image smoke test (`scripts/image-smoke.sh`) checks the embedded
//! variant (feature `embed-web`).

use std::{fs, path::Path, sync::Arc};
use url::Url;

use axum::{
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    app::{AppState, router},
    broker::crypto::SecretKey,
    config::Config,
    db::{self, Db},
    mailer::templates::{MAIL_LOGO_PATH, PUSH_ICON_PATH},
    web::branding::{APP_ICON_PATH, MANIFEST_PATH, MASKABLE_ICON_PATH, TOUCH_ICON_PATH},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

const INDEX: &str = "<!doctype html><title>Roedy Mail</title>";
const SCRIPT: &str = "console.log('start');";

/// Data directory and web build as from `pnpm build`.
fn state() -> (tempfile::TempDir, AppState) {
    state_with(true)
}

/// With or without web app (`ROEDY_WEB_DIR`).
fn state_with(web_app: bool) -> (tempfile::TempDir, AppState) {
    let tmp = tempfile::tempdir().unwrap();
    let build = tmp.path().join("build");
    let write = |name: &str, content: &str| {
        let path = build.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    };
    write("index.html", INDEX);
    write("_app/immutable/entry/start.A1b2C3.js", SCRIPT);
    write("_app/version.json", r#"{"version":"0.1.0+abc1234"}"#);
    write("licenses.json", "[]");
    let db = Db::from(db::open(&tmp.path().join("data")).unwrap());
    let web = Arc::new(WebAssets::new(web_app.then_some(build.as_path())).unwrap());
    let state = AppState::new(
        db,
        web,
        &Config::default(),
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    (tmp, state)
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn header(&self, name: header::HeaderName) -> Option<&str> {
        self.headers.get(name).map(|v| v.to_str().unwrap())
    }

    /// Body as text; apart from images every response is UTF-8.
    fn body(&self) -> &str {
        std::str::from_utf8(&self.bytes).unwrap()
    }
}

async fn send(state: &AppState, method: Method, path: &str, etag: Option<&str>) -> Reply {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(etag) = etag {
        request = request.header(header::IF_NONE_MATCH, etag);
    }
    let response = router(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        bytes: bytes.to_vec(),
    }
}

async fn get(state: &AppState, path: &str) -> Reply {
    send(state, Method::GET, path, None).await
}

#[tokio::test]
async fn serves_index_for_root_and_spa_routes() {
    let (_tmp, state) = state();
    for path in [
        "/",
        "/index.html",
        "/login",
        "/mailbox/all/inbox",
        "/account/profile/",
        "/confirm-email/ABC%20DEF",
        "/invite/header.payload.signature",
    ] {
        let reply = get(&state, path).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert_eq!(reply.body(), INDEX, "{path}");
        assert_eq!(
            reply.header(header::CONTENT_TYPE),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
        assert_eq!(
            reply.header(header::X_CONTENT_TYPE_OPTIONS),
            Some("nosniff")
        );
        assert!(reply.header(header::ETAG).is_some(), "{path}");
    }
}

#[tokio::test]
async fn immutable_assets_are_cached_long() {
    let (_tmp, state) = state();
    let reply = get(&state, "/_app/immutable/entry/start.A1b2C3.js").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body(), SCRIPT);
    assert_eq!(
        reply.header(header::CONTENT_TYPE),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        reply.header(header::CACHE_CONTROL),
        Some("public, max-age=31536000, immutable")
    );

    let reply = get(&state, "/_app/version.json").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("application/json"));
}

#[tokio::test]
async fn missing_files_are_not_found() {
    let (_tmp, state) = state();
    for path in [
        "/_app/immutable/entry/missing.js",
        "/_app/missing",
        "/favicon.png",
        "/api",
        // Outside /api/v1 the API does not answer (tests/api.rs).
        "/api/v2/auth/me",
        "/../Cargo.toml",
        "/%2e%2e/Cargo.toml",
        "/_app/immutable/%2e%2e/%2e%2e/index.html",
        "/%FF",
    ] {
        let reply = get(&state, path).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(reply.body(), "", "{path}");
        assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-store"));
    }
}

#[tokio::test]
async fn revalidation_returns_not_modified() {
    let (_tmp, state) = state();
    let first = get(&state, "/").await;
    let etag = first.header(header::ETAG).unwrap().to_owned();

    let reply = send(&state, Method::GET, "/login", Some(&etag)).await;
    assert_eq!(reply.status, StatusCode::NOT_MODIFIED);
    assert_eq!(reply.body(), "");
    assert_eq!(reply.header(header::ETAG), Some(etag.as_str()));
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));

    let reply = send(&state, Method::GET, "/", Some("\"other\"")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body(), INDEX);
}

#[tokio::test]
async fn head_has_headers_without_body() {
    let (_tmp, state) = state();
    let reply = send(&state, Method::HEAD, "/licenses.json", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body(), "");
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("application/json"));
}

#[tokio::test]
async fn other_methods_are_not_allowed() {
    let (_tmp, state) = state();
    let reply = send(&state, Method::POST, "/login", None).await;
    assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(reply.header(header::ALLOW), Some("GET, HEAD"));
    // Under /api it stays 404, for other methods too.
    let reply = send(&state, Method::POST, "/api/v2/auth/login", None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn mail_logo_is_public_and_revalidated() {
    let (_tmp, state) = state();
    let reply = get(&state, MAIL_LOGO_PATH).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.bytes, state.brand().mail_logo().unwrap().bytes);
    assert!(reply.bytes.starts_with(b"\x89PNG"));
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("image/png"));
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
    assert_eq!(
        reply.header(header::X_CONTENT_TYPE_OPTIONS),
        Some("nosniff")
    );
    let etag = reply.header(header::ETAG).unwrap().to_owned();

    let reply = send(&state, Method::GET, MAIL_LOGO_PATH, Some(&etag)).await;
    assert_eq!(reply.status, StatusCode::NOT_MODIFIED);
    assert!(reply.bytes.is_empty());
    assert_eq!(reply.header(header::ETAG), Some(etag.as_str()));
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));

    let reply = send(&state, Method::HEAD, MAIL_LOGO_PATH, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.bytes.is_empty());
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("image/png"));

    let reply = send(&state, Method::POST, MAIL_LOGO_PATH, None).await;
    assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn push_icon_is_public() {
    let (_tmp, state) = state_with(false);
    let reply = get(&state, PUSH_ICON_PATH).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.bytes, state.brand().push_icon().unwrap().bytes);
    assert!(reply.bytes.starts_with(b"\x89PNG"));
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("image/png"));
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
}

#[tokio::test]
async fn manifest_comes_from_the_standard_branding() {
    let (_tmp, state) = state_with(false);
    let reply = get(&state, MANIFEST_PATH).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.header(header::CONTENT_TYPE),
        Some("application/manifest+json")
    );
    assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
    let manifest: Value = serde_json::from_slice(&reply.bytes).unwrap();
    let brand = state.brand();
    let logos = brand.logos.as_ref().unwrap();
    assert_eq!(
        manifest,
        json!({
            "id": "/",
            "name": "Roedy Mail",
            "short_name": "Roedy Mail",
            "dir": "ltr",
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "protocol_handlers": [{ "protocol": "mailto", "url": "/compose/new?mailto=%s" }],
            "background_color": "#f5a06e",
            "icons": [
                {
                    "src": format!("{PUSH_ICON_PATH}?v={}", logos.push.version),
                    "sizes": "192x192",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": format!("{APP_ICON_PATH}?v={}", logos.icon.version),
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": format!("{MASKABLE_ICON_PATH}?v={}", logos.maskable.version),
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "maskable",
                },
            ],
        })
    );
    // The browser revalidates via the ETag.
    let etag = reply.header(header::ETAG).unwrap().to_owned();
    let again = send(&state, Method::GET, MANIFEST_PATH, Some(&etag)).await;
    assert_eq!(again.status, StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn app_icons_are_public_and_in_their_sizes() {
    let (_tmp, state) = state_with(false);
    let brand = state.brand();
    let logos = brand.logos.as_ref().unwrap();
    for (path, png) in [
        (APP_ICON_PATH, &logos.icon),
        (MASKABLE_ICON_PATH, &logos.maskable),
        (TOUCH_ICON_PATH, &logos.touch),
    ] {
        let reply = get(&state, path).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert_eq!(reply.bytes, png.bytes, "{path}");
        assert_eq!(reply.header(header::CONTENT_TYPE), Some("image/png"));
        assert_eq!(reply.header(header::CACHE_CONTROL), Some("no-cache"));
        // With the version in the link as in the manifest.
        let versioned = get(&state, &format!("{path}?v={}", png.version)).await;
        assert_eq!(versioned.bytes, png.bytes, "{path}");
    }
}

#[tokio::test]
async fn mail_logo_without_web_app() {
    let (_tmp, state) = state_with(false);
    let reply = get(&state, MAIL_LOGO_PATH).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header(header::CONTENT_TYPE), Some("image/png"));
    // Other files under /branding do not belong to it.
    let reply = get(&state, "/branding/logo.png").await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn health_endpoints_take_precedence() {
    let (_tmp, state) = state();
    let reply = get(&state, "/healthz").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body(), r#"{"status":"ok"}"#);
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_must_stay_inside_web_dir() {
    let (tmp, state) = state();
    let outside = tmp.path().join("secret.txt");
    fs::write(&outside, "secret").unwrap();
    let WebAssets::Dir(build) = state.web.as_ref() else {
        panic!("directory expected");
    };
    std::os::unix::fs::symlink(&outside, build.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(Path::new("index.html"), build.join("start.html")).unwrap();

    assert_eq!(get(&state, "/link.txt").await.status, StatusCode::NOT_FOUND);
    let reply = get(&state, "/start.html").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body(), INDEX);
}
