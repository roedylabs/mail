/**
 * Copy for starting without network: without `public/config`,
 * `auth/me`, mail accounts and settings the app would only get from the cache
 * to the error page `offline`. The copy lives in `localStorage` only for
 * signed-in accounts, contains no tokens and ends with the session: signing
 * out and an ended session delete it (effect in the layout), as does "Clear
 * local data". In the storage overview it counts as local data.
 */
import { localStore } from '#lib/last-page.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import type { StoredSettings } from '#lib/state/prefs.svelte.ts';
import type { Me, PublicConfig } from '#lib/state/session.svelte.ts';

export const START_COPY_KEY = 'roedy-mail:start';
/** Increases when the structure changes; an older copy is then no longer valid. */
const FORMAT = 2;

export interface StartCopy {
  config: PublicConfig;
  user: Me;
  accounts: MailAccount[];
  settings: StoredSettings;
}

function isCopy(value: unknown): value is StartCopy & { format: number } {
  if (typeof value !== 'object' || value === null) return false;
  const copy = value as Partial<StartCopy> & { format?: unknown };
  return copy.format === FORMAT && !!copy.config && !!copy.user && Array.isArray(copy.accounts) && !!copy.settings;
}

export function readStartCopy(): StartCopy | null {
  try {
    const raw = localStore()?.getItem(START_COPY_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isCopy(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores the copy; if the storage is full, there simply is no start without network. */
export function saveStartCopy(copy: StartCopy): void {
  try {
    localStore()?.setItem(START_COPY_KEY, JSON.stringify({ format: FORMAT, ...copy }));
  } catch {
    // Full or blocked.
  }
}

export function forgetStartCopy(): void {
  try {
    localStore()?.removeItem(START_COPY_KEY);
  } catch {
    // Blocked: nothing stored.
  }
}
