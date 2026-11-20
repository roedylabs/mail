import { afterEach, describe, expect, it, vi } from 'vitest';
import { fold, FOLD_MS, unfold } from './fold.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('fold', () => {
  it('moves the height on measured pixels and ends on its own transitionend', () => {
    const el = document.createElement('div');
    const after = vi.fn();
    fold(el, 0, 120, { ms: FOLD_MS, after });
    expect(el.style.height).toBe('120px');
    expect(el.style.transition).toContain(`height ${FOLD_MS}ms`);
    // Clipped top and bottom only, never at the sides.
    expect(el.style.clipPath).toBe('inset(0px -24px)');
    // Another property's end, or a child's, is not the end.
    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));
    expect(after).not.toHaveBeenCalled();
    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'height' }));
    expect(after).toHaveBeenCalledOnce();
    // Back to the natural height, nothing clipped.
    expect([el.style.height, el.style.clipPath, el.style.transition]).toEqual(['', '', '']);
  });

  it('keeps the end height and clips only the bottom when asked', () => {
    const el = document.createElement('div');
    fold(el, 300, 96, { ms: 0, clip: 'bottom', keep: true });
    expect(el.style.height).toBe('96px');
    expect(el.style.clipPath).toBe('inset(-24px -24px 0px)');
    unfold(el);
    expect([el.style.height, el.style.clipPath]).toEqual(['', '']);
  });

  it('ends by a timer without transitionend, and a new fold stops a running one', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    const first = vi.fn();
    const second = vi.fn();
    fold(el, 0, 100, { ms: FOLD_MS, after: first });
    fold(el, 100, 0, { ms: FOLD_MS, keep: true, after: second });
    vi.advanceTimersByTime(FOLD_MS + 800);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(el.style.height).toBe('0px');
  });
});
