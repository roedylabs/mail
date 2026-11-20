/**
 * Custom accent colours: reading and normalising hex input (`parseHex()`),
 * the colour for text and icons on the accent (`accentInk()`) and the
 * colours derived from it (`accentText()`), each text at least `MIN_CONTRAST`.
 * Shared by the theme (`#lib/theme.ts`), the setup and Settings › Appearance.
 */
import { ACCENT_TEXT, ACCSOFT_SHARE, MODES, type AccentMix, type ModeName } from '@roedy/tokens';

/** A colour as `#rrggbb` in lowercase. */
export type HexColor = `#${string}`;

/** Light ink on dark accents (like `--accink` of the named accents, only light). */
export const LIGHT_INK: HexColor = '#fffaf3';

/** Red, green and blue, each 0–255. */
type Rgb = readonly [r: number, g: number, b: number];

/**
 * Reads a hex colour (`#rgb`, `rgb`, `#rrggbb`, `rrggbb`, any case, spaces
 * around it ignored) as `#rrggbb` in lowercase; `null` for anything else.
 */
export function parseHex(value: string): HexColor | null {
  const digits = value.trim().replace(/^#/, '').toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(digits)) return null;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return `#${full}`;
}

/** Whether `value` is a colour as stored: `#rrggbb` in lowercase. */
export function isHexColor(value: unknown): value is HexColor {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
}

function rgbOf(hex: HexColor): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf([r, g, b]: Rgb): HexColor {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Hue in degrees (0–360) and HSV saturation (0–1). */
function hueAndSaturation([r, g, b]: Rgb): [hue: number, saturation: number] {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return [0, 0];
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, delta / max];
}

/** HSL (hue in degrees, saturation and lightness 0–1) to RGB 0–255. */
function fromHsl(hue: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

/** Relative luminance after WCAG 2. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio after WCAG 2 (1–21). */
export function contrast(a: HexColor, b: HexColor): number {
  const [la, lb] = [luminance(rgbOf(a)), luminance(rgbOf(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Dark shade of the hue of `hex`: HSL `lightness` (default 13 %), saturation 30 % + 50 % × its HSV saturation. */
export function darkShade(hex: HexColor, lightness = 0.13): HexColor {
  const [hue, saturation] = hueAndSaturation(rgbOf(hex));
  return hexOf(fromHsl(hue, 0.3 + 0.5 * saturation, lightness));
}

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

/**
 * Ink for text and icons on the accent `hex` (`--accink`): its `darkShade()`
 * or `LIGHT_INK`, whichever has the higher contrast. Below `MIN_CONTRAST` the
 * dark shade gets darker in steps of 0.5 % lightness (down to 0 %) until it
 * reaches it; on very dark colours where even that fails, white.
 */
export function accentInk(hex: HexColor): HexColor {
  const dark = darkShade(hex);
  const best = contrast(hex, dark) >= contrast(hex, LIGHT_INK) ? dark : LIGHT_INK;
  if (contrast(hex, best) >= MIN_CONTRAST) return best;
  // Lightness in half percent: 13 % is 26.
  for (let step = 25; step >= 0; step--) {
    const shade = darkShade(hex, step / 200);
    if (contrast(hex, shade) >= MIN_CONTRAST) return shade;
  }
  return '#ffffff';
}

// OKLab after Björn Ottosson, like `color-mix(in oklab, …)` in the browser.

type Lab = readonly [l: number, a: number, b: number];

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to RGB 0–255, clipped to the sRGB gamut. */
function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => fromLinear(Math.min(1, Math.max(0, c)))) as unknown as Rgb;
}

function rgbContrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Share of `--inkfg` in the hover surface of "Undo" in the toast (`Toast.svelte`, `.undo:hover`). */
export const TOAST_HOVER = 0.08;

/** Steps of the OKLab lightness (0–1) when a derived text colour has to move. */
const LIGHTNESS_STEP = 0.005;

/**
 * `mix` of the accent (like its `color-mix()` in CSS), then its OKLab
 * lightness moved in small steps towards the side with more contrast until it
 * reaches `MIN_CONTRAST` on every surface.
 */
function textOn(accent: Rgb, mix: AccentMix, surfaces: readonly Rgb[]): HexColor {
  const base = toOklab(accent);
  const lab = mix ? mixLab(base, toOklab(rgbOf(mix.toward)), mix.share / 100) : base;
  const fits = (rgb: Rgb) => surfaces.every((surface) => rgbContrast(rgb, surface) >= MIN_CONTRAST);
  const [surface] = surfaces as [Rgb];
  const lighter = rgbContrast([255, 255, 255], surface) >= rgbContrast([0, 0, 0], surface);
  let rgb = rgbOf(hexOf(fromOklab(lab)));
  for (let l = lab[0]; !fits(rgb) && (lighter ? l < 1 : l > 0);) {
    l = lighter ? Math.min(1, l + LIGHTNESS_STEP) : Math.max(0, l - LIGHTNESS_STEP);
    rgb = rgbOf(hexOf(fromOklab([l, lab[1], lab[2]])));
  }
  return hexOf(rgb);
}

function mixLab(a: Lab, b: Lab, share: number): Lab {
  return [0, 1, 2].map((i) => a[i]! * share + b[i]! * (1 - share)) as unknown as Lab;
}

/**
 * `--accsoft`: `start` % of the accent mixed in oklab with `surface` (like its
 * `color-mix()` in CSS), the share lowered in steps of 1 % until every colour
 * of `texts` reaches `MIN_CONTRAST` on it; at 0 % the surface itself.
 */
function softOn(accent: Rgb, surface: Rgb, start: number, texts: readonly Rgb[]): Rgb {
  const [a, s] = [toOklab(accent), toOklab(surface)];
  for (let share = start; share > 0; share--) {
    const rgb = rgbOf(hexOf(fromOklab(mixLab(a, s, share / 100))));
    if (texts.every((text) => rgbContrast(text, rgb) >= MIN_CONTRAST)) return rgb;
  }
  return surface;
}

/** Colours a custom accent derives per mode (`accentText()`). */
export type AccentText = Record<'--accsoft' | '--deep' | '--toastacc', HexColor>;

/**
 * Derived colours of a custom accent in `mode`: `--accsoft` with
 * `ACCSOFT_SHARE` of the accent or less, so that `--mfg` and `--danger` reach
 * `MIN_CONTRAST` on it, and the mixes of `ACCENT_TEXT`, each moved to
 * `MIN_CONTRAST` on its surfaces — `--deep` on `--surface` and on that
 * `--accsoft`, `--toastacc` on `--ink` and on its hover surface
 * (`TOAST_HOVER` of `--inkfg` over `--ink`).
 */
export function accentText(hex: HexColor, mode: ModeName): AccentText {
  const tokens = MODES[mode];
  const accent = rgbOf(hex);
  const surface = rgbOf(tokens['--surface']);
  const soft = softOn(accent, surface, ACCSOFT_SHARE[mode], [rgbOf(tokens['--mfg']), rgbOf(tokens['--danger'])]);
  const ink = rgbOf(tokens['--ink']);
  const inkfg = rgbOf(tokens['--inkfg']);
  const hover = ink.map((c, i) => c * (1 - TOAST_HOVER) + inkfg[i]! * TOAST_HOVER) as unknown as Rgb;
  return {
    '--accsoft': hexOf(soft),
    '--deep': textOn(accent, ACCENT_TEXT[mode]['--deep'], [surface, soft]),
    '--toastacc': textOn(accent, ACCENT_TEXT[mode]['--toastacc'], [ink, hover]),
  };
}

/** Background of the always dark terminal in the setup token step (`StepToken.svelte`, `--t-bg`). */
export const TERMINAL_BG: HexColor = '#1b1612';

/** Steps of the share of white in `terminalAccent()` (percent). */
const TERMINAL_STEP = 2;

/**
 * Colour of the program names in the terminal (`StepToken.svelte`): the
 * accent `hex` mixed in oklab with white (like `color-mix()` in CSS), the
 * share of white raised in steps of `TERMINAL_STEP` % until it reaches
 * `MIN_CONTRAST` on `TERMINAL_BG`. The named accents and most light colours
 * already do, unchanged; black needs the most (60 %).
 */
export function terminalAccent(hex: HexColor): HexColor {
  const [accent, white, bg] = [toOklab(rgbOf(hex)), toOklab([255, 255, 255]), rgbOf(TERMINAL_BG)];
  for (let share = 0; share < 100; share += TERMINAL_STEP) {
    const rgb = rgbOf(hexOf(fromOklab(mixLab(white, accent, share / 100))));
    if (rgbContrast(rgb, bg) >= MIN_CONTRAST) return hexOf(rgb);
  }
  return '#ffffff';
}
