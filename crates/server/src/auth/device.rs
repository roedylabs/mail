//! Device detection: browser, operating system and kind of device from the
//! user agent, using the same rules as the web app for the current device,
//! extended by the browsers on iOS and ChromeOS. From that come the name
//! shown in the session list and in security notices ("Firefox on Linux")
//! and, with the client IP's network, the ID of known devices
//! ([`Device::hash`]).

use std::net::IpAddr;

use crate::{broker::crypto::SecretKey, i18n, settings::Language};

/// Kind of device for the icon (`ti-device-desktop`, `-mobile`, `-tablet`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceType {
    Desktop,
    Mobile,
    Tablet,
}

impl DeviceType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
            Self::Tablet => "tablet",
        }
    }
}

/// What the user agent reveals about the device; versions do not count, so
/// that a browser update is not a new device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Device {
    pub browser: Option<&'static str>,
    pub os: Option<&'static str>,
    pub kind: DeviceType,
}

/// First match wins: Edge and Chrome also say "Safari", Edge also
/// "Chrome". On iOS the browsers have other names (all with "Safari/").
const BROWSERS: &[(&[&str], &str)] = &[
    (&["Edg/", "EdgA/", "EdgiOS/"], "Edge"),
    (&["Firefox/", "FxiOS/"], "Firefox"),
    (&["Chrome/", "CriOS/", "Chromium/"], "Chrome"),
    (&["Safari/"], "Safari"),
];

/// iPhone and iPad say "like Mac OS X", Android says "Linux".
const SYSTEMS: &[(&str, &str)] = &[
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("CrOS", "ChromeOS"),
    ("Mac", "macOS"),
    ("Windows", "Windows"),
    ("Linux", "Linux"),
];

/// Device name from browser and operating system in the reader's language:
/// also for the texts of notifications, whose details carry only the names.
pub fn label(browser: Option<&str>, os: Option<&str>, lang: Language) -> String {
    match (browser, os) {
        (Some(browser), Some(os)) => {
            i18n::tf(lang, "device.label", &[("browser", &browser), ("os", &os)])
        }
        (Some(browser), None) => browser.to_owned(),
        (None, Some(os)) => i18n::tf(lang, "device.browser_on", &[("os", &os)]),
        (None, None) => i18n::t(lang, "device.unknown").to_owned(),
    }
}

impl Device {
    pub fn parse(user_agent: Option<&str>) -> Self {
        let ua = user_agent.unwrap_or_default();
        let browser = BROWSERS
            .iter()
            .find(|(tokens, _)| tokens.iter().any(|token| ua.contains(token)))
            .map(|(_, name)| *name);
        let os = SYSTEMS
            .iter()
            .find(|(token, _)| ua.contains(token))
            .map(|(_, name)| *name);
        let kind = match os {
            Some("iPhone") => DeviceType::Mobile,
            Some("iPad") => DeviceType::Tablet,
            // Android tablets omit "Mobile".
            Some("Android") if ua.contains("Mobile") => DeviceType::Mobile,
            Some("Android") => DeviceType::Tablet,
            _ => DeviceType::Desktop,
        };
        Self { browser, os, kind }
    }

    /// Name such as "Firefox on Linux"; if one detail is missing, only the
    /// other or "Unknown device".
    pub fn label(&self, lang: Language) -> String {
        label(self.browser, self.os, lang)
    }

    /// ID for `known_devices`: HMAC over browser, operating system, kind
    /// and the client IP's network (IPv4 /24, IPv6 /48) with the instance's
    /// key – the same device in the same network is known, another device
    /// or network is not. Without a key the networks could be
    /// recovered from a copy of the database (there are only 2²⁴ IPv4 networks).
    pub fn hash(&self, secrets: &SecretKey, ip: IpAddr) -> [u8; 32] {
        secrets.mac(
            HASH_PURPOSE,
            &[
                self.browser.unwrap_or_default().as_bytes(),
                self.os.unwrap_or_default().as_bytes(),
                self.kind.as_str().as_bytes(),
                network(ip).as_bytes(),
            ],
        )
    }
}

