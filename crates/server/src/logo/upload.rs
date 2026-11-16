//! Checking uploaded logos (admin `branding`):
//! PNG, JPG, WebP or SVG up to 1 MB as a data URL, as `readBrandFile`
//! reads them in the browser.
//!
//! - Raster images: format by content, at most [`MAX_SIDE`] pixels per
//!   side, fully decoded as when drawing (resvg).
//! - SVG: without entities (they would otherwise blow up despite roxmltree's
//!   limits; a DOCTYPE with a public identifier stays allowed, roxmltree
//!   never loads the external DTD), without text (the backend has no fonts
//!   for it) – also in nested SVGs –, read by usvg and
//!   rewritten – what remains are paths, groups,
//!   gradients, masks, filters and images as data URLs; scripts, events,
//!   `foreignObject`, links and external references are dropped.
//! - SVG with limits on the effort: at most [`MAX_ELEMENTS`]
//!   elements and [`MAX_DATA`] bytes of geometry after resolving `use`
//!   and nested SVGs (before usvg, which creates every use as its own
//!   node), at most [`MAX_COST`] when drawing; without markers
//!   (one copy per point of the path), morphology and convolution (effort per
//!   pixel grows with the radius or the size of the matrix) and without turbulence with
//!   more than [`MAX_OCTAVES`] octaves.

use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
    sync::{Arc, Mutex, PoisonError},
};

use base64::Engine as _;

use super::{Format, Image, has_entities, options_with};

/// Maximum upload size, the same limit the web app checks (`f.size > 1048576`).
pub const MAX_BYTES: usize = 1024 * 1024;
/// Maximum size of a sanitised SVG (usvg writes shapes as paths).
const MAX_SVG_BYTES: usize = 2 * MAX_BYTES;
/// At most this many pixels per side (also for images in an SVG), so that
/// decoding does not blow the memory (4096² RGBA = 64 MB).
pub const MAX_SIDE: usize = 4096;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

/// At most this many elements after resolving `use` and
/// nested SVGs, together with at most [`MAX_DATA`] bytes in `d`,
/// `points` and data URLs: nested `use` multiply, and
/// usvg creates every use as its own node.
pub const MAX_ELEMENTS: usize = 10_000;
pub const MAX_DATA: usize = 4 * MAX_BYTES;
/// Effort when drawing ([`render_cost`]): a shape counts 1, a
/// filter primitive [`FILTER_COST`] (one pass over its area).
pub const MAX_COST: usize = 20_000;
const FILTER_COST: usize = 16;
/// Turbulence computes once more over every pixel per octave.
pub const MAX_OCTAVES: u32 = 10;
/// The backend reads no SVG nested deeper than this.
const MAX_DEPTH: usize = 256;

/// Why an image is not accepted; the code goes to the web app as
/// `fields.image` to the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    /// Not PNG, JPG, WebP or SVG ("This format isn’t supported").
    Unsupported,
    /// Larger than 1 MB ("The file is larger than 1 MB.").
    TooLarge,
    /// Not readable ("The file couldn’t be read.").
    Unreadable,
    /// More than [`MAX_SIDE`] pixels per side.
    Dimensions,
    /// SVG with text.
    SvgText,
}

impl Rejected {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::TooLarge => "too_large",
            Self::Unreadable => "unreadable",
            Self::Dimensions => "dimensions",
            Self::SvgText => "svg_text",
        }
    }
}

/// Checks a data URL (`data:<mime>;base64,<data>`).
pub fn from_data_url(url: &str) -> Result<Image, Rejected> {
    let rest = url
        .get(..5)
        .filter(|scheme| scheme.eq_ignore_ascii_case("data:"))
        .map(|_| &url[5..])
        .ok_or(Rejected::Unreadable)?;
    let (meta, payload) = rest.split_once(',').ok_or(Rejected::Unreadable)?;
    let mut params = meta.split(';');
    let mime = params.next().unwrap_or_default().trim();
    let declared = Format::of_mime(mime).ok_or(Rejected::Unsupported)?;
    if !params.any(|param| param.trim().eq_ignore_ascii_case("base64")) {
        return Err(Rejected::Unreadable);
    }
    // Before decoding: 4 characters per 3 bytes.
    if payload.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(Rejected::TooLarge);
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| Rejected::Unreadable)?;
    check(declared, data)
}

