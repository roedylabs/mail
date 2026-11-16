import { afterEach, describe, expect, it, vi } from 'vitest';
import { Countdown } from './countdown.svelte.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Countdown', () => {
  it('counts down per kind and reports expired locks', () => {
    vi.useFakeTimers();
    const freed = vi.fn<(kind: 'a' | 'b') => void>();
    const locks = new Countdown<'a' | 'b'>(freed);
    locks.start('a', 30);
    locks.start('b', 2);
    expect(locks.active('a')).toBe(true);
    expect(locks.left('a')).toBe(30);
    vi.advanceTimersByTime(2000);
    expect(freed).toHaveBeenCalledWith('b');
    expect(locks.active('b')).toBe(false);
    expect(locks.left('a')).toBe(28);
    locks.clear('a');
    expect(locks.left('a')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(freed).toHaveBeenCalledOnce();
  });

  it('starts no lock after stop()', () => {
    vi.useFakeTimers();
    const locks = new Countdown<'a'>();
    locks.stop();
    locks.start('a', 10);
    expect(locks.active('a')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
