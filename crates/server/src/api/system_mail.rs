//! Administration › Email: the sending account of the system mails (page
//! state in `#lib/system-mail.svelte.ts`).
//!
//! - `GET admin/system-mail`: account like `MAIL0` without the secret
//!   (`has_secret`), plus the status of the last check (`none`, `unchecked`,
//!   `ok`, `err`), "Last checked" and the account's identities.
//! - `PUT admin/system-mail`: changes the given fields; the backend checks a
//!   new connection right afterwards and responds with the result.
//! - `POST admin/system-mail/test`: checks the draft (missing fields from the
//!   stored account) without saving; with `to` a test email then goes to this
//!   address.
//! - `GET admin/system-mail/preview`: a mail template of the Templates tab
//!   with sample data, as HTML (light or dark) or text.
//!
//! Secrets appear in no response, no log and no audit entry.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
    routing::{get, post},
};
use jiff::Timestamp;
use roedy_jmap as jmap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use super::{
    ApiError, FieldErrors, JsonBody,
    error::retry_secs,
    me::{self, is_invisible},
    nullable,
    servers::{audit_entry, check_client_field, clean_optional},
    setup,
};
use crate::{
    app::AppState,
    auth::{AdminUser, email},
    broker::crypto::SecretKey,
    client_ip::ClientIp,
    db::{
        self,
        repo::audit_log::{self, Category},
    },
    mailer::{
        Account, MailError,
        delivery::Delivery,
        format::Format,
        preview::{Choice, Viewer},
        system_mail::{self, Auth, Credentials, Identity, Outcome, SystemMail},
        templates::{Context, SystemTest, Theme},
    },
    rate_limit::{Key, Policy},
    settings::{self, Language},
};

/// Reply-to address and recipient of the test email, in characters.
const MAX_REPLY_TO: usize = 254;

/// Test emails per administrator: ten in ten minutes – a hijacked session
/// should not be able to write to any number of addresses through the system
/// mail.
const TEST_MAIL: Policy = Policy::rate("system_mail.test", 10, Duration::from_secs(10 * 60));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/system-mail", get(show).put(update))
        .route("/admin/system-mail/test", post(test))
        .route("/admin/system-mail/preview", get(preview))
}

/// Response of `GET` and `PUT`.
#[derive(Debug, Serialize)]
struct View {
    /// `null` without an account or after its server was deleted.
    server_id: Option<String>,
    auth: &'static str,
    user: String,
    has_secret: bool,
    identity_id: Option<String>,
    sender_name: Option<String>,
    reply_to: Option<String>,
    keep_sent: bool,
    /// `none`, `unchecked`, `ok` or `err`.
    status: &'static str,
    reason: Option<String>,
    /// With `no_mailbox` the missing mailbox (`drafts`, `sent`).
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    checked_at: Option<String>,
    identities: Vec<Identity>,
}

impl View {
    fn load(conn: &rusqlite::Connection) -> anyhow::Result<Self> {
        let Some(mail) = system_mail::load(conn)? else {
            return Ok(Self::empty());
        };
        let on_server = system_mail::base_url(conn, &mail.server_id)?.is_some();
        let has_secret = mail.secret_enc().is_some();
        let (status, reason, role, checked_at, identities) = match (on_server, mail.check) {
            (false, _) => ("none", None, None, None, Vec::new()),
            (true, None) => ("unchecked", None, None, None, Vec::new()),
            (true, Some(check)) if check.ok => ("ok", None, None, Some(check.at), check.identities),
            (true, Some(check)) => (
                "err",
                check.reason,
                check.role,
                Some(check.at),
                check.identities,
            ),
        };
        Ok(Self {
            server_id: on_server.then_some(mail.server_id),
            auth: mail.auth.as_str(),
            user: mail.user,
            has_secret,
            identity_id: mail.identity_id,
            sender_name: mail.sender_name,
            reply_to: mail.reply_to,
            keep_sent: mail.keep_sent,
            status,
            reason,
            role,
            checked_at,
            identities,
        })
    }

