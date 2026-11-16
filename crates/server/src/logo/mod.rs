//! App icon of the branding as PNG: mail logo in 80 × 80, push notification
//! icon in 192 × 192 and the icons of the installed app.
//! Uploaded images are checked and sanitised by [`upload`].
//!
//! Drawing matches the logo the web app draws on a canvas, with the choice
//! from its `mkLogo`: plate in the brand colour or light or
//! dark (`PLATES`) with corners 24 of 80, containing
//!
//! - the standard mark at 64 %,
//! - an icon from `BRAND_ICONS` at 56 % (Tabler Icons as SVG instead of the
//!   web font, horizontally in the field, vertically centred by the ink like the
//!   text on the canvas),
//! - the initial in Young Serif via skrifa (40 px, two characters 30 px;
//!   characters the font does not know are dropped) or
//! - the uploaded image ("Padded" at 72 %, "Fill" without margin).
//!
//! The tilt (`tilt`) applies only in the web app.

pub mod upload;

use std::{
    fmt::Write as _,
    sync::{Arc, LazyLock},
};

use anyhow::Context as _;
use axum::body::Bytes;
use base64::Engine as _;
use sha2::{Digest as _, Sha256};

use crate::{
    instance::Branding,
    mailer::templates::{Accent, Plate},
    web::static_files::etag_of,
};

/// Edge length of the mail logo (shown at 40 × 40).
pub const MAIL_SIZE: u32 = 80;
/// Edge length of the push notification icon, also the small icon
/// in the web manifest.
pub const PUSH_SIZE: u32 = 192;
/// Edge length of the large icon in the web manifest (also `maskable`).
pub const ICON_SIZE: u32 = 512;
/// Edge length of the `apple-touch-icon`.
pub const TOUCH_SIZE: u32 = 180;

/// Path of uploaded images: `/branding/image/<id>.<extension>`. The
/// ID is a hash of the content, so the address changes with the
/// image ([`crate::web::branding::image`]).
pub const IMAGE_PATH: &str = "/branding/image";

/// Young Serif (OFL-1.1, `assets/fonts/OFL.txt`) for the initial.
static FONT: &[u8] = include_bytes!("../../assets/fonts/YoungSerif-Regular.ttf");

/// Icons offered for the logo (Tabler Icons, MIT, `assets/icons/LICENSE`).
const ICONS: [(&str, &str); 12] = [
    (
        "ti-mountain",
        include_str!("../../assets/icons/ti-mountain.svg"),
    ),
    ("ti-leaf", include_str!("../../assets/icons/ti-leaf.svg")),
    ("ti-bolt", include_str!("../../assets/icons/ti-bolt.svg")),
    ("ti-flame", include_str!("../../assets/icons/ti-flame.svg")),
    ("ti-star", include_str!("../../assets/icons/ti-star.svg")),
    ("ti-heart", include_str!("../../assets/icons/ti-heart.svg")),
    ("ti-cloud", include_str!("../../assets/icons/ti-cloud.svg")),
    (
        "ti-compass",
        include_str!("../../assets/icons/ti-compass.svg"),
    ),
    (
        "ti-diamond",
        include_str!("../../assets/icons/ti-diamond.svg"),
    ),
    (
        "ti-rocket",
        include_str!("../../assets/icons/ti-rocket.svg"),
    ),
    (
        "ti-feather",
        include_str!("../../assets/icons/ti-feather.svg"),
    ),
    (
        "ti-planet",
        include_str!("../../assets/icons/ti-planet.svg"),
    ),
];

/// Whether the icon exists (`BRAND_ICONS`).
pub fn is_icon(name: &str) -> bool {
    ICONS.iter().any(|(icon, _)| *icon == name)
}

/// Format of an uploaded image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
    Webp,
    Svg,
}

impl Format {
    pub const ALL: [Self; 4] = [Self::Png, Self::Jpeg, Self::Webp, Self::Svg];

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Svg => "svg",
        }
    }

    pub fn of_mime(mime: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|format| format.mime().eq_ignore_ascii_case(mime))
    }
}

/// An uploaded image, checked and (SVG) sanitised; stored in `assets`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    /// Hash of the content (32 hex digits).
    pub id: String,
    pub format: Format,
    pub data: Bytes,
}

