// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditLogs, queueKey, type EditLog, type QueuedDraft, type QueuedEdit } from './mail-queue.ts';
import { MailStores } from './mail-store.ts';

const item = (key: string, account = 'k1', patch: Partial<QueuedEdit> = {}): QueuedEdit => ({
  key,
  account,
  edits: [['e1', { keywords: { $seen: true }, mailboxIds: { in: false, trash: true } }]],
  subjects: { e1: 'Subject' },
  quiet: false,
  ...patch,
});

/** Offline version; `text` distinguishes versions with the same key. */
const draft = (key: string, account = 'k1', text = 'Hello', patch: Partial<QueuedDraft> = {}): QueuedDraft => ({
  key,
  account,
  email: {
    from: { name: 'Anna', email: 'a@example.com' },
    to: [{ name: null, email: 'b@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Subject',
    text,
    attachments: [],
    inReplyTo: null,
    references: null,
    keywords: {},
    mailboxIds: [],
    messageId: 'm1@roedy.invalid',
  },
  replace: null,
  moved: null,
  at: 1,
  ...patch,
});

const names = async () => (await indexedDB.databases()).map((db) => db.name);
const keys = async (log: EditLog) => (await log.all())?.map((i) => i.key);
const draftKeys = async (log: EditLog) => (await log.drafts())?.map((d) => d.key);

describe('EditLogs', () => {
  let logs: EditLogs;
  let log: EditLog;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    logs = new EditLogs();
    log = logs.of('u1')!;
  });

  afterEach(async () => {
    await logs.dropAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns entries in the order of their keys, not of writing', async () => {
    expect(await log.add(item('2'))).toBe(true);
    expect(await log.add(item('3'))).toBe(true);
    expect(await log.add(item('1'))).toBe(true);
    expect(await keys(log)).toEqual(['1', '2', '3']);
  });

  it('returns an entry completely and removes it individually', async () => {
    const quiet = item('1', 'k2', { subjects: { e1: 'Invoice' }, quiet: true });
    await log.add(quiet);
    await log.add(item('2'));
    expect(await log.all()).toEqual([quiet, item('2')]);
    await log.remove('1');
    expect(await keys(log)).toEqual(['2']);
    await log.remove('missing');
    expect(await keys(log)).toEqual(['2']);
  });

  it('reports `false` if the entry cannot be written', async () => {
    const broken = item('1', 'k1', { subjects: { e1: (() => '') as unknown as string } });
    expect(await log.add(broken)).toBe(false);
    expect(await log.all()).toEqual([]);
  });

  it('`retain` deletes only the entries of other accounts', async () => {
    await log.add(item('1', 'k1'));
    await log.add(item('2', 'k2'));
    await log.add(item('3', 'k3'));
    await log.retain(['k1', 'k3']);
    expect(await keys(log)).toEqual(['1', '3']);
    await log.retain([]);
    expect(await log.all()).toEqual([]);
  });

  it('keeps a version completely', async () => {
    const full = draft('1', 'k2', 'Text', {
      replace: { account: 'k2', id: 'd1' },
      moved: { account: 'k1', id: 'd2' },
      at: 42,
    });
    expect(await log.putDraft(full)).toBe(true);
    expect(await log.drafts()).toEqual([full]);
  });

  it('`putDraft` replaces the version with the same key and leaves others', async () => {
    await log.putDraft(draft('1', 'k1', 'first'));
    await log.putDraft(draft('2', 'k1', 'other'));
    await log.putDraft(draft('1', 'k1', 'second'));
    expect((await log.drafts())?.map((d) => [d.key, d.email.text])).toEqual([
      ['1', 'second'],
      ['2', 'other'],
    ]);
  });

  it('`removeDraft` removes individually and ignores unknown ones', async () => {
    await log.putDraft(draft('1'));
    await log.putDraft(draft('2'));
    await log.removeDraft('1');
    await log.removeDraft('missing');
    expect(await draftKeys(log)).toEqual(['2']);
  });

  it('keeps actions and versions apart, even with the same key', async () => {
    await log.add(item('1'));
    await log.putDraft(draft('1'));
    await log.remove('1');
    expect(await draftKeys(log)).toEqual(['1']);
    await log.add(item('1'));
    await log.removeDraft('1');
    expect(await keys(log)).toEqual(['1']);
    expect(await log.drafts()).toEqual([]);
  });

  it('reports `false` if the version cannot be written', async () => {
    const broken = draft('1', 'k1', 'x', { email: (() => null) as unknown as QueuedDraft['email'] });
    expect(await log.putDraft(broken)).toBe(false);
    expect(await log.drafts()).toEqual([]);
  });

  it('`retain` deletes actions and versions of other accounts', async () => {
    await log.add(item('1', 'k1'));
    await log.add(item('2', 'k2'));
    await log.putDraft(draft('3', 'k1'));
    await log.putDraft(draft('4', 'k2'));
    await log.retain(['k1']);
    expect(await keys(log)).toEqual(['1']);
    expect(await draftKeys(log)).toEqual(['3']);
    await log.retain([]);
    expect(await log.all()).toEqual([]);
    expect(await log.drafts()).toEqual([]);
  });

  it('`dropAll` also deletes the versions', async () => {
    await log.putDraft(draft('1'));
    await logs.dropAll();
    expect(await logs.of('u1')!.drafts()).toEqual([]);
  });

  it('returns the same queue for the same user', () => {
    expect(logs.of('u1')).toBe(log);
  });

  it('discards the databases of other users', async () => {
    await log.add(item('1'));
    expect(await names()).toEqual(['roedy-mail-queue:u1']);
    const other = logs.of('u2')!;
    await other.add(item('2'));
    await vi.waitFor(async () => expect(await names()).toEqual(['roedy-mail-queue:u2']));
    expect(await keys(other)).toEqual(['2']);
  });

  it('discards what an earlier visit of another user left behind', async () => {
    await log.add(item('1'));
    const later = new EditLogs();
    const other = later.of('u2')!;
    await other.add(item('2'));
    await vi.waitFor(async () => expect(await names()).toEqual(['roedy-mail-queue:u2']));
    await later.dropAll();
  });

  it('`dropAll` deletes the queue, afterwards an empty one starts', async () => {
    await log.add(item('1'));
    await logs.dropAll();
    expect(await names()).toEqual([]);
    expect(await logs.of('u1')!.all()).toEqual([]);
  });

  it('`pause()` then returns `null`, and nothing is written anymore', async () => {
    await log.add(item('1'));
    logs.pause();
    expect(logs.of('u1')).toBeNull();
    expect(logs.of('u2')).toBeNull();
    // `dropAll()` deletes the data; `pause()` only stops this tab.
    await logs.dropAll();
    expect(await names()).toEqual([]);
    expect(logs.of('u1')).toBeNull();
  });

  it('returns `null` without IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(new EditLogs().of('u1')).toBeNull();
  });

  it('survives deleting the mail store: its own database', async () => {
    const stores = new MailStores();
    stores.of('u1')!.saveTags([{ id: 't' }]);
    await log.add(item('1'));
    await stores.dropAll();
    expect(await keys(log)).toEqual(['1']);
    expect(await names()).toEqual(['roedy-mail-queue:u1']);
  });

  it('reopens when another tab has deleted the database', async () => {
    await log.add(item('1'));
    const tab = new EditLogs();
    tab.of('u1');
    await tab.dropAll();
    expect(await log.all()).toEqual([]);
    expect(await log.add(item('2'))).toBe(true);
    expect(await keys(log)).toEqual(['2']);
  });

  it('returns `null` and `false` if the database cannot be opened', async () => {
    const open = vi.fn(() => {
      throw new Error('locked');
    });
    vi.stubGlobal('indexedDB', { open, databases: () => Promise.resolve([]) });
    const blocked = new EditLogs().of('u1')!;
    expect(await blocked.all()).toBeNull();
    expect(await blocked.add(item('1'))).toBe(false);
    await blocked.remove('1');
    expect(await blocked.drafts()).toBeNull();
    expect(await blocked.putDraft(draft('1'))).toBe(false);
    await blocked.removeDraft('1');
    await blocked.retain([]);
    expect(open).toHaveBeenCalled();
  });

  it('tries again if opening fails with `onerror`', async () => {
    const open = vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onerror?.(new Event('error'));
      });
      return request;
    });
    vi.stubGlobal('indexedDB', { open, databases: () => Promise.resolve([]) });
    const failing = new EditLogs().of('u1')!;
    expect(await failing.all()).toBeNull();
    expect(await failing.add(item('1'))).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('tries again if `indexedDB.open()` throws once', async () => {
    const open = vi.fn(() => {
      throw new Error('locked');
    });
    vi.stubGlobal('indexedDB', { open, databases: () => Promise.resolve([]) });
    const blocked = new EditLogs().of('u1')!;
    expect(await blocked.all()).toBeNull();
    expect(await blocked.add(item('1'))).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('gives up after two seconds if the storage hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', { open: () => ({}), databases: () => Promise.resolve([]) });
    const hanging = new EditLogs().of('u1')!;
    const read = hanging.all();
    await vi.advanceTimersByTimeAsync(1999);
    let done = false;
    void read.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBeNull();
  });
});

describe('queueKey', () => {
  it('sorts by time, then by counter, also across digit changes', () => {
    const list = [
      queueKey(1_000, 2),
      queueKey(999, 7),
      queueKey(1_000, 10),
      queueKey(1_767_225_600_000, 1),
      queueKey(1_000, 1),
    ];
    expect(list.toSorted()).toEqual([
      queueKey(999, 7),
      queueKey(1_000, 1),
      queueKey(1_000, 2),
      queueKey(1_000, 10),
      queueKey(1_767_225_600_000, 1),
    ]);
  });

  it('distinguishes time and counter', () => {
    expect(queueKey(1, 2)).not.toBe(queueKey(2, 1));
    expect(queueKey(1, 2)).toBe(queueKey(1, 2));
  });
});
