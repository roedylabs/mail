//! Instance-wide details for everyone: organization, banner, branding and the
//! update hint (Administration › Organization, Banner, Branding and Updates).
//!
//! They live in `app_settings` (keys [`ORG`], [`BANNER`] and [`BRANDING`],
//! the logo in `assets`) and in memory ([`Instance`], loaded at startup, set
//! after every change while still inside the transaction). `public/config`
//! and `AppState::brand` read from there – one source for the web app and
//! mails, without a database query per request.
//! Changed by: `api::instance` and `api::branding`.

use std::sync::{
    Arc, PoisonError, RwLock,
    atomic::{AtomicU64, Ordering},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    db::repo::{app_settings, assets},
    logo::{Image, Logos},
    updates::{self, Hint},
};

/// Key of the organization in `app_settings`.
pub const ORG: &str = "org";
/// Key of the banner in `app_settings`.
pub const BANNER: &str = "banner";
/// Key of the branding in `app_settings`.
pub const BRANDING: &str = "branding";
/// Key of the browser cache version in `app_settings`: `storage/compact`
/// increments it, `public/config` reports it.
pub const CLIENT_CACHE_VERSION: &str = "client_cache_version";

/// App name without a custom name.
pub const APP_NAME: &str = "Roedy Mail";
/// Logo kinds; the first is the default.
pub const KINDS: [&str; 4] = ["standard", "initial", "icon", "image"];
/// How an image is fitted; the first is the default.
pub const FITS: [&str; 2] = ["padded", "fill"];
/// Plates behind the logo; the first is the default.
pub const PLATES: [&str; 3] = ["accent", "light", "dark"];

/// Banner colors; the first is the default.
pub const TONES: [&str; 4] = ["accent", "soft", "dark", "warning"];
/// Banner icons; the first is the default.
pub const ICONS: [&str; 8] = [
    "ti-speakerphone",
    "ti-info-circle",
    "ti-alert-triangle",
    "ti-calendar-event",
    "ti-sparkles",
    "ti-tool",
    "ti-gift",
    "ti-heart",
];

/// Organization details; `None` means "not specified" (an empty field on the
/// page).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Org {
    pub name: Option<String>,
    pub website: Option<String>,
    pub help: Option<String>,
    /// Support email.
    pub email: Option<String>,
    pub imprint: Option<String>,
    pub privacy: Option<String>,
    pub terms: Option<String>,
    /// Repository address (source code, AGPL).
    pub source: Option<String>,
}

impl Org {
    /// The fields in the order of the page, for validation and the audit log.
    pub fn fields_mut(&mut self) -> [(&'static str, &mut Option<String>); 8] {
        [
            ("name", &mut self.name),
            ("website", &mut self.website),
            ("help", &mut self.help),
            ("email", &mut self.email),
            ("imprint", &mut self.imprint),
            ("privacy", &mut self.privacy),
            ("terms", &mut self.terms),
            ("source", &mut self.source),
        ]
    }
}

/// Banner content and look, plus `on` (shown) and `revision`. Empty texts
/// mean "not specified".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Banner {
    pub on: bool,
    pub title: String,
    pub text: String,
    pub link: String,
    pub link_label: String,
    pub tone: String,
    pub icon: String,
    pub closable: bool,
    /// Increases with every change; whoever closes the banner remembers the
    /// revision in their settings and sees it again
    /// after the next change.
    pub revision: u64,
}

impl Default for Banner {
    /// Empty, switched off.
    fn default() -> Self {
        Self {
            on: false,
            title: String::new(),
            text: String::new(),
            link: String::new(),
            link_label: String::new(),
            tone: TONES[0].into(),
            icon: ICONS[0].into(),
            closable: true,
            revision: 0,
        }
    }
}

impl Banner {
    /// Same content and same display, regardless of the revision.
    pub fn same_as(&self, other: &Self) -> bool {
        Self {
            revision: other.revision,
            ..self.clone()
        } == *other
    }
}

/// Branding: `name` is the app name (`None` = [`APP_NAME`]), `image` the ID of
/// the logo in `assets` (its address comes from [`Image::path`]), `imageName`
/// and `imageMeta` describe it on the page (file name and size).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Branding {
    pub name: Option<String>,
    pub kind: String,
    pub letter: String,
    pub icon: String,
    pub image: Option<String>,
    pub image_name: String,
    pub image_meta: String,
    pub fit: String,
    pub plate: String,
    pub tilt: bool,
    pub color: String,
    pub user_accent: bool,
    pub login_title: String,
    pub login_text: String,
    pub login_art: bool,
}

/// Heading of the login page without a custom one.
pub const LOGIN_TITLE: &str = "Welcome back";
/// Text below the heading of the login page without a custom one.
pub const LOGIN_TEXT: &str = "Sign in with your account.";

impl Default for Branding {
    /// The standard logo in apricot with the default login texts.
    fn default() -> Self {
        Self {
            name: None,
            kind: KINDS[0].into(),
            letter: String::new(),
            icon: "ti-mountain".into(),
            image: None,
            image_name: String::new(),
            image_meta: String::new(),
            fit: FITS[0].into(),
            plate: PLATES[0].into(),
            tilt: true,
            color: "apricot".into(),
            user_accent: true,
            login_title: LOGIN_TITLE.into(),
            login_text: LOGIN_TEXT.into(),
            login_art: true,
        }
    }
}

