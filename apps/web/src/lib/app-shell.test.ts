import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, MANIFEST_PATH, NAVIGATION_TIMEOUT_MS, SHELL_PATH, SHELL_PREFIX, routeOf } from './app-shell.ts';

const ORIGIN = 'https://app.example.test';
const ASSET = '/_app/immutable/entry/start.abc.js';

/** Cache Storage from maps: the key is the path. */
function fakeCaches(names: string[] = []) {
  const stores = new Map<string, Map<string, Response>>(names.map((name) => [name, new Map()]));
  const open = (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return Promise.resolve({
      addAll: (paths: string[]) => {
        for (const path of paths) store.set(path, new Response(path));
        return Promise.resolve();
      },
      add: (path: string) => {
        store.set(path, new Response(path));
        return Promise.resolve();
      },
    } as unknown as Cache);
  };
  return {
    stores,
    open: vi.fn(open),
    // A new response every time as in the browser: the body of a clone could not be cancelled on its own.
    match: (path: string, options: { cacheName: string }) =>
      Promise.resolve(stores.get(options.cacheName)?.has(path) ? new Response(path) : undefined),
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  };
}

function shellWith(caches = fakeCaches(), fetcher: typeof fetch = () => Promise.reject(new TypeError('offline'))) {
  const later: Promise<unknown>[] = [];
  const shell = new AppShell({ caches, fetch: fetcher, origin: ORIGIN, version: '1', assets: [ASSET] });
  const wait = (work: Promise<unknown>) => later.push(work);
  return { shell, caches, later, wait };
}

