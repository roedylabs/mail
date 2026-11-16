/**
 * HTML of an email for the sandbox iframe of the reading view. DOMPurify sanitizes the HTML parts (HTML only,
 * without forms, media and embedded documents; it removes scripts and event
 * attributes itself), links open in a new tab. Images from foreign servers
 * (`src`, `srcset`, `background`, `url()` in `style`) stay only with
 * permission (`remote`); otherwise they live in `data-ext-src`, and blocked
 * `<img>` become tiles (dimensions from the attributes, otherwise 120 px
 * high), tracking pixels disappear. `cid:` images show the blob URLs of their
 * parts. The result is a document of its own with a CSP and the message
 * colours (`rd.tv`); the CSP additionally blocks everything the sanitizing
 * misses.
 */
import DOMPurify from 'dompurify';
import type { ReadTheme } from '#lib/message-view.ts';
import { cidKey } from './parts.ts';

export interface RenderOptions {
  /** Load images from foreign servers (`extMode`, `extAllow`). */
  remote: boolean;
  /** Blob URLs of embedded images by content ID (`cidKey`). */
  cids: ReadonlyMap<string, string>;
  /** Colours of the message. */
  theme: ReadTheme;
  /** Padding of the content (desktop or mobile). */
  padding: string;
  /** Label of the tile of a blocked image ("Image blocked"). */
  blockedLabel: string;
}

export interface RenderedMail {
  /** Complete document for the iframe. */
  html: string;
  /** Blocked images and tracking pixels from foreign servers (distinct addresses) for the banner. */
  blocked: number;
}

/** Elements an email does not need: forms and media that load on their own. */
const FORBID_TAGS = [
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'output',
  'audio',
  'video',
  'source',
  'track',
];

/** `ping` loads on click; only the sanitizing sets `data-ext-src` (otherwise the email would turn images into tiles). */
const FORBID_ATTR = ['ping', 'data-ext-src'];

/** Dimensions up to which an image counts as a tracking pixel (not as a tile). */
const PIXEL = 2;

/** Tiles below these dimensions show only the icon. */
const SMALL_W = 96;
const SMALL_H = 64;

/** Height of a tile without a known height. */
const FREE_H = 120;

/** Icon `ti-photo-off` (Tabler Icons, MIT) for the tiles. */
const PHOTO_OFF =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15 8h.01"/><path d="M7 3h11a3 3 0 0 1 3 3v11m-.856 3.099a2.991 2.991 0 0 1 -2.144 .901h-12a3 3 0 0 1 -3 -3v-12c0 -.845 .349 -1.608 .91 -2.153"/>' +
  '<path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M16.33 12.338c.574 -.054 1.155 .166 1.67 .662l3 3"/><path d="M3 3l18 18"/></svg>';

/** Running sanitization (the hooks hang on the shared DOMPurify instance). */
interface Pass {
  remote: boolean;
  cids: ReadonlyMap<string, string>;
  blocked: Set<string>;
}

let pass: Pass | null = null;
let purifier: ReturnType<typeof DOMPurify> | null = null;

type Target = { kind: 'remote' | 'keep'; url: string } | { kind: 'drop' };

/**
 * Target of an image address: foreign servers (`http:` becomes `https:`,
 * otherwise the CSP blocks it), `cid:` as a blob URL, `data:image/…` stays,
 * everything else is dropped (relative addresses have no base in the `blob:` document).
 */
