//! Administration › Organization and Banner.
//!
//! - `GET admin/org`, `PUT admin/org`: the fields of [`Org`]; `PUT`
//!   changes the given ones, `null` or an empty text deletes one. Links only
//!   as `http(s)://…`, the support address only in address form – checked on
//!   save, and the mail templates check again to be safe.
//! - `GET admin/banner`, `PUT admin/banner`: the fields of [`Banner`] with `on`
//!   (display on/off); `PUT` changes the given ones. A displayed banner needs
//!   a title. Every change raises `revision`, so a closed banner shows again
//!   after the next change.
//!
//! Both live in `app_settings` and in the in-memory store
//! (`crate::instance`), which `public/config` and the mails read; changes
//! are recorded in the audit log (category settings).

use std::collections::BTreeMap;

use axum::{Json, Router, extract::State, routing::get};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::{ApiError, FieldErrors, JsonBody, servers::audit_entry};
use crate::{
    app::AppState,
    auth::{AdminUser, AuthUser},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            app_settings,
            audit_log::{self, Category, Entry},
        },
    },
    instance::{self, BANNER, Banner, ICONS, ORG, Org, TONES},
    mailer::templates::{is_address, is_link},
};

/// Maximum lengths in characters: organization name, links, support address.
const MAX_NAME: usize = 120;
const MAX_LINK: usize = 2048;
const MAX_EMAIL: usize = 254;
/// Maximum lengths of the banner texts.
const MAX_TITLE: usize = 40;
const MAX_TEXT: usize = 140;
const MAX_LINK_LABEL: usize = 24;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/org", get(get_org).put(put_org))
        .route("/admin/banner", get(get_banner).put(put_banner))
}

/// The banner link, checked the same way as on the page:
/// only `https://`, with a dot in the host – otherwise the page would show a
/// stored link as faulty and not let it be saved.
fn is_banner_link(value: &str) -> bool {
    is_link(value)
        && value
            .get(..8)
            .is_some_and(|start| start.eq_ignore_ascii_case("https://"))
        && Url::parse(value).is_ok_and(|url| url.host_str().is_some_and(|host| host.contains('.')))
}

/// A single-line text without control characters with at most `max`
/// characters.
pub(super) fn text_error(value: &str, max: usize) -> Option<&'static str> {
    if value.chars().count() > max {
        Some("too_long")
    } else if value.chars().any(char::is_control) {
        Some("invalid")
    } else {
        None
    }
}

fn link_error(value: &str, valid: fn(&str) -> bool) -> Option<&'static str> {
    if value.chars().count() > MAX_LINK {
        Some("too_long")
    } else if !valid(value) {
        Some("invalid")
    } else {
        None
    }
}

/// Error of an organization field (value already trimmed, not empty).
fn org_error(field: &str, value: &str) -> Option<&'static str> {
    match field {
        "name" => text_error(value, MAX_NAME),
        "email" if value.chars().count() > MAX_EMAIL => Some("too_long"),
        "email" => (!is_address(value)).then_some("invalid"),
        _ => link_error(value, is_link),
    }
}

fn entry(action: &'static str, user: &AuthUser, ip: ClientIp) -> Entry {
    audit_entry(Category::Settings, action, user, ip)
}

async fn get_org(State(state): State<AppState>, _: AdminUser) -> Json<Org> {
    Json(state.instance.org())
}

/// The given fields of a change, trimmed; `None` for empty or `null`.
/// Unknown fields are 400 like elsewhere with `deny_unknown_fields`.
fn org_changes(
    body: BTreeMap<String, Option<String>>,
) -> Result<Vec<(&'static str, Option<String>)>, ApiError> {
    let fields = Org::default().fields_mut().map(|(field, _)| field);
    body.into_iter()
        .map(|(key, value)| {
            let field = fields
                .iter()
                .find(|field| **field == key)
                .ok_or_else(|| ApiError::BadRequest(format!("unknown field `{key}`")))?;
            let value = value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            Ok((*field, value))
        })
        .collect()
}

/// "Save" on the Organisation page. The audit log records the names of
/// the changed fields (`org.update`); without a change everything stays as
/// it is.
async fn put_org(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<BTreeMap<String, Option<String>>>,
) -> Result<Json<Org>, ApiError> {
    let changes = org_changes(body)?;
    let mut errors = FieldErrors::default();
    for (field, value) in &changes {
        if let Some(code) = value.as_deref().and_then(|value| org_error(field, value)) {
            errors.code(field, code);
        }
    }
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let instance = state.instance.clone();
    let org = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let mut org = instance::load_org(&tx)?;
        let mut changed = Vec::new();
        for (field, slot) in org.fields_mut() {
            if let Some((_, value)) = changes.iter().find(|(name, _)| *name == field)
                && slot != value
            {
                slot.clone_from(value);
                changed.push(field);
            }
        }
        if !changed.is_empty() {
            app_settings::set(&tx, ORG, &org)?;
            audit_log::insert(
                &tx,
                &entry("org.update", &user, ip).details(json!({ "fields": changed })),
            )?;
            tx.commit()?;
        }
        // Still on the connection: a later change never sets the store
        // before this one.
        instance.set_org(org.clone());
        Ok(org)
    })
    .await?;
    Ok(Json(org))
}

