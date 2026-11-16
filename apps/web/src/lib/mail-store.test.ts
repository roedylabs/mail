// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListThread } from '#lib/mail-list.ts';
import type { MessageEmail } from '#lib/state/message.svelte.ts';
import {
  fitThread,
  MAX_ACCOUNT_BYTES,
  MAX_ACCOUNT_THREADS,
  MAX_LISTS,
  MAX_THREAD_BYTES,
  MailStores,
  threadKey,
  type MailStore,
  type SavedList,
  type SavedMailboxes,
  type SavedThread,
} from './mail-store.ts';

const boxes = (account: string, state = 's1'): SavedMailboxes => ({ account, accountId: 'j1', state, list: [] });

const list = (key: string, account = 'a'): SavedList => ({
  key,
  account,
  ids: ['e1'],
  threads: [{ id: 'e1' } as ListThread],
  total: 1,
  counts: { all: 1 },
  queryState: 'q',
  emailState: 'e',
  done: true,
});

const mail = (id: string, bytes = 10): MessageEmail =>
  ({
    id,
    receivedAt: 1,
    from: [],
    to: [],
    subject: `Subject ${id}`,
    preview: 'Vorschau',
    mailboxIds: ['m1'],
    keywords: {},
    hasAttachment: false,
    attachments: [{ name: 'a.pdf' }, {}],
    bodyValues: { 1: { value: 'x'.repeat(bytes), isTruncated: false, isEncodingProblem: false } },
  }) as unknown as MessageEmail;

const thread = (id: string, account = 'a', bytes = 10): SavedThread => ({
  key: threadKey(account, id),
  account,
  threadId: id,
  emails: [mail(`e-${id}`, bytes)],
});

