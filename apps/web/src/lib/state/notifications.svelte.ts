/**
 * State module `notifications`: entries of the
 * bell from `GET notifications` with icon, title, text and target, as the
 * backend builds them from the event catalogue.
 *
 * - **Fetch** (`watch`): at start, every 60 s while the page is visible, on
 *   returning to the tab, after an interrupted connection and on
 *   opening the bell. There is no dedicated live channel for notifications
 *   (real time would need a push channel).
 * - **Read**: one entry on opening, the loaded ones via "Mark all
 *   as read" (`POST notifications/read` with `ids`). The display changes immediately;
 *   if the call fails, the entry becomes unread again.
 * - **Remove** with undo (`ui.toasts.defer`): the
 *   entry disappears immediately, `DELETE notifications/:id` follows after the
 *   toast; a fetch in the meantime does not bring it back.
 * - **Sound** (`nSound`): on new unread entries after the
 *   first fetch, as long as the channel "In the app" and the topic in the app are
 *   on.
 * - **First load failed** (`failure`): as long as there is no list, the bell
 *   shows a "Couldn’t load notifications" card with the reason instead of the
 *   placeholder rows; every later fetch (try again, opening the bell) shows
 *   the placeholder rows again until its response.
 */
import { api, isApiError } from '#lib/api.ts';
import { armChime, chime } from '#lib/chime.ts';
import { failText, loadFailText } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import { pollVisible } from '#lib/state/network.svelte.ts';
import { prefs, type Channels } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Interval of the fetches while the page is visible. */
export const POLL_MS = 60_000;

/** Target of an entry: area, page, path and, if needed, the entry. */
export interface NotificationTarget {
  view: 'settings' | 'admin' | 'mailacct';
  page: string;
  path: string;
  user_id?: string;
  invitation_id?: string;
  mail_account_id?: string;
}

/** Entry from `GET notifications`. */
export interface AppNotification {
  id: string;
  topic: string;
  kind: string;
  /** Class of the Tabler icons (`ti-…`); unknown ones show the bell icon. */
  icon: string;
  title: string;
  /** Empty when falling back to the topic (unknown event). */
  text: string;
  target: NotificationTarget | null;
  created_at: string;
  read_at: string | null;
}

/** What the module needs from the browser; replaceable in tests. */
export interface NotificationsEnv {
  /** Plays the sound. */
  chime(): void;
  /** Prepares the sound on the first interaction (autoplay rules); returns the cleanup. */
  arm(): () => void;
  /** Page visible. */
  visible(): boolean;
}

const browserEnv: NotificationsEnv = {
  chime,
  arm: armChime,
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
};

/**
 * Topic wanted in the app (`nMx[topic].app`); security always (locked,
 * Entries created before deselecting stay hidden as well.
 */
export function shownInApp(topic: string, topics: Readonly<Record<string, Channels>>): boolean {
  return topic === 'security' || topics[topic]?.app !== false;
}

/** Time "read" until the next server response. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Newest first like the backend's list. */
function newestFirst(a: AppNotification, b: AppNotification): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

export class Notifications {
  env: NotificationsEnv = browserEnv;
  /** Entries of the bell; `null` until the first response. */
  list = $state<AppNotification[] | null>(null);
  /** A fetch is running (the open list is marked `aria-busy` until its response). */
  loading = $state(false);
  /** Reason of the failed first load (`loadFailText`); `null` once a list is there or before the first answer. */
  failure = $state<string | null>(null);

  /** IDs already shown: only entries that are newly added play the sound. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, not displayed
  #seen = new Set<string>();
  /** Removed, but still in the toast with undo (or in flight). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, not displayed
  #removing = new Set<string>();
  /** Counts `reset()`; responses and actions from an earlier session expire. */
  #generation = 0;
  /** Counts local changes; a fetch that began before is discarded. */
  #changes = 0;
  #loading: Promise<void> | null = null;

  /** Reloads the list; a running fetch is shared. Errors leave the last state. */
  load(): Promise<void> {
    if (this.#loading) return this.#loading;
    const loading = this.#fetch().finally(() => {
      // After `reset()` a new fetch may already be running; only release the own one.
      if (this.#loading !== loading) return;
      this.#loading = null;
      this.loading = false;
    });
    this.#loading = loading;
    this.loading = true;
    return loading;
  }

