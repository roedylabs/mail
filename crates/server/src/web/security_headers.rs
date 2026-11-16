//! Security headers of every response.
//!
//! - **CSP:** besides the app, `connect-src` only allows the servers of the
//!   registry – with "Allow custom server URLs" any `https:` address. [`Csp`]
//!   keeps the value in memory; every change to the registry commits through
//!   [`Csp::commit`], i.e. in the order of the changes.
//!   SvelteKit starts the SPA with an inline script in `index.html`;
//!   `static_files` attaches its SHA-256 to the response as [`InlineScripts`].
//! - `Referrer-Policy: no-referrer` (links from mails reveal no app
//!   addresses), `Permissions-Policy` without camera, microphone etc.,
//!   `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy:
//!   same-origin` (a foreign page that opens the app keeps no handle on its
//!   window).
//! - **HSTS** only with `ROEDY_TRUST_PROXY`: then a reverse proxy terminates
//!   TLS; without one the server cannot know whether it is reachable over
//!   HTTPS.
//!
//! If a handler sets a CSP itself (branding SVG), its own stays.

use std::sync::{Arc, PoisonError, RwLock};

use axum::{
    extract::{Request, State},
    http::{HeaderName, HeaderValue, header},
    middleware::Next,
    response::Response,
};
use base64::Engine as _;
use rusqlite::{Connection, Transaction};
use sha2::{Digest as _, Sha256};

use crate::{app::AppState, db::repo::servers};

const PERMISSIONS_POLICY: &str = "camera=(), display-capture=(), geolocation=(), \
     microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()";
const HSTS: &str = "max-age=31536000";
static PERMISSIONS_POLICY_HEADER: HeaderName = HeaderName::from_static("permissions-policy");
static OPENER_POLICY_HEADER: HeaderName = HeaderName::from_static("cross-origin-opener-policy");

/// CSP with `connect-src` from the registry. The finished header without
/// script hashes is kept ready; only HTML responses rebuild it with hashes.
pub struct Csp {
    current: RwLock<Current>,
}

#[derive(Clone)]
struct Current {
    connect_src: Arc<str>,
    header: HeaderValue,
}

impl Current {
    fn new(connect_src: String) -> Self {
        Self {
            header: policy(&connect_src, &[]),
            connect_src: connect_src.into(),
        }
    }
}

impl Default for Csp {
    fn default() -> Self {
        Self {
            current: RwLock::new(Current::new("'self'".into())),
        }
    }
}

impl Csp {
    /// Reads servers and policy (at startup).
    pub fn reload(&self, conn: &Connection) -> anyhow::Result<()> {
        let connect_src = connect_src(conn)?;
        self.set(connect_src);
        Ok(())
    }

    /// Finishes a transaction that changes the registry: the new sources are
    /// read from the transaction beforehand (an error aborts everything) and
    /// only applied after the commit. Every writer of the registry
    /// (administration, initial setup) commits this way; on the database thread,
    /// concurrent changes do not overtake each other.
    pub fn commit(&self, tx: Transaction<'_>) -> anyhow::Result<()> {
        let connect_src = connect_src(&tx)?;
        tx.commit()?;
        self.set(connect_src);
        Ok(())
    }

    fn set(&self, connect_src: String) {
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = Current::new(connect_src);
    }

