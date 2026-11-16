import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kit = vi.hoisted(() => ({
  updated: { current: false, check: vi.fn(() => Promise.resolve(false)) },
  dev: false,
}));
vi.mock('$app/state', () => ({ updated: kit.updated }));
vi.mock('$app/env', () => ({
  get dev() {
    return kit.dev;
  },
}));

/** `navigator.serviceWorker` as a stub; `null` means: the browser has none. */
function stubWorker() {
  const registration = { update: vi.fn(() => Promise.resolve()) };
  const container = {
    register: vi.fn(() => Promise.resolve(registration)),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(() => Promise.resolve(registration)),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  return { container, registration };
}

beforeEach(() => {
  vi.resetModules();
  kit.dev = false;
  kit.updated.current = false;
  kit.updated.check.mockResolvedValue(false);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  kit.updated.check.mockClear();
});

describe('service worker of the app', () => {
  it('registers once at start, even for several callers', async () => {
    const { container } = stubWorker();
    const { appWorker, startAppWorker } = await import('./app-worker.ts');
    startAppWorker();
    await appWorker();
    expect(container.register).toHaveBeenCalledOnce();
    expect(container.register).toHaveBeenCalledWith('/service-worker.js', { type: 'classic' });
  });

  it('tries again after a failure', async () => {
    const { container } = stubWorker();
    container.register.mockRejectedValueOnce(new Error('blocked'));
    const { appWorker } = await import('./app-worker.ts');
    await expect(appWorker()).rejects.toThrow('blocked');
    await expect(appWorker()).resolves.toBeDefined();
  });

  it('does not start in development and keeps running without a service worker', async () => {
    const { startAppWorker } = await import('./app-worker.ts');
    expect(() => startAppWorker()).not.toThrow();
    const { container } = stubWorker();
    kit.dev = true;
    startAppWorker();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('fetches the new worker as soon as a new build appears', async () => {
    const { registration } = stubWorker();
    const { watchRelease } = await import('./app-worker.ts');
    const stop = watchRelease(window);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(kit.updated.check).toHaveBeenCalledOnce());
    expect(registration.update).not.toHaveBeenCalled();

    kit.updated.check.mockResolvedValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());

    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(kit.updated.check).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when the check fails', async () => {
    stubWorker();
    kit.updated.check.mockRejectedValue(new TypeError('offline'));
    const { watchRelease } = await import('./app-worker.ts');
    const stop = watchRelease(window);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(kit.updated.check).toHaveBeenCalled());
    stop();
  });

  it('reloads only outside the composer, and only with a new build', async () => {
    const { releaseWaiting } = await import('./app-worker.ts');
    expect(releaseWaiting('/start', '/mailbox/all')).toBe(false);
    kit.updated.current = true;
    expect(releaseWaiting('/start', '/mailbox/all')).toBe(true);
    expect(releaseWaiting('/start', '/compose/new')).toBe(false);
    expect(releaseWaiting('/compose/new', '/start')).toBe(false);
  });
});