function navigation(path = '/mailbox/all'): Request {
  const request = new Request(ORIGIN + path);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('routeOf', () => {
  const assets = new Set([ASSET]);

  it('answers pages, build files and the manifest', () => {
    expect(routeOf(navigation(), ORIGIN, assets)).toBe('page');
    expect(routeOf(navigation('/oauth/callback?code=a'), ORIGIN, assets)).toBe('page');
    expect(routeOf(new Request(ORIGIN + ASSET), ORIGIN, assets)).toBe('asset');
    expect(routeOf(new Request(ORIGIN + MANIFEST_PATH), ORIGIN, assets)).toBe('manifest');
  });

  it('lets API, mail servers, version file and branding bypass the service worker', () => {
    expect(routeOf(new Request(`${ORIGIN}/api/v1/public/config`), ORIGIN, assets)).toBeNull();
    expect(routeOf(navigation('/api/v1/export'), ORIGIN, assets)).toBeNull();
    expect(routeOf(navigation('/branding/app-icon.png'), ORIGIN, assets)).toBeNull();
    expect(routeOf(new Request('https://mail.example.test/jmap/'), ORIGIN, assets)).toBeNull();
    expect(routeOf(new Request(`${ORIGIN}/_app/version.json`), ORIGIN, assets)).toBeNull();
    expect(routeOf(new Request(ORIGIN + ASSET, { method: 'POST' }), ORIGIN, assets)).toBeNull();
  });
});

describe('AppShell', () => {
  it('fills the cache of the build with page, files and manifest', async () => {
    const { shell, caches } = shellWith();
    await shell.precache();
    expect([...(caches.stores.get(`${SHELL_PREFIX}1`)?.keys() ?? [])]).toEqual([SHELL_PATH, ASSET, MANIFEST_PATH]);
  });

  it('fails without the page, not without the manifest', async () => {
    const add = vi.fn(() => Promise.reject(new TypeError('offline')));
    const addAll = vi.fn(() => Promise.resolve());
    const caches = fakeCaches();
    caches.open.mockResolvedValue({ add, addAll } as unknown as Cache);
    await expect(shellWith(caches).shell.precache()).resolves.toBeUndefined();
    addAll.mockRejectedValueOnce(new TypeError('offline'));
    await expect(shellWith(caches).shell.precache()).rejects.toThrow('offline');
  });

  it('installs without a predecessor even without a cache, otherwise the old build stays', async () => {
    const addAll = vi.fn(() => Promise.reject(new TypeError('voll')));
    const caches = fakeCaches();
    caches.open.mockResolvedValue({ addAll } as unknown as Cache);
    await expect(shellWith(caches).shell.install(false)).resolves.toBeUndefined();
    await expect(shellWith(caches).shell.install(true)).rejects.toThrow('voll');
  });

  it('discards older builds, other caches stay', async () => {
    const caches = fakeCaches([`${SHELL_PREFIX}0`, `${SHELL_PREFIX}1`, 'roedy-mail-other']);
    await shellWith(caches).shell.cleanup();
    expect([...caches.stores.keys()]).toEqual([`${SHELL_PREFIX}1`, 'roedy-mail-other']);
  });

  it('takes a page from the network so the CSP stays current', async () => {
    const { shell, wait } = shellWith(fakeCaches(), () => Promise.resolve(new Response('frisch')));
    await shell.precache();
    const response = await shell.respond(navigation(), 'page', wait);
    expect(await response.text()).toBe('frisch');
  });

  it('falls back to the stored page without a network', async () => {
    const { shell, wait } = shellWith();
    await shell.precache();
    const response = await shell.respond(navigation(), 'page', wait);
    expect(await response.text()).toBe(SHELL_PATH);
  });

  it('does not wait longer than the timeout on a bad network', async () => {
    vi.useFakeTimers();
    const { shell, wait } = shellWith(fakeCaches(), () => new Promise(() => {}));
    await shell.precache();
    const answer = shell.respond(navigation(), 'page', wait);
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS);
    expect(await (await answer).text()).toBe(SHELL_PATH);
  });

  it('reports the error like without a service worker when offline and without a cache', async () => {
    const { shell, later, wait } = shellWith();
    await expect(shell.respond(navigation(), 'page', wait)).rejects.toThrow('offline');
    await Promise.all(later);
  });

  it('waits for the network without a stored page, however long it takes', async () => {
    vi.useFakeTimers();
    const { shell, wait } = shellWith(fakeCaches(), async () => {
      await new Promise((done) => setTimeout(done, NAVIGATION_TIMEOUT_MS * 2));
      return new Response('langsam');
    });
    const answer = shell.respond(navigation(), 'page', wait);
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS * 2);
    expect(await (await answer).text()).toBe('langsam');
  });

  it('refills an emptied cache only at the next load', async () => {
    const { shell, caches, later, wait } = shellWith(fakeCaches(), () => Promise.resolve(new Response('frisch')));
    const response = await shell.respond(navigation(), 'page', wait);
    expect(await response.text()).toBe('frisch');
    await Promise.all(later);
    expect(caches.stores.get(`${SHELL_PREFIX}1`)?.has(SHELL_PATH)).toBe(true);
  });

  it('does not recreate an emptied cache when reading', async () => {
    const { shell, caches, wait } = shellWith(fakeCaches(), () => Promise.resolve(new Response('Netz')));
    await shell.respond(new Request(ORIGIN + ASSET), 'asset', wait);
    expect(caches.stores.size).toBe(0);
  });

  it('fills only an empty cache on request', async () => {
    const { shell, caches } = shellWith();
    await shell.refill();
    expect(caches.stores.get(`${SHELL_PREFIX}1`)?.size).toBe(3);
    caches.stores.get(`${SHELL_PREFIX}1`)?.delete(ASSET);
    await shell.refill();
    expect(caches.stores.get(`${SHELL_PREFIX}1`)?.size).toBe(2);
  });

  it('takes files from the cache and fetches missing ones from the network', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('Netz')));
    const { shell, wait } = shellWith(fakeCaches(), fetcher);
    expect(await (await shell.respond(new Request(ORIGIN + ASSET), 'asset', wait)).text()).toBe('Netz');
    await shell.precache();
    expect(await (await shell.respond(new Request(ORIGIN + ASSET), 'asset', wait)).text()).toBe(ASSET);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes the manifest from the network, offline the stored one', async () => {
    const online = shellWith(fakeCaches(), () => Promise.resolve(new Response('frisch')));
    await online.shell.precache();
    const request = new Request(ORIGIN + MANIFEST_PATH);
    expect(await (await online.shell.respond(request, 'manifest', online.wait)).text()).toBe('frisch');
    const offline = shellWith();
    await expect(offline.shell.respond(request, 'manifest', offline.wait)).rejects.toThrow('offline');
    await offline.shell.precache();
    expect(await (await offline.shell.respond(request, 'manifest', offline.wait)).text()).toBe(MANIFEST_PATH);
  });
});
