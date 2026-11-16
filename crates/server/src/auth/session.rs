//! App sessions: an opaque token in the cookie, only
//! its SHA-256 in the database. A session expires after 30 days without
//! activity; every request extends it (throttled, see
//! [`super::extract::resolve`]).

use std::{fmt::Write as _, time::Duration};

use axum::http::{HeaderMap, HeaderValue, header};
use rusqlite::Connection;
use sha2::{Digest as _, Sha256};

use super::device::Device;
use crate::{
    db::repo::{
        sessions,
        users::{Profile, Role},
    },
    random,
};

/// `__Host-`: only with `Secure`, `Path=/` and without `Domain` – a subdomain
/// (e.g. a mail server under the same domain) can thus neither set nor
/// overwrite the cookie.
pub const COOKIE: &str = "__Host-roedy_session";
/// With `1` when the web app runs installed ([`installed_app`]).
pub const APP_HEADER: &str = "x-roedy-app";
/// Shared attributes; deleting only works with the same ones.
const ATTRIBUTES: &str = "Path=/; HttpOnly; Secure; SameSite=Lax";
/// Expiry without activity.
pub const IDLE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Random bytes per token (256 bits), as 64 hex characters in the cookie.
const TOKEN_BYTES: usize = 32;

/// Signed-in user of a valid session (active, not expired).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub role: Role,
    /// ID of the session (`auth/sessions/:id`).
    pub session_id: String,
}

impl AuthUser {
    pub fn new(profile: Profile, session_id: String) -> Self {
        Self {
            id: profile.id,
            username: profile.username,
            email: profile.email,
            display_name: profile.display_name,
            role: profile.role,
            session_id,
        }
    }

    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }
}

/// A session token in this server's format (64 characters `0-9a-f`), also
/// for links from mails. Only such a token can build a cookie – arbitrary text from a request cannot
/// make the header invalid.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// New token from the random source (also for the intermediate sign-in
    /// step, `auth::challenge`, and links from mails).
    pub fn generate() -> anyhow::Result<Self> {
        let mut token = String::with_capacity(2 * TOKEN_BYTES);
        for b in random::bytes::<TOKEN_BYTES>()? {
            let _ = write!(token, "{b:02x}");
        }
        Ok(Self(token))
    }

    /// Checks the format; anything else is certainly not a valid token (saves
    /// the database query).
    pub fn parse(value: &str) -> Option<Self> {
        let well_formed = value.len() == 2 * TOKEN_BYTES
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        well_formed.then(|| Self(value.to_owned()))
    }

    /// The token itself – only for the link in a mail (reset password,
    /// confirm email); as for sessions, only the hash is stored.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// SHA-256 for `sessions.token_hash` (also links from mails).
    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.0.as_bytes()).into()
    }

    /// `Set-Cookie` for the session, also for renewing. `persistent`
    /// ("Stay signed in"): with the full lifetime, otherwise without `Max-Age` –
    /// then the browser deletes the cookie when it closes.
    pub fn cookie(&self, persistent: bool) -> HeaderValue {
        self.cookie_named(COOKIE, persistent.then_some(IDLE))
    }

    /// `Set-Cookie` for a cookie `name` with the same attributes; without
    /// `max_age` until the browser closes.
    pub fn cookie_named(&self, name: &str, max_age: Option<Duration>) -> HeaderValue {
        let value = match max_age {
            Some(max_age) => format!(
                "{name}={}; Max-Age={}; {ATTRIBUTES}",
                self.0,
                max_age.as_secs()
            ),
            None => format!("{name}={}; {ATTRIBUTES}", self.0),
        };
        HeaderValue::try_from(value).expect("fixed name, token only hex characters")
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(***)")
    }
}

/// New session: the cookie goes to the browser exactly once.
pub struct Started {
    pub id: String,
    pub cookie: HeaderValue,
}

/// What is known about the client at creation.
#[derive(Debug, Default, Clone)]
pub struct Client<'a> {
    pub user_agent: Option<&'a str>,
    pub ip: Option<std::net::IpAddr>,
    /// Place from GeoIP, if known (`AppState::place`).
    pub place: Option<&'a str>,
    /// Reports itself as an installed app ([`installed_app`]).
    pub app: bool,
}

/// Origin of a request: user agent, client IP and place (GeoIP) – for
/// session, audit log and events. Built with `api::auth::origin`.
#[derive(Debug, Clone)]
pub struct Origin {
    pub user_agent: Option<String>,
    pub ip: std::net::IpAddr,
    pub place: Option<String>,
    /// ID for `known_devices` (`Device::hash`).
    pub device_hash: [u8; 32],
    /// Reports itself as an installed app ([`installed_app`]).
    pub app: bool,
}

impl Origin {
    pub fn client(&self) -> Client<'_> {
        Client {
            user_agent: self.user_agent.as_deref(),
            ip: Some(self.ip),
            place: self.place.as_deref(),
            app: self.app,
        }
    }

    pub fn device(&self) -> Device {
        Device::parse(self.user_agent.as_deref())
    }
}

/// User agent of the request for [`Client`], truncated as in `sessions`: device,
/// ID and list thus see the same text.
pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|ua| sessions::truncate(ua, sessions::MAX_USER_AGENT).to_owned())
}

/// Whether the web app reports that it runs installed (`X-Roedy-App: 1`).
/// This is a client claim only for the device list, not
/// proof: it decides nothing.
pub fn installed_app(headers: &HeaderMap) -> bool {
    headers.get(APP_HEADER).is_some_and(|value| value == "1")
}

