import { afterEach, describe, expect, it, vi } from 'vitest';
import { NET_CHECK_MS, NET_WAIT, Reconnect, netWait } from './no-connection.svelte.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('netWait', () => {
  it('waits 5, 10, 20, then every 30 seconds', () => {
    expect(NET_WAIT).toEqual([5, 10, 20, 30]);
    expect([0, 1, 2, 3, 4, 9].map(netWait)).toEqual([5, 10, 20, 30, 30, 30]);
    expect(netWait(-1)).toBe(5);
  });
});

describe('Reconnect', () => {
  it('retries by itself on the schedule and closes on the first answer', async () => {
    vi.useFakeTimers();
    const answers = [false, false, false, false, true];
    const probe = vi.fn(() => Promise.resolve(answers.shift() ?? true));
    const net = new Reconnect({ probe });
    net.show();
    expect([net.open, net.left, net.total]).toEqual([true, 5, 5]);

    const attemptAfter = async (seconds: number) => {
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 250);
      const before = probe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(250);
      expect(probe.mock.calls.length).toBe(before + 1);
      expect(net.busy).toBe(true);
      // "Checking …" lasts at least 1.2 s without an answer.
      await vi.advanceTimersByTimeAsync(NET_CHECK_MS);
    };
    await attemptAfter(5);
    expect([net.busy, net.tries, net.total]).toEqual([false, 1, 10]);
    await attemptAfter(10);
    expect(net.total).toBe(20);
    await attemptAfter(20);
    expect(net.total).toBe(30);
    await attemptAfter(30);
    expect(net.total).toBe(30);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(net.open).toBe(false);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('attempts at once on "Try now" and shakes if the message stays', async () => {
    vi.useFakeTimers();
    const stayed = vi.fn();
    const probe = vi.fn(() => Promise.resolve(false));
    const net = new Reconnect({ probe, stayed });
    net.show();
    const pending = net.attempt(true);
    expect(net.busy).toBe(true);
    // A second press while checking does nothing.
    void net.attempt(true);
    await vi.advanceTimersByTimeAsync(NET_CHECK_MS);
    await pending;
    expect(probe).toHaveBeenCalledOnce();
    expect(stayed).toHaveBeenCalledOnce();
    expect([net.open, net.tries, net.left]).toEqual([true, 1, 10]);
    // Automatic attempts do not shake.
    await vi.advanceTimersByTimeAsync(10_000 + NET_CHECK_MS);
    expect(stayed).toHaveBeenCalledOnce();
    net.close();
  });

  it('counts a failing probe as no answer and does nothing while closed', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => Promise.reject(new Error('down')));
    const net = new Reconnect({ probe });
    await net.attempt();
    expect(probe).not.toHaveBeenCalled();
    net.show();
    net.show();
    const pending = net.attempt();
    await vi.advanceTimersByTimeAsync(NET_CHECK_MS);
    await pending;
    expect([net.open, net.tries]).toEqual([true, 1]);
    net.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledOnce();
  });
});
