//! Details in mails – dates, times, intervals, names, sizes – in the
//! recipient's time zone and formats (`tz`, `dateFmt`, `timeFmt`) from their
//! settings (`crate::settings`), with the words of their language (month
//! names, "Today") from the locale files. For recipients without an account
//! (invitations) the default formats apply in the inviter's language.

use std::net::IpAddr;

use jiff::{Timestamp, tz::TimeZone};
use serde::{Deserialize, Serialize};

use crate::{
    i18n::{plural, t, tf},
    settings::Language,
};

/// Default time zone (`tz`).
pub const DEFAULT_TZ: &str = "Europe/Berlin";
/// Date format (`dateFmt`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateFormat {
    /// `de`: spelled out with the month name, "30 October 2026".
    #[default]
    #[serde(rename = "de")]
    De,
    /// `iso`: "2026-10-30".
    #[serde(rename = "iso")]
    Iso,
    /// `us`: "10/30/2026".
    #[serde(rename = "us")]
    Us,
}

/// Time format (`timeFmt`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeFormat {
    /// `24h`: "15:57", with the suffix of the language if it has one.
    #[default]
    #[serde(rename = "24h")]
    H24,
    /// `12h`: "3:57 PM" in every language.
    #[serde(rename = "12h")]
    H12,
}

/// Time zone, formats and language of a recipient.
#[derive(Debug, Clone)]
pub struct Format {
    tz: TimeZone,
    date: DateFormat,
    time: TimeFormat,
    lang: Language,
}

impl Default for Format {
    fn default() -> Self {
        Self {
            tz: zone(DEFAULT_TZ),
            date: DateFormat::default(),
            time: TimeFormat::default(),
            lang: Language::default(),
        }
    }
}

impl Format {
    /// Time zone as IANA name (unknown → default), formats and
    /// language.
    pub fn new(tz: &str, date: DateFormat, time: TimeFormat, lang: Language) -> Self {
        let tz = named_zone(tz);
        Self {
            tz,
            date,
            time,
            lang,
        }
    }

    /// The same formats in `lang`: for recipients without settings
    /// (invitations) and the template preview.
    #[must_use]
    pub fn with_lang(self, lang: Language) -> Self {
        Self { lang, ..self }
    }

    /// Language of the recipient (templates, subjects, texts).
    pub fn lang(&self) -> Language {
        self.lang
    }

    /// Time zone of the recipient (also for quiet hours and digest).
    pub fn zone(&self) -> &TimeZone {
        &self.tz
    }

    /// Date, e.g. "30 October 2026".
    pub fn date(&self, at: Timestamp) -> String {
        let at = at.to_zoned(self.tz.clone());
        let (year, month, day) = (at.year(), at.month(), at.day());
        match self.date {
            DateFormat::De => tf(
                self.lang,
                "format.date",
                &[
                    ("day", &day),
                    ("month", &t(self.lang, &format!("format.month.{month}"))),
                    ("year", &year),
                ],
            ),
            DateFormat::Iso => format!("{year:04}-{month:02}-{day:02}"),
            DateFormat::Us => format!("{month:02}/{day:02}/{year:04}"),
        }
    }

    /// Time, e.g. "15:57" or "3:57 PM".
    pub fn time(&self, at: Timestamp) -> String {
        let at = at.to_zoned(self.tz.clone());
        let (hour, minute) = (at.hour(), at.minute());
        match self.time {
            TimeFormat::H24 => tf(
                self.lang,
                "format.time_24h",
                &[("time", &format!("{hour:02}:{minute:02}"))],
            ),
            TimeFormat::H12 => {
                let suffix = if hour < 12 { "AM" } else { "PM" };
                let hour = match hour % 12 {
                    0 => 12,
                    hour => hour,
                };
                format!("{hour}:{minute:02} {suffix}")
            }
        }
    }

    /// Point in time: "Today, 15:57", on another day "23 October 2026,
    /// 14:28" (day in the recipient's time zone, compared with `now`).
    pub fn when(&self, at: Timestamp, now: Timestamp) -> String {
        let today = at.to_zoned(self.tz.clone()).date() == now.to_zoned(self.tz.clone()).date();
        let day = if today {
            t(self.lang, "format.today").to_owned()
        } else {
            self.date(at)
        };
        format!("{day}, {}", self.time(at))
    }
}

