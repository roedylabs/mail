import { describe, expect, it } from 'vitest';
import { forgetRegistered } from '#lib/state/forget.ts';
import { Kept } from '#lib/state/kept.ts';

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

  it('waits for calls of left pages, also failed ones, until the session ends', async () => {
    const kept = new Kept<string>();
    let done = () => {};
    let failed = () => {};
    kept.track(new Promise<void>((resolve) => (done = resolve)));
    kept.track(new Promise<void>((_, reject) => (failed = () => reject(new Error('x')))));
    let through = false;
    const load = kept.after(() => {
      through = true;
      return Promise.resolve(1);
    });
    done();
    await Promise.resolve();
    expect(through).toBe(false);
    failed();
    expect(await load).toBe(1);
    kept.track(new Promise(() => {}));
    kept.forget();
    // Without calls right away.
    let now = false;
    void kept.after(() => Promise.resolve((now = true)));
    expect(now).toBe(true);
  });
});