    /// Without an account (setup skipped): defaults like `MAIL0` with empty
    /// credentials (`smState(true)`).
    fn empty() -> Self {
        Self {
            server_id: None,
            auth: Auth::Password.as_str(),
            user: String::new(),
            has_secret: false,
            identity_id: None,
            sender_name: None,
            reply_to: None,
            keep_sent: true,
            status: "none",
            reason: None,
            role: None,
            checked_at: None,
            identities: Vec::new(),
        }
    }
}

async fn show(State(state): State<AppState>, _: AdminUser) -> Result<Json<View>, ApiError> {
    Ok(Json(db::call(&state.db, |conn| View::load(conn)).await?))
}

/// Body of `PUT` and `test`: the changed fields of the draft; `to` only for
/// the test. No `Debug`, like `Changes`: both hold the secret in plain text.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    server_id: Option<String>,
    auth: Option<String>,
    user: Option<String>,
    /// Empty or missing: the stored one stays (like `client_secret`).
    app_password: Option<String>,
    token: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    identity_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    sender_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    reply_to: Option<Option<String>>,
    keep_sent: Option<bool>,
    to: Option<String>,
}

/// Validated changes; `None` = unchanged, for the optional fields
/// `Some(None)` = empty.
#[derive(Default)]
struct Changes {
    server_id: Option<String>,
    auth: Option<Auth>,
    user: Option<String>,
    app_password: Option<String>,
    token: Option<String>,
    identity_id: Option<Option<String>>,
    sender_name: Option<Option<String>>,
    reply_to: Option<Option<String>>,
    keep_sent: Option<bool>,
}

/// By hand, so the secrets never appear in any output.
impl std::fmt::Debug for Changes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hidden = |secret: &Option<String>| secret.as_ref().map(|_| "…");
        f.debug_struct("Changes")
            .field("server_id", &self.server_id)
            .field("auth", &self.auth)
            .field("user", &self.user)
            .field("app_password", &hidden(&self.app_password))
            .field("token", &hidden(&self.token))
            .finish_non_exhaustive()
    }
}

/// Empty or missing text becomes `None`, otherwise trimmed.
fn optional_text(value: Option<Option<String>>) -> Option<Option<String>> {
    value.map(clean_optional)
}

impl Body {
    /// Checks the fields one by one; [`apply`] checks required
    /// fields on the result. Returns the changes and `to`.
    fn checked(self) -> Result<(Changes, Option<String>), ApiError> {
        let mut errors = FieldErrors::default();
        let server_id = self.server_id.map(|id| id.trim().to_owned());
        if server_id.as_deref() == Some("") {
            errors.code("server_id", "required");
        }
        let auth = self.auth.as_deref().map(Auth::parse);
        if auth == Some(None) {
            errors.code("auth", "invalid");
        }
        let user = self.user.map(|user| user.trim().to_owned());
        if user.as_deref().is_some_and(setup::is_bad_user) {
            errors.code("user", "invalid");
        }
        // Do not trim secrets: they may start with spaces.
        let app_password = self.app_password.filter(|value| !value.is_empty());
        check_client_field(&mut errors, "app_password", app_password.as_deref());
        let token = self.token.map(|value| value.trim().to_owned());
        let token = token.filter(|value| !value.is_empty());
        check_client_field(&mut errors, "token", token.as_deref());
        let identity_id = optional_text(self.identity_id);
        if identity_id
            .as_ref()
            .is_some_and(|id| id.as_deref().is_some_and(setup::is_bad_identity))
        {
            errors.code("identity_id", "invalid");
        }
        let sender_name = optional_text(self.sender_name);
        if let Some(Some(name)) = &sender_name {
            if name.chars().count() > me::MAX_NAME {
                errors.code("sender_name", "too_long");
            } else if name.chars().any(|c| c.is_control() || is_invisible(c)) {
                errors.code("sender_name", "invalid");
            }
        }
        let reply_to = optional_text(self.reply_to);
        if let Some(Some(address)) = &reply_to {
            if address.chars().count() > MAX_REPLY_TO {
                errors.code("reply_to", "too_long");
            } else if !email::is_valid(address) {
                errors.code("reply_to", "invalid");
            }
        }
        let to = self.to.map(|to| to.trim().to_owned());
        if let Some(to) = &to {
            if to.chars().count() > MAX_REPLY_TO {
                errors.code("to", "too_long");
            } else {
                me::check_email(&mut errors, "to", to);
            }
        }
        if !errors.is_empty() {
            return Err(errors.into_error());
        }
        let changes = Changes {
            server_id,
            auth: auth.flatten(),
            user,
            app_password,
            token,
            identity_id,
            sender_name,
            reply_to,
            keep_sent: self.keep_sent,
        };
        Ok((changes, to))
    }
}

