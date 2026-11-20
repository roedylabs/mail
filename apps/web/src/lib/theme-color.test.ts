import { MODES } from '@roedy/tokens';
import { describe, expect, it } from 'vitest';
import { themeColor } from './theme-color.ts';

describe('themeColor', () => {
  it('follows the canvas of the current mode', () => {
    expect(themeColor(true)).toBe(MODES.dark['--cnv']);
    expect(themeColor(false)).toBe(MODES.light['--cnv']);
    expect(themeColor(true)).not.toBe(themeColor(false));
  });
});
