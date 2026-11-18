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
    const late = vi.fn();
    const left = {};
    const open = {};
    let done = () => {};
    let failed = () => {};
    kept.track(new Promise<void>((resolve) => (done = resolve)), left);
    kept.track(new Promise<void>((_, reject) => (failed = () => reject(new Error('x')))), left);
    // Its own calls: right away.
    let own = false;
    void kept.after(left, () => Promise.resolve((own = true)), late);
    expect(own).toBe(true);
    let through = false;
    const load = kept.after(
      open,
      () => {
        through = true;
        return Promise.resolve(1);
      },
      late,
    );
    done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(through).toBe(false);
    failed();
    expect(await load).toBe(1);
    kept.track(new Promise(() => {}), left);
    kept.forget();
    // Without calls right away.
    let now = false;
    void kept.after(open, () => Promise.resolve((now = true)), late);
    expect(now).toBe(true);
    // Through before the wait ran out: no second load.
    expect(late).not.toHaveBeenCalled();
  });

  it('loads again for each call through after the wait, also while another one hangs', async () => {
    vi.useFakeTimers();
    try {
      const kept = new Kept<string>();
      let done = () => {};
      let failed = () => {};
      kept.track(new Promise(() => {}), {});
      kept.track(new Promise<void>((resolve) => (done = resolve)), {});
      kept.track(new Promise<void>((_, reject) => (failed = () => reject(new Error('x')))), {});
      const late = vi.fn();
      const load = kept.after({}, () => Promise.resolve(1), late);
      await vi.advanceTimersByTimeAsync(KEPT_WAIT_MS);
      expect(await load).toBe(1);
      done();
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toHaveBeenCalledTimes(1);
      failed();
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toHaveBeenCalledTimes(2);
      // The hanging call ran out once: a later load does not wait for it again.
      let again = false;
      void kept.after({}, () => Promise.resolve((again = true)), late);
      expect(again).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads nothing if the session ended while waiting', async () => {
    const kept = new Kept<string>();
    let done = () => {};
    kept.track(new Promise<void>((resolve) => (done = resolve)), {});
    const alive = kept.alive();
    const load = vi.fn(() => Promise.resolve(1));
    const waiting = kept.after({}, load, () => {});
    kept.forget();
    done();
    expect(await waiting).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(alive()).toBe(false);
    expect(kept.alive()()).toBe(true);
  });

  it('loads anyway after `KEPT_WAIT_MS` and again once the call is through after all', async () => {
    vi.useFakeTimers();
    try {
      const kept = new Kept<string>();
      let done = () => {};
      kept.track(new Promise<void>((resolve) => (done = resolve)), {});
      let through = false;
      const late = vi.fn();
      const load = kept.after({}, () => Promise.resolve((through = true)), late);
      await vi.advanceTimersByTimeAsync(KEPT_WAIT_MS - 1);
      expect(through).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await load;
      expect(through).toBe(true);
      expect(late).not.toHaveBeenCalled();
      done();
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toHaveBeenCalledOnce();
      // A hanging call of an ended session loads nothing later.
      let never = () => {};
      kept.track(new Promise<void>((resolve) => (never = resolve)), {});
      const after = vi.fn();
      const old = kept.after({}, () => Promise.resolve(), after);
      await vi.advanceTimersByTimeAsync(KEPT_WAIT_MS);
      await old;
      kept.forget();
      never();
      await vi.advanceTimersByTimeAsync(0);
      expect(after).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