async fn get_banner(State(state): State<AppState>, _: AdminUser) -> Json<Banner> {
    Json(state.instance.banner())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BannerBody {
    on: Option<bool>,
    title: Option<String>,
    text: Option<String>,
    link: Option<String>,
    link_label: Option<String>,
    tone: Option<String>,
    icon: Option<String>,
    closable: Option<bool>,
}

impl BannerBody {
    /// Trims the texts and checks the given fields; whether a displayed
    /// banner has a title is checked by [`put_banner`] on the result.
    fn checked(mut self) -> Result<Self, ApiError> {
        let mut errors = FieldErrors::default();
        for (field, value, max) in [
            ("title", &mut self.title, MAX_TITLE),
            ("text", &mut self.text, MAX_TEXT),
            ("linkLabel", &mut self.link_label, MAX_LINK_LABEL),
        ] {
            if let Some(value) = value {
                *value = value.trim().to_owned();
                if let Some(code) = text_error(value, max) {
                    errors.code(field, code);
                }
            }
        }
        if let Some(link) = &mut self.link {
            *link = link.trim().to_owned();
            if let Some(code) = Some(link.as_str())
                .filter(|link| !link.is_empty())
                .and_then(|link| link_error(link, is_banner_link))
            {
                errors.code("link", code);
            }
        }
        if self
            .tone
            .as_deref()
            .is_some_and(|tone| !TONES.contains(&tone))
        {
            errors.code("tone", "invalid");
        }
        if self
            .icon
            .as_deref()
            .is_some_and(|icon| !ICONS.contains(&icon))
        {
            errors.code("icon", "invalid");
        }
        if errors.is_empty() {
            Ok(self)
        } else {
            Err(errors.into_error())
        }
    }

    fn apply(self, banner: &mut Banner) {
        let Self {
            on,
            title,
            text,
            link,
            link_label,
            tone,
            icon,
            closable,
        } = self;
        for (slot, value) in [
            (&mut banner.title, title),
            (&mut banner.text, text),
            (&mut banner.link, link),
            (&mut banner.link_label, link_label),
            (&mut banner.tone, tone),
            (&mut banner.icon, icon),
        ] {
            if let Some(value) = value {
                *slot = value;
            }
        }
        banner.on = on.unwrap_or(banner.on);
        banner.closable = closable.unwrap_or(banner.closable);
    }
}

/// Turning on, turning off and "Save" on the Banner page. Every change
/// raises `revision`. The audit log records what everyone sees: turned on
/// (`banner.enable`), turned off (`banner.disable`), a displayed banner
/// changed (`banner.update`).
async fn put_banner(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<BannerBody>,
) -> Result<Json<Banner>, ApiError> {
    let body = body.checked()?;
    let instance = state.instance.clone();
    let banner = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let current = instance::load_banner(&tx)?;
        let mut next = current.clone();
        body.apply(&mut next);
        if next.on && next.title.is_empty() {
            let mut errors = FieldErrors::default();
            errors.code("title", "required");
            return Ok(Err(errors.into_error()));
        }
        if !next.same_as(&current) {
            next.revision = current.revision + 1;
            app_settings::set(&tx, BANNER, &next)?;
            let action = match (current.on, next.on) {
                (false, true) => Some("banner.enable"),
                (true, false) => Some("banner.disable"),
                (true, true) => Some("banner.update"),
                (false, false) => None,
            };
            if let Some(action) = action {
                audit_log::insert(
                    &tx,
                    &entry(action, &user, ip)
                        .details(json!({ "title": next.title, "revision": next.revision })),
                )?;
            }
            tx.commit()?;
        }
        instance.set_banner(next.clone());
        Ok(Ok(next))
    })
    .await??;
    Ok(Json(banner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_links_only_https_with_a_dot() {
        for good in [
            "https://example.com/new",
            "HTTPS://a.b",
            "https://127.0.0.1/",
        ] {
            assert!(is_banner_link(good), "{good}");
        }
        for bad in [
            "http://example.com",
            "https://intranet/new",
            "https://[::1]/",
            "javascript:x",
        ] {
            assert!(!is_banner_link(bad), "{bad}");
        }
    }

    #[test]
    fn org_fields_by_kind() {
        assert_eq!(org_error("name", "Example Ltd"), None);
        assert_eq!(org_error("name", &"x".repeat(121)), Some("too_long"));
        assert_eq!(org_error("name", "a\u{7}b"), Some("invalid"));
        assert_eq!(org_error("email", "support@example.com"), None);
        assert_eq!(
            org_error("email", "support@example.com?cc=x"),
            Some("invalid")
        );
        assert_eq!(org_error("email", "no name@example.com"), Some("invalid"));
        assert_eq!(
            org_error("email", &format!("{}@example.com", "a".repeat(250))),
            Some("too_long")
        );
        assert_eq!(org_error("source", "https://github.com/a/b"), None);
        assert_eq!(org_error("terms", "javascript:x"), Some("invalid"));
        assert_eq!(
            org_error("help", &format!("https://example.com/{}", "a".repeat(2048))),
            Some("too_long")
        );
    }
}
