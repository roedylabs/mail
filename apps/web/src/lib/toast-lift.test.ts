import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAR_STUCK_MAX, liftOf, TOAST_GAP, toastLift, unsavedBar } from './toast-lift.svelte.ts';

/** Bar with a fixed rectangle in window coordinates (jsdom computes no layout). */
function bar(top: number | (() => number), height: number): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  const y = typeof top === 'number' ? () => top : top;
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ x: 0, y: y(), width: 600, height }),
  );
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('liftOf', () => {
  it('places the toast 12 px above the bar', () => {
    expect(TOAST_GAP).toBe(12);
    // Desktop: bar 54 px high, 24 px above the edge of main, main 16 px above the window edge.
    expect(liftOf({ top: 900 - 16 - 24 - 54, bottom: 900 - 16 - 24, height: 54 }, 900)).toBe(106);
    // Mobile: 8 + 36 + 12 px below the bar, 58 px high.
    expect(liftOf({ top: 844 - 8 - 36 - 12 - 58, bottom: 844 - 56, height: 58 }, 844)).toBe(126);
    // Vacation on mobile: bottom 16 px.
    expect(liftOf({ top: 844 - 8 - 36 - 16 - 58, bottom: 844 - 60, height: 58 }, 844)).toBe(130);
  });

  it('rounds to whole pixels', () => {
    expect(liftOf({ top: 793.4, bottom: 847.4, height: 54 }, 900)).toBe(119);
  });

  it('no distance without a visible bar', () => {
    // hidden (display: none)
    expect(liftOf({ top: 0, bottom: 0, height: 0 }, 900)).toBeNull();
    // below or above the window
    expect(liftOf({ top: 900, bottom: 954, height: 54 }, 900)).toBeNull();
    expect(liftOf({ top: -60, bottom: -6, height: 54 }, 900)).toBeNull();
    // cut off at the top: the toast would end up above the top edge
    expect(liftOf({ top: -10, bottom: 44, height: 54 }, 50)).toBeNull();
  });

  it('lifts only above a bar stuck to the bottom', () => {
    // Short content in a tall window (1440 × 2000): the bar sits in the middle of the window.
    expect(liftOf({ top: 900, bottom: 954, height: 54 }, 2000)).toBeNull();
    // Limit: at most BAR_STUCK_MAX above the bottom edge.
    expect(BAR_STUCK_MAX).toBe(120);
    expect(liftOf({ top: 2000 - 120 - 54, bottom: 2000 - 120, height: 54 }, 2000)).toBe(120 + 54 + 12);
    expect(liftOf({ top: 2000 - 121 - 54, bottom: 2000 - 121, height: 54 }, 2000)).toBeNull();
    // Tablet: 10 px more for safeB.
    expect(liftOf({ top: 834 - 50 - 54, bottom: 834 - 50, height: 54 }, 834)).toBe(116);
  });
});

describe('toastLift', () => {
  it('measures registered bars and forgets them when unregistering', () => {
    vi.stubGlobal('innerHeight', 900);
    expect(toastLift.bottom).toBeNull();
    const off = unsavedBar(bar(806, 54));
    expect(toastLift.bottom).toBe(106);
    if (typeof off === 'function') off();
    expect(toastLift.bottom).toBeNull();
  });

  it('takes the highest of two bars and measures again on scrolling and resizing', async () => {
    vi.stubGlobal('innerHeight', 900);
    let lowTop = 806;
    const low = bar(() => lowTop, 54);
    const offLow = toastLift.add(low);
    const high = bar(780, 54);
    const offHigh = toastLift.add(high);
    expect(toastLift.bottom).toBe(132);
    offHigh();
    expect(toastLift.bottom).toBe(106);

    // The bar moves (sticky) when scrolling: measured again in the next frame.
    lowTop = 760;
    document.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(toastLift.bottom).toBe(152));

    vi.stubGlobal('innerHeight', 920);
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(toastLift.bottom).toBe(172));
    offLow();
    expect(toastLift.bottom).toBeNull();
  });

  it('stops listening to scrolling without bars', async () => {
    vi.stubGlobal('innerHeight', 900);
    const el = bar(806, 54);
    toastLift.add(el)();
    const spy = vi.spyOn(toastLift, 'measure');
    document.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spy).not.toHaveBeenCalled();
  });
});
