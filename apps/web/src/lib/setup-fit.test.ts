import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { SetupFit } from './setup-fit.svelte.ts';

/** Page whose content is `content` px high in a window of `height` px. */
function page() {
  const root = {
    content: 500,
    height: 800,
    get scrollHeight() {
      return Math.max(this.content, this.height);
    },
    get clientHeight() {
      return this.height;
    },
  };
  const fit = new SetupFit({
    root: () => root as unknown as HTMLElement,
    card: () => undefined,
    levels: () => 7,
    columns: true,
  });
  return { root, fit };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SetupFit', () => {
  it('refits after gradual resizing of 1 px steps', async () => {
    const { root, fit } = page();
    fit.relayout(1280, 800);
    await settle();
    expect(fit.level).toBe(0);
    // The window gets lower 1 px at a time until the content no longer fits.
    for (let h = 799; h >= 480; h--) {
      root.height = h;
      fit.resize(1280, h);
      flushSync();
      await settle();
    }
    expect(fit.h).toBe(480);
    expect(fit.level).toBe(6);
  });

  it('finds the same level for a size however the window got there', async () => {
    const { root, fit } = page();
    // Loaded in a low window: the content does not fit, the densest level.
    root.height = 480;
    fit.relayout(1280, 480);
    await settle();
    expect(fit.level).toBe(6);
    // The window grows until the content fits again: level 0, as on a fresh load at that size.
    root.height = 520;
    fit.resize(1280, 520);
    await settle();
    expect(fit.level).toBe(0);
  });

  it('takes the current page size on a relayout without one', async () => {
    const { root, fit } = page();
    root.height = 480;
    fit.relayout(1280, 480);
    await settle();
    expect(fit.level).toBe(6);
    // The page grew, but no resize was observed yet (hidden page): a change of language refits on the real size.
    root.height = 800;
    fit.relayout();
    await settle();
    expect([fit.h, fit.level]).toEqual([800, 0]);
  });

  it('ignores a small resize that crosses no threshold, but keeps the size', async () => {
    const { fit } = page();
    fit.relayout(1280, 800);
    await settle();
    fit.resize(1283, 802);
    expect([fit.w, fit.h, fit.level]).toEqual([1283, 802, 0]);
  });

  it('switches to mobile across 520 px even by a few pixels', async () => {
    const { fit } = page();
    fit.relayout(522, 800);
    await settle();
    expect(fit.mobile).toBe(false);
    fit.resize(519, 800);
    expect(fit.mobile).toBe(true);
  });

  it('keeps its level while held and refits once released if the size changed meanwhile', async () => {
    const { root, fit } = page();
    fit.relayout(1280, 800);
    await settle();
    fit.hold(true);
    root.height = 480;
    fit.resize(1280, 480);
    fit.relayout();
    await settle();
    expect([fit.h, fit.level]).toEqual([800, 0]);
    fit.hold(false);
    await settle();
    expect(fit.h).toBe(480);
    expect(fit.level).toBeGreaterThan(0);
  });

  it('refits when a web font finishes loading after fonts.ready', async () => {
    const { root, fit } = page();
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const had = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      // Fallback fonts: the content is too high, the card takes a denser level.
      root.content = 900;
      const stop = fit.observe(root as unknown as HTMLElement);
      await settle();
      expect(fit.level).toBeGreaterThan(0);
      // The web font arrives later and the content fits again.
      root.content = 500;
      fonts.dispatchEvent(new Event('loadingdone'));
      await settle();
      expect(fit.level).toBe(0);
      stop();
      root.content = 900;
      fonts.dispatchEvent(new Event('loadingdone'));
      await settle();
      expect(fit.level).toBe(0);
    } finally {
      if (had) Object.defineProperty(document, 'fonts', had);
      else delete (document as { fonts?: unknown }).fonts;
      vi.unstubAllGlobals();
    }
  });

  it('does not refit on release without a change', async () => {
    const { fit } = page();
    fit.relayout(1280, 800);
    await settle();
    fit.hold(true);
    fit.resize(1280, 800);
    fit.hold(false);
    expect([fit.w, fit.h, fit.level]).toEqual([1280, 800, 0]);
  });
});
