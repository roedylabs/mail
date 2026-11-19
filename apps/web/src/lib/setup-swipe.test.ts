import { describe, expect, it } from 'vitest';
import { swipeGoes, swipeOffset, swipeProgress } from './setup-swipe.ts';

describe('setup swipe back', () => {
  it('goes back from 30 % of the width or a flick', () => {
    expect(swipeGoes(118, 0, 390)).toBe(true);
    expect(swipeGoes(116, 0, 390)).toBe(false);
    expect(swipeGoes(50, 0.4, 390)).toBe(true);
    expect(swipeGoes(40, 0.9, 390)).toBe(false);
    expect(swipeGoes(50, 0.3, 390)).toBe(false);
  });

  it('follows to the right, a rubber band to the left', () => {
    expect(swipeOffset(80)).toBe(80);
    expect(swipeOffset(-20)).toBe(-10);
    expect(swipeProgress(0, 390)).toBe(0);
    expect(swipeProgress(117, 390)).toBe(1);
    expect(swipeProgress(500, 390)).toBe(1);
  });
});
