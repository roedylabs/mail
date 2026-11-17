/**
 * Store for new mail in the service worker: a copy of quiet hours, time zone and account addresses that the app stores,
 * and per account the last check of the flow. IndexedDB, because the service
 * worker reaches neither `localStorage` nor, without a session, the settings.
 * Without runes and without DOM, so that app and service worker use the same path.
 */

/** Quiet hours from the settings; start = end counts as off. */
export interface QuietCopy {
  on: boolean;
  from: string;
  to: string;
  tz: string;
}

/** What the app stores for the service worker. */
export interface MailPushCopy {
  /**
   * App user the copy belongs to: the app removes the copy of another user
   * who signed in before in this browser, the service worker ignores a copy
   * without one.
   */
  user: string;
  quiet: QuietCopy;
  /** Addresses of all mail accounts by ID, for the text and for "multiple accounts". */
  accounts: Record<string, string>;
  appName: string;
  /** Language of the app for the notification texts. */
  lang: string;
}

/** Replaceable in tests. */
export interface MailPushStore {
  read(): Promise<MailPushCopy | null>;
  write(copy: MailPushCopy): Promise<void>;
  /** Last check of the flow, otherwise 0. */
  renewedAt(accountId: string): Promise<number>;
  markRenewed(accountId: string, at: number): Promise<void>;
  /** Removes everything; also the database, so that nothing remains for the storage measurement. */
  clear(): Promise<void>;
}

const DATABASE = 'roedy-mail-push';
const VALUES = 'values';
const COPY_KEY = 'copy';

function failure(error: DOMException | null | undefined): Error {
  return error ?? new Error('IndexedDB');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(VALUES);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error));
  });
}

/** One transaction; the connection closes afterwards, otherwise it would block "Clear local data". */
async function run<T>(mode: IDBTransactionMode, work: (values: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(VALUES, mode);
      const request = work(transaction.objectStore(VALUES));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(failure(transaction.error));
      transaction.onabort = () => reject(failure(transaction.error));
    });
  } finally {
    database.close();
  }
}

export const mailPushStore: MailPushStore = {
  read: async () =>
    (await run('readonly', (values) => values.get(COPY_KEY) as IDBRequest<MailPushCopy | undefined>)) ?? null,
  write: async (copy) => {
    await run('readwrite', (values) => values.put(copy, COPY_KEY));
  },
  renewedAt: async (accountId) =>
    (await run('readonly', (values) => values.get(accountId) as IDBRequest<number | undefined>)) ?? 0,
  markRenewed: async (accountId, at) => {
    await run('readwrite', (values) => values.put(at, accountId));
  },
  clear: () =>
    new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(DATABASE);
      // Blocked or failed: the entry goes with the next sign-out.
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    }),
};