/** Waits until the batched write is done. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 280));

const names = async () => (await indexedDB.databases()).map((db) => db.name);

describe('MailStores', () => {
  let stores: MailStores;
  let store: MailStore;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    stores = new MailStores();
    store = stores.of('u1')!;
  });

  afterEach(async () => {
    await stores.dropAll();
    vi.unstubAllGlobals();
  });

  it('reads what was written, also before batching', async () => {
    store.saveMailboxes(boxes('a'));
    expect(await store.mailboxes('a')).toEqual(boxes('a'));
    store.saveList(list('k'));
    store.saveTags([{ id: 't' }]);
    await settled();
    expect(await store.tags()).toEqual([{ id: 't' }]);
    expect(await store.list('k')).toMatchObject({ key: 'k', ids: ['e1'], emailState: 'e' });
    expect(await store.list('missing')).toBeNull();
    expect(await store.mailboxes('missing')).toBeNull();
  });

  it('writes only the latest state per key', async () => {
    store.saveMailboxes(boxes('a', 's1'));
    store.saveMailboxes(boxes('a', 's2'));
    await settled();
    expect((await store.mailboxes('a'))?.state).toBe('s2');
  });

  it('separates app users: a second one sees nothing, and the database of the first goes', async () => {
    store.saveMailboxes(boxes('a'));
    await settled();
    expect(await names()).toEqual(['roedy-mail-mail:u1']);
    const other = stores.of('u2')!;
    expect(await other.mailboxes('a')).toBeNull();
    await vi.waitFor(async () => expect(await names()).toEqual(['roedy-mail-mail:u2']));
  });

  it('keeps only the newest lists per account', async () => {
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < MAX_LISTS + 3; i++) {
      now.mockReturnValue(1000 + i);
      store.saveList(list(`k${i}`));
      await settled();
    }
    store.saveList(list('other', 'b'));
    await settled();
    now.mockRestore();
    expect(await store.list('k0')).toBeNull();
    expect(await store.list('k2')).toBeNull();
    expect(await store.list('k3')).not.toBeNull();
    expect(await store.list('other')).not.toBeNull();
  }, 20_000);

  it('discards the records of removed accounts', async () => {
    store.saveMailboxes(boxes('a'));
    store.saveMailboxes(boxes('b'));
    store.saveList(list('ka', 'a'));
    store.saveList(list('kb', 'b'));
    await settled();
    store.retain(['a']);
    await vi.waitFor(async () => expect(await store.mailboxes('b')).toBeNull());
    await vi.waitFor(async () => expect(await store.list('kb')).toBeNull());
    expect(await store.mailboxes('a')).not.toBeNull();
    expect(await store.list('ka')).not.toBeNull();
  });

  it('deletes everything on request, and afterwards it continues', async () => {
    store.saveMailboxes(boxes('a'));
    await settled();
    await stores.dropAll();
    expect(await names()).toEqual([]);
    const again = stores.of('u1')!;
    expect(await again.mailboxes('a')).toBeNull();
    again.saveMailboxes(boxes('a', 'new'));
    expect((await again.mailboxes('a'))?.state).toBe('new');
  });

  it('discards what is not written yet when deleting', async () => {
    store.saveMailboxes(boxes('a'));
    await stores.dropAll();
    await settled();
    expect(await names()).toEqual([]);
  });

  it('stores nothing after "Clear local data"', async () => {
    store.saveMailboxes(boxes('a'));
    stores.pause();
    expect(stores.of('u1')).toBeNull();
    await settled();
    expect(await names()).toEqual([]);
  });

  it('copes with deletion from another tab', async () => {
    store.saveMailboxes(boxes('a'));
    await settled();
    await new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase('roedy-mail-mail:u1');
      request.onsuccess = () => done();
    });
    expect(await store.mailboxes('a')).toBeNull();
    store.saveMailboxes(boxes('a', 'new'));
    await settled();
    expect((await store.mailboxes('a'))?.state).toBe('new');
  });

  it('stores conversations with texts and details without texts separately', async () => {
    store.saveThread(thread('t1'));
    expect((await store.thread(threadKey('a', 't1')))?.emails[0]?.id).toBe('e-t1');
    await settled();
    expect((await store.thread(threadKey('a', 't1')))?.emails[0]?.bodyValues[1]?.value).toBe('x'.repeat(10));
    const [head] = await store.heads('a');
    expect(head).toMatchObject({ threadId: 't1', size: 2058 });
    expect(head?.mails[0]).toMatchObject({ id: 'e-t1', subject: 'Subject e-t1', attachments: ['a.pdf'] });
    expect(head?.mails[0]).not.toHaveProperty('bodyValues');
    expect(await store.heads('b')).toEqual([]);
  });

  it('shortens conversations that are too large starting with the oldest email', () => {
    const fitted = fitThread([mail('old', MAX_THREAD_BYTES), mail('new', 100)]);
    expect(fitted.map((e) => e.miss)).toEqual([true, undefined]);
    expect(fitted[0]?.bodyValues).toEqual({});
    expect(fitted[1]?.bodyValues[1]?.value).toHaveLength(100);
  });

  it('keeps the number of conversations per account, the ones unused for the longest go first', async () => {
    store.saveThread(thread('t0'));
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.saveThread(thread('t1'));
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 2; i < MAX_ACCOUNT_THREADS; i++) store.saveThread(thread(`t${i}`));
    store.saveThread(thread('foreign', 'b'));
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // `useThread` makes t0 the most recently used, so t1 is the oldest.
    store.useThread(threadKey('a', 't0'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.saveThread(thread('new'));
    await settled();
    const threads = (await store.heads('a')).map((h) => h.threadId);
    expect(threads).toHaveLength(MAX_ACCOUNT_THREADS);
    expect(threads).toContain('t0');
    expect(threads).toContain('new');
    expect(threads).not.toContain('t1');
    expect(await store.thread(threadKey('a', 't1'))).toBeNull();
    expect(await store.heads('b')).toHaveLength(1);
  });

  it('keeps the size per account', async () => {
    const big = Math.ceil(MAX_ACCOUNT_BYTES / 3);
    for (const id of ['t1', 't2', 't3']) {
      store.saveThread(thread(id, 'a', big));
      await settled();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const threads = (await store.heads('a')).map((h) => h.threadId);
    expect(threads).toEqual(['t2', 't3']);
    expect(await store.thread(threadKey('a', 't1'))).toBeNull();
  });

  it('discards conversations individually, by emails and with the account', async () => {
    store.saveThread(thread('t1'));
    store.saveThread(thread('t2'));
    store.saveThread(thread('t3'));
    store.saveThread(thread('t4', 'b'));
    await settled();
    store.dropThread(threadKey('a', 't1'));
    store.dropEmails('a', ['e-t2', 'e-t4']);
    await settled();
    expect((await store.heads('a')).map((h) => h.threadId)).toEqual(['t3']);
    expect(await store.thread(threadKey('a', 't2'))).toBeNull();
    expect((await store.heads('b')).map((h) => h.threadId)).toEqual(['t4']);
    store.retain(['b']);
    await settled();
    expect(await store.heads('a')).toEqual([]);
    expect(await store.thread(threadKey('a', 't3'))).toBeNull();
    expect(await store.thread(threadKey('b', 't4'))).not.toBeNull();
  });

  it('takes an unwritten discard seriously', async () => {
    store.saveThread(thread('t1'));
    store.dropThread(threadKey('a', 't1'));
    await settled();
    expect(await store.heads('a')).toEqual([]);
  });

  it('reads all lists of an account', async () => {
    store.saveList(list('l1'));
    store.saveList(list('l2'));
    store.saveList(list('l3', 'b'));
    await settled();
    expect((await store.lists('a')).map((l) => l.key).sort()).toEqual(['l1', 'l2']);
  });

  it('writes lists even when the store for texts is full, and then cleans up', async () => {
    for (let i = 0; i < 8; i++) store.saveThread(thread(`t${i}`));
    await settled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- bound with `call`
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name !== 'messages') return put.call(this, value, key);
      Object.defineProperty(this.transaction, 'error', { value: new DOMException('voll', 'QuotaExceededError') });
      this.transaction.abort();
      throw new DOMException('voll', 'QuotaExceededError');
    });
    store.saveList(list('l1'));
    store.saveThread(thread('new'));
    await settled();
    spy.mockRestore();
    expect(await store.list('l1')).not.toBeNull();
    expect(await store.heads('a')).toHaveLength(6);
  });

  it('works without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const none = new MailStores();
    expect(none.of('u1')).toBeNull();
    await expect(none.dropAll()).resolves.toBeUndefined();
  });
});
