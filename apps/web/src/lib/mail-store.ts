/**
 * Store for mailboxes, lists, tags and messages in the browser: one
 * IndexedDB per app user. Only what the server answered is
 * written, batched and without feedback: it is a cache; if it fails (full,
 * locked, no IndexedDB), the app loads as without it. Tokens do not go in,
 * nor do attachments.
 */
import type { Id, Mailbox } from '@roedy/jmap';
import type { ListThread, SegmentCounts } from '#lib/mail-list.ts';
import type { MessageEmail } from '#lib/state/message.svelte.ts';

const PREFIX = 'roedy-mail-mail:';
/**
 * Version of the database; a new version discards everything.
 * Also increases when the structure of `Mailbox`, `ListThread`, `SavedList`,
 * `SavedThread` or `MessageEmail` changes: records survive an app update.
 */
const SCHEMA = 2;
/** Writing collects for this long (ms): syncs often come in quick succession. */
const WRITE_DELAY = 250;
/** If the store hangs (ms), the app loads without it. */
const READ_LIMIT = 2000;

/** Conversations per list. */
export const MAX_LIST_THREADS = 200;
/** Lists per mail account; the most recently written stay. */
export const MAX_LISTS = 30;
/** Texts per conversation; above this the oldest emails lack their text. */
export const MAX_THREAD_BYTES = 4 << 20;
/** Texts per mail account; the conversations unused for the longest go first. */
export const MAX_ACCOUNT_BYTES = 32 << 20;
/** Conversations with text per mail account. */
export const MAX_ACCOUNT_THREADS = 500;
/** Details of an email without its texts, roughly in bytes. */
const EMAIL_BYTES = 2048;

const MAILBOXES = 'mailboxes';
const LISTS = 'lists';
const USER = 'user';
const MESSAGES = 'messages';
const HEADS = 'heads';
const STORES = [MAILBOXES, LISTS, USER];
const THREAD_STORES = [MESSAGES, HEADS];
const BY_AGE = 'age';
const BY_EMAIL = 'email';
const TAGS_KEY = 'tags';

/** Mailboxes of a mail account with the state for `Mailbox/changes`. */
export interface SavedMailboxes {
  account: string;
  accountId: Id;
  state: string;
  list: Mailbox[];
}

/** Part of a list: an account, its mailboxes, a segment. */
export interface SavedList {
  key: string;
  account: string;
  ids: Id[];
  threads: ListThread[];
  total: number;
  counts: Partial<SegmentCounts>;
  queryState: string | null;
  /** Up to here the record knows all changes (`Email/changes`). */
  emailState: string | null;
  done: boolean;
}

/** Conversation with texts. */
export interface SavedThread {
  /** `threadKey()`. */
  key: string;
  account: string;
  threadId: Id;
  emails: MessageEmail[];
}

/** Saved email without texts: for search and sync. */
export type SavedMail = Pick<
  MessageEmail,
  'id' | 'receivedAt' | 'from' | 'to' | 'subject' | 'preview' | 'mailboxIds' | 'keywords' | 'hasAttachment'
> & {
  /** File names of the attachments (matches in the attachments area). */
  attachments: string[];
};

/** Details of a `SavedThread` without texts: limit, cleanup and search read only these. */
export interface ThreadHead {
  key: string;
  account: string;
  threadId: Id;
  /** Rough size in bytes. */
  size: number;
  /** Last written or opened (ms). */
  usedAt: number;
  mails: SavedMail[];
  /** `emailRef()` per email. */
  refs: string[];
}

export const threadKey = (account: string, threadId: Id): string => JSON.stringify([account, threadId]);

/** Email ids apply per account, the index applies to all. */
const emailRef = (account: string, id: Id): string => JSON.stringify([account, id]);

const sizeOf = (email: MessageEmail): number =>
  Object.values(email.bodyValues).reduce((sum, v) => sum + v.value.length, EMAIL_BYTES);

/**
 * Emails as the store takes them: the newest keep their text until
 * `MAX_THREAD_BYTES` is reached; the rest lack it (`miss`), and the reading
 * view shows the "not saved for offline use" card there.
 */
export function fitThread(emails: readonly MessageEmail[]): MessageEmail[] {
  let room = MAX_THREAD_BYTES;
  return [...emails]
    .reverse()
    .map((email) => {
      room -= sizeOf(email);
      return room < 0 ? { ...email, bodyValues: {}, miss: true as const } : email;
    })
    .reverse();
}

