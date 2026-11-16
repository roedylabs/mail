//! Audit log texts: icon, person, action and details of an entry are built on
//! read from the action key and details, in the administrator's language –
//! one source for list, search and export. The wording lives in the locale
//! files under `audit.*` (`crate::i18n`).
//!
//! `who` and `act` follow each other, so `act` starts with a space (" signed
//! in") or a colon (": Backup failed"); `meta` is the place or a detail such
//! as the size of a backup.
//!
//! An unknown key (say after a downgrade) or missing details show the key
//! instead of the text, so no entry disappears.

use std::fmt::Display;

use serde_json::Value;

use crate::{
    db::repo::audit_log::{Category, Row},
    i18n::{plural, t, tf},
    mailer::format,
    settings::Language,
};

/// An entry to display and search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    /// Icon as a Tabler Icons class (`ti-…`, registry of the web app).
    pub icon: &'static str,
    pub who: String,
    pub act: String,
    pub meta: String,
    /// Highlighted as a warning.
    pub warn: bool,
}

impl Shown {
    /// Text the search matches.
    pub fn searchable(&self, category: Category, lang: Language) -> String {
        format!(
            "{}{} {} {}",
            self.who,
            self.act,
            self.meta,
            label(category, lang)
        )
    }
}

/// Column headers of the export.
pub fn csv_head(lang: Language) -> [&'static str; 5] {
    ["time", "category", "person", "action", "details"]
        .map(|column| t(lang, &format!("audit.csv.{column}")))
}

/// Name of the category.
pub fn label(category: Category, lang: Language) -> &'static str {
    t(
        lang,
        match category {
            Category::Login => "audit.category.login",
            Category::Users => "audit.category.users",
            Category::Settings => "audit.category.settings",
            Category::System => "audit.category.system",
        },
    )
}

/// An entry from action key and details.
pub fn render(row: &Row, lang: Language) -> Shown {
    let line = known(row, lang)
        .unwrap_or_else(|| Line::new(fallback_icon(row.category), format!(": {}", row.action)));
    Shown {
        icon: line.icon,
        who: row
            .actor_name
            .clone()
            .unwrap_or_else(|| label(Category::System, lang).to_owned()),
        act: line.act,
        meta: row
            .place
            .clone()
            .or(line.meta)
            .or_else(|| login_ip(row))
            .unwrap_or_default(),
        warn: line.warn,
    }
}

/// Without GeoIP, sign-ins show the shortened IP address; other entries have
/// no detail.
fn login_ip(row: &Row) -> Option<String> {
    (row.category == Category::Login)
        .then(|| row.ip.as_deref()?.parse().ok().map(format::short_ip))
        .flatten()
}

fn fallback_icon(category: Category) -> &'static str {
    match category {
        Category::Login => "ti-login",
        Category::Users => "ti-users",
        Category::Settings => "ti-settings",
        Category::System => "ti-server",
    }
}

/// Text of a key without person and place.
struct Line {
    icon: &'static str,
    act: String,
    meta: Option<String>,
    warn: bool,
}

impl Line {
    fn new(icon: &'static str, act: impl Into<String>) -> Self {
        Self {
            icon,
            act: act.into(),
            meta: None,
            warn: false,
        }
    }

    fn warn(mut self) -> Self {
        self.warn = true;
        self
    }

    fn meta(mut self, meta: Option<String>) -> Self {
        self.meta = meta;
        self
    }
}

/// Details of an entry.
#[derive(Clone, Copy)]
struct Details<'a>(Option<&'a Value>);

impl<'a> Details<'a> {
    fn text(self, key: &str) -> Option<&'a str> {
        self.0?.get(key)?.as_str()
    }

    fn number(self, key: &str) -> Option<u64> {
        self.0?.get(key)?.as_u64()
    }

    fn flag(self, key: &str) -> Option<bool> {
        self.0?.get(key)?.as_bool()
    }

    /// Size in bytes like "1.2 GB".
    fn size(self, key: &str, lang: Language) -> Option<String> {
        self.number(key).map(|bytes| format::size(bytes, lang))
    }
}

/// Role within a sentence ("the user role").
fn role(lang: Language, role: &str) -> Option<&'static str> {
    matches!(role, "admin" | "user").then(|| t(lang, &format!("audit.role.{role}")))
}

/// Role after "as" ("invited … as a user").
fn role_as(lang: Language, role: &str) -> Option<&'static str> {
    matches!(role, "admin" | "user").then(|| t(lang, &format!("audit.role_as.{role}")))
}

