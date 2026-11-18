/**
 * Push from the mail server (RFC 8620, 7): subscriptions with `PushSubscription/get|set`,
 * verification via `verificationCode` (7.2.2), the server's key (RFC 9749),
 * `emailPush` (draft-ietf-jmap-emailpush) and the messages the server sends.
 * `PushSubscription` has no `accountId` and no state: a subscription belongs to
 * the person the token identifies.
 */

import type { JmapClient } from './client.ts';
import {
  EMAIL_PUSH,
  WEBPUSH_VAPID,
  type Filter,
  type Id,
  type PatchObject,
  type Session,
  type SetError,
} from './core.ts';
import { JmapError } from './errors.ts';
import type { Email, EmailFilter } from './mail.ts';

export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** Entry of `emailPush`: which emails are reported and what the message contains. */
export interface EmailPushConfig {
  filter?: Filter<EmailFilter> | null;
  properties?: (keyof Email)[];
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

export interface JmapPushSubscription {
  id: Id;
  deviceClientId: string;
  /** Not readable: the server only accepts the URL on create. */
  url: string;
  keys: PushKeys | null;
  /** `null` until verified; Stalwart up to v1.0.x always returns `null`, even after verification. */
  verificationCode: string | null;
  expires: string | null;
  types: string[] | null;
  emailPush?: Record<Id, EmailPushConfig> | null;
}

export type PushSubscriptionProperty = keyof JmapPushSubscription;

export interface PushSubscriptionGetArgs {
  ids?: Id[] | null;
  properties?: PushSubscriptionProperty[] | null;
}

export interface PushSubscriptionGetResponse {
  list: JmapPushSubscription[];
  notFound: Id[] | null;
}

export interface PushSubscriptionSetArgs {
  create?: Record<Id, Partial<JmapPushSubscription>> | null;
  update?: Record<Id, PatchObject> | null;
  destroy?: Id[] | null;
}

export interface PushSubscriptionSetResponse {
  created: Record<Id, Partial<JmapPushSubscription> & { id: Id }> | null;
  updated: Record<Id, Partial<JmapPushSubscription> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

/** What the client provides on create. */
export interface NewPushSubscription {
  deviceClientId: string;
  url: string;
  keys: PushKeys;
  /** All data types when omitted. */
  types?: string[];
  emailPush?: Record<Id, EmailPushConfig>;
  /** The server may shorten it, Stalwart to at most 7 days. */
  expires?: string;
}

function refused(error: SetError | undefined): JmapError {
  const type = error?.type ?? 'unknown';
  return new JmapError('request', error?.description ? { type, detail: error.description } : { type });
}

/** The server's `applicationServerKey` (Base64url), `null` without VAPID. */
export function webPushKey(session: Session): string | null {
  const capability = session.capabilities[WEBPUSH_VAPID];
  if (!capability || typeof capability !== 'object') return null;
  const { applicationServerKey } = capability as { applicationServerKey?: unknown };
  return typeof applicationServerKey === 'string' && applicationServerKey ? applicationServerKey : null;
}

/** All subscriptions of the person; `url` and `keys` are missing. */
export async function listPushSubscriptions(client: JmapClient, signal?: AbortSignal): Promise<JmapPushSubscription[]> {
  return (await client.call('PushSubscription/get', { ids: null }, signal)).list;
}

/**
 * Creates a subscription. The server then sends a `PushVerification` to `url`;
 * no messages go out until `verifyPushSubscription` confirms it.
 */
export async function createPushSubscription(
  client: JmapClient,
  subscription: NewPushSubscription,
  signal?: AbortSignal,
): Promise<{ id: Id; expires: string | null }> {
  const batch = client.batch();
  if (subscription.emailPush) batch.use(EMAIL_PUSH);
  const call = batch.call('PushSubscription/set', { create: { push: subscription } });
  const response = (await batch.send(signal)).get(call);
  const created = response.created?.push;
  if (!created) throw refused(response.notCreated?.push);
  return { id: created.id, expires: created.expires ?? null };
}

/** Verifies a subscription with the code from the `PushVerification`. */
export async function verifyPushSubscription(
  client: JmapClient,
  id: Id,
  verificationCode: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.call('PushSubscription/set', { update: { [id]: { verificationCode } } }, signal);
  if (response.notUpdated?.[id]) throw refused(response.notUpdated[id]);
}

/** Renews a subscription. If the server shortens the value, it does not say so; `list` shows the real one. */
export async function renewPushSubscription(
  client: JmapClient,
  id: Id,
  expires: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.call('PushSubscription/set', { update: { [id]: { expires } } }, signal);
  if (response.notUpdated?.[id]) throw refused(response.notUpdated[id]);
}

/** Removes subscriptions; already missing ones count as removed. */
export async function destroyPushSubscriptions(client: JmapClient, ids: Id[], signal?: AbortSignal): Promise<void> {
  if (ids.length === 0) return;
  const response = await client.call('PushSubscription/set', { destroy: ids }, signal);
  const failed = Object.values(response.notDestroyed ?? {}).find((error) => error.type !== 'notFound');
  if (failed) throw refused(failed);
}

/** Message from the server as the service worker receives it decrypted. */
export type PushObject =
  | { type: 'PushVerification'; pushSubscriptionId: Id; verificationCode: string }
  | { type: 'StateChange'; changed: Record<Id, Record<string, string>> }
  | { type: 'EmailPush'; accountId: Id; emails: Partial<Email>[]; state: string | null };

/** Parses a message; unknown or incomplete ones yield `null`. */
export function parsePushObject(raw: string | null | undefined): PushObject | null {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const object = data as Record<string, unknown>;
  switch (object['@type']) {
    case 'PushVerification': {
      const { pushSubscriptionId, verificationCode } = object;
      if (typeof pushSubscriptionId !== 'string' || typeof verificationCode !== 'string') return null;
      return { type: 'PushVerification', pushSubscriptionId, verificationCode };
    }
    case 'StateChange': {
      const { changed } = object;
      if (!changed || typeof changed !== 'object') return null;
      return { type: 'StateChange', changed: changed as Record<Id, Record<string, string>> };
    }
    case 'EmailPush': {
      const { accountId, emails, state } = object;
      if (typeof accountId !== 'string' || !Array.isArray(emails)) return null;
      return {
        type: 'EmailPush',
        accountId,
        emails: emails as Partial<Email>[],
        state: typeof state === 'string' ? state : null,
      };
    }
    default:
      return null;
  }
}
