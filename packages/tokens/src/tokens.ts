/**
 * Roedy Mail design tokens: colours, accents, fonts, sizes and motion as
 * TypeScript constants and CSS custom properties. `tokens.css` is generated
 * from them (`pnpm --filter @roedy/tokens build`).
 */

export type ModeName = 'light' | 'dark';
export type CssVars = Readonly<Record<`--${string}`, string>>;

/** Colour modes. */
export const MODES = {
  light: {
    '--cnv': '#f3eee7',
    '--surface': '#fffdfa',
    '--surface2': '#f8f3ec',
    '--sunken': '#efe7dc',
    '--pop': '#fffdfa',
    '--bd': 'rgba(70,45,20,0.09)',
    '--bdhi': 'rgba(70,45,20,0.17)',
    '--fg': '#2b221c',
    '--mfg': '#74665a',
    '--dim': '#918375',
    '--ink': '#2b221c',
    '--inkfg': '#fffaf3',
    '--hov': 'rgba(70,45,20,0.055)',
    '--scrim': 'rgba(43,34,28,0.26)',
    '--danger': '#b3412e',
    '--warn': '#9a5d0a',
    '--star': '#a77000',
    '--sh1': '0 1px 2px rgba(60,35,10,0.06), 0 4px 12px -2px rgba(60,35,10,0.07)',
    '--sh2': '0 2px 4px rgba(60,35,10,0.04), 0 24px 56px -16px rgba(60,35,10,0.2)',
    '--sh3': '0 2px 6px rgba(60,35,10,0.06), 0 40px 90px -24px rgba(60,35,10,0.38)',
    '--sh-edge': 'inset 0 -3px 0 rgba(0,0,0,0.08)',
  },
  dark: {
    '--cnv': '#181411',
    '--surface': '#221d19',
    '--surface2': '#2a241f',
    '--sunken': '#141110',
    '--pop': '#322b25',
    '--bd': 'rgba(255,240,220,0.07)',
    '--bdhi': 'rgba(255,240,220,0.14)',
    '--fg': '#f4ece2',
    '--mfg': '#b3a597',
    '--dim': '#807366',
    '--ink': '#f4ece2',
    '--inkfg': '#221d19',
    '--hov': 'rgba(255,240,220,0.055)',
    '--scrim': 'rgba(0,0,0,0.45)',
    '--danger': '#f0a594',
    '--warn': '#eec27c',
    '--star': '#e3a93a',
    '--sh1': '0 1px 2px rgba(0,0,0,0.3), 0 4px 12px -2px rgba(0,0,0,0.25)',
    '--sh2': '0 2px 4px rgba(0,0,0,0.25), 0 24px 56px -16px rgba(0,0,0,0.55)',
    '--sh3': '0 2px 6px rgba(0,0,0,0.3), 0 40px 90px -24px rgba(0,0,0,0.7)',
    '--sh-edge': 'inset 0 -3px 0 rgba(0,0,0,0.08)',
  },
} as const satisfies Record<ModeName, CssVars>;

/** Accent colours; `base` becomes `--acc`, `ink` becomes `--accink`. */
export const ACCENTS = {
  apricot: { base: '#f5a06e', ink: '#3a1b06' },
  sage: { base: '#94c48d', ink: '#13300f' },
  lavender: { base: '#b0a2f2', ink: '#21134d' },
  sky: { base: '#82bbec', ink: '#0b2a47' },
  rose: { base: '#f097ad', ink: '#4a0f20' },
} as const;
export type AccentName = keyof typeof ACCENTS;

/** Default when neither the user nor the branding sets an accent colour. */
export const DEFAULT_ACCENT: AccentName = 'apricot';

/** Mode without a stored setting. */
export const DEFAULT_MODE: ModeName = 'dark';

/** Colours for accounts and tags: name, fill, text. */
export const MA_COLORS = [
  ['apricot', '#f5a06e', '#3a1b06'],
  ['sage', '#94c48d', '#13300f'],
  ['lilac', '#b0a2f2', '#21134d'],
  ['sky', '#82bbec', '#0b2a47'],
  ['rose', '#f097ad', '#4a0f20'],
  ['honey', '#f2c46b', '#3d2a00'],
] as const;

/** Chip colours. */
export const CHIPS = ['var(--acc)', '#94c48d', '#b0a2f2', '#f2c46b', '#82bbec'] as const;

/** Avatar colours: fill, text. */
export const AV = [
  ['#94c48d', '#13300f'],
  ['#b0a2f2', '#21134d'],
  ['#82bbec', '#0b2a47'],
  ['#f097ad', '#4a0f20'],
  ['#f2c46b', '#3d2a00'],
] as const;

/** Logo plates: fill, text; `null` = accent colour. */
export const PLATES = {
  accent: null,
  light: ['#fffdfa', '#2b221c'],
  dark: ['#2b221c', '#fffaf3'],
} as const;

/**
 * Mode previews on the appearance page: icon, background, panel,
 * lines and text of the mini app in the card. Fixed values because each card
 * shows its own mode, regardless of the active one.
 */
export const MODE_PREV = {
  light: { icon: 'ti-sun', bg: '#f3eee7', panel: '#fffdfa', line: 'rgba(70,45,20,.14)', inkc: '#2b221c' },
  dark: { icon: 'ti-moon', bg: '#181411', panel: '#2a241f', line: 'rgba(255,240,220,.16)', inkc: '#f4ece2' },
  system: {
    icon: 'ti-device-desktop',
    bg: 'linear-gradient(115deg,#f3eee7 0 50%,#181411 50% 100%)',
    panel: 'rgba(150,130,110,.3)',
    line: 'rgba(150,130,110,.45)',
    inkc: '#8a7a6c',
  },
} as const;

