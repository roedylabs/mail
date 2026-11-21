//! Public branding files: the mail logo that the mail templates
//! embed with an absolute URL, the icon of push messages, the uploaded logo
//! that `public/config` names, and the web manifest and icons of the
//! installed app.
//! Mail clients, the device's system and the sign-in page load them without
//! signing in, which is why they live outside `/api`.
//!
//! The rendered images and the manifest keep their address while the content
//! follows the branding: the browser revalidates via the ETag as with
//! `static_files` (`no-cache`); mails and the manifest append the version
//! (`?v=…`), which does not matter here. The uploaded logo, by contrast, has
//! one address per content and stays in the cache (`immutable`).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use super::static_files::{CACHE_IMMUTABLE, CACHE_REVALIDATE, cached, etag_of, plain};
use crate::{
    app::AppState,
    logo::{ICON_SIZE, Logos, PUSH_SIZE, Png},
    mailer::templates::{Brand, PUSH_ICON_PATH, Theme},
};

/// Web manifest; the address is fixed in `app.html`.
pub const MANIFEST_PATH: &str = "/manifest.webmanifest";
/// Large icon in the web manifest.
pub const APP_ICON_PATH: &str = "/branding/app-icon.png";
/// Icon that the system crops itself.
pub const MASKABLE_ICON_PATH: &str = "/branding/app-icon-maskable.png";
/// Icon for the iOS home screen; the address is fixed in `app.html`.
pub const TOUCH_ICON_PATH: &str = "/branding/apple-touch-icon.png";

/// For the logo, even if someone opens an SVG directly: no scripts, no
/// external references (usvg has sanitized it anyway).
const IMAGE_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/// `GET /branding/mail-logo.png` – from the same branding as the mails
/// (`AppState::brand` takes the logos from there too).
pub async fn mail_logo(State(state): State<AppState>, headers: HeaderMap) -> Response {
    drawn(&state, &headers, |logos| &logos.mail)
}

/// `GET /branding/push-icon.png` – app icon of push messages.
pub async fn push_icon(State(state): State<AppState>, headers: HeaderMap) -> Response {
    drawn(&state, &headers, |logos| &logos.push)
}

/// `GET /branding/app-icon.png` – large icon in the web manifest.
pub async fn app_icon(State(state): State<AppState>, headers: HeaderMap) -> Response {
    drawn(&state, &headers, |logos| &logos.icon)
}

/// `GET /branding/app-icon-maskable.png` – filled to the edge, the system crops
/// it.
pub async fn maskable_icon(State(state): State<AppState>, headers: HeaderMap) -> Response {
    drawn(&state, &headers, |logos| &logos.maskable)
}

/// `GET /branding/apple-touch-icon.png` – iOS home screen.
pub async fn touch_icon(State(state): State<AppState>, headers: HeaderMap) -> Response {
    drawn(&state, &headers, |logos| &logos.touch)
}

/// A rendered version of the current branding.
fn drawn(state: &AppState, headers: &HeaderMap, pick: fn(&Logos) -> &Png) -> Response {
    let branding = state.instance.branding();
    png(branding.logos.as_deref().map(pick), headers)
}

/// `GET /manifest.webmanifest` – name, colors and icons from the branding.
pub async fn manifest(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let body = manifest_json(&state.brand()).to_string();
    cached(
        &headers,
        &etag_of(&Sha256::digest(&body)),
        CACHE_REVALIDATE,
        "application/manifest+json",
        body,
    )
}

/// The manifest. The version on the icons makes installed apps pick up a
/// changed icon; without rendered logos the list stays empty (the routes then
/// answer 404).
/// The system replaces `%s` with the whole link; the compose page reads it.
const MAILTO_HANDLER: &str = "/compose/new?mailto=%s";

///
/// `theme_color` is the page background, not the accent: Chrome on Android
/// colours the installed app's navigation bar with it and keeps it from the
/// install on, so it cannot follow the page's `theme-color` meta. The light
/// page by default, the dark page under `user_preferences.color_scheme_dark`
/// for systems in dark mode where the browser reads that.
fn manifest_json(brand: &Brand) -> Value {
    let (plate, _) = brand.plate.colors(brand.accent);
    json!({
        "id": "/",
        "name": brand.app,
        "short_name": brand.app,
        "dir": "ltr",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "protocol_handlers": [{ "protocol": "mailto", "url": MAILTO_HANDLER }],
        "theme_color": Theme::Light.page(),
        "background_color": plate,
        "user_preferences": { "color_scheme_dark": { "theme_color": Theme::Dark.page() } },
        "icons": brand.logos.as_deref().map_or_else(Vec::new, manifest_icons),
    })
}

fn manifest_icons(logos: &Logos) -> Vec<Value> {
    let icon = |path: &str, png: &Png, size: u32, purpose: &str| {
        json!({
            "src": format!("{path}?v={}", png.version),
            "sizes": format!("{size}x{size}"),
            "type": "image/png",
            "purpose": purpose,
        })
    };
    vec![
        icon(PUSH_ICON_PATH, &logos.push, PUSH_SIZE, "any"),
        icon(APP_ICON_PATH, &logos.icon, ICON_SIZE, "any"),
        icon(MASKABLE_ICON_PATH, &logos.maskable, ICON_SIZE, "maskable"),
    ]
}

/// Without a PNG 404, otherwise the image or 304.
fn png(png: Option<&Png>, headers: &HeaderMap) -> Response {
    let Some(png) = png else {
        return plain(StatusCode::NOT_FOUND);
    };
    cached(
        headers,
        &png.etag,
        CACHE_REVALIDATE,
        "image/png",
        png.bytes.clone(),
    )
}

/// `GET /branding/image/<id>.<extension>` – the uploaded logo; only the
/// current one, earlier addresses are 404.
pub async fn image(
    State(state): State<AppState>,
    Path(file): Path<String>,
    headers: HeaderMap,
) -> Response {
    let branding = state.instance.branding();
    let Some(image) = branding
        .image
        .as_ref()
        .filter(|image| file == format!("{}.{}", image.id, image.format.extension()))
    else {
        return plain(StatusCode::NOT_FOUND);
    };
    let mut response = cached(
        &headers,
        &format!("\"{}\"", image.id),
        CACHE_IMMUTABLE,
        image.format.mime(),
        image.data.clone(),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(IMAGE_CSP),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_without_logos_has_no_icons() {
        let manifest = manifest_json(&Brand {
            logos: None,
            ..Brand::default()
        });
        assert_eq!(manifest["name"], "Roedy Mail");
        assert_eq!(manifest["icons"], json!([]));
    }

    #[test]
    fn manifest_colours_the_bars_like_the_page() {
        let manifest = manifest_json(&Brand::default());
        assert_eq!(manifest["theme_color"], "#f3eee7");
        assert_eq!(
            manifest["user_preferences"]["color_scheme_dark"]["theme_color"],
            "#181411"
        );
    }

    #[test]
    fn not_found_without_png() {
        let response = png(None, &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }
}
