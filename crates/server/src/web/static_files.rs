//! Web app from the build of `apps/web` (`pnpm build`): embedded in the binary
//! (feature `embed-web`, as in the image) or from `ROEDY_WEB_DIR`.
//!
//! - Files under `_app/immutable/` carry a hash in their name and may be cached
//!   for a year. Everything else, above all `index.html`, the browser
//!   revalidates on every load via the ETag (`no-cache`, then mostly 304).
//! - Unknown paths return `index.html` (SPA fallback), so that the SPA's
//!   routes (`/login`, `/mailbox/…`) also work on reload – even with a dot in
//!   the last segment (`/invite/a.b`). Missing files under `_app/` or with a
//!   known file extension (`.js`, `.png` …, table [`known_type`]) and
//!   everything under `/api` give 404 – otherwise a missing script would get
//!   HTML.

use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context as _, ensure};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use percent_encoding::percent_decode_str;

use super::security_headers::InlineScripts;
use crate::app::AppState;

const INDEX: &str = "index.html";
const APP_DIR: &str = "_app";
const IMMUTABLE_DIR: &str = "_app/immutable/";
pub(super) const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
pub(super) const CACHE_REVALIDATE: &str = "no-cache";

#[cfg(feature = "embed-web")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../../apps/web/build/"]
struct Embedded;

/// Where the files of the web app come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebAssets {
    /// Embedded in the binary (feature `embed-web`).
    Embedded,
    /// From a directory (`ROEDY_WEB_DIR`), canonical path.
    Dir(PathBuf),
    /// No web app, only API and operational endpoints (development with `pnpm dev`).
    None,
}

impl WebAssets {
    /// `ROEDY_WEB_DIR` takes precedence over the embedded web app. The directory
    /// must contain an `index.html`.
    pub fn new(web_dir: Option<&Path>) -> anyhow::Result<Self> {
        match web_dir {
            Some(dir) => {
                let dir = std::fs::canonicalize(dir).with_context(|| {
                    format!("ROEDY_WEB_DIR: directory {} not readable", dir.display())
                })?;
                ensure!(
                    dir.join(INDEX).is_file(),
                    "ROEDY_WEB_DIR: {} contains no {INDEX} – run `pnpm build` first",
                    dir.display()
                );
                Ok(Self::Dir(dir))
            }
            None if cfg!(feature = "embed-web") => Ok(Self::Embedded),
            None => Ok(Self::None),
        }
    }

    /// Short description for the startup message.
    pub fn describe(&self) -> String {
        match self {
            Self::Embedded => "embedded".into(),
            Self::Dir(dir) => dir.display().to_string(),
            Self::None => "none".into(),
        }
    }

    async fn get(&self, name: &str) -> Option<Asset> {
        match self {
            Self::Embedded => embedded(name),
            Self::Dir(root) => from_dir(root, name).await,
            Self::None => None,
        }
    }
}

struct Asset {
    body: Bytes,
    etag: String,
}

/// Strong ETag from the SHA-256 of the content.
pub(crate) fn etag_of(sha256: &[u8]) -> String {
    use std::fmt::Write as _;

    sha256.iter().fold(String::from("\""), |mut tag, byte| {
        let _ = write!(tag, "{byte:02x}");
        tag
    }) + "\""
}

#[cfg(feature = "embed-web")]
fn embedded(name: &str) -> Option<Asset> {
    use std::borrow::Cow;

    let file = Embedded::get(name)?;
    let etag = etag_of(&file.metadata.sha256_hash());
    let body = match file.data {
        Cow::Borrowed(data) => Bytes::from_static(data),
        Cow::Owned(data) => Bytes::from(data),
    };
    Some(Asset { body, etag })
}

#[cfg(not(feature = "embed-web"))]
fn embedded(_name: &str) -> Option<Asset> {
    None
}

