import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
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
});