  async #fetch(): Promise<void> {
    const generation = this.#generation;
    const changes = this.#changes;
    try {
      const { notifications } = await api<{ notifications: AppNotification[]; unread: number }>('GET', 'notifications');
      if (generation !== this.#generation || changes !== this.#changes) return;
      this.#apply(notifications);
      this.failure = null;
    } catch (error) {
      // Without a response the bell keeps its last state; the next fetch tries again.
      // Without a list yet, the bell shows the reason instead of the placeholder rows.
      if (generation === this.#generation && this.list === null) this.failure = loadFailText(error);
      // Session ended (other tab, password reset): reload the account, the layout then shows the sign-in.
      if (generation === this.#generation && isApiError(error, 401)) void session.refreshUser().catch(() => {});
    }
  }

  #apply(items: AppNotification[]): void {
    const first = this.list === null;
    const shown = items.filter((n) => !this.#removing.has(n.id));
    const values = prefs.values;
    const fresh = shown.some((n) => !n.read_at && !this.#seen.has(n.id) && shownInApp(n.topic, values.nMx));
    for (const n of items) this.#seen.add(n.id);
    this.list = shown;
    if (!first && fresh && values.nSound && values.nCh.app) this.env.chime();
  }

  #setRead(ids: readonly string[], read: string | null): void {
    if (!this.list) return;
    this.list = this.list.map((n) => (ids.includes(n.id) ? { ...n, read_at: read } : n));
  }

  /** Entry opened: mark as read (without a message if it fails). */
  async read(id: string): Promise<void> {
    if (!this.list?.some((n) => n.id === id && !n.read_at)) return;
    const generation = this.#generation;
    const ids = [id];
    this.#changes++;
    this.#setRead(ids, nowIso());
    try {
      await api('POST', 'notifications/read', { ids: [id] });
    } catch {
      if (generation === this.#generation) this.#setRead(ids, null);
    }
  }

  /**
   * "Mark all as read": the loaded unread ones (at most 200 like
   * the list), not `all` – that would also hit entries created since the last
   * fetch that nobody has seen yet. If it fails, they are
   * unread again, with an error toast.
   */
  async readAll(): Promise<void> {
    const ids = (this.list ?? []).filter((n) => !n.read_at).map((n) => n.id);
    if (!ids.length) return;
    const generation = this.#generation;
    this.#changes++;
    this.#setRead(ids, nowIso());
    try {
      await api('POST', 'notifications/read', { ids });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setRead(ids, null);
      ui.toasts.error(failText(error));
    }
  }

  /** Remove with undo: immediately out of the list, `DELETE` after the toast. */
  remove(id: string): void {
    const entry = this.list?.find((n) => n.id === id);
    if (!this.list || !entry) return;
    const generation = this.#generation;
    this.#removing.add(id);
    this.#changes++;
    this.list = this.list.filter((n) => n.id !== id);
    ui.toasts.defer({
      text: m.notif_pop_removed(),
      revert: () => {
        if (generation !== this.#generation) return;
        this.#removing.delete(id);
        if (!this.list || this.list.some((n) => n.id === id)) return;
        this.#changes++;
        this.list = [...this.list, entry].sort(newestFirst);
      },
      commit: async (keepalive) => {
        try {
          await api('DELETE', `notifications/${encodeURIComponent(id)}`, undefined, { keepalive });
        } catch (error) {
          // Already removed (e.g. in another tab): goal reached.
          if (!isApiError(error, 404)) throw error;
        }
        if (generation !== this.#generation) return;
        this.#removing.delete(id);
        // A fetch from the time of the toast still knows the entry.
        this.#changes++;
      },
      onError: (error) => ui.toasts.error(failText(error)),
    });
  }

  /**
   * Fetch at start, every `POLL_MS` while the page is visible, on returning
   * to the tab and after an interrupted connection (also after the
   * offline simulation); returns the cleanup.
   */
  watch(target: Window = window): () => void {
    void this.load();
    const disarm = this.env.arm();
    const stop = pollVisible(
      target,
      POLL_MS,
      () => this.env.visible(),
      () => void this.load(),
    );
    return () => {
      stop();
      disarm();
    };
  }

  /** Signed out: discard entries; running responses expire. */
  reset(): void {
    this.#generation++;
    this.list = null;
    this.failure = null;
    this.#seen.clear();
    this.#removing.clear();
    this.#loading = null;
    this.loading = false;
  }
}

export const notifications = new Notifications();