function target(raw: string, cids: ReadonlyMap<string, string>): Target {
  // Like the URL parser: tab and line break are dropped, as are control characters and spaces at the edges.
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (/^https?:/i.test(v)) return { kind: 'remote', url: v.replace(/^http:/i, 'https:') };
  if (v.startsWith('//')) return { kind: 'remote', url: `https:${v}` };
  if (/^cid:/i.test(v)) {
    const url = cids.get(cidKey(v.slice(4)));
    return url ? { kind: 'keep', url } : { kind: 'drop' };
  }
  if (/^data:image\//i.test(v)) return { kind: 'keep', url: v };
  return { kind: 'drop' };
}

/**
 * Pixels per `vh` in the email's CSS (based on 800 px height): the iframe
 * follows the content; with real viewport units a block with `100vh` would
 * grow with it, and whatever follows would end up below the edge.
 */
const VH_PX = 8;

/**
 * Rewrite addresses in `url(…)`; blocked ones become `none`. Comments,
 * `@import` and `@font-face` are dropped (the CSP blocks external fonts and
 * stylesheets anyway, even after permission), so that the banner only
 * counts images. Viewport heights (`vh`, `svh`, `lvh`, `dvh`) become pixels
 * (`VH_PX`); addresses in `url(…)` stay untouched.
 */
function rewriteCss(css: string, p: Pass): string {
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}?/gi, '')
    .replace(
      /url\(\s*(["']?)(.*?)\1\s*\)|(?<![\w.])(\d*\.?\d+)[sdl]?vh\b/gis,
      (match, _q, raw?: string, vh?: string) => {
        if (vh !== undefined) return `${+(Number(vh) * VH_PX).toFixed(2)}px`;
        if (raw === undefined) return match;
        const t = target(raw, p.cids);
        if (t.kind === 'drop') return 'none';
        if (t.kind === 'remote' && !p.remote) {
          p.blocked.add(t.url);
          return 'none';
        }
        return `url("${t.url.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")`;
      },
    );
}

/** Candidates of `srcset` (HTML, "parse a srcset attribute", simplified): address and descriptor. */
export function srcsetCandidates(srcset: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
    const start = i;
    while (i < srcset.length && !/\s/.test(srcset[i]!)) i++;
    let url = srcset.slice(start, i);
    if (!url) break;
    if (url.endsWith(',')) {
      // Candidate without a descriptor.
      out.push({ url: url.replace(/,+$/, ''), descriptor: '' });
      continue;
    }
    const descStart = i;
    let depth = 0;
    while (i < srcset.length && (depth > 0 || srcset[i] !== ',')) {
      if (srcset[i] === '(') depth++;
      else if (srcset[i] === ')') depth = Math.max(0, depth - 1);
      i++;
    }
    url = url.trim();
    out.push({ url, descriptor: srcset.slice(descStart, i).trim() });
  }
  return out;
}

/** `srcset` with allowed candidates, otherwise `null`. */
function rewriteSrcset(candidates: { url: string; descriptor: string }[], p: Pass): string | null {
  const out: string[] = [];
  for (const { url, descriptor } of candidates) {
    const t = target(url, p.cids);
    if (t.kind === 'drop' || (t.kind === 'remote' && !p.remote)) continue;
    out.push(descriptor ? `${t.url} ${descriptor}` : t.url);
  }
  return out.length ? out.join(', ') : null;
}

function rewriteElement(el: Element, p: Pass): void {
  const tag = el.localName;
  if (tag === 'img') {
    const src = el.getAttribute('src');
    const srcset = el.getAttribute('srcset');
    el.removeAttribute('srcset');
    const t = src !== null ? target(src, p.cids) : null;
    if (t?.kind === 'remote' && !p.remote) {
      p.blocked.add(t.url);
      el.removeAttribute('src');
      el.setAttribute('data-ext-src', t.url);
    } else if (t?.kind === 'drop') el.removeAttribute('src');
    else if (t) el.setAttribute('src', t.url);
    if (srcset !== null) {
      const candidates = srcsetCandidates(srcset);
      const kept = rewriteSrcset(candidates, p);
      if (kept) el.setAttribute('srcset', kept);
      else if (!t || t.kind === 'drop') {
        // Image only from `srcset`: when blocked, the first foreign candidate counts.
        const first = target(candidates[0]?.url ?? '', p.cids);
        if (first.kind === 'remote' && !p.remote) {
          p.blocked.add(first.url);
          el.setAttribute('data-ext-src', first.url);
        }
      }
    }
    el.setAttribute('referrerpolicy', 'no-referrer');
  }
  const background = el.getAttribute('background');
  if (background !== null) {
    const t = target(background, p.cids);
    if (t.kind === 'remote' && !p.remote) {
      p.blocked.add(t.url);
      el.removeAttribute('background');
      el.setAttribute('data-ext-src', t.url);
    } else if (t.kind === 'drop') el.removeAttribute('background');
    else el.setAttribute('background', t.url);
  }
  const style = el.getAttribute('style');
  if (style !== null && /url\(|@import|@font-face|vh\b/i.test(style)) el.setAttribute('style', rewriteCss(style, p));
  if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
    if ((el.getAttribute('href') ?? '').startsWith('#')) el.removeAttribute('target');
    else {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

const COMMENT_MARKERS = ['<!--', '-->', '--!>'] as const;

/**
 * Removes `<!--`, `-->` and `--!>` until none are left, in linear time: a removal can join
 * its neighbours into a new marker (`<<!---->!--`), which always ends at the top of the stack.
 */
function stripCommentMarkers(css: string): string {
  const out: string[] = [];
  for (let i = 0; i < css.length; i++) {
    out.push(css.charAt(i));
    for (const marker of COMMENT_MARKERS) {
      const start = out.length - marker.length;
      if (start >= 0 && out.slice(start).join('') === marker) {
        out.length = start;
        break;
      }
    }
  }
  return out.join('');
}

function instance(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'style' || !pass) return;
    // `<!-- … -->` around old stylesheets: meaningless for CSS, but would look like markup to DOMPurify.
    node.textContent = rewriteCss(stripCommentMarkers(node.textContent ?? ''), pass);
  });
  p.addHook('afterSanitizeAttributes', (node) => {
    if (pass && node.nodeType === 1) rewriteElement(node, pass);
  });
  return (purifier = p);
}

/** Pixel size from `width`/`height` or the inline style; `null` if unknown (percent, `auto`). */
function sizeOf(img: Element, dim: 'width' | 'height'): number | null {
  const attr = img.getAttribute(dim)?.trim() ?? '';
  const style = new RegExp(`(?:^|;)\\s*${dim}\\s*:\\s*([\\d.]+)px`, 'i').exec(img.getAttribute('style') ?? '');
  const raw = /^\d+(\.\d+)?(px)?$/i.test(attr) ? attr : style?.[1];
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Name of the tile: last path segment of the address, otherwise the server. */
function nameOf(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.host;
  } catch {
    return url;
  }
}

/** Placeholder with the image's dimensions: the tile shrinks like an image (in tables, `max-width`). */
function spacer(doc: Document, w: number, h: number): HTMLImageElement {
  const img = doc.createElement('img');
  img.alt = '';
  img.width = w;
  img.height = h;
  img.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}`;
  return img;
}

/**
 * Replace blocked `<img>` with tiles: with width and height in aspect ratio
 * with a label (class `r`, below `SMALL_W` × `SMALL_H` only the
 * icon, class `s`), with width 120 px high (`n`), otherwise full width and
 * 120 px high (`f`). Style, classes, `hidden` and `align` of the
 * image carry over, so that hidden images (variants for mobile and desktop)
 * stay hidden and floated ones stay floated.
 */
function replaceBlocked(body: HTMLElement, label: string): void {
  const doc = body.ownerDocument;
  for (const img of body.querySelectorAll('img[data-ext-src]')) {
    const w = sizeOf(img, 'width');
    const h = sizeOf(img, 'height');
    if ((w !== null && w <= PIXEL) || (h !== null && h <= PIXEL)) {
      img.remove();
      continue;
    }
    const tile = doc.createElement('rm-blocked');
    tile.setAttribute('role', 'img');
    tile.setAttribute('aria-label', label);
    const inner = doc.createElement('rm-in');
    inner.innerHTML = PHOTO_OFF;
    let kind: 'r' | 's' | 'n' | 'f' = 'f';
    if (w !== null) {
      kind = h === null ? 'n' : w < SMALL_W || h < SMALL_H ? 's' : 'r';
      tile.append(spacer(doc, w, h ?? FREE_H));
    }
    tile.className = [kind, img.getAttribute('class') ?? ''].join(' ').trim();
    const align = img.getAttribute('align')?.toLowerCase();
    const float = align === 'left' || align === 'right' ? `float:${align};` : '';
    const style = float + (img.getAttribute('style') ?? '');
    if (style) tile.setAttribute('style', style);
    if (img.hasAttribute('hidden')) tile.setAttribute('hidden', '');
    if (kind === 'r') {
      const text = doc.createElement('rm-label');
      text.textContent = label;
      inner.append(text);
    }
    if (kind !== 's') {
      const name = doc.createElement('rm-name');
      name.textContent = nameOf(img.getAttribute('data-ext-src') ?? '');
      inner.append(name);
    }
    tile.append(inner);
    img.replaceWith(tile);
  }
}

/**
 * Base style of the document: message colours, font, tiles. The content lives in `rm-mail` (padding, measuring the
 * height, shrinking); the email's stylesheets do not hit this element,
 * nor their usual resets of `html` and `body`. Links in the browser's
 * colours for the scheme. The padding holds the margins at the start and
 * end.
 */
function baseCss(theme: ReadTheme, padding: string): string {
  return `:root{color-scheme:${theme.scheme};--fg:${theme.fg};--mfg:${theme.mfg};--bdhi:${theme.bdhi};--surface:${theme.surface}}
html{background:transparent;overflow-y:hidden}
body{margin:0;color:var(--fg);font:15.5px/1.6 -apple-system,'Segoe UI',Helvetica,sans-serif;overflow-wrap:break-word}
rm-mail{display:flow-root;padding:${padding}}
:where(rm-mail>:first-child,rm-mail>:first-child>:first-child){margin-top:0}
:where(rm-mail>:last-child,rm-mail>:last-child>:last-child){margin-bottom:0}
img{max-width:100%}
img[width]{height:auto}
rm-blocked{position:relative;display:inline-block;max-width:100%;vertical-align:middle;color:var(--mfg);text-align:center;font:12.5px/1.3 -apple-system,'Segoe UI',Helvetica,sans-serif}
rm-blocked>img{display:block}
rm-blocked.f{display:block;width:100%;height:${FREE_H}px}
rm-in{position:absolute;inset:0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px;border:1.5px dashed var(--bdhi);border-radius:12px;background:var(--surface);overflow:hidden}
rm-in svg{flex-shrink:0}
rm-blocked.n rm-in,rm-blocked.f rm-in{gap:6px;padding:8px 12px}
rm-blocked.s rm-in{padding:2px}
rm-blocked.s svg{flex-shrink:1;width:min(24px,100%);height:min(24px,100%)}
rm-label{font-weight:700}
rm-name{display:block;width:0;min-width:100%;font:11.5px/1.3 ui-monospace,'SF Mono',Menlo,monospace;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
rm-blocked.n rm-name,rm-blocked.f rm-name{opacity:1}`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sanitizes HTML and builds the document for the iframe. */
export function renderMail(html: string, options: RenderOptions): RenderedMail {
  const purify = instance();
  const current: Pass = { remote: options.remote, cids: options.cids, blocked: new Set() };
  pass = current;
  let body: HTMLElement;
  try {
    // With `RETURN_DOM`, DOMPurify returns the `body` of its inert document (including sanitized attributes).
    body = purify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      FORCE_BODY: true,
      RETURN_DOM: true,
    }) as HTMLElement;
  } finally {
    pass = null;
  }
  replaceBlocked(body, options.blockedLabel);
  // The email's stylesheets go into the head: they apply there just the same, and `rm-mail>:first-child` hits the content.
  const sheets = [...body.querySelectorAll('style')].map((el) => {
    el.remove();
    return el.outerHTML;
  });
  // Attributes of the email's `body` (`bgcolor`, `style`, `class` …) stay on the document's `body`.
  const attrs = [...body.attributes].map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
  const csp = `default-src 'none'; img-src data: blob:${options.remote ? ' https:' : ''}; style-src 'unsafe-inline'`;
  return {
    html:
      '<!doctype html><html><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      '<meta name="referrer" content="no-referrer">' +
      `<style>${baseCss(options.theme, options.padding)}</style>${sheets.join('')}</head>` +
      `<body${attrs}><rm-mail>${body.innerHTML}</rm-mail></body></html>`,
    blocked: current.blocked.size,
  };
}
