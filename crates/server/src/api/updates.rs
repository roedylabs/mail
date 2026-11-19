//! Administration › Updates.
//!
//! - `GET admin/updates`: state (installed and latest version, last and next
//!   check, status), schedule, display and token without the secret.
//! - `PUT admin/updates`: changes the given fields; the backend first checks
//!   a new token `pat` against GitHub and stores it only if it is valid. The
//!   token is optional and only raises GitHub's rate limit.
//! - `POST admin/updates/remove-pat`: removes the token.
//! - `POST admin/updates/check`: "Check now".

use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use jiff::Timestamp;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;

use super::{ApiError, FieldErrors, JsonBody, servers::audit_entry};
use crate::{
    app::AppState,
    auth::AdminUser,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category},
            update_state,
        },
    },
    rate_limit::{Key, Policy},
    settings::{self, Clock},
    updates::{self, Day, Every, Pat, Release, github},
};

/// Requests to GitHub per administrator (check and new token): enough for the
/// page, too few to use up GitHub's rate limit for a token.
const CHECK: Policy = Policy::rate("updates.check", 20, Duration::from_secs(10 * 60));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/updates", get(show).put(update))
        .route("/admin/updates/remove-pat", post(remove_pat))
        .route("/admin/updates/check", post(check))
}

/// Token without the secret: prefix, last characters and when it was saved.
#[derive(Debug, Serialize)]
struct PatView {
    prefix: String,
    tail: String,
    saved_at: String,
}

/// Response of all calls.
#[derive(Debug, Serialize)]
struct View {
    version: &'static str,
    latest: Option<String>,
    available: bool,
    /// `ok` or `err`.
    status: &'static str,
    /// With `err`: `token`, `no_access`, `rate_limited` or `unreachable`.
    reason: Option<String>,
    checked_at: Option<String>,
    /// `null` when no check is scheduled ("Disabled").
    next_at: Option<String>,
    auto: bool,
    every: Every,
    time: Clock,
    weekday: Day,
    show: bool,
    pat: Option<PatView>,
    /// `public/config` › `update`: lets About follow without knowing the rule.
    update: Option<updates::Hint>,
}

impl View {
    fn load(conn: &rusqlite::Connection) -> anyhow::Result<Self> {
        let settings = updates::load(conn)?;
        let known = update_state::load(conn)?;
        let now = Timestamp::now();
        let next_at = settings.next_check(known.checked(), now);
        let status = if known.reason.is_some() { "err" } else { "ok" };
        Ok(Self {
            version: updates::VERSION,
            available: known
                .latest
                .as_deref()
                .is_some_and(|latest| updates::newer(latest, updates::VERSION)),
            latest: known.latest,
            status,
            reason: known.reason.filter(|_| status == "err"),
            checked_at: known.checked_at,
            // A missed date does not lie in the past, the job catches up on it
            // right away.
            next_at: next_at.map(|at| at.max(now).to_string()),
            auto: settings.auto,
            every: settings.every,
            time: settings.time,
            weekday: settings.weekday,
            show: settings.show,
            pat: settings.pat.map(|pat| PatView {
                prefix: pat.prefix,
                tail: pat.tail,
                saved_at: pat.saved_at,
            }),
            update: updates::hint(conn)?,
        })
    }
}

async fn show(State(state): State<AppState>, _: AdminUser) -> Result<Json<View>, ApiError> {
    Ok(Json(db::call(&state.db, |conn| View::load(conn)).await?))
}

/// Body of `PUT`: the changed fields. No `Debug`, `pat` is a secret.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    auto: Option<bool>,
    every: Option<String>,
    time: Option<String>,
    weekday: Option<String>,
    show: Option<bool>,
    pat: Option<String>,
}

/// Validated changes; `None` = unchanged.
#[derive(Default)]
struct Changes {
    auto: Option<bool>,
    every: Option<Every>,
    time: Option<Clock>,
    weekday: Option<Day>,
    show: Option<bool>,
    pat: Option<String>,
}

