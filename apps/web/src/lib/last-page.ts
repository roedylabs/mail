/**
 * "Open at start: last opened page" (`gStart` `last`, Settings › General). The
 * app stores the last opened page of the shell per device in the browser
 * (`localStorage`, with the ID of the account, so that after an account switch on
 * the same device nothing foreign opens). "Clear local data" removes it too.
 * `/start` leads there on entry (opened without a predecessor, after the
 * redirect from `/`, after sign-in); the logo keeps leading to the inbox.
 */
import { isAdminPath, isAppPath, isGuestPath, NO_ACCOUNT_PATH, START_PATH } from '#lib/routes.ts';

export const LAST_PAGE_KEY = 'roedy-mail:last-page';

/**
 * Pages that do not count as "last opened": entry, start page,
 * drafts (maybe sent by now), OAuth and the search (the search
 * term would otherwise remain in the browser after sign-out; the page
 * before it applies).
 */
const SKIP = [START_PATH, NO_ACCOUNT_PATH, '/compose/', '/oauth/', '/search'];

/** Whether `path` is a page of the shell that may open again at the next start. */
export function isRememberable(path: string): boolean {
  if (path === '/' || isGuestPath(path)) return false;
  return !SKIP.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));
}

/**
 * Whether `/start` is an entry from `from` (then `gStart` applies): opened
 * without a predecessor, from `/` or after sign-in, setup or invitation.
 * Not the logo and not "To the start page" of the error page – otherwise a
 * broken last page would lead to the error again and again.
 */
export function isEntry(from: string | null): boolean {
  return from === null || from === '/' || (isGuestPath(from) && !from.startsWith('/error/'));
}

/** `localStorage` if the browser allows it (blocked e.g. with blocked site data), otherwise `null`. */
export function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Remembers `url` for the account `user` if it is a page of the shell. */
export function rememberPage(user: string, url: { pathname: string; search: string }): void {
  if (!isRememberable(url.pathname)) return;
  try {
    localStore()?.setItem(LAST_PAGE_KEY, JSON.stringify({ user, path: url.pathname + url.search }));
  } catch {
    // Storage full or blocked: the next start opens the inbox.
  }
}

/** Last opened page of the account `user`, otherwise `null`; administration pages only while it is an administrator. */
export function lastPage(user: string, admin: boolean): string | null {
  try {
    const raw = localStore()?.getItem(LAST_PAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { user: owner, path } = value as { user?: unknown; path?: unknown };
    if (owner !== user || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
    const pathname = path.split(/[?#]/, 1)[0] ?? '';
    // Only pages that still exist: a stale address would open the 404 page.
    return isAppPath(pathname) && isRememberable(pathname) && (admin || !isAdminPath(pathname)) ? path : null;
  } catch {
    return null;
  }
}

/** Forgets the page (account deleted). */
export function forgetPage(): void {
  try {
    localStore()?.removeItem(LAST_PAGE_KEY);
  } catch {
    // Blocked: nothing stored.
  }
}