/// Purpose of the HMAC (`broker::crypto::SecretKey::mac`).
const HASH_PURPOSE: &str = "known_devices.device_hash";

/// Network of an address as text, e.g. "203.0.113.0/24".
fn network(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            format!("{a}.{b}.{c}.0/24")
        }
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => network(IpAddr::V4(ip)),
            None => {
                let [a, b, c, ..] = ip.segments();
                format!("{a:x}:{b:x}:{c:x}::/48")
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(ua: &str) -> (String, DeviceType) {
        let device = Device::parse(Some(ua));
        (device.label(Language::English), device.kind)
    }

    #[test]
    fn common_browsers() {
        use DeviceType::*;
        for (ua, label, kind) in [
            (
                "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
                "Firefox on Linux",
                Desktop,
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/141.0.0.0 Safari/537.36",
                "Chrome on Windows",
                Desktop,
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
                "Edge on Windows",
                Desktop,
            ),
            (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
                "Safari on macOS",
                Desktop,
            ),
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
                "Safari on iPhone",
                Mobile,
            ),
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
                "Chrome on iPhone",
                Mobile,
            ),
            (
                "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
                "Firefox on iPad",
                Tablet,
            ),
            (
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
                "Chrome on Android",
                Mobile,
            ),
            (
                "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
                "Chrome on Android",
                Tablet,
            ),
            (
                "Mozilla/5.0 (X11; CrOS x86_64 16328.55.0) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
                "Chrome on ChromeOS",
                Desktop,
            ),
        ] {
            assert_eq!(named(ua), (label.to_owned(), kind), "{ua}");
        }
    }

    #[test]
    fn unknown_parts() {
        assert_eq!(named("curl/8.10.1").0, "Unknown device");
        assert_eq!(
            named("Mozilla/5.0 (Windows NT 10.0)").0,
            "Browser on Windows"
        );
        assert_eq!(named("Mozilla/5.0 Firefox/140.0").0, "Firefox");
        assert_eq!(
            Device::parse(None).label(Language::English),
            "Unknown device"
        );
    }

    #[test]
    fn labels_follow_the_language() {
        let de = Language::German;
        let firefox = Device::parse(Some(
            "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        ));
        let german = firefox.label(de);
        assert_eq!(
            german,
            i18n::tf(
                de,
                "device.label",
                &[("browser", &"Firefox"), ("os", &"Linux")]
            )
        );
        assert_ne!(german, firefox.label(Language::English));
        assert_eq!(
            label(None, Some("Windows"), de),
            i18n::tf(de, "device.browser_on", &[("os", &"Windows")])
        );
        assert_eq!(Device::parse(None).label(de), i18n::t(de, "device.unknown"));
    }

    #[test]
    fn hash_ignores_versions_and_host_part() {
        let key = SecretKey::random().unwrap();
        let ip = |s: &str| s.parse().unwrap();
        let old = Device::parse(Some("Mozilla/5.0 (X11; Linux x86_64) Firefox/139.0"));
        let new = Device::parse(Some("Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0"));
        let hash = |device: &Device, addr: &str| device.hash(&key, ip(addr));
        assert_eq!(hash(&old, "203.0.113.7"), hash(&new, "203.0.113.200"));
        assert_eq!(hash(&old, "::ffff:203.0.113.7"), hash(&old, "203.0.113.9"));
        assert_ne!(hash(&old, "203.0.113.7"), hash(&old, "203.0.114.7"));
        assert_eq!(
            hash(&old, "2001:db8:1:2::1"),
            hash(&old, "2001:db8:1:ffff::9")
        );
        assert_ne!(hash(&old, "2001:db8:1::1"), hash(&old, "2001:db8:2::1"));
        let chrome = Device::parse(Some("Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0"));
        assert_ne!(hash(&old, "203.0.113.7"), hash(&chrome, "203.0.113.7"));
        // A different key gives a different ID.
        let other = SecretKey::random().unwrap();
        assert_ne!(
            hash(&old, "203.0.113.7"),
            old.hash(&other, ip("203.0.113.7"))
        );
    }
}
