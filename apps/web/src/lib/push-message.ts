/**
 * Content of a push message for the service worker: title, text, icon, `tag`
 * (replaces an earlier message of the same entry) and `data.url`, which a
 * click opens. Without a DOM dependency, so that the service worker and
 * tests use the same rules.
 */

/** Target without an entry (like `push::START_PATH` in the backend). */
export const START_PATH = '/start';

/** Message to the app windows: open a path after a click on a notification. */
export const OPEN_MESSAGE = 'roedy:push-open';

/** Message to the app windows: the backend sent a notification, the bell reloads. */
export const BELL_MESSAGE = 'roedy:push-bell';

/** Message to the app windows: new mail in an account (`accountId`), the list syncs right away. */
export const MAIL_MESSAGE = 'roedy:push-mail';

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  url: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Stand-in origin: `safePath` only checks that a path stays on whichever origin it resolves against. */
const BASE = 'https://app.invalid';

/** C0 controls and DEL: the URL parser drops tab and newlines, so "/\t/host" would become "//host". */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * App path from `data.url`: only same-origin paths ("/…", not "//…", with a
 * scheme, a backslash or control characters), otherwise `/start` – a message
 * must not lead out of the app. Beyond the textual rules, the path must also
 * resolve to the same origin (defence in depth for parser quirks).
 */
export function safePath(url: unknown): string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return START_PATH;
  if (CONTROL.test(url)) return START_PATH;
  try {
    return new URL(url, BASE).origin === BASE ? url : START_PATH;
  } catch {
    return START_PATH;
  }
}

/**
 * Reads the backend's JSON message. If the title is missing or it is not
 * readable, `fallbackTitle` applies (the browser requires a visible
 * notification for every push).
 */
export function parsePush(raw: string | null | undefined, fallbackTitle: string): PushPayload {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const extra = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
  const payload: PushPayload = {
    title: text(record.title) || fallbackTitle,
    body: text(record.body),
    url: safePath(extra.url),
  };
  const icon = text(record.icon);
  if (icon.startsWith('/') && !icon.startsWith('//')) payload.icon = icon;
  const tag = text(record.tag);
  if (tag) payload.tag = tag;
  return payload;
}
