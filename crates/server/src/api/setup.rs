//! Initial setup. As long as no administrator exists, the setup token from
//! the container log authorizes the steps; afterwards all endpoints answer
//! with 409 `setup_done`.
//!
//! - `POST setup/token` (`{token}`): checks the token.
//! - `POST setup/complete` with the token in the header `X-Setup-Token`:
//!   creates the administrator with their appearance settings in one
//!   transaction, deletes the token and signs the administrator in.
//!
//! Mail servers and system emails are added afterwards under Administration;
//! the public address comes from `ROEDY_PUBLIC_URL`.
//!
//! Every token check counts towards the lockout (five failed attempts, then
//! 30 s, per client IP) – in `setup/complete` too, otherwise it could be
//! guessed there without limit.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, FieldErrors, JsonBody, auth, me};
use crate::{
    app::AppState,
    auth::{AuthUser, session},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            known_devices,
            users::{self, NewUser, Role},
        },
    },
    events::{self, News},
    rate_limit::{Key, Policy},
    settings::{self, Accent, ColorScheme, Language, Settings},
    setup_token,
};

/// Header with the setup token for `setup/complete`.
pub const TOKEN_HEADER: &str = "x-setup-token";

/// Five failed attempts, then a 30 s lockout. The page counts the attempts
/// without a time window; here they are forgotten after ten
/// minutes.
const TOKEN_LIMIT: Policy = Policy::lockout(
    "setup.token",
    5,
    Duration::from_secs(10 * 60),
    Duration::from_secs(30),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/setup/token", post(token))
        .route("/setup/complete", post(complete))
}

fn setup_done() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "setup_done")
}

/// Checks the token with a lockout after failed attempts. After the setup
/// 409 `setup_done` (also without a token); without a token 400; wrong 422
/// `invalid_token` with `remaining` (attempts until the lockout, "3 attempts
/// left"), at the fifth 429 `rate_limited` as during the lockout.
async fn check_token(state: &AppState, ip: ClientIp, input: Option<&str>) -> Result<(), ApiError> {
    let token = db::call(&state.db, |conn| setup_token::current(conn))
        .await?
        .ok_or_else(setup_done)?;
    let Some(input) = input else {
        return Err(ApiError::BadRequest("header X-Setup-Token missing".into()));
    };
    let key = Key::Ip(ip.network());
    // Reserve up front, so that even many concurrent attempts get no more
    // than five comparisons.
    let attempt = state.limiter.reserve(&TOKEN_LIMIT, key.clone())?;
    if setup_token::matches(&token, input) {
        // A correct token does not count.
        drop(attempt);
        return Ok(());
    }
    attempt.count();
    tracing::info!(ip = %ip.0, "setup token rejected");
    let remaining = state.limiter.remaining(&TOKEN_LIMIT, &key)?;
    Err(
        ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "invalid_token")
            .with("remaining", remaining),
    )
}

/// Valid setup token from the header `X-Setup-Token`. Comes
/// before the body, so that nothing else is checked without a token.
pub struct SetupToken;

