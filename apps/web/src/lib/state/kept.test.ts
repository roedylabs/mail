import { describe, expect, it, vi } from 'vitest';
import { forgetRegistered } from '#lib/state/forget.ts';
import { KEPT_WAIT_MS, Kept } from '#lib/state/kept.ts';

describe('Kept', () => {
  it('keeps the data of the last page until the session ends', () => {
    const kept = new Kept<string[]>();
    expect(kept.value).toBeNull();
    kept.keeper()(['a']);
    kept.keeper()(['b']);
    expect(kept.value).toEqual(['b']);
    forgetRegistered();
    expect(kept.value).toBeNull();
  });

  it('a page opened before the session ended keeps nothing afterwards', () => {
    const kept = new Kept<string>();
    const before = kept.keeper();
    kept.forget();
    before('old');
    expect(kept.value).toBeNull();
    kept.keeper()('new');
    expect(kept.value).toBe('new');
  });

  it('waits for calls of other pages, also failed ones, until the session ends', async () => {
    const kept = new Kept<string>();
    const left = {};
    const open = {};
    let done = () => {};
    let failed = () => {};
    kept.track(new Promise<void>((resolve) => (done = resolve)), left);
    kept.track(new Promise<void>((_, reject) => (failed = () => reject(new Error('x')))), left);
    // Its own calls: right away.
    let own = false;
    void kept.after(left, () => Promise.resolve((own = true)));
    expect(own).toBe(true);
    let through = false;
    const load = kept.after(open, () => {
      through = true;
      return Promise.resolve(1);
    });
    done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(through).toBe(false);
    failed();
    expect(await load).toBe(1);
    kept.track(new Promise(() => {}), left);
    kept.forget();
    // Without calls right away.
    let now = false;
    void kept.after(open, () => Promise.resolve((now = true)));
    expect(now).toBe(true);
  });

  it('loads anyway after `KEPT_WAIT_MS` if a call hangs', async () => {
    vi.useFakeTimers();
    try {
      const kept = new Kept<string>();
      kept.track(new Promise(() => {}), {});
      let through = false;
      const load = kept.after({}, () => Promise.resolve((through = true)));
      await vi.advanceTimersByTimeAsync(KEPT_WAIT_MS - 1);
      expect(through).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await load;
      expect(through).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
