import { ACCENTS, ACCENT_TEXT, MODES, type ModeName } from '@roedy/tokens';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '#lib/color-editor.svelte.ts';
import * as exact from '#lib/test/contrast.ts';
import {
  LIGHT_INK,
  MIN_CONTRAST,
  TOAST_HOVER,
  accentInk,
  accentText,
  contrast,
  darkShade,
  isHexColor,
  parseHex,
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

describe('accentText', () => {
  /** `--deep` on `--surface`, `--toastacc` on `--ink` and on its hover surface. */
  function contrasts(hex: HexColor, mode: ModeName) {
    const tokens = MODES[mode];
    const text = accentText(hex, mode);
    const [deep, toast, surface, ink] = [text['--deep'], text['--toastacc'], tokens['--surface'], tokens['--ink']].map(
      exact.hex,
    ) as [exact.Rgb, exact.Rgb, exact.Rgb, exact.Rgb];
    const hover = exact.over(ink, exact.hex(tokens['--inkfg']), TOAST_HOVER);
    return {
      deep: exact.contrast(deep, surface),
      toast: Math.min(exact.contrast(toast, ink), exact.contrast(toast, hover)),
    };
  }

  /** The mix of `ACCENT_TEXT` as in CSS, rounded to 8 bits. */
  function mixed(hex: HexColor, mode: ModeName, name: '--deep' | '--toastacc'): HexColor {
    const mix = ACCENT_TEXT[mode][name];
    const rgb = mix ? exact.mixOklab(exact.hex(hex), exact.hex(mix.toward), mix.share / 100) : exact.hex(hex);
    return `#${rgb
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  }

  for (const mode of ['light', 'dark'] as const) {
    it(`reaches 4.5:1 on every colour of the RGB cube in ${mode} mode`, () => {
      for (const hex of cube(8)) {
        const { deep, toast } = contrasts(hex, mode);
        expect(deep, `${hex} --deep`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(toast, `${hex} --toastacc`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    });

    it(`keeps the mix where it already reaches 4.5:1 in ${mode} mode`, () => {
      for (const [name, { base }] of Object.entries(ACCENTS)) {
        expect(accentText(base, mode), name).toEqual({
          '--deep': mixed(base, mode, '--deep'),
          '--toastacc': mixed(base, mode, '--toastacc'),
        });
      }
    });
  }

  it('moves the lightness only as far as needed, away from the surface', () => {
    // Light mode: the accent itself on the dark `--ink` pill gets lighter.
    const toast = accentText('#808080', 'light')['--toastacc'];
    expect(contrast(toast, '#808080')).toBeLessThan(1.6);
    expect(exact.contrast(exact.hex(toast), exact.hex('#ffffff'))).toBeLessThan(
      exact.contrast(exact.hex('#808080'), exact.hex('#ffffff')),
    );
    // Dark mode: `--deep` of a dark blue on the dark surface gets lighter too.
    const deep = accentText('#1e3a8a', 'dark')['--deep'];
    expect(contrast(deep, MODES.dark['--surface'])).toBeLessThan(MIN_CONTRAST + 0.15);
  });
});
