// Contrast per WCAG 2.2 (relative luminance) and mixing in oklab like
// `color-mix(in oklab, …)` (Bjorn Ottosson, "A perceptual color space for image processing").
// An approximation: the browser rounds intermediate values to 8 bits; measured, this deviates
// by up to about 0.03:1 (checked visually). Tests should therefore keep some distance to the limit.

export type Rgb = [number, number, number];

export const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const unlin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Contrast ratio of two colours (1 to 21). */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const toOklab = (rgb: Rgb): Rgb => {
  const [r, g, b] = rgb.map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([L, a, b]: Rgb): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, unlin(c)))) as Rgb;
};

/** `color-mix(in oklab, a share, b)` with `share` between 0 and 1. */
export function mixOklab(a: Rgb, b: Rgb, share: number): Rgb {
  const [A, B] = [toOklab(a), toOklab(b)];
  return fromOklab(A.map((v, i) => v * share + B[i]! * (1 - share)) as Rgb);
}

/** `top` with opacity `alpha` over `base`, blended in sRGB like in the browser. */
export function over(base: Rgb, top: Rgb, alpha: number): Rgb {
  return base.map((c, i) => c * (1 - alpha) + top[i]! * alpha) as Rgb;
}