    fn current(&self) -> Current {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The current value of `connect-src`.
    pub fn connect_src(&self) -> Arc<str> {
        self.current().connect_src
    }

    fn header(&self, scripts: &[String]) -> HeaderValue {
        let current = self.current();
        if scripts.is_empty() {
            current.header
        } else {
            policy(&current.connect_src, scripts)
        }
    }
}

/// `'self'` and the origins of the registry; with "Eigene Server-URLs
/// erlauben" `https:` – `http://` servers of the registry (loopback only,
/// development) then stay allowed individually.
fn connect_src(conn: &Connection) -> anyhow::Result<String> {
    let allow_custom = servers::allow_custom_servers(conn)?;
    let mut src = String::from("'self'");
    if allow_custom {
        src.push_str(" https:");
    }
    for origin in servers::base_urls(conn)? {
        if !allow_custom || !origin.starts_with("https:") {
            src.push(' ');
            src.push_str(&origin);
        }
    }
    Ok(src)
}

fn policy(connect_src: &str, scripts: &[String]) -> HeaderValue {
    let mut script_src = String::from("'self'");
    for hash in scripts {
        script_src.push(' ');
        script_src.push_str(hash);
    }
    // `img-src https:` for images of allowed HTML mails: the `blob:` iframe
    // inherits this CSP and restricts it further with its own.
    let policy = format!(
        "default-src 'self'; script-src {script_src}; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https:; connect-src {connect_src}; frame-src 'self' blob:; \
         object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    // The sources are checked origins and Base64 hashes.
    HeaderValue::from_str(&policy)
        .unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'"))
}

/// Hashes of the inline scripts of an HTML document (`'sha256-…'`), as a
/// response extension.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InlineScripts(pub Vec<String>);

impl InlineScripts {
    /// Finds `<script>` elements without `src` and hashes their content as the
    /// browser sees it (text between the tags, unchanged).
    pub fn of_html(html: &[u8]) -> Self {
        let lower = html.to_ascii_lowercase();
        let mut hashes = Vec::new();
        let mut rest = 0;
        while let Some(at) = find(&lower[rest..], b"<script") {
            let tag_start = rest + at;
            let after_name = tag_start + b"<script".len();
            let Some(end) = find(&lower[after_name..], b">") else {
                break;
            };
            let tag_end = after_name + end;
            let attributes = &lower[after_name..tag_end];
            rest = tag_end + 1;
            if !attributes.first().is_none_or(u8::is_ascii_whitespace) {
                // `<scripts>` or similar.
                continue;
            }
            let Some(close) = find(&lower[rest..], b"</script") else {
                break;
            };
            let content = &html[rest..rest + close];
            rest += close;
            let external = attributes
                .split(u8::is_ascii_whitespace)
                .any(|token| token == b"src" || token.starts_with(b"src="));
            if external {
                continue;
            }
            let digest = Sha256::digest(content);
            let hash = format!(
                "'sha256-{}'",
                base64::engine::general_purpose::STANDARD.encode(digest)
            );
            if !hashes.contains(&hash) {
                hashes.push(hash);
            }
        }
        Self(hashes)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Middleware for all server responses.
pub async fn apply(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let scripts = response
        .extensions_mut()
        .remove::<InlineScripts>()
        .unwrap_or_default();
    let headers = response.headers_mut();
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            state.csp.header(&scripts.0),
        );
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        PERMISSIONS_POLICY_HEADER.clone(),
        HeaderValue::from_static(PERMISSIONS_POLICY),
    );
    headers.insert(
        OPENER_POLICY_HEADER.clone(),
        HeaderValue::from_static("same-origin"),
    );
    if state.trust_proxy.enabled() {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(HSTS),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(content: &str) -> String {
        format!(
            "'sha256-{}'",
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(content))
        )
    }

    #[test]
    fn hashes_inline_scripts_only() {
        let html = "<!doctype html><head>\
            <script src=\"/_app/a.js\"></script>\
            <script data-src=\"x\">with();</script>\
            <SCRIPT type=\"module\">\n  start();\n</SCRIPT>\
            <scripts>no script</scripts>\
            <script>\n  start();\n</script>\
            <script>empty();</script></head>";
        assert_eq!(
            InlineScripts::of_html(html.as_bytes()),
            InlineScripts(vec![
                hash("with();"),
                hash("\n  start();\n"),
                hash("empty();")
            ])
        );
        assert_eq!(
            InlineScripts::of_html(b"<p>without</p>"),
            InlineScripts::default()
        );
        assert_eq!(
            InlineScripts::of_html(b"<script>open"),
            InlineScripts::default()
        );
    }

    #[test]
    fn known_hash_of_sveltekit_bootstrap() {
        // Example from the CSP specification: alert('Hello, world.');
        assert_eq!(
            InlineScripts::of_html(b"<script>alert('Hello, world.');</script>").0,
            ["'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='"]
        );
    }

    #[test]
    fn header_contains_sources() {
        let csp = Csp::default();
        let value = csp.header(&["'sha256-abc='".into()]);
        let value = value.to_str().unwrap();
        assert!(
            value.contains("script-src 'self' 'sha256-abc=';"),
            "{value}"
        );
        assert!(value.contains("connect-src 'self';"), "{value}");
        assert!(value.contains("frame-src 'self' blob:;"), "{value}");
        assert!(
            value.contains("img-src 'self' data: blob: https:;"),
            "{value}"
        );
        assert!(
            value.contains("style-src 'self' 'unsafe-inline';"),
            "{value}"
        );
    }
}
