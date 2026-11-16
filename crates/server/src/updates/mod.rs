//! Updates: Roedy Mail checks for new versions on a schedule, reports them to
//! the administrators and, after an update, to everyone.
//!
//! - [`Settings`] live in `app_settings.updates` (schedule, display, optional
//!   token encrypted), the result of the checks in `update_state`.
//! - [`check`] queries [`github`] and records the result with [`record`]:
//!   "Update available" comes once per version. The job `update_check` calls
//!   it on schedule, `api::updates` on "Check now".
//! - [`on_start`] detects the version change: "Update installed" to the
//!   administrators with system notice `system_update`, "New in version …" to
//!   everyone.
//! - [`hint`] is the notice for everyone in `public/config`, held in
//!   `Instance`.
//!
//! The token appears in no response, no log and no audit log entry.

pub mod github;
pub mod schedule;

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jiff::{Timestamp, tz::TimeZone};
use rusqlite::Connection;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub use github::{Failure, Release};
pub use schedule::{Day, Every};

use crate::{
    app::AppState,
    broker::crypto::SecretKey,
    db::{
        self,
        repo::{
            app_settings,
            audit_log::{self, Category, Entry},
            notifications, update_state,
        },
    },
    events::{self, News, Outbox},
    instance,
    mailer::format::{self, DEFAULT_TZ},
    settings::{Clock, Zone},
};

/// Key in `app_settings`.
pub const KEY: &str = "updates";
/// Purpose for the AAD of the token; the row is [`KEY`].
const PAT_PURPOSE: &str = "app_settings.updates.pat";

/// Installed version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Short commit of the build, if known (release workflow).
const BUILD: Option<&str> = option_env!("ROEDY_BUILD_SHA");

/// Accepted token prefixes: classic and fine-grained personal access tokens.
const PAT_PREFIXES: [&str; 2] = ["github_pat_", "ghp_"];
/// Characters after the prefix.
const PAT_LEN: std::ops::RangeInclusive<usize> = 20..=255;
/// Visible end of the token (`pat.masked`).
const PAT_TAIL: usize = 4;

/// Settings in `app_settings.updates`. The token is optional: the repository
/// is public, a token only raises GitHub's rate limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub auto: bool,
    pub every: Every,
    pub time: Clock,
    pub weekday: Day,
    pub show: bool,
    /// Time zone of the administrator who last changed the schedule; without a
    /// change `DEFAULT_TZ`.
    pub tz: Option<Zone>,
    pub pat: Option<Pat>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto: true,
            every: Every::default(),
            time: Clock::fixed("03:00"),
            weekday: Day::default(),
            show: true,
            tz: None,
            pat: None,
        }
    }
}

impl Settings {
    fn zone(&self) -> TimeZone {
        format::named_zone(self.tz.as_ref().map_or(DEFAULT_TZ, Zone::as_str))
    }

    /// Next check; `None` if automatic checks are disabled. Without a
    /// previous check it is due right away.
    pub fn next_check(&self, last: Option<Timestamp>, now: Timestamp) -> Option<Timestamp> {
        if !self.auto {
            return None;
        }
        Some(last.map_or(now, |last| {
            schedule::next(
                self.every,
                self.weekday,
                self.time.time(),
                &self.zone(),
                last,
            )
        }))
    }

    /// The fields the time zone belongs to.
    pub fn schedule(&self) -> (Every, &Clock, Day) {
        (self.every, &self.time, self.weekday)
    }
}

/// Stored token; the page shows `prefix`, `tail` and `saved_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pat {
    enc: String,
    pub prefix: String,
    pub tail: String,
    pub saved_at: String,
}

impl Pat {
    pub fn new(secrets: &SecretKey, token: &str, at: Timestamp) -> anyhow::Result<Self> {
        let prefix = PAT_PREFIXES
            .into_iter()
            .find(|prefix| token.starts_with(prefix))
            .unwrap_or_default();
        let tail = token
            .get(token.len().saturating_sub(PAT_TAIL)..)
            .unwrap_or_default();
        Ok(Self {
            enc: STANDARD.encode(secrets.seal(PAT_PURPOSE, KEY, token.as_bytes())?),
            prefix: prefix.to_owned(),
            tail: tail.to_owned(),
            saved_at: at.to_string(),
        })
    }