/// Value from a fixed set of names, or an error on the field.
fn choice<T: DeserializeOwned>(
    errors: &mut FieldErrors,
    field: &str,
    value: Option<String>,
) -> Option<T> {
    let parsed = serde_json::from_value(json!(value?)).ok();
    if parsed.is_none() {
        errors.code(field, "invalid");
    }
    parsed
}

impl Body {
    fn checked(self) -> Result<Changes, ApiError> {
        let mut errors = FieldErrors::default();
        let every = choice(&mut errors, "every", self.every);
        let weekday = choice(&mut errors, "weekday", self.weekday);
        let time = self.time.and_then(|time| {
            let parsed = Clock::try_from(time).ok();
            if parsed.is_none() {
                errors.code("time", "invalid");
            }
            parsed
        });
        let pat = self.pat.map(|pat| pat.trim().to_owned());
        if pat.as_deref().is_some_and(|pat| !updates::valid_pat(pat)) {
            errors.code("pat", "invalid");
        }
        if !errors.is_empty() {
            return Err(errors.into_error());
        }
        Ok(Changes {
            auto: self.auto,
            every,
            time,
            weekday,
            show: self.show,
            pat,
        })
    }
}

/// Queries GitHub with the new token. What GitHub rejects is `invalid` on the
/// field, what says nothing about the token is `unavailable`.
async fn verify(state: &AppState, pat: &str) -> Result<Option<Release>, ApiError> {
    github::newest(&state.http, &state.github_api, Some(pat))
        .await
        .map_err(|failure| {
            let code = if failure.temporary() {
                "unavailable"
            } else {
                "invalid"
            };
            let mut errors = FieldErrors::default();
            errors.code("pat", code);
            errors.into_error()
        })
}

async fn update(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<Body>,
) -> Result<Json<View>, ApiError> {
    let mut changes = body.checked()?;
    let token = changes.pat.take();
    let verified = match token {
        Some(token) => {
            state.limiter.acquire(&CHECK, Key::User(user.id.clone()))?;
            let release = verify(&state, &token).await?;
            Some((token, release))
        }
        None => None,
    };
    let (secrets, instance) = (state.secrets.clone(), state.instance.clone());
    let view = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let before = updates::load(&tx)?;
        let mut next = before.clone();
        next.auto = changes.auto.unwrap_or(next.auto);
        next.every = changes.every.unwrap_or(next.every);
        next.weekday = changes.weekday.unwrap_or(next.weekday);
        next.show = changes.show.unwrap_or(next.show);
        if let Some(time) = changes.time {
            next.time = time;
        }
        if next.schedule() != before.schedule() {
            next.tz = Some(settings::load(&tx, &user.id)?.settings.tz);
        }
        if next != before {
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "updates.settings", &user, ip),
            )?;
        }
        if let Some((token, release)) = verified {
            let now = Timestamp::now();
            next.pat = Some(Pat::new(&secrets, &token, now)?);
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "updates.pat", &user, ip),
            )?;
            updates::record(&tx, Ok(release), now)?;
        }
        if next != before {
            updates::save(&tx, &next)?;
        }
        tx.commit()?;
        instance.reload_update(conn)?;
        View::load(conn)
    })
    .await?;
    Ok(Json(view))
}

async fn remove_pat(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
) -> Result<Json<View>, ApiError> {
    let instance = state.instance.clone();
    let view = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let mut settings = updates::load(&tx)?;
        if settings.pat.take().is_some() {
            updates::save(&tx, &settings)?;
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "updates.pat_remove", &user, ip),
            )?;
        }
        tx.commit()?;
        instance.reload_update(conn)?;
        View::load(conn)
    })
    .await?;
    Ok(Json(view))
}

/// "Check now", with or without a token; a failed check ends up in the status
/// as in the job.
async fn check(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
) -> Result<Json<View>, ApiError> {
    state.limiter.acquire(&CHECK, Key::User(user.id.clone()))?;
    updates::check(&state).await?;
    let view = db::call(&state.db, move |conn| {
        audit_log::insert(
            conn,
            &audit_entry(Category::System, "updates.check", &user, ip),
        )?;
        View::load(conn)
    })
    .await?;
    Ok(Json(view))
}