impl Image {
    /// From the content; the ID is the hash.
    pub fn new(format: Format, data: impl Into<Bytes>) -> Self {
        let data = data.into();
        let id = hex(&Sha256::digest(&data)[..16]);
        Self { id, format, data }
    }

    /// Public address (relative), as `public/config` names it.
    pub fn path(&self) -> String {
        format!("{IMAGE_PATH}/{}.{}", self.id, self.format.extension())
    }

    fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.format.mime(),
            base64::engine::general_purpose::STANDARD.encode(&self.data)
        )
    }
}

/// A drawn PNG with ETag and a short version for the address
/// (`?v=…`) so that image proxies load the new one after a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Png {
    pub bytes: Bytes,
    pub etag: String,
    pub version: String,
}

impl Png {
    fn new(bytes: Vec<u8>) -> Self {
        let hash = Sha256::digest(&bytes);
        Self {
            etag: etag_of(&hash),
            version: hex(&hash[..6]),
            bytes: bytes.into(),
        }
    }
}

/// All drawn versions of a branding's app icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Logos {
    pub mail: Png,
    pub push: Png,
    /// Large icon in the web manifest (`purpose: any`).
    pub icon: Png,
    /// Icon in the web manifest that the system crops itself
    /// (`purpose: maskable`).
    pub maskable: Png,
    /// `apple-touch-icon` for the iOS home screen.
    pub touch: Png,
}

impl Logos {
    /// Draws all versions.
    pub fn render(branding: &Branding, image: Option<&Image>) -> anyhow::Result<Self> {
        // Stored logos too only within the upload limits: otherwise an
        // oversized one (e.g. from a manipulated backup) would hold up every start.
        // Only if the branding draws the image (`Composition::of`).
        if let Some(image) =
            image.filter(|image| branding.kind == "image" && image.format == Format::Svg)
        {
            upload::within_limits(&image.data)
                .map_err(|rejected| anyhow::anyhow!("SVG over the limits ({})", rejected.code()))?;
        }
        let composition = Composition::of(branding, image);
        let tree = |shape| {
            usvg::Tree::from_str(&composition.svg(shape), &options()).context("logo not readable")
        };
        let rounded = tree(Shape::Rounded)?;
        Ok(Self {
            mail: Png::new(rasterize(&rounded, MAIL_SIZE)?),
            push: Png::new(rasterize(&rounded, PUSH_SIZE)?),
            icon: Png::new(rasterize(&rounded, ICON_SIZE)?),
            maskable: Png::new(rasterize(&tree(Shape::Maskable)?, ICON_SIZE)?),
            touch: Png::new(rasterize(&tree(Shape::Square)?, TOUCH_SIZE)?),
        })
    }

    /// The default logos (`BRAND0`), drawn once.
    pub fn standard() -> Option<Arc<Self>> {
        static STANDARD: LazyLock<Option<Arc<Logos>>> = LazyLock::new(|| {
            Logos::render(&Branding::default(), None)
                .inspect_err(|error| tracing::error!("default logo: {error:#}"))
                .ok()
                .map(Arc::new)
        });
        STANDARD.clone()
    }

    /// Draws and logs an error; without a logo the mail header shows
    /// only the plate, and the routes answer with 404.
    pub fn render_or_warn(branding: &Branding, image: Option<&Image>) -> Option<Arc<Self>> {
        if *branding == Branding::default() && image.is_none() {
            return Self::standard();
        }
        Self::render(branding, image)
            .inspect_err(|error| tracing::warn!("branding logo not drawn: {error:#}"))
            .ok()
            .map(Arc::new)
    }
}

/// Scaling for `maskable`: the safe zone is a circle with 80 % of the
/// diameter, and the largest field (72 %, "Padded") is a square
/// whose corners must lie inside it (0.8 / (0.72 · √2) ≈ 0.786).
const MASKABLE_SCALE: f32 = 0.78;

/// Shape of the plate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// Corners 24 of 80, transparent outside.
    Rounded,
    /// Up to the edge: iOS rounds itself and fills transparency with black.
    Square,
    /// Up to the edge, the content at [`MASKABLE_SCALE`] so that it stays in the
    /// safe zone that every system mask leaves.
    /// "Fill" still runs up to the edge.
    Maskable,
}