/// Retention period: a year or a number of days.
fn keep(lang: Language, days: u64) -> String {
    match days {
        365 => t(lang, "audit.keep_year").to_owned(),
        days => plural(lang, "duration.days", days, &[]),
    }
}

/// Icon, text and highlight of a key; `None` for an unknown key or missing
/// details.
fn known(row: &Row, lang: Language) -> Option<Line> {
    let p = Details(row.details.as_ref());
    let action = row.action.as_str();
    // Text of the action, `audit.<action>[.<variant>]`.
    let key = |variant: Option<&str>| match variant {
        Some(variant) => format!("audit.{action}.{variant}"),
        None => format!("audit.{action}"),
    };
    let act = |variant: Option<&str>, args: &[(&str, &dyn Display)]| tf(lang, &key(variant), args);
    let plain = |icon| Line::new(icon, act(None, &[]));
    let with = |icon, name: &str, value: &dyn Display| Line::new(icon, act(None, &[(name, value)]));
    Some(match action {
        // Sign-in
        "auth.login" if p.text("method") == Some("recovery") => {
            Line::new("ti-lifebuoy", act(Some("recovery"), &[]))
        }
        "auth.login" => plain("ti-login"),
        "auth.login_failed" => Line::new(
            "ti-alert-triangle",
            act(
                match p.text("reason") {
                    Some(reason @ ("locked" | "password" | "totp" | "recovery")) => Some(reason),
                    _ => None,
                },
                &[],
            ),
        )
        .warn(),
        "auth.logout" => plain("ti-logout"),
        "auth.password_change" | "auth.password_forgot" | "auth.password_reset" => plain("ti-key"),
        "auth.email_change_request" | "auth.email_change_resend" => {
            with("ti-mail-forward", "email", &p.text("email")?)
        }
        "auth.email_change_confirm" => with("ti-mail-check", "email", &p.text("email")?),
        "auth.email_change_discard" => plain("ti-mail-off"),
        "auth.profile_change" => plain("ti-user-edit"),
        "auth.recovery_codes" => plain("ti-lifebuoy"),
        "auth.session_revoke" => plain("ti-device-desktop-off"),
        "auth.sessions_revoke" => Line::new(
            "ti-devices",
            plural(lang, &key(None), p.number("sessions_ended")?, &[]),
        ),
        "auth.totp_add" => with("ti-shield-plus", "name", &p.text("name")?),
        "auth.totp_remove" => with("ti-shield-minus", "name", &p.text("name")?),
        // Users
        "users.invite" => Line::new(
            "ti-user-plus",
            act(
                None,
                &[
                    ("email", &p.text("email")?),
                    ("role", &role_as(lang, p.text("role")?)?),
                ],
            ),
        ),
        "users.invite_accept" => plain("ti-user-check"),
        "users.invite_renew" => with("ti-calendar-plus", "email", &p.text("email")?),
        "users.invite_request" => plain("ti-user-plus"),
        "users.invite_resend" => with("ti-send", "email", &p.text("email")?),
        "users.invite_revoke" => with("ti-user-minus", "email", &p.text("email")?),
        "users.invite_role" => Line::new(
            "ti-user-cog",
            act(
                None,
                &[
                    ("name", &p.text("email")?),
                    ("role", &role(lang, p.text("role")?)?),
                ],
            ),
        ),
        "users.lock" => with("ti-lock", "name", &p.text("name")?),
        "users.unlock" => with("ti-lock-open", "name", &p.text("name")?),
        "users.remove" => with("ti-user-minus", "name", &p.text("name")?),
        "users.delete_self" => plain("ti-user-minus"),
        "users.role" => Line::new(
            "ti-user-cog",
            act(
                None,
                &[
                    ("name", &p.text("name")?),
                    ("role", &role(lang, p.text("role")?)?),
                ],
            ),
        ),
        "users.mfa_reset" => with("ti-shield-off", "name", &p.text("name")?),
        // Settings
        "org.update" => plain("ti-building"),
        "branding.update" => plain("ti-brush"),
        "banner.enable" | "banner.disable" | "banner.update" => plain("ti-speakerphone"),
        "system_mail.update" => plain("ti-mail"),
        "servers.policy" => Line::new(
            "ti-world-www",
            act(
                Some(if p.flag("allow_custom_servers")? {
                    "allowed"
                } else {
                    "blocked"
                }),
                &[],
            ),
        ),
        "settings.local_reset" => plain("ti-eraser"),
        "audit.retention" => with("ti-history", "keep", &keep(lang, p.number("days")?)),
        "updates.settings" => plain("ti-cloud-download"),
        "updates.pat" => plain("ti-key"),
        "updates.pat_remove" => plain("ti-key-off").warn(),
        "backups.schedule" => plain("ti-calendar-time"),
        // System
        "auth.reset_admin" => with("ti-user-shield", "user", &p.text("user")?).warn(),
        "setup.complete" => plain("ti-rocket"),
        "servers.create" | "servers.update" => with("ti-server-2", "label", &p.text("label")?),
        "servers.delete" => with("ti-server-off", "label", &p.text("label")?).warn(),
        "servers.register_client" => with("ti-plug-connected", "url", &p.text("url")?),
        "audit.export" => plain("ti-download").meta(
            p.number("count")
                .map(|n| plural(lang, "audit.entries", n, &[])),
        ),
        "updates.check" => plain("ti-refresh"),
        "updates.available" => with("ti-cloud-download", "version", &p.text("version")?),
        "updates.installed" => with("ti-refresh", "version", &p.text("version")?).meta(
            p.text("build")
                .map(|build| tf(lang, "audit.build", &[("build", &build)])),
        ),
        "maintenance.on" => plain("ti-tool").warn(),
        "maintenance.off" => plain("ti-tool"),
        "storage.compact" => plain("ti-arrows-minimize"),
        "backups.create" | "backups.auto" => plain("ti-database").meta(p.size("size", lang)),
        "backups.failed" => plain("ti-database-off").warn(),
        "backups.download" => plain("ti-download"),
        "backups.restore" => plain("ti-history").warn(),
        "backups.delete" => plain("ti-trash"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(action: &str, category: Category, details: Value) -> Row {
        Row {
            id: 1,
            at: "2026-11-05T09:26:00.000Z".into(),
            category,
            action: action.into(),
            actor_name: Some("Anna Becker".into()),
            ip: None,
            place: None,
            details: Some(details),
        }
    }

    fn shown_en(action: &str, category: Category, details: Value) -> Shown {
        render(&row(action, category, details), Language::English)
    }

    #[test]
    fn sign_in_with_place_and_warnings() {
        let mut login = row(
            "auth.login",
            Category::Login,
            json!({ "method": "password" }),
        );
        login.place = Some("Berlin, Germany".into());
        login.ip = Some("198.51.100.56".into());
        let line = render(&login, Language::English);
        assert_eq!(line.icon, "ti-login");
        assert_eq!(line.who, "Anna Becker");
        assert_eq!(line.act, " signed in");
        assert_eq!(line.meta, "Berlin, Germany");
        assert!(!line.warn);

        let locked = shown_en(
            "auth.login_failed",
            Category::Login,
            json!({ "reason": "locked" }),
        );
        assert_eq!(locked.icon, "ti-alert-triangle");
        assert!(locked.warn);
        for (action, icon, warn) in [
            ("maintenance.on", "ti-tool", true),
            ("maintenance.off", "ti-tool", false),
            ("storage.compact", "ti-arrows-minimize", false),
        ] {
            let line = shown_en(action, Category::System, json!({}));
            assert_eq!((line.icon, line.warn), (icon, warn), "{action}");
        }
    }

    /// All action keys with their category.
    const ACTIONS: [(&str, Category); 61] = {
        use Category::{Login, Settings, System, Users};
        [
            ("auth.login", Login),
            ("auth.login_failed", Login),
            ("auth.logout", Login),
            ("auth.password_change", Login),
            ("auth.password_forgot", Login),
            ("auth.password_reset", Login),
            ("auth.email_change_request", Login),
            ("auth.email_change_resend", Login),
            ("auth.email_change_confirm", Login),
            ("auth.email_change_discard", Login),
            ("auth.profile_change", Login),
            ("auth.recovery_codes", Login),
            ("auth.session_revoke", Login),
            ("auth.sessions_revoke", Login),
            ("auth.totp_add", Login),
            ("auth.totp_remove", Login),
            ("users.invite", Users),
            ("users.invite_accept", Users),
            ("users.invite_renew", Users),
            ("users.invite_request", Users),
            ("users.invite_resend", Users),
            ("users.invite_revoke", Users),
            ("users.invite_role", Users),
            ("users.lock", Users),
            ("users.unlock", Users),
            ("users.remove", Users),
            ("users.delete_self", Users),
            ("users.role", Users),
            ("users.mfa_reset", Users),
            ("org.update", Settings),
            ("branding.update", Settings),
            ("banner.enable", Settings),
            ("banner.disable", Settings),
            ("banner.update", Settings),
            ("system_mail.update", Settings),
            ("servers.policy", Settings),
            ("settings.local_reset", Settings),
            ("audit.retention", Settings),
            ("updates.settings", Settings),
            ("updates.pat", Settings),
            ("updates.pat_remove", Settings),
            ("backups.schedule", Settings),
            ("auth.reset_admin", System),
            ("setup.complete", System),
            ("servers.create", System),
            ("servers.update", System),
            ("servers.delete", System),
            ("servers.register_client", System),
            ("audit.export", System),
            ("updates.check", System),
            ("updates.available", System),
            ("updates.installed", System),
            ("maintenance.on", System),
            ("maintenance.off", System),
            ("storage.compact", System),
            ("backups.create", System),
            ("backups.auto", System),
            ("backups.failed", System),
            ("backups.download", System),
            ("backups.restore", System),
            ("backups.delete", System),
        ]
    };

    /// Details with which every key has a text.
    fn all_details() -> Value {
        json!({
            "method": "password", "reason": "password", "email": "a@example.com",
            "sessions_ended": 2, "name": "Mia Koch", "role": "admin", "user": "Anna Becker",
            "allow_custom_servers": true, "days": 365, "label": "Stalwart",
            "url": "https://mail.example.com", "count": 2, "version": "0.7.0", "size": 1024,
            "build": "7f3c2a1",
        })
    }

    /// `all_details` with the other branches of the conditions.
    fn other_details() -> Value {
        json!({
            "method": "recovery", "reason": "locked", "email": "a@example.com",
            "sessions_ended": 1, "name": "Mia Koch", "role": "user", "user": "Anna Becker",
            "allow_custom_servers": false, "days": 30, "label": "Stalwart",
            "url": "https://mail.example.com", "count": 1, "version": "0.7.0",
            "size": 1_288_490_189_u64,
        })
    }

    #[test]
    fn lines_read_like_the_glossary() {
        use Category::{Login, Settings, System, Users};
        let email = json!({ "email": "jonas.schulz@example.com", "role": "admin" });
        let name = json!({ "name": "Mia Koch", "role": "user" });
        for (action, category, details, act) in [
            ("auth.login", Login, json!({}), " signed in"),
            (
                "auth.login",
                Login,
                json!({ "method": "recovery" }),
                " signed in with a recovery code",
            ),
            (
                "auth.login_failed",
                Login,
                json!({ "reason": "locked" }),
                ": Sign-in denied, account suspended",
            ),
            (
                "auth.login_failed",
                Login,
                json!({ "reason": "new" }),
                ": Sign-in denied",
            ),
            (
                "auth.sessions_revoke",
                Login,
                json!({ "sessions_ended": 1 }),
                " signed out 1 other device",
            ),
            (
                "auth.sessions_revoke",
                Login,
                json!({ "sessions_ended": 3 }),
                " signed out 3 other devices",
            ),
            (
                "auth.totp_add",
                Login,
                json!({ "name": "Pixel" }),
                " added the authenticator app “Pixel”",
            ),
            (
                "users.invite",
                Users,
                email.clone(),
                " invited jonas.schulz@example.com as an administrator",
            ),
            (
                "users.invite_role",
                Users,
                email,
                " gave jonas.schulz@example.com the administrator role",
            ),
            (
                "users.role",
                Users,
                name.clone(),
                " gave Mia Koch the user role",
            ),
            ("users.lock", Users, name.clone(), " suspended Mia Koch"),
            ("users.unlock", Users, name.clone(), " reactivated Mia Koch"),
            (
                "users.mfa_reset",
                Users,
                name,
                " reset multi-factor authentication for Mia Koch",
            ),
            (
                "system_mail.update",
                Settings,
                json!({ "fields": [] }),
                " changed the email settings",
            ),
            (
                "servers.policy",
                Settings,
                json!({ "allow_custom_servers": false }),
                " blocked custom server URLs for users",
            ),
            (
                "audit.retention",
                Settings,
                json!({ "days": 365 }),
                " changed the audit log retention to 1 year",
            ),
            (
                "audit.retention",
                Settings,
                json!({ "days": 30 }),
                " changed the audit log retention to 30 days",
            ),
            (
                "servers.delete",
                System,
                json!({ "label": "Stalwart" }),
                " removed the mail server Stalwart",
            ),
            (
                "maintenance.on",
                System,
                json!({}),
                " turned on maintenance mode",
            ),
            ("backups.failed", System, json!({}), ": Backup failed"),
        ] {
            assert_eq!(shown_en(action, category, details).act, act, "{action}");
        }

        let mut auto = row("backups.auto", System, json!({ "size": 1_288_490_189_u64 }));
        auto.actor_name = None;
        let line = render(&auto, Language::English);
        assert_eq!(
            (line.who.as_str(), line.act.as_str(), line.meta.as_str()),
            ("System", " created an automatic backup", "1.2 GB")
        );

        let mut update = row(
            "updates.installed",
            System,
            json!({ "version": "0.1.0", "build": "7f3c2a1" }),
        );
        update.actor_name = None;
        let line = render(&update, Language::English);
        assert_eq!(line.act, " installed version 0.1.0");
        assert_eq!(line.meta, "Build 7f3c2a1");

        for (count, meta) in [(1, "1 entry"), (2, "2 entries")] {
            assert_eq!(
                shown_en("audit.export", System, json!({ "count": count })).meta,
                meta
            );
        }
    }

    #[test]
    fn missing_details_or_unknown_action_show_the_key() {
        let line = shown_en("users.lock", Category::Users, json!({}));
        assert_eq!((line.icon, line.act.as_str()), ("ti-users", ": users.lock"));
        let line = shown_en("new.something", Category::System, json!({}));
        assert_eq!(
            (line.icon, line.act.as_str(), line.warn),
            ("ti-server", ": new.something", false)
        );
        assert_eq!(
            shown_en(
                "users.invite",
                Category::Users,
                json!({ "email": "a@example.com" })
            )
            .act,
            ": users.invite"
        );
        let refused = shown_en(
            "auth.login_failed",
            Category::Login,
            json!({ "reason": "new" }),
        );
        assert_eq!(refused.act, ": Sign-in denied");
        assert!(refused.warn);
    }

    #[test]
    fn login_without_place_shows_the_short_ip_others_nothing() {
        let mut login = row("auth.logout", Category::Login, json!({}));
        login.ip = Some("198.51.100.56".into());
        assert_eq!(render(&login, Language::English).meta, "198.51.x.x");

        let mut banner = row("banner.update", Category::Settings, json!({}));
        banner.ip = Some("198.51.100.56".into());
        assert_eq!(render(&banner, Language::English).meta, "");
    }

    #[test]
    fn head_categories_and_search() {
        assert_eq!(
            csv_head(Language::English),
            ["Time", "Category", "Person", "Action", "Details"]
        );
        assert_eq!(
            [
                Category::Login,
                Category::Users,
                Category::Settings,
                Category::System
            ]
            .map(|category| label(category, Language::English)),
            ["Sign-in", "Users", "Settings", "System"]
        );
        let mut login = row(
            "auth.login",
            Category::Login,
            json!({ "method": "password" }),
        );
        login.place = Some("Berlin, Germany".into());
        assert_eq!(
            render(&login, Language::English).searchable(login.category, Language::English),
            "Anna Becker signed in Berlin, Germany Sign-in"
        );
    }

    /// Every key has a text in both languages, with the same icons,
    /// highlights and details; German differs in wording only.
    #[test]
    fn every_action_has_a_text_in_both_languages() {
        for details in [all_details(), other_details()] {
            for (action, category) in ACTIONS {
                let row = row(action, category, details.clone());
                let (en, de) = (
                    render(&row, Language::English),
                    render(&row, Language::German),
                );
                assert!(!en.act.contains(action), "{action}: falls back to the key");
                assert_eq!(
                    (de.icon, de.warn, de.meta.is_empty(), &de.who),
                    (en.icon, en.warn, en.meta.is_empty(), &en.who),
                    "{action}: {details}"
                );
                assert_ne!(de.act, en.act, "{action}");
                for line in [&en, &de] {
                    assert!(
                        line.act.starts_with(": ")
                            || (line.act.starts_with(' ') && !line.act.starts_with("  ")),
                        "{action}: {}",
                        line.act
                    );
                    assert!(!line.act.contains(['{', '}']), "{action}: {}", line.act);
                }
                assert!(
                    en.act.starts_with(": ")
                        || en.act[1..].starts_with(|c: char| c.is_ascii_lowercase()),
                    "{action}: {}",
                    en.act
                );
            }
        }
        let fallback = row("users.lock", Category::Users, json!({}));
        assert_eq!(render(&fallback, Language::German).act, ": users.lock");
    }

    /// English uses English quotation marks only.
    #[test]
    fn english_quotes_are_balanced() {
        for details in [all_details(), other_details()] {
            for (action, category) in ACTIONS {
                let line = shown_en(action, category, details.clone());
                for text in [line.act, line.meta] {
                    assert!(!text.contains(['\u{201e}', '\u{201a}']), "{text}");
                    assert_eq!(
                        text.matches('“').count(),
                        text.matches('”').count(),
                        "{text}"
                    );
                }
            }
        }
    }
}