/** Font sizes, set as the `font-size` of `<html>`. */
export const FONT_PX = { small: '14px', medium: '16px', large: '18px' } as const;
export type FontSizeName = keyof typeof FONT_PX;
export const DEFAULT_FONT_SIZE: FontSizeName = 'medium';

/** List row height in px per density, as `--rowh`. */
export const DENSITY = { compact: 40, normal: 46, comfortable: 52 } as const;
export type DensityName = keyof typeof DENSITY;
export const DEFAULT_DENSITY: DensityName = 'normal';

/** Width in px below which the mobile variant applies (`MOBILE_BP`), and the narrow desktop view begins (`NARROW`). */
export const MOBILE_BP = 640;
export const NARROW = 1000;

/** Fonts: Nunito Sans (variable, axes opsz and wght) and Young Serif; code and tokens in the system's monospace font. */
export const FONT_SANS = "'Nunito Sans Variable', 'Nunito Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
export const FONT_SERIF = "'Young Serif', Georgia, serif";
export const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Motion with and without animations (`--dur`, `--shim`, `--spin`). */
export const MOTION = {
  on: { '--dur': '220ms', '--shim': 'snShim 1.5s ease-in-out infinite', '--spin': 'snSpin 800ms linear infinite' },
  off: { '--dur': '0ms', '--shim': 'none', '--spin': 'none' },
} as const satisfies Record<'on' | 'off', CssVars>;

/** Text colour from the accent: the accent itself (`null`) or `share` % of it mixed in oklab with `toward`. */
export type AccentMix = { readonly share: number; readonly toward: `#${string}` } | null;

/**
 * Text colours derived from the accent per mode: `--deep` (accent text on
 * `--surface`) and `--toastacc` ("Undo" in the toast on the `--ink` pill).
 * Custom accents compute them in JS from the same mixes (`accentText()` in
 * the web app), named ones use the CSS of `derivedAccentVars()`.
 */
export const ACCENT_TEXT = {
  dark: { '--deep': { share: 80, toward: '#ffffff' }, '--toastacc': { share: 45, toward: '#2b1405' } },
  light: { '--deep': { share: 52, toward: '#2b1405' }, '--toastacc': null },
} as const satisfies Record<ModeName, Record<'--deep' | '--toastacc', AccentMix>>;

/**
 * Share of the accent in percent in `--accsoft` (the accent-tinted surface,
 * mixed in oklab with `--surface`). Custom accents start from it and lower it
 * in JS until text on it reaches 4.5:1 (`accentText()` in the web app).
 */
export const ACCSOFT_SHARE = { dark: 22, light: 26 } as const satisfies Record<ModeName, number>;

const mixCss = (mix: AccentMix) =>
  mix ? `color-mix(in oklab, var(--acc) ${mix.share}%, ${mix.toward})` : 'var(--acc)';

/**
 * Colours derived from accent and mode. They refer to
 * `var(--acc)` so that in CSS they follow the active accent: `--accsoft` mixes
 * with `--surface`, `--deep` and `--toastacc` follow `ACCENT_TEXT`.
 */
export function derivedAccentVars(mode: ModeName): CssVars {
  const text = ACCENT_TEXT[mode];
  return {
    '--accsoft': `color-mix(in oklab, var(--acc) ${ACCSOFT_SHARE[mode]}%, var(--surface))`,
    '--deep': mixCss(text['--deep']),
    '--toastacc': mixCss(text['--toastacc']),
  };
}

/** Keyframes of the app shell. */
export const KEYFRAMES = {
  snFloat: '0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}',
  snPop: 'from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:none}',
  snDlg: 'from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}',
  snFade: 'from{opacity:0}to{opacity:1}',
  snToast: 'from{opacity:0;transform:translate(-50%,20px) scale(.9)}to{opacity:1;transform:translate(-50%,0) scale(1)}',
  snWave:
    '0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-8deg)}60%{transform:rotate(10deg)}80%{transform:rotate(-4deg)}',
  snSheet: 'from{transform:translateY(110%)}to{transform:none}',
  snTipT: 'from{opacity:0;transform:translateY(5px) scale(.9)}to{opacity:1;transform:none}',
  snTipB: 'from{opacity:0;transform:translateY(-5px) scale(.9)}to{opacity:1;transform:none}',
  snTipL: 'from{opacity:0;transform:translateX(5px) scale(.9)}to{opacity:1;transform:none}',
  snTipR: 'from{opacity:0;transform:translateX(-5px) scale(.9)}to{opacity:1;transform:none}',
  snDrawer: 'from{transform:translateX(-105%)}to{transform:none}',
  snRdIn: 'from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:none}',
  snFromL: 'from{opacity:0;transform:translateX(48px)}to{opacity:1;transform:none}',
  snRise: 'from{opacity:0;transform:translateY(36px) scale(.97)}to{opacity:1;transform:none}',
  snShim: '0%,100%{opacity:.5}50%{opacity:1}',
  snSpin: 'to{transform:rotate(360deg)}',
  snBar: '0%{transform:translateX(-110%)}100%{transform:translateX(260%)}',
} as const;