/// Checks the content; the format follows the content, not the declaration (a
/// wrong extension changes nothing), SVG only if declared as such.
pub fn check(declared: Format, data: Vec<u8>) -> Result<Image, Rejected> {
    if data.len() > MAX_BYTES {
        return Err(Rejected::TooLarge);
    }
    let format = match imagesize::image_type(&data) {
        Ok(imagesize::ImageType::Png) => Format::Png,
        Ok(imagesize::ImageType::Jpeg) => Format::Jpeg,
        Ok(imagesize::ImageType::Webp) => Format::Webp,
        _ if declared == Format::Svg => return svg(&data),
        Ok(_) => return Err(Rejected::Unsupported),
        Err(_) => return Err(Rejected::Unreadable),
    };
    let size = imagesize::blob_size(&data).map_err(|_| Rejected::Unreadable)?;
    if !fits(size) {
        return Err(Rejected::Dimensions);
    }
    if !decodes(format, &data) {
        return Err(Rejected::Unreadable);
    }
    Ok(Image::new(format, data))
}

fn fits(size: imagesize::ImageSize) -> bool {
    (1..=MAX_SIDE).contains(&size.width) && (1..=MAX_SIDE).contains(&size.height)
}

/// Decodes like resvg when drawing; what fails here resvg would not
/// draw.
fn decodes(format: Format, data: &[u8]) -> bool {
    match format {
        Format::Png => resvg::tiny_skia::Pixmap::decode_png(data).is_ok(),
        Format::Jpeg => {
            use zune_jpeg::zune_core::{colorspace::ColorSpace, options::DecoderOptions};
            // The decoder checks the dimensions itself too: imagesize reads them
            // separately and could find different ones in a crafted file.
            let options = DecoderOptions::default()
                .jpeg_set_out_colorspace(ColorSpace::RGBA)
                .set_max_width(MAX_SIDE)
                .set_max_height(MAX_SIDE);
            let mut decoder = zune_jpeg::JpegDecoder::new_with_options(Cursor::new(data), options);
            decoder.decode_headers().is_ok()
                && decoder.output_colorspace() == Some(ColorSpace::RGBA)
                && decoder.decode().is_ok()
        }
        Format::Webp => image_webp::WebPDecoder::new(Cursor::new(data)).is_ok_and(|mut decoder| {
            let (width, height) = decoder.dimensions();
            usize::try_from(width.max(height)).is_ok_and(|side| side <= MAX_SIDE)
                && decoder
                    .output_buffer_size()
                    .is_some_and(|size| decoder.read_image(&mut vec![0; size]).is_ok())
        }),
        Format::Svg => false,
    }
}

/// Reads an SVG with roxmltree: without entities, without text, with its
/// size after resolving `use` ([`expanded`]).
fn document(data: &[u8]) -> Result<(roxmltree::Document<'_>, Size), Rejected> {
    if has_entities(data) {
        return Err(Rejected::Unreadable);
    }
    let text = std::str::from_utf8(data).map_err(|_| Rejected::Unreadable)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let doc = roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|_| Rejected::Unreadable)?;
    if doc
        .descendants()
        .any(|node| node.tag_name().name() == "text" && node.tag_name().namespace() == Some(SVG_NS))
    {
        return Err(Rejected::SvgText);
    }
    let size = expanded(&doc)?;
    Ok((doc, size))
}

/// Whether a stored SVG still fits the upload limits – e.g. one
/// restored from a backup.
pub fn within_limits(data: &[u8]) -> Result<(), Rejected> {
    svg(data).map(drop)
}

/// What the check of nested SVGs collects: the first reason for a
/// rejection and the size of all read so far.
struct Nested {
    problem: Option<Rejected>,
    total: Size,
}

