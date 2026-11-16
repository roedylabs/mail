//! Error responses of the API: status and `{"error": "<code>"}`. The codes are
//! stable; the web app shows its own localized texts for them.

use std::time::Duration;

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::{auth::password::Busy, logging::ExpectedFailure, rate_limit::Limited};

#[derive(Debug)]
pub enum ApiError {
    /// 400 `bad_request` with `detail`: the body does not fit the endpoint (no
    /// JSON, wrong types, unknown fields).
    BadRequest(String),
    /// 401 `unauthorized`: no valid session.
    Unauthorized,
    /// 403 `forbidden`: signed in, but without permission.
    Forbidden,
    /// 403 `csrf`: modifying request without `X-Requested-With`.
    Csrf,
    /// 404 `not_found`.
    NotFound,
    /// 429 `rate_limited` with `Retry-After` and `retry_after` (seconds).
    RateLimited(Duration),
    /// 503 `busy`: all slots for password hashing are taken.
    Busy,
    /// 503 `maintenance` with its own notice in `message`: part of normal
    /// operation and not logged as an error.
    Maintenance(Option<String>),
    /// 500 `internal`; the cause is only in the log.
    Internal(anyhow::Error),
    /// Domain error: own status and code, further fields next to `error`
    /// (e.g. `fields` for 422 `invalid`, `reason`).
    Rejected {
        status: StatusCode,
        code: &'static str,
        extra: Map<String, Value>,
    },
}

impl ApiError {
    pub fn rejected(status: StatusCode, code: &'static str) -> Self {
        Self::Rejected {
            status,
            code,
            extra: Map::new(),
        }
    }

    /// 422 `invalid`: input breaks rules; `fields` names `{"code": …}` per
    /// field and further details where needed.
    pub fn invalid(fields: Map<String, Value>) -> Self {
        Self::rejected(StatusCode::UNPROCESSABLE_ENTITY, "invalid").with("fields", fields)
    }

    /// Adds a field to the response (only for [`Self::Rejected`]).
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        if let Self::Rejected { extra, .. } = &mut self {
            extra.insert(key.into(), value.into());
        }
        self
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::RateLimited(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::Maintenance(_) => (StatusCode::SERVICE_UNAVAILABLE, "maintenance"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
            Self::Rejected { status, code, .. } => (*status, code),
        }
    }
}

/// Field errors for [`ApiError::invalid`]: per field the first error as
/// `{"code": …}` with further details.
#[derive(Debug, Default)]
pub struct FieldErrors(Map<String, Value>);

impl FieldErrors {
    pub fn add(&mut self, field: &str, error: Value) {
        self.0.entry(field).or_insert(error);
    }

    pub fn code(&mut self, field: &str, code: &str) {
        self.add(field, json!({ "code": code }));
    }

    /// Takes over the errors of `other` (existing fields keep theirs).
    pub fn merge(&mut self, other: Self) {
        for (field, error) in other.0 {
            self.add(&field, error);
        }
    }

    /// Takes over the errors of `other` with `prefix.` prepended
    /// (such as `server.url` in `setup/complete`).
    pub fn nest(&mut self, prefix: &str, other: Self) {
        for (field, error) in other.0 {
            self.add(&format!("{prefix}.{field}"), error);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn into_error(self) -> ApiError {
        ApiError::invalid(self.0)
    }

    /// `fields` of the response, for tests.
    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }
}

/// Waiting time in whole seconds for `Retry-After` and `retry_after`:
/// rounded up, at least 1.
pub fn retry_secs(retry_after: Duration) -> u64 {
    (retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0)).max(1)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        match self {
            Self::RateLimited(retry_after) => {
                let secs = retry_secs(retry_after);
                let mut response =
                    (status, Json(json!({ "error": code, "retry_after": secs }))).into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from(secs));
                response
            }
            Self::Internal(error) => {
                tracing::error!("internal error: {error:#}");
                (status, Json(json!({ "error": code }))).into_response()
            }
            Self::BadRequest(detail) => {
                (status, Json(json!({ "error": code, "detail": detail }))).into_response()
            }
            Self::Rejected { mut extra, .. } => {
                extra.insert("error".into(), code.into());
                (status, Json(Value::Object(extra))).into_response()
            }
            Self::Maintenance(message) => {
                let body = match message {
                    Some(message) => json!({ "error": code, "message": message }),
                    None => json!({ "error": code }),
                };
                let mut response = (status, Json(body)).into_response();
                response.extensions_mut().insert(ExpectedFailure);
                response
            }
            _ => (status, Json(json!({ "error": code }))).into_response(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        if error.is::<Busy>() {
            Self::Busy
        } else {
            Self::Internal(error)
        }
    }
}

impl From<Limited> for ApiError {
    fn from(limited: Limited) -> Self {
        Self::RateLimited(limited.retry_after)
    }
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt as _;

    use super::*;

    async fn render(error: ApiError) -> (StatusCode, Option<String>, String) {
        let response = error.into_response();
        let status = response.status();
        let retry = response
            .headers()
            .get(header::RETRY_AFTER)
            .map(|v| v.to_str().unwrap().to_owned());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, retry, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn renders_codes() {
        assert_eq!(
            render(ApiError::Unauthorized).await,
            (
                StatusCode::UNAUTHORIZED,
                None,
                r#"{"error":"unauthorized"}"#.into()
            )
        );
        assert_eq!(
            render(ApiError::Internal(anyhow::anyhow!("secret"))).await,
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                None,
                r#"{"error":"internal"}"#.into()
            )
        );
        assert_eq!(
            render(ApiError::from(anyhow::Error::new(Busy))).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn maintenance_is_marked_as_expected() {
        let response = ApiError::Maintenance(None).into_response();
        assert!(response.extensions().get::<ExpectedFailure>().is_some());
        assert!(
            ApiError::Busy
                .into_response()
                .extensions()
                .get::<ExpectedFailure>()
                .is_none()
        );
        let (status, _, body) = render(ApiError::Maintenance(None)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, r#"{"error":"maintenance"}"#);
    }

    #[tokio::test]
    async fn renders_rejections_with_fields() {
        let mut fields = Map::new();
        fields.insert("url".into(), json!({ "code": "taken" }));
        let (status, _, body) = render(ApiError::invalid(fields)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "error": "invalid", "fields": { "url": { "code": "taken" } } })
        );
        let error = ApiError::rejected(StatusCode::BAD_GATEWAY, "registration_failed")
            .with("reason", "unreachable");
        let (status, _, body) = render(error).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "error": "registration_failed", "reason": "unreachable" })
        );
        let (status, _, body) = render(ApiError::BadRequest("no JSON".into())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"detail":"no JSON","error":"bad_request"}"#);
    }

    #[tokio::test]
    async fn rate_limit_rounds_retry_after_up() {
        let (status, retry, body) =
            render(ApiError::RateLimited(Duration::from_millis(12_300))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(retry.as_deref(), Some("13"));
        assert_eq!(body, r#"{"error":"rate_limited","retry_after":13}"#);
        let (_, retry, _) = render(ApiError::RateLimited(Duration::ZERO)).await;
        assert_eq!(retry.as_deref(), Some("1"));
    }
}
