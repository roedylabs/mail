//! Administration › Branding.
//!
//! - `GET admin/branding`: the branding fields – `name` (app name,
//!   `null` = "Roedy Mail"), `kind, letter, icon, image, fit, plate, tilt,
//!   color, userAccent, loginTitle, loginText, loginArt` –, plus `imageName`
//!   and `imageMeta` (name and details of the uploaded file). `image` is the
//!   URL of the logo or `null`.
//! - `PUT admin/branding`: changes the given fields. `image` is `null`
//!   (remove), the previous URL (stays) or a data URL of a new file (new
//!   logo: PNG, JPG, WebP or SVG up to 1 MB, SVG sanitized;
//!   `crate::logo::upload`). "Image" needs a logo.
//!
//! Stored in `app_settings.branding` and `assets`; afterwards the server
//! redraws mail logo and push icon (`crate::logo`). The in-memory store
//! (`crate::instance`) applies immediately to `public/config`, mails and push.

use axum::{Json, Router, extract::State, routing::get};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    ApiError, FieldErrors, JsonBody, instance::text_error, nullable, servers::audit_entry,
};
use crate::{
    app::AppState,
    auth::AdminUser,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            app_settings, assets,
            audit_log::{self, Category},
        },
    },
    instance::{
        self, APP_NAME, BRANDING, Branding, BrandingState, FITS, KINDS, LOGIN_TITLE, PLATES,
    },
    logo::{self, Image, Logos, upload},
    mailer::templates::ACCENTS,
};

/// Maximum lengths of the form fields: app name, letter, title
/// and text of the sign-in page.
const MAX_NAME: usize = 32;
const MAX_LETTER: usize = 2;
const MAX_LOGIN_TITLE: usize = 48;
const MAX_LOGIN_TEXT: usize = 120;
/// File name and details (`PNG · 34 KB`) of the logo.
const MAX_IMAGE_NAME: usize = 255;
const MAX_IMAGE_META: usize = 64;

pub fn routes() -> Router<AppState> {
    Router::new().route("/admin/branding", get(get_branding).put(put_branding))
}

/// The response of `GET` and `PUT`: the stored branding, `image` as a URL
/// instead of an ID. `public/config` takes the same view without the
/// details meant only for the administration ([`ADMIN_ONLY`]).
pub(super) fn view(state: &BrandingState) -> Map<String, Value> {
    let mut fields = match serde_json::to_value(&state.branding) {
        Ok(Value::Object(fields)) => fields,
        _ => Map::new(),
    };
    fields.insert("image".into(), json!(state.image_path()));
    fields
}

/// Fields `public/config` does not name: app name (at the top there as
/// `name`) and the file details.
pub(super) const ADMIN_ONLY: [&str; 3] = ["name", "imageName", "imageMeta"];