fn svg(data: &[u8]) -> Result<Image, Rejected> {
    let (doc, size) = document(data)?;
    // Nested SVGs follow the same rules; the first reason
    // becomes the response. usvg asks per use, so each counts towards the
    // size – otherwise `use` would multiply a small nested SVG.
    let nested = Arc::new(Mutex::new(Nested {
        problem: None,
        total: size,
    }));
    let options = options_with({
        let nested = nested.clone();
        move |data| {
            let mut nested = nested.lock().unwrap_or_else(PoisonError::into_inner);
            if nested.problem.is_some() {
                return false;
            }
            let result = document(data).and_then(|(_, size)| {
                let total = nested.total.add(size);
                total.fits().then_some(total).ok_or(Rejected::TooLarge)
            });
            match result {
                Ok(total) => {
                    nested.total = total;
                    true
                }
                Err(rejected) => {
                    nested.problem = Some(rejected);
                    false
                }
            }
        }
    });
    let tree = usvg::Tree::from_xmltree(&doc, &options).map_err(|_| Rejected::Unreadable)?;
    if let Some(rejected) = nested
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .problem
    {
        return Err(rejected);
    }
    if !tree.root().has_children() {
        // Nothing to draw, e.g. only external images.
        return Err(Rejected::Unreadable);
    }
    if !images_fit(tree.root()) {
        return Err(Rejected::Dimensions);
    }
    let mut left = MAX_COST;
    render_cost(tree.root(), &mut left)?;
    let clean = tree.to_string(&usvg::WriteOptions::default());
    if clean.len() > MAX_SVG_BYTES {
        return Err(Rejected::TooLarge);
    }
    Ok(Image::new(Format::Svg, clean.into_bytes()))
}

/// Size of an SVG after resolving `use`.
#[derive(Debug, Clone, Copy)]
struct Size {
    elements: usize,
    data: usize,
}

impl Size {
    fn add(self, other: Self) -> Self {
        Self {
            elements: self.elements.saturating_add(other.elements),
            data: self.data.saturating_add(other.data),
        }
    }

    fn max(self, other: Self) -> Self {
        Self {
            elements: self.elements.max(other.elements),
            data: self.data.max(other.data),
        }
    }

    fn fits(self) -> bool {
        self.elements <= MAX_ELEMENTS && self.data <= MAX_DATA
    }
}

/// Size of the document as usvg builds it: every `use` (and `feImage`
/// on an element) counts its target once more. Computed once per
/// element; a reference to itself is unreadable, a marker not
/// supported.
fn expanded(doc: &roxmltree::Document<'_>) -> Result<Size, Rejected> {
    // With duplicate IDs as in usvg: `use` resolves to the first element
    // (when reading the XML). `feImage` takes the last one usvg itself knows
    // (`element_by_id`, without `style` and unknown elements); instead of rebuilding
    // this list, the check counts the largest one there.
    let mut first: HashMap<&str, roxmltree::Node<'_, '_>> = HashMap::new();
    let mut all: HashMap<&str, Vec<roxmltree::Node<'_, '_>>> = HashMap::new();
    for node in doc.descendants().filter(roxmltree::Node::is_element) {
        if let Some(id) = node.attribute("id") {
            first.entry(id).or_insert(node);
            all.entry(id).or_default().push(node);
        }
    }
    let mut walk = Walk {
        first,
        all,
        done: HashMap::new(),
        open: HashSet::new(),
    };
    let size = walk.size(doc.root_element(), 0)?;
    size.fits().then_some(size).ok_or(Rejected::TooLarge)
}

struct Walk<'a, 'input> {
    first: HashMap<&'a str, roxmltree::Node<'a, 'input>>,
    all: HashMap<&'a str, Vec<roxmltree::Node<'a, 'input>>>,
    done: HashMap<roxmltree::NodeId, Size>,
    open: HashSet<roxmltree::NodeId>,
}