function headOf(saved: SavedThread, usedAt: number): ThreadHead {
  const { key, account, threadId, emails } = saved;
  return {
    key,
    account,
    threadId,
    size: emails.reduce((sum, e) => sum + sizeOf(e), 0),
    usedAt,
    mails: emails.map((e) => ({
      id: e.id,
      receivedAt: e.receivedAt,
      from: e.from,
      to: e.to,
      subject: e.subject,
      preview: e.preview,
      mailboxIds: e.mailboxIds,
      keywords: e.keywords,
      hasAttachment: e.hasAttachment,
      attachments: e.attachments.flatMap((p) => (p.name ? [p.name] : [])),
    })),
    refs: emails.map((e) => emailRef(account, e.id)),
  };
}

/** Store of an app user. Reading returns `null` if nothing is there or access fails. */
export interface MailStore {
  mailboxes(account: string): Promise<SavedMailboxes | null>;
  saveMailboxes(saved: SavedMailboxes): void;
  list(key: string): Promise<SavedList | null>;
  saveList(saved: SavedList): void;
  /** All lists of an account (search); empty if access fails. */
  lists(account: string): Promise<SavedList[]>;
  thread(key: string): Promise<SavedThread | null>;
  saveThread(saved: SavedThread): void;
  /** A conversation from the store was opened: it stays longer. */
  useThread(key: string): void;
  dropThread(key: string): void;
  /** Discards the conversations that one of these emails belongs to. */
  dropEmails(account: string, ids: Iterable<Id>): void;
  /** Details of all conversations of an account without texts; empty if access fails. */
  heads(account: string): Promise<ThreadHead[]>;
  tags<T>(): Promise<T[] | null>;
  saveTags(tags: readonly unknown[]): void;
  /** Discards the records of all accounts not in `accounts`. */
  retain(accounts: readonly string[]): void;
}

export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

export function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB'));
  });
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((done) => {
    const request = indexedDB.deleteDatabase(name);
    // "blocked": another connection closes shortly on `versionchange`, then the deletion happens.
    request.onsuccess = request.onerror = request.onblocked = () => done();
  });
}

