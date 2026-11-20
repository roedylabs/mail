//! Diagnostics and DCR against a local test server (`fake_stalwart`):
//! success, CORS missing, OAuth missing or not matching, old version,
//! throttled, unreachable.

mod fake_stalwart;

use std::time::Duration;

use axum::http::StatusCode;
use fake_stalwart::{
    ADMIN, ADMIN_PASSWORD, CLIENT_ID, CLIENT_SECRET, Options, RETRY_AFTER, Server, unreachable_url,
};
use roedy_mail_server::broker::{
    dcr::{self, Error, Registration},
    http_client,
    probe::{self, Reasons, Report, Status, Target},
};
use serde_json::json;
use url::Url;

const ORIGIN: &str = "https://app.example.com";

async fn probe(url: &str, client_id: Option<&str>, origin: &str) -> Report {
    let base_url = Url::parse(url).unwrap();
    probe::probe(
        &http_client().unwrap(),
        &Target {
            base_url: &base_url,
            client_id,
            has_secret: false,
            origin,
        },
    )
    .await
}

fn report(reach: Status, cors: Status, oauth: Status, reasons: Reasons) -> Report {
    Report {
        reach,
        cors,
        oauth,
        reasons,
        retry_after: None,
    }
}

#[tokio::test]
async fn probe_succeeds_against_stalwart() {
    let server = Server::start(Options::default()).await;
    assert_eq!(
        probe(&server.url, Some(CLIENT_ID), ORIGIN).await,
        report(Status::Ok, Status::Ok, Status::Ok, Reasons::default())
    );
}

