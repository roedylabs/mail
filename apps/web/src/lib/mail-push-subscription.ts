/**
 * Push subscription of a mail account on this device: scope of
 * the registration, device identifier and the entry at the mail server.
 * Without runes and without DOM, so that app and service worker use the same flow.
 */
import {
  createPushSubscription,
  destroyPushSubscriptions,
  EMAIL_PUSH,
  listPushSubscriptions,
  renewPushSubscription,
  webPushKey,
  type JmapClient,
  type JmapPushSubscription,
} from '@roedy/jmap';

/** The scopes live under this path; there are no pages there. */
const SCOPE_PATH = '/mail-account-push/';

/** Message to the app windows: the subscription of an account is confirmed. */
export const VERIFIED_MESSAGE = 'roedy:mail-push-verified';

const DAY = 86_400_000;
/** Stalwart truncates longer values. */
const LIFETIME = 7 * DAY;
/** Below this, the next start renews; less than a day since the last time is not worth a call. */
const RENEW_BELOW = 6 * DAY;

/** Scope of the registration of a mail account. */
export function mailPushScope(accountId: string): string {
  return `${SCOPE_PATH}${encodeURIComponent(accountId)}/`;
}

/** Mail account of a registration; the app's registration yields `null`. */
export function mailPushAccount(scope: string): string | null {
  const { pathname } = new URL(scope, 'https://app.invalid');
  if (!pathname.startsWith(SCOPE_PATH)) return null;
  const part = pathname.slice(SCOPE_PATH.length, -1);
  return part && !part.includes('/') && pathname.endsWith('/') ? decodeURIComponent(part) : null;
}

/** Identifier of the browser subscription at the mail server: reveals nothing and needs no storage. */
export async function deviceClientId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest).subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `roedy-mail-${hex.join('')}`;
}

/** `expires` in seven days as UTCDate (RFC 8620, 1.4: without fractional seconds). */
function expiry(now: number): string {
  return new Date(now + LIFETIME).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Key of the mail server; without VAPID or `emailPush` there is no push for new mail there. */
export async function serverKey(client: JmapClient, signal?: AbortSignal): Promise<string | null> {
  const session = await client.session(signal);
  return EMAIL_PUSH in session.capabilities ? webPushKey(session) : null;
}

/** Entries of this browser subscription at the mail server. */
export async function ownEntries(
  client: JmapClient,
  endpoint: string,
  signal?: AbortSignal,
): Promise<JmapPushSubscription[]> {
  const device = await deviceClientId(endpoint);
  return (await listPushSubscriptions(client, signal)).filter((entry) => entry.deviceClientId === device);
}

/** Expired? `set` no longer knows such entries, even if `get` shows them once more. */
export function isExpired(entry: JmapPushSubscription, now = Date.now()): boolean {
  return entry.expires !== null && Date.parse(entry.expires) <= now;
}

/** Renews the entry when it expires soon. */
export async function renewIfDue(
  client: JmapClient,
  entry: JmapPushSubscription,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<void> {
  const expires = entry.expires ? Date.parse(entry.expires) : 0;
  if (expires - now < RENEW_BELOW) await renewPushSubscription(client, entry.id, expiry(now), signal);
}

/**
 * Creates the entry at the mail server: only the inbox, only the IDs in the
 * message. The confirmation arrives as a push.
 */
export async function createEntry(
  client: JmapClient,
  subscription: PushSubscription,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<string> {
  const { keys } = subscription.toJSON();
  if (!keys?.p256dh || !keys.auth) throw new Error('Subscription without keys');
  const accountId = await client.accountId(undefined, signal);
  const { ids } = await client.call('Mailbox/query', { accountId, filter: { role: 'inbox' } }, signal);
  const inbox = ids[0];
  if (!inbox) throw new Error('No inbox');
  const { id } = await createPushSubscription(
    client,
    {
      deviceClientId: await deviceClientId(subscription.endpoint),
      url: subscription.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      types: ['EmailDelivery'],
      emailPush: { [accountId]: { filter: { inMailbox: inbox }, properties: ['id', 'threadId'] } },
      expires: expiry(now),
    },
    signal,
  );
  return id;
}

/** Removes all entries of a browser subscription at the mail server. */
export async function destroyEntries(client: JmapClient, endpoint: string, signal?: AbortSignal): Promise<void> {
  const entries = await ownEntries(client, endpoint, signal);
  await destroyPushSubscriptions(
    client,
    entries.map((entry) => entry.id),
    signal,
  );
}