impl<'a, 'input> Walk<'a, 'input> {
    fn size(&mut self, node: roxmltree::Node<'a, 'input>, depth: usize) -> Result<Size, Rejected> {
        if let Some(size) = self.done.get(&node.id()) {
            return Ok(*size);
        }
        if depth > MAX_DEPTH || !self.open.insert(node.id()) {
            return Err(Rejected::Unreadable);
        }
        let name = node.tag_name();
        if name.namespace() == Some(SVG_NS) && name.name() == "marker" {
            return Err(Rejected::Unsupported);
        }
        // Like usvg: `href` without prefix before `xlink:href` (SVG 2).
        let href = node
            .attributes()
            .find(|a| a.name() == "href" && a.namespace().is_none())
            .or_else(|| {
                node.attributes()
                    .find(|a| a.name() == "href" && a.namespace() == Some(XLINK_NS))
            })
            .map(|a| a.value());
        let data = ["d", "points"]
            .iter()
            .filter_map(|name| node.attribute(*name))
            .chain(href.filter(|href| href.starts_with("data:")))
            .map(str::len)
            .sum();
        let mut size = Size { elements: 1, data };
        let candidates: Vec<_> = match (name.name(), href.and_then(|h| h.strip_prefix('#'))) {
            ("use", Some(id)) => self.first.get(id).copied().into_iter().collect(),
            ("feImage", Some(id)) => self.all.get(id).cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut target: Option<Size> = None;
        for candidate in candidates {
            let own = self.size(candidate, depth + 1)?;
            target = Some(target.map_or(own, |other| other.max(own)));
        }
        if let Some(target) = target {
            size = size.add(target);
        }
        for child in node.children().filter(roxmltree::Node::is_element) {
            size = size.add(self.size(child, depth + 1)?);
            if !size.fits() {
                return Err(Rejected::TooLarge);
            }
        }
        self.open.remove(&node.id());
        self.done.insert(node.id(), size);
        Ok(size)
    }
}

/// Subtracts the drawing effort from `left`: 1 per shape and image, per
/// filter primitive [`FILTER_COST`] (turbulence per octave); patterns, masks,
/// clip paths and images in filters on every use, as resvg
/// draws them. Morphology, convolution and too many octaves are not
/// supported: their effort per pixel does not depend on the file size.
fn render_cost(group: &usvg::Group, left: &mut usize) -> Result<(), Rejected> {
    use usvg::filter::Kind;
    let spend = |cost: usize, left: &mut usize| {
        *left = left.checked_sub(cost).ok_or(Rejected::TooLarge)?;
        Ok::<_, Rejected>(())
    };
    for filter in group.filters() {
        for primitive in filter.primitives() {
            let cost = match primitive.kind() {
                Kind::Turbulence(turbulence) if turbulence.num_octaves() <= MAX_OCTAVES => {
                    FILTER_COST * turbulence.num_octaves().max(1) as usize
                }
                Kind::Turbulence(_) | Kind::Morphology(_) | Kind::ConvolveMatrix(_) => {
                    return Err(Rejected::Unsupported);
                }
                _ => FILTER_COST,
            };
            spend(cost, left)?;
        }
    }
    for node in group.children() {
        spend(1, left)?;
        if let usvg::Node::Group(child) = node {
            render_cost(child, left)?;
        }
        let mut result = Ok(());
        node.subroots(|root| {
            if result.is_ok() {
                result = render_cost(root, left);
            }
        });
        result?;
    }
    Ok(())
}

/// Raster images in an SVG (also in patterns, masks and nested
/// SVGs) at most [`MAX_SIDE`] pixels per side.
fn images_fit(group: &usvg::Group) -> bool {
    group.children().iter().all(|node| {
        let own = match node {
            usvg::Node::Group(group) => images_fit(group),
            usvg::Node::Image(image) => match image.kind() {
                usvg::ImageKind::JPEG(data)
                | usvg::ImageKind::PNG(data)
                | usvg::ImageKind::GIF(data)
                | usvg::ImageKind::WEBP(data) => imagesize::blob_size(data).is_ok_and(fits),
                usvg::ImageKind::SVG(_) => true,
            },
            _ => true,
        };
        let mut nested = true;
        node.subroots(|root| nested &= images_fit(root));
        own && nested
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_url(mime: &str, data: &[u8]) -> String {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        )
    }

    /// A PNG `width` × `height` (single colour).
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).unwrap();
        pixmap.fill(resvg::tiny_skia::Color::from_rgba8(10, 20, 30, 255));
        pixmap.encode_png().unwrap()
    }

    fn svg_text(image: &Image) -> &str {
        std::str::from_utf8(&image.data).unwrap()
    }

