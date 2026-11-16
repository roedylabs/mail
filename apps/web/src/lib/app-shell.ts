/**
 * App shell in the service worker: precache of a build and the rules for where
 * each request comes from. Only the registration `/` uses it, the registrations
 * of the mail accounts know no pages.
 *
 * - Pages come from the network first: the CSP of `index.html` names the
 *   servers of the registry, from the cache the CSP of the installation would
 *   apply. The stored page is only the fallback offline.
 * - Build files come from the cache, their content belongs to the build.
 * - Everything else bypasses the service worker: `/api`, mail servers,
 *   `_app/version.json` (the app detects new builds by it), branding.
 */

export const SHELL_PREFIX = 'roedy-mail-shell-';
/** `start_url` of the manifest and fallback for every route of the SPA. */
export const SHELL_PATH = '/';
/** Fixed address from `app.html`. */
export const MANIFEST_PATH = '/manifest.webmanifest';
/** A page does not wait longer than this for the server on a bad network. */
export const NAVIGATION_TIMEOUT_MS = 4000;
/** Asks the service worker to refill the precache right away (`#lib/client-cache.ts`). */
export const REFILL_MESSAGE = 'roedy-shell-refill';

/** Addresses that never belong to the SPA, even as navigation. */
const NOT_PAGES = ['/api/', '/branding/', '/healthz', '/readyz'];

export type ShellRoute = 'page' | 'asset' | 'manifest';

export interface ShellEnv {
  caches: Pick<CacheStorage, 'open' | 'keys' | 'delete' | 'match'>;
  fetch: typeof fetch;
  origin: string;
  /** Identifier of the build (`version` from `$app/env`). */
  version: string;
  /** Paths of the build (`immutable` and `assets` from `$app/manifest`). */
  assets: readonly string[];
}

/** Where a request comes from; `null` means: bypass the service worker. */
export function routeOf(request: Request, origin: string, assets: ReadonlySet<string>): ShellRoute | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if (request.mode === 'navigate') {
    return NOT_PAGES.some((prefix) => url.pathname.startsWith(prefix)) ? null : 'page';
  }
  if (url.pathname === MANIFEST_PATH) return 'manifest';
  return assets.has(url.pathname) ? 'asset' : null;
}

/** Like `fetch`, but rejected after `ms` without a response; the request itself keeps running. */
function withTimeout(response: Promise<Response>, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    response.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class AppShell {
  readonly #env: ShellEnv;
  readonly #assets: ReadonlySet<string>;

  constructor(env: ShellEnv) {
    this.#env = env;
    this.#assets = new Set(env.assets);
  }

  get cacheName(): string {
    return SHELL_PREFIX + this.#env.version;
  }

  /**
   * Fills the cache of the build. If that fails, the installation fails:
   * the old build stays and the browser tries again at the next update
   * check. The manifest is no reason for that, it is only needed to install
   * the app.
   */
  async precache(): Promise<void> {
    const cache = await this.#env.caches.open(this.cacheName);
    await cache.addAll([SHELL_PATH, ...this.#env.assets]);
    await cache.add(MANIFEST_PATH).catch(() => undefined);
  }

  /**
   * Fills the cache at installation. If the worker replaces an older build,
   * it fails with it (see `precache`). Without a predecessor it continues
   * without the cache, otherwise push would hang on a full storage or a network
   * error (`serviceWorker.ready` would never resolve); the next load fills it.
   */
  async install(replaces: boolean): Promise<void> {
    await this.precache().catch((error: unknown) => {
      if (replaces) throw error;
    });
  }

  /** Discards the caches of older builds; caches of other kinds stay. */
  async cleanup(): Promise<void> {
    const names = await this.#env.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(SHELL_PREFIX) && name !== this.cacheName)
        .map((name) => this.#env.caches.delete(name)),
    );
  }

  /** Fills the cache if someone emptied it ("Clear local data", `client_cache_version`). */
  async refill(): Promise<void> {
    const shell = await this.#shell();
    // An unread response holds the storage of a deleted cache, like an open `Cache`.
    await shell?.body?.cancel();
    if (!shell) await this.precache();
  }

  /** The route of this request; `null` means: do not answer. */
  route(request: Request): ShellRoute | null {
    return routeOf(request, this.#env.origin, this.#assets);
  }

  /** Answers a request with a route. `later` keeps the worker alive for work after the response. */
  respond(request: Request, route: ShellRoute, later: (work: Promise<unknown>) => void): Promise<Response> {
    if (route === 'page') return this.#page(request, later);
    if (route === 'manifest') return this.#manifest(request);
    return this.#asset(request);
  }

  /**
   * Reads via `caches.match`, not via `caches.open`: that does not recreate an
   * emptied cache, and an open `Cache` holds the storage of a deleted cache
   * until the worker ends. "Local data" would otherwise show the old size
   * for about 30 seconds after deleting.
   */
  #saved(path: string): Promise<Response | undefined> {
    return this.#env.caches.match(path, { cacheName: this.cacheName, ignoreVary: true });
  }

  #shell(): Promise<Response | undefined> {
    return this.#saved(SHELL_PATH);
  }

  /**
   * Network first, the stored page only without a response. If the cache is
   * empty, the next load is the right moment to fill it: right after
   * "Clear local data" it would otherwise be back at once. Without a stored
   * page the network applies, however long it takes.
   */
  async #page(request: Request, later: (work: Promise<unknown>) => void): Promise<Response> {
    const network = this.#env.fetch(request);
    later(network.then(() => this.refill()).catch(() => undefined));
    try {
      return await withTimeout(network, NAVIGATION_TIMEOUT_MS);
    } catch {
      return (await this.#shell()) ?? network;
    }
  }

  async #manifest(request: Request): Promise<Response> {
    try {
      return await this.#env.fetch(request);
    } catch (error) {
      const saved = await this.#saved(MANIFEST_PATH);
      if (saved) return saved;
      throw error;
    }
  }

  async #asset(request: Request): Promise<Response> {
    const saved = await this.#saved(new URL(request.url).pathname);
    return saved ?? this.#env.fetch(request);
  }
}
