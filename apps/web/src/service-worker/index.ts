/**
 * Service worker of the app: shows push messages
 * from the backend (`title`, `body`, `icon`, `tag`) and opens `data.url` on a
 * click – in an open window of the app via its router, otherwise in a new one.
 * The app registers it itself (`#lib/push.svelte.ts`), plus once per mail
 * account with push under a scope of its own: only JMAP push arrives there
 * (`#lib/mail-push-worker.ts`, new mails). The app's
 * registration also keeps the app shell for starting without a network
 * (`#lib/app-shell.ts`). Types from the `tsconfig.json` next to it
 * (library `webworker`; the app's project excludes the folder, `pnpm check`
 * checks it separately).
 */
import { dev, version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { AppShell, REFILL_MESSAGE } from '#lib/app-shell.ts';
import { needsEveryNotice } from '#lib/mail-push-notification.ts';
import { mailPushAccount } from '#lib/mail-push-subscription.ts';
import { handleMailPush, handleSubscriptionChange } from '#lib/mail-push-worker.ts';
import { BELL_MESSAGE, OPEN_MESSAGE, parsePush, safePath } from '#lib/push-message.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Mail account of this registration; the app's registration has none. */
const mailAccount = mailPushAccount(sw.registration.scope);

/**
 * App shell only in the app's registration. It stays off in development: Vite
 * serves every file itself there, and tests with `page.route` would not see
 * requests from the service worker.
 */
const shell =
  mailAccount === null && !dev
    ? new AppShell({
        caches: sw.caches,
        fetch: (input, init) => sw.fetch(input, init),
        origin: sw.location.origin,
        version,
        assets: [...immutable, ...assets].map(({ path }) => `/${path}`),
      })
    : null;

// Take over only with a full cache: if filling fails, the old version stays. Waiting would leave the old version
// hanging: an installed app or an open tab may never close.
sw.addEventListener('install', (event) => {
  const filled = shell?.install(sw.registration.active !== null) ?? Promise.resolve();
  event.waitUntil(filled.then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([shell?.cleanup(), sw.clients.claim()]));
});

if (shell) {
  sw.addEventListener('fetch', (event) => {
    const route = shell.route(event.request);
    if (route) event.respondWith(shell.respond(event.request, route, (work) => event.waitUntil(work)));
  });
}

sw.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (shell && data && typeof data === 'object' && (data as Record<string, unknown>).type === REFILL_MESSAGE) {
    event.waitUntil(shell.refill());
  }
});

sw.addEventListener('push', (event) => {
  let raw: string | null;
  try {
    raw = event.data?.text() ?? null;
  } catch {
    raw = null;
  }
  if (mailAccount !== null) {
    const everyNotice = needsEveryNotice(sw.navigator.userAgent);
    const worker = { clients: sw.clients, registration: sw.registration, appName: sw.location.host, everyNotice };
    event.waitUntil(handleMailPush(mailAccount, raw, worker));
    return;
  }
  const message = parsePush(raw, sw.location.host);
  const options: NotificationOptions = { body: message.body, data: { url: message.url } };
  if (message.icon) options.icon = message.icon;
  if (message.tag) options.tag = message.tag;
  event.waitUntil(Promise.all([sw.registration.showNotification(message.title, options), ringBell()]));
});

sw.addEventListener('pushsubscriptionchange', (event) => {
  if (mailAccount === null) return;
  const oldEndpoint = event.oldSubscription?.endpoint ?? null;
  const subscription = event.newSubscription;
  event.waitUntil(handleSubscriptionChange(mailAccount, sw.registration.pushManager, { oldEndpoint, subscription }));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const path = safePath(data && typeof data === 'object' ? (data as Record<string, unknown>).url : undefined);
  event.waitUntil(open(path));
});

/** Open windows reload the bell right away instead of waiting for its next fetch. */
async function ringBell(): Promise<void> {
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const window of windows) window.postMessage({ type: BELL_MESSAGE });
}

/** An open window of the app navigates itself (without reloading) and comes to the front, otherwise a new one. */
async function open(path: string): Promise<void> {
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = windows.find((client) => new URL(client.url).origin === sw.location.origin);
  if (target) {
    target.postMessage({ type: OPEN_MESSAGE, url: path });
    try {
      await target.focus();
      return;
    } catch {
      // Focus refused (hidden or frozen window): then a new window.
    }
  }
  await sw.clients.openWindow(new URL(path, sw.location.origin).href);
}
