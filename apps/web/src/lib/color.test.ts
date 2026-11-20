import { ACCENTS, ACCENT_TEXT, ACCSOFT_SHARE, MODES, type ModeName } from '@roedy/tokens';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '#lib/color-editor.svelte.ts';
import * as exact from '#lib/test/contrast.ts';
import {
  LIGHT_INK,
  MIN_CONTRAST,
  TERMINAL_BG,
  TOAST_HOVER,
  accentInk,
  accentText,
  contrast,
  darkShade,
  isHexColor,
  parseHex,
  terminalAccent,
  type HexColor,
} from './color.ts';

/** Every colour of the RGB cube in steps of `step` per channel, plus 255. */
function* cube(step: number): Generator<HexColor> {
  const values = [...Array.from({ length: Math.ceil(256 / step) }, (_, i) => i * step), 255];
  for (const r of values) {
    for (const g of values) {
      for (const b of values) {
        yield `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      }
    }
  }
}

/** The rule before #164: dark shade at 13 % or `LIGHT_INK`, whichever contrasts more. */
const previousInk = (hex: HexColor) =>
  contrast(hex, darkShade(hex)) >= contrast(hex, LIGHT_INK) ? darkShade(hex) : LIGHT_INK;

describe('parseHex', () => {
  it('reads short and long hex colours with or without # in any case', () => {
    for (const input of ['#f5a06e', 'f5a06e', '#F5A06E', 'F5a06E', '  #f5a06e ']) {
      expect(parseHex(input), input).toBe('#f5a06e');
    }
    for (const input of ['#abc', 'abc', '#ABC', 'aBc']) {
      expect(parseHex(input), input).toBe('#aabbcc');
    }
    expect(parseHex('#000')).toBe('#000000');
  });

  it('rejects everything else', () => {
    for (const input of [
      '',
      '#',
      '##abc',
      '#ab',
      '#abcd',
      '#abcde',
      '#abcdefa',
      '#ggg',
      'apricot',
      'rgb(1,2,3)',
      '# abc',
    ]) {
      expect(parseHex(input), input).toBeNull();
    }
  });

  it('isHexColor accepts the stored form only', () => {
    expect(isHexColor('#f5a06e')).toBe(true);
    for (const value of ['#F5A06E', 'f5a06e', '#abc', 'sky', null, 3]) expect(isHexColor(value)).toBe(false);
  });
});

describe('accentInk', () => {
  it('is the dark shade of the hue on light colours', () => {
    // Close to the hand-picked inks of the named accents.
    expect(accentInk('#f5a06e')).toBe('#341c0e');
    expect(accentInk('#82bbec')).toBe('#102233');
    expect(accentInk('#94c48d')).toBe('#163013');
    // Without saturation: 30 % saturation at hue 0.
    expect(accentInk('#ffffff')).toBe('#2b1717');
    // Full saturation: 80 %, half: 55 %.
    expect(darkShade('#ff0000')).toBe('#3c0707');
    expect(accentInk('#ff7f7f')).toBe('#330f0f');
  });

  it('is the light ink on dark colours', () => {
    for (const hex of ['#000000', '#1e3a8a', '#7c3aed', '#0f766e'] as const) {
      expect(accentInk(hex), hex).toBe(LIGHT_INK);
    }
    // The shade keeps the hue: blue stays blue.
    expect(darkShade('#1e3a8a')).toBe('#0a1638');
  });

  it('picks whichever has the higher contrast', () => {
    for (const hex of ['#f5a06e', '#7c3aed', '#ff7f7f', '#1e3a8a', '#ffffff'] as const) {
      const best = Math.max(contrast(hex, darkShade(hex)), contrast(hex, LIGHT_INK));
      expect(contrast(hex, accentInk(hex)), hex).toBe(best);
    }
    for (const { base } of Object.values(ACCENTS)) expect(contrast(base, accentInk(base))).toBeGreaterThan(7);
  });

  it('darkens the shade in steps of 0.5 % until it reaches 4.5:1 on mid tones', () => {
    // 13 %: 4.3:1, light ink 3.8:1.
    expect(accentInk('#808080')).toBe(darkShade('#808080', 0.105));
    expect(contrast('#808080', accentInk('#808080'))).toBeCloseTo(4.53, 2);
    expect(contrast('#808080', darkShade('#808080', 0.11))).toBeLessThan(MIN_CONTRAST);
    // The worst case before: 3.35:1.
    expect(accentInk('#889000')).toBe(darkShade('#889000', 0.08));
    expect(contrast('#889000', accentInk('#889000'))).toBeCloseTo(4.51, 2);
    expect(contrast('#889000', darkShade('#889000', 0.085))).toBeLessThan(MIN_CONTRAST);
    // Pure red at 13 %: 4.29:1.
    expect(contrast('#ff0000', accentInk('#ff0000'))).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('keeps the light ink on black and falls back to white where even a black shade fails', () => {
    expect(accentInk('#000000')).toBe(LIGHT_INK);
    // Light ink 4.49:1, black 4.47:1.
    const between = [...cube(4)].find(
      (hex) => contrast(hex, LIGHT_INK) < MIN_CONTRAST && contrast(hex, '#000000') < MIN_CONTRAST,
    );
    expect(between).toBeDefined();
    expect(accentInk(between!)).toBe('#ffffff');
  });

  it('gives the 18 presets and the named accents the same ink as before', () => {
    for (const [name, hex] of PRESETS) expect(accentInk(hex), name).toBe(previousInk(hex));
    for (const [name, { base }] of Object.entries(ACCENTS)) expect(accentInk(base), name).toBe(previousInk(base));
  });

  it('reaches 4.5:1 on every colour of the RGB cube', () => {
    for (const hex of cube(8)) {
      expect(exact.contrast(exact.hex(hex), exact.hex(accentInk(hex))), hex).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it('contrast follows WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});

/** Rounded to 8 bits as `#rrggbb`, like a colour set as a custom property. */
const hexOfExact = (rgb: exact.Rgb): HexColor =>
  `#${rgb
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

describe('accentText', () => {
  /**
   * `--deep` on `--surface` and on `--accsoft`, `--mfg` and `--danger` on
   * `--accsoft`, `--toastacc` on `--ink` and on its hover surface.
   */
  function contrasts(hex: HexColor, mode: ModeName) {
    const tokens = MODES[mode];
    const text = accentText(hex, mode);
    const [deep, soft, toast, surface, ink, mfg, danger] = [
      text['--deep'],
      text['--accsoft'],
      text['--toastacc'],
      tokens['--surface'],
      tokens['--ink'],
      tokens['--mfg'],
      tokens['--danger'],
    ].map(exact.hex) as [exact.Rgb, exact.Rgb, exact.Rgb, exact.Rgb, exact.Rgb, exact.Rgb, exact.Rgb];
    const hover = exact.over(ink, exact.hex(tokens['--inkfg']), TOAST_HOVER);
    return {
      deep: exact.contrast(deep, surface),
      deepSoft: exact.contrast(deep, soft),
      mfgSoft: exact.contrast(mfg, soft),
      dangerSoft: exact.contrast(danger, soft),
      toast: Math.min(exact.contrast(toast, ink), exact.contrast(toast, hover)),
    };
  }

  /** The mix of `ACCENT_TEXT` as in CSS, rounded to 8 bits. */
  function mixed(hex: HexColor, mode: ModeName, name: '--deep' | '--toastacc'): HexColor {
    const mix = ACCENT_TEXT[mode][name];
    return hexOfExact(mix ? exact.mixOklab(exact.hex(hex), exact.hex(mix.toward), mix.share / 100) : exact.hex(hex));
  }

  /** `--accsoft` with `share` % of the accent, rounded to 8 bits. */
  const soft = (hex: HexColor, mode: ModeName, share: number) =>
    hexOfExact(exact.mixOklab(exact.hex(hex), exact.hex(MODES[mode]['--surface']), share / 100));

  for (const mode of ['light', 'dark'] as const) {
    it(`reaches 4.5:1 on every colour of the RGB cube in ${mode} mode`, () => {
      for (const hex of cube(8)) {
        const { deep, deepSoft, mfgSoft, dangerSoft, toast } = contrasts(hex, mode);
        expect(deep, `${hex} --deep`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(deepSoft, `${hex} --deep on --accsoft`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(mfgSoft, `${hex} --mfg on --accsoft`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(dangerSoft, `${hex} --danger on --accsoft`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(toast, `${hex} --toastacc`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    });

    it(`keeps the mixes where they already reach 4.5:1 in ${mode} mode`, () => {
      for (const [name, { base }] of Object.entries(ACCENTS)) {
        expect(accentText(base, mode), name).toEqual({
          '--accsoft': soft(base, mode, ACCSOFT_SHARE[mode]),
          '--deep': mixed(base, mode, '--deep'),
          '--toastacc': mixed(base, mode, '--toastacc'),
        });
      }
    });

    it(`keeps the 18 presets at 4.5:1 on --accsoft in ${mode} mode`, () => {
      for (const [name, hex] of PRESETS) {
        const { deep, deepSoft, mfgSoft, dangerSoft } = contrasts(hex, mode);
        for (const [what, value] of Object.entries({ deep, deepSoft, mfgSoft, dangerSoft })) {
          expect(value, `${name} ${what}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        }
      }
    });
  }

  it('lowers the share of --accsoft in steps of 1 % only as far as needed', () => {
    // Raspberry at 26 %: `--danger` 4.31:1.
    const share = [...Array(27).keys()].reverse().find((s) => {
      const surface = exact.hex(soft('#e8798f', 'light', s));
      return [MODES.light['--mfg'], MODES.light['--danger']].every(
        (text) => exact.contrast(exact.hex(text), surface) >= MIN_CONTRAST,
      );
    })!;
    expect(share).toBeLessThan(ACCSOFT_SHARE.light);
    expect(accentText('#e8798f', 'light')['--accsoft']).toBe(soft('#e8798f', 'light', share));
    // Black in light mode drops furthest (6 %), a pale cyan in dark mode to 17 %.
    expect(accentText('#000000', 'light')['--accsoft']).toBe(soft('#000000', 'light', 6));
    expect(accentText('#e0f0f0', 'dark')['--accsoft']).toBe(soft('#e0f0f0', 'dark', 17));
    // Dark blue on the dark surface keeps 22 %.
    expect(accentText('#1e3a8a', 'dark')['--accsoft']).toBe(soft('#1e3a8a', 'dark', ACCSOFT_SHARE.dark));
  });

  it('moves the lightness only as far as needed, away from the surface', () => {
    // Light mode: the accent itself on the dark `--ink` pill gets lighter.
    const toast = accentText('#808080', 'light')['--toastacc'];
    expect(contrast(toast, '#808080')).toBeLessThan(1.6);
    expect(exact.contrast(exact.hex(toast), exact.hex('#ffffff'))).toBeLessThan(
      exact.contrast(exact.hex('#808080'), exact.hex('#ffffff')),
    );
    // Dark mode: `--deep` of a dark blue gets lighter too, until it reaches 4.5:1 on the
    // dark `--surface` and on its `--accsoft`, whichever is harder.
    const text = accentText('#1e3a8a', 'dark');
    const lowest = Math.min(
      contrast(text['--deep'], MODES.dark['--surface']),
      contrast(text['--deep'], text['--accsoft']),
    );
    expect(lowest).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(lowest).toBeLessThan(MIN_CONTRAST + 0.15);
  });
});

