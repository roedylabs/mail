/**
 * Key and browser subscription for both push paths (app and service worker):
 * one service worker registration holds exactly one subscription with one
 * key. Without runes and without DOM, so the service worker can use it too.
 */

/** VAPID key (Base64url) as bytes for `applicationServerKey`. */
export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameBytes(a: ArrayBuffer, b: Uint8Array): boolean {
  if (a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

/** Subscription for the key: the existing one, otherwise a new one. */
export async function browserSubscription(manager: PushManager, key: string): Promise<PushSubscription> {
  const applicationServerKey = base64UrlBytes(key);
  let subscription = await manager.getSubscription();
  // If the browser does not report the key, the subscription stays (otherwise every sign-in would create a new one).
  const known = subscription?.options.applicationServerKey;
  if (subscription && known && !sameBytes(known, applicationServerKey)) {
    // Different key: no push service accepts the old subscription anymore.
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  return subscription ?? manager.subscribe({ userVisibleOnly: true, applicationServerKey });
}
