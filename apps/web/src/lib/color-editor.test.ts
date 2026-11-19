import { describe, expect, it } from 'vitest';
import { contrast, isHexColor } from '#lib/color.ts';
import {
  ColorDraft,
  LOW_CONTRAST,
  PRESETS,
  SURFACE_DARK,
  SURFACE_LIGHT,
  customName,
  gridMove,
  lowContrast,
  placePopover,
  presetOf,
} from './color-editor.svelte.ts';

describe('Presets', () => {
  it('has 18 distinct colours that stand out in both themes', () => {
    expect(PRESETS).toHaveLength(18);
    expect(new Set(PRESETS.map(([, hex]) => hex)).size).toBe(18);
    for (const [, hex] of PRESETS) {
      expect(isHexColor(hex)).toBe(true);
      expect(lowContrast(hex)).toBeNull();
    }
  });

  it('names a custom colour after its preset, otherwise by its code', () => {
    expect(presetOf('#78c895')).toBe('mint');
    expect(presetOf('#123456')).toBeUndefined();
    expect(customName('#78c895')).toBe('Mint');
    expect(customName('#4a7bd0')).toBe('Custom #4A7BD0');
  });
});

describe('Contrast hints', () => {
  it('flags colours below 1.6 : 1 against a surface, the dark one first', () => {
    expect(lowContrast('#f5a06e')).toBeNull();
    expect(lowContrast('#333333')).toBe('dark');
    expect(lowContrast('#fafafa')).toBe('light');
    expect(contrast('#333333', SURFACE_DARK)).toBeLessThan(LOW_CONTRAST);
    expect(contrast('#fafafa', SURFACE_LIGHT)).toBeLessThan(LOW_CONTRAST);
  });
});

describe('Grid keys', () => {
  it('moves through six columns, stops at the ends, Home and End jump', () => {
    expect(gridMove('ArrowRight', 5, 18)).toBe(6);
    expect(gridMove('ArrowLeft', 0, 18)).toBe(0);
    expect(gridMove('ArrowDown', 1, 18)).toBe(7);
    expect(gridMove('ArrowDown', 15, 18)).toBe(17);
    expect(gridMove('ArrowUp', 3, 18)).toBe(0);
    expect(gridMove('ArrowRight', 17, 18)).toBe(17);
    expect(gridMove('Home', 9, 18)).toBe(0);
    expect(gridMove('End', 2, 18)).toBe(17);
    expect(gridMove('a', 2, 18)).toBeNull();
  });
});

describe('Draft', () => {
  it('starts with the colour in upper case', () => {
    const draft = new ColorDraft('#f5a06e');
    expect([draft.hex, draft.text, draft.valid, draft.note]).toEqual(['#f5a06e', '#F5A06E', true, null]);
  });

  it('normalises valid input and shows the error only once the field was left', () => {
    const fresh = new ColorDraft('#f5a06e');
    fresh.input('#12');
    expect(fresh.note).toBeNull();
    fresh.blur();
    expect(fresh.note).toBe('invalid');
    const draft = new ColorDraft('#f5a06e');
    draft.input('abc');
    expect([draft.hex, draft.text]).toEqual(['#aabbcc', 'abc']);
    draft.blur();
    expect(draft.text).toBe('#AABBCC');
    // Once left, the field reports invalid input while typing.
    draft.input('#12345');
    expect(draft.valid).toBe(false);
    expect(draft.note).toBe('invalid');
    // The swatch keeps the last valid colour.
    expect(draft.hex).toBe('#aabbcc');
    draft.blur();
    expect(draft.text).toBe('#12345');
    // A preset clears the error.
    draft.pick('#8ea6ee');
    expect([draft.hex, draft.text, draft.note]).toEqual(['#8ea6ee', '#8EA6EE', null]);
  });

  it('keeps at most seven characters', () => {
    const draft = new ColorDraft('#f5a06e');
    draft.input('#4a7bd0ff');
    expect(draft.text).toBe('#4a7bd0');
    expect(draft.hex).toBe('#4a7bd0');
  });

  it('hints at low contrast for a valid colour (neutral, not an error)', () => {
    const draft = new ColorDraft('#f5a06e');
    draft.input('#333');
    expect(draft.note).toBe('dark');
    draft.input('fafafa');
    expect(draft.note).toBe('light');
  });

  it('applies a valid colour, otherwise shows the error', () => {
    const draft = new ColorDraft('#f5a06e');
    draft.input('xyz');
    expect(draft.apply()).toBeNull();
    expect(draft.note).toBe('invalid');
    draft.input('4A7BD0');
    expect(draft.apply()).toBe('#4a7bd0');
  });
});

describe('Popover placement', () => {
  const box = { width: 1000, height: 800 };

  it('sits above the swatch with its right edge there', () => {
    expect(placePopover(box, { top: 600, bottom: 660, right: 700 }, 400)).toEqual({
      left: 366,
      top: 190,
      width: 340,
      maxHeight: 776,
      origin: 'bottom right',
    });
  });

  it('goes below without room above, centred without room either side', () => {
    expect(placePopover(box, { top: 100, bottom: 160, right: 700 }, 400)).toMatchObject({
      top: 170,
      origin: 'top right',
    });
    expect(placePopover({ width: 1000, height: 500 }, { top: 200, bottom: 260, right: 700 }, 400)).toMatchObject({
      top: 50,
      origin: 'bottom right',
    });
  });

  it('never leaves the window', () => {
    const narrow = placePopover({ width: 300, height: 400 }, { top: 300, bottom: 350, right: 120 }, 900);
    expect(narrow).toMatchObject({ left: 12, width: 276, maxHeight: 376, top: 12 });
    expect(placePopover(box, { top: 600, bottom: 660, right: 995 }, 400).left).toBe(648);
  });

  it('sits in the middle without a swatch', () => {
    expect(placePopover(box, null, 400)).toEqual({ left: 330, top: 200, width: 340, maxHeight: 776, origin: 'center' });
  });
});
