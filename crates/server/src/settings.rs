//! Per-user settings: one JSON document with the field names and values of
//! the web app's settings pages, in `user_settings` with a version.
//!
//! - [`Settings`] knows every field with the values the web app offers.
//!   Without a row and for missing fields the default applies.
//! - [`Settings::apply`] applies a change from `PUT settings` and checks
//!   each field on its own.
//! - [`load`] and [`save`] read and store with a version. Stored data that
//!   this program version does not accept (e.g. after a downgrade) falls back
//!   to the default – part by part, so that e.g. an unknown topic in `nMx`
//!   does not reset all other channels.
//! - [`Settings::format`] provides the time zone and formats for mails, the
//!   event catalog reads the channels `nCh` and `nMx`
//!   (`events::Channels::of`). Security stays on there in the app and by
//!   email, whatever is stored; it is still stored the way the page shows it
//!   ([`Settings::apply`]).

use std::collections::HashSet;

use jiff::tz::TimeZone;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    auth::email::MAX_LEN,
    db::repo::{user_settings, users},
    mailer::format::{DEFAULT_TZ, DateFormat, Format, TimeFormat},
};

/// A setting with a fixed choice, serialized as a stable identifier.
macro_rules! choice {
    ($(#[$meta:meta])* $name:ident {
        $($(#[$variant_meta:meta])* $variant:ident = $value:literal),+ $(,)?
    }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$variant_meta])* #[serde(rename = $value)] $variant),+
        }
    };
}

choice!(
    /// Color scheme; without a choice the web app decides.
    ColorScheme { Light = "light", Dark = "dark", System = "system" }
);
choice!(
    /// Font size.
    FontSize { Small = "small", Medium = "medium", Large = "large" }
);
choice!(
    /// Density.
    Density { Compact = "compact", Normal = "normal", Comfortable = "comfortable" }
);
choice!(
    /// Look of the message list.
    ListDesign { Soft = "soft", Compact = "compact" }
);
choice!(
    /// Language of the web app, the mails and the backend texts; English
    /// unless chosen otherwise. `System` follows the browser: the web app
    /// asks it, backend texts and mails use the language of the last
    /// sign-in ([`Language::or_sign_in`]).
    #[derive(Default)]
    Language {
        German = "de",
        #[default]
        English = "en",
        System = "system",
    }
);

impl Language {
    /// Language code, as serialized; for German and English also the `lang`
    /// of the mails.
    pub fn code(self) -> &'static str {
        match self {
            Self::German => "de",
            Self::English => "en",
            Self::System => "system",
        }
    }

    /// The language texts are written in: `System` becomes `sign_in`, the
    /// language of the last sign-in, without one English.
    pub fn or_sign_in(self, sign_in: Option<Self>) -> Self {
        match self {
            Self::System => match sign_in {
                Some(Self::German) => Self::German,
                _ => Self::English,
            },
            fixed => fixed,
        }
    }

    /// The language a browser prefers, from `Accept-Language`: German for
    /// `de` and its regions, English for every other language; `None`
    /// without a language (empty, only `*` or `q=0`).
    pub fn from_accept_language(header: &str) -> Option<Self> {
        let mut best: Option<(&str, f32)> = None;
        for entry in header.split(',') {
            let mut parts = entry.split(';').map(str::trim);
            let tag = parts.next().unwrap_or_default();
            let weight = parts
                .find_map(|param| {
                    param
                        .strip_prefix("q=")
                        .or_else(|| param.strip_prefix("Q="))
                })
                .map_or(Some(1.0), |q| {
                    q.parse::<f32>().ok().filter(|q| (0.0..=1.0).contains(q))
                });
            let Some(weight) = weight else { continue };
            if tag.is_empty() || tag == "*" || weight <= 0.0 {
                continue;
            }
            // The first of equal weights wins.
            if best.is_none_or(|(_, top)| weight > top) {
                best = Some((tag, weight));
            }
        }
        let (tag, _) = best?;
        let primary = tag.split(['-', '_']).next().unwrap_or_default();
        Some(if primary.eq_ignore_ascii_case("de") {
            Self::German
        } else {
            Self::English
        })
    }
}

/// Accent color; without a choice the brand color applies. One of the five
/// named accents or a custom color, stored as `#rrggbb` in lowercase
/// (accepted: `#rgb`, `rgb`, `#rrggbb`, `rrggbb`, any case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Accent {
    Apricot,
    Sage,
    Lavender,
    Sky,
    Rose,
    /// Custom color as red, green and blue.
    Custom([u8; 3]),
}

impl Accent {
    /// Identifier as stored: the name or `#rrggbb`.
    pub fn id(self) -> String {
        let name = match self {
            Self::Apricot => "apricot",
            Self::Sage => "sage",
            Self::Lavender => "lavender",
            Self::Sky => "sky",
            Self::Rose => "rose",
            Self::Custom([r, g, b]) => return format!("#{r:02x}{g:02x}{b:02x}"),
        };
        name.to_owned()
    }