impl Branding {
    /// The app name, [`APP_NAME`] without a custom one.
    pub fn app_name(&self) -> &str {
        self.name.as_deref().unwrap_or(APP_NAME)
    }
}

/// The branding with its logo and the PNGs rendered from it.
#[derive(Debug, Clone)]
pub struct BrandingState {
    pub branding: Branding,
    pub image: Option<Image>,
    /// `None` if rendering failed (then only the plate).
    pub logos: Option<Arc<Logos>>,
}

impl Default for BrandingState {
    fn default() -> Self {
        Self {
            branding: Branding::default(),
            image: None,
            logos: Logos::standard(),
        }
    }
}

impl BrandingState {
    /// Renders the logos for branding and image.
    pub fn new(branding: Branding, image: Option<Image>) -> Self {
        let logos = Logos::render_or_warn(&branding, image.as_ref());
        Self {
            branding,
            image,
            logos,
        }
    }

    /// Address of the logo, if there is one.
    pub fn image_path(&self) -> Option<String> {
        self.image.as_ref().map(Image::path)
    }
}

/// Reads `key`; `T` itself tolerates missing and unknown fields. If a value
/// does not fit (say a text instead of a number), `fallback` applies with a
/// warning – otherwise the server would not start, and `PUT` could never
/// replace the entry.
pub(crate) fn load<T: DeserializeOwned>(
    conn: &Connection,
    key: &str,
    fallback: impl FnOnce(&Value) -> T,
) -> anyhow::Result<Option<T>> {
    let Some(value) = app_settings::get::<Value>(conn, key)? else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_value(value.clone()).unwrap_or_else(
        |error| {
            tracing::warn!("app_settings.{key} unreadable, using default: {error}");
            fallback(&value)
        },
    )))
}

/// Organization from the database; without a (readable) entry nothing is
/// specified.
pub fn load_org(conn: &Connection) -> anyhow::Result<Org> {
    Ok(load(conn, ORG, |_| Org::default())?.unwrap_or_default())
}

/// Banner from the database; without an entry the empty default, switched
/// off. If it is unreadable, at least the revision is kept, so that a banner
/// saved later does not appear under an already closed revision.
pub fn load_banner(conn: &Connection) -> anyhow::Result<Banner> {
    Ok(load(conn, BANNER, |value| Banner {
        revision: value.get("revision").and_then(Value::as_u64).unwrap_or(0),
        ..Banner::default()
    })?
    .unwrap_or_default())
}

/// Branding from the database, without a (readable) entry the default, with
/// the logo from `assets`. If it is missing there, the branding applies without
/// an image (with a warning) – the kind "image" then renders the initial.
pub fn load_branding(conn: &Connection) -> anyhow::Result<(Branding, Option<Image>)> {
    let mut branding: Branding = load(conn, BRANDING, |_| Branding::default())?.unwrap_or_default();
    let image = match &branding.image {
        Some(id) => {
            let image = assets::get(conn, id)?;
            if image.is_none() {
                tracing::warn!("branding logo {id} missing from assets");
                branding.image = None;
            }
            image
        }
        None => None,
    };
    Ok((branding, image))
}

/// Browser cache version, `0` without a (readable) entry.
pub fn load_client_cache_version(conn: &Connection) -> anyhow::Result<u64> {
    Ok(load(conn, CLIENT_CACHE_VERSION, |_| 0)?.unwrap_or_default())
}

/// The in-memory state.
#[derive(Default)]
pub struct Instance {
    org: RwLock<Org>,
    banner: RwLock<Banner>,
    branding: RwLock<Arc<BrandingState>>,
    update: RwLock<Option<Hint>>,
    client_cache_version: AtomicU64,
}

impl Instance {
    /// Reads everything from the database and renders the logo.
    pub fn load(&self, conn: &Connection) -> anyhow::Result<()> {
        self.set_org(load_org(conn)?);
        self.set_banner(load_banner(conn)?);
        let (branding, image) = load_branding(conn)?;
        self.set_branding(BrandingState::new(branding, image));
        self.set_client_cache_version(load_client_cache_version(conn)?);
        self.reload_update(conn)
    }