/// Result of [`apply`].
struct Applied {
    mail: SystemMail,
    base_url: Url,
    /// Names of the changed fields for the audit log (for the secret only the name).
    changed: Vec<&'static str>,
    /// Whether server, sign-in method, user or secret differ from the stored ones.
    new_connection: bool,
}

/// Applies the changes to the stored account (without saving) and checks the
/// result: server in the registry, user with password, secret of the chosen
/// sign-in method.
fn apply(
    conn: &rusqlite::Connection,
    secrets: &SecretKey,
    current: Option<&SystemMail>,
    changes: Changes,
) -> anyhow::Result<Result<Applied, FieldErrors>> {
    let mut errors = FieldErrors::default();
    let mut next = current.cloned().unwrap_or_default();
    if let Some(server_id) = changes.server_id {
        if server_id != next.server_id {
            // The stored secret belongs to its server; another one does not
            // get it.
            next.forget_secret();
        }
        next.server_id = server_id;
    }
    let base_url = system_mail::base_url(conn, &next.server_id)?;
    if base_url.is_none() {
        let code = if next.server_id.is_empty() {
            "required"
        } else {
            "invalid"
        };
        errors.code("server_id", code);
    }
    if let Some(auth) = changes.auth {
        next.set_auth(auth);
    }
    if let Some(user) = changes.user {
        next.user = user;
    }
    let secret = match next.auth {
        Auth::Password => changes.app_password,
        Auth::Token => changes.token,
    };
    // The same secret again changes nothing (the values are compared); an
    // unreadable stored one counts as different.
    if let Some(secret) = secret
        && next.secret(secrets).ok().flatten().as_deref() != Some(secret.as_str())
    {
        next.set_secret(secrets, next.auth, &secret)?;
    }
    if next.secret_enc().is_none() {
        errors.code(next.auth.secret_field(), "required");
    }
    if next.auth == Auth::Password && next.user.is_empty() {
        errors.code("user", "required");
    }
    if let Some(identity_id) = changes.identity_id {
        next.identity_id = identity_id;
    }
    if let Some(sender_name) = changes.sender_name {
        next.sender_name = sender_name;
    }
    if let Some(reply_to) = changes.reply_to {
        next.reply_to = reply_to;
    }
    if let Some(keep_sent) = changes.keep_sent {
        next.keep_sent = keep_sent;
    }
    let Some(base_url) = base_url.filter(|_| errors.is_empty()) else {
        return Ok(Err(errors));
    };
    let before = current.cloned().unwrap_or_default();
    let mut changed = Vec::new();
    for (field, differs) in [
        ("server_id", before.server_id != next.server_id),
        ("auth", before.auth != next.auth),
        ("user", before.user != next.user),
        (
            next.auth.secret_field(),
            next.secret_enc().is_some() && before.secret_enc() != next.secret_enc(),
        ),
        ("identity_id", before.identity_id != next.identity_id),
        ("sender_name", before.sender_name != next.sender_name),
        ("reply_to", before.reply_to != next.reply_to),
        ("keep_sent", before.keep_sent != next.keep_sent),
    ] {
        if differs {
            changed.push(field);
        }
    }
    let new_connection = current.is_none_or(|current| current.credentials() != next.credentials());
    if new_connection {
        next.check = None;
    }
    Ok(Ok(Applied {
        mail: next,
        base_url,
        changed,
        new_connection,
    }))
}