impl FromRequestParts<AppState> for SetupToken {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = ClientIp::from_request_parts(parts, state).await?;
        // A value that is not text cannot be the token and counts as a
        // failed attempt.
        let token = parts
            .headers
            .get(TOKEN_HEADER)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        check_token(state, ip, token.as_deref())
            .await
            .map(|()| Self)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

/// "Continue" with the token: answers `{}` when it matches.
async fn token(
    State(state): State<AppState>,
    ip: ClientIp,
    JsonBody(body): JsonBody<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    check_token(&state, ip, Some(&body.token)).await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteBody {
    name: String,
    email: String,
    password: String,
    settings: AppearanceBody,
}

/// Language and appearance from the first step; all three are required.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppearanceBody {
    lang: Language,
    mode: ColorScheme,
    accent: Accent,
}

/// Checked setup data.
struct Plan {
    name: String,
    email: String,
    password: String,
    /// The administrator's own settings: the defaults with the appearance
    /// from the body.
    settings: Settings,
}

/// Checks name, email address and password like the steps of the page.
fn validate(body: CompleteBody) -> Result<Plan, FieldErrors> {
    let mut errors = FieldErrors::default();
    let name = body.name.trim();
    me::check_display_name(&mut errors, "name", name);
    let email = body.email.trim();
    me::check_email(&mut errors, "email", email);
    me::check_new_password(&mut errors, "password", &body.password);
    if !errors.is_empty() {
        return Err(errors);
    }
    let AppearanceBody { lang, mode, accent } = body.settings;
    Ok(Plan {
        name: name.to_owned(),
        email: email.to_owned(),
        password: body.password,
        settings: Settings {
            lang,
            mode: Some(mode),
            accent: Some(accent),
            ..Settings::default()
        },
    })
}

/// Result of the transaction in [`complete`].
enum Outcome {
    Done(AuthUser, HeaderValue),
    /// An administrator exists by now.
    SetupDone,
}

/// "Finish setup": creates the administrator with their settings in one
/// transaction, deletes the token and signs the administrator in (201 with
/// the session cookie).
async fn complete(
    State(state): State<AppState>,
    _: SetupToken,
    ip: ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<CompleteBody>,
) -> Result<Response, ApiError> {
    let plan = validate(body).map_err(FieldErrors::into_error)?;

    // Before the transaction: hashing needs no database.
    let password_hash = state.hasher.hash(&plan.password).await?;
    let origin = auth::origin(&state, &headers, ip);

    let outcome = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Two concurrent completions: the second finds the administrator.
        if users::admin_exists(&tx)? {
            return Ok(Outcome::SetupDone);
        }
        let username = users::unique_username(&tx, &plan.email)?;
        let user_id = users::insert(
            &tx,
            &NewUser {
                username: &username,
                email: &plan.email,
                display_name: &plan.name,
                role: Role::Admin,
                password_hash: &password_hash,
            },
        )?;
        // A new account has no settings yet (version 0).
        if settings::save(&tx, &user_id, 0, &plan.settings)?.is_none() {
            anyhow::bail!("settings of the new administrator already exist");
        }
        let client = origin.client();
        let started = session::start(&tx, &user_id, &client, true)?;
        // The account's first device: known, without a notice.
        known_devices::remember(&tx, &user_id, &origin.device_hash)?;
        setup_token::delete(&tx)?;
        let admin = AuthUser {
            id: user_id,
            username,
            email: plan.email.clone(),
            display_name: plan.name.clone(),
            role: Role::Admin,
            session_id: started.id.clone(),
        };
        // Shown as "completed the initial setup", then the sign-in.
        audit_log::insert(
            &tx,
            &Entry::new(Category::System, "setup.complete")
                .actor(&admin)
                .ip(ip.0),
        )?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.login")
                .actor(&admin)
                .client(&client)
                .target(&started.id)
                .details(json!({ "method": "setup" })),
        )?;
        events::news(&tx, &admin.id, News::Welcome)?;
        tx.commit()?;
        Ok(Outcome::Done(admin, started.cookie))
    })
    .await?;
    let (admin, cookie) = match outcome {
        Outcome::Done(admin, cookie) => (admin, cookie),
        Outcome::SetupDone => return Err(setup_done()),
    };
    tracing::info!(user = %admin.id, "setup completed");
    let body = Json(json!({ "user": auth::user_json(&admin) }));
    Ok((StatusCode::CREATED, [(header::SET_COOKIE, cookie)], body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> Result<CompleteBody, serde_json::Error> {
        serde_json::from_value(value)
    }

    fn valid() -> Value {
        json!({
            "name": " Max Smith ",
            "email": " max@example.com ",
            "password": "Summer2026!",
            "settings": { "lang": "de", "mode": "dark", "accent": "sage" },
        })
    }

    fn errors_of(value: Value) -> Value {
        match validate(body(value).unwrap()) {
            Ok(_) => panic!("expected errors"),
            Err(errors) => errors.into_value(),
        }
    }

    #[test]
    fn validates_and_takes_the_appearance() {
        let plan = validate(body(valid()).unwrap()).unwrap();
        assert_eq!(plan.name, "Max Smith");
        assert_eq!(plan.email, "max@example.com");
        assert_eq!(plan.settings.lang, Language::German);
        assert_eq!(plan.settings.mode, Some(ColorScheme::Dark));
        assert_eq!(plan.settings.accent, Some(Accent::Sage));
        // Everything else keeps the defaults.
        assert_eq!(
            Settings {
                lang: Language::default(),
                mode: None,
                accent: None,
                ..plan.settings
            },
            Settings::default()
        );
    }

    #[test]
    fn reports_every_field() {
        assert_eq!(
            errors_of(json!({
                "name": " ",
                "email": "max@example",
                "password": "short",
                "settings": { "lang": "en", "mode": "system", "accent": "apricot" },
            })),
            json!({
                "name": { "code": "required" },
                "email": { "code": "invalid" },
                "password": { "code": "policy", "rules": ["len", "case", "num"] },
            })
        );

        let mut long = valid();
        long["password"] = json!(format!("Aa1{}", "x".repeat(auth::MAX_PASSWORD)));
        long["name"] = json!("M".repeat(me::MAX_NAME + 1));
        assert_eq!(
            errors_of(long),
            json!({
                "name": { "code": "too_long" },
                "password": { "code": "too_long" },
            })
        );

        let mut digit = valid();
        digit["name"] = json!("Max Smith 2");
        assert_eq!(errors_of(digit), json!({ "name": { "code": "invalid" } }));
    }

    #[test]
    fn requires_all_three_settings_with_known_values() {
        for field in ["lang", "mode", "accent"] {
            let mut missing = valid();
            missing["settings"].as_object_mut().unwrap().remove(field);
            assert!(body(missing).is_err(), "without {field}");
        }
        for (field, value) in [("lang", "fr"), ("mode", "dim"), ("accent", "teal")] {
            let mut unknown = valid();
            unknown["settings"][field] = json!(value);
            assert!(body(unknown).is_err(), "{field}: {value}");
        }
        let mut without = valid();
        without.as_object_mut().unwrap().remove("settings");
        assert!(body(without).is_err());
    }

    #[test]
    fn rejects_unknown_fields() {
        for (path, field) in [
            (None, "role"),
            (None, "server"),
            (None, "public_url"),
            (None, "system_mail"),
            (Some("settings"), "density"),
        ] {
            let mut extra = valid();
            let target = match path {
                Some(path) => &mut extra[path],
                None => &mut extra,
            };
            target[field] = json!("x");
            assert!(body(extra).is_err(), "{field}");
        }
    }
}