    fn token(&self, secrets: &SecretKey) -> anyhow::Result<String> {
        let sealed = STANDARD
            .decode(&self.enc)
            .context("app_settings.updates: token is not Base64")?;
        String::from_utf8(secrets.open(PAT_PURPOSE, KEY, &sealed)?)
            .context("app_settings.updates: token is not UTF-8")
    }
}

/// Whether `token` has the form of a GitHub token. Rejects before the request
/// what GitHub would not accept anyway, and keeps foreign content out of the
/// header.
pub fn valid_pat(token: &str) -> bool {
    PAT_PREFIXES
        .into_iter()
        .find_map(|prefix| token.strip_prefix(prefix))
        .is_some_and(|rest| {
            PAT_LEN.contains(&rest.len())
                && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

/// Settings from the database; if they are not readable, the defaults apply
/// and the token is kept if possible.
pub fn load(conn: &Connection) -> anyhow::Result<Settings> {
    let settings = instance::load(conn, KEY, |value| Settings {
        pat: value
            .get("pat")
            .cloned()
            .and_then(|pat| serde_json::from_value(pat).ok()),
        ..Settings::default()
    })?;
    Ok(settings.unwrap_or_default())
}

pub fn save(conn: &Connection, settings: &Settings) -> anyhow::Result<()> {
    app_settings::set(conn, KEY, settings)
}

/// Whether `version` is newer than `than`; anything unreadable is older than
/// everything else.
pub fn newer(version: &str, than: &str) -> bool {
    match (Version::parse(version), Version::parse(than)) {
        (Ok(version), Ok(than)) => version > than,
        (Ok(_), Err(_)) => true,
        (Err(_), _) => false,
    }
}

/// Notice for everyone (`public/config` › `update`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hint {
    pub available: bool,
    pub latest: String,
}

/// `None` if the display is off or the app cannot know its state: before a
/// check has found a version, and after a failed one – then a new version
/// found earlier still holds, but "up to date" no longer does.
pub fn hint(conn: &Connection) -> anyhow::Result<Option<Hint>> {
    let settings = load(conn)?;
    if !settings.show {
        return Ok(None);
    }
    let known = update_state::load(conn)?;
    let Some(latest) = known.latest else {
        return Ok(None);
    };
    let available = newer(&latest, VERSION);
    Ok((available || known.reason.is_none()).then_some(Hint { available, latest }))
}

/// Whether the scheduled check is due.
pub fn due(conn: &Connection, now: Timestamp) -> anyhow::Result<bool> {
    let last = update_state::load(conn)?.checked();
    Ok(load(conn)?
        .next_check(last, now)
        .is_some_and(|next| next <= now))
}

/// Records the result of a check and reports a new version, in the caller's
/// transaction. Each version comes once; it is only new compared to the
/// installed one and the one reported last.
pub fn record(
    conn: &Connection,
    result: Result<Option<Release>, Failure>,
    now: Timestamp,
) -> anyhow::Result<()> {
    let release = match result {
        Ok(release) => release,
        Err(failure) => {
            update_state::failed(conn, failure.code(), now)?;
            return Ok(());
        }
    };
    let (version, summary) = release.map_or((None, None), |release| {
        (Some(release.version), release.summary)
    });
    update_state::succeeded(conn, version.as_deref(), summary.as_deref(), now)?;
    let Some(version) = version else {
        return Ok(());
    };
    let notified = update_state::load(conn)?.last_notified_version;
    if newer(&version, VERSION) && notified.is_none_or(|last| newer(&version, &last)) {
        events::update_available(conn, &version)?;
        audit_log::insert(
            conn,
            &Entry::new(Category::System, "updates.available")
                .details(json!({ "version": version })),
        )?;
        update_state::set_notified(conn, &version)?;
    }
    Ok(())
}

/// Like [`record`] for the result of a request with `pat` (or without a
/// token). If the token has been added, replaced or removed in the meantime,
/// the result belongs to another token and has no effect.
fn record_for(
    conn: &Connection,
    pat: Option<&Pat>,
    result: Result<Option<Release>, Failure>,
    now: Timestamp,
) -> anyhow::Result<()> {
    if load(conn)?.pat.as_ref() == pat {
        record(conn, result, now)?;
    }
    Ok(())
}

/// Checks for a new version, with the stored token if there is one.
pub async fn check(state: &AppState) -> anyhow::Result<()> {
    let pat = db::call(&state.db, |conn| Ok(load(conn)?.pat)).await?;
    let token = pat
        .as_ref()
        .map(|pat| pat.token(&state.secrets))
        .transpose();
    let result = match token {
        Ok(token) => github::newest(&state.http, &state.github_api, token.as_deref()).await,
        // With a different instance key: like an invalid token.
        Err(error) => {
            tracing::warn!("update token not readable: {error:#}");
            Err(Failure::Token)
        }
    };
    if let Err(failure) = result {
        tracing::warn!(reason = failure.code(), "update check failed");
    }
    let instance = state.instance.clone();
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        record_for(&tx, pat.as_ref(), result, Timestamp::now())?;
        tx.commit()?;
        instance.reload_update(conn)
    })
    .await
}

