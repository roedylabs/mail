import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshLock } from '#lib/refresh-lock.svelte.ts';

describe('RefreshLock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('locks for 900 ms and turns the icon 720 degrees', async () => {
    const lock = new RefreshLock();
    const done = vi.fn();
    void lock.press(true)?.then(done);
    expect(lock.locked).toBe(true);
    expect(lock.rot).toBe(720);
    await vi.advanceTimersByTimeAsync(899);
    expect(lock.locked).toBe(true);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.locked).toBe(false);
    expect(done).toHaveBeenCalledOnce();
  });

  it('locks for 500 ms with motion off', async () => {
    const lock = new RefreshLock();
    void lock.press(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(lock.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.locked).toBe(false);
  });

  it('a click while locked does nothing, afterwards it turns again', async () => {
    const lock = new RefreshLock();
    expect(lock.press(true)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(lock.press(true)).toBeNull();
    expect(lock.rot).toBe(720);
    await vi.advanceTimersByTimeAsync(500);
    expect(lock.press(true)).not.toBeNull();
    expect(lock.rot).toBe(1440);
  });
});