/// Creates a session for `user_id`; `persistent` as in
/// [`Token::cookie`]. Synchronous so that callers can include it in their
/// transaction (e.g. `setup/complete`). Beyond
/// [`sessions::MAX_PER_USER`] the user's least recently used session
/// ends.
pub fn start(
    conn: &Connection,
    user_id: &str,
    client: &Client<'_>,
    persistent: bool,
) -> anyhow::Result<Started> {
    let token = Token::generate()?;
    let id = sessions::insert(conn, user_id, &token.hash(), client, persistent)?;
    sessions::trim(conn, user_id, &id, sessions::MAX_PER_USER)?;
    Ok(Started {
        id,
        cookie: token.cookie(persistent),
    })
}

/// Value of the session cookie from the cookie header (also across several
/// `Cookie` lines, HTTP/2), not yet checked.
pub fn cookie_value(headers: &HeaderMap) -> Option<&str> {
    named_cookie(headers, COOKIE)
}

/// Value of the cookie `name`, not yet checked. Reading goes per cookie, not
/// per line: a cookie with bytes outside ASCII, e.g. set by another
/// subdomain under the same domain, must not hide the
/// session. Only ASCII whitespace is removed and the name
/// compared byte for byte: `str::trim` would turn `\u{2000}__Host-…` into the
/// name of the session cookie, although the browser accepts such a cookie
/// without the `__Host-` rules from a subdomain too.
pub fn named_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .flat_map(|value| value.as_bytes().split(|&b| b == b';'))
        .find_map(|pair| {
            let (key, value) = std::str::from_utf8(pair.trim_ascii())
                .ok()?
                .split_once('=')?;
            (key == name).then_some(value)
        })
}

/// `Set-Cookie` that deletes the session in the browser.
pub fn clear_cookie() -> HeaderValue {
    clear_named_cookie(COOKIE)
}

/// `Set-Cookie` that deletes the cookie `name` (attributes as when setting).
pub fn clear_named_cookie(name: &str) -> HeaderValue {
    HeaderValue::try_from(format!("{name}=; Max-Age=0; {ATTRIBUTES}"))
        .expect("fixed ASCII characters")
}

/// Whether a response already sets the session cookie itself (sign-in, sign-out).
pub fn sets_cookie(headers: &HeaderMap) -> bool {
    headers.get_all(header::SET_COOKIE).iter().any(|v| {
        v.as_bytes()
            .strip_prefix(COOKIE.as_bytes())
            .is_some_and(|rest| rest.starts_with(b"="))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_value_one_reports_the_installed_app() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(APP_HEADER, HeaderValue::from_static(value));
            installed_app(&headers)
        };
        assert!(with("1"));
        assert!(!with("0"));
        assert!(!with(""));
        assert!(!installed_app(&HeaderMap::new()));
    }
    use crate::db::repo::users::tests::{add, conn};

    #[test]
    fn tokens_are_random_hex() {
        let a = Token::generate().unwrap();
        let b = Token::generate().unwrap();
        assert_ne!(a, b);
        assert_eq!(Token::parse(&a.0).as_ref(), Some(&a));
        for bad in [
            "",
            "abc",
            &a.0.to_uppercase(),
            &format!("{}0", a.0),
            // Always one character outside hex (`replace('a', …)` would leave
            // a token without "a" unchanged, about every 60th).
            &format!("g{}", &a.0[1..]),
        ] {
            assert_eq!(Token::parse(bad), None, "{bad}");
        }
        assert_eq!(format!("{a:?}"), "Token(***)");
    }

    #[test]
    fn finds_cookie_among_others() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("a=1; theme=dark"));
        assert_eq!(cookie_value(&headers), None);
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("x=2;__Host-roedy_session=abc ; y=3"),
        );
        assert_eq!(cookie_value(&headers), Some("abc"));
        // A cookie with UTF-8 in the same line does not hide the session.
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_bytes("x=ä; __Host-roedy_session=abc".as_bytes()).unwrap(),
        );
        assert_eq!(cookie_value(&headers), Some("abc"));
        // Unicode whitespace belongs to the name: such a cookie is not a
        // `__Host-` cookie and must not shadow the real one.
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_bytes(
                "\u{2000}__Host-roedy_session=foreign; __Host-roedy_session=abc".as_bytes(),
            )
            .unwrap(),
        );
        assert_eq!(cookie_value(&headers), Some("abc"));
    }

    #[test]
    fn cookie_attributes() {
        let token = Token("0".repeat(64));
        assert_eq!(
            token.cookie(true).to_str().unwrap(),
            format!(
                "__Host-roedy_session={}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
                "0".repeat(64)
            )
        );
        assert_eq!(
            token.cookie(false).to_str().unwrap(),
            format!(
                "__Host-roedy_session={}; Path=/; HttpOnly; Secure; SameSite=Lax",
                "0".repeat(64)
            )
        );
        assert_eq!(
            clear_cookie().to_str().unwrap(),
            "__Host-roedy_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"
        );

        let mut headers = HeaderMap::new();
        headers.append(header::SET_COOKIE, HeaderValue::from_static("other=1"));
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("__Host-roedy_session_old=1"),
        );
        assert!(!sets_cookie(&headers));
        headers.append(header::SET_COOKIE, clear_cookie());
        assert!(sets_cookie(&headers));
    }

    #[test]
    fn start_stores_only_the_hash() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let started = start(&conn, &user, &Client::default(), true).unwrap();
        let cookie = started.cookie.to_str().unwrap();
        let value = cookie
            .strip_prefix("__Host-roedy_session=")
            .and_then(|rest| rest.split(';').next())
            .unwrap();
        let token = Token::parse(value).unwrap();
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT token_hash FROM sessions WHERE id = ?1",
                [&started.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, token.hash());
    }
}