/// Interval as in the bell: "just now", "5 minutes ago", "1 hour ago", from
/// 48 hours "8 days ago".
pub fn ago(at: Timestamp, now: Timestamp, lang: Language) -> String {
    let minutes = (now.as_millisecond() - at.as_millisecond()).div_euclid(60_000);
    let hours = minutes.div_euclid(60);
    let days = hours.div_euclid(24);
    let count = |key, n: i64| plural(lang, key, u64::try_from(n).unwrap_or(0), &[]);
    if minutes < 1 {
        t(lang, "format.ago.now").to_owned()
    } else if minutes < 60 {
        count("format.ago.minutes", minutes)
    } else if hours < 48 {
        count("format.ago.hours", hours)
    } else {
        count("format.ago.days", days)
    }
}

/// Time zone as IANA name; unknown ones get the default.
pub fn named_zone(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap_or_else(|_| zone(DEFAULT_TZ))
}

fn zone(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap_or(TimeZone::UTC)
}

/// Display name in reading order: "Mustermann, Max" becomes "Max Mustermann".
pub fn full_name(name: &str) -> String {
    match name.split_once(',') {
        Some((last, rest)) => {
            // Only the part up to the next comma.
            let first = rest.split(',').next().unwrap_or_default();
            format!("{} {}", first.trim(), last.trim())
                .trim()
                .to_owned()
        }
        None => name.trim().to_owned(),
    }
}

/// First name for the greeting ("Hi Max,").
pub fn first_name(name: &str) -> Option<String> {
    full_name(name).split_whitespace().next().map(str::to_owned)
}

/// Truncated IP address ("198.51.x.x"); IPv6 with the first two groups.
pub fn short_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            format!("{a}.{b}.x.x")
        }
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => short_ip(IpAddr::V4(ip)),
            None => {
                let [a, b, ..] = ip.segments();
                format!("{a:x}:{b:x}:x:x:x:x:x:x")
            }
        },
    }
}

