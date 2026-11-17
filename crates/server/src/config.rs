//! Configuration via `ROEDY_*` environment variables.
//!
//! Unknown `ROEDY_*` variables are ignored so that tools such as the Git hooks
//! (`ROEDY_PUSH_MAIN`) can use their own variables. Empty values count as unset
//! (e.g. `ROEDY_LOG=${ROEDY_LOG:-}` in Compose). Values are text, without
//! surrounding whitespace; each field parses what it needs.

use std::{collections::BTreeMap, net::SocketAddr, path::PathBuf};

use anyhow::anyhow;
use figment::{
    Figment,
    providers::{Env, Serialized},
};
use serde::{Deserialize, Deserializer, de::Error as _};
use url::Url;

/// Prefix of all environment variables.
pub const ENV_PREFIX: &str = "ROEDY_";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Address of the HTTP server (`ROEDY_LISTEN`).
    pub listen: SocketAddr,
    /// Directory for database and key (`ROEDY_DATA_DIR`).
    pub data_dir: PathBuf,
    /// Public address of the app (`ROEDY_PUBLIC_URL`). If set, it is fixed for
    /// the initial setup; otherwise the setup asks for it.
    #[serde(deserialize_with = "public_url")]
    pub public_url: Option<Url>,
    /// Log filter in the format of `tracing_subscriber::EnvFilter` (`ROEDY_LOG`).
    pub log: String,
    /// Log format (`ROEDY_LOG_FORMAT`).
    pub log_format: LogFormat,
    /// Directory with the web app build (`ROEDY_WEB_DIR`, e.g.
    /// `apps/web/build`). Takes precedence over the embedded web app.
    pub web_dir: Option<PathBuf>,
    /// Reverse proxies in front of the server (`ROEDY_TRUST_PROXY`): `false`,
    /// `true` (one proxy) or their number. Determines the client IP from
    /// `X-Forwarded-For`.
    #[serde(deserialize_with = "trust_proxy")]
    pub trust_proxy: TrustProxy,
    /// Key for secrets in the database (`ROEDY_SECRET_KEY`): 64 hex characters
    /// or Base64 for 32 bytes.
    pub secret_key: Option<Secret>,
    /// File with this key (`ROEDY_SECRET_KEY_FILE`, e.g. a Docker secret). If
    /// both are missing, `<ROEDY_DATA_DIR>/secret.key` applies.
    pub secret_key_file: Option<PathBuf>,
    /// GeoIP database in MaxMind DB format (`ROEDY_GEOIP_DB`, optional):
    /// location in sessions, audit log and security mails.
    pub geoip_db: Option<PathBuf>,
}

/// Value that never appears in `Debug` output or logs.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

/// How many reverse proxies append to `X-Forwarded-For`. With 0 only the
/// address of the TCP connection counts; otherwise the client is as many
/// entries before the end of the list as there are proxies in front.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrustProxy(pub u8);

impl TrustProxy {
    /// At most this many proxies; more would almost certainly be a typo.
    pub const MAX: u8 = 10;

    pub fn hops(self) -> usize {
        usize::from(self.0)
    }

    pub fn enabled(self) -> bool {
        self.0 > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    /// One JSON line per event (default, for container logs).
    Json,
    /// Readable text for development.
    Text,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([0, 0, 0, 0], 8080)),
            // Relative to the working directory; the image sets `ROEDY_DATA_DIR=/data`.
            data_dir: PathBuf::from("data"),
            public_url: None,
            log: "info".into(),
            log_format: LogFormat::Json,
            web_dir: None,
            trust_proxy: TrustProxy::default(),
            secret_key: None,
            secret_key_file: None,
            geoip_db: None,
        }
    }
}

impl Config {
    /// Reads the configuration from the environment.
    pub fn load() -> anyhow::Result<Self> {
        Self::from_vars(
            Env::prefixed(ENV_PREFIX)
                .iter()
                .map(|(key, value)| (key.to_string(), value)),
        )
    }

    /// Reads the configuration from variables named without the prefix
    /// (`secret_key` for `ROEDY_SECRET_KEY`).
    ///
    /// The values go to figment as strings on purpose: its `Env` provider
    /// parses each value as data, so a key made only of digits arrived as a
    /// number (without its leading zeros), `true` as a bool and `[a]` as an
    /// array, and text fields rejected them.
    fn from_vars(vars: impl IntoIterator<Item = (String, String)>) -> anyhow::Result<Self> {
        let vars: BTreeMap<String, String> = vars
            .into_iter()
            .filter_map(|(key, value)| {
                let value = value.trim();
                (!value.is_empty()).then(|| (key.to_ascii_lowercase(), value.to_owned()))
            })
            .collect();
        Self::from_figment(Figment::from(Serialized::defaults(vars)))
    }

    pub fn from_figment(figment: Figment) -> anyhow::Result<Self> {
        figment.extract().map_err(|errors| {
            // Report each error with the full variable name, e.g. `ROEDY_LISTEN: …`.
            let details: Vec<String> = errors
                .into_iter()
                .map(|e| match e.path.join("_").to_uppercase() {
                    key if key.is_empty() => e.kind.to_string(),
                    key => format!("{ENV_PREFIX}{key}: {}", e.kind),
                })
                .collect();
            anyhow!("Invalid configuration – {}", details.join("; "))
        })
    }
}

