/**
 * Custom accent colours: reading and normalising hex input (`parseHex()`) and
 * the colour for text and icons on the accent (`accentInk()`). Shared by the
 * theme (`#lib/theme.ts`), the setup and Settings › Appearance.
 */

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

/** Dark shade of the hue of `hex`: HSL lightness 13 %, saturation 30 % + 50 % × its HSV saturation. */
export function darkShade(hex: HexColor): HexColor {
  const [hue, saturation] = hueAndSaturation(rgbOf(hex));
  return hexOf(fromHsl(hue, 0.3 + 0.5 * saturation, 0.13));
}

/**
 * Ink for text and icons on the accent `hex` (`--accink`): its `darkShade()`
 * or `LIGHT_INK`, whichever has the higher contrast.
 */
export function accentInk(hex: HexColor): HexColor {
  const dark = darkShade(hex);
  return contrast(hex, dark) >= contrast(hex, LIGHT_INK) ? dark : LIGHT_INK;
}
