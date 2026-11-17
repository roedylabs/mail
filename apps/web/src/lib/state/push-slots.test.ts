import { describe, expect, it, vi } from 'vitest';
import { HTTP1_STREAMS, multiplexed, pushSlots, tabLocks } from './push-slots.ts';

const MAIL = 'https://mail.example.com';
const STREAM = `${MAIL}/jmap/eventsource/?types={types}`;

function entry(name: string, nextHopProtocol: string): PerformanceEntry {
  return { name, entryType: 'resource', nextHopProtocol } as unknown as PerformanceEntry;
}

/** Lets the lock callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('multiplexed', () => {
  it('follows the latest request to the origin with a known protocol', () => {
    expect(multiplexed(MAIL, [entry(`${MAIL}/jmap/`, 'h2')])).toBe(true);
    expect(multiplexed(MAIL, [entry(`${MAIL}/jmap/`, 'h3')])).toBe(true);
    expect(multiplexed(MAIL, [entry(`${MAIL}/jmap/`, 'h2'), entry(`${MAIL}/jmap/`, 'http/1.1')])).toBe(false);
    // Empty without `Timing-Allow-Origin`: does not override what is known.
    expect(multiplexed(MAIL, [entry(`${MAIL}/jmap/`, 'h2'), entry(`${MAIL}/jmap/`, '')])).toBe(true);
  });

  it('counts unknown and other origins as HTTP/1.1', () => {
    expect(multiplexed(MAIL, [])).toBe(false);
    expect(multiplexed(MAIL, [entry(`${MAIL}/jmap/`, '')])).toBe(false);
    expect(multiplexed(MAIL, [entry('https://mail.example.com.example/jmap/', 'h2')])).toBe(false);
    expect(multiplexed(MAIL, [entry('https://other.example/jmap/', 'h2')])).toBe(false);
  });
});

describe('pushSlots', () => {
  it('allows half of the six connections by default', () => {
    expect(HTTP1_STREAMS).toBe(3);
  });

  it('hands out the limit per origin and lets the next one wait for a free slot', async () => {
    const slots = pushSlots(tabLocks(), () => false, 2);
    const ctl = [new AbortController(), new AbortController(), new AbortController(), new AbortController()];
    const waited = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const held = [false, false, false, false];
    ctl.slice(0, 3).forEach((c, i) => void slots.acquire(STREAM, c.signal, waited[i]!).then(() => (held[i] = true)));
    // Another origin has its own slots.
    void slots
      .acquire('https://other.example/jmap/eventsource/', ctl[3]!.signal, waited[3]!)
      .then(() => (held[3] = true));
    await flush();
    expect(held).toEqual([true, true, false, true]);
    expect(waited.map((w) => w.mock.calls.length)).toEqual([0, 0, 1, 0]);
    ctl[0]!.abort();
    await flush();
    expect(held[2]).toBe(true);
  });

  it('stops waiting on abort without a slot and without blocking others', async () => {
    const slots = pushSlots(tabLocks(), () => false, 1);
    const first = new AbortController();
    const second = new AbortController();
    const third = new AbortController();
    await slots.acquire(STREAM, first.signal, vi.fn());
    const waiting = slots.acquire(STREAM, second.signal, vi.fn());
    await flush();
    second.abort();
    await waiting;
    let held = false;
    void slots.acquire(STREAM, third.signal, vi.fn()).then(() => (held = true));
    first.abort();
    await flush();
    expect(held).toBe(true);
  });

  it('needs no slot over a multiplexed connection or after an abort', async () => {
    const onWait = vi.fn();
    const slots = pushSlots(tabLocks(), () => true, 1);
    for (let i = 0; i < 3; i++) await slots.acquire(STREAM, new AbortController().signal, onWait);
    const aborted = new AbortController();
    aborted.abort();
    await pushSlots(tabLocks(), () => false, 0).acquire(STREAM, aborted.signal, onWait);
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('tabLocks', () => {
  it('grants exclusively in order and reports a taken lock with ifAvailable', async () => {
    const locks = tabLocks();
    const order: string[] = [];
    let release!: () => void;
    void locks.request('x', {}, () => new Promise<void>((resolve) => (release = resolve)));
    await flush();
    const busy = await locks.request('x', { ifAvailable: true }, (lock) => {
      order.push(lock === null ? 'busy' : 'free');
    });
    expect(busy).toBeUndefined();
    const second = locks.request('x', {}, () => void order.push('second'));
    const third = locks.request('x', {}, () => void order.push('third'));
    release();
    await Promise.all([second, third]);
    expect(order).toEqual(['busy', 'second', 'third']);
  });

  it('drops an aborted request from the queue', async () => {
    const locks = tabLocks();
    let release!: () => void;
    void locks.request('x', {}, () => new Promise<void>((resolve) => (release = resolve)));
    await flush();
    const ctl = new AbortController();
    const callback = vi.fn();
    const dropped = locks.request('x', { signal: ctl.signal }, callback);
    ctl.abort();
    await expect(dropped).rejects.toBeDefined();
    release();
    await flush();
    expect(callback).not.toHaveBeenCalled();
    expect(await locks.request('x', { ifAvailable: true }, (lock) => void expect(lock).not.toBeNull())).toBeUndefined();
  });
});