#[tokio::test]
async fn probe_reports_missing_cors() {
    let server = Server::start(Options {
        cors: false,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(
        (result.reach, result.cors, result.oauth),
        (Status::Ok, Status::Err, Status::Ok)
    );
    assert_eq!(result.reasons.cors, Some("origin_not_allowed"));
}

#[tokio::test]
async fn probe_needs_authorization_and_content_type() {
    for (allow, expected) in [
        ("Authorization", Some("content_type_not_allowed")),
        ("*", Some("authorization_not_allowed")),
        ("Content-Type", Some("authorization_not_allowed")),
        ("authorization, *", None),
        ("Content-Type,Authorization", None),
    ] {
        let server = Server::start(Options {
            allow_headers: Some(allow),
            ..Options::default()
        })
        .await;
        let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
        assert_eq!(result.reasons.cors, expected, "{allow}");
        let status = if expected.is_some() {
            Status::Err
        } else {
            Status::Ok
        };
        assert_eq!(result.cors, status, "{allow}");
    }
}

#[tokio::test]
async fn probe_applies_metadata_defaults() {
    // Without `grant_types_supported` there are no refresh tokens per RFC 8414.
    let server = Server::start(Options {
        minimal_metadata: true,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(
        (result.oauth, result.reasons.oauth),
        (Status::Err, Some("grant_types"))
    );
}

#[tokio::test]
async fn probe_checks_issuer_and_client_kind() {
    // The browser compares `iss` of the redirect back with the `issuer`.
    let server = Server::start(Options {
        foreign_issuer: true,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(
        (result.oauth, result.reasons.oauth),
        (Status::Err, Some("issuer_mismatch"))
    );

    // With a secret the backend authenticates at the token endpoint.
    let server = Server::start(Options::default()).await;
    let base_url = Url::parse(&server.url).unwrap();
    let result = probe::probe(
        &http_client().unwrap(),
        &Target {
            base_url: &base_url,
            client_id: Some(CLIENT_ID),
            has_secret: true,
            origin: ORIGIN,
        },
    )
    .await;
    assert_eq!(result.oauth, Status::Ok, "{result:?}");
}

#[tokio::test]
async fn probe_reports_missing_oauth() {
    let server = Server::start(Options::default()).await;
    let result = probe(&server.url, None, ORIGIN).await;
    assert_eq!(
        (result.reach, result.cors, result.oauth),
        (Status::Ok, Status::Ok, Status::Err)
    );
    assert_eq!(result.reasons.oauth, Some("no_client_id"));

    let server = Server::start(Options {
        metadata: false,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(result.oauth, Status::Err);
    assert_eq!(result.reasons.oauth, Some("no_metadata"));
}

#[tokio::test]
async fn probe_reports_stalwart_v016_as_unsupported() {
    // Even without a client ID: no client helps for v0.16.
    let server = Server::start(Options {
        v016: true,
        ..Options::default()
    })
    .await;
    for client_id in [Some(CLIENT_ID), None] {
        let result = probe(&server.url, client_id, ORIGIN).await;
        assert_eq!(
            (result.reach, result.cors, result.oauth),
            (Status::Ok, Status::Ok, Status::Err)
        );
        assert_eq!(result.reasons.oauth, Some("unsupported_version"));
    }
}

#[tokio::test]
async fn probe_stops_when_throttled() {
    // Requests of the diagnostics: discovery, session, preflight, metadata.
    let throttled = |after| async move {
        let server = Server::start(Options {
            throttle_after: Some(after),
            ..Options::default()
        })
        .await;
        probe(&server.url, Some(CLIENT_ID), ORIGIN).await
    };
    let wait = Some(Duration::from_secs(RETRY_AFTER));
    let mut expected = report(
        Status::Unk,
        Status::Unk,
        Status::Unk,
        Reasons {
            reach: Some("throttled"),
            cors: Some("throttled"),
            oauth: Some("throttled"),
        },
    );
    expected.retry_after = wait;
    assert_eq!(throttled(0).await, expected);
    assert_eq!(throttled(1).await, expected);

    expected.reach = Status::Ok;
    expected.reasons.reach = None;
    assert_eq!(throttled(2).await, expected);

    expected.cors = Status::Ok;
    expected.reasons.cors = None;
    assert_eq!(throttled(3).await, expected);
}

#[tokio::test]
async fn probe_reports_unreachable_server() {
    let url = unreachable_url();
    assert_eq!(
        probe(&url, Some(CLIENT_ID), ORIGIN).await,
        report(
            Status::Err,
            Status::Unk,
            Status::Unk,
            Reasons {
                reach: Some("unreachable"),
                cors: Some("not_reachable"),
                oauth: Some("not_reachable"),
            }
        )
    );
}

#[tokio::test]
async fn probe_checks_session_details() {
    // Without a session for guests: reachable, but the capabilities stay open.
    let server = Server::start(Options {
        session_needs_auth: true,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(
        (result.reach, result.reasons.reach),
        (Status::Ok, Some("auth_required"))
    );
    assert_eq!(
        (result.cors, result.reasons.cors),
        (Status::Unk, Some("no_api_url"))
    );
    assert_eq!(result.oauth, Status::Ok);

    // An `apiUrl` on another host would not be allowed by the CSP.
    let server = Server::start(Options {
        foreign_api_url: true,
        ..Options::default()
    })
    .await;
    let result = probe(&server.url, Some(CLIENT_ID), ORIGIN).await;
    assert_eq!(
        (result.reach, result.reasons.reach),
        (Status::Err, Some("api_url_mismatch"))
    );
}

fn registration<'a>(base_url: &'a Url, password: &'a str) -> Registration<'a> {
    Registration {
        base_url,
        redirect_uri: "https://app.example.com/oauth/callback",
        client_uri: ORIGIN,
        username: ADMIN,
        password,
    }
}

#[tokio::test]
async fn dcr_registers_confidential_client() {
    let server = Server::start(Options::default()).await;
    let base_url = Url::parse(&server.url).unwrap();
    let client = dcr::register(
        &http_client().unwrap(),
        &registration(&base_url, ADMIN_PASSWORD),
    )
    .await
    .unwrap();
    assert_eq!(
        (client.client_id.as_str(), client.client_secret.as_str()),
        (CLIENT_ID, CLIENT_SECRET)
    );
    // The secret stays out of outputs.
    assert!(!format!("{client:?}").contains(CLIENT_SECRET));
    let sent = server.registrations();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0],
        json!({
            "redirect_uris": ["https://app.example.com/oauth/callback"],
            "client_name": "Roedy Mail",
            "client_uri": ORIGIN,
            "application_type": "web",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_basic",
            "scope": "offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts",
        })
    );
}

#[tokio::test]
async fn dcr_reports_errors() {
    let http = http_client().unwrap();
    let server = Server::start(Options::default()).await;
    let base_url = Url::parse(&server.url).unwrap();
    let register = |base_url: Url, password: &'static str| {
        let http = http.clone();
        async move {
            dcr::register(&http, &registration(&base_url, password))
                .await
                .map(|client| client.client_id)
        }
    };
    assert_eq!(
        register(base_url.clone(), "wrong").await,
        Err(Error::AuthFailed)
    );

    let mut insecure = registration(&base_url, ADMIN_PASSWORD);
    insecure.redirect_uri = "http://app.example.com/oauth/callback";
    assert_eq!(
        dcr::register(&http, &insecure).await.map(|c| c.client_id),
        Err(Error::Rejected("invalid_redirect_uri".into()))
    );

    // 402 (second factor), 403 (without `SysOAuthClientCreate`),
    // 429 with a wait time.
    for (status, error) in [
        (StatusCode::PAYMENT_REQUIRED, Error::MfaRequired),
        (StatusCode::FORBIDDEN, Error::Forbidden),
        (
            StatusCode::TOO_MANY_REQUESTS,
            Error::Throttled(Duration::from_secs(RETRY_AFTER)),
        ),
        (StatusCode::INTERNAL_SERVER_ERROR, Error::InvalidResponse),
    ] {
        let server = Server::start(Options {
            register_status: Some(status),
            ..Options::default()
        })
        .await;
        let base_url = Url::parse(&server.url).unwrap();
        assert_eq!(register(base_url, ADMIN_PASSWORD).await, Err(error));
    }

    // Throttled already at the metadata.
    let server = Server::start(Options {
        throttle_after: Some(0),
        ..Options::default()
    })
    .await;
    let base_url = Url::parse(&server.url).unwrap();
    assert_eq!(
        register(base_url, ADMIN_PASSWORD).await,
        Err(Error::Throttled(Duration::from_secs(RETRY_AFTER)))
    );

    // Stalwart v0.16: the credentials do not even go out.
    let server = Server::start(Options {
        v016: true,
        ..Options::default()
    })
    .await;
    let base_url = Url::parse(&server.url).unwrap();
    let result = register(base_url, ADMIN_PASSWORD).await;
    assert_eq!(result, Err(Error::UnsupportedVersion));
    assert_eq!(result.unwrap_err().reason(), "unsupported_version");
    assert!(server.registrations().is_empty());

    let server = Server::start(Options {
        metadata: false,
        ..Options::default()
    })
    .await;
    let base_url = Url::parse(&server.url).unwrap();
    assert_eq!(
        register(base_url, ADMIN_PASSWORD).await,
        Err(Error::Unsupported)
    );

    let base_url = Url::parse(&unreachable_url()).unwrap();
    let result = register(base_url, ADMIN_PASSWORD).await;
    assert_eq!(result, Err(Error::Unreachable));
    assert_eq!(result.unwrap_err().reason(), "unreachable");
}