/// "Save" on the Email page. With a new connection the backend checks it
/// afterwards itself (like "Send test email"); the response
/// is the stored account with the status.
async fn update(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<Body>,
) -> Result<Json<View>, ApiError> {
    if body.to.is_some() {
        return Err(ApiError::BadRequest("unknown field `to`".into()));
    }
    let (changes, _) = body.checked()?;
    let secrets = state.secrets.clone();
    let saved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let current = system_mail::load(&tx)?;
        let applied = match apply(&tx, &secrets, current.as_ref(), changes)? {
            Ok(applied) => applied,
            Err(errors) => return Ok(Err(errors.into_error())),
        };
        if !applied.changed.is_empty() {
            system_mail::save(&tx, &applied.mail)?;
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "system_mail.update", &user, ip)
                    .details(json!({ "fields": applied.changed })),
            )?;
            tx.commit()?;
        }
        Ok(Ok(applied))
    })
    .await??;
    if saved.new_connection {
        let account = saved.mail.account(saved.base_url.clone(), &state.secrets)?;
        let outcome = match state.mailer.test(&account).await {
            Ok(identities) => Outcome::Ok(Some(identities.into_iter().map(Into::into).collect())),
            Err(error) => Outcome::failed(&error),
        };
        record(&state, saved.mail.credentials(), outcome).await?;
    }
    Ok(Json(db::call(&state.db, |conn| View::load(conn)).await?))
}

async fn record(
    state: &AppState,
    credentials: Credentials,
    outcome: Outcome,
) -> anyhow::Result<()> {
    db::call(&state.db, move |conn| {
        system_mail::record(conn, &credentials, Timestamp::now(), outcome)
    })
    .await
    .map(drop)
}

/// Error of a test for the caller (also the setup): `mail_failed` with
/// `reason`; `auth_failed` and `forbidden` 422, `auth_locked` 429 with
/// `retry_after`, otherwise 502; `no_mailbox` names the missing mailbox with
/// `role` (`drafts`, `sent`), the page names it in the text.
pub(super) fn rejection(error: &MailError) -> ApiError {
    let rejection = |status| {
        let rejected = ApiError::rejected(status, "mail_failed").with("reason", error.reason());
        match error.mailbox_role() {
            Some(role) => rejected.with("role", role),
            None => rejected,
        }
    };
    match error {
        MailError::Locked(left) => {
            rejection(StatusCode::TOO_MANY_REQUESTS).with("retry_after", retry_secs(*left))
        }
        MailError::Jmap(jmap::Error::AuthFailed | jmap::Error::Forbidden) => {
            rejection(StatusCode::UNPROCESSABLE_ENTITY)
        }
        MailError::Jmap(_) => rejection(StatusCode::BAD_GATEWAY),
    }
}

/// What a test needs: the draft's account and, if it is the stored one, its
/// connection for the status.
struct Draft {
    account: Account,
    saved: Option<Credentials>,
    /// Language and formats of the administrator for the test email.
    format: Format,
}

/// "Test connection" and "Send" (Test section) with the draft.
async fn test(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    JsonBody(body): JsonBody<Body>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (changes, to) = body.checked()?;
    let secrets = state.secrets.clone();
    let admin_id = admin.id.clone();
    let draft = db::call(&state.db, move |conn| {
        let current = system_mail::load(conn)?;
        let applied = match apply(conn, &secrets, current.as_ref(), changes)? {
            Ok(applied) => applied,
            Err(errors) => return Ok(Err(errors.into_error())),
        };
        let saved = (!applied.new_connection).then(|| applied.mail.credentials());
        let account = applied.mail.account(applied.base_url, &secrets)?;
        let format = settings::format_of(conn, &admin_id)?;
        Ok(Ok(Draft {
            account,
            saved,
            format,
        }))
    })
    .await??;

    let identities: Vec<Identity> = match state.mailer.test(&draft.account).await {
        Ok(identities) => identities.into_iter().map(Into::into).collect(),
        Err(error) => {
            if let Some(saved) = draft.saved {
                record(&state, saved, Outcome::failed(&error)).await?;
            }
            return Err(rejection(&error));
        }
    };
    if let Some(saved) = draft.saved.clone() {
        record(&state, saved, Outcome::Ok(Some(identities.clone()))).await?;
    }
    let Some(to) = to else {
        return Ok(Json(json!({ "identities": identities, "sent": false })));
    };
    // Only now: only test emails that really go out count.
    state
        .limiter
        .acquire(&TEST_MAIL, Key::User(admin.id.clone()))?;
    send_test(&state, draft, to).await?;
    Ok(Json(json!({ "identities": identities, "sent": true })))
}

