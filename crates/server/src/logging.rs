//! Logging with `tracing`. Logs go to stderr so that stdout stays
//! free for the output of subcommands; `docker logs` shows both.

use std::{borrow::Cow, fmt::Display, io::IsTerminal as _};

use anyhow::{Context as _, anyhow};
use axum::http::{Request, Response};
use tower_http::classify::{
    ClassifiedResponse, ClassifyResponse, NeverClassifyEos, ServerErrorsAsFailures,
    ServerErrorsFailureClass,
};
use tracing::Span;
use tracing_subscriber::{EnvFilter, filter::Directive};

use crate::config::{Config, LogFormat};

/// Target of the setup token message. It appears regardless of `ROEDY_LOG`,
/// because the initial setup is impossible without it.
pub const SETUP_TARGET: &str = "setup";

pub fn init(config: &Config) -> anyhow::Result<()> {
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter(&config.log)?)
        .with_writer(std::io::stderr);
    match config.log_format {
        LogFormat::Json => builder.json().flatten_event(true).try_init(),
        LogFormat::Text => builder
            .with_ansi(std::io::stderr().is_terminal())
            .try_init(),
    }
    .map_err(|e| anyhow!(e).context("Logging could not be set up"))
}

/// Paths whose next segment is a token from a mail link (tokens never
/// appear in logs). The SPA routes are included because the backend serves
/// them itself: whoever opens the link from the mail loads the page directly
/// from here. For `/api/v1/invites/` this also hits IDs
/// (`invites/:id/resend`), which the log does not miss.
const TOKEN_PREFIXES: &[&str] = &[
    "/api/v1/auth/password/reset/",
    "/api/v1/invites/",
    "/invite/",
    "/password/reset/",
    "/confirm-email/",
];

/// Replacement for a redacted segment.
const REDACTED: &str = "***";

/// Path for the request log with token segments redacted. The query is left
/// out entirely (e.g. `code` and `state` in `/oauth/callback?…`).
pub fn redact_path(path: &str) -> Cow<'_, str> {
    for prefix in TOKEN_PREFIXES {
        if let Some(rest) = path.strip_prefix(prefix) {
            if rest.is_empty() {
                break;
            }
            let tail = rest.find('/').map_or("", |i| &rest[i..]);
            return Cow::Owned(format!("{prefix}{REDACTED}{tail}"));
        }
    }
    Cow::Borrowed(path)
}

/// Span per request for `TraceLayer` (level `debug`) – only method and
/// [`redact_path`] instead of the full URI. Same target as `DefaultMakeSpan`,
/// so that `ROEDY_LOG=…,tower_http=debug` enables span and events together.
pub fn request_span<B>(request: &Request<B>) -> Span {
    tracing::debug_span!(
        target: "tower_http::trace::make_span",
        "request",
        method = %request.method(),
        path = %redact_path(request.uri().path()),
    )
}

/// Marks a 5xx response that is part of normal operation, like 503
/// `maintenance`: it produces no ERROR, so the log stays searchable for
/// errors in maintenance mode.
#[derive(Clone, Copy, Debug)]
pub struct ExpectedFailure;

/// Classifier for `TraceLayer`: like `ServerErrorsAsFailures`, except that
/// responses with [`ExpectedFailure`] do not count as failures. The status
/// alone is not enough: 503 `busy` and `unavailable` should still stand out.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequestClassifier;

impl ClassifyResponse for RequestClassifier {
    type FailureClass = ServerErrorsFailureClass;
    type ClassifyEos = NeverClassifyEos<ServerErrorsFailureClass>;

    fn classify_response<B>(
        self,
        response: &Response<B>,
    ) -> ClassifiedResponse<Self::FailureClass, Self::ClassifyEos> {
        if response.extensions().get::<ExpectedFailure>().is_some() {
            return ClassifiedResponse::Ready(Ok(()));
        }
        ServerErrorsAsFailures::new().classify_response(response)
    }

    fn classify_error<E>(self, error: &E) -> Self::FailureClass
    where
        E: Display + 'static,
    {
        ServerErrorsAsFailures::new().classify_error(error)
    }
}