fn public_url<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Url>, D::Error> {
    let Some(raw) = Option::<String>::deserialize(deserializer)? else {
        return Ok(None);
    };
    let url =
        Url::parse(raw.trim()).map_err(|e| D::Error::custom(format!("not a valid URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(D::Error::custom("expects an http(s) address with a host"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(D::Error::custom("must contain neither query nor fragment"));
    }
    // Credentials have no place in links or in the log.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(D::Error::custom("must not contain credentials"));
    }
    Ok(Some(url))
}

fn trust_proxy<'de, D: Deserializer<'de>>(deserializer: D) -> Result<TrustProxy, D::Error> {
    // The environment delivers text; other figment providers may deliver
    // `true`/`2` as bool or number.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Bool(bool),
        Hops(u64),
        Text(String),
    }
    let hops = match Raw::deserialize(deserializer)? {
        Raw::Bool(on) => u64::from(on),
        Raw::Hops(hops) => hops,
        Raw::Text(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => 1,
            "false" | "no" | "off" => 0,
            other => other
                .parse()
                .map_err(|_| D::Error::custom("expects true, false or the number of proxies"))?,
        },
    };
    u8::try_from(hops)
        .ok()
        .filter(|&hops| hops <= TrustProxy::MAX)
        .map(TrustProxy)
        .ok_or_else(|| {
            D::Error::custom(format!(
                "at most {} proxies (expects true, false or a number)",
                TrustProxy::MAX
            ))
        })
}

#[cfg(test)]
#[allow(
    clippy::result_large_err,
    reason = "figment::Jail requires closures returning figment::Result"
)]
mod tests {
    use super::*;
    use figment::Jail;

