//! Notification texts: icon, title, text and target are built when reading
//! from topic, event (`kind`) and details (`params`) in the recipient's
//! language – one source for the API, the email digest and Web Push. The
//! wording lives in the locale files under `notification.<kind>.*`
//! (`crate::i18n`).
//!
//! An unknown event (e.g. after a downgrade) or missing details show the
//! topic's icon and title, no text and no target. The target carries the
//! entry (user, invitation, email account) so that the app can open the row
//! or the overview.

use std::{fmt::Display, net::IpAddr};

use serde_json::{Map, Value, json};

use super::Topic;
use crate::{
    auth::device,
    i18n::{plural, t, tf},
    mailer::format::{self, size},
    settings::Language,
};

/// What the texts need besides the details.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// Recipient's language (`lang` of their settings).
    pub lang: Language,
    /// App name from the branding.
    pub app: &'a str,
}

/// A notification for display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// Icon as a Tabler Icons class (`ti-…`, the web app's registry).
    pub icon: &'static str,
    pub title: String,
    /// Empty when falling back to the topic.
    pub text: String,
    /// No target when falling back to the topic.
    pub target: Option<Target>,
    /// `false`: fallback to the topic (unknown event or missing
    /// details).
    pub known: bool,
}

/// Area of a target in the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// Settings and account (`settings`).
    Settings,
    /// Administration (`admin`).
    Admin,
    /// Overview of an email account (`mailacct`).
    MailAccount,
}

impl View {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Admin => "admin",
            Self::MailAccount => "mailacct",
        }
    }
}

/// Entry of a target: row under Administration › Users or the email
/// account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    User(String),
    Invitation(String),
    MailAccount(String),
}

impl Entry {
    fn key(&self) -> &'static str {
        match self {
            Self::User(_) => "user_id",
            Self::Invitation(_) => "invitation_id",
            Self::MailAccount(_) => "mail_account_id",
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::User(id) | Self::Invitation(id) | Self::MailAccount(id) => id,
        }
    }
}

/// Target of a notification: area, page and – where the app opens an entry –
/// the entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub view: View,
    /// Page as the last segment of its route (`security`, `users`,
    /// `overview` …).
    pub page: &'static str,
    pub entry: Option<Entry>,
}

impl Target {
    fn settings(page: &'static str) -> Self {
        Self {
            view: View::Settings,
            page,
            entry: None,
        }
    }

    fn admin(page: &'static str, entry: Option<Entry>) -> Self {
        Self {
            view: View::Admin,
            page,
            entry,
        }
    }

    /// Path in the web app for links in mails and Web Push. An email
    /// account's overview needs its ID; without it the path leads to the
    /// list.
    pub fn path(&self) -> String {
        match self.view {
            View::Admin => format!("/admin/{}", self.page),
            View::MailAccount => match &self.entry {
                Some(entry) => format!("/account/mail-accounts/{}/{}", entry.id(), self.page),
                None => "/account/mail-accounts".to_owned(),
            },
            // The account pages sit in the settings navigation under `/account`.
            View::Settings => match self.page {
                page @ ("profile" | "mail-accounts" | "security") => format!("/account/{page}"),
                page => format!("/settings/{page}"),
            },
        }
    }

    /// For the API: `view`, `page`, `path` and the entry under its
    /// name from the details (`user_id`, `invitation_id`,
    /// `mail_account_id`).
    pub fn to_json(&self) -> Value {
        let mut target = json!({
            "view": self.view.as_str(),
            "page": self.page,
            "path": self.path(),
        });
        if let Some(entry) = &self.entry {
            target[entry.key()] = json!(entry.id());
        }
        target
    }
}

/// Icon, title, text and target of a notification.
pub fn render(topic: &str, kind: &str, params: &Value, cx: &Context<'_>) -> Rendered {
    let empty = Map::new();
    let p = Params(params.as_object().unwrap_or(&empty));
    known(kind, &p, cx).unwrap_or_else(|| fallback(topic, cx.lang))
}

/// Icon and title of the topic, without text and target: for unknown events
/// and missing details.
fn fallback(topic: &str, lang: Language) -> Rendered {
    let (icon, key) = match Topic::parse(topic) {
        Some(Topic::Security) => ("ti-shield-lock", "topic.security"),
        Some(Topic::Account) => ("ti-user", "topic.account"),
        Some(Topic::Team) => ("ti-users", "topic.team"),
        Some(Topic::System) => ("ti-server", "topic.system"),
        Some(Topic::News) => ("ti-sparkles", "topic.news"),
        None => ("ti-bell", "topic.unknown"),
    };
    Rendered {
        icon,
        title: t(lang, key).to_owned(),
        text: String::new(),
        target: None,
        known: false,
    }
}