describe('named accents on --accsoft (CSS mixes)', () => {
  /** `color-mix(in oklab, accent share, toward)` as in `tokens.css`. */
  const mix = (base: HexColor, share: number, toward: string) =>
    exact.mixOklab(exact.hex(base), exact.hex(toward), share / 100);

  for (const mode of ['light', 'dark'] as const) {
    it(`keeps --deep, --mfg and --danger at 4.5:1 on --accsoft in ${mode} mode`, () => {
      const tokens = MODES[mode];
      const deepMix = ACCENT_TEXT[mode]['--deep'];
      for (const [name, { base }] of Object.entries(ACCENTS)) {
        const soft = mix(base, ACCSOFT_SHARE[mode], tokens['--surface']);
        const deep = mix(base, deepMix.share, deepMix.toward);
        // Some distance to the limit: the browser rounds intermediate values (`#lib/test/contrast.ts`).
        expect(exact.contrast(deep, soft), `${name} --deep`).toBeGreaterThanOrEqual(MIN_CONTRAST + 0.1);
        expect(
          exact.contrast(deep, exact.hex(tokens['--surface'])),
          `${name} --deep on --surface`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST + 0.1);
        for (const text of ['--mfg', '--danger'] as const) {
          expect(exact.contrast(exact.hex(tokens[text]), soft), `${name} ${text}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        }
      }
    });
  }

  it('lifts Sage above 4.5:1 with 52 % accent in the light --deep', () => {
    const { base } = ACCENTS.sage;
    const soft = mix(base, ACCSOFT_SHARE.light, MODES.light['--surface']);
    expect(exact.contrast(mix(base, 55, '#2b1405'), soft)).toBeLessThan(MIN_CONTRAST);
    expect(exact.contrast(mix(base, 52, '#2b1405'), soft)).toBeGreaterThanOrEqual(4.6);
  });
});

describe('terminalAccent', () => {
  const bg = exact.hex(TERMINAL_BG);

  it('is the terminal background of the setup token step', () => {
    expect(TERMINAL_BG).toBe('#1b1612');
  });

  it('mixes 36 % white into #1e3a8a', () => {
    expect(terminalAccent('#1e3a8a')).toBe('#6880b6');
    expect(exact.contrast(exact.hex('#6880b6'), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    // One step of 2 % less stays below 4.5:1.
    expect(exact.contrast(exact.mixOklab(exact.hex('#ffffff'), exact.hex('#1e3a8a'), 0.34), bg)).toBeLessThan(
      MIN_CONTRAST,
    );
  });

  it('needs 60 % white for black', () => {
    expect(terminalAccent('#000000')).toBe('#808080');
    expect(exact.contrast(exact.hex('#808080'), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(exact.contrast(exact.mixOklab(exact.hex('#ffffff'), exact.hex('#000000'), 0.58), bg)).toBeLessThan(
      MIN_CONTRAST,
    );
  });

  it('keeps the named accents and light colours unchanged', () => {
    for (const [name, { base }] of Object.entries(ACCENTS)) expect(terminalAccent(base), name).toBe(base);
    for (const hex of ['#ffffff', '#f5a06e', '#e8798f', '#78c895'] as const) expect(terminalAccent(hex), hex).toBe(hex);
  });

  it('reaches 4.5:1 on the terminal for every colour of the RGB cube', () => {
    for (const hex of cube(8)) {
      expect(exact.contrast(exact.hex(terminalAccent(hex)), bg), hex).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
});

describe('--deep on the light terminal card (--surface2)', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`reaches 4.5:1 on --surface2 for every colour of the RGB cube in ${mode} mode`, () => {
      const card = exact.hex(MODES[mode]['--surface2']);
      for (const hex of cube(8)) {
        const deep = exact.hex(accentText(hex, mode)['--deep']);
        expect(exact.contrast(deep, card), hex).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    });
  }

  it('keeps the named accents’ light --deep on --surface2 (CSS mix, 5.19–5.60 : 1)', () => {
    const { share, toward } = ACCENT_TEXT.light['--deep'];
    const card = exact.hex(MODES.light['--surface2']);
    for (const [name, { base }] of Object.entries(ACCENTS)) {
      const deep = exact.mixOklab(exact.hex(base), exact.hex(toward), share / 100);
      expect(exact.contrast(deep, card), name).toBeGreaterThanOrEqual(5.1);
    }
  });

  it('gives Sage’s light --deep #636a46 for "Setup-Token" on the card', () => {
    expect(accentText(ACCENTS.sage.base, 'light')['--deep']).toBe('#636a46');
    expect(exact.contrast(exact.hex('#636a46'), exact.hex(MODES.light['--surface2']))).toBeGreaterThanOrEqual(5.1);
  });
});

describe('flag star (--star) at 3:1 on its surfaces', () => {
  /** Non-text contrast of a state icon (WCAG 1.4.11). */
  const ICON_CONTRAST = 3;
  /**
   * With some distance to the limit: the browser rounds `color-mix()` and the `--hov` overlay to 8 bits
   * (`#lib/test/contrast.ts`); with `#aa7300` the model said 3.02:1 on Lavender's hovered `--accsoft`,
   * the browser 2.99:1.
   */
  const MIN_ICON = ICON_CONTRAST + 0.1;

  /** `--hov` (`rgba(…)`) over `base`, blended in sRGB like in the browser. */
  function hovered(base: exact.Rgb, mode: ModeName): exact.Rgb {
    const [r, g, b, alpha] = MODES[mode]['--hov'].match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
    return exact.over(base, [r / 255, g / 255, b / 255], alpha);
  }

  /** Contrast of `--star` on `surface` and on `--hov` over it. */
  function onSurface(surface: exact.Rgb, mode: ModeName) {
    const star = exact.hex(MODES[mode]['--star']);
    return Math.min(exact.contrast(star, surface), exact.contrast(star, hovered(surface, mode)));
  }

  for (const mode of ['light', 'dark'] as const) {
    it(`reaches 3:1 on --surface, --surface2 and --cnv with and without --hov in ${mode} mode`, () => {
      const tokens = MODES[mode];
      for (const name of ['--surface', '--surface2', '--cnv'] as const) {
        expect(onSurface(exact.hex(tokens[name]), mode), name).toBeGreaterThanOrEqual(MIN_ICON);
      }
      // Compact list: the hovered star button (`--hov`) in a hovered row (`--hov` over `--surface`).
      const twice = hovered(exact.hex(tokens['--surface']), mode);
      expect(onSurface(twice, mode), '--hov twice over --surface').toBeGreaterThanOrEqual(MIN_ICON);
    });

    it(`reaches 3:1 on --accsoft of the named accents with and without --hov in ${mode} mode`, () => {
      const surface = exact.hex(MODES[mode]['--surface']);
      for (const [name, { base }] of Object.entries(ACCENTS)) {
        const soft = exact.mixOklab(exact.hex(base), surface, ACCSOFT_SHARE[mode] / 100);
        expect(onSurface(soft, mode), name).toBeGreaterThanOrEqual(MIN_ICON);
      }
    });

    it(`reaches 3:1 on --accsoft of custom accents with and without --hov in ${mode} mode`, () => {
      for (const hex of [...cube(16), ...PRESETS.map(([, preset]) => preset)]) {
        const soft = exact.hex(accentText(hex, mode)['--accsoft']);
        expect(onSurface(soft, mode), hex).toBeGreaterThanOrEqual(MIN_ICON);
      }
    });
  }

  it('keeps the amber in dark mode, which misses 3:1 on the light --surface', () => {
    expect(MODES.dark['--star']).toBe('#e3a93a');
    const surface = exact.hex(MODES.light['--surface']);
    expect(exact.contrast(exact.hex(MODES.dark['--star']), surface)).toBeLessThan(ICON_CONTRAST);
  });
});