/// Sends the test email in a separate task: if the call aborts, sending still
/// does not stop halfway. With the stored account's connection,
/// [`Delivery`] writes the result to the status.
async fn send_test(state: &AppState, draft: Draft, to: String) -> Result<(), ApiError> {
    let worker = state.clone();
    let task = tokio::spawn(async move {
        let Some(delivery) = Delivery::for_account(&worker, draft.account, draft.saved).await?
        else {
            tracing::warn!("test email: no public URL");
            return Ok(Err(ApiError::rejected(
                StatusCode::BAD_GATEWAY,
                "mail_failed",
            )
            .with("reason", "no_public_url")));
        };
        let sent = delivery
            .send(&worker, &draft.format, |ctx| {
                SystemTest { to: &to }.render(ctx)
            })
            .await?;
        Ok::<_, anyhow::Error>(sent.map_err(|error| rejection(&error)))
    });
    task.await.map_err(anyhow::Error::from)??
}

/// Request of `GET admin/system-mail/preview`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewQuery {
    /// Template of the tab (`TPL`), e.g. `security`.
    template: String,
    /// Variant (`VARS`); without it the first one.
    variant: Option<String>,
    #[serde(default)]
    format: PreviewFormat,
    /// Only for HTML.
    #[serde(default)]
    theme: Theme,
    /// Language of the template (`de`, `en`); without it (or `system`) the
    /// administrator's.
    lang: Option<Language>,
}

/// HTML or text.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PreviewFormat {
    #[default]
    Html,
    Text,
}

/// Response of `preview`: subject, sender, recipient and the content.
#[derive(Debug, Serialize)]
struct Preview {
    subject: String,
    /// Sender as when sending; `null` as long as no identity is known.
    from: Option<String>,
    to: String,
    /// Whole HTML document or the text.
    body: String,
}

/// Renders a mail template with sample data, the current
/// branding (logo as data URL) and the administrator's format.
async fn preview(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    query: Result<Query<PreviewQuery>, QueryRejection>,
) -> Result<Json<Preview>, ApiError> {
    let Query(query) = query.map_err(|rejection| ApiError::BadRequest(rejection.body_text()))?;
    let choice = Choice::parse(&query.template, query.variant.as_deref())
        .ok_or_else(|| ApiError::BadRequest("unknown template or variant".into()))?;
    let public_url = state
        .public_url()
        .await?
        .ok_or_else(|| anyhow::anyhow!("no public URL"))?;
    let user_id = user.id.clone();
    let (format, from) = db::call(&state.db, move |conn| {
        Ok((settings::format_of(conn, &user_id)?, sender(conn)?))
    })
    .await?;
    // `system` is the administrator's own language.
    let format = match query.lang {
        Some(lang) if lang != Language::System => format.with_lang(lang),
        _ => format,
    };
    let brand = state.brand();
    let ctx = Context {
        brand: &brand,
        theme: query.theme,
        format: &format,
        public_url: &public_url,
        now: Timestamp::now(),
        inline_logo: true,
    };
    let viewer = Viewer {
        name: &user.display_name,
        email: &user.email,
    };
    let mail = choice.render(&viewer, &ctx)?;
    Ok(Json(Preview {
        subject: mail.subject,
        from,
        to: mail.to,
        body: match query.format {
            PreviewFormat::Html => mail.html,
            PreviewFormat::Text => mail.text,
        },
    }))
}

/// Sender as when sending: the account's sender name or the
/// identity's name, plus its address – the identity from the last check (the
/// first one if none is chosen). `None` without an account, without a server or
/// as long as the identity is not known.
fn sender(conn: &rusqlite::Connection) -> anyhow::Result<Option<String>> {
    let Some(mail) = system_mail::load(conn)? else {
        return Ok(None);
    };
    if system_mail::base_url(conn, &mail.server_id)?.is_none() {
        return Ok(None);
    }
    let identities = mail.check.map(|check| check.identities).unwrap_or_default();
    let identity = match &mail.identity_id {
        Some(id) => identities.iter().find(|identity| &identity.id == id),
        None => identities.first(),
    };
    // Like `Mailer::submit` and `jmap::Message`: sender name trimmed, without
    // it the identity's name, without a name only the address.
    Ok(identity.map(|identity| {
        match mail
            .sender_name
            .as_deref()
            .and_then(trimmed)
            .or_else(|| trimmed(&identity.name))
        {
            Some(name) => format!("{name} <{}>", identity.email),
            None => identity.email.clone(),
        }
    }))
}