fn shown(icon: &'static str, title: impl Into<String>, text: String, target: Target) -> Rendered {
    Rendered {
        icon,
        title: title.into(),
        text,
        target: Some(target),
        known: true,
    }
}

/// The event catalogue; `None` for an unknown event or missing details.
fn known(kind: &str, p: &Params<'_>, cx: &Context<'_>) -> Option<Rendered> {
    const SECURITY: &str = "security";
    let lang = cx.lang;
    // Title of the event, `notification.<kind>.title`.
    let title = |key: &str| t(lang, &format!("notification.{kind}.{key}")).to_owned();
    // Text of the event with placeholders.
    let text = |key: &str, args: &[(&str, &dyn Display)]| {
        tf(lang, &format!("notification.{kind}.{key}"), args)
    };
    Some(match kind {
        "security.login" => shown(
            device_icon(p.str("device_type")),
            title("title"),
            text("text", &[("device", &device_at(p, lang))]),
            Target::settings(SECURITY),
        ),
        "security.password" => {
            let reset = p.flag("reset");
            let mut sentences = vec![text("text", &[("device", &device(p, lang))])];
            let ended = p.uint("sessions_ended").unwrap_or(0);
            if ended > 0 {
                let others = if reset {
                    "signed_out"
                } else {
                    "signed_out_others"
                };
                sentences.push(plural(
                    lang,
                    &format!("notification.security.password.{others}"),
                    ended,
                    &[],
                ));
            }
            if !reset {
                sentences.push(text("not_you", &[]));
            }
            shown(
                "ti-key",
                title(if reset { "title_reset" } else { "title" }),
                sentences.join(" "),
                Target::settings(SECURITY),
            )
        }
        "security.email_change" => shown(
            "ti-mail-forward",
            title("title"),
            text(
                "text",
                &[("email", &p.str("email")?), ("device", &device(p, lang))],
            ),
            Target::settings("profile"),
        ),
        "security.mfa_reset" => shown(
            "ti-shield-off",
            title("title"),
            text(
                "text",
                &[(
                    "by",
                    &p.text("by")
                        .unwrap_or_else(|| t(lang, "notification.security.mfa_reset.by_default")),
                )],
            ),
            Target::settings(SECURITY),
        ),
        "security.totp_add" => shown(
            "ti-shield-plus",
            title("title"),
            if p.flag("first") {
                let advice = if p.flag("sole_admin") {
                    "advice_sole_admin"
                } else {
                    "advice"
                };
                text(
                    "text_first",
                    &[("device", &device(p, lang)), ("advice", &text(advice, &[]))],
                )
            } else {
                text(
                    "text",
                    &[("name", &p.str("name")?), ("device", &device_at(p, lang))],
                )
            },
            Target::settings(SECURITY),
        ),
        "security.totp_remove" => {
            let last = p.flag("last");
            shown(
                "ti-shield-minus",
                title(if last { "title_last" } else { "title" }),
                if last {
                    text("text_last", &[])
                } else {
                    text(
                        "text",
                        &[("name", &p.str("name")?), ("device", &device_at(p, lang))],
                    )
                },
                Target::settings(SECURITY),
            )
        }
        "security.recovery_used" => {
            let remaining = p.uint("remaining");
            let left = match remaining {
                Some(0) => text("none_left", &[]),
                _ => text(
                    "left",
                    &[("remaining", &remaining?), ("total", &p.uint("total")?)],
                ),
            };
            shown(
                "ti-lifebuoy",
                title(if remaining == Some(0) {
                    "title_last"
                } else {
                    "title"
                }),
                text(
                    if p.flag("new_device") {
                        "text_new_device"
                    } else {
                        "text"
                    },
                    &[("device", &device_at(p, lang)), ("left", &left)],
                ),
                Target::settings(SECURITY),
            )
        }
        "security.recovery_codes" => shown(
            "ti-lifebuoy",
            title("title"),
            text("text", &[("device", &device_at(p, lang))]),
            Target::settings(SECURITY),
        ),
        "account.profile" => {
            let fields = p.list("fields");
            let (name, username) = (fields.contains(&"name"), fields.contains(&"username"));
            shown(
                "ti-user-edit",
                title("title"),
                text(
                    match (name, username) {
                        (true, true) => "text_both",
                        (false, true) => "text_username",
                        _ => "text_name",
                    },
                    &[],
                ),
                Target::settings("profile"),
            )
        }
        "account.email_confirmed" => shown(
            "ti-mail-check",
            title("title"),
            text("text", &[("email", &p.str("email")?)]),
            Target::settings("profile"),
        ),
        "account.quota" => shown(
            "ti-chart-pie",
            title("title"),
            text(
                "text",
                &[
                    ("account", &p.str("account")?),
                    ("percent", &p.uint("percent")?),
                    ("used", &size(p.uint("used")?, lang)),
                    ("limit", &size(p.uint("limit")?, lang)),
                ],
            ),
            Target {
                view: View::MailAccount,
                page: "overview",
                entry: p.id("mail_account_id").map(Entry::MailAccount),
            },
        ),
        "team.invite_accepted" => shown(
            "ti-user-check",
            title("title"),
            text("text", &[("name", &p.str("name")?)]),
            Target::admin("users", p.id("user_id").map(Entry::User)),
        ),
        "team.role_changed" => shown(
            "ti-user-cog",
            title("title"),
            text(
                if p.str("role") == Some("admin") {
                    "text_admin"
                } else {
                    "text_user"
                },
                &[("name", &p.str("name")?)],
            ),
            Target::admin("users", p.id("user_id").map(Entry::User)),
        ),
        "team.user_locked" => shown(
            "ti-lock",
            title("title"),
            text("text", &[("name", &p.str("name")?)]),
            Target::admin("users", p.id("user_id").map(Entry::User)),
        ),
        "team.invite_requested" => shown(
            "ti-user-plus",
            title("title"),
            text("text", &[("email", &p.str("email")?)]),
            Target::admin("users", p.id("invitation_id").map(Entry::Invitation)),
        ),
        "system.backup_ok" => shown(
            "ti-database",
            title("title"),
            match p.uint("size").filter(|&size| size > 0) {
                Some(bytes) => text("text_size", &[("size", &size(bytes, lang))]),
                None => text("text", &[]),
            },
            Target::admin("maintenance", None),
        ),
        "system.backup_failed" => shown(
            "ti-database-off",
            title("title"),
            text("text", &[]),
            Target::admin("maintenance", None),
        ),
        "system.update_available" => shown(
            "ti-cloud-download",
            title("title"),
            text("text", &[("version", &p.str("version")?)]),
            Target::admin("updates", None),
        ),
        "system.update_installed" => {
            let version = p.str("version")?;
            shown(
                "ti-refresh",
                title("title"),
                match p.text("from") {
                    Some(from) => text(
                        "text_from",
                        &[("app", &cx.app), ("version", &version), ("from", &from)],
                    ),
                    None => text("text", &[("app", &cx.app), ("version", &version)]),
                },
                Target::admin("updates", None),
            )
        }
        "system.maintenance_on" | "system.maintenance_off" => shown(
            "ti-tool",
            title("title"),
            text("text", &[("by", &p.str("by")?)]),
            Target::admin("maintenance", None),
        ),
        "news.welcome" => shown(
            "ti-sparkles",
            title("title"),
            text("text", &[]),
            Target::settings("general"),
        ),
        "news.release" => shown(
            "ti-gift",
            text("title", &[("version", &p.str("version")?)]),
            p.text("summary")
                .map_or_else(|| text("text", &[]), |summary| cut(summary, 70)),
            Target::settings("about"),
        ),
        _ => return None,
    })
}