fn filter(log: &str) -> anyhow::Result<EnvFilter> {
    let setup: Directive = format!("{SETUP_TARGET}=info").parse()?;
    Ok(EnvFilter::try_new(log)
        .with_context(|| format!("ROEDY_LOG is invalid: \"{log}\""))?
        .add_directive(setup))
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        io,
        sync::{Arc, Mutex},
    };

    use axum::{body::Body, http::StatusCode};
    use tower::{ServiceBuilder, ServiceExt as _, service_fn};
    use tower_http::{classify::SharedClassifier, trace::TraceLayer};

    use super::*;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Buffer {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Returns what arrives of two info messages with `ROEDY_LOG=log`.
    fn logged_with(log: &str) -> String {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter(log).unwrap())
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: SETUP_TARGET, "Setup-Token: TEST");
            tracing::info!(target: "other", "other message");
        });
        String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn setup_token_survives_restrictive_filters() {
        for log in ["warn", "off", "roedy_mail_server=debug"] {
            let out = logged_with(log);
            assert!(out.contains("Setup-Token: TEST"), "{log}: {out}");
            assert!(!out.contains("other message"), "{log}: {out}");
        }
        assert!(logged_with("info").contains("other message"));
    }

    #[test]
    fn redacts_token_segments() {
        for (path, logged) in [
            ("/invite/K7Q2-abc", "/invite/***"),
            ("/password/reset/abc/", "/password/reset/***/"),
            ("/confirm-email/abc.def", "/confirm-email/***"),
            (
                "/api/v1/auth/password/reset/abc",
                "/api/v1/auth/password/reset/***",
            ),
            ("/api/v1/invites/abc/accept", "/api/v1/invites/***/accept"),
            ("/api/v1/invites", "/api/v1/invites"),
            ("/api/v1/invites/", "/api/v1/invites/"),
            ("/invite", "/invite"),
            ("/mailbox/inbox", "/mailbox/inbox"),
            ("/oauth/callback", "/oauth/callback"),
        ] {
            assert_eq!(redact_path(path), logged, "{path}");
        }
    }

    #[test]
    fn request_log_contains_no_token_or_query() {
        // Also with `tower_http=debug` alone (same target as DefaultMakeSpan).
        for log in ["debug", "info,tower_http=debug"] {
            let buffer = Buffer::default();
            let writer = buffer.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_env_filter(filter(log).unwrap())
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish();
            tracing::subscriber::with_default(subscriber, || {
                for uri in ["/invite/SECRET1", "/oauth/callback?code=SECRET2&state=x"] {
                    let request = Request::get(uri).body(()).unwrap();
                    request_span(&request)
                        .in_scope(|| tracing::debug!(target: "tower_http::trace", "request"));
                }
            });
            let out = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
            assert!(out.contains("path=/invite/***"), "{log}: {out}");
            assert!(out.contains("path=/oauth/callback"), "{log}: {out}");
            assert!(!out.contains("SECRET"), "{log}: {out}");
        }
    }

    /// Sends a response with `status` through the app's `TraceLayer`; returns the log.
    async fn trace(status: StatusCode, expected: bool) -> String {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter("info").unwrap())
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let service = ServiceBuilder::new()
            .layer(TraceLayer::new(SharedClassifier::new(RequestClassifier)))
            .service(service_fn(move |_: Request<Body>| async move {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = status;
                if expected {
                    response.extensions_mut().insert(ExpectedFailure);
                }
                Ok::<_, Infallible>(response)
            }));
        let request = Request::get("/").body(Body::empty()).unwrap();
        let response = service.oneshot(request).await.unwrap();
        assert_eq!(response.status(), status);
        String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap()
    }

    #[tokio::test]
    async fn expected_failure_logs_no_error() {
        let out = trace(StatusCode::SERVICE_UNAVAILABLE, true).await;
        assert!(!out.contains("ERROR"), "{out}");
    }

    #[tokio::test]
    async fn other_server_errors_stay_errors() {
        for status in [
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let out = trace(status, false).await;
            assert!(out.contains("ERROR"), "{status}: {out}");
        }
        assert!(!trace(StatusCode::OK, false).await.contains("ERROR"));
    }

    #[test]
    fn rejects_invalid_filter() {
        let err = filter("[[").unwrap_err();
        assert!(err.to_string().contains("ROEDY_LOG"), "{err}");
    }
}
