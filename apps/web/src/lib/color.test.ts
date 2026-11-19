import { ACCENTS } from '@roedy/tokens';
import { describe, expect, it } from 'vitest';
import { LIGHT_INK, accentInk, contrast, darkShade, isHexColor, parseHex } from './color.ts';

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
    expect(accentInk('#808080')).toBe('#2b1717');
    // Full saturation: 80 %.
    expect(accentInk('#ff0000')).toBe('#3c0707');
  });

  it('is the light ink on dark colours', () => {
    for (const hex of ['#000000', '#1e3a8a', '#7c3aed', '#0f766e'] as const) {
      expect(accentInk(hex), hex).toBe(LIGHT_INK);
    }
    // The shade keeps the hue: blue stays blue.
    expect(darkShade('#1e3a8a')).toBe('#0a1638');
  });

  it('picks whichever has the higher contrast', () => {
    for (const hex of ['#f5a06e', '#808080', '#7c3aed', '#ff0000', '#1e3a8a', '#ffffff'] as const) {
      const best = Math.max(contrast(hex, darkShade(hex)), contrast(hex, LIGHT_INK));
      expect(contrast(hex, accentInk(hex)), hex).toBe(best);
    }
    for (const { base } of Object.values(ACCENTS)) expect(contrast(base, accentInk(base))).toBeGreaterThan(7);
  });

  it('contrast follows WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});