    /// A custom color from hex digits: `#rgb`, `rgb`, `#rrggbb` or `rrggbb`,
    /// any case.
    pub fn hex(value: &str) -> Option<Self> {
        let digits = value.strip_prefix('#').unwrap_or(value);
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |range: std::ops::Range<usize>| u8::from_str_radix(&digits[range], 16).ok();
        let rgb = match digits.len() {
            3 => [byte(0..1)? * 17, byte(1..2)? * 17, byte(2..3)? * 17],
            6 => [byte(0..2)?, byte(2..4)?, byte(4..6)?],
            _ => return None,
        };
        Some(Self::Custom(rgb))
    }
}

impl TryFrom<String> for Accent {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let named = match value.as_str() {
            "apricot" => Self::Apricot,
            "sage" => Self::Sage,
            "lavender" => Self::Lavender,
            "sky" => Self::Sky,
            "rose" => Self::Rose,
            other => return Self::hex(other).ok_or("accent name or hex color"),
        };
        Ok(named)
    }
}

impl From<Accent> for String {
    fn from(accent: Accent) -> Self {
        accent.id()
    }
}

choice!(
    /// Country or region.
    Region {
        Germany = "DE",
        Austria = "AT",
        Switzerland = "CH",
        France = "FR",
        Italy = "IT",
        Netherlands = "NL",
        Spain = "ES",
        UnitedKingdom = "GB",
        UnitedStates = "US",
    }
);
choice!(
    /// First day of the week.
    WeekStart { Monday = "monday", Sunday = "sunday" }
);
choice!(
    /// Number format.
    NumberFormat {
        Comma = "1.234,56",
        Point = "1,234.56",
        Space = "1\u{a0}234,56",
    }
);
choice!(
    /// What opens at startup.
    StartPage { Inbox = "inbox", Last = "last" }
);
choice!(
    /// Duration of the undo hint.
    UndoDelay { Three = "3 s", Five = "5 s", Ten = "10 s" }
);
choice!(
    /// Action of a swipe gesture.
    Swipe {
        Nothing = "none",
        Delete = "del",
        Read = "read",
        Star = "star",
        Spam = "spam",
        Move = "move",
    }
);
choice!(
    /// External content in emails.
    ExternalContent { Ask = "ask", Always = "always", Never = "never" }
);
choice!(
    /// Digest by email.
    Digest { Instant = "instant", Daily = "daily", Weekly = "weekly" }
);
choice!(
    /// Log level of the developer page.
    LogLevel { Error = "error", Warning = "warning", Info = "info", Debug = "debug" }
);

/// Notification channels: globally as `nCh`, per topic in `nMx`. Changes and
/// stored data are taken over part by part by [`Settings::apply`] and
/// [`load`] respectively.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelSet {
    pub app: bool,
    pub mail: bool,
    pub push: bool,
}

/// Channels per topic (`nMx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Topics {
    pub security: ChannelSet,
    pub account: ChannelSet,
    pub team: ChannelSet,
    pub system: ChannelSet,
    pub news: ChannelSet,
}

/// Time of day of the quiet hours (`nFrom`, `nTo`) like
/// `<input type="time">`: "22:00".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Clock(String);

impl Clock {
    /// Fixed value from the code, such as a default.
    pub(crate) fn fixed(value: &str) -> Self {
        debug_assert!(Self::try_from(value.to_owned()).is_ok(), "{value}");
        Self(value.to_owned())
    }

    /// As a time of day (checked on creation).
    pub fn time(&self) -> jiff::civil::Time {
        let number = |range: std::ops::Range<usize>| self.0[range].parse::<i8>().unwrap_or(0);
        jiff::civil::Time::new(number(0..2), number(3..5), 0, 0).unwrap_or_default()
    }
}

impl TryFrom<String> for Clock {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let valid = match value.as_bytes() {
            [h1, h2, b':', m1, m2] if [h1, h2, m1, m2].iter().all(|b| b.is_ascii_digit()) => {
                (h1 - b'0') * 10 + (h2 - b'0') < 24 && *m1 < b'6'
            }
            _ => false,
        };
        if valid {
            Ok(Self(value))
        } else {
            Err("time of day as HH:MM")
        }
    }
}

/// Time zone (`tz`) as an IANA name known to the embedded time zone database,
/// in its spelling ("europe/berlin" becomes "Europe/Berlin", as `Intl` names
/// it). `Etc/Unknown` (CLDR, not an IANA name) is not valid. While
/// `tzAuto` applies, the web app reports the zone from the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Zone(String);

impl Zone {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Zone {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        // Longer than any name in the database; guards against arbitrary input.
        let name = (value.len() <= 64)
            .then(|| TimeZone::get(&value).ok())
            .flatten()
            .and_then(|zone| zone.iana_name().map(str::to_owned));
        name.map(Self).ok_or("unknown time zone")
    }
}

/// Senders whose external content is always loaded (`extAllow`): addresses
/// from the `From` header, lowercase, each once. Only the shape is checked
/// (`@` with parts before and after, no control characters, at most 254
/// characters) – not the stricter check for account addresses, because
/// `root@localhost` or a quoted local part also occur as senders.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<String>")]
pub struct Senders(Vec<String>);

/// Maximum number of allowed senders.
pub const MAX_SENDERS: usize = 1000;

