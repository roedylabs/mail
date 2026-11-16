/**
 * Queue for changes to emails in the browser: a separate
 * IndexedDB per app user. Unlike the mail store it is not a cache: a new
 * version or `client_cache_version` leaves it untouched, writes happen
 * immediately and with feedback. Entries survive an app update; their
 * structure may only change in a backward-compatible way.
 */
import type { Id } from '@roedy/jmap';
import type { EmailEdit } from '#lib/mail-actions.ts';
import type { ListThread } from '#lib/mail-list.ts';
import type { DraftEmail, SavedDraft } from '#lib/state/compose.svelte.ts';
import { databaseNames, deleteDatabase, finished, limited, result } from '#lib/mail-store.ts';

const PREFIX = 'roedy-mail-queue:';
const VERSION = 2;
const EDITS = 'edits';
const DRAFTS = 'drafts';

/** An action of an account waiting for the server. */
export interface QueuedEdit {
  /** Order (`queueKey()`). */
  key: string;
  account: string;
  edits: [Id, EmailEdit][];
  /** Subjects per email, as far as known: for the notice in case the server does not apply the change. */
  subjects: Record<Id, string>;
  /** Without user involvement (read on opening): no notice. */
  quiet: boolean;
  /** Conversations the change puts into a mailbox: the target shows them until replay. */
  rows?: ListThread[];
}

/** Draft version saved offline; one per draft, the newest replaces the previous one. */
export interface QueuedDraft {
  /** Stays the same across all versions; sorts like `QueuedEdit.key`. */
  key: string;
  /** Account of "Senden als": the draft is created there. */
  account: string;
  email: DraftEmail;
  /** State on the server in the same account that this version replaces; `null` for a new draft. */
  replace: SavedDraft | null;
  /** Draft in another account: "Senden als" changed, it goes after the replay. */
  moved: SavedDraft | null;
  /** Time of the version. */
  at: number;
}

/** Queue of an app user. */
export interface EditLog {
  /** All entries in their order; `null` if access fails. */
  all(): Promise<QueuedEdit[] | null>;
  /** Writes an entry; `false` if that fails (full, locked). */
  add(item: QueuedEdit): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** All drafts; `null` if access fails. */
  drafts(): Promise<QueuedDraft[] | null>;
  /** Writes a version, the previous one with the same key goes; `false` if that fails. */
  putDraft(item: QueuedDraft): Promise<boolean>;
  removeDraft(key: string): Promise<void>;
  /** Discards the entries of all accounts not in `accounts`. */
  retain(accounts: readonly string[]): Promise<void>;
}

const tab = Math.random().toString(36).slice(2, 8);

/** Key of an entry: time of the action, counter and tab; sorts in the order of the actions. */
export function queueKey(at: number, token: number): string {
  return `${String(at).padStart(16, '0')}-${String(token).padStart(8, '0')}-${tab}`;
}

class UserEditLog implements EditLog {
  readonly name: string;
  #db: Promise<IDBDatabase | null> | null = null;

  constructor(user: string) {
    this.name = PREFIX + user;
  }

  all(): Promise<QueuedEdit[] | null> {
    return limited(() => this.#readAll());
  }

  async add(item: QueuedEdit): Promise<boolean> {
    try {
      const db = await this.#open();
      if (!db) return false;
      const tx = db.transaction(EDITS, 'readwrite');
      tx.objectStore(EDITS).put(item);
      await finished(tx);
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      const db = await this.#open();
      if (!db) return;
      const tx = db.transaction(EDITS, 'readwrite');
      tx.objectStore(EDITS).delete(key);
      await finished(tx);
    } catch {
      // If the entry stays, the next run repeats it: the patches are idempotent.
    }
  }

  drafts(): Promise<QueuedDraft[] | null> {
    return limited(async () => {
      const db = await this.#open();
      if (!db) return null;
      return result(db.transaction(DRAFTS).objectStore(DRAFTS).getAll() as IDBRequest<QueuedDraft[]>);
    });
  }

  async putDraft(item: QueuedDraft): Promise<boolean> {
    try {
      const db = await this.#open();
      if (!db) return false;
      const tx = db.transaction(DRAFTS, 'readwrite');
      tx.objectStore(DRAFTS).put(item);
      await finished(tx);
      return true;
    } catch {
      return false;
    }
  }

  async removeDraft(key: string): Promise<void> {
    try {
      const db = await this.#open();
      if (!db) return;
      const tx = db.transaction(DRAFTS, 'readwrite');
      tx.objectStore(DRAFTS).delete(key);
      await finished(tx);
    } catch {
      // If the version stays, it goes out on the next run: better one draft too many.
    }
  }

  async retain(accounts: readonly string[]): Promise<void> {
    try {
      const [items, drafts] = await Promise.all([this.#readAll(), this.drafts()]);
      const db = await this.#open();
      if (!db || !items || !drafts) return;
      const tx = db.transaction([EDITS, DRAFTS], 'readwrite');
      for (const item of items) if (!accounts.includes(item.account)) tx.objectStore(EDITS).delete(item.key);
      for (const item of drafts) if (!accounts.includes(item.account)) tx.objectStore(DRAFTS).delete(item.key);
      await finished(tx);
    } catch {
      // The next account sync tries again.
    }
  }

  close(): void {
    const db = this.#db;
    this.#db = null;
    void db?.then((open) => open?.close());
  }

  async #readAll(): Promise<QueuedEdit[] | null> {
    const db = await this.#open();
    if (!db) return null;
    return result(db.transaction(EDITS).objectStore(EDITS).getAll() as IDBRequest<QueuedEdit[]>);
  }

  /** Open connection; if it fails, the next access tries again. */
  async #open(): Promise<IDBDatabase | null> {
    this.#db ??= this.#connect();
    const db = await this.#db;
    if (!db) this.#db = null;
    return db;
  }

  #connect(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB?.open(this.name, VERSION);
        if (!request) {
          resolve(null);
          return;
        }
        // Only create what is missing, so that waiting entries survive a future upgrade.
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of [EDITS, DRAFTS])
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          const gone = () => {
            this.#db = null;
          };
          // Another tab is deleting: make room, the next access reopens.
          db.onversionchange = () => {
            db.close();
            gone();
          };
          db.onclose = gone;
          resolve(db);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
}

/** Queue per app user; exactly one is open at any time. */
export class EditLogs {
  #current: UserEditLog | null = null;
  #user: string | null = null;
  #paused = false;

  /** Queue of the user; `null` without IndexedDB and after "Clear local data" (`pause()`). */
  of(user: string): EditLog | null {
    if (this.#paused || !globalThis.indexedDB) return null;
    if (this.#user === user && this.#current) return this.#current;
    this.#current?.close();
    this.#user = user;
    const log = new UserEditLog(user);
    this.#current = log;
    // Whatever the previous user left behind goes now.
    void this.#drop((name) => name !== log.name).catch(() => {});
    return log;
  }

  /** Waiting changes end with the session as well. */
  async dropAll(): Promise<void> {
    const known = this.#current?.name ?? null;
    this.#current?.close();
    this.#current = null;
    this.#user = null;
    await this.#drop(() => true, known).catch(() => {});
  }

  /** "Clear local data": this tab writes nothing more until the next full load. */
  pause(): void {
    this.#paused = true;
    this.#current?.close();
    this.#current = null;
    this.#user = null;
  }

  async #drop(match: (name: string) => boolean, known: string | null = null): Promise<void> {
    const names = await databaseNames(PREFIX, known);
    await Promise.all(names.filter(match).map(deleteDatabase));
  }
}

export const editLogs = new EditLogs();