/// What is in the field (`mkLogo`).
enum Content<'a> {
    Mark,
    Icon(&'static str),
    Initial(String),
    Image {
        image: &'a Image,
        fill: bool,
    },
    /// Unknown icon (other program version): only the plate.
    Nothing,
}

struct Composition<'a> {
    plate: &'static str,
    ink: &'static str,
    content: Content<'a>,
}

impl<'a> Composition<'a> {
    fn of(branding: &Branding, image: Option<&'a Image>) -> Self {
        let (plate, ink) = Plate::named(&branding.plate).colors(Accent::named(&branding.color));
        let content = match (branding.kind.as_str(), image) {
            ("image", Some(image)) => Content::Image {
                image,
                fill: branding.fit == "fill",
            },
            ("icon", _) => ICONS
                .iter()
                .find(|(name, _)| *name == branding.icon)
                .map_or(Content::Nothing, |(_, svg)| Content::Icon(svg)),
            ("standard", _) => Content::Mark,
            _ => Content::Initial(initial_text(branding)),
        };
        Self {
            plate,
            ink,
            content,
        }
    }

    /// The logo as SVG in 80 × 80; [`rasterize`] sets the size.
    fn svg(&self, shape: Shape) -> String {
        let ink = self.ink;
        let content = match &self.content {
            Content::Mark => mark(ink),
            Content::Icon(svg) => icon(svg, ink).unwrap_or_default(),
            Content::Initial(text) => initial(text, ink).unwrap_or_default(),
            Content::Image { image, fill } => {
                // `drawImage` as in the web app: filling and cropped, otherwise
                // entirely within the 72 % field.
                let (at, size, aspect) = if *fill {
                    (0.0, 80.0, "xMidYMid slice")
                } else {
                    (11.2, 57.6, "xMidYMid meet")
                };
                format!(
                    r#"<image x="{at}" y="{at}" width="{size}" height="{size}" preserveAspectRatio="{aspect}" xlink:href="{}"/>"#,
                    image.data_url()
                )
            }
            Content::Nothing => String::new(),
        };
        let radius = if shape == Shape::Rounded { 24 } else { 0 };
        let filling = matches!(self.content, Content::Image { fill: true, .. });
        let scale = if shape == Shape::Maskable && !filling {
            MASKABLE_SCALE
        } else {
            1.0
        };
        let offset = 40.0 * (1.0 - scale);
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 80 80" width="80" height="80"><defs><clipPath id="plate"><rect width="80" height="80" rx="{radius}"/></clipPath></defs><rect width="80" height="80" rx="{radius}" fill="{}"/><g clip-path="url(#plate)"><g transform="translate({offset} {offset}) scale({scale})">{content}</g></g></svg>"##,
            self.plate
        )
    }
}

/// Text of the initial like `mkLogo`: the custom character, otherwise the first
/// letter of the app name upper case, otherwise "A".
fn initial_text(branding: &Branding) -> String {
    let letter = branding.letter.trim();
    if !letter.is_empty() {
        return letter.to_owned();
    }
    branding
        .app_name()
        .trim()
        .chars()
        .next()
        .map_or_else(|| "A".to_owned(), |first| first.to_uppercase().collect())
}

/// The standard mark (letter on letter, as in the web app) at
/// 64 % (51.2 px), centred.
fn mark(ink: &str) -> String {
    const BACK: &str = "M18 6h20a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z";
    const FRONT: &str =
        "M10 17h22a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V21a4 4 0 0 1 4-4z";
    const WHITE: &str = r##"<rect x="-12" y="-12" width="72" height="72" fill="#fff"/>"##;
    format!(
        r##"<mask id="a">{WHITE}<path d="{FRONT}" fill="#000" stroke="#000" stroke-width="3" stroke-linejoin="round"/></mask><mask id="b">{WHITE}<path d="M8.5 20 21 29.5 33.5 20" fill="none" stroke="#000" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></mask><g transform="translate(14.4 14.4) scale(1.0666667)"><path d="{BACK}" mask="url(#a)" fill="{ink}" opacity=".55"/><path d="{FRONT}" mask="url(#b)" fill="{ink}"/></g>"##
    )
}