/// Detects the switch to a newer version at startup; the mails go out after
/// the commit. The first version of an instance is not an update, and neither
/// is a switch back.
pub fn installed(conn: &Connection, version: &str) -> anyhow::Result<Outbox> {
    let mut outbox = Outbox::default();
    let known = update_state::load(conn)?;
    if known.installed_version.as_deref() == Some(version) {
        return Ok(outbox);
    }
    update_state::set_installed(conn, version)?;
    let Some(previous) = known.installed_version else {
        return Ok(outbox);
    };
    if !newer(version, &previous) {
        tracing::info!(version, previous, "older version started");
        return Ok(outbox);
    }
    events::update_installed(conn, &mut outbox, version, &previous)?;
    let summary = known
        .summary
        .filter(|_| known.latest.as_deref() == Some(version));
    for user in notifications::active_recipients(conn)? {
        let event = News::Release {
            version,
            summary: summary.as_deref(),
        };
        events::news(conn, &user, event)?;
    }
    let mut details = json!({ "version": version });
    if let Some(build) = BUILD {
        details["build"] = json!(build);
    }
    audit_log::insert(
        conn,
        &Entry::new(Category::System, "updates.installed").details(details),
    )?;
    Ok(outbox)
}

/// At server start, before the jobs.
pub async fn on_start(state: &AppState) -> anyhow::Result<()> {
    let outbox = db::call(&state.db, |conn| {
        let tx = conn.transaction()?;
        let outbox = installed(&tx, VERSION)?;
        tx.commit()?;
        Ok(outbox)
    })
    .await?;
    outbox.send(state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    #[test]
    fn versions_compare_as_semver() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.9.9", "0.10.0"));
        assert!(!newer("0.7.0", "0.7.0"));
        assert!(newer("0.7.0", "unreadable"));
        assert!(!newer("unreadable", "0.7.0"));
    }

    #[test]
    fn pat_needs_the_form_of_a_github_token() {
        assert!(valid_pat(&format!("ghp_{}", "a1".repeat(18))));
        assert!(valid_pat(&format!("github_pat_{}_B2", "a".repeat(30))));
        assert!(!valid_pat("ghp_short"));
        assert!(!valid_pat(""));
        assert!(!valid_pat(&format!("gho_{}", "a".repeat(36))));
        assert!(!valid_pat(&format!("ghp_{}\nX: y", "a".repeat(36))));
        assert!(!valid_pat(&format!("ghp_{}", "a".repeat(300))));
    }

    #[test]
    fn pat_is_sealed_and_shows_only_prefix_and_tail() {
        let secrets = SecretKey::random().unwrap();
        let token = format!("ghp_{}a1F3", "x".repeat(32));
        let at = Timestamp::UNIX_EPOCH;
        let pat = Pat::new(&secrets, &token, at).unwrap();
        assert_eq!((pat.prefix.as_str(), pat.tail.as_str()), ("ghp_", "a1F3"));
        assert_eq!(pat.token(&secrets).unwrap(), token);
        let stored = serde_json::to_string(&pat).unwrap();
        assert!(!stored.contains(&token), "{stored}");
        assert!(pat.token(&SecretKey::random().unwrap()).is_err());
    }

    #[test]
    fn checks_are_planned_without_token_unless_switched_off() {
        let now: Timestamp = "2026-11-05T10:00:00Z".parse().unwrap();
        let mut settings = Settings::default();
        // 03:00 in Berlin, the default without an administrator's schedule.
        assert_eq!(
            settings.next_check(Some(now), now),
            Some("2026-11-06T02:00:00Z".parse().unwrap())
        );
        assert_eq!(settings.next_check(None, now), Some(now));
        settings.tz = Some(Zone::try_from("Asia/Tokyo".to_owned()).unwrap());
        assert_eq!(
            settings.next_check(Some(now), now),
            Some("2026-11-05T18:00:00Z".parse().unwrap())
        );
        settings.auto = false;
        assert_eq!(settings.next_check(Some(now), now), None);
    }

    #[test]
    fn stored_settings_stay_readable_field_by_field() {
        let settings: Settings = serde_json::from_str(r#"{"every":"hourly"}"#).unwrap();
        assert_eq!(settings.every, Every::Hourly);
        assert_eq!(settings.time, Clock::fixed("03:00"));
        assert!(settings.auto && settings.show);
    }

    #[test]
    fn unreadable_settings_keep_the_token() {
        let conn = conn();
        let pat = Pat::new(
            &SecretKey::random().unwrap(),
            "ghp_x",
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let stored = json!({ "every": "monthly", "show": false, "pat": pat });
        app_settings::set(&conn, KEY, &stored).unwrap();
        let settings = load(&conn).unwrap();
        assert_eq!(settings.every, Every::Daily);
        assert!(settings.show);
        assert_eq!(settings.pat, Some(pat));
    }

    #[test]
    fn a_result_for_a_replaced_token_changes_nothing() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        let now = Timestamp::UNIX_EPOCH;
        let old = Pat::new(&secrets, "ghp_old", now).unwrap();
        let settings = Settings {
            pat: Some(Pat::new(&secrets, "ghp_new", now).unwrap()),
            ..Settings::default()
        };
        save(&conn, &settings).unwrap();

        record_for(&conn, Some(&old), Err(Failure::Token), now).unwrap();
        assert_eq!(update_state::load(&conn).unwrap().reason, None);
        record_for(&conn, None, Err(Failure::Token), now).unwrap();
        assert_eq!(update_state::load(&conn).unwrap().reason, None);

        let current = settings.pat.unwrap();
        record_for(&conn, Some(&current), Err(Failure::Token), now).unwrap();
        let reason = update_state::load(&conn).unwrap().reason;
        assert_eq!(reason.as_deref(), Some("token"));
    }

    #[test]
    fn hint_keeps_a_found_version_but_not_up_to_date_after_a_failure() {
        let conn = conn();
        let now = Timestamp::UNIX_EPOCH;
        let release = |version: &str| Release {
            version: version.to_owned(),
            summary: None,
        };

        record(&conn, Ok(Some(release("0.0.0"))), now).unwrap();
        assert_eq!(hint(&conn).unwrap().map(|hint| hint.available), Some(false));
        record(&conn, Err(Failure::Token), now).unwrap();
        assert_eq!(hint(&conn).unwrap(), None);

        record(&conn, Ok(Some(release("99.0.0"))), now).unwrap();
        record(&conn, Err(Failure::Token), now).unwrap();
        assert_eq!(hint(&conn).unwrap().map(|hint| hint.available), Some(true));
    }

    #[test]
    fn a_failure_keeps_the_known_version() {
        let conn = conn();
        let now = Timestamp::UNIX_EPOCH;
        let release = Release {
            version: "0.0.0".to_owned(),
            summary: Some("New".to_owned()),
        };
        record(&conn, Ok(Some(release)), now).unwrap();
        record(&conn, Err(Failure::RateLimited), now).unwrap();
        let state = update_state::load(&conn).unwrap();
        assert_eq!(state.latest.as_deref(), Some("0.0.0"));
        assert_eq!(state.summary.as_deref(), Some("New"));
        assert_eq!(state.reason.as_deref(), Some("rate_limited"));
        assert_eq!(state.checked(), Some(now));
        // An older version is not worth a notification.
        assert_eq!(state.last_notified_version, None);
        record(&conn, Ok(None), now).unwrap();
        let state = update_state::load(&conn).unwrap();
        assert_eq!((state.latest, state.reason), (None, None));
    }

    #[test]
    fn first_version_and_way_back_are_no_update() {
        let conn = conn();
        let outbox = installed(&conn, "0.7.0").unwrap();
        assert!(outbox.is_empty());
        let state = update_state::load(&conn).unwrap();
        assert_eq!(state.installed_version.as_deref(), Some("0.7.0"));

        let outbox = installed(&conn, "0.6.0").unwrap();
        assert!(outbox.is_empty());
        let state = update_state::load(&conn).unwrap();
        assert_eq!(state.installed_version.as_deref(), Some("0.6.0"));
        let entries: i64 = conn
            .query_row("SELECT count(*) FROM audit_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(entries, 0);
    }
}