/// Details of a notification.
struct Params<'a>(&'a Map<String, Value>);

impl<'a> Params<'a> {
    /// Text, also empty.
    fn str(&self, key: &str) -> Option<&'a str> {
        self.0.get(key)?.as_str()
    }

    /// Text, only if not empty.
    fn text(&self, key: &str) -> Option<&'a str> {
        self.str(key).filter(|text| !text.is_empty())
    }

    fn uint(&self, key: &str) -> Option<u64> {
        self.0.get(key)?.as_u64()
    }

    /// Truthiness as in JavaScript, as the web app writes the details.
    fn flag(&self, key: &str) -> bool {
        match self.0.get(key) {
            Some(Value::Bool(value)) => *value,
            Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
            Some(Value::String(text)) => !text.is_empty(),
            Some(Value::Array(_) | Value::Object(_)) => true,
            Some(Value::Null) | None => false,
        }
    }

    /// List of texts; a single text counts as a list.
    fn list(&self, key: &str) -> Vec<&'a str> {
        match self.0.get(key) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
            Some(Value::String(text)) => vec![text.as_str()],
            _ => Vec::new(),
        }
    }

    /// ID for a target. It is part of the web app's path, so only characters
    /// that `db::new_id` generates; otherwise the target counts as without an entry.
    fn id(&self, key: &str) -> Option<String> {
        self.text(key)
            .filter(|id| {
                id.len() <= 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map(str::to_owned)
    }
}

/// Icon by kind of device.
fn device_icon(device_type: Option<&str>) -> &'static str {
    match device_type {
        Some("mobile") => "ti-device-mobile",
        Some("tablet") => "ti-device-tablet",
        _ => "ti-device-desktop",
    }
}