    #[test]
    fn raster_images_by_content() {
        let data = png(4, 2);
        let image = from_data_url(&data_url("image/png", &data)).unwrap();
        assert_eq!(image.format, Format::Png);
        assert_eq!(image.data, data);
        // Wrong declaration, right content: the content counts.
        let image = from_data_url(&data_url("image/jpeg", &data)).unwrap();
        assert_eq!(image.format, Format::Png);
        assert_eq!(
            from_data_url(&data_url("image/png", b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b")),
            Err(Rejected::Unsupported)
        );
        assert_eq!(
            from_data_url(&data_url("image/gif", &data)),
            Err(Rejected::Unsupported)
        );
        assert_eq!(
            from_data_url(&data_url("image/png", b"not an image")),
            Err(Rejected::Unreadable)
        );
        // Header fine, content truncated.
        assert_eq!(
            from_data_url(&data_url("image/png", &data[..data.len() - 20])),
            Err(Rejected::Unreadable)
        );
    }

    #[test]
    fn limits_of_size_and_pixels() {
        assert_eq!(
            check(Format::Png, vec![0; MAX_BYTES + 1]),
            Err(Rejected::TooLarge)
        );
        let huge = "A".repeat(MAX_BYTES / 3 * 4 + 8);
        assert_eq!(
            from_data_url(&format!("data:image/png;base64,{huge}")),
            Err(Rejected::TooLarge)
        );
        assert!(check(Format::Png, png(4096, 1)).is_ok());
        assert_eq!(check(Format::Png, png(4097, 1)), Err(Rejected::Dimensions));
    }

    #[test]
    fn data_urls_only_with_base64() {
        assert_eq!(
            from_data_url("data:image/svg+xml,<svg/>"),
            Err(Rejected::Unreadable)
        );
        assert_eq!(from_data_url("https://x/y.png"), Err(Rejected::Unreadable));
        assert_eq!(
            from_data_url("data:image/png;base64,***"),
            Err(Rejected::Unreadable)
        );
        assert_eq!(
            from_data_url("data:text/html;base64,PGI+"),
            Err(Rejected::Unsupported)
        );
        assert!(from_data_url(&data_url("IMAGE/PNG;charset=x", &png(1, 1))).is_ok());
    }

    #[test]
    fn svg_is_rewritten_without_active_content() {
        let source = br##"<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20" onload="alert(1)">
  <script>alert(2)</script>
  <style>@import url(https://example.test/x.css); rect { fill: #00f }</style>
  <a xlink:href="javascript:alert(3)"><rect width="10" height="10" onclick="alert(4)"/></a>
  <foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <image width="5" height="5" xlink:href="https://example.test/track.png"/>
  <image width="5" height="5" xlink:href="/etc/passwd"/>
  <use xlink:href="https://example.test/sprite.svg#a"/>
  <circle cx="15" cy="15" r="4" fill="url(#g)"/>
  <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
</svg>"##;
        let image = check(Format::Svg, source.to_vec()).unwrap();
        assert_eq!(image.format, Format::Svg);
        let clean = svg_text(&image);
        for gone in [
            "script",
            "alert",
            "onload",
            "onclick",
            "foreignObject",
            "example.test",
            "passwd",
            "@import",
            "javascript",
            "<a",
        ] {
            assert!(!clean.contains(gone), "{gone}: {clean}");
        }
        assert!(clean.contains("<path"), "{clean}");
        assert!(clean.contains("linearGradient"), "{clean}");
        // usvg reads the result again.
        assert!(usvg::Tree::from_str(clean, &crate::logo::options()).is_ok());
    }

    #[test]
    fn svg_keeps_embedded_images_within_limits() {
        let small = data_url("image/png", &png(3, 3));
        let source = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image width="10" height="10" xlink:href="{small}"/></svg>"#
        );
        let image = check(Format::Svg, source.into_bytes()).unwrap();
        assert!(svg_text(&image).contains("data:image/png;base64,"));

        let large = data_url("image/png", &png(4097, 1));
        let source = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><pattern id="p" width="10" height="10"><image width="10" height="10" xlink:href="{large}"/></pattern><rect width="10" height="10" fill="url(#p)"/></svg>"#
        );
        assert_eq!(
            check(Format::Svg, source.into_bytes()),
            Err(Rejected::Dimensions)
        );
    }

    /// An SVG with `inner` as a nested SVG (data URL in `<image>`).
    fn nesting(inner: &str) -> Vec<u8> {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><rect width="10" height="10"/><image width="10" height="10" xlink:href="{}"/></svg>"#,
            data_url("image/svg+xml", inner.as_bytes())
        )
        .into_bytes()
    }