/// An icon at 56 % (44.8 px): horizontally in the middle of the field like
/// `textAlign: center`, vertically by its ink (stroke included)
/// like `actualBoundingBox…` on the web app's canvas.
fn icon(svg: &str, ink: &str) -> Option<String> {
    const SIZE: f32 = 44.8;
    let scale = SIZE / 24.0;
    let tree = usvg::Tree::from_str(svg, &options()).ok()?;
    let ink_box = tree.root().abs_stroke_bounding_box();
    let center = (ink_box.top() + ink_box.bottom()) / 2.0;
    let x = (80.0 - SIZE) / 2.0;
    let y = 40.0 - center * scale;
    Some(format!(
        r#"<g color="{ink}" transform="translate({x:.3} {y:.3}) scale({scale:.7})">{svg}</g>"#
    ))
}

/// The initial as paths from Young Serif: horizontally centred by the advance
/// width, vertically by the ink (the canvas with `textBaseline:
/// 'alphabetic'`). Two characters (like `text.length > 1` in the web app, counted
/// in UTF-16) at 30 px, otherwise 40 px.
fn initial(text: &str, ink: &str) -> Option<String> {
    use skrifa::{
        FontRef, MetadataProvider as _,
        instance::{LocationRef, Size},
        outline::DrawSettings,
    };

    let font = FontRef::new(FONT).ok()?;
    let px = if text.encode_utf16().count() > 1 {
        30.0
    } else {
        40.0
    };
    // Metrics and outlines in pixels of this size, without hinting.
    let size = Size::new(px);
    let metrics = font.glyph_metrics(size, LocationRef::default());
    let charmap = font.charmap();
    let outlines = font.outline_glyphs();
    let mut glyphs = Vec::new();
    let mut advance = 0.0;
    let (mut top, mut bottom) = (f32::MIN, f32::MAX);
    for ch in text.chars() {
        let Some(id) = charmap.map(ch) else {
            continue;
        };
        if let Some(bounds) = metrics.bounds(id) {
            top = top.max(bounds.y_max);
            bottom = bottom.min(bounds.y_min);
        }
        glyphs.push((id, advance));
        advance += metrics.advance_width(id).unwrap_or(0.0);
    }
    if top < bottom {
        // No ink (unknown characters, spaces): only the plate.
        return None;
    }
    let left = 40.0 - advance / 2.0;
    // Baseline: S/2 + (top − bottom)/2, both above the line.
    let baseline = 40.0 + (top + bottom) / 2.0;
    let mut path = Outline {
        d: String::new(),
        x: 0.0,
        y: baseline,
    };
    for (id, offset) in glyphs {
        path.x = left + offset;
        if let Some(glyph) = outlines.get(id) {
            let _ = glyph.draw(
                DrawSettings::unhinted(size, LocationRef::default()),
                &mut path,
            );
        }
    }
    Some(format!(r#"<path d="{}" fill="{ink}"/>"#, path.d))
}

/// Path data from the font's outlines (y upwards) in the field (y
/// downwards).
struct Outline {
    d: String,
    x: f32,
    y: f32,
}

impl Outline {
    fn point(&mut self, command: char, points: &[(f32, f32)]) {
        self.d.push(command);
        for (x, y) in points {
            let (x, y) = (self.x + x, self.y - y);
            let _ = write!(self.d, "{x:.3} {y:.3} ");
        }
    }
}

impl skrifa::outline::OutlinePen for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.point('M', &[(x, y)]);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.point('L', &[(x, y)]);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.point('Q', &[(x1, y1), (x, y)]);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.point('C', &[(x1, y1), (x2, y2), (x, y)]);
    }

    fn close(&mut self) {
        self.d.push('Z');
    }
}

/// Options for usvg: images only from data URLs, never from files.
pub(crate) fn options() -> usvg::Options<'static> {
    options_with(|_| true)
}

