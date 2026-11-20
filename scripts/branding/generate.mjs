// Branding files of Roedy Mail: app icon, mark, logo with wordmark and social
// preview as SVG and PNG, plus favicon.ico. Everything is drawn from the
// default logo of the app (mark paths of `Logo.svelte`, plate in the apricot
// accent) and the wordmark in Young Serif from crates/server/assets/fonts,
// converted to paths so the SVG files need no font.
//
// Usage (`just branding`): node scripts/branding/generate.mjs [output-dir]
// The output directory defaults to assets/branding; the script replaces its
// `svg/`, `png/` and `favicon.ico` and leaves everything else (README.md).
// Needs `rsvg-convert` (librsvg) on the PATH for the PNG files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const FONT = path.join(REPO, 'crates/server/assets/fonts/YoungSerif-Regular.ttf');

// --- Brand values --------------------------------------------------------------

const PLATE = '#f5a06e'; // apricot accent
const EDGE = '#e19365'; // plate darkened by 8 % (lower edge, like the splash tile)
const INK = '#3a1b06'; // mark on the plate
const LIGHT = { bg: '#f3eee7', fg: '#2b221c', mfg: '#74665a' }; // tokens, light mode
const DARK = { bg: '#181411', fg: '#f4ece2', mfg: '#b3a597' }; // tokens, dark mode
const RADIUS = 0.35; // corners of the plate, share of the edge length
const EDGE_H = 0.075; // height of the lower edge, share of the edge length
const MARK = 0.64; // mark, share of the plate (as in Logo.svelte)
const MASKABLE = 0.78; // safe zone of maskable icons (as in crates/server/src/logo)
const TAGLINE = 'Lightweight self-hosted webmail for Stalwart';

// --- Mark (48 × 48, from apps/web/src/lib/components/Logo.svelte) --------------

export const BACK = 'M18 6h20a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z';
export const FRONT = 'M10 17h22a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V21a4 4 0 0 1 4-4z';
export const FLAP = 'M8.5 20 21 29.5 33.5 20';

/** Mark in a 48 × 48 box; `id` keeps the masks apart when several marks share a file. */
function mark(ink, id = 'm', back = 0.55) {
  const white = '<rect x="-12" y="-12" width="72" height="72" fill="#fff"/>';
  return (
    `<mask id="${id}a">${white}<path d="${FRONT}" stroke="#000" stroke-width="3" stroke-linejoin="round"/></mask>` +
    `<mask id="${id}b">${white}<path d="${FLAP}" fill="none" stroke="#000" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></mask>` +
    `<path d="${BACK}" mask="url(#${id}a)" fill="${ink}" opacity="${back}"/>` +
    `<path d="${FRONT}" mask="url(#${id}b)" fill="${ink}"/>`
  );
}

const n = (v) => +v.toFixed(2);

/** App icon in a box of `s`: plate with lower edge and mark. */
function icon(s, id = 'm') {
  const r = n(s * RADIUS);
  const k = (s * MARK) / 48;
  const at = n((s * (1 - MARK)) / 2);
  return (
    `<clipPath id="${id}p"><rect width="${s}" height="${s}" rx="${r}"/></clipPath>` +
    `<rect width="${s}" height="${s}" rx="${r}" fill="${EDGE}"/>` +
    `<rect width="${s}" height="${n(s * (1 - EDGE_H))}" rx="${r}" fill="${PLATE}" clip-path="url(#${id}p)"/>` +
    `<g transform="translate(${at} ${at}) scale(${n(k)})">${mark(INK, id)}</g>`
  );
}

/** Square plate up to the edge (iOS rounds itself; maskable: mark inside the safe zone). */
function squareIcon(s, scale = 1) {
  const k = (s * MARK * scale) / 48;
  const at = n((s - 48 * k) / 2);
  return `<rect width="${s}" height="${s}" fill="${PLATE}"/><g transform="translate(${at} ${at}) scale(${n(k)})">${mark(INK)}</g>`;
}