    #[test]
    fn nested_svgs_follow_the_same_rules() {
        let fine =
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><circle r="2"/></svg>"#;
        assert!(check(Format::Svg, nesting(fine)).is_ok());
        let entities = r#"<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><desc>&a;&a;</desc></svg>"#;
        assert_eq!(
            check(Format::Svg, nesting(entities)),
            Err(Rejected::Unreadable)
        );
        let text = r#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><text>Post</text></svg>"#;
        assert_eq!(check(Format::Svg, nesting(text)), Err(Rejected::SvgText));
        // Never with entities when drawing stored images.
        let tree = usvg::Tree::from_data(&nesting(entities), &crate::logo::options()).unwrap();
        assert!(
            tree.root()
                .children()
                .iter()
                .all(|node| !matches!(node, usvg::Node::Image(_)))
        );
    }

    /// Limits on the effort: the check rejects quickly
    /// before usvg multiplies or resvg computes endlessly.
    #[test]
    fn svg_limits_of_effort() {
        let reject = |body: &str| {
            let source = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">{body}</svg>"#
            );
            let started = std::time::Instant::now();
            let result = check(Format::Svg, source.into_bytes()).map(|_| ());
            assert!(started.elapsed().as_secs() < 5, "{body:.80}");
            result
        };
        let filtered = |primitive: &str| {
            reject(&format!(
                r#"<filter id="f">{primitive}</filter><rect width="10" height="10" filter="url(#f)"/>"#
            ))
        };
        // resvg would compute turbulence with 2³² octaves practically forever.
        assert_eq!(
            filtered(r#"<feTurbulence numOctaves="4294967295"/>"#),
            Err(Rejected::Unsupported)
        );
        assert_eq!(
            filtered(r#"<feMorphology radius="4000"/>"#),
            Err(Rejected::Unsupported)
        );
        assert_eq!(
            filtered(r#"<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>"#),
            Err(Rejected::Unsupported)
        );
        assert_eq!(
            filtered(r#"<feTurbulence numOctaves="4"/><feGaussianBlur stdDeviation="2"/>"#),
            Ok(())
        );
        assert_eq!(
            reject(
                r#"<marker id="m"><rect width="1" height="1"/></marker><path d="M0 0L5 5L9 1" marker-mid="url(#m)"/>"#
            ),
            Err(Rejected::Unsupported)
        );

        // `levels` levels with ten `use` each on `leaf` (ID `<prefix>0`).
        let chain = |prefix: &str, leaf: &str, levels: usize| {
            let mut body = format!("<defs>{leaf}");
            for level in 1..=levels {
                body += &format!(r#"<g id="{prefix}{level}">"#);
                for _ in 0..10 {
                    body += &format!(r##"<use href="#{prefix}{}"/>"##, level - 1);
                }
                body += "</g>";
            }
            body + &format!(r##"</defs><use href="#{prefix}{levels}"/>"##)
        };
        // Six levels: a million copies of a path.
        let path = r#"<path id="l0" d="M0 0L1 1L2 0Z"/>"#;
        assert_eq!(reject(&chain("l", path, 6)), Err(Rejected::TooLarge));
        // A nested SVG with a thousand copies, a thousand times outside.
        let inner = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">{}</svg>"#,
            chain("l", path, 3)
        );
        let image = format!(
            r#"<image id="n0" width="10" height="10" href="{}"/>"#,
            data_url("image/svg+xml", inner.as_bytes())
        );
        assert_eq!(reject(&chain("n", &image, 3)), Err(Rejected::TooLarge));
        // Each fits on its own.
        assert_eq!(reject(&chain("l", path, 3)), Ok(()));
        assert_eq!(reject(&image), Ok(()));
        // Duplicate IDs and both `href`: what usvg resolves is counted (the
        // first element, `href` before `xlink:href`). Otherwise the check would count
        // 350 elements, usvg built over 15 000.
        let group = format!(
            r#"<g id="a">{}</g>"#,
            r#"<rect width="1" height="1"/>"#.repeat(50)
        );
        let uses = |attrs: &str| format!("<use {attrs}/>").repeat(300);
        let duplicate = format!(
            r##"<defs>{group}<g id="a"/></defs>{}"##,
            uses(r##"href="#a""##)
        );
        assert_eq!(reject(&duplicate), Err(Rejected::TooLarge));
        let both = format!(
            r##"<defs>{group}<g id="b"/></defs>{}"##,
            uses(r##"href="#a" xlink:href="#b""##)
        );
        assert_eq!(reject(&both), Err(Rejected::TooLarge));
        // With duplicate IDs `feImage` takes the last element: 110 filters with
        // one copy of 100 elements each stay below the drawing effort
        // but not below the element limit.
        let hundred = format!(
            r#"<g id="a">{}</g>"#,
            r#"<rect width="1" height="1"/>"#.repeat(100)
        );
        let (mut filters, mut shapes) = (String::new(), String::new());
        for i in 0..110 {
            filters += &format!(r##"<filter id="f{i}"><feImage href="#a"/></filter>"##);
            shapes += &format!(r#"<rect width="10" height="10" filter="url(#f{i})"/>"#);
        }
        // Also behind a `style` with the same ID that usvg does not know.
        for defs in [
            format!(r#"<g id="a"/>{hundred}"#),
            format!(r#"{hundred}<style id="a"/>"#),
        ] {
            let filtered = format!("<defs>{defs}{filters}</defs>{shapes}");
            assert_eq!(reject(&filtered), Err(Rejected::TooLarge), "{defs:.40}");
        }
        // A `use` on itself.
        assert_eq!(
            reject(r##"<g id="a"><use href="#a"/></g>"##),
            Err(Rejected::Unreadable)
        );
        // More elements than allowed, even without `use`.
        let many = r#"<rect width="1" height="1"/>"#.repeat(MAX_ELEMENTS);
        assert_eq!(reject(&many), Err(Rejected::TooLarge));
        // A pattern is drawn on every use.
        let pattern = format!(
            r#"<defs><pattern id="p" width="1" height="1">{}</pattern></defs>{}"#,
            r#"<rect width="1" height="1"/>"#.repeat(100),
            r#"<rect width="10" height="10" fill="url(#p)"/>"#.repeat(300)
        );
        assert_eq!(reject(&pattern), Err(Rejected::TooLarge));
    }

    #[test]
    fn svg_rejections() {
        let reject = |source: &str| check(Format::Svg, source.as_bytes().to_vec());
        assert_eq!(
            reject(r#"<svg xmlns="http://www.w3.org/2000/svg"><text>Company</text></svg>"#),
            Err(Rejected::SvgText)
        );
        assert_eq!(
            reject(
                r#"<!DOCTYPE svg [<!ENTITY a "aaaaaaaa">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#
            ),
            Err(Rejected::Unreadable)
        );
        assert_eq!(reject("<svg"), Err(Rejected::Unreadable));
        assert_eq!(reject("<html/>"), Err(Rejected::Unreadable));
        assert_eq!(
            reject(
                r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="5" height="5" xlink:href="https://example.test/x.png"/></svg>"#
            ),
            Err(Rejected::Unreadable)
        );
        assert_eq!(
            check(Format::Svg, vec![0xff, 0xfe, 0x00]),
            Err(Rejected::Unreadable)
        );
        // Entities also behind a comment with DOCTYPE.
        assert_eq!(
            reject(
                r#"<!-- <!DOCTYPE x> --><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#
            ),
            Err(Rejected::Unreadable)
        );
        // Read with a byte order mark.
        assert!(
            check(
                Format::Svg,
                "\u{feff}<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"><rect width=\"2\" height=\"2\"/></svg>"
                    .as_bytes()
                    .to_vec()
            )
            .is_ok()
        );
    }
}