async fn from_dir(root: &Path, name: &str) -> Option<Asset> {
    let path = tokio::fs::canonicalize(root.join(name)).await.ok()?;
    // Symbolic links must not lead out of the directory either.
    if !path.starts_with(root) {
        return None;
    }
    let meta = tokio::fs::metadata(&path).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let body = tokio::fs::read(&path).await.ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    Some(Asset {
        etag: format!("\"{:x}-{modified:x}\"", body.len()),
        body: body.into(),
    })
}

/// What a decoded path (with leading `/`) asks for.
#[derive(Debug, PartialEq, Eq)]
enum Target<'a> {
    /// A file of the build; if it is missing and `fallback` is set, `index.html` applies.
    File { name: &'a str, fallback: bool },
    /// Never from the web app: `/api`, invalid paths.
    NotFound,
}

fn target(path: &str) -> Target<'_> {
    let Some(rel) = path.strip_prefix('/') else {
        return Target::NotFound;
    };
    if rel.is_empty() {
        return Target::File {
            name: INDEX,
            fallback: false,
        };
    }
    if rel == "api" || rel.starts_with("api/") {
        return Target::NotFound;
    }
    let (name, dir) = match rel.strip_suffix('/') {
        Some(name) => (name, true),
        None => (rel, false),
    };
    if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(['\\', '\0']))
    {
        return Target::NotFound;
    }
    let fallback = name != APP_DIR && !name.starts_with("_app/") && known_type(name).is_none();
    match (dir, fallback) {
        (false, _) => Target::File { name, fallback },
        // With a trailing `/` never a file, but a route of the SPA.
        (true, true) => Target::File {
            name: INDEX,
            fallback: false,
        },
        (true, false) => Target::NotFound,
    }
}

/// Content type by the extension of the last segment, if known.
fn known_type(name: &str) -> Option<&'static str> {
    let last = name.rsplit('/').next().unwrap_or(name);
    let (_, ext) = last.rsplit_once('.')?;
    Some(match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => return None,
    })
}

/// `If-None-Match` with weak comparison (RFC 9110, 13.1.2).
fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|tag| tag == "*" || tag.trim_start_matches("W/") == etag)
}

pub(super) fn plain(status: StatusCode) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
    )
        .into_response()
}

/// Router fallback: everything that is not an API or operational route.
pub async fn serve(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Ok(path) = percent_decode_str(uri.path()).decode_utf8() else {
        return plain(StatusCode::NOT_FOUND);
    };
    let (name, fallback) = match target(&path) {
        Target::NotFound => return plain(StatusCode::NOT_FOUND),
        Target::File { name, fallback } => (name, fallback),
    };
    if method != Method::GET && method != Method::HEAD {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }

    let mut found = state.web.get(name).await.map(|asset| (name, asset));
    if found.is_none() && fallback {
        found = state.web.get(INDEX).await.map(|asset| (INDEX, asset));
    }
    let Some((name, asset)) = found else {
        return plain(StatusCode::NOT_FOUND);
    };

    let cache = if name.starts_with(IMMUTABLE_DIR) {
        CACHE_IMMUTABLE
    } else {
        CACHE_REVALIDATE
    };
    // Also on 304: the browser copies the headers into the stored response,
    // and a CSP without hashes would then block the startup script.
    let scripts = name
        .ends_with(".html")
        .then(|| InlineScripts::of_html(&asset.body));
    let content_type = known_type(name).unwrap_or("application/octet-stream");
    let mut response = cached(&headers, &asset.etag, cache, content_type, asset.body);
    if let Some(scripts) = scripts {
        response.extensions_mut().insert(scripts);
    }
    response
}