/** Silhouette in one colour: plate with the whole mark cut out (system masks, pinned tabs). */
function monoIcon(s, color = '#000') {
  const r = n(s * RADIUS);
  const k = (s * MARK) / 48;
  const at = n((s * (1 - MARK)) / 2);
  return (
    `<mask id="cut"><rect width="${s}" height="${s}" fill="#fff"/>` +
    `<g transform="translate(${at} ${at}) scale(${n(k)})">${mark('#000', 'c', 1)}</g></mask>` +
    `<rect width="${s}" height="${s}" rx="${r}" fill="${color}" mask="url(#cut)"/>`
  );
}

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>\n`;

// --- Young Serif outlines (TrueType glyf, cmap, hmtx and GPOS pair kerning) ----

const font = (() => {
  const b = fs.readFileSync(FONT);
  const tables = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const at = 12 + 16 * i;
    tables[b.toString('latin1', at, at + 4)] = b.readUInt32BE(at + 8);
  }
  const head = tables.head;
  const upm = b.readUInt16BE(head + 18);
  const longLoca = b.readInt16BE(head + 50) === 1;
  const hMetrics = b.readUInt16BE(tables.hhea + 34);
  const os2 = tables['OS/2'];
  const capHeight = b.readInt16BE(os2 + 88);

  // cmap: Windows Unicode BMP (format 4)
  const cmap = tables.cmap;
  let sub = 0;
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const at = cmap + 4 + 8 * i;
    if (b.readUInt16BE(at) === 3 && b.readUInt16BE(at + 2) === 1) sub = cmap + b.readUInt32BE(at + 4);
  }
  if (!sub || b.readUInt16BE(sub) !== 4) throw new Error('font: no cmap format 4');
  const segs = b.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + 2 * segs + 2;
  const deltas = starts + 2 * segs;
  const ranges = deltas + 2 * segs;
  function glyphId(code) {
    for (let i = 0; i < segs; i++) {
      if (code > b.readUInt16BE(ends + 2 * i)) continue;
      const start = b.readUInt16BE(starts + 2 * i);
      if (code < start) return 0;
      const delta = b.readInt16BE(deltas + 2 * i);
      const range = b.readUInt16BE(ranges + 2 * i);
      if (!range) return (code + delta) & 0xffff;
      const g = b.readUInt16BE(ranges + 2 * i + range + 2 * (code - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  }

  const advance = (g) => b.readUInt16BE(tables.hmtx + 4 * Math.min(g, hMetrics - 1));
  const loca = (g) => (longLoca ? b.readUInt32BE(tables.loca + 4 * g) : 2 * b.readUInt16BE(tables.loca + 2 * g));

  /** Contours of a glyph as arrays of {x, y, on}. */
  function contours(g) {
    const at = tables.glyf + loca(g);
    if (loca(g + 1) === loca(g)) return [];
    const count = b.readInt16BE(at);
    if (count < 0) {
      // composite: components with offsets (and optional scale)
      const out = [];
      let p = at + 10;
      for (;;) {
        const flags = b.readUInt16BE(p);
        const part = b.readUInt16BE(p + 2);
        p += 4;
        const words = flags & 1;
        const dx = words ? b.readInt16BE(p) : b.readInt8(p);
        const dy = words ? b.readInt16BE(p + 2) : b.readInt8(p + 1);
        p += words ? 4 : 2;
        let [a, bb, c, d] = [1, 0, 0, 1];
        const f2 = (o) => b.readInt16BE(o) / 16384;
        if (flags & 8) {
          a = d = f2(p);
          p += 2;
        } else if (flags & 0x40) {
          [a, d] = [f2(p), f2(p + 2)];
          p += 4;
        } else if (flags & 0x80) {
          [a, bb, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
          p += 8;
        }
        for (const contour of contours(part))
          out.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: bb * q.x + d * q.y + dy, on: q.on })));
        if (!(flags & 0x20)) return out;
      }
    }
    const endPts = [];
    for (let i = 0; i < count; i++) endPts.push(b.readUInt16BE(at + 10 + 2 * i));
    const total = endPts.at(-1) + 1;
    let p = at + 10 + 2 * count;
    p += 2 + b.readUInt16BE(p);
    const flags = [];
    while (flags.length < total) {
      const f = b[p++];
      flags.push(f);
      if (f & 8) for (let r = b[p++]; r > 0; r--) flags.push(f);
    }
    const coords = (short, same) => {
      let v = 0;
      return flags.map((f) => {
        if (f & short) {
          const d = b[p++];
          v += f & same ? d : -d;
        } else if (!(f & same)) {
          v += b.readInt16BE(p);
          p += 2;
        }
        return v;
      });
    };
    const xs = coords(2, 16);
    const ys = coords(4, 32);
    const out = [];
    let first = 0;
    for (const last of endPts) {
      const contour = [];
      for (let i = first; i <= last; i++) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      out.push(contour);
      first = last + 1;
    }
    return out;
  }

  // GPOS: pair adjustment (lookup type 2, also behind extension type 9) of the feature `kern`
  const kerning = new Map();
  const gpos = tables.GPOS;
  if (gpos) {
    const coverage = (o) => {
      const list = [];
      if (b.readUInt16BE(o) === 1)
        for (let i = 0; i < b.readUInt16BE(o + 2); i++) list.push(b.readUInt16BE(o + 4 + 2 * i));
      else
        for (let i = 0; i < b.readUInt16BE(o + 2); i++) {
          const r = o + 4 + 6 * i;
          for (let g = b.readUInt16BE(r); g <= b.readUInt16BE(r + 2); g++) list.push(g);
        }
      return list;
    };
    const classOf = (o) => {
      const map = new Map();
      if (b.readUInt16BE(o) === 1) {
        const start = b.readUInt16BE(o + 2);
        for (let i = 0; i < b.readUInt16BE(o + 4); i++) map.set(start + i, b.readUInt16BE(o + 6 + 2 * i));
      } else
        for (let i = 0; i < b.readUInt16BE(o + 2); i++) {
          const r = o + 4 + 6 * i;
          for (let g = b.readUInt16BE(r); g <= b.readUInt16BE(r + 2); g++) map.set(g, b.readUInt16BE(r + 4));
        }
      return (g) => map.get(g) ?? 0;
    };
    const bits = (f) => [...Array(8).keys()].filter((i) => f & (1 << i)).length;
    /** x advance of the first value record (bit 2, after x and y placement). */
    const xAdvance = (o, f) => (f & 4 ? b.readInt16BE(o + 2 * bits(f & 3)) : 0);
    const pairs = (st) => {
      const fmt = b.readUInt16BE(st);
      const cov = coverage(st + b.readUInt16BE(st + 2));
      const [f1, f2] = [b.readUInt16BE(st + 4), b.readUInt16BE(st + 6)];
      const size = 2 * (bits(f1) + bits(f2));
      const set = (l, r, v) => v && !kerning.has(`${l},${r}`) && kerning.set(`${l},${r}`, v);
      if (fmt === 1) {
        cov.forEach((l, i) => {
          const ps = st + b.readUInt16BE(st + 10 + 2 * i);
          for (let j = 0; j < b.readUInt16BE(ps); j++) {
            const rec = ps + 2 + j * (2 + size);
            set(l, b.readUInt16BE(rec), xAdvance(rec + 2, f1));
          }
        });
      } else {
        const c1 = classOf(st + b.readUInt16BE(st + 8));
        const c2 = classOf(st + b.readUInt16BE(st + 10));
        const n2 = b.readUInt16BE(st + 14);
        const covered = new Set(cov);
        // only the glyphs of the wordmark and tagline matter
        const glyphs = [...new Set([...`Roedy Mail${TAGLINE}`].map((ch) => glyphId(ch.codePointAt(0))))];
        for (const l of glyphs) {
          if (!covered.has(l)) continue;
          for (const r of glyphs) set(l, r, xAdvance(st + 16 + (c1(l) * n2 + c2(r)) * size, f1));
        }
      }
    };
    const features = gpos + b.readUInt16BE(gpos + 6);
    const lookups = gpos + b.readUInt16BE(gpos + 8);
    const used = new Set();
    for (let i = 0; i < b.readUInt16BE(features); i++) {
      const rec = features + 2 + 6 * i;
      if (b.toString('latin1', rec, rec + 4) !== 'kern') continue;
      const ft = features + b.readUInt16BE(rec + 4);
      for (let j = 0; j < b.readUInt16BE(ft + 2); j++) used.add(b.readUInt16BE(ft + 4 + 2 * j));
    }
    for (const index of [...used].sort((x, y) => x - y)) {
      const lk = lookups + b.readUInt16BE(lookups + 2 + 2 * index);
      const type = b.readUInt16BE(lk);
      for (let j = 0; j < b.readUInt16BE(lk + 4); j++) {
        let st = lk + b.readUInt16BE(lk + 6 + 2 * j);
        if (type === 9) {
          if (b.readUInt16BE(st + 2) !== 2) continue;
          st += b.readUInt32BE(st + 4);
        } else if (type !== 2) continue;
        pairs(st);
      }
    }
  }

  return { upm, capHeight, glyphId, advance, contours, kern: (l, r) => kerning.get(`${l},${r}`) ?? 0 };
})();

/** Text as one SVG path: left edge of the first advance at x, baseline at y. Returns path and width. */
function text(str, size, x, y, fill) {
  const k = size / font.upm;
  const ids = [...str].map((ch) => font.glyphId(ch.codePointAt(0)));
  let pen = 0;
  let d = '';
  const pt = (q) => `${n(x + (pen + q.x) * k)} ${n(y - q.y * k)}`;
  ids.forEach((g, i) => {
    for (const contour of font.contours(g)) {
      const start = contour.findIndex((q) => q.on);
      const seq =
        start < 0
          ? [
              { x: (contour[0].x + contour.at(-1).x) / 2, y: (contour[0].y + contour.at(-1).y) / 2, on: true },
              ...contour,
            ]
          : [...contour.slice(start), ...contour.slice(0, start)];
      d += `M${pt(seq[0])}`;
      let ctrl = null;
      for (let j = 1; j <= seq.length; j++) {
        const q = seq[j % seq.length];
        if (q.on) {
          d += ctrl ? `Q${pt(ctrl)} ${pt(q)}` : `L${pt(q)}`;
          ctrl = null;
        } else {
          if (ctrl) d += `Q${pt(ctrl)} ${pt({ x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2 })}`;
          ctrl = q;
        }
      }
      d += 'Z';
    }
    pen += font.advance(g) + (i + 1 < ids.length ? font.kern(g, ids[i + 1]) : 0);
  });
  return { path: `<path d="${d}" fill="${fill}"/>`, width: pen * k };
}

// --- Compositions --------------------------------------------------------------

/** Horizontal logo: icon and wordmark, the wordmark centred on the icon by its cap height. */
function logo(fg) {
  const s = 120;
  const gap = 32;
  const size = 64;
  const baseline = s / 2 + (font.capHeight * size) / font.upm / 2;
  const word = text('Roedy Mail', size, s + gap, baseline, fg);
  const w = Math.ceil(s + gap + word.width);
  return svg(w, s, icon(s) + word.path);
}

/** Social preview (1200 × 630): icon, wordmark and tagline, centred. */
function social(mode) {
  const [W, H] = [1200, 630];
  const s = 200;
  const name = 96;
  const tag = 36;
  const nameCap = (font.capHeight * name) / font.upm;
  const tagCap = (font.capHeight * tag) / font.upm;
  const block = s + 56 + nameCap + 44 + tagCap;
  const top = (H - block) / 2;
  const nameBase = top + s + 56 + nameCap;
  const tagBase = nameBase + 44 + tagCap;
  const centred = (str, size, base, fill) => {
    const probe = text(str, size, 0, 0, fill).width;
    return text(str, size, (W - probe) / 2, base, fill).path;
  };
  return svg(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="${mode.bg}"/>` +
      `<g transform="translate(${(W - s) / 2} ${n(top)})">${icon(s)}</g>` +
      centred('Roedy Mail', name, nameBase, mode.fg) +
      centred(TAGLINE, tag, tagBase, mode.mfg),
  );
}