impl TryFrom<Vec<String>> for Senders {
    type Error = &'static str;

    fn try_from(list: Vec<String>) -> Result<Self, Self::Error> {
        if list.len() > MAX_SENDERS {
            return Err("too many senders");
        }
        let mut senders = Vec::with_capacity(list.len());
        let mut seen = HashSet::with_capacity(list.len());
        for address in list {
            let address = address.trim().to_lowercase();
            let valid = address.len() <= MAX_LEN
                && !address.chars().any(char::is_control)
                && address
                    .rsplit_once('@')
                    .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty());
            if !valid {
                return Err("not a sender address");
            }
            if seen.insert(address.clone()) {
                senders.push(address);
            }
        }
        Ok(Self(senders))
    }
}

/// Default account (`defaultAccount`): a mail account or
/// `all` ("all accounts"). Only the shape of the ID is checked here (ULID,
/// stored in uppercase like `db::new_id`); that it is one of the user's
/// accounts is checked by `PUT settings`, and `api::mail_accounts` updates it
/// when accounts are added and removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct DefaultAccount(String);

impl DefaultAccount {
    /// A mail account (ID from `db::new_id`).
    pub fn account(id: &str) -> Self {
        Self(id.to_owned())
    }

    /// ID of the account; `None` for "all accounts".
    pub fn account_id(&self) -> Option<&str> {
        (self.0 != "all").then_some(self.0.as_str())
    }
}

impl TryFrom<String> for DefaultAccount {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value == "all" {
            return Ok(Self(value));
        }
        ulid::Ulid::from_string(&value)
            .map(|id| Self(id.to_string()))
            .map_err(|_| "account ID or all")
    }
}

/// All settings of a user with the field names of the web app. Missing fields take
/// the default, unknown ones make reading fail (then [`load`] takes over
/// field by field).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    // Appearance
    pub mode: Option<ColorScheme>,
    pub accent: Option<Accent>,
    /// Greeting on the start page; on without a choice.
    pub greet: Option<bool>,
    pub font_size: FontSize,
    pub density: Density,
    pub animations: bool,
    pub pf_design: ListDesign,
    // Language and region
    pub lang: Language,
    pub region: Region,
    pub tz_auto: bool,
    pub tz: Zone,
    pub date_fmt: DateFormat,
    pub time_fmt: TimeFormat,
    pub week_start: WeekStart,
    pub num_fmt: NumberFormat,
    // General
    pub g_start: StartPage,
    pub g_confirm: bool,
    pub g_undo: UndoDelay,
    pub g_keys: bool,
    pub sw_l: Swipe,
    pub sw_r: Swipe,
    pub ext_mode: ExternalContent,
    pub ext_allow: Senders,
    pub default_account: Option<DefaultAccount>,
    // Notifications
    pub n_ch: ChannelSet,
    pub n_mx: Topics,
    pub n_quiet: bool,
    pub n_from: Clock,
    pub n_to: Clock,
    pub n_digest: Digest,
    pub n_sound: bool,
    // Developer
    pub dev_debug: bool,
    pub dev_level: LogLevel,
    pub dev_offline: bool,
    // Shell
    /// Revision of the banner the person last closed.
    pub banner_dismissed_rev: Option<u64>,
    /// "Advanced": shows the developer page to administrators.
    pub advanced: bool,
}

const fn channels(app: bool, mail: bool, push: bool) -> ChannelSet {
    ChannelSet { app, mail, push }
}

impl Default for Settings {
    /// The defaults of the web app's "Reset settings", plus the initial
    /// values for `tz`, `extMode`, `extAllow`, `defaultAccount`, `advanced`
    /// and no closed banner.
    fn default() -> Self {
        Self {
            mode: None,
            accent: None,
            greet: None,
            font_size: FontSize::Medium,
            density: Density::Normal,
            animations: true,
            pf_design: ListDesign::Soft,
            lang: Language::default(),
            region: Region::UnitedKingdom,
            tz_auto: true,
            tz: Zone(DEFAULT_TZ.to_owned()),
            date_fmt: DateFormat::De,
            time_fmt: TimeFormat::H24,
            week_start: WeekStart::Monday,
            num_fmt: NumberFormat::Point,
            g_start: StartPage::Inbox,
            g_confirm: true,
            g_undo: UndoDelay::Five,
            g_keys: true,
            sw_l: Swipe::Move,
            sw_r: Swipe::Delete,
            ext_mode: ExternalContent::Ask,
            ext_allow: Senders::default(),
            default_account: None,
            n_ch: channels(true, true, false),
            n_mx: Topics {
                security: channels(true, true, true),
                account: channels(true, true, false),
                team: channels(true, false, false),
                system: channels(true, false, false),
                news: channels(true, false, false),
            },
            n_quiet: false,
            n_from: Clock("22:00".to_owned()),
            n_to: Clock("07:00".to_owned()),
            n_digest: Digest::Daily,
            n_sound: true,
            dev_debug: false,
            dev_level: LogLevel::Info,
            dev_offline: false,
            banner_dismissed_rev: None,
            advanced: false,
        }
    }
}