    #[test]
    fn defaults_without_environment() {
        let config = Config::from_figment(Figment::new()).unwrap();
        assert_eq!(config, Config::default());
        assert_eq!(config.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(config.log_format, LogFormat::Json);
    }

    #[test]
    fn reads_prefixed_environment() {
        Jail::expect_with(|jail| {
            jail.set_env("ROEDY_LISTEN", "127.0.0.1:9000");
            jail.set_env("ROEDY_DATA_DIR", "/srv/roedy");
            jail.set_env("ROEDY_PUBLIC_URL", "https://mail.example.org/");
            jail.set_env("ROEDY_LOG", "debug,tower_http=trace");
            jail.set_env("ROEDY_LOG_FORMAT", "text");
            jail.set_env("ROEDY_WEB_DIR", "apps/web/build");
            jail.set_env("ROEDY_TRUST_PROXY", "true");
            jail.set_env("ROEDY_SECRET_KEY", "abc");
            jail.set_env("ROEDY_SECRET_KEY_FILE", "/run/secrets/roedy");
            jail.set_env("ROEDY_GEOIP_DB", "/geoip/GeoLite2-City.mmdb");
            jail.set_env("ROEDY_PUSH_MAIN", "1");

            let config = Config::load().unwrap();
            assert_eq!(config.listen.to_string(), "127.0.0.1:9000");
            assert_eq!(config.data_dir, PathBuf::from("/srv/roedy"));
            assert_eq!(
                config.public_url.as_ref().map(Url::as_str),
                Some("https://mail.example.org/")
            );
            assert_eq!(config.log, "debug,tower_http=trace");
            assert_eq!(config.log_format, LogFormat::Text);
            assert_eq!(config.web_dir, Some(PathBuf::from("apps/web/build")));
            assert_eq!(config.trust_proxy, TrustProxy(1));
            assert_eq!(config.secret_key, Some(Secret::new("abc")));
            assert_eq!(format!("{:?}", config.secret_key), "Some(Secret(…))");
            assert_eq!(
                config.secret_key_file,
                Some(PathBuf::from("/run/secrets/roedy"))
            );
            assert_eq!(
                config.geoip_db,
                Some(PathBuf::from("/geoip/GeoLite2-City.mmdb"))
            );
            Ok(())
        });
    }

    #[test]
    fn empty_values_are_unset() {
        Jail::expect_with(|jail| {
            for key in [
                "ROEDY_LISTEN",
                "ROEDY_DATA_DIR",
                "ROEDY_PUBLIC_URL",
                "ROEDY_LOG",
                "ROEDY_LOG_FORMAT",
                "ROEDY_WEB_DIR",
                "ROEDY_TRUST_PROXY",
                "ROEDY_SECRET_KEY",
                "ROEDY_SECRET_KEY_FILE",
                "ROEDY_GEOIP_DB",
            ] {
                jail.set_env(key, "  ");
            }
            assert_eq!(Config::load().unwrap(), Config::default());
            Ok(())
        });
    }

    #[test]
    fn secret_key_made_only_of_digits_is_text() {
        // Regression: the key arrived as the number 0 and was rejected.
        let digits = "0".repeat(64);
        Jail::expect_with(|jail| {
            jail.set_env("ROEDY_SECRET_KEY", &digits);
            let config = Config::load().unwrap();
            assert_eq!(config.secret_key, Some(Secret::new(digits.clone())));
            let (_, source) = crate::broker::crypto::SecretKey::load(&config).unwrap();
            assert_eq!(source, crate::broker::crypto::KeySource::Env);
            Ok(())
        });
    }

    /// Values that look like a number, a bool or structured data.
    const LOOKALIKES: [&str; 14] = [
        "0",
        "007",
        "42",
        "-1",
        "1.50",
        "1e3",
        "inf",
        "true",
        "false",
        "[a]",
        "[1, 2]",
        "{a=1}",
        "\"quoted\"",
        "a=b",
    ];

    #[test]
    fn text_settings_are_read_verbatim() {
        for value in LOOKALIKES {
            Jail::expect_with(|jail| {
                for key in [
                    "ROEDY_DATA_DIR",
                    "ROEDY_LOG",
                    "ROEDY_WEB_DIR",
                    "ROEDY_SECRET_KEY",
                    "ROEDY_GEOIP_DB",
                ] {
                    jail.set_env(key, value);
                }
                let config = Config::load().unwrap_or_else(|e| panic!("{value}: {e}"));
                assert_eq!(config.data_dir, PathBuf::from(value), "{value}");
                assert_eq!(config.log, value);
                assert_eq!(config.web_dir, Some(PathBuf::from(value)), "{value}");
                assert_eq!(config.secret_key, Some(Secret::new(value)), "{value}");
                assert_eq!(config.geoip_db, Some(PathBuf::from(value)), "{value}");
                Ok(())
            });
            // Separately: both key sources together are rejected later on.
            Jail::expect_with(|jail| {
                jail.set_env("ROEDY_SECRET_KEY_FILE", value);
                let config = Config::load().unwrap_or_else(|e| panic!("{value}: {e}"));
                assert_eq!(config.secret_key_file, Some(PathBuf::from(value)));
                Ok(())
            });
        }
    }

    /// Property: every text setting keeps any value as text, without the
    /// surrounding whitespace. Random values from a fixed seed (no property
    /// test crate in the workspace), weighted towards digits and the syntax of
    /// figment's value parser.
    #[test]
    fn text_settings_keep_any_value() {
        const CHARS: &[u8] = b"0123456789000000abcdefABCDEF+/=-_.,:[]{}\"' \txyz";
        let mut state: u64 = 0x5EED_0019;
        let mut next = |bound: usize| {
            // xorshift64
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            usize::try_from(state % bound as u64).unwrap()
        };
        for _ in 0..2_000 {
            let len = next(70);
            let raw: String = (0..len)
                .map(|_| char::from(CHARS[next(CHARS.len())]))
                .collect();
            let vars = ["data_dir", "log", "web_dir", "secret_key", "geoip_db"]
                .map(|key| (key.to_owned(), raw.clone()));
            let config = Config::from_vars(vars).unwrap_or_else(|e| panic!("{raw:?}: {e}"));
            let value = raw.trim();
            if value.is_empty() {
                assert_eq!(config, Config::default(), "{raw:?}");
                continue;
            }
            assert_eq!(config.data_dir, PathBuf::from(value), "{raw:?}");
            assert_eq!(config.log, value, "{raw:?}");
            assert_eq!(config.web_dir, Some(PathBuf::from(value)), "{raw:?}");
            assert_eq!(config.secret_key, Some(Secret::new(value)), "{raw:?}");
            assert_eq!(config.geoip_db, Some(PathBuf::from(value)), "{raw:?}");
        }
    }

    #[test]
    fn trust_proxy_accepts_bool_and_count() {
        for (value, hops) in [
            ("false", 0),
            ("true", 1),
            ("TRUE", 1),
            ("off", 0),
            ("0", 0),
            ("2", 2),
            ("10", 10),
        ] {
            Jail::expect_with(|jail| {
                jail.set_env("ROEDY_TRUST_PROXY", value);
                assert_eq!(
                    Config::load().unwrap().trust_proxy,
                    TrustProxy(hops),
                    "{value}"
                );
                Ok(())
            });
        }
    }

    #[test]
    fn rejects_invalid_values() {
        for (key, value) in [
            ("ROEDY_LISTEN", "localhost"),
            ("ROEDY_PUBLIC_URL", "mail.example.org"),
            ("ROEDY_PUBLIC_URL", "ftp://mail.example.org"),
            ("ROEDY_PUBLIC_URL", "https://mail.example.org/?a=1"),
            ("ROEDY_PUBLIC_URL", "https://admin:secret@mail.example.org"),
            ("ROEDY_LOG_FORMAT", "xml"),
            ("ROEDY_TRUST_PROXY", "maybe"),
            ("ROEDY_TRUST_PROXY", "11"),
            ("ROEDY_TRUST_PROXY", "-1"),
        ] {
            Jail::expect_with(|jail| {
                jail.set_env(key, value);
                let err = Config::load().unwrap_err().to_string();
                assert!(err.contains(&format!("{key}: ")), "{key}={value}: {err}");
                Ok(())
            });
        }
    }
}