/// Like [`options`]; usvg reads nested SVGs (`<image>` with a data URL)
/// only if `nested` accepts them, and never with entities – the
/// check of the outer document only sees their base64.
pub(crate) fn options_with(
    nested: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
) -> usvg::Options<'static> {
    let data = usvg::ImageHrefResolver::default_data_resolver();
    usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(move |mime, bytes, options| {
                let raster = matches!(
                    imagesize::image_type(&bytes),
                    Ok(imagesize::ImageType::Png
                        | imagesize::ImageType::Jpeg
                        | imagesize::ImageType::Gif
                        | imagesize::ImageType::Webp)
                );
                // `nested` first, so that the upload check learns the reason.
                if !raster && (!nested(&bytes) || has_entities(&bytes)) {
                    return None;
                }
                data(mime, bytes, options)
            }),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    }
}

/// Whether a document declares entities; they can blow up heavily despite
/// roxmltree's limits.
pub(crate) fn has_entities(bytes: &[u8]) -> bool {
    const ENTITY: &[u8] = b"<!ENTITY";
    bytes.windows(ENTITY.len()).any(|window| window == ENTITY)
}

/// Draws an SVG with `viewBox="0 0 80 80"` as PNG in `size` × `size`.
fn rasterize(tree: &usvg::Tree, size: u32) -> anyhow::Result<Vec<u8>> {
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size).context("logo size")?;
    let scale = size as f32 / tree.size().width();
    resvg::render(
        tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().context("logo PNG")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The backend does not draw a stored logo over the upload limits
    /// either, e.g. one restored from a manipulated backup.
    #[test]
    fn stored_svg_over_the_limits_is_not_drawn() {
        let image = Image::new(
            Format::Svg,
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><marker id="m"><rect width="1" height="1"/></marker><path d="M0 0L5 5L9 1" marker-mid="url(#m)"/></svg>"#.to_vec(),
        );
        let branding = Branding {
            kind: "image".into(),
            image: Some(image.id.clone()),
            ..Branding::default()
        };
        assert!(Logos::render(&branding, Some(&image)).is_err());
        // If the branding does not draw the image, it does no harm.
        let initial = Branding {
            kind: "initial".into(),
            ..branding
        };
        assert!(Logos::render(&initial, Some(&image)).is_ok());
    }

    /// Width, height and RGBA pixels of a PNG.
    fn pixels(png: &[u8]) -> (u32, u32, Vec<u8>) {
        let pixmap = resvg::tiny_skia::Pixmap::decode_png(png).unwrap();
        let (width, height) = (pixmap.width(), pixmap.height());
        let data = pixmap
            .pixels()
            .iter()
            .flat_map(|pixel| {
                let pixel = pixel.demultiply();
                [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]
            })
            .collect();
        (width, height, data)
    }

    fn pixel(png: &[u8], x: u32, y: u32) -> [u8; 4] {
        let (width, _, data) = pixels(png);
        let at = ((y * width + x) * 4) as usize;
        data[at..at + 4].try_into().unwrap()
    }

    /// Share of pixels in the colour `rgb` (to within ±8).
    fn share(png: &[u8], rgb: [u8; 3]) -> f32 {
        let (width, height, data) = pixels(png);
        let hits = data
            .chunks(4)
            .filter(|p| p[3] == 255 && (0..3).all(|i| p[i].abs_diff(rgb[i]) <= 8))
            .count();
        hits as f32 / (width * height) as f32
    }

    fn rgb(hex: &str) -> [u8; 3] {
        let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap();
        [(value >> 16) as u8, (value >> 8) as u8, value as u8]
    }

    fn branding(kind: &str) -> Branding {
        Branding {
            kind: kind.into(),
            ..Branding::default()
        }
    }

    #[test]
    fn standard_logo_like_the_previous_png() {
        let logos = Logos::standard().unwrap();
        let (width, height, _) = pixels(&logos.mail.bytes);
        assert_eq!((width, height), (80, 80));
        assert_eq!(pixels(&logos.push.bytes).0, 192);
        // Corners transparent, plate apricot, mark in the ink colour.
        assert_eq!(pixel(&logos.mail.bytes, 0, 0)[3], 0);
        assert_eq!(pixel(&logos.mail.bytes, 40, 4), [0xf5, 0xa0, 0x6e, 255]);
        let ink = share(&logos.mail.bytes, rgb("#3a1b06"));
        assert!((0.08..0.3).contains(&ink), "{ink}");
        // The same drawing as the previous PNG in the binary (resvg 0.45.1).
        let previous = include_bytes!("../../tests/fixtures/mail-logo-0.45.png");
        let (_, _, before) = pixels(previous);
        let (_, _, now) = pixels(&logos.mail.bytes);
        let differing = before
            .chunks(4)
            .zip(now.chunks(4))
            .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 24))
            .count();
        assert!(differing < 40, "{differing}");
    }

    #[test]
    fn plates_and_accents() {
        for (plate, color, bg, ink) in [
            ("light", "sage", "#fffdfa", "#2b221c"),
            ("dark", "rose", "#2b221c", "#fffaf3"),
            ("accent", "sky", "#82bbec", "#0b2a47"),
        ] {
            let logos = Logos::render(
                &Branding {
                    plate: plate.into(),
                    color: color.into(),
                    ..Branding::default()
                },
                None,
            )
            .unwrap();
            assert_eq!(pixel(&logos.mail.bytes, 40, 4)[..3], rgb(bg), "{plate}");
            assert!(share(&logos.mail.bytes, rgb(ink)) > 0.08, "{plate}");
            assert_ne!(logos, *Logos::standard().unwrap(), "{plate}");
        }
    }

    #[test]
    fn every_icon_is_drawn_and_centered() {
        for (name, _) in ICONS {
            let logos = Logos::render(
                &Branding {
                    icon: name.into(),
                    ..branding("icon")
                },
                None,
            )
            .unwrap();
            let png = &logos.mail.bytes;
            let ink = share(png, rgb("#3a1b06"));
            assert!((0.02..0.3).contains(&ink), "{name}: {ink}");
            // Ink roughly centred vertically.
            let (width, height, data) = pixels(png);
            let rows: Vec<u32> = (0..height)
                .filter(|y| {
                    (0..width).any(|x| {
                        let p = &data[((y * width + x) * 4) as usize..][..4];
                        p[0] < 0x80 && p[3] == 255
                    })
                })
                .collect();
            let (first, last) = (rows[0], *rows.last().unwrap());
            assert!(
                first.abs_diff(height - 1 - last) <= 2,
                "{name}: {first}–{last}"
            );
        }
    }

    #[test]
    fn initials_from_the_letter_or_the_app_name() {
        assert_eq!(initial_text(&branding("initial")), "R");
        let named = Branding {
            name: Some("élan".into()),
            ..branding("initial")
        };
        assert_eq!(initial_text(&named), "É");
        let letter = Branding {
            letter: " ab ".into(),
            ..named.clone()
        };
        assert_eq!(initial_text(&letter), "ab");
        let empty = Branding {
            name: Some("  ".into()),
            ..branding("initial")
        };
        assert_eq!(initial_text(&empty), "A");
        // An unknown kind draws the initial, like the web app.
        assert_eq!(initial_text(&branding("later")), "R");

        let one = Logos::render(&named, None).unwrap();
        let two = Logos::render(&letter, None).unwrap();
        for logos in [&one, &two] {
            let ink = share(&logos.mail.bytes, rgb("#3a1b06"));
            assert!((0.02..0.3).contains(&ink), "{ink}");
        }
        assert_ne!(one.mail, two.mail);
    }

    #[test]
    fn unknown_glyphs_leave_only_the_plate() {
        let logos = Logos::render(
            &Branding {
                letter: "語".into(),
                ..branding("initial")
            },
            None,
        )
        .unwrap();
        assert_eq!(share(&logos.mail.bytes, rgb("#3a1b06")), 0.0);
        assert_eq!(pixel(&logos.mail.bytes, 40, 40), [0xf5, 0xa0, 0x6e, 255]);
    }

    /// Distance of the farthest pixel without the plate colour from the
    /// centre, as a share of half the edge.
    fn reach(png: &[u8], plate: [u8; 3]) -> f32 {
        let (width, _, rgba) = pixels(png);
        let center = width as f32 / 2.0;
        rgba.as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .filter(|(_, pixel)| pixel[..3] != plate)
            .map(|(at, _)| {
                let (x, y) = (at as u32 % width, at as u32 / width);
                (x as f32 + 0.5 - center).hypot(y as f32 + 0.5 - center) / center
            })
            .fold(0.0, f32::max)
    }

    #[test]
    fn app_icons_in_their_sizes_and_shapes() {
        let logos = Logos::render(&branding("standard"), None).unwrap();
        let plate = [0xf5, 0xa0, 0x6e, 255];
        assert_eq!(pixels(&logos.icon.bytes).0, ICON_SIZE);
        assert_eq!(pixels(&logos.maskable.bytes).0, ICON_SIZE);
        assert_eq!(pixels(&logos.touch.bytes).0, TOUCH_SIZE);
        // The manifest has round corners, maskable and iOS a full area.
        assert_eq!(pixel(&logos.icon.bytes, 0, 0)[3], 0);
        assert_eq!(pixel(&logos.maskable.bytes, 0, 0), plate);
        assert_eq!(pixel(&logos.touch.bytes, 0, 0), plate);
        assert_eq!(pixel(&logos.touch.bytes, 179, 179), plate);
        // The mark stays in the safe zone (circle with 80 %).
        let ink = rgb("#3a1b06");
        let [r, g, b, _] = plate;
        assert!(share(&logos.maskable.bytes, ink) > 0.01);
        let (masked, full) = (
            reach(&logos.maskable.bytes, [r, g, b]),
            reach(&logos.touch.bytes, [r, g, b]),
        );
        assert!(masked <= 0.8, "{masked}");
        let ratio = masked / full;
        assert!((ratio - MASKABLE_SCALE).abs() < 0.02, "{masked} {full}");
    }

    #[test]
    fn maskable_keeps_filling_images_full_size() {
        let svg = Image::new(
            Format::Svg,
            &br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>"##[..],
        );
        let image = |fit: &str| Branding {
            fit: fit.into(),
            ..branding("image")
        };
        let filling = Logos::render(&image("fill"), Some(&svg)).unwrap();
        assert_eq!(pixel(&filling.maskable.bytes, 0, 0), [255, 0, 0, 255]);
        let margin = Logos::render(&image("padded"), Some(&svg)).unwrap();
        assert_eq!(pixel(&margin.maskable.bytes, 0, 0), [0xf5, 0xa0, 0x6e, 255]);
        assert_eq!(pixel(&margin.maskable.bytes, 256, 256), [255, 0, 0, 255]);
        // The corners of the square image also stay in the safe zone.
        let reached = reach(&margin.maskable.bytes, [0xf5, 0xa0, 0x6e]);
        assert!((0.75..=0.8).contains(&reached), "{reached}");
    }

    #[test]
    fn images_with_margin_or_filling() {
        // A red square as SVG.
        let svg = Image::new(
            Format::Svg,
            &br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>"##[..],
        );
        let margin = Logos::render(&branding("image"), Some(&svg)).unwrap();
        let red = share(&margin.mail.bytes, [255, 0, 0]);
        // 57.6² of 80² ≈ 52 %.
        assert!((0.48..0.56).contains(&red), "{red}");
        assert_eq!(pixel(&margin.mail.bytes, 40, 4)[..3], rgb("#f5a06e"));
        let fill = Logos::render(
            &Branding {
                fit: "fill".into(),
                ..branding("image")
            },
            Some(&svg),
        )
        .unwrap();
        assert_eq!(pixel(&fill.mail.bytes, 40, 4), [255, 0, 0, 255]);
        assert_eq!(pixel(&fill.mail.bytes, 0, 0)[3], 0);
        // Without an image, the kind `image` draws the initial (`mkLogo`).
        let without = Logos::render(&branding("image"), None).unwrap();
        assert!(share(&without.mail.bytes, rgb("#3a1b06")) > 0.02);
    }

    #[test]
    fn versions_follow_the_content() {
        let standard = Logos::standard().unwrap();
        assert_eq!(standard.mail.version.len(), 12);
        assert!(standard.mail.etag.starts_with('"'));
        let again = Logos::render(&Branding::default(), None).unwrap();
        assert_eq!(again, *standard);
    }

    #[test]
    fn images_have_addresses_by_content() {
        let image = Image::new(Format::Jpeg, &b"jpeg"[..]);
        assert_eq!(image.id.len(), 32);
        assert_eq!(image.path(), format!("/branding/image/{}.jpg", image.id));
        assert_eq!(Format::of_mime("IMAGE/SVG+XML"), Some(Format::Svg));
        assert_eq!(Format::of_mime("image/gif"), None);
    }
}