/// Device as in Account › Security (`Device::label`).
fn device(p: &Params<'_>, lang: Language) -> String {
    device::label(p.text("browser"), p.text("os"), lang)
}

/// Device with place; without a place with the truncated IP address.
fn device_at(p: &Params<'_>, lang: Language) -> String {
    let device = device(p, lang);
    let place = place(p.0.get("place"));
    if !place.is_empty() {
        tf(
            lang,
            "device.in_place",
            &[("device", &device), ("place", &place)],
        )
    } else if let Some(ip) = p.text("ip") {
        tf(
            lang,
            "device.with_ip",
            &[("device", &device), ("ip", &short_ip(ip))],
        )
    } else {
        device
    }
}

/// Place "City, Country": stored as text, also accepted as an object with
/// `city` and `country`.
fn place(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(place)) => ["city", "country"]
            .iter()
            .filter_map(|key| place.get(*key)?.as_str().filter(|s| !s.is_empty()))
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

/// Truncated IP address. It is stored truncated already and then stays as it
/// is; a full address is truncated by the same rule as Account › Security
/// (`mailer::format::short_ip`).
fn short_ip(ip: &str) -> String {
    ip.parse::<IpAddr>()
        .map_or_else(|_| ip.to_owned(), format::short_ip)
}

/// Text cut to at most `max` characters at a word boundary, with " …".
fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let head: String = text.chars().take(max - 1).collect();
    let head = match head.rfind(' ') {
        Some(at) if at > 0 => &head[..at],
        _ => &head[..],
    };
    let head = head.strip_suffix([',', '.', ';', ':']).unwrap_or(head);
    format!("{head} …")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_language(lang: Language, topic: &str, kind: &str, params: &Value) -> Rendered {
        render(
            topic,
            kind,
            params,
            &Context {
                lang,
                app: "Roedy Mail",
            },
        )
    }

    fn en(topic: &str, kind: &str, params: Value) -> Rendered {
        in_language(Language::English, topic, kind, &params)
    }

    fn says(rendered: &Rendered, title: &str, text: &str) {
        assert!(rendered.known, "{rendered:?}");
        assert_eq!(rendered.title, title);
        assert_eq!(rendered.text, text);
    }

    fn iphone() -> Value {
        json!({ "browser": "Safari", "os": "iPhone", "device_type": "mobile",
                "place": "Hamburg, Germany", "ip": "198.51.x.x" })
    }

    fn windows() -> Value {
        json!({ "browser": "Firefox", "os": "Windows", "device_type": "desktop", "ip": "203.0.x.x" })
    }

    fn with(mut base: Value, more: Value) -> Value {
        if let (Value::Object(base), Value::Object(more)) = (&mut base, more) {
            base.extend(more);
        }
        base
    }

    #[test]
    fn security_texts() {
        let login = en("security", "security.login", iphone());
        says(
            &login,
            "New sign-in",
            "Safari on iPhone in Hamburg, Germany. Not you? Sign out the device.",
        );
        assert_eq!(login.icon, "ti-device-mobile");
        let login = en("security", "security.login", windows());
        says(
            &login,
            "New sign-in",
            "Firefox on Windows, IP address 203.0.x.x. Not you? Sign out the device.",
        );
        assert_eq!(login.icon, "ti-device-desktop");
        let password = |base, ended: u64, reset: bool| {
            en(
                "security",
                "security.password",
                with(base, json!({ "sessions_ended": ended, "reset": reset })),
            )
        };
        says(
            &password(windows(), 2, false),
            "Password changed",
            "From Firefox on Windows. 2 other devices were signed out. Not you? Reset your password.",
        );
        says(
            &password(windows(), 0, false),
            "Password changed",
            "From Firefox on Windows. Not you? Reset your password.",
        );
        says(
            &password(iphone(), 3, true),
            "Password reset",
            "From Safari on iPhone. 3 devices were signed out.",
        );
        says(
            &password(iphone(), 1, false),
            "Password changed",
            "From Safari on iPhone. 1 other device was signed out. Not you? Reset your password.",
        );
        says(
            &en(
                "security",
                "security.email_change",
                json!({ "browser": "Safari", "os": "macOS", "device_type": "desktop",
                        "place": "Berlin, Germany", "email": "max.new@example.com" }),
            ),
            "Email address change requested",
            "New address max.new@example.com, requested from Safari on macOS. Not you? Discard the change.",
        );
        says(
            &en(
                "security",
                "security.mfa_reset",
                json!({ "by": "Anna Becker" }),
            ),
            "Multi-factor reset",
            "By Anna Becker. Set up an authenticator app again.",
        );
        says(
            &en("security", "security.mfa_reset", json!({})),
            "Multi-factor reset",
            "By your administrator. Set up an authenticator app again.",
        );
    }

    #[test]
    fn multi_factor_texts() {
        let app = |more| en("security", "security.totp_add", with(iphone(), more));
        says(
            &app(json!({ "name": "Max’s iPhone", "first": false })),
            "Authenticator app added",
            "“Max’s iPhone”, from Safari on iPhone in Hamburg, Germany.",
        );
        says(
            &app(json!({ "name": "Max’s iPhone", "first": true, "sole_admin": false })),
            "Authenticator app added",
            "Your first app, from Safari on iPhone. Not you? Contact your administrator right away.",
        );
        says(
            &app(json!({ "name": "Max’s iPhone", "first": true, "sole_admin": true })),
            "Authenticator app added",
            "Your first app, from Safari on iPhone. Not you? Reset your password right away.",
        );
        let removed = |more| en("security", "security.totp_remove", with(iphone(), more));
        says(
            &removed(json!({ "name": "Max’s iPhone", "last": false })),
            "Authenticator app removed",
            "“Max’s iPhone”, from Safari on iPhone in Hamburg, Germany.",
        );
        says(
            &removed(json!({ "name": "Max’s iPhone", "last": true })),
            "Last authenticator app removed",
            "You now sign in with just your password. Not you? Change your password.",
        );
        let used = |base, more| en("security", "security.recovery_used", with(base, more));
        says(
            &used(
                iphone(),
                json!({ "remaining": 9, "total": 10, "new_device": false }),
            ),
            "Recovery code used",
            "Safari on iPhone in Hamburg, Germany. 9 of 10 codes left.",
        );
        says(
            &used(
                windows(),
                json!({ "remaining": 8, "total": 10, "new_device": true }),
            ),
            "Recovery code used",
            "New device: Firefox on Windows, IP address 203.0.x.x. 8 of 10 codes left. Not you? Sign out the device.",
        );
        says(
            &used(
                iphone(),
                json!({ "remaining": 0, "total": 10, "new_device": false }),
            ),
            "Last recovery code used",
            "Safari on iPhone in Hamburg, Germany. Generate new codes.",
        );
        says(
            &en("security", "security.recovery_codes", iphone()),
            "New recovery codes generated",
            "From Safari on iPhone in Hamburg, Germany. Your previous codes no longer work.",
        );
        let target = app(json!({ "name": "x", "first": false })).target.unwrap();
        assert_eq!(target.path(), "/account/security");
    }

    #[test]
    fn account_team_system_and_news_texts() {
        for (fields, text) in [
            (json!(["name"]), "Display name changed."),
            (json!(["username"]), "Username changed."),
            (
                json!(["name", "username"]),
                "Display name and username changed.",
            ),
            (json!("username"), "Username changed."),
        ] {
            says(
                &en("account", "account.profile", json!({ "fields": fields })),
                "Profile changed",
                text,
            );
        }
        says(
            &en(
                "account",
                "account.email_confirmed",
                json!({ "email": "max.new@example.com" }),
            ),
            "Email address confirmed",
            "max.new@example.com is now used for sign-in and notifications.",
        );
        let quota = en(
            "account",
            "account.quota",
            json!({ "mail_account_id": "m1", "account": "max@example.com", "percent": 92,
                    "used": 4_939_212_390_u64, "limit": 5_368_709_120_u64 }),
        );
        says(
            &quota,
            "Storage almost full",
            "max@example.com is 92% full (4.6 GB of 5 GB).",
        );
        let target = quota.target.unwrap();
        assert_eq!(target.path(), "/account/mail-accounts/m1/overview");
        assert_eq!(
            target.to_json(),
            json!({ "view": "mailacct", "page": "overview",
                    "path": "/account/mail-accounts/m1/overview", "mail_account_id": "m1" })
        );

        let accepted = en(
            "team",
            "team.invite_accepted",
            json!({ "user_id": "u7", "name": "Lea Fischer" }),
        );
        says(
            &accepted,
            "Invitation accepted",
            "Lea Fischer now has access.",
        );
        assert_eq!(
            accepted.target.unwrap().to_json(),
            json!({ "view": "admin", "page": "users", "path": "/admin/users",
                    "user_id": "u7" })
        );
        let role = |role| {
            en(
                "team",
                "team.role_changed",
                json!({ "user_id": "u2", "name": "Anna Becker", "role": role }),
            )
        };
        says(
            &role("admin"),
            "Role changed",
            "Anna Becker is now an administrator.",
        );
        says(&role("user"), "Role changed", "Anna Becker is now a user.");
        says(
            &en(
                "team",
                "team.user_locked",
                json!({ "user_id": "u3", "name": "Jonas Weber" }),
            ),
            "User suspended",
            "Jonas Weber was suspended and signed out.",
        );
        let requested = en(
            "team",
            "team.invite_requested",
            json!({ "invitation_id": "i1", "email": "lea.fischer@example.com" }),
        );
        says(
            &requested,
            "New invitation requested",
            "lea.fischer@example.com is asking for a new invitation. The old one has expired.",
        );
        assert_eq!(
            requested.target.unwrap().entry,
            Some(Entry::Invitation("i1".into()))
        );

        says(
            &en("system", "system.backup_ok", json!({ "size": 251_658_240 })),
            "Backup created",
            "The automatic backup is complete (240.0 MB).",
        );
        says(
            &en("system", "system.backup_ok", json!({})),
            "Backup created",
            "The automatic backup is complete.",
        );
        says(
            &en("system", "system.backup_failed", json!({})),
            "Backup failed",
            "The automatic backup failed. Check the storage space and log.",
        );
        says(
            &en(
                "system",
                "system.update_available",
                json!({ "version": "0.7.0" }),
            ),
            "Update available",
            "Version 0.7.0 is out.",
        );
        let installed = en(
            "system",
            "system.update_installed",
            json!({ "version": "0.7.0", "from": "0.6.0" }),
        );
        says(
            &installed,
            "Update installed",
            "Roedy Mail is now running version 0.7.0 (previously 0.6.0).",
        );
        assert_eq!(installed.target.unwrap().path(), "/admin/updates");
        says(
            &en(
                "system",
                "system.update_installed",
                json!({ "version": "0.7.0" }),
            ),
            "Update installed",
            "Roedy Mail is now running version 0.7.0.",
        );
        says(
            &en(
                "system",
                "system.maintenance_on",
                json!({ "by": "Anna Becker" }),
            ),
            "Maintenance mode turned on",
            "By Anna Becker. Users are signed out until it ends.",
        );
        says(
            &en(
                "system",
                "system.maintenance_off",
                json!({ "by": "Anna Becker" }),
            ),
            "Maintenance mode turned off",
            "By Anna Becker. Users can sign in again.",
        );

        let welcome = en("news", "news.welcome", json!({}));
        says(
            &welcome,
            "Welcome",
            "In Settings, you can adjust the appearance, language, and more.",
        );
        assert_eq!(welcome.target.unwrap().path(), "/settings/general");
        says(
            &en("news", "news.release", json!({ "version": "0.7.0" })),
            "New in version 0.7.0",
            "See what’s new.",
        );
        says(
            &en(
                "news",
                "news.release",
                json!({ "version": "0.7.0",
                        "summary": "Rules for incoming messages, shared folders, new keyboard shortcuts, and much more." }),
            ),
            "New in version 0.7.0",
            "Rules for incoming messages, shared folders, new keyboard shortcuts …",
        );
    }

    #[test]
    fn unknown_kinds_and_missing_params_fall_back_to_the_topic() {
        let unknown = en("security", "security.passkey_add", json!({}));
        assert_eq!(
            unknown,
            Rendered {
                icon: "ti-shield-lock",
                title: "Security".into(),
                text: String::new(),
                target: None,
                known: false,
            }
        );
        for (topic, title) in [
            ("account", "Account"),
            ("team", "Team"),
            ("system", "System"),
            ("news", "News"),
            ("unknown", "Notification"),
        ] {
            assert_eq!(en(topic, "x.y", json!({})).title, title);
        }
        // Missing details that would appear in the text.
        for (topic, kind, params) in [
            ("security", "security.email_change", json!({})),
            ("security", "security.totp_add", json!({ "first": false })),
            (
                "security",
                "security.recovery_used",
                json!({ "remaining": 3 }),
            ),
            (
                "account",
                "account.quota",
                json!({ "account": "max@example.com" }),
            ),
            ("team", "team.user_locked", json!({ "user_id": "u3" })),
            ("system", "system.maintenance_on", json!({})),
            ("news", "news.release", json!({ "summary": "New" })),
        ] {
            let got = en(topic, kind, params);
            assert!(!got.known, "{kind}: {got:?}");
            assert_eq!(got.text, "");
            assert_eq!(got.target, None);
        }
        assert_eq!(en("team", "team.user_locked", json!(null)).icon, "ti-users");
    }

    #[test]
    fn targets_without_a_usable_entry() {
        // Without the account's ID, "Storage almost full" leads to the list.
        let quota = en(
            "account",
            "account.quota",
            json!({ "account": "a@example.com", "percent": 90, "used": 9, "limit": 10 }),
        );
        assert_eq!(quota.target.unwrap().path(), "/account/mail-accounts");
        // An ID that does not belong in a path is dropped.
        let odd = en(
            "account",
            "account.quota",
            json!({ "mail_account_id": "../x", "account": "a@example.com", "percent": 90,
                    "used": 9, "limit": 10 }),
        );
        assert_eq!(odd.target.unwrap().entry, None);
        let settings = |page| Target::settings(page).path();
        assert_eq!(settings("profile"), "/account/profile");
        assert_eq!(settings("mail-accounts"), "/account/mail-accounts");
        assert_eq!(settings("about"), "/settings/about");
    }

    #[test]
    fn places_addresses_and_sizes() {
        let object = json!({ "browser": "Safari", "os": "iPhone",
                             "place": { "city": "", "country": "Germany" } });
        assert_eq!(
            en("security", "security.recovery_codes", object).text,
            "From Safari on iPhone in Germany. Your previous codes no longer work."
        );
        assert_eq!(short_ip("198.51.100.56"), "198.51.x.x");
        assert_eq!(short_ip("2001:db8:x:x:x:x:x:x"), "2001:db8:x:x:x:x:x:x");
        assert_eq!(short_ip("2001:db8:1:2::1"), "2001:db8:x:x:x:x:x:x");
        assert_eq!(short_ip("unknown"), "unknown");
        assert_eq!(
            device(
                &Params(json!({ "os": "Linux" }).as_object().unwrap()),
                Language::English
            ),
            "Browser on Linux"
        );
        assert_eq!(
            device(&Params(&Map::new()), Language::English),
            "Unknown device"
        );
        assert_eq!(cut("  short  ", 70), "short");
        assert_eq!(cut("one two, three", 12), "one two …");
        assert_eq!(cut("Nowhitespace", 6), "Nowhi …");
    }

    /// All events and details of the tests above, plus the fallbacks.
    fn cases() -> Vec<(&'static str, &'static str, Value)> {
        let password = |base, ended: u64, reset: bool| {
            with(base, json!({ "sessions_ended": ended, "reset": reset }))
        };
        let user = |role| json!({ "user_id": "u2", "name": "Anna Becker", "role": role });
        vec![
            ("security", "security.login", iphone()),
            ("security", "security.login", windows()),
            (
                "security",
                "security.password",
                password(windows(), 2, false),
            ),
            (
                "security",
                "security.password",
                password(windows(), 0, false),
            ),
            ("security", "security.password", password(iphone(), 3, true)),
            (
                "security",
                "security.password",
                password(iphone(), 1, false),
            ),
            (
                "security",
                "security.email_change",
                json!({ "browser": "Safari", "os": "macOS", "device_type": "desktop",
                        "place": "Berlin, Germany", "email": "max.new@example.com" }),
            ),
            (
                "security",
                "security.mfa_reset",
                json!({ "by": "Anna Becker" }),
            ),
            ("security", "security.mfa_reset", json!({})),
            (
                "security",
                "security.totp_add",
                with(iphone(), json!({ "name": "Max’s iPhone", "first": false })),
            ),
            (
                "security",
                "security.totp_add",
                with(iphone(), json!({ "first": true, "sole_admin": false })),
            ),
            (
                "security",
                "security.totp_add",
                with(iphone(), json!({ "first": true, "sole_admin": true })),
            ),
            (
                "security",
                "security.totp_remove",
                with(iphone(), json!({ "name": "Max’s iPhone", "last": false })),
            ),
            (
                "security",
                "security.totp_remove",
                with(iphone(), json!({ "last": true })),
            ),
            (
                "security",
                "security.recovery_used",
                with(
                    iphone(),
                    json!({ "remaining": 9, "total": 10, "new_device": false }),
                ),
            ),
            (
                "security",
                "security.recovery_used",
                with(
                    windows(),
                    json!({ "remaining": 8, "total": 10, "new_device": true }),
                ),
            ),
            (
                "security",
                "security.recovery_used",
                with(iphone(), json!({ "remaining": 0, "new_device": false })),
            ),
            ("security", "security.recovery_codes", iphone()),
            ("security", "security.recovery_codes", json!({})),
            ("account", "account.profile", json!({ "fields": ["name"] })),
            (
                "account",
                "account.profile",
                json!({ "fields": ["username"] }),
            ),
            (
                "account",
                "account.profile",
                json!({ "fields": ["name", "username"] }),
            ),
            (
                "account",
                "account.email_confirmed",
                json!({ "email": "max.new@example.com" }),
            ),
            (
                "account",
                "account.quota",
                json!({ "mail_account_id": "m1", "account": "max@example.com", "percent": 92,
                        "used": 4_939_212_390_u64, "limit": 5_368_709_120_u64 }),
            ),
            (
                "team",
                "team.invite_accepted",
                json!({ "user_id": "u7", "name": "Lea Fischer" }),
            ),
            ("team", "team.role_changed", user("admin")),
            ("team", "team.role_changed", user("user")),
            (
                "team",
                "team.user_locked",
                json!({ "user_id": "u3", "name": "Jonas Weber" }),
            ),
            (
                "team",
                "team.invite_requested",
                json!({ "invitation_id": "i1", "email": "lea.fischer@example.com" }),
            ),
            ("system", "system.backup_ok", json!({ "size": 251_658_240 })),
            ("system", "system.backup_ok", json!({})),
            ("system", "system.backup_failed", json!({})),
            (
                "system",
                "system.update_available",
                json!({ "version": "0.7.0" }),
            ),
            (
                "system",
                "system.update_installed",
                json!({ "version": "0.7.0", "from": "0.6.0" }),
            ),
            (
                "system",
                "system.update_installed",
                json!({ "version": "0.7.0" }),
            ),
            (
                "system",
                "system.maintenance_on",
                json!({ "by": "Anna Becker" }),
            ),
            (
                "system",
                "system.maintenance_off",
                json!({ "by": "Anna Becker" }),
            ),
            ("news", "news.welcome", json!({})),
            ("news", "news.release", json!({ "version": "0.7.0" })),
            // Fallbacks to the topic.
            ("security", "security.passkey_add", json!({})),
            ("security", "security.email_change", json!({})),
            ("team", "team.user_locked", json!({ "user_id": "u3" })),
            ("unknown", "x.y", json!({})),
        ]
    }

    /// German has the same icons, targets and fallbacks as English, and
    /// every text is translated and fully filled in.
    #[test]
    fn german_matches_english_in_everything_but_the_wording() {
        let mut known = std::collections::BTreeSet::new();
        for (topic, kind, params) in cases() {
            let german = in_language(Language::German, topic, kind, &params);
            let english = en(topic, kind, params);
            assert_eq!(
                (german.icon, &german.target, german.known),
                (english.icon, &english.target, english.known),
                "{kind}: {german:?}"
            );
            if english.known {
                known.insert(kind);
                assert_ne!(german.title, english.title, "{kind}");
                assert_ne!(german.text, english.text, "{kind}");
            }
            for text in [&german.title, &german.text, &english.title, &english.text] {
                assert!(!text.contains(['{', '}']), "{kind}: {text}");
            }
        }
        // Every event of the catalogue occurs.
        assert_eq!(known.len(), 23, "{known:?}");
    }

    /// The German sentences are assembled from the same parts as the English
    /// ones.
    #[test]
    fn german_assembles_the_same_parts() {
        let de = Language::German;
        let text = in_language(
            de,
            "security",
            "security.password",
            &with(windows(), json!({ "sessions_ended": 2, "reset": false })),
        )
        .text;
        let device = device::label(Some("Firefox"), Some("Windows"), de);
        assert_eq!(
            text,
            [
                tf(
                    de,
                    "notification.security.password.text",
                    &[("device", &device)]
                ),
                plural(
                    de,
                    "notification.security.password.signed_out_others",
                    2,
                    &[]
                ),
                t(de, "notification.security.password.not_you").to_owned(),
            ]
            .join(" ")
        );
        let quota = in_language(
            de,
            "account",
            "account.quota",
            &json!({ "account": "max@example.com", "percent": 92,
                     "used": 1_288_490_189_u64, "limit": 5_368_709_120_u64 }),
        );
        assert!(quota.text.contains(&size(1_288_490_189, de)), "{quota:?}");
        assert_ne!(
            size(1_288_490_189, de),
            size(1_288_490_189, Language::English)
        );
    }

    #[test]
    fn english_texts_use_english_quotes() {
        for (topic, kind, params) in cases() {
            let got = en(topic, kind, params);
            for text in [&got.title, &got.text] {
                assert!(!text.contains(['\u{201e}', '\u{201a}']), "{kind}: {text}");
                // "…" would leave a “ without ”.
                assert_eq!(
                    text.matches('“').count(),
                    text.matches('”').count(),
                    "{kind}: {text}"
                );
            }
        }
    }
}