/// File with ETag and `Cache-Control`, also for the mail logo
/// (`web::branding`): 304 if the browser already has this version.
pub(super) fn cached(
    request: &HeaderMap,
    etag: &str,
    cache: &'static str,
    content_type: &'static str,
    body: impl Into<Body>,
) -> Response {
    let mut response = if not_modified(request, etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut response = Response::new(body.into());
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
        response
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(etag) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, etag);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, fallback: bool) -> Target<'_> {
        Target::File { name, fallback }
    }

    #[test]
    fn classifies_paths() {
        assert_eq!(target("/"), file(INDEX, false));
        assert_eq!(target("/index.html"), file(INDEX, false));
        assert_eq!(target("/login"), file("login", true));
        assert_eq!(
            target("/mailbox/all/f/a1/t42"),
            file("mailbox/all/f/a1/t42", true)
        );
        assert_eq!(target("/account/profile/"), file(INDEX, false));
        assert_eq!(target("/invite/abc.def"), file("invite/abc.def", true));
        assert_eq!(target("/missing.php"), file("missing.php", true));
        assert_eq!(target("/licenses.json"), file("licenses.json", false));
        assert_eq!(target("/favicon.png"), file("favicon.png", false));
        assert_eq!(
            target("/_app/immutable/entry/app.js"),
            file("_app/immutable/entry/app.js", false)
        );
        assert_eq!(target("/_app/version"), file("_app/version", false));
        assert_eq!(target("/_app"), file("_app", false));
        assert_eq!(target("/_app/"), Target::NotFound);
        assert_eq!(target("/file.txt/"), Target::NotFound);
    }

    #[test]
    fn never_serves_api_or_unsafe_paths() {
        for path in [
            "/api",
            "/api/",
            "/api/v1/auth/me",
            "/../Cargo.toml",
            "/_app/../../secret",
            "/./index.html",
            "//etc/passwd",
            "/a//b",
            "/a\\..\\b",
            "/a\0b",
            "no-slash",
        ] {
            assert_eq!(target(path), Target::NotFound, "{path:?}");
        }
    }

    #[test]
    fn content_types() {
        assert_eq!(known_type("index.html"), Some("text/html; charset=utf-8"));
        assert_eq!(
            known_type("_app/immutable/entry/start.A1b2.js"),
            Some("text/javascript; charset=utf-8")
        );
        assert_eq!(known_type("a/b.CSS"), Some("text/css; charset=utf-8"));
        assert_eq!(known_type("licenses.json"), Some("application/json"));
        assert_eq!(known_type("x.woff2"), Some("font/woff2"));
        assert_eq!(known_type("favicon.svg"), Some("image/svg+xml"));
        assert_eq!(known_type("no-extension"), None);
        assert_eq!(known_type("a.b/no-extension"), None);
        assert_eq!(known_type("token.abc123"), None);
    }

    #[test]
    fn if_none_match() {
        let etag = "\"abc\"";
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static(value));
            headers
        };
        assert!(!not_modified(&HeaderMap::new(), etag));
        assert!(not_modified(&with("\"abc\""), etag));
        assert!(not_modified(&with("W/\"abc\""), etag));
        assert!(not_modified(&with("\"x\", \"abc\""), etag));
        assert!(not_modified(&with("*"), etag));
        assert!(!not_modified(&with("\"abcd\""), etag));
    }

    #[test]
    fn web_dir_needs_index() {
        let tmp = tempfile::tempdir().unwrap();
        let err = WebAssets::new(Some(tmp.path())).unwrap_err().to_string();
        assert!(err.contains("index.html"), "{err}");
        std::fs::write(tmp.path().join(INDEX), "<!doctype html>").unwrap();
        assert_eq!(
            WebAssets::new(Some(tmp.path())).unwrap(),
            WebAssets::Dir(tmp.path().canonicalize().unwrap())
        );
        assert!(WebAssets::new(Some(&tmp.path().join("missing"))).is_err());
    }

    #[test]
    fn without_web_dir_depends_on_feature() {
        let expected = if cfg!(feature = "embed-web") {
            WebAssets::Embedded
        } else {
            WebAssets::None
        };
        assert_eq!(WebAssets::new(None).unwrap(), expected);
    }
}
