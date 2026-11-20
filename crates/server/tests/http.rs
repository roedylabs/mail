//! Operational endpoints via the router (without network).

use std::sync::Arc;
use url::Url;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    app::{AppState, router},
    broker::crypto::SecretKey,
    config::Config,
    db::{self, Db},
    web::static_files::WebAssets,
};
use tower::ServiceExt as _;

fn state() -> (tempfile::TempDir, AppState) {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    let web = Arc::new(WebAssets::None);
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
    cache_control: Option<String>,
    body: String,
}

async fn get(state: AppState, path: &str) -> Reply {
    let response = router(state)
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        cache_control,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

#[tokio::test]
async fn healthz_reports_ok() {
    let (_tmp, state) = state();
    let reply = get(state, "/healthz").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.cache_control.as_deref(), Some("no-store"));
    assert_eq!(reply.body, r#"{"status":"ok"}"#);
}

#[tokio::test]
async fn readyz_reports_ok_with_database() {
    let (_tmp, state) = state();
    let reply = get(state, "/readyz").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, r#"{"status":"ok"}"#);
}

#[tokio::test]
async fn readyz_reports_unavailable_without_database() {
    let (_tmp, state) = state();
    state.db.clone().close().await.unwrap();
    let reply = get(state, "/readyz").await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.cache_control.as_deref(), Some("no-store"));
    assert_eq!(reply.body, r#"{"status":"unavailable"}"#);
}

#[tokio::test]
async fn unknown_path_without_web_app_is_not_found() {
    let (_tmp, state) = state();
    assert_eq!(
        get(state, "/does-not-exist").await.status,
        StatusCode::NOT_FOUND
    );
}