/// Size as the web app shows it: KB whole, MB with one decimal, GB with one
/// decimal without ".0". Rounded half up like JavaScript's `toFixed`,
/// computed in integers; with the decimal mark of the language ("1.2 GB").
pub fn size(bytes: u64, lang: Language) -> String {
    let point = t(lang, "format.decimal_mark");
    const KB: u128 = 1 << 10;
    const MB: u128 = 1 << 20;
    const GB: u128 = 1 << 30;
    let bytes = u128::from(bytes);
    let tenths = |unit: u128| (bytes * 10 + unit / 2) / unit;
    if bytes >= GB {
        let t = tenths(GB);
        if t % 10 == 0 {
            format!("{} GB", t / 10)
        } else {
            format!("{}{point}{} GB", t / 10, t % 10)
        }
    } else if bytes < MB {
        format!("{} KB", ((bytes + KB / 2) / KB).max(1))
    } else {
        let t = tenths(MB);
        format!("{}{point}{} MB", t / 10, t % 10)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn dates_in_the_recipients_zone() {
        let format = Format::default();
        // 30.10. 23:30 UTC is already the 31st in Berlin.
        assert_eq!(format.date(at("2026-10-30T23:30:00Z")), "31 October 2026");
        assert_eq!(format.date(at("2026-03-01T12:00:00Z")), "1 March 2026");
        let iso = Format::new(
            "America/New_York",
            DateFormat::Iso,
            TimeFormat::H24,
            Language::English,
        );
        assert_eq!(iso.date(at("2026-10-31T02:00:00Z")), "2026-10-30");
        let us = Format::new(
            DEFAULT_TZ,
            DateFormat::Us,
            TimeFormat::H24,
            Language::English,
        );
        assert_eq!(us.date(at("2026-01-05T12:00:00Z")), "01/05/2026");
    }

    #[test]
    fn times_follow_daylight_saving_and_clock() {
        let format = Format::default();
        // Daylight saving time until 25.10.2026, CET afterwards.
        assert_eq!(format.time(at("2026-10-24T13:57:00Z")), "15:57");
        assert_eq!(format.time(at("2026-10-26T13:57:00Z")), "14:57");
        let h12 = Format::new(
            "Europe/Berlin",
            DateFormat::De,
            TimeFormat::H12,
            Language::English,
        );
        assert_eq!(h12.time(at("2026-10-24T13:57:00Z")), "3:57 PM");
        assert_eq!(h12.time(at("2026-10-23T22:05:00Z")), "12:05 AM");
        assert_eq!(h12.time(at("2026-10-24T10:00:00Z")), "12:00 PM");
    }

    #[test]
    fn today_or_date() {
        let format = Format::default();
        let now = at("2026-10-24T20:00:00Z");
        assert_eq!(format.when(at("2026-10-24T13:57:00Z"), now), "Today, 15:57");
        assert_eq!(
            format.when(at("2026-10-23T12:28:00Z"), now),
            "23 October 2026, 14:28"
        );
        // 22:30 UTC is already the next day in Berlin.
        assert_eq!(
            format.when(at("2026-10-24T22:30:00Z"), now),
            "25 October 2026, 00:30"
        );
    }

    #[test]
    fn unknown_zone_falls_back() {
        let format = Format::new(
            "Mars/Olympus",
            DateFormat::De,
            TimeFormat::H24,
            Language::English,
        );
        assert_eq!(format.date(at("2026-10-24T13:57:00Z")), "24 October 2026");
        assert_eq!(format.time(at("2026-10-24T13:57:00Z")), "15:57");
    }

    #[test]
    fn format_names() {
        assert_eq!(serde_json::to_value(DateFormat::Iso).unwrap(), "iso");
        assert_eq!(
            serde_json::from_value::<TimeFormat>("12h".into()).unwrap(),
            TimeFormat::H12
        );
        assert!(serde_json::from_value::<TimeFormat>("13h".into()).is_err());
    }

    #[test]
    fn names_in_reading_order() {
        assert_eq!(full_name("Mustermann, Max"), "Max Mustermann");
        assert_eq!(full_name(" Max Mustermann "), "Max Mustermann");
        assert_eq!(first_name("Mustermann, Max"), Some("Max".into()));
        assert_eq!(first_name("Jonas Schulz"), Some("Jonas".into()));
        assert_eq!(first_name("  "), None);
        assert_eq!(full_name("Mustermann,"), "Mustermann");
    }

    #[test]
    fn shortened_ips() {
        assert_eq!(short_ip("198.51.100.56".parse().unwrap()), "198.51.x.x");
        assert_eq!(
            short_ip("2001:db8::1".parse().unwrap()),
            "2001:db8:x:x:x:x:x:x"
        );
        assert_eq!(short_ip("::ffff:203.0.113.2".parse().unwrap()), "203.0.x.x");
    }

    #[test]
    fn ago_in_words() {
        let now = at("2026-10-24T16:00:00Z");
        let ago_at = |when: &str| ago(at(when), now, Language::English);
        assert_eq!(ago_at("2026-10-24T15:59:00.001Z"), "just now");
        assert_eq!(ago_at("2026-10-24T15:59:00Z"), "1 minute ago");
        assert_eq!(ago_at("2026-10-24T15:01:00Z"), "59 minutes ago");
        assert_eq!(ago_at("2026-10-24T15:00:00Z"), "1 hour ago");
        assert_eq!(ago_at("2026-10-24T11:00:00Z"), "5 hours ago");
        assert_eq!(ago_at("2026-10-22T16:00:01Z"), "47 hours ago");
        assert_eq!(ago_at("2026-10-22T16:00:00Z"), "2 days ago");
        assert_eq!(ago_at("2026-10-16T16:00:00Z"), "8 days ago");
    }

    #[test]
    fn english_is_the_default() {
        assert_eq!(Format::default().lang(), Language::English);
    }

    /// German uses the same digits with its own words and decimal mark.
    #[test]
    fn german_words_with_the_same_digits() {
        let de = Language::German;
        let format = Format::default().with_lang(de);
        let now = at("2026-10-24T20:00:00Z");
        let october = t(de, "format.month.10");
        assert_ne!(october, t(Language::English, "format.month.10"));
        assert_eq!(
            format.date(at("2026-10-23T12:28:00Z")),
            tf(
                de,
                "format.date",
                &[("day", &23), ("month", &october), ("year", &2026)]
            )
        );
        let time = tf(de, "format.time_24h", &[("time", &"15:57")]);
        assert_ne!(time, "15:57");
        assert_eq!(format.time(at("2026-10-24T13:57:00Z")), time);
        assert_eq!(
            format.when(at("2026-10-24T13:57:00Z"), now),
            format!("{}, {time}", t(de, "format.today"))
        );
        assert_eq!(
            ago(at("2026-10-24T15:00:00Z"), now, de),
            plural(de, "format.ago.hours", 5, &[])
        );
        let mark = t(de, "format.decimal_mark");
        assert_ne!(mark, ".");
        assert_eq!(size(1_342_177_280, de), format!("1{mark}3 GB"));
    }

    #[test]
    fn sizes_with_the_decimal_mark_of_the_language() {
        assert_eq!(size(1_342_177_280, Language::English), "1.3 GB");
        assert_eq!(size(1_048_576, Language::English), "1.0 MB");
        assert_eq!(size(2_147_483_648, Language::English), "2 GB");
        assert_eq!(size(1536, Language::English), "2 KB");
        assert_eq!(size(0, Language::English), "1 KB");
        assert_eq!(size(1_073_741_823, Language::English), "1024.0 MB");
        // Half rounds up: 1.25 GB → 1.3 GB.
        assert_eq!(size(1_342_177_280, Language::English), "1.3 GB");
    }
}
