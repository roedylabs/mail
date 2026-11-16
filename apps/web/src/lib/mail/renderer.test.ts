import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MailRenderer,
  PRELOAD_TIMEOUT_MS,
  RELOAD_KEY,
  RELOAD_LOCK_MS,
  RETRY_MS,
  type RenderMail,
  type RendererDeps,
} from '#lib/mail/renderer.svelte.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const fake: RenderMail = () => ({ html: '<p>x</p>', blocked: 0 });
/** Sum of all waiting times until the last attempt. */
const ALL_RETRIES = RETRY_MS.reduce((a, b) => a + b, 0);

/**
 * Import that fails `fails` times (`Infinity`: always; `setFails` changes that), plus online state,
 * storage, reload and registered listeners for `online` (`goOnline()` triggers them).
 */
function deps(fails: number, patch: Partial<RendererDeps> = {}) {
  let calls = 0;
  let limit = fails;
  const load = vi.fn(() => {
    calls++;
    return calls <= limit ? Promise.reject(new Error('chunk missing')) : Promise.resolve({ renderMail: fake });
  });
  const reload = vi.fn();
  const listeners = new Set<() => void>();
  const onOnline = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const d: RendererDeps = {
    load,
    online: () => true,
    storage: () => sessionStorage,
    reload,
    now: () => NOW,
    onOnline,
    ...patch,
  };
  const goOnline = () => {
    for (const listener of [...listeners]) listener();
  };
  return { d, load, reload, onOnline, listeners, goOnline, setFails: (n: number) => (limit = calls + n) };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mailRenderer: render.ts only for the reading view', () => {
  it('loads the real render.ts once and reports renderMail', async () => {
    vi.resetModules();
    const { mailRenderer } = await import('#lib/mail/renderer.svelte.ts');
    expect(mailRenderer.current).toBeNull();
    const [a, b] = await Promise.all([mailRenderer.load(), mailRenderer.load()]);
    const { renderMail } = await import('#lib/mail/render.ts');
    expect(a).toBe(renderMail);
    expect(b).toBe(renderMail);
    expect(mailRenderer.current).toBe(renderMail);
  });

  it('retries by itself after an error, with growing intervals, without a new call', async () => {
    vi.useFakeTimers();
    const { d, load, reload } = deps(2);
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(r.current).toBeNull();
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(await done).toBe(fake);
    expect(r.current).toBe(fake);
    expect(reload).not.toHaveBeenCalled();
  });

  it('gives up after three retries and reloads the page exactly once', async () => {
    vi.useFakeTimers();
    const { d, load, reload } = deps(Infinity);
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(await done).toBeNull();
    expect(load).toHaveBeenCalledTimes(1 + RETRY_MS.length);
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe(String(NOW));
    // A new call (another conversation) starts over, but does not reload again within the lock.
    const again = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(await again).toBeNull();
    expect(load).toHaveBeenCalledTimes(2 * (1 + RETRY_MS.length));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload offline (the service worker keeps the chunks of the version)', async () => {
    vi.useFakeTimers();
    const { d, reload } = deps(Infinity, { online: () => false });
    const done = new MailRenderer(d).load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(await done).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it('does not reload within the lock of an earlier reload, afterwards again', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(RELOAD_KEY, String(NOW - RELOAD_LOCK_MS + 1));
    const blocked = deps(Infinity);
    const first = new MailRenderer(blocked.d).load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await first;
    expect(blocked.reload).not.toHaveBeenCalled();
    sessionStorage.setItem(RELOAD_KEY, String(NOW - RELOAD_LOCK_MS));
    const free = deps(Infinity);
    const second = new MailRenderer(free.d).load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await second;
    expect(free.reload).toHaveBeenCalledOnce();
  });

  it('no reload without sessionStorage (no lock against loops)', async () => {
    vi.useFakeTimers();
    const { d, reload } = deps(Infinity, { storage: () => null });
    const done = new MailRenderer(d).load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await done;
    expect(reload).not.toHaveBeenCalled();
  });

  it('preloads with `preload()` only during idle time, once', async () => {
    const idle = vi.fn<(run: () => void, options: { timeout: number }) => number>();
    vi.stubGlobal('requestIdleCallback', idle);
    const { d, load } = deps(0);
    const r = new MailRenderer(d);
    r.preload();
    r.preload();
    expect(idle).toHaveBeenCalledOnce();
    expect(idle.mock.calls[0]![1]).toEqual({ timeout: PRELOAD_TIMEOUT_MS });
    expect(load).not.toHaveBeenCalled();
    idle.mock.calls[0]![0]();
    await vi.waitFor(() => expect(r.current).toBe(fake));
    r.preload();
    expect(idle).toHaveBeenCalledOnce();
  });

  it('without `requestIdleCallback` after `PRELOAD_TIMEOUT_MS`', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const { d, load } = deps(0);
    const r = new MailRenderer(d);
    r.preload();
    await vi.advanceTimersByTimeAsync(PRELOAD_TIMEOUT_MS - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.current).toBe(fake);
  });

  it('if only the preload fails, it does not reload the page; only the reading view may do that', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const { d, reload } = deps(Infinity);
    const r = new MailRenderer(d);
    r.preload();
    await vi.advanceTimersByTimeAsync(PRELOAD_TIMEOUT_MS + ALL_RETRIES);
    expect(r.current).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    const done = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });

  it('`release()` prevents the reload after the last failure', async () => {
    vi.useFakeTimers();
    const { d, reload, onOnline } = deps(Infinity);
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    r.release();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(await done).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(onOnline).not.toHaveBeenCalled();
  });

  it('after `release()` a late success still fills `current`', async () => {
    vi.useFakeTimers();
    const { d, load, reload } = deps(2);
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(0);
    r.release();
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] + RETRY_MS[1]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(await done).toBe(fake);
    expect(r.current).toBe(fake);
    expect(reload).not.toHaveBeenCalled();
  });

  it('`online` starts the attempts over after the final failure while the need persists', async () => {
    vi.useFakeTimers();
    const { d, load, reload, onOnline, listeners, goOnline, setFails } = deps(Infinity, { online: () => false });
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(await done).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(onOnline).toHaveBeenCalledOnce();
    // Another call while waiting does not register again.
    const again = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await again;
    expect(onOnline).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);
    const before = load.mock.calls.length;
    setFails(1);
    goOnline();
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(load).toHaveBeenCalledTimes(before + 2);
    expect(r.current).toBe(fake);
  });

  it('`online` without need: `release()` unregisters, there is no new attempt', async () => {
    vi.useFakeTimers();
    const { d, load, listeners, goOnline } = deps(Infinity, { online: () => false });
    const r = new MailRenderer(d);
    const done = r.load();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    await done;
    expect(listeners.size).toBe(1);
    const before = load.mock.calls.length;
    r.release();
    expect(listeners.size).toBe(0);
    goOnline();
    await vi.advanceTimersByTimeAsync(ALL_RETRIES);
    expect(load).toHaveBeenCalledTimes(before);
  });
});
