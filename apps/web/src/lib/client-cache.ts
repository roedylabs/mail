/**
 * `client_cache_version` from `public/config`: when the version rises, for
 * example after compaction, the browser renews its caches: the cache of the app
 * shell and the store for mails.
 */
import { REFILL_MESSAGE, SHELL_PREFIX } from '#lib/app-shell.ts';
import { localStore } from '#lib/last-page.ts';
import { mailStores } from '#lib/mail-store.ts';

/** Last seen version; a setting of the device, no local data. */
export const CACHE_VERSION_KEY = 'roedy-mail:cache-version';

export interface ClientCacheEnv {
  storage: () => Storage | null;
  caches: () => Pick<CacheStorage, 'keys' | 'delete'> | null;
  /** Asks the service worker to refill the cache right away. */
  refill: () => void;
  /** Deletes the store for mails; the app keeps writing afterwards. */
  dropMail: () => Promise<void>;
}

const browserEnv: ClientCacheEnv = {
  storage: localStore,
  caches: () => globalThis.caches ?? null,
  refill: () => {
    if (typeof navigator === 'undefined') return;
    navigator.serviceWorker?.controller?.postMessage({ type: REFILL_MESSAGE });
  },
  dropMail: () => mailStores.dropAll(),
};

function seenVersion(storage: Storage): number | null {
  const seen = storage.getItem(CACHE_VERSION_KEY);
  return seen === null ? null : Number(seen);
}

/**
 * Compares the server's version with the seen one. The first time there is
 * nothing to renew, it is only remembered. If access to a store fails, the
 * app stays usable: the next fetch comes anyway.
 */
export async function applyCacheVersion(version: number, env: ClientCacheEnv = browserEnv): Promise<void> {
  try {
    const storage = env.storage();
    if (!storage) return;
    const seen = seenVersion(storage);
    if (seen === version) return;
    storage.setItem(CACHE_VERSION_KEY, String(version));
    if (seen === null) return;
    await env.dropMail();
    const caches = env.caches();
    if (!caches) return;
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(SHELL_PREFIX)).map((name) => caches.delete(name)));
    env.refill();
  } catch {
    // Blocked store: nothing to renew.
  }
}