/// Fields a change could not apply: name as in the document (parts joined
/// with a dot, e.g. `nMx.team.mail`) and code (`unknown`, `invalid`).
#[derive(Debug)]
pub enum Rejected {
    Fields(Vec<(String, &'static str)>),
    Internal(serde_json::Error),
}

/// One part of a change: location in the field as a JSON pointer (empty =
/// the whole field), name for the error and new value.
struct Part<'a> {
    pointer: String,
    name: String,
    value: &'a Value,
}

/// Splits `change` against the value `current`: objects (`nCh`, `nMx`) part
/// by part down to the values, so that an unknown or invalid part only
/// discards itself and missing parts stay as they are.
fn parts<'a>(
    current: &Value,
    change: &'a Value,
    pointer: String,
    name: String,
    out: &mut Vec<Part<'a>>,
) {
    let (Value::Object(current), Value::Object(change)) = (current, change) else {
        out.push(Part {
            pointer,
            name,
            value: change,
        });
        return;
    };
    for (key, value) in change {
        let pointer = format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
        let name = format!("{name}.{key}");
        match current.get(key) {
            Some(inner) => parts(inner, value, pointer, name, out),
            None => out.push(Part {
                pointer,
                name,
                value,
            }),
        }
    }
}

impl Settings {
    /// Applies the fields from `changes` (`PUT settings`); missing ones keep
    /// their value, in `nCh` and `nMx` missing parts as well. Each field is
    /// checked on its own so that the error can name it: unknown fields as
    /// `unknown`, values the web app does not offer as `invalid` – then
    /// nothing changes.
    pub fn apply(&self, changes: &Map<String, Value>) -> Result<Self, Rejected> {
        let mut problems = Vec::new();
        let merged = self
            .merge(changes, false, |field, code| {
                problems.push((field.to_owned(), code));
            })
            .map_err(Rejected::Internal)?;
        if problems.is_empty() {
            Ok(merged)
        } else {
            Err(Rejected::Fields(problems))
        }
    }

    /// Lays `changes` part by part over these settings. What does not fit is
    /// reported via `reject` and stays as it was. `lenient` (reading stored
    /// data): of a list that does not fit as a whole, the entries that fit on
    /// their own apply.
    fn merge(
        &self,
        changes: &Map<String, Value>,
        lenient: bool,
        mut reject: impl FnMut(&str, &'static str),
    ) -> serde_json::Result<Self> {
        let Value::Object(mut doc) = serde_json::to_value(self)? else {
            return Err(serde::de::Error::custom("settings are not an object"));
        };
        for (field, change) in changes {
            let Some(slot) = doc.get_mut(field) else {
                reject(field, "unknown");
                continue;
            };
            // A value is valid if the field alone can be read with it.
            let valid = |value: &Value| {
                let single = Map::from_iter([(field.clone(), value.clone())]);
                Self::deserialize(&Value::Object(single)).is_ok()
            };
            let mut split = Vec::new();
            parts(slot, change, String::new(), field.clone(), &mut split);
            for part in split {
                let mut candidate = slot.clone();
                let Some(target) = candidate.pointer_mut(&part.pointer) else {
                    reject(&part.name, "unknown");
                    continue;
                };
                *target = part.value.clone();
                if lenient
                    && let Value::Array(items) = part.value
                    && !valid(&candidate)
                {
                    // Of a list, the entries that fit on their own apply.
                    let fits = |item: &Value| {
                        let mut one = slot.clone();
                        if let Some(target) = one.pointer_mut(&part.pointer) {
                            *target = Value::Array(vec![item.clone()]);
                        }
                        valid(&one)
                    };
                    let kept: Vec<Value> =
                        items.iter().filter(|item| fits(item)).cloned().collect();
                    if let Some(target) = candidate.pointer_mut(&part.pointer) {
                        *target = Value::Array(kept);
                    }
                }
                if valid(&candidate) {
                    // Only entries of a list were discarded.
                    if candidate.pointer(&part.pointer) != Some(part.value) {
                        reject(&part.name, "invalid");
                    }
                    *slot = candidate;
                } else {
                    reject(&part.name, "invalid");
                }
            }
        }
        let mut merged = Self::deserialize(&Value::Object(doc))?;
        merged.lock_security();
        Ok(merged)
    }

    /// Security is locked and on in the app and by email; that is also what
    /// the document says. The
    /// lock takes effect in the event catalog, not only here.
    fn lock_security(&mut self) {
        self.n_mx.security.app = true;
        self.n_mx.security.mail = true;
    }

    /// Time zone, formats and `lang` (resolved, see [`Stored::lang`]) for
    /// mails to this person.
    pub fn format(&self, lang: Language) -> Format {
        Format::new(self.tz.as_str(), self.date_fmt, self.time_fmt, lang)
    }
}

/// Settings with the version they are based on (0 = never stored).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub version: i64,
    pub settings: Settings,
    /// The stored document contains something this version skips; the next
    /// `PUT` rewrites it, even if nothing changes.
    pub rewrite: bool,
    /// Language of backend texts and mails: `settings.lang`, for `system` the
    /// language of the last sign-in ([`Language::or_sign_in`]).
    pub lang: Language,
}