/** Reads with a time limit: if the store hangs or fails, `null` applies. */
export async function limited<T>(read: () => Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_LIMIT);
  });
  try {
    return await Promise.race([read(), limit]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Databases with the prefix; without `databases()` (older browsers) only the named one. */
export async function databaseNames(prefix: string, known: string | null): Promise<string[]> {
  const list = (await globalThis.indexedDB?.databases?.()) ?? [];
  const names = list.flatMap((db) => (db.name?.startsWith(prefix) ? [db.name] : []));
  return known && !names.includes(known) ? [...names, known] : names;
}

class UserMailStore implements MailStore {
  readonly name: string;
  #db: Promise<IDBDatabase | null> | null = null;
  #pending = new Map<string, { store: string; value: unknown; key?: string }>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(user: string) {
    this.name = PREFIX + user;
  }

  mailboxes(account: string): Promise<SavedMailboxes | null> {
    return this.#read(MAILBOXES, account);
  }

  saveMailboxes(saved: SavedMailboxes): void {
    this.#write(MAILBOXES, saved.account, saved);
  }

  list(key: string): Promise<SavedList | null> {
    return this.#read(LISTS, key);
  }

  saveList(saved: SavedList): void {
    this.#write(LISTS, saved.key, saved);
  }

  lists(account: string): Promise<SavedList[]> {
    return this.#byAccount(LISTS, account);
  }

  thread(key: string): Promise<SavedThread | null> {
    return this.#read(MESSAGES, key);
  }

  saveThread(saved: SavedThread): void {
    this.#write(MESSAGES, saved.key, saved);
  }

  useThread(key: string): void {
    void this.#use(key).catch(() => {});
  }

  dropThread(key: string): void {
    this.#pending.delete(`${MESSAGES}/${key}`);
    void this.#dropKeys(() => [key]).catch(() => {});
  }

  dropEmails(account: string, ids: Iterable<Id>): void {
    const refs = [...ids].map((id) => emailRef(account, id));
    void this.#dropKeys(async (heads) => {
      const found = await Promise.all(refs.map((ref) => result(heads.index(BY_EMAIL).getAllKeys(ref))));
      return found.flat();
    }).catch(() => {});
  }

  heads(account: string): Promise<ThreadHead[]> {
    return this.#byAccount(HEADS, account);
  }

  tags<T>(): Promise<T[] | null> {
    return this.#read(USER, TAGS_KEY);
  }

  saveTags(tags: readonly unknown[]): void {
    this.#write(USER, TAGS_KEY, tags, TAGS_KEY);
  }

  retain(accounts: readonly string[]): void {
    void this.#retain(accounts).catch(() => {});
  }

  /** Ends the store: pending writes stay unwritten, the connection closes. */
  close(): void {
    this.#closed = true;
    this.#pending.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const db = this.#db;
    this.#db = null;
    void db?.then((d) => d?.close());
  }

  #open(): Promise<IDBDatabase | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#db ??= new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB?.open(this.name, SCHEMA);
        if (!request) {
          resolve(null);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
          db.createObjectStore(MAILBOXES, { keyPath: 'account' });
          const lists = db.createObjectStore(LISTS, { keyPath: 'key' });
          lists.createIndex(BY_AGE, ['account', 'savedAt']);
          db.createObjectStore(USER);
          db.createObjectStore(MESSAGES, { keyPath: 'key' });
          const heads = db.createObjectStore(HEADS, { keyPath: 'key' });
          heads.createIndex(BY_AGE, ['account', 'usedAt']);
          heads.createIndex(BY_EMAIL, 'refs', { multiEntry: true });
        };
        request.onsuccess = () => {
          const db = request.result;
          const gone = () => {
            this.#db = null;
          };
          // Another tab is deleting: make room, the next write reopens.
          db.onversionchange = () => {
            db.close();
            gone();
          };
          // The browser closed the connection, e.g. when clearing storage.
          db.onclose = gone;
          resolve(db);
        };
        // With `blocked`, `success` still comes: as soon as the old connection is closed, the new one applies.
        request.onerror = () => {
          this.#db = null;
          resolve(null);
        };
      } catch {
        this.#db = null;
        resolve(null);
      }
    });
    return this.#db;
  }

  #read<T>(store: string, key: string): Promise<T | null> {
    return limited(() => this.#get<T>(store, key));
  }

  /** Records of an account via the `BY_AGE` index, oldest first. */
  async #byAccount<T>(store: string, account: string): Promise<T[]> {
    const all = await limited(async () => {
      const db = await this.#open();
      if (!db) return null;
      const index = db.transaction(store).objectStore(store).index(BY_AGE);
      return (await result(index.getAll(IDBKeyRange.bound([account], [account, []])))) as T[];
    });
    return all ?? [];
  }

  async #get<T>(store: string, key: string): Promise<T | null> {
    const queued = this.#pending.get(`${store}/${key}`);
    if (queued) return queued.value as T;
    const db = await this.#open();
    if (!db) return null;
    return ((await result(db.transaction(store).objectStore(store).get(key))) as T | undefined) ?? null;
  }

  #write(store: string, id: string, value: unknown, key?: string): void {
    if (this.#closed) return;
    this.#pending.set(`${store}/${id}`, key === undefined ? { store, value } : { store, value, key });
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      void this.#flush().catch(() => {});
    }, WRITE_DELAY);
  }

  /**
   * Writes everything pending. Texts go in a separate transaction: if the
   * store fills up with them, lists and mailboxes still arrive.
   */
  async #flush(): Promise<void> {
    const writes = [...this.#pending.values()];
    this.#pending.clear();
    const db = await this.#open();
    if (!db || !writes.length) return;
    const threads = writes.filter((w) => w.store === MESSAGES).map((w) => w.value as SavedThread);
    const rest = writes.filter((w) => w.store !== MESSAGES);
    await Promise.allSettled([
      rest.length ? this.#flushLists(db, rest) : null,
      threads.length ? this.#flushThreads(db, threads) : null,
    ]);
  }

  /** Writes in one transaction and removes the oldest lists of the affected accounts. */
  async #flushLists(db: IDBDatabase, writes: { store: string; value: unknown; key?: string }[]): Promise<void> {
    const tx = db.transaction(STORES, 'readwrite');
    const now = Date.now();
    const touched = new Set<string>();
    for (const { store, value, key } of writes) {
      if (store === LISTS) {
        const saved = value as SavedList;
        touched.add(saved.account);
        tx.objectStore(LISTS).put({ ...saved, savedAt: now });
      } else if (key === undefined) tx.objectStore(store).put(value);
      else tx.objectStore(store).put(value, key);
    }
    const lists = tx.objectStore(LISTS);
    for (const account of touched) {
      const keys = lists.index(BY_AGE).getAllKeys(IDBKeyRange.bound([account], [account, []]));
      keys.onsuccess = () => {
        for (const key of keys.result.slice(0, Math.max(0, keys.result.length - MAX_LISTS))) lists.delete(key);
      };
    }
    await finished(tx);
  }

  /** Writes conversations and keeps the limits of the affected accounts. */
  async #flushThreads(db: IDBDatabase, threads: SavedThread[]): Promise<void> {
    try {
      await this.#writeThreads(db, threads);
    } catch (error) {
      // The browser gives no more: make room, the next state tries again.
      if ((error as Error | null)?.name === 'QuotaExceededError') await this.#shrink(db);
      else throw error;
    }
  }

  async #writeThreads(db: IDBDatabase, threads: SavedThread[]): Promise<void> {
    const tx = db.transaction(THREAD_STORES, 'readwrite');
    const messages = tx.objectStore(MESSAGES);
    const heads = tx.objectStore(HEADS);
    const now = Date.now();
    for (const saved of threads) {
      messages.put(saved);
      heads.put(headOf(saved, now));
    }
    for (const account of new Set(threads.map((t) => t.account))) {
      const all = heads.index(BY_AGE).getAll(IDBKeyRange.bound([account], [account, []]));
      all.onsuccess = () => {
        const list = all.result as ThreadHead[];
        let count = list.length;
        let bytes = list.reduce((sum, h) => sum + h.size, 0);
        for (const head of list) {
          if (count <= MAX_ACCOUNT_THREADS && bytes <= MAX_ACCOUNT_BYTES) break;
          messages.delete(head.key);
          heads.delete(head.key);
          count -= 1;
          bytes -= head.size;
        }
      };
    }
    await finished(tx);
  }

  /** Discards the quarter of conversations unused for the longest. */
  async #shrink(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(THREAD_STORES, 'readwrite');
    const heads = tx.objectStore(HEADS);
    const all = (await result(heads.getAll())) as ThreadHead[];
    const oldest = all.sort((a, b) => a.usedAt - b.usedAt).slice(0, Math.ceil(all.length / 4));
    for (const { key } of oldest) {
      heads.delete(key);
      tx.objectStore(MESSAGES).delete(key);
    }
    await finished(tx);
  }

  async #use(key: string): Promise<void> {
    const db = await this.#open();
    if (!db) return;
    const tx = db.transaction(HEADS, 'readwrite');
    const heads = tx.objectStore(HEADS);
    const head = (await result(heads.get(key))) as ThreadHead | undefined;
    if (head) heads.put({ ...head, usedAt: Date.now() });
    await finished(tx);
  }

  /** Discards the named conversations; `keys` runs in the same transaction. */
  async #dropKeys(keys: (heads: IDBObjectStore) => IDBValidKey[] | Promise<IDBValidKey[]>): Promise<void> {
    const db = await this.#open();
    if (!db) return;
    const tx = db.transaction(THREAD_STORES, 'readwrite');
    const heads = tx.objectStore(HEADS);
    for (const key of await keys(heads)) {
      heads.delete(key);
      tx.objectStore(MESSAGES).delete(key);
    }
    await finished(tx);
  }

  async #retain(accounts: readonly string[]): Promise<void> {
    const db = await this.#open();
    if (!db) return;
    const tx = db.transaction([MAILBOXES, LISTS, ...THREAD_STORES], 'readwrite');
    const boxes = tx.objectStore(MAILBOXES);
    for (const key of await result(boxes.getAllKeys()))
      if (typeof key === 'string' && !accounts.includes(key)) boxes.delete(key);
    /** Walks the records via the index and deletes those of other accounts. */
    const sweep = (name: string, drop: (key: IDBValidKey) => void) => {
      const cursor = tx.objectStore(name).index(BY_AGE).openKeyCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const [account] = c.key as [string, number];
        if (!accounts.includes(account)) drop(c.primaryKey);
        c.continue();
      };
    };
    sweep(LISTS, (key) => tx.objectStore(LISTS).delete(key));
    sweep(HEADS, (key) => {
      tx.objectStore(HEADS).delete(key);
      tx.objectStore(MESSAGES).delete(key);
    });
  }
}

/** Store per app user; exactly one is open at any time. */
export class MailStores {
  #current: UserMailStore | null = null;
  #user: string | null = null;
  #paused = false;

  /** Store of the user; `null` without IndexedDB and while this tab stores nothing (`pause()`). */
  of(user: string): MailStore | null {
    if (this.#paused || !globalThis.indexedDB) return null;
    if (this.#user === user && this.#current) return this.#current;
    this.#current?.close();
    this.#user = user;
    const store = new UserMailStore(user);
    this.#current = store;
    // Whatever the previous user left behind (session ended unnoticed) goes now.
    void this.#drop((name) => name !== store.name).catch(() => {});
    return store;
  }

  /** Deletes the store of all users; afterwards the next access reopens. */
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

export const mailStores = new MailStores();