/// Without surrounding whitespace; empty → `None` (like `non_empty` in the mailer).
fn trimmed(name: &str) -> Option<&str> {
    Some(name.trim()).filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn checked(value: Value) -> Result<(Changes, Option<String>), Value> {
        let body: Body = serde_json::from_value(value).unwrap();
        body.checked().map_err(|error| match error {
            ApiError::Rejected { status, extra, .. } => {
                assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
                extra["fields"].clone()
            }
            other => panic!("not a 422: {other:?}"),
        })
    }

    #[test]
    fn fields_are_trimmed_and_emptied() {
        let (changes, to) = checked(json!({
            "server_id": " s1 ", "auth": "token", "user": " noreply@example.org ",
            "app_password": "", "token": " abc ", "identity_id": "",
            "sender_name": "  ", "reply_to": null, "keep_sent": false,
            "to": " max@example.com ",
        }))
        .unwrap();
        assert_eq!(changes.server_id.as_deref(), Some("s1"));
        assert_eq!(changes.auth, Some(Auth::Token));
        assert_eq!(changes.user.as_deref(), Some("noreply@example.org"));
        assert_eq!(changes.app_password, None);
        assert_eq!(changes.token.as_deref(), Some("abc"));
        assert_eq!(changes.identity_id, Some(None));
        assert_eq!(changes.sender_name, Some(None));
        assert_eq!(changes.reply_to, Some(None));
        assert_eq!(changes.keep_sent, Some(false));
        assert_eq!(to.as_deref(), Some("max@example.com"));

        let (changes, to) = checked(json!({})).unwrap();
        assert!(changes.identity_id.is_none() && changes.auth.is_none() && to.is_none());
        // The password stays as it is – even with spaces.
        let (changes, _) = checked(json!({ "app_password": " a b " })).unwrap();
        assert_eq!(changes.app_password.as_deref(), Some(" a b "));
    }

    #[test]
    fn each_field_reports_its_own_code() {
        let errors = checked(json!({
            "server_id": "", "auth": "sso", "user": "no reply",
            "app_password": "a\u{7}b", "token": "x".repeat(5000),
            "identity_id": "i\n1", "sender_name": "x".repeat(101),
            "reply_to": "no-at", "to": "",
        }))
        .unwrap_err();
        let code = |field: &str| errors[field]["code"].as_str().unwrap().to_owned();
        assert_eq!(code("server_id"), "required");
        assert_eq!(code("auth"), "invalid");
        assert_eq!(code("user"), "invalid");
        assert_eq!(code("app_password"), "invalid");
        assert_eq!(code("token"), "invalid");
        assert_eq!(code("identity_id"), "invalid");
        assert_eq!(code("sender_name"), "too_long");
        assert_eq!(code("reply_to"), "invalid");
        assert_eq!(code("to"), "required");

        let errors = checked(json!({
            "sender_name": "Ex\u{200b}ample",
            "reply_to": format!("{}@example.org", "a".repeat(250)),
            "to": "max@",
        }))
        .unwrap_err();
        assert_eq!(errors["sender_name"]["code"], "invalid");
        assert_eq!(errors["reply_to"]["code"], "too_long");
        assert_eq!(errors["to"]["code"], "invalid");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        assert!(serde_json::from_value::<Body>(json!({ "url": "https://a.b" })).is_err());
        assert!(serde_json::from_value::<Body>(json!({ "pass": "x" })).is_err());
    }

    /// The page names the missing mailbox; other reasons without `role`.
    #[test]
    fn missing_mailbox_names_its_role() {
        let extra = |error: MailError| match rejection(&error) {
            ApiError::Rejected { status, extra, .. } => (status, Value::Object(extra)),
            other => panic!("not a rejection: {other:?}"),
        };
        for role in ["drafts", "sent"] {
            assert_eq!(
                extra(MailError::Jmap(jmap::Error::NoMailbox(role))),
                (
                    StatusCode::BAD_GATEWAY,
                    json!({ "reason": "no_mailbox", "role": role })
                )
            );
        }
        assert_eq!(
            extra(MailError::Jmap(jmap::Error::NoIdentity)).1,
            json!({ "reason": "no_identity" })
        );
    }
}