    pub fn branding(&self) -> Arc<BrandingState> {
        self.branding
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set_branding(&self, branding: BrandingState) {
        *self
            .branding
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(branding);
    }

    pub fn org(&self) -> Org {
        self.org
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set_org(&self, org: Org) {
        *self.org.write().unwrap_or_else(PoisonError::into_inner) = org;
    }

    pub fn banner(&self) -> Banner {
        self.banner
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set_banner(&self, banner: Banner) {
        *self.banner.write().unwrap_or_else(PoisonError::into_inner) = banner;
    }

    pub fn update(&self) -> Option<Hint> {
        self.update
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn client_cache_version(&self) -> u64 {
        self.client_cache_version.load(Ordering::Relaxed)
    }

    pub fn set_client_cache_version(&self, version: u64) {
        self.client_cache_version.store(version, Ordering::Relaxed);
    }

    /// Reloads the hint, after every change to settings or state.
    pub fn reload_update(&self, conn: &Connection) -> anyhow::Result<()> {
        let update = updates::hint(conn)?;
        *self.update.write().unwrap_or_else(PoisonError::into_inner) = update;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    #[test]
    fn defaults_without_entries_and_tolerant_reading() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        assert_eq!(load_org(&conn).unwrap(), Org::default());
        let banner = load_banner(&conn).unwrap();
        assert_eq!(banner, Banner::default());
        assert_eq!(
            serde_json::to_value(&banner).unwrap(),
            serde_json::json!({
                "on": false, "title": "", "text": "", "link": "", "linkLabel": "",
                "tone": "accent", "icon": "ti-speakerphone", "closable": true,
                "revision": 0,
            })
        );

        // Missing and unknown fields from another program version.
        conn.execute(
            "INSERT INTO app_settings (key, json) VALUES \
             ('org', '{\"name\":\"Example Inc.\",\"fax\":\"0\"}'), \
             ('banner', '{\"on\":true,\"title\":\"New\",\"revision\":3,\"later\":1}')",
            [],
        )
        .unwrap();
        let instance = Instance::default();
        instance.load(&conn).unwrap();
        assert_eq!(instance.org().name.as_deref(), Some("Example Inc."));
        let banner = instance.banner();
        assert!(banner.on && banner.closable);
        assert_eq!((banner.title.as_str(), banner.revision), ("New", 3));
        assert_eq!(banner.icon, "ti-speakerphone");
    }

    #[test]
    fn unreadable_entries_fall_back_instead_of_failing() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, json) VALUES \
             ('org', '{\"name\":7}'), \
             ('banner', '{\"on\":\"yes\",\"title\":\"New\",\"revision\":5}')",
            [],
        )
        .unwrap();
        assert_eq!(load_org(&conn).unwrap(), Org::default());
        let banner = load_banner(&conn).unwrap();
        assert!(!banner.on && banner.title.is_empty());
        assert_eq!(banner.revision, 5);
    }

    #[test]
    fn same_as_ignores_only_the_revision() {
        let banner = Banner {
            revision: 4,
            ..Banner::default()
        };
        assert!(banner.same_as(&Banner::default()));
        let on = Banner {
            on: true,
            ..Banner::default()
        };
        assert!(!banner.same_as(&on));
    }

    #[test]
    fn branding_has_defaults_and_reads_tolerantly() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (branding, image) = load_branding(&conn).unwrap();
        assert_eq!((branding.clone(), image), (Branding::default(), None));
        assert_eq!(
            serde_json::to_value(&branding).unwrap(),
            serde_json::json!({
                "name": null, "kind": "standard", "letter": "", "icon": "ti-mountain",
                "image": null, "imageName": "", "imageMeta": "", "fit": "padded",
                "plate": "accent", "tilt": true, "color": "apricot", "userAccent": true,
                "loginTitle": "Welcome back",
                "loginText": "Sign in with your account.", "loginArt": true,
            })
        );
        let state = BrandingState::default();
        assert_eq!(state.branding.app_name(), "Roedy Mail");
        assert!(state.logos.is_some());

        // Unknown fields, an image missing from `assets`.
        conn.execute(
            "INSERT INTO app_settings (key, json) VALUES ('branding', \
             '{\"name\":\"Post\",\"kind\":\"image\",\"image\":\"missing\",\"later\":1}')",
            [],
        )
        .unwrap();
        let instance = Instance::default();
        instance.load(&conn).unwrap();
        let state = instance.branding();
        assert_eq!(state.branding.app_name(), "Post");
        assert_eq!(state.branding.kind, "image");
        assert_eq!(
            (state.branding.image.as_deref(), state.image_path()),
            (None, None)
        );
        // "image" without an image renders the initial.
        assert_ne!(state.logos, Logos::standard());

        // Unreadable: default.
        conn.execute(
            "UPDATE app_settings SET json = '{\"tilt\":\"yes\"}' WHERE key = 'branding'",
            [],
        )
        .unwrap();
        assert_eq!(load_branding(&conn).unwrap().0, Branding::default());
    }

    #[test]
    fn branding_with_image_from_assets() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let image = crate::logo::upload::check(
            crate::logo::Format::Svg,
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>"#.to_vec(),
        )
        .unwrap();
        assets::insert(&conn, &image).unwrap();
        let branding = Branding {
            kind: "image".into(),
            image: Some(image.id.clone()),
            ..Branding::default()
        };
        app_settings::set(&conn, BRANDING, &branding).unwrap();
        let instance = Instance::default();
        instance.load(&conn).unwrap();
        let state = instance.branding();
        assert_eq!(state.branding, branding);
        assert_eq!(state.image.as_ref(), Some(&image));
        assert_eq!(
            state.image_path().unwrap(),
            format!("/branding/image/{}.svg", image.id)
        );
    }
}