async fn get_branding(State(state): State<AppState>, _: AdminUser) -> Json<Map<String, Value>> {
    Json(view(&state.instance.branding()))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrandingBody {
    #[serde(default, deserialize_with = "nullable")]
    name: Option<Option<String>>,
    kind: Option<String>,
    letter: Option<String>,
    icon: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    image: Option<Option<String>>,
    image_name: Option<String>,
    image_meta: Option<String>,
    fit: Option<String>,
    plate: Option<String>,
    tilt: Option<bool>,
    color: Option<String>,
    user_accent: Option<bool>,
    login_title: Option<String>,
    login_text: Option<String>,
    login_art: Option<bool>,
}

/// What happens to the logo.
#[derive(Debug)]
enum ImageChange {
    Keep,
    Remove,
    /// The previous URL; only valid if it is still current.
    Same(String),
    Upload(Image),
}

/// A checked change.
#[derive(Debug)]
struct Changes {
    body: BrandingBody,
    image: ImageChange,
}

fn trim(value: &mut Option<String>) {
    if let Some(text) = value {
        *text = text.trim().to_owned();
    }
}

fn invalid_image(code: &str) -> ApiError {
    let mut errors = FieldErrors::default();
    errors.code("image", code);
    errors.into_error()
}

impl BrandingBody {
    /// Trims the texts and checks the given fields (without the logo).
    fn check(&mut self) -> FieldErrors {
        let mut errors = FieldErrors::default();
        if let Some(name) = &mut self.name {
            trim(name);
            // Empty or the app's own name: the default.
            if name
                .as_deref()
                .is_some_and(|n| n.is_empty() || n == APP_NAME)
            {
                *name = None;
            }
        }
        for value in [
            &mut self.letter,
            &mut self.image_name,
            &mut self.image_meta,
            &mut self.login_title,
            &mut self.login_text,
        ] {
            trim(value);
        }
        for (field, value, max) in [
            (
                "name",
                self.name.as_ref().and_then(Option::as_deref),
                MAX_NAME,
            ),
            ("letter", self.letter.as_deref(), MAX_LETTER),
            ("imageName", self.image_name.as_deref(), MAX_IMAGE_NAME),
            ("imageMeta", self.image_meta.as_deref(), MAX_IMAGE_META),
            ("loginTitle", self.login_title.as_deref(), MAX_LOGIN_TITLE),
            ("loginText", self.login_text.as_deref(), MAX_LOGIN_TEXT),
        ] {
            if let Some(code) = value.and_then(|value| text_error(value, max)) {
                errors.code(field, code);
            }
        }
        // Without a custom title the default one.
        if self.login_title.as_deref() == Some("") {
            self.login_title = Some(LOGIN_TITLE.into());
        }
        let valid = |value: &Option<String>, allowed: &dyn Fn(&str) -> bool| {
            value.as_deref().is_none_or(allowed)
        };
        for (field, ok) in [
            ("kind", valid(&self.kind, &|v| KINDS.contains(&v))),
            ("icon", valid(&self.icon, &logo::is_icon)),
            ("fit", valid(&self.fit, &|v| FITS.contains(&v))),
            ("plate", valid(&self.plate, &|v| PLATES.contains(&v))),
            (
                "color",
                valid(&self.color, &|v| ACCENTS.iter().any(|(name, _)| *name == v)),
            ),
        ] {
            if !ok {
                errors.code(field, "invalid");
            }
        }
        errors
    }
}

impl Changes {
    /// The branding after the change, with its logo; `current_image` is the
    /// previous one.
    fn apply(
        &self,
        current: &Branding,
        current_image: Option<&Image>,
    ) -> Result<(Branding, Option<Image>), ApiError> {
        let body = &self.body;
        let mut next = current.clone();
        if let Some(name) = &body.name {
            next.name.clone_from(name);
        }
        for (slot, value) in [
            (&mut next.kind, &body.kind),
            (&mut next.letter, &body.letter),
            (&mut next.icon, &body.icon),
            (&mut next.image_name, &body.image_name),
            (&mut next.image_meta, &body.image_meta),
            (&mut next.fit, &body.fit),
            (&mut next.plate, &body.plate),
            (&mut next.color, &body.color),
            (&mut next.login_title, &body.login_title),
            (&mut next.login_text, &body.login_text),
        ] {
            if let Some(value) = value {
                slot.clone_from(value);
            }
        }
        for (slot, value) in [
            (&mut next.tilt, body.tilt),
            (&mut next.user_accent, body.user_accent),
            (&mut next.login_art, body.login_art),
        ] {
            *slot = value.unwrap_or(*slot);
        }
        let image = match &self.image {
            ImageChange::Keep => current_image.cloned(),
            ImageChange::Same(path) if current_image.is_some_and(|i| i.path() == *path) => {
                current_image.cloned()
            }
            ImageChange::Same(_) => return Err(invalid_image("invalid")),
            ImageChange::Remove => None,
            ImageChange::Upload(image) => Some(image.clone()),
        };
        let replaced = image.as_ref().map(|i| &i.id) != current_image.map(|i| &i.id);
        if replaced {
            // Name and details belong to the file: new or empty.
            next.image_name = body.image_name.clone().unwrap_or_default();
            next.image_meta = body.image_meta.clone().unwrap_or_default();
        }
        if image.is_none() {
            next.image_name.clear();
            next.image_meta.clear();
        }
        next.image = image.as_ref().map(|i| i.id.clone());
        if next.kind == "image" && image.is_none() {
            return Err(invalid_image("required"));
        }
        Ok((next, image))
    }
}

/// Names of the changed fields as spelled in the API.
fn changed_fields(before: &Branding, after: &Branding) -> Vec<String> {
    let (Ok(Value::Object(before)), Ok(Value::Object(after))) =
        (serde_json::to_value(before), serde_json::to_value(after))
    else {
        return Vec::new();
    };
    after
        .iter()
        .filter(|(key, value)| before.get(*key) != Some(value))
        .map(|(key, _)| key.clone())
        .collect()
}

/// Reads the logo from a data URL; errors go to `fields.image`.
async fn upload(url: String) -> Result<Image, ApiError> {
    tokio::task::spawn_blocking(move || upload::from_data_url(&url))
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .map_err(|rejected| invalid_image(rejected.code()))
}

/// "Save" on the Branding page (also "Reset" with the default values). The
/// audit log records the names of the changed fields (`branding.update`,
/// shown as "changed the branding").
async fn put_branding(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(mut body): JsonBody<BrandingBody>,
) -> Result<Json<Map<String, Value>>, ApiError> {
    let errors = body.check();
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let image = match body.image.take() {
        None => ImageChange::Keep,
        Some(None) => ImageChange::Remove,
        Some(Some(value)) if value.trim().is_empty() => ImageChange::Remove,
        Some(Some(value)) if value.starts_with("data:") => {
            ImageChange::Upload(upload(value).await?)
        }
        Some(Some(value)) => ImageChange::Same(value),
    };
    let changes = Changes { body, image };

    // Draw from the in-memory store up front so the database does not wait;
    // if the state no longer matches in the transaction, redraw there.
    let current = state.instance.branding();
    let guess = changes
        .apply(&current.branding, current.image.as_ref())
        .ok();
    let drawn = match guess {
        Some((branding, image)) => {
            let logos = tokio::task::spawn_blocking({
                let (branding, image) = (branding.clone(), image.clone());
                move || Logos::render_or_warn(&branding, image.as_ref())
            })
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
            Some((branding, image, logos))
        }
        None => None,
    };

    let instance = state.instance.clone();
    let result = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let (current, current_image) = instance::load_branding(&tx)?;
        let (next, image) = match changes.apply(&current, current_image.as_ref()) {
            Ok(next) => next,
            Err(error) => return Ok(Err(error)),
        };
        let changed = changed_fields(&current, &next);
        if changed.is_empty() {
            // Nothing changed; the in-memory store stays.
            return Ok(Ok(view(&instance.branding())));
        }
        if let ImageChange::Upload(upload) = &changes.image {
            assets::insert(&tx, upload)?;
        }
        app_settings::set(&tx, BRANDING, &next)?;
        assets::delete_except(&tx, next.image.as_deref())?;
        audit_log::insert(
            &tx,
            &audit_entry(Category::Settings, "branding.update", &user, ip)
                .details(json!({ "fields": changed })),
        )?;
        tx.commit()?;
        let logos = match drawn {
            Some((branding, drawn_image, logos))
                if branding == next
                    && drawn_image.as_ref().map(|i| &i.id) == image.as_ref().map(|i| &i.id) =>
            {
                logos
            }
            _ => Logos::render_or_warn(&next, image.as_ref()),
        };
        let state = BrandingState {
            branding: next,
            image,
            logos,
        };
        let response = view(&state);
        // Still on the connection: a later change never sets the store
        // before this one.
        instance.set_branding(state);
        Ok(Ok(response))
    })
    .await??;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(json: Value) -> BrandingBody {
        serde_json::from_value(json).unwrap()
    }

    /// The codes per field (`fields.<field>.code`).
    fn codes(mut body: BrandingBody) -> Value {
        let Value::Object(fields) = body.check().into_value() else {
            panic!("no fields");
        };
        fields
            .into_iter()
            .map(|(field, error)| (field, error["code"].clone()))
            .collect()
    }

    #[test]
    fn checks_lengths_and_choices() {
        assert_eq!(
            codes(body(json!({
                "name": "x".repeat(33), "letter": "abc", "loginTitle": "x".repeat(49),
                "loginText": "x".repeat(121), "kind": "Photo", "icon": "ti-mail",
                "fit": "Stretched", "plate": "Gray", "color": "Green",
            }))),
            json!({
                "name": "too_long", "letter": "too_long", "loginTitle": "too_long",
                "loginText": "too_long", "kind": "invalid", "icon": "invalid",
                "fit": "invalid", "plate": "invalid", "color": "invalid",
            })
        );
        assert_eq!(
            codes(body(json!({
                "name": " Post ", "letter": " ÉB ", "kind": "icon", "icon": "ti-planet",
                "fit": "fill", "plate": "dark", "color": "rose", "loginText": "",
            }))),
            json!({})
        );
        assert_eq!(
            codes(body(json!({ "name": "a\tb" }))),
            json!({ "name": "invalid" })
        );
    }

    #[test]
    fn names_and_titles_fall_back_like_brsave() {
        let mut b = body(json!({ "name": " Roedy Mail ", "loginTitle": "  " }));
        b.check();
        assert_eq!(b.name, Some(None));
        assert_eq!(b.login_title.as_deref(), Some(LOGIN_TITLE));
        let mut b = body(json!({ "name": "" }));
        b.check();
        assert_eq!(b.name, Some(None));
        let mut b = body(json!({ "name": " Post " }));
        b.check();
        assert_eq!(b.name, Some(Some("Post".into())));
    }

    #[test]
    fn image_changes() {
        let image = Image::new(logo::Format::Png, &b"png"[..]);
        let current = Branding {
            kind: "image".into(),
            image: Some(image.id.clone()),
            image_name: "logo.png".into(),
            image_meta: "PNG · 1 KB".into(),
            ..Branding::default()
        };
        let changes = |json: Value, image: ImageChange| Changes {
            body: body(json),
            image,
        };
        // Stays, also with the previous URL.
        let (next, kept) = changes(json!({ "tilt": false }), ImageChange::Keep)
            .apply(&current, Some(&image))
            .unwrap();
        assert_eq!(
            (next.image_name.as_str(), kept.as_ref()),
            ("logo.png", Some(&image))
        );
        assert!(
            changes(json!({}), ImageChange::Same(image.path()))
                .apply(&current, Some(&image))
                .is_ok()
        );
        assert!(
            changes(
                json!({}),
                ImageChange::Same("/branding/image/old.png".into())
            )
            .apply(&current, Some(&image))
            .is_err()
        );
        // "Image" needs a logo; with another kind it may go.
        assert!(
            changes(json!({}), ImageChange::Remove)
                .apply(&current, Some(&image))
                .is_err()
        );
        let (next, none) = changes(json!({ "kind": "standard" }), ImageChange::Remove)
            .apply(&current, Some(&image))
            .unwrap();
        assert_eq!(none, None);
        assert_eq!(
            (next.image, next.image_name, next.image_meta),
            (None, String::new(), String::new())
        );
        // A new logo takes name and details from the change.
        let other = Image::new(logo::Format::Svg, &b"<svg/>"[..]);
        let (next, _) = changes(
            json!({ "imageName": "new.svg" }),
            ImageChange::Upload(other.clone()),
        )
        .apply(&current, Some(&image))
        .unwrap();
        assert_eq!(next.image.as_ref(), Some(&other.id));
        assert_eq!(
            (next.image_name.as_str(), next.image_meta.as_str()),
            ("new.svg", "")
        );
    }

    #[test]
    fn changed_fields_in_api_names() {
        let before = Branding::default();
        let after = Branding {
            user_accent: false,
            login_title: "Hello".into(),
            ..before.clone()
        };
        assert_eq!(
            changed_fields(&before, &after),
            ["loginTitle", "userAccent"]
        );
        assert!(changed_fields(&before, &before).is_empty());
    }
}