// --- Output --------------------------------------------------------------------

/** All SVG files by path below the output directory. */
export function svgFiles() {
  return {
    'svg/icon.svg': svg(512, 512, icon(512)),
    'svg/icon-square.svg': svg(512, 512, squareIcon(512)),
    'svg/icon-maskable.svg': svg(512, 512, squareIcon(512, MASKABLE)),
    'svg/icon-monochrome.svg': svg(512, 512, monoIcon(512)),
    'svg/mark-on-light.svg': svg(48, 48, mark(INK)),
    'svg/mark-on-dark.svg': svg(48, 48, mark(DARK.fg)),
    'svg/logo-on-light.svg': logo(LIGHT.fg),
    'svg/logo-on-dark.svg': logo(DARK.fg),
    'svg/social-light.svg': social(LIGHT),
    'svg/social-dark.svg': social(DARK),
  };
}

/** PNG files: [source SVG, file name, width]. */
const PNGS = [
  ...[16, 32, 48, 64, 128, 192, 256, 512, 1024].map((size) => ['svg/icon.svg', `icon-${size}.png`, size]),
  ['svg/icon-square.svg', 'apple-touch-icon.png', 180],
  ['svg/icon-maskable.svg', 'icon-maskable-192.png', 192],
  ['svg/icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['svg/icon-monochrome.svg', 'icon-monochrome-512.png', 512],
  ['svg/mark-on-light.svg', 'mark-on-light-512.png', 512],
  ['svg/mark-on-dark.svg', 'mark-on-dark-512.png', 512],
  ['svg/logo-on-light.svg', 'logo-on-light.png', 'double'],
  ['svg/logo-on-dark.svg', 'logo-on-dark.png', 'double'],
  ['svg/social-light.svg', 'social-light.png', 1200],
  ['svg/social-dark.svg', 'social-dark.png', 1200],
];

/** Sizes in favicon.ico. */
const ICO = [16, 32, 48, 256];

/** favicon.ico with PNG images (supported since Windows Vista and by every current browser). */
function icoFile(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header[at] = size % 256; // 0 stands for 256
    header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function main(out) {
  for (const old of ['svg', 'png', 'favicon.ico']) fs.rmSync(path.join(out, old), { recursive: true, force: true });
  const files = svgFiles();
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.writeFileSync(path.join(out, file), content);
  }
  fs.mkdirSync(path.join(out, 'png'), { recursive: true });
  for (const [from, to, width] of PNGS) {
    const px = width === 'double' ? 2 * Number(/width="(\d+)"/.exec(files[from])[1]) : width;
    const args = ['--width', String(px), '--keep-aspect-ratio', '-o', path.join(out, 'png', to), path.join(out, from)];
    execFileSync('rsvg-convert', args, { stdio: 'inherit' });
  }
  const images = ICO.map((size) => ({ size, data: fs.readFileSync(path.join(out, 'png', `icon-${size}.png`)) }));
  fs.writeFileSync(path.join(out, 'favicon.ico'), icoFile(images));
  console.log(`Branding files written to ${path.relative(process.cwd(), out) || '.'}`);
}

if (import.meta.main) main(path.resolve(process.argv[2] ?? path.join(REPO, 'assets/branding')));