impl Stored {
    /// Time zone, formats and language for mails to this person.
    pub fn format(&self) -> Format {
        self.settings.format(self.lang)
    }
}

/// Reads the settings, filled up with the defaults. What this version does not
/// know (any more) or does not accept – e.g. after a downgrade or a new topic
/// in `nMx` – falls back to the default part by part (logged); if the
/// document is not an object at all, all defaults apply. Only a database
/// error fails: security events and login read from here as well.
pub fn load(conn: &Connection, user_id: &str) -> anyhow::Result<Stored> {
    let (version, settings, rewrite) = load_settings(conn, user_id)?;
    let sign_in = match settings.lang {
        Language::System => users::sign_in_lang(conn, user_id)?,
        _ => None,
    };
    let lang = settings.lang.or_sign_in(sign_in);
    Ok(Stored {
        version,
        settings,
        rewrite,
        lang,
    })
}

/// [`load`] without the language: version, settings and whether to rewrite.
fn load_settings(conn: &Connection, user_id: &str) -> anyhow::Result<(i64, Settings, bool)> {
    let Some(row) = user_settings::get(conn, user_id)? else {
        return Ok((0, Settings::default(), false));
    };
    let doc: Value = serde_json::from_str(&row.json).unwrap_or(Value::Null);
    let Value::Object(changes) = &doc else {
        tracing::warn!(
            user_id,
            "stored settings are not an object, using the defaults"
        );
        return Ok((row.version, Settings::default(), true));
    };
    // Usually the document fits exactly.
    if let Ok(mut settings) = Settings::deserialize(&doc) {
        settings.lock_security();
        return Ok((row.version, settings, false));
    }
    let settings = Settings::default().merge(changes, true, |field, code| {
        tracing::warn!(user_id, field, code, "stored setting skipped");
    })?;
    Ok((row.version, settings, true))
}

/// Stores `settings` as the successor of `version` and returns the new
/// version; `None` if another one applies by now.
pub fn save(
    conn: &Connection,
    user_id: &str,
    version: i64,
    settings: &Settings,
) -> anyhow::Result<Option<i64>> {
    let json = serde_json::to_string(settings)?;
    Ok(user_settings::save(conn, user_id, &json, version)?)
}

/// Time zone, formats and language for mails to a user.
pub fn format_of(conn: &Connection, user_id: &str) -> anyhow::Result<Format> {
    Ok(load(conn, user_id)?.format())
}

