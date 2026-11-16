import { describe, expect, it, vi } from 'vitest';
import { TokenSource, type TokenGrant } from './token.ts';

const HOUR = 3_600_000;

/** Broker with a clock: returns `t1`, `t2`, … valid for one hour. */
function broker(start = Date.parse('2026-10-27T12:00:00Z')) {
  let now = start;
  let n = 0;
  const fetch = vi.fn((refresh: boolean): Promise<TokenGrant> => {
    void refresh;
    n++;
    return Promise.resolve({ accessToken: `t${n}`, expiresAt: new Date(now + HOUR).toISOString(), session: { n } });
  });
  return {
    fetch,
    tick: (ms: number) => (now += ms),
    source: (extra: Partial<ConstructorParameters<typeof TokenSource>[0]> = {}) =>
      new TokenSource({ fetch, now: () => now, ...extra }),
  };
}

describe('TokenSource', () => {
  it('keeps the token until shortly before expiry', async () => {
    const b = broker();
    const tokens = b.source();
    expect(await tokens.token()).toBe('t1');
    b.tick(HOUR - 61_000);
    expect(await tokens.token()).toBe('t1');
    b.tick(2000);
    expect(await tokens.token()).toBe('t2');
    expect(b.fetch.mock.calls).toEqual([[false], [false]]);
    expect(tokens.grant?.session).toEqual({ n: 2 });
  });

  it('asks only once for concurrent calls', async () => {
    const b = broker();
    const tokens = b.source();
    expect(await Promise.all([tokens.token(), tokens.token(), tokens.token()])).toEqual(['t1', 't1', 't1']);
    expect(b.fetch).toHaveBeenCalledOnce();
  });

  it('renews a rejected token with refresh, but only once for everyone', async () => {
    const b = broker();
    const tokens = b.source();
    await tokens.token();
    const renewed = await Promise.all([tokens.token({ rejected: 't1' }), tokens.token({ rejected: 't1' })]);
    expect(renewed).toEqual(['t2', 't2']);
    expect(b.fetch.mock.calls).toEqual([[false], [true]]);
    // Whoever comes with the old token afterwards gets the new one without a fetch.
    expect(await tokens.token({ rejected: 't1' })).toBe('t2');
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it('also renews when a fetch without refresh is already running at rejection time', async () => {
    let resolveFirst: (grant: TokenGrant) => void = () => {};
    const fetch = vi
      .fn<(refresh: boolean) => Promise<TokenGrant>>()
      .mockResolvedValueOnce({ accessToken: 't1', expiresAt: 'broken' })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ accessToken: 't2', expiresAt: null });
    const tokens = new TokenSource({ fetch });
    expect(await tokens.token()).toBe('t1');
    // `t1` counts as expired (unreadable date): the next fetch runs without refresh.
    const plain = tokens.token();
    const renewed = tokens.token({ rejected: 't1' });
    resolveFirst({ accessToken: 't1', expiresAt: 'broken' });
    expect(await plain).toBe('t1');
    expect(await renewed).toBe('t2');
    expect(fetch.mock.calls).toEqual([[false], [false], [true]]);
  });

  it('clear also forgets a fetch in progress', async () => {
    let resolve: (grant: TokenGrant) => void = () => {};
    const fetch = vi
      .fn<(refresh: boolean) => Promise<TokenGrant>>()
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockResolvedValueOnce({ accessToken: 'new', expiresAt: null });
    const tokens = new TokenSource({ fetch });
    const before = tokens.token();
    tokens.clear();
    resolve({ accessToken: 'old', expiresAt: null });
    await expect(before).rejects.toMatchObject({ name: 'AbortError' });
    expect(tokens.grant).toBeNull();
    expect(await tokens.token()).toBe('new');
  });

  it('renews when the broker returns the rejected token again', async () => {
    const fetch = vi
      .fn<(refresh: boolean) => Promise<TokenGrant>>()
      .mockResolvedValueOnce({ accessToken: 'old', expiresAt: null })
      .mockResolvedValueOnce({ accessToken: 'new', expiresAt: null });
    const tokens = new TokenSource({ fetch });
    expect(await tokens.token({ rejected: 'old' })).toBe('new');
    expect(fetch.mock.calls).toEqual([[false], [true]]);
  });

  it('waits until Retry-After after 429 and keeps returning the valid token during the pause', async () => {
    const b = broker();
    const limited = Object.assign(new Error('rate_limited'), { retry_after: 30 });
    const tokens = b.source({
      retryAfter: (error) => (error === limited ? 30 : undefined),
    });
    expect(await tokens.token()).toBe('t1');
    b.fetch.mockRejectedValueOnce(limited);

    await expect(tokens.token({ rejected: 't1' })).rejects.toBe(limited);
    expect(tokens.retryAt()).toBe(Date.parse('2026-10-27T12:00:30Z'));
    // During the pause nobody asks the broker; a still valid token keeps going out.
    await expect(tokens.token({ rejected: 't1' })).rejects.toBe(limited);
    expect(await tokens.token()).toBe('t1');
    expect(b.fetch).toHaveBeenCalledTimes(2);

    b.tick(30_000);
    expect(tokens.retryAt()).toBe(0);
    expect(await tokens.token({ rejected: 't1' })).toBe('t2');
  });

  it('does not pause on errors without a wait time', async () => {
    const b = broker();
    const tokens = b.source({ retryAfter: () => undefined });
    b.fetch.mockRejectedValueOnce(new Error('needs_reauth'));
    await expect(tokens.token()).rejects.toThrow('needs_reauth');
    expect(tokens.retryAt()).toBe(0);
    expect(await tokens.token()).toBe('t1');
  });

  it('aborts the wait without aborting the fetch for others', async () => {
    let resolve: (grant: TokenGrant) => void = () => {};
    const fetch = vi.fn(() => new Promise<TokenGrant>((r) => (resolve = r)));
    const tokens = new TokenSource({ fetch });
    const controller = new AbortController();
    const aborted = tokens.token({ signal: controller.signal });
    const other = tokens.token();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ accessToken: 't1', expiresAt: null });
    expect(await other).toBe('t1');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('forgets the token with clear', async () => {
    const b = broker();
    const tokens = b.source();
    await tokens.token();
    tokens.clear();
    expect(tokens.grant).toBeNull();
    expect(await tokens.token()).toBe('t2');
  });
});
