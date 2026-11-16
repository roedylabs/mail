/**
 * Service worker of the app from the page's view: registration at start, also
 * for guests, and detection of new builds. Long-open tabs and installed apps
 * never reload by themselves, so they poll `_app/version.json` regularly and
 * reload after the next navigation.
 */
import { dev } from '$app/env';
import { updated } from '$app/state';
import { pollVisible } from '#lib/state/network.svelte.ts';

/** Interval of the check for a new build while the page is visible. */
export const RELEASE_POLL_MS = 5 * 60_000;

const COMPOSE_PATH = '/compose/';

let registering: Promise<ServiceWorkerRegistration> | null = null;

/** The registration `/`, created on demand; a failure can be retried. */
export function appWorker(): Promise<ServiceWorkerRegistration> {
  // In development Vite serves the worker as a module.
  registering ??= navigator.serviceWorker
    .register('/service-worker.js', { type: dev ? 'module' : 'classic' })
    .then(() => navigator.serviceWorker.ready)
    .catch((error: unknown) => {
      registering = null;
      throw error;
    });
  return registering;
}

/** At app start. Without a service worker (private window, insecure context) the app runs as before, just not offline. */
export function startAppWorker(): void {
  if (dev || !('serviceWorker' in navigator)) return;
  appWorker().catch(() => undefined);
}

/** Fetches the new service worker right away instead of waiting for the browser's next update check. */
async function fetchNewWorker(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration('/');
  await registration?.update();
}

/** Checks for a new build while the page is visible, on return and after an offline phase; returns the cleanup. */
export function watchRelease(target: Window = window): () => void {
  return pollVisible(
    target,
    RELEASE_POLL_MS,
    () => target.document.visibilityState === 'visible',
    () => {
      updated
        .check()
        .then((found) => (found ? fetchNewWorker() : undefined))
        .catch(() => undefined);
    },
  );
}

/**
 * Whether the page should reload to the new build after a navigation. Not
 * into the composer: it opens before the navigation (reply, quote,
 * `mailto:`), reloading would leave only an empty draft. Not out of the
 * composer either: there leaving is just saving the draft.
 */
export function releaseWaiting(from: string, to: string): boolean {
  return updated.current && !from.startsWith(COMPOSE_PATH) && !to.startsWith(COMPOSE_PATH);
}