/// A user's language for backend texts ([`Stored::lang`]).
pub fn lang_of(conn: &Connection, user_id: &str) -> anyhow::Result<Language> {
    Ok(load(conn, user_id)?.lang)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use serde_json::json;

    use super::*;
    use crate::{
        auth::session::{self, Client},
        db::repo::users::{
            Role,
            tests::{add, conn},
        },
    };

    fn changes(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else {
            panic!("not an object");
        };
        map
    }

    fn rejected(result: Result<Settings, Rejected>) -> Vec<(String, &'static str)> {
        match result {
            Err(Rejected::Fields(fields)) => fields,
            other => panic!("expected field errors: {other:?}"),
        }
    }

    #[test]
    fn language_code_is_the_serialized_value() {
        for lang in [Language::German, Language::English, Language::System] {
            assert_eq!(serde_json::to_value(lang).unwrap(), json!(lang.code()));
        }
    }

    #[test]
    fn system_language_is_the_sign_in_language_or_english() {
        let system = Language::System;
        assert_eq!(system.or_sign_in(Some(Language::German)), Language::German);
        assert_eq!(
            system.or_sign_in(Some(Language::English)),
            Language::English
        );
        assert_eq!(system.or_sign_in(None), Language::English);
        // A chosen language stays.
        assert_eq!(
            Language::German.or_sign_in(Some(Language::English)),
            Language::German
        );
        assert_eq!(
            Language::English.or_sign_in(Some(Language::German)),
            Language::English
        );
    }

    #[test]
    fn accept_language_is_german_for_de_otherwise_english() {
        let cases = [
            ("de-DE,de;q=0.9,en;q=0.8", Some(Language::German)),
            ("de", Some(Language::German)),
            ("DE-at", Some(Language::German)),
            ("de_CH", Some(Language::German)),
            ("en-US,en;q=0.9,de;q=0.8", Some(Language::English)),
            ("fr-FR, de;q=0.5", Some(Language::English)),
            // The highest weight wins, the first of equal ones.
            ("en;q=0.5, de;q=0.9", Some(Language::German)),
            ("fr, de", Some(Language::English)),
            ("en;q=0, de;q=0.1", Some(Language::German)),
            ("dk", Some(Language::English)),
            ("*", None),
            ("de;q=0", None),
            ("de;q=abc", None),
            ("", None),
        ];
        for (header, expected) in cases {
            assert_eq!(
                Language::from_accept_language(header),
                expected,
                "{header:?}"
            );
        }
    }

    #[test]
    fn accents_are_names_or_hex_colors_stored_as_rrggbb() {
        let base = Settings::default();
        for (input, stored) in [
            ("sky", "sky"),
            ("#f5a06e", "#f5a06e"),
            ("f5a06e", "#f5a06e"),
            ("#F5A06E", "#f5a06e"),
            ("F5a06E", "#f5a06e"),
            ("#abc", "#aabbcc"),
            ("ABC", "#aabbcc"),
            ("#000", "#000000"),
        ] {
            let next = base.apply(&changes(json!({ "accent": input }))).unwrap();
            assert_eq!(
                serde_json::to_value(&next).unwrap()["accent"],
                json!(stored),
                "{input}"
            );
        }
        assert_eq!(
            Accent::hex("#336699"),
            Some(Accent::Custom([0x33, 0x66, 0x99]))
        );
        for bad in [
            "",
            "#",
            "#ab",
            "#abcd",
            "#abcde",
            "#abcdefa",
            "#ggg",
            "##abc",
            "Sky",
            "chartreuse",
            " #abc",
            "#ab c",
            "+abc",
            "#ａｂｃ",
        ] {
            let problems = rejected(base.apply(&changes(json!({ "accent": bad }))));
            assert_eq!(problems, [("accent".to_owned(), "invalid")], "{bad:?}");
        }
        let problems = rejected(base.apply(&changes(json!({ "accent": 336_699 }))));
        assert_eq!(problems, [("accent".to_owned(), "invalid")]);
    }

    #[test]
    fn old_documents_keep_their_language_and_accent() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        user_settings::save(&conn, &max, r#"{"lang":"de","accent":"rose"}"#, 0).unwrap();
        let stored = load(&conn, &max).unwrap();
        assert!(!stored.rewrite);
        assert_eq!(stored.settings.lang, Language::German);
        assert_eq!(stored.settings.accent, Some(Accent::Rose));
        assert_eq!(stored.lang, Language::German);
    }

    #[test]
    fn system_language_follows_the_last_sign_in() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let next = Settings::default()
            .apply(&changes(json!({ "lang": "system", "accent": "#336699" })))
            .unwrap();
        save(&conn, &max, 0, &next).unwrap();
        let stored = load(&conn, &max).unwrap();
        assert_eq!(stored.settings.lang, Language::System);
        assert_eq!(
            stored.settings.accent,
            Some(Accent::Custom([0x33, 0x66, 0x99]))
        );
        // Never signed in with a language: English.
        assert_eq!(stored.lang, Language::English);
        assert_eq!(lang_of(&conn, &max).unwrap(), Language::English);

        let german = Client {
            lang: Some(Language::German),
            ..Client::default()
        };
        session::start(&conn, &max, &german, true).unwrap();
        assert_eq!(lang_of(&conn, &max).unwrap(), Language::German);
        assert_eq!(format_of(&conn, &max).unwrap().lang(), Language::German);
        // A sign-in without a language keeps the last one.
        session::start(&conn, &max, &Client::default(), true).unwrap();
        assert_eq!(lang_of(&conn, &max).unwrap(), Language::German);
        let english = Client {
            lang: Some(Language::English),
            ..Client::default()
        };
        session::start(&conn, &max, &english, true).unwrap();
        assert_eq!(lang_of(&conn, &max).unwrap(), Language::English);

        // A chosen language wins over the sign-in language.
        session::start(&conn, &max, &german, true).unwrap();
        let fixed = next.apply(&changes(json!({ "lang": "en" }))).unwrap();
        save(&conn, &max, 1, &fixed).unwrap();
        assert_eq!(lang_of(&conn, &max).unwrap(), Language::English);
    }

    #[test]
    fn defaults_like_the_web_app() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        // The web app's defaults for "Reset settings".
        let reset0 = json!({
            "mode": null, "accent": null, "greet": null, "fontSize": "medium",
            "density": "normal", "animations": true, "pfDesign": "soft", "lang": "en",
            "region": "GB", "tzAuto": true, "dateFmt": "de",
            "timeFmt": "24h", "weekStart": "monday", "numFmt": "1,234.56",
            "gStart": "inbox", "gConfirm": true, "gUndo": "5 s", "gKeys": true,
            "swL": "move", "swR": "del",
            "nCh": { "app": true, "mail": true, "push": false },
            "nMx": {
                "security": { "app": true, "mail": true, "push": true },
                "account": { "app": true, "mail": true, "push": false },
                "team": { "app": true, "mail": false, "push": false },
                "system": { "app": true, "mail": false, "push": false },
                "news": { "app": true, "mail": false, "push": false },
            },
            "nQuiet": false, "nFrom": "22:00", "nTo": "07:00", "nDigest": "daily",
            "nSound": true, "devDebug": false, "devLevel": "info",
            "devOffline": false,
        });
        for (field, expected) in reset0.as_object().unwrap() {
            assert_eq!(&value[field], expected, "{field}");
        }
        // Plus the fields without a reset.
        let extra = json!({
            "tz": "Europe/Berlin", "extMode": "ask", "extAllow": [],
            "defaultAccount": null, "bannerDismissedRev": null, "advanced": false,
        });
        for (field, expected) in extra.as_object().unwrap() {
            assert_eq!(&value[field], expected, "{field}");
        }
        assert_eq!(
            value.as_object().unwrap().len(),
            reset0.as_object().unwrap().len() + extra.as_object().unwrap().len()
        );
    }

    #[test]
    fn apply_takes_valid_fields_and_keeps_the_rest() {
        let base = Settings::default();
        let next = base
            .apply(&changes(json!({
                "mode": "light",
                "fontSize": "large",
                "tz": "America/New_York",
                "timeFmt": "12h",
                "nFrom": "23:30",
                "numFmt": "1\u{a0}234,56",
                "defaultAccount": "all",
                "bannerDismissedRev": 3,
                "lang": "de",
            })))
            .unwrap();
        assert_eq!(next.mode, Some(ColorScheme::Light));
        assert_eq!(next.lang, Language::German);
        assert_eq!(next.font_size, FontSize::Large);
        assert_eq!(next.tz.as_str(), "America/New_York");
        assert_eq!(next.n_from, Clock("23:30".into()));
        assert_eq!(next.num_fmt, NumberFormat::Space);
        assert_eq!(next.banner_dismissed_rev, Some(3));
        assert_eq!(next.density, base.density);
        // `null` resets to "no choice".
        let back = next
            .apply(&changes(json!({ "mode": null, "defaultAccount": null })))
            .unwrap();
        assert_eq!(back.mode, None);
        assert_eq!(back.default_account, None);
        let id = "01JBZ6V9W8X7Y6Z5A4B3C2D1E0";
        let picked = next
            .apply(&changes(json!({ "defaultAccount": id })))
            .unwrap();
        assert_eq!(picked.default_account, Some(DefaultAccount(id.into())));
    }

    #[test]
    fn apply_rejects_unknown_fields_and_foreign_values() {
        let base = Settings::default();
        let problems = rejected(base.apply(&changes(json!({
            "mode": "Pink",
            "fontSize": "medium",
            "lang": "fr",
            "animations": "yes",
            "tz": "Mars/Olympus",
            "nFrom": "24:00",
            "nTo": "7:00",
            "swL": "archive",
            "defaultAccount": "m1",
            "bannerDismissedRev": -1,
            "nCh": { "app": "yes", "fax": true },
            "nMx": { "calendar": { "app": true }, "team": 1 },
            "loadSim": true,
        }))));
        let mut fields: Vec<(&str, &str)> =
            problems.iter().map(|(f, c)| (f.as_str(), *c)).collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                ("animations", "invalid"),
                ("bannerDismissedRev", "invalid"),
                ("defaultAccount", "invalid"),
                ("lang", "invalid"),
                ("loadSim", "unknown"),
                ("mode", "invalid"),
                ("nCh.app", "invalid"),
                ("nCh.fax", "unknown"),
                ("nFrom", "invalid"),
                ("nMx.calendar", "unknown"),
                ("nMx.team", "invalid"),
                ("nTo", "invalid"),
                ("swL", "invalid"),
                ("tz", "invalid"),
            ]
        );
    }

    #[test]
    fn senders_are_addresses_once_and_lowercase() {
        let base = Settings::default();
        let next = base
            .apply(&changes(json!({
                "extAllow": ["Hello@Example.ORG", "hello@example.org", " news@example.com "],
            })))
            .unwrap();
        assert_eq!(
            next.ext_allow,
            Senders(vec!["hello@example.org".into(), "news@example.com".into()])
        );
        // Also senders that would not work as an account.
        let local = base
            .apply(&changes(json!({
                "extAllow": ["root@localhost", "\"Max Mustermann\"@example.com"],
            })))
            .unwrap();
        assert_eq!(
            local.ext_allow,
            Senders(vec![
                "root@localhost".into(),
                "\"max mustermann\"@example.com".into()
            ])
        );
        for bad in ["no-sender", "@example.com", "max@", "max@exam\nple.com"] {
            let problems = rejected(base.apply(&changes(json!({ "extAllow": [bad] }))));
            assert_eq!(problems, [("extAllow".to_owned(), "invalid")], "{bad:?}");
        }
        let many: Vec<String> = (0..=MAX_SENDERS).map(|i| format!("a{i}@b.de")).collect();
        let problems = rejected(base.apply(&changes(json!({ "extAllow": many }))));
        assert_eq!(problems, [("extAllow".to_owned(), "invalid")]);
    }

    #[test]
    fn channels_change_part_by_part() {
        let base = Settings::default()
            .apply(&changes(json!({ "nMx": { "account": { "mail": false } } })))
            .unwrap();
        // Only one part of `nMx`: the other topics stay as they were, including
        // the one just changed.
        let next = base
            .apply(&changes(
                json!({ "nMx": { "team": { "mail": true } }, "nCh": { "push": true } }),
            ))
            .unwrap();
        assert_eq!(next.n_mx.account, channels(true, false, false));
        assert_eq!(next.n_mx.team, channels(true, true, false));
        assert_eq!(next.n_ch, channels(true, true, true));
    }

    #[test]
    fn zones_and_accounts_are_stored_canonically() {
        let next = Settings::default()
            .apply(&changes(json!({
                "tz": "europe/berlin",
                "defaultAccount": "01jbz6v9w8x7y6z5a4b3c2d1e0",
            })))
            .unwrap();
        assert_eq!(next.tz.as_str(), "Europe/Berlin");
        assert_eq!(
            next.default_account,
            Some(DefaultAccount("01JBZ6V9W8X7Y6Z5A4B3C2D1E0".into()))
        );
        // `Etc/Unknown` is not an IANA name, `Intl` does not know it.
        for bad in ["Etc/Unknown", "etc/unknown", ""] {
            let problems = rejected(Settings::default().apply(&changes(json!({ "tz": bad }))));
            assert_eq!(problems, [("tz".to_owned(), "invalid")], "{bad:?}");
        }
        assert!(Zone::try_from("UTC".to_owned()).is_ok());
    }

    #[test]
    fn security_stays_on_in_the_document() {
        let next = Settings::default()
            .apply(&changes(json!({
                "nMx": {
                    "security": { "app": false, "mail": false, "push": false },
                    "account": { "app": false, "mail": false, "push": false },
                    "team": { "app": true, "mail": true, "push": false },
                    "system": { "app": true, "mail": false, "push": false },
                    "news": { "app": true, "mail": false, "push": false },
                },
            })))
            .unwrap();
        assert_eq!(next.n_mx.security, channels(true, true, false));
        assert_eq!(next.n_mx.account, channels(false, false, false));
        assert!(next.n_mx.team.mail);
    }

    #[test]
    fn clock_accepts_times_of_day_only() {
        for good in ["00:00", "07:00", "23:59", "12:30"] {
            assert!(Clock::try_from(good.to_owned()).is_ok(), "{good}");
        }
        for bad in ["24:00", "7:00", "07:60", "07-00", "07:000", "", "aa:bb"] {
            assert!(Clock::try_from(bad.to_owned()).is_err(), "{bad}");
        }
    }

    #[test]
    fn load_and_save_with_version() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let first = load(&conn, &max).unwrap();
        assert_eq!(first.version, 0);
        assert_eq!(first.settings, Settings::default());

        let next = first
            .settings
            .apply(&changes(json!({ "dateFmt": "iso", "tz": "Asia/Tokyo" })))
            .unwrap();
        assert_eq!(save(&conn, &max, 0, &next).unwrap(), Some(1));
        assert_eq!(save(&conn, &max, 0, &next).unwrap(), None);
        let stored = load(&conn, &max).unwrap();
        assert_eq!(stored.version, 1);
        assert_eq!(stored.settings, next);
        assert!(!stored.rewrite);

        // Time zone and formats for mails: 13:57 UTC is 22:57 in Tokyo.
        let format = format_of(&conn, &max).unwrap();
        let at: Timestamp = "2026-10-24T13:57:00Z".parse().unwrap();
        assert_eq!(format.date(at), "2026-10-24");
        assert_eq!(format.time(at), "22:57");
    }

    #[test]
    fn load_skips_what_this_version_does_not_know() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        user_settings::save(
            &conn,
            &max,
            r#"{"density":"compact","fontSize":"huge","later":1}"#,
            0,
        )
        .unwrap();
        let stored = load(&conn, &max).unwrap();
        assert_eq!(stored.version, 1);
        assert_eq!(stored.settings.density, Density::Compact);
        assert_eq!(stored.settings.font_size, FontSize::Medium);
        assert!(stored.rewrite);
    }

    #[test]
    fn load_keeps_known_parts_of_channels_and_senders() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        // One topic is missing (added later), one is unknown (after a
        // downgrade), a channel too; one sender no longer fits.
        let doc = json!({
            "nMx": {
                "account": { "app": false, "mail": false, "push": false },
                "team": { "app": false, "mail": true, "push": false, "sms": true },
                "calendar": { "app": true, "mail": true, "push": true },
            },
            "extAllow": ["a@b.example", "broken", "c@d.example"],
            "gKeys": false,
        });
        user_settings::save(&conn, &max, &doc.to_string(), 0).unwrap();
        let stored = load(&conn, &max).unwrap();
        assert!(stored.rewrite);
        let settings = stored.settings;
        assert_eq!(settings.n_mx.account, channels(false, false, false));
        assert_eq!(settings.n_mx.team, channels(false, true, false));
        assert_eq!(settings.n_mx.news, Settings::default().n_mx.news);
        assert_eq!(
            settings.ext_allow,
            Senders(vec!["a@b.example".into(), "c@d.example".into()])
        );
        assert!(!settings.g_keys);
    }

    #[test]
    fn load_survives_a_document_that_is_no_object() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        for doc in ["[]", "null", "\"light\""] {
            conn.execute("DELETE FROM user_settings", []).unwrap();
            user_settings::save(&conn, &max, doc, 0).unwrap();
            let stored = load(&conn, &max).unwrap();
            assert_eq!(stored.version, 1, "{doc}");
            assert_eq!(stored.settings, Settings::default(), "{doc}");
            assert!(stored.rewrite, "{doc}");
            // Channels and mails keep working.
            assert!(format_of(&conn, &max).is_ok());
        }
    }
}
