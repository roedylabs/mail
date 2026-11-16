// @vitest-environment jsdom
import { JmapError, MethodError, type Id } from '@roedy/jmap';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '#lib/api.ts';
import type { EmailEdit } from '#lib/mail-actions.ts';
import { EditLogs, type EditLog, type QueuedDraft, type QueuedEdit } from '#lib/mail-queue.ts';
import {
  DRAFT_PAUSE_MS,
  EditQueue,
  LOCAL_DRAFT,
  exclusive,
  unanswered,
  type DraftReplayer,
  type QueueEnv,
  type ReplayedDraft,
} from './edit-queue.svelte.ts';

const SEEN: EmailEdit = { keywords: { $seen: true } };
const STAR_ON: EmailEdit = { keywords: { $flagged: true } };
const STAR_OFF: EmailEdit = { keywords: { $flagged: false } };
const TO_TRASH: EmailEdit = { mailboxIds: { in: false, trash: true } };
const FROM_TRASH: EmailEdit = { mailboxIds: { trash: false, in: true } };
const TO_ARCHIVE: EmailEdit = { mailboxIds: { trash: false, archive: true } };

/** An action on `ids`; without a value an own email per key. */
const item = (key: string, account = 'k1', ids: Id[] = [`e${key}`], patch: Partial<QueuedEdit> = {}): QueuedEdit => ({
  key,
  account,
  edits: ids.map((id) => [id, SEEN]),
  subjects: Object.fromEntries(ids.map((id) => [id, `Subject ${id}`])),
  quiet: false,
  ...patch,
});

/** An action on an email with an own change. */
const change = (key: string, id: Id, edit: EmailEdit, account = 'k1'): QueuedEdit =>
  item(key, account, [id], { edits: [[id, edit]] });

/** Offline version; `text` distinguishes versions of the same draft. */
const draft = (key: string, account = 'k1', patch: Partial<QueuedDraft> = {}, text = 'Hello'): QueuedDraft => ({
  key,
  account,
  email: {
    from: { name: null, email: `${account}@example.com` },
    to: [],
    cc: [],
    bcc: [],
    subject: `Subject ${key}`,
    text,
    attachments: [],
    inReplyTo: null,
    references: null,
    keywords: {},
    mailboxIds: [],
    messageId: `${key}@roedy.invalid`,
  },
  replace: null,
  moved: null,
  at: 1,
  ...patch,
});

/**
 * Queue in memory; `refuse` makes writing fail, `read`
 * and `readDrafts` replace the result of `all()` and `drafts()`.
 */
function memoryLog() {
  const rows = new Map<string, QueuedEdit>();
  const draftRows = new Map<string, QueuedDraft>();
  const state = {
    refuse: false,
    read: null as Promise<QueuedEdit[] | null> | null,
    readDrafts: null as Promise<QueuedDraft[] | null> | null,
  };
  const log: EditLog = {
    all: () => state.read ?? Promise.resolve([...rows.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1))),
    add: (i) => {
      if (state.refuse) return Promise.resolve(false);
      rows.set(i.key, i);
      return Promise.resolve(true);
    },
    remove: (key) => {
      rows.delete(key);
      return Promise.resolve();
    },
    drafts: () => state.readDrafts ?? Promise.resolve([...draftRows.values()]),
    putDraft: (d) => {
      if (state.refuse) return Promise.resolve(false);
      draftRows.set(d.key, d);
      return Promise.resolve(true);
    },
    removeDraft: (key) => {
      draftRows.delete(key);
      return Promise.resolve();
    },
    retain: (accounts) => {
      for (const [key, i] of rows) if (!accounts.includes(i.account)) rows.delete(key);
      for (const [key, d] of draftRows) if (!accounts.includes(d.account)) draftRows.delete(key);
      return Promise.resolve();
    },
  };
  return { log, rows, draftRows, state };
}

function setup(patch: Partial<QueueEnv> = {}) {
  const memory = memoryLog();
  const noAccess = new Set<string>();
  const browser = { offline: false };
  const replay = vi.fn<QueueEnv['replay']>(() => Promise.resolve([]));
  const restored = vi.fn<QueueEnv['restored']>();
  const finished = vi.fn<QueueEnv['finished']>();
  const transferred = vi.fn<QueueEnv['transferred']>();
  const env: QueueEnv = {
    log: () => memory.log,
    replay,
    offline: () => browser.offline,
    lacksAccess: (account) => noAccess.has(account),
    exclusive: (task) => task(),
    restored,
    finished,
    transferred,
    ...patch,
  };
  const queue = new EditQueue(env);
  const replayer = {
    replay: vi.fn<DraftReplayer['replay']>((d) => Promise.resolve({ id: `new-${d.key}`, conflict: false })),
    replayed: vi.fn<DraftReplayer['replayed']>(),
    revoke: vi.fn<DraftReplayer['revoke']>(),
  };
  queue.attach(replayer);
  /** Entries as after reloading: they lie in the database, and nothing is running yet. */
  const seed = async (...items: QueuedEdit[]) => {
    for (const i of items) memory.rows.set(i.key, i);
    await queue.restore();
    restored.mockClear();
  };
  /** Like `seed` for drafts. */
  const seedDrafts = async (...items: QueuedDraft[]) => {
    for (const d of items) memory.draftRows.set(d.key, d);
    await queue.restore();
  };
  return { queue, seed, seedDrafts, replayer, noAccess, browser, replay, restored, finished, transferred, ...memory };
}

/** Promise that the test resolves from outside. */
function gate<T = Id[]>() {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const offline = () => new NetworkError(new Error('gone'));
const nextTask = () => new Promise((resolve) => setTimeout(resolve));
const keysOf = (queue: EditQueue) => queue.items.map((i) => i.key);
const draftKeys = (queue: EditQueue) => queue.drafts.map((d) => d.key);
const replayed = (replay: ReturnType<typeof setup>['replay']) =>
  replay.mock.calls.map(([account, edits]) => [account, ...edits.keys()]);

describe('unanswered', () => {
  it.each([
    ['NetworkError', offline()],
    ['unreachable', new JmapError('unreachable')],
    ['502', new JmapError('status', { status: 502 })],
    ['503', new JmapError('status', { status: 503 })],
    ['504', new JmapError('status', { status: 504 })],
    ['502 from the backend', new ApiError(502, {})],
  ])('counts %s as a missing response', (_name, error) => {
    expect(unanswered(error)).toBe(true);
  });

  it.each([
    ['500', new JmapError('status', { status: 500 })],
    ['403 as status', new JmapError('status', { status: 403 })],
    ['403', new JmapError('forbidden', { status: 403 })],
    ['401', new JmapError('auth', { status: 401 })],
    ['429', new JmapError('throttled', { status: 429 })],
    ['a status without a number', new JmapError('status')],
    ['a method error', new MethodError('Email/set', 'c0', { type: 'serverUnavailable' })],
    ['another error', new Error('500')],
    ['nothing', undefined],
  ])('counts %s as a response', (_name, error) => {
    expect(unanswered(error)).toBe(false);
  });
});

describe('exclusive', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs unprotected without `navigator.locks`', async () => {
    const task = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', {});
    await exclusive(task);
    expect(task).toHaveBeenCalledOnce();
  });

  it('runs with the lock and skips the tab if it is taken', async () => {
    let free = true;
    const request = vi.fn((_name: string, _options: unknown, run: (lock: unknown) => unknown) =>
      Promise.resolve(run(free ? { name: 'roedy-mail-queue' } : null)),
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const task = vi.fn(() => Promise.resolve());
    await exclusive(task);
    expect(task).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('roedy-mail-queue', { ifAvailable: true }, expect.any(Function));
    free = false;
    await exclusive(task);
    expect(task).toHaveBeenCalledOnce();
  });
});

describe('EditQueue', () => {
  it('takes in entries in the order of their keys and writes them immediately', async () => {
    const { queue, rows } = setup();
    await queue.add(item('2'), true);
    await queue.add(item('1'), true);
    expect(keysOf(queue)).toEqual(['1', '2']);
    expect(queue.count).toBe(2);
    expect([...rows.keys()]).toEqual(['2', '1']);
  });

  it('merges the entries of an account in their order into one call', async () => {
    const { queue, seed, replay } = setup();
    await seed(item('3', 'k1', ['c']), item('1', 'k1', ['a']), item('2', 'k1', ['b']));
    await queue.replay();
    expect(replayed(replay)).toEqual([['k1', 'a', 'b', 'c']]);
    expect(queue.count).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it('passes the changes of an account as a map', async () => {
    const { queue, seed, replay } = setup();
    await seed(item('1', 'k1', ['a', 'b']));
    await queue.replay();
    expect(replay.mock.calls[0]?.[1]).toEqual(
      new Map([
        ['a', SEEN],
        ['b', SEEN],
      ]),
    );
  });

  it('removes the entries only after the response', async () => {
    const { queue, seed, replay, rows } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1'), item('2'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await nextTask();
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.count).toBe(2);
    expect(rows.size).toBe(2);
    first.open([]);
    await run;
    expect(replay).toHaveBeenCalledOnce();
    expect(rows.size).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it('does not let an account without a response hold up the other one', async () => {
    const { queue, seed, replay, transferred } = setup();
    const silent = gate();
    replay.mockImplementation((account) => (account === 'k1' ? silent.promise : Promise.resolve([])));
    await seed(item('1', 'k1'), item('2', 'k2'), item('3', 'k2'));
    const run = queue.replay();
    await vi.waitFor(() => expect(keysOf(queue)).toEqual(['1']));
    expect(replay).toHaveBeenCalledTimes(2);
    silent.fail(offline());
    await run;
    expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('leaves all entries of the account without a response, and `stuck` names it', async () => {
    const { queue, seed, replay, finished, rows } = setup();
    replay.mockRejectedValue(offline());
    await seed(item('1'), item('2'), item('3', 'k2'));
    expect(queue.stuck).toEqual([]);
    await queue.replay();
    expect(replayed(replay)).toEqual([
      ['k1', 'e1', 'e2'],
      ['k2', 'e3'],
    ]);
    expect(keysOf(queue)).toEqual(['1', '2', '3']);
    expect(rows.size).toBe(3);
    expect(finished).not.toHaveBeenCalled();
    expect(queue.stuck).toEqual([
      { account: 'k1', count: 2 },
      { account: 'k2', count: 1 },
    ]);
  });

  it('tries again on the next trigger with all entries and clears `stuck` on success', async () => {
    const { queue, seed, replay, transferred } = setup();
    replay.mockRejectedValueOnce(offline());
    await seed(item('1', 'k1', ['a']), item('2', 'k1', ['b']));
    await queue.replay();
    expect(queue.stuck).toEqual([{ account: 'k1', count: 2 }]);
    await queue.replay();
    expect(replayed(replay)).toEqual([
      ['k1', 'a', 'b'],
      ['k1', 'a', 'b'],
    ]);
    expect(queue.stuck).toEqual([]);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('`add` with `failed` names the account without starting a replay', async () => {
    const { queue, replay } = setup();
    await queue.add(item('1'), true);
    expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    await nextTask();
    expect(replay).not.toHaveBeenCalled();
  });

  it('`add` without `failed` starts the replay', async () => {
    const { queue, replay, transferred } = setup();
    await queue.add(item('1'), false);
    await vi.waitFor(() => expect(transferred).toHaveBeenCalledWith(1));
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.count).toBe(0);
  });

  it('`resume()` clears `stuck` immediately and replays', async () => {
    const { queue, seed, replay, transferred } = setup();
    replay.mockRejectedValueOnce(offline());
    await seed(item('1'));
    await queue.replay();
    expect(queue.stuck).toHaveLength(1);
    queue.resume();
    expect(queue.stuck).toEqual([]);
    await vi.waitFor(() => expect(transferred).toHaveBeenCalledWith(1));
    expect(queue.count).toBe(0);
  });

  it('lets an account without access wait and names it in `stuck`', async () => {
    const { queue, seed, replay, noAccess, transferred } = setup();
    noAccess.add('k1');
    await seed(item('1'), item('2'), item('3', 'k2'));
    await queue.replay();
    expect(replayed(replay)).toEqual([['k2', 'e3']]);
    expect(queue.stuck).toEqual([{ account: 'k1', count: 2 }]);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    // After signing in again (`reached`) it continues.
    noAccess.clear();
    expect(queue.stuck).toEqual([]);
    await queue.replay();
    expect(queue.count).toBe(0);
  });

  it('pauses when an account loses access during the run', async () => {
    const { queue, seed, replay, noAccess } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await queue.add(item('2'), false);
    noAccess.add('k1');
    first.open([]);
    await run;
    expect(replay).toHaveBeenCalledOnce();
    expect(keysOf(queue)).toEqual(['2']);
    expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
  });

  it.each([
    ['accountNotFound', new MethodError('Email/set', 'c0', { type: 'accountNotFound' })],
    ['requestTooLarge', new MethodError('Email/set', 'c0', { type: 'requestTooLarge' })],
    ['invalidArguments', new MethodError('Email/get', 'c0', { type: 'invalidArguments' })],
    ['a rejected request', new JmapError('request', { status: 400, type: 'limit', limit: 'maxSizeRequest' })],
  ])('discards all emails of the account on %s, the other accounts keep going', async (_name, error) => {
    const { queue, seed, replay, finished, rows, transferred } = setup();
    replay.mockImplementation((account) => (account === 'k1' ? Promise.reject(error) : Promise.resolve([])));
    await seed(item('1', 'k1', ['a', 'b']), item('2', 'k1', ['c']), item('3', 'k2', ['d']));
    await queue.replay();
    expect(finished).toHaveBeenCalledWith('1', ['a', 'b']);
    expect(finished).toHaveBeenCalledWith('2', ['c']);
    expect(finished).toHaveBeenCalledWith('3', []);
    expect(queue.lost).toEqual({ count: 3, subject: 'Subject a' });
    expect(queue.count).toBe(0);
    expect(rows.size).toBe(0);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    ['serverUnavailable', new MethodError('Email/set', 'c0', { type: 'serverUnavailable' })],
    ['serverFail', new MethodError('Email/set', 'c0', { type: 'serverFail' })],
    ['serverPartialFail', new MethodError('Email/set', 'c0', { type: 'serverPartialFail' })],
    ['rateLimit', new MethodError('Email/set', 'c0', { type: 'rateLimit' })],
    ['auth', new JmapError('auth', { status: 401 })],
    ['throttled', new JmapError('throttled', { status: 429 })],
    ['Status 500', new JmapError('status', { status: 500 })],
    ['Status 503', new JmapError('status', { status: 503 })],
    ['unreachable', new JmapError('unreachable')],
    ['NetworkError', offline()],
  ])('pauses on %s and loses nothing', async (_name, error) => {
    const { queue, seed, replay, finished, rows, transferred } = setup();
    replay.mockRejectedValue(error);
    await seed(item('1'), item('2'));
    await queue.replay();
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.count).toBe(2);
    expect(rows.size).toBe(2);
    expect(queue.lost).toBeNull();
    expect(finished).not.toHaveBeenCalled();
    expect(transferred).not.toHaveBeenCalled();
    expect(queue.stuck).toEqual([{ account: 'k1', count: 2 }]);
  });

  it('counts emails in `lost`, names the first subject and skips quiet ones', async () => {
    const { queue, seed, replay, finished } = setup();
    replay.mockImplementation((_account, edits) => Promise.resolve([...edits.keys()]));
    await seed(item('1', 'k1', ['a'], { quiet: true }), item('2', 'k1', ['b', 'c']), item('3', 'k1', ['d']));
    await queue.replay();
    expect(queue.lost).toEqual({ count: 3, subject: 'Subject b' });
    expect(finished).toHaveBeenCalledWith('1', ['a']);
    expect(finished).toHaveBeenCalledWith('2', ['b', 'c']);
    expect(finished).toHaveBeenCalledWith('3', ['d']);
  });

  it('names the subject of the rejected email on a conflict, not of the first of the entry', async () => {
    const { queue, seed, replay } = setup();
    replay.mockResolvedValue(['b']);
    await seed(item('1', 'k1', ['a', 'b', 'c']));
    await queue.replay();
    expect(queue.lost).toEqual({ count: 1, subject: 'Subject b' });
  });

  it('gives `finished` per entry only its emails', async () => {
    const { queue, seed, replay, finished } = setup();
    replay.mockResolvedValue(['b', 'c']);
    await seed(item('1', 'k1', ['a', 'b']), item('2', 'k1', ['c', 'd']), item('3', 'k1', ['e']));
    await queue.replay();
    expect(finished).toHaveBeenCalledWith('1', ['b']);
    expect(finished).toHaveBeenCalledWith('2', ['c']);
    expect(finished).toHaveBeenCalledWith('3', []);
  });

  it('leaves the subject empty if the entry does not know it', async () => {
    const { queue, seed, replay } = setup();
    replay.mockResolvedValue(['a']);
    await seed(item('1', 'k1', ['a'], { subjects: {} }));
    await queue.replay();
    expect(queue.lost).toEqual({ count: 1, subject: '' });
  });

  it('takes the subject from the visible entry if a quiet one hits the same email', async () => {
    const { queue, seed, replay } = setup();
    replay.mockResolvedValue(['a']);
    await seed(item('1', 'k1', ['a'], { quiet: true, subjects: { a: 'Still' } }), change('2', 'a', STAR_ON));
    await queue.replay();
    expect(queue.lost).toEqual({ count: 1, subject: 'Subject a' });
  });

  it('reports nothing at all for quiet entries', async () => {
    const { queue, seed, replay, transferred } = setup();
    replay.mockResolvedValue(['e1']);
    await seed(item('1', 'k1', ['e1'], { quiet: true }));
    await queue.replay();
    expect(queue.lost).toBeNull();
    expect(transferred).not.toHaveBeenCalled();
  });

  it('keeps counting `lost` over several rounds and keeps the first subject', async () => {
    const { queue, seed, replay } = setup();
    replay.mockResolvedValueOnce(['a']);
    await seed(item('1', 'k1', ['a']));
    await queue.replay();
    replay.mockResolvedValueOnce(['b']);
    await seed(item('2', 'k1', ['b']));
    await queue.replay();
    expect(queue.lost).toEqual({ count: 2, subject: 'Subject a' });
  });

  it('counts partial loss in `lost`, `transferred` names only the arrived emails', async () => {
    const { queue, seed, replay, transferred, finished } = setup();
    replay.mockResolvedValueOnce(['b']);
    await seed(item('1', 'k1', ['a', 'b']), item('2', 'k1', ['c']));
    await queue.replay();
    expect(finished).toHaveBeenCalledWith('1', ['b']);
    expect(finished).toHaveBeenCalledWith('2', []);
    expect(queue.lost).toEqual({ count: 1, subject: 'Subject b' });
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('reports `transferred` once per run with the emails of all accounts', async () => {
    const { queue, seed, transferred } = setup();
    await seed(item('1', 'k1', ['a', 'b']), item('2', 'k2', ['a']), item('3', 'k1', ['b', 'c']));
    await queue.replay();
    expect(transferred).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('reports no `transferred` without success', async () => {
    const { queue, seed, replay, transferred } = setup();
    replay.mockRejectedValue(offline());
    await seed(item('1'));
    await queue.replay();
    expect(transferred).not.toHaveBeenCalled();
  });

  it('replays in the next round what is added during the run', async () => {
    const { queue, seed, replay, transferred } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await queue.add(item('2'), false);
    first.open([]);
    await run;
    expect(replayed(replay)).toEqual([
      ['k1', 'e1'],
      ['k1', 'e2'],
    ]);
    expect(queue.count).toBe(0);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('also takes along the entry of an account that has not run so far', async () => {
    const { queue, seed, replay, transferred } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1', 'k1'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await queue.add(item('2', 'k2'), false);
    first.open([]);
    await run;
    expect(replayed(replay)).toEqual([
      ['k1', 'e1'],
      ['k2', 'e2'],
    ]);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('replays an entry that arrives between the end of the loop and the release of the lock', async () => {
    const release = gate<void>();
    const { queue, seed, replay } = setup({
      exclusive: async (task) => {
        await task();
        await release.promise;
      },
    });
    await seed(item('1'));
    const run = queue.replay();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    await nextTask();
    await queue.add(item('2'), false);
    release.open();
    await run;
    await nextTask();
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('knows waiting accounts with `holds()`; a run does not hold up other accounts', async () => {
    const { queue, seed, replay } = setup();
    expect(queue.holds('k1')).toBe(false);
    await seed(item('1', 'k1'));
    expect(queue.holds('k1')).toBe(true);
    expect(queue.holds('k2')).toBe(false);
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(queue.holds('k1')).toBe(true);
    expect(queue.holds('k2')).toBe(false);
    first.open([]);
    await run;
    expect(queue.holds('k1')).toBe(false);
    expect(queue.holds('k2')).toBe(false);
  });

  it('starts with the database contents without own entries', async () => {
    const { queue, rows, replay, restored } = setup();
    rows.set('1', item('1'));
    await queue.replay();
    expect(restored).toHaveBeenCalledExactlyOnceWith(item('1'));
    expect(replay).toHaveBeenCalledOnce();
  });

  it('does nothing without entries', async () => {
    const { queue, replay, transferred } = setup();
    await queue.replay();
    expect(replay).not.toHaveBeenCalled();
    expect(transferred).not.toHaveBeenCalled();
    expect(queue.replaying).toBe(0);
  });

  it('replays nothing if another tab has the lock', async () => {
    const { queue, seed, replay } = setup({ exclusive: () => Promise.resolve() });
    await seed(item('1'));
    await queue.replay();
    expect(replay).not.toHaveBeenCalled();
    expect(queue.count).toBe(1);
    expect(queue.holds('k2')).toBe(false);
  });

  it('`restore()` takes over new entries and reports them once', async () => {
    const { queue, rows, restored, finished } = setup();
    rows.set('2', item('2'));
    rows.set('1', item('1'));
    await queue.restore();
    await queue.restore();
    expect(keysOf(queue)).toEqual(['1', '2']);
    expect(restored.mock.calls.map(([i]) => i.key)).toEqual(['1', '2']);
    expect(finished).not.toHaveBeenCalled();
  });

  it('`restore()` reports what another tab has finished as done without loss', async () => {
    const { queue, seed, rows, finished } = setup();
    await seed(item('1'), item('2'));
    rows.delete('1');
    await queue.restore();
    expect(finished).toHaveBeenCalledExactlyOnceWith('1', []);
    expect(keysOf(queue)).toEqual(['2']);
  });

  it('`restore()` does not bring back finished entries, even if `all()` read before the deletion', async () => {
    const { queue, seed, state, replay, restored } = setup();
    await seed(item('1'));
    const stale = gate<QueuedEdit[] | null>();
    state.read = stale.promise;
    const reading = queue.restore();
    state.read = null;
    await queue.replay();
    expect(queue.items).toEqual([]);

    stale.open([item('1')]);
    await reading;
    expect(queue.items).toEqual([]);
    expect(queue.count).toBe(0);
    expect(restored).not.toHaveBeenCalled();
    await queue.replay();
    expect(replay).toHaveBeenCalledOnce();
  });

  it('`restore()` keeps entries whose writing failed', async () => {
    const { queue, state, finished } = setup();
    state.refuse = true;
    await queue.add(item('1'), true);
    await queue.restore();
    expect(queue.count).toBe(1);
    expect(finished).not.toHaveBeenCalled();
  });

  it('`restore()` leaves everything as it is if the database does not answer', async () => {
    const { queue, seed, state, finished } = setup();
    await seed(item('1'));
    state.read = Promise.resolve(null);
    await queue.restore();
    expect(queue.count).toBe(1);
    expect(finished).not.toHaveBeenCalled();
  });

  it("works from the tab's memory without a database", async () => {
    const { queue, replay, transferred } = setup({ log: () => null });
    await queue.restore();
    await queue.add(item('1'), false);
    await vi.waitFor(() => expect(transferred).toHaveBeenCalledWith(1));
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.count).toBe(0);
  });

  it('`retain` discards the entries of foreign accounts including the database and reports their emails', async () => {
    const { queue, seed, rows, finished } = setup();
    await seed(item('1', 'k1'), item('2', 'k2', ['a', 'b']));
    queue.retain(['k1']);
    expect(keysOf(queue)).toEqual(['1']);
    expect(queue.count).toBe(1);
    expect(finished).toHaveBeenCalledExactlyOnceWith('2', ['a', 'b']);
    await vi.waitFor(() => expect([...rows.keys()]).toEqual(['1']));
    expect(queue.lost).toBeNull();
  });

  it('`retain` does not let discarded entries come back from an older read either', async () => {
    const { queue, seed, rows } = setup();
    await seed(item('1', 'k1'), item('2', 'k2'));
    const stale = rows.get('2')!;
    queue.retain(['k1']);
    rows.set('2', stale);
    await queue.restore();
    expect(keysOf(queue)).toEqual(['1']);
  });

  it('`reset()` during a run ends it without further calls', async () => {
    const { queue, seed, replay, finished, transferred, rows } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1'), item('2'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    queue.reset();
    expect(queue.count).toBe(0);
    expect(queue.replaying).toBe(0);
    first.open(['e1']);
    await run;
    expect(replay).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    expect(transferred).not.toHaveBeenCalled();
    expect(queue.lost).toBeNull();
    expect(rows.size).toBe(2);
    expect(queue.holds('k1')).toBe(false);
  });

  it('`reset()` also skips the failure of the running entry', async () => {
    const { queue, seed, replay } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(item('1'));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    queue.reset();
    first.fail(offline());
    await run;
    await queue.add(item('2'), false);
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(queue.stuck).toEqual([]);
  });

  it('`reset()` forgets `lost` and `stuck`', async () => {
    const { queue, seed, replay } = setup();
    replay.mockResolvedValueOnce(['e1']);
    await seed(item('1'));
    await queue.replay();
    await queue.add(item('2'), true);
    expect(queue.lost).not.toBeNull();
    expect(queue.stuck).toHaveLength(1);
    queue.reset();
    expect(queue.lost).toBeNull();
    // A new entry of the same account shows: the failure is forgotten.
    replay.mockReturnValueOnce(new Promise(() => {}));
    await queue.add(item('3'), false);
    expect(queue.stuck).toEqual([]);
  });
});

describe('Counter: one change per message', () => {
  it('counts emails, not entries', async () => {
    const { queue } = setup();
    await queue.add(item('1', 'k1', ['a', 'b', 'c']), true);
    expect(queue.count).toBe(3);
    await queue.add(change('2', 'a', STAR_ON), true);
    expect(queue.count).toBe(3);
    expect(queue.items).toHaveLength(2);
    expect(queue.stuck).toEqual([{ account: 'k1', count: 3 }]);
  });

  it('counts the same id in two accounts twice', async () => {
    const { queue } = setup();
    await queue.add(item('1', 'k1', ['a']), true);
    await queue.add(item('2', 'k2', ['a']), true);
    expect(queue.count).toBe(2);
    expect(queue.stuck).toEqual([
      { account: 'k1', count: 1 },
      { account: 'k2', count: 1 },
    ]);
  });

  it('also counts quiet entries', async () => {
    const { queue } = setup();
    await queue.add(item('1', 'k1', ['a'], { quiet: true }), true);
    expect(queue.count).toBe(1);
  });

  it('cancels there and back: counter 0, no `stuck`, no call, and the entries are gone', async () => {
    const { queue, replay, transferred, finished, rows } = setup();
    await queue.add(change('1', 'e1', STAR_ON), true);
    await queue.add(change('2', 'e1', STAR_OFF), true);
    expect(queue.count).toBe(0);
    expect(queue.items).toHaveLength(2);
    expect(queue.stuck).toEqual([]);

    await queue.replay();
    expect(replay).not.toHaveBeenCalled();
    expect(transferred).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith('1', []);
    expect(finished).toHaveBeenCalledWith('2', []);
    expect(queue.items).toEqual([]);
    expect(rows.size).toBe(0);
    expect(queue.lost).toBeNull();
    expect(queue.holds('k1')).toBe(false);
  });

  it('cancels trash and back', async () => {
    const { queue, seed, replay } = setup();
    await seed(change('1', 'e1', TO_TRASH), change('2', 'e1', FROM_TRASH));
    expect(queue.count).toBe(0);
    await queue.replay();
    expect(replay).not.toHaveBeenCalled();
    expect(queue.items).toEqual([]);
  });

  it('does not name an account without access if nothing remains', async () => {
    const { queue, seed, noAccess } = setup();
    noAccess.add('k1');
    await seed(change('1', 'e1', STAR_ON), change('2', 'e1', STAR_OFF));
    expect(queue.stuck).toEqual([]);
  });

  it('sends on, off, on as one change', async () => {
    const { queue, seed, replay, transferred } = setup();
    await seed(change('1', 'e1', STAR_ON), change('2', 'e1', STAR_OFF), change('3', 'e1', STAR_ON));
    expect(queue.count).toBe(1);
    await queue.replay();
    expect(replay).toHaveBeenCalledExactlyOnceWith('k1', new Map([['e1', STAR_ON]]));
    expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('sends inbox → trash → archive as one move', async () => {
    const { queue, seed, replay } = setup();
    await seed(change('1', 'e1', TO_TRASH), change('2', 'e1', TO_ARCHIVE));
    await queue.replay();
    expect(replay).toHaveBeenCalledExactlyOnceWith(
      'k1',
      new Map([['e1', { mailboxIds: { in: false, archive: true } }]]),
    );
  });

  it('sends only what remains', async () => {
    const { queue, seed, replay, transferred } = setup();
    await seed(change('1', 'e1', STAR_ON), change('2', 'e2', SEEN), change('3', 'e1', STAR_OFF));
    expect(queue.count).toBe(1);
    await queue.replay();
    expect(replayed(replay)).toEqual([['k1', 'e2']]);
    expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    expect(queue.items).toEqual([]);
  });

  it('hits all entries of the email on a conflict and counts it once', async () => {
    const { queue, seed, replay, finished } = setup();
    replay.mockResolvedValue(['e1']);
    await seed(change('1', 'e1', TO_TRASH), change('2', 'e1', TO_ARCHIVE));
    await queue.replay();
    expect(finished).toHaveBeenCalledWith('1', ['e1']);
    expect(finished).toHaveBeenCalledWith('2', ['e1']);
    expect(queue.lost).toEqual({ count: 1, subject: 'Subject e1' });
  });

  it('no longer cancels what is already in flight: the way back goes out in the next round', async () => {
    const { queue, seed, replay, transferred } = setup();
    const first = gate();
    replay.mockReturnValueOnce(first.promise);
    await seed(change('1', 'e1', STAR_ON));
    const run = queue.replay();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await queue.add(change('2', 'e1', STAR_OFF), false);
    first.open([]);
    await run;
    expect(replay).toHaveBeenLastCalledWith('k1', new Map([['e1', STAR_OFF]]));
    expect(transferred).toHaveBeenCalledExactlyOnceWith(2);
    expect(queue.items).toEqual([]);
  });
});

describe('Drafts', () => {
  describe('Counter', () => {
    it('counts one change per draft, also next to actions', async () => {
      const { queue } = setup();
      await queue.add(item('1', 'k1', ['a', 'b']), true);
      await queue.addDraft(draft('2'), true);
      await queue.addDraft(draft('3'), true);
      expect(queue.count).toBe(4);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 4 }]);
    });

    it('does not count a newer version of the same draft again', async () => {
      const { queue, draftRows } = setup();
      await queue.addDraft(draft('1', 'k1', {}, 'first'), true);
      await queue.addDraft(draft('1', 'k1', {}, 'second'), true);
      expect(queue.count).toBe(1);
      expect(queue.drafts.map((d) => d.email.text)).toEqual(['second']);
      expect(draftRows.get('1')?.email.text).toBe('second');
    });

    it('names an account in which only a draft waits, and counts per account', async () => {
      const { queue } = setup();
      await queue.addDraft(draft('1', 'k2'), true);
      await queue.add(item('2', 'k1'), true);
      expect(queue.stuck).toEqual(
        expect.arrayContaining([
          { account: 'k1', count: 1 },
          { account: 'k2', count: 1 },
        ]),
      );
      expect(queue.count).toBe(2);
    });

    it('does not stop actions: a draft alone is no reason to queue up', async () => {
      const { queue } = setup();
      await queue.addDraft(draft('1'), true);
      expect(queue.holds('k1')).toBe(false);
    });

    it('includes drafts in the sync pill and `transferred`', async () => {
      vi.useFakeTimers();
      const { queue, seed, seedDrafts, transferred } = setup();
      await seed(item('1', 'k1', ['a', 'b']));
      await seedDrafts(draft('2'));
      await queue.replay();
      expect(queue.replaying).toBe(3);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(3);
      await vi.advanceTimersByTimeAsync(1500);
      vi.useRealTimers();
    });
  });

  describe('Intake', () => {
    it('sorts by key and writes immediately', async () => {
      const { queue, draftRows } = setup();
      await queue.addDraft(draft('2'), true);
      await queue.addDraft(draft('1'), true);
      expect(draftKeys(queue)).toEqual(['1', '2']);
      expect([...draftRows.keys()].toSorted()).toEqual(['1', '2']);
    });

    it('with `failed` names the account without starting a replay', async () => {
      const { queue, replayer } = setup();
      await queue.addDraft(draft('1'), true);
      await nextTask();
      expect(replayer.replay).not.toHaveBeenCalled();
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    });

    it('without `failed` starts the replay', async () => {
      const { queue, replayer } = setup();
      await queue.addDraft(draft('1'), false);
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
    });

    it('starts nothing and names no account when the page closes', async () => {
      const { queue, replayer, draftRows } = setup();
      await queue.addDraft(draft('1'), false, true);
      await nextTask();
      expect(replayer.replay).not.toHaveBeenCalled();
      expect(queue.stuck).toEqual([]);
      expect(draftRows.size).toBe(1);
    });
  });

  describe('Replay', () => {
    it('replays and reports the new id', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred, finished } = setup();
      const entry = draft('1');
      await seedDrafts(entry);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledExactlyOnceWith(entry);
      expect(replayer.replayed).toHaveBeenCalledExactlyOnceWith(entry, 'new-1', false);
      expect(queue.drafts).toEqual([]);
      expect(draftRows.size).toBe(0);
      expect(queue.conflict).toBeNull();
      expect(queue.lost).toBeNull();
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
      expect(finished).not.toHaveBeenCalled();
    });

    it('removes the version only after the response', async () => {
      const { queue, seedDrafts, replayer, draftRows } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await nextTask();
      expect(queue.count).toBe(1);
      expect(draftRows.size).toBe(1);
      answer.open({ id: 'x', conflict: false });
      await run;
      expect(queue.count).toBe(0);
      expect(draftRows.size).toBe(0);
    });

    it('replays per account first the actions, then the drafts, one after another', async () => {
      const seen: string[] = [];
      const { queue, seed, seedDrafts, replayer } = setup({
        replay: (account) => {
          seen.push(`Action ${account}`);
          return Promise.resolve([]);
        },
      });
      replayer.replay.mockImplementation((d) => {
        seen.push(`Draft ${d.account} ${d.key}`);
        return Promise.resolve({ id: `new-${d.key}`, conflict: false });
      });
      await seedDrafts(draft('1', 'k1'), draft('2', 'k1'), draft('3', 'k2'));
      await seed(item('8', 'k1'), item('9', 'k2'));
      await queue.replay();
      const of = (account: string) => seen.filter((x) => x.includes(account));
      expect(of('k1')).toEqual(['Action k1', 'Draft k1 1', 'Draft k1 2']);
      expect(of('k2')).toEqual(['Action k2', 'Draft k2 3']);
    });

    it("lets the drafts wait while the account's actions stay without a response", async () => {
      const { queue, seed, seedDrafts, replay, replayer } = setup();
      replay.mockRejectedValue(offline());
      await seed(item('1'));
      await seedDrafts(draft('2'));
      await queue.replay();
      expect(replayer.replay).not.toHaveBeenCalled();
      expect(queue.stuck).toEqual([{ account: 'k1', count: 2 }]);
    });

    it('lets the drafts through if the server rejects an action', async () => {
      const { queue, seed, seedDrafts, replay, replayer } = setup();
      replay.mockRejectedValue(new MethodError('Email/set', 'c0', { type: 'invalidArguments' }));
      await seed(item('1'));
      await seedDrafts(draft('2'));
      await queue.replay();
      expect(queue.lost).toMatchObject({ count: 1 });
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(queue.count).toBe(0);
    });

    it('goes to the next draft after a rejection, the version stays, and the account is in `stuck`', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred } = setup();
      replayer.replay.mockImplementation((d) =>
        d.key === '1'
          ? Promise.reject(new Error('Email/set: overQuota'))
          : Promise.resolve({ id: `new-${d.key}`, conflict: false }),
      );
      await seedDrafts(draft('1'), draft('2'));
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(draftKeys(queue)).toEqual(['1']);
      expect(draftRows.size).toBe(1);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
      expect(transferred).toHaveBeenCalledWith(1);
    });

    it('counts a message with a version and an action as one change', async () => {
      const { queue, seedDrafts, seed } = setup();
      await seed(change('1', 'm1', STAR_ON));
      await seedDrafts(draft('2', 'k1', { replace: { account: 'k1', id: 'm1' } }));
      expect(queue.count).toBe(1);
    });

    it('pauses on a missing response: the version stays, the account is in `stuck`', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred } = setup();
      replayer.replay.mockRejectedValue(offline());
      await seedDrafts(draft('1'), draft('2'));
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(replayer.replayed).not.toHaveBeenCalled();
      expect(draftKeys(queue)).toEqual(['1', '2']);
      expect(draftRows.size).toBe(2);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 2 }]);
      expect(queue.lost).toBeNull();
      expect(queue.conflict).toBeNull();
      expect(transferred).not.toHaveBeenCalled();
    });

    it('does not let an account without a response hold up the other one', async () => {
      const { queue, seedDrafts, replayer, transferred } = setup();
      replayer.replay.mockImplementation((d) =>
        d.account === 'k1' ? Promise.reject(offline()) : Promise.resolve({ id: 'x', conflict: false }),
      );
      await seedDrafts(draft('1', 'k1'), draft('2', 'k2'));
      await queue.replay();
      expect(draftKeys(queue)).toEqual(['1']);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('tries again on the next trigger and clears `stuck` on success', async () => {
      const { queue, seedDrafts, replayer } = setup();
      replayer.replay.mockRejectedValueOnce(offline());
      await seedDrafts(draft('1'));
      await queue.replay();
      expect(queue.stuck).toHaveLength(1);
      await queue.replay(true);
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(queue.stuck).toEqual([]);
      expect(queue.count).toBe(0);
    });

    it('lets an account without access wait and names it in `stuck`', async () => {
      const { queue, seedDrafts, replayer, noAccess } = setup();
      noAccess.add('k1');
      await seedDrafts(draft('1', 'k1'), draft('2', 'k2'));
      await queue.replay();
      expect(replayer.replay.mock.calls.map(([d]) => d.key)).toEqual(['2']);
      expect(draftKeys(queue)).toEqual(['1']);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    });

    it('leaves drafts as long as nobody has attached the replay', async () => {
      const memory = memoryLog();
      const queue = new EditQueue({
        log: () => memory.log,
        replay: () => Promise.resolve([]),
        offline: () => false,
        lacksAccess: () => false,
        exclusive: (task) => task(),
        restored: () => {},
        finished: () => {},
        transferred: () => {},
      });
      await queue.addDraft(draft('1'), true);
      await queue.replay();
      expect(draftKeys(queue)).toEqual(['1']);
      expect(memory.draftRows.size).toBe(1);
    });

    it('starts with the database contents without own entries', async () => {
      const { queue, draftRows, replayer } = setup();
      draftRows.set('1', draft('1'));
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(draftRows.size).toBe(0);
    });
  });

  describe('Pause after a failure', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** One attempt failed; every further one would succeed. */
    async function failed(error: unknown = offline()) {
      const f = setup();
      f.replayer.replay.mockRejectedValueOnce(error);
      await f.seedDrafts(draft('1'));
      await f.queue.replay();
      expect(f.replayer.replay).toHaveBeenCalledOnce();
      return f;
    }

    it.each([
      ['a missing response', offline()],
      ['a rejection', new Error('Email/set: overQuota')],
    ])('waits 10 s with the drafts of the account after %s', async (_name, error) => {
      const { queue, replayer } = await failed(error);
      expect(DRAFT_PAUSE_MS).toBe(10_000);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);

      await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(queue.count).toBe(0);
      expect(queue.stuck).toEqual([]);
    });

    it('also lets new versions wait during the pause', async () => {
      const { queue, replayer, draftRows } = await failed();
      await queue.addDraft(draft('1', 'k1', {}, 'newer'), false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(draftRows.get('1')?.email.text).toBe('newer');
    });

    it('`replay(true)` lifts the pause', async () => {
      const { queue, replayer } = await failed();
      await queue.replay(true);
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(queue.count).toBe(0);
    });

    it('`resume()` lifts the pause', async () => {
      const { queue, replayer } = await failed();
      queue.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(queue.count).toBe(0);
    });

    it('starts anew after every failure', async () => {
      const { queue, replayer } = await failed();
      replayer.replay.mockRejectedValueOnce(offline());
      await queue.replay(true);
      expect(replayer.replay).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledTimes(2);
    });

    it('after a success a new version goes out right away', async () => {
      const { queue, replayer } = await failed();
      await queue.replay(true);
      await queue.addDraft(draft('2'), false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayer.replay).toHaveBeenCalledTimes(3);
      expect(queue.count).toBe(0);
    });

    it('`reset()` forgets the pause', async () => {
      const { queue, replayer, draftRows } = await failed();
      queue.reset();
      // The database ends with the session.
      draftRows.clear();
      await queue.addDraft(draft('2'), false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayer.replay.mock.calls.map(([d]) => d.key)).toEqual(['1', '2']);
    });

    it('applies per account: another one keeps going', async () => {
      const { queue, replayer } = await failed();
      await queue.addDraft(draft('2', 'k2'), false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayer.replay.mock.calls.map(([d]) => d.key)).toEqual(['1', '2']);
      expect(draftKeys(queue)).toEqual(['1']);
    });

    it('still lets the actions of the account run', async () => {
      const { queue, replay, replayer } = await failed();
      await queue.add(item('2'), false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayed(replay)).toEqual([['k1', 'e2']]);
      expect(keysOf(queue)).toEqual([]);
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(draftKeys(queue)).toEqual(['1']);
    });

    it('does not pause after a failed action: patches are idempotent', async () => {
      const { queue, seed, seedDrafts, replay, replayer } = setup();
      replay.mockRejectedValueOnce(offline());
      await seed(item('1'));
      await seedDrafts(draft('2'));
      await queue.replay();
      expect(replayer.replay).not.toHaveBeenCalled();
      await queue.replay();
      expect(replay).toHaveBeenCalledTimes(2);
      expect(replayer.replay).toHaveBeenCalledOnce();
    });
  });

  describe('Conflict', () => {
    const conflicting = (replayer: ReturnType<typeof setup>['replayer']) =>
      replayer.replay.mockImplementation((d) => Promise.resolve({ id: `new-${d.key}`, conflict: true }));

    it('fills `conflict` for a draft with subject and new draft', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred } = setup();
      conflicting(replayer);
      const entry = draft('1', 'k1', { replace: { account: 'k1', id: 'old' } });
      await seedDrafts(entry);
      await queue.replay();
      expect(queue.conflict).toEqual({
        count: 1,
        subject: 'Subject 1',
        account: 'k1',
        id: 'new-1',
        accounts: ['k1'],
      });
      // The version has arrived: it no longer waits.
      expect(replayer.replayed).toHaveBeenCalledExactlyOnceWith(entry, 'new-1', false);
      expect(queue.drafts).toEqual([]);
      expect(draftRows.size).toBe(0);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('counts several drafts and keeps the first', async () => {
      const { queue, seedDrafts, replayer } = setup();
      conflicting(replayer);
      await seedDrafts(draft('1'), draft('2'));
      await queue.replay();
      expect(queue.conflict).toEqual({
        count: 2,
        subject: 'Subject 1',
        account: 'k1',
        id: 'new-1',
        accounts: ['k1'],
      });
    });

    it('names every account once', async () => {
      const { queue, seedDrafts, replayer } = setup();
      conflicting(replayer);
      await seedDrafts(draft('1', 'k1'), draft('2', 'k1'), draft('3', 'k2'));
      await queue.replay();
      expect(queue.conflict?.count).toBe(3);
      expect(queue.conflict?.accounts.toSorted()).toEqual(['k1', 'k2']);
    });

    it('keeps counting over several runs', async () => {
      const { queue, seedDrafts, replayer } = setup();
      conflicting(replayer);
      await seedDrafts(draft('1'));
      await queue.replay();
      await seedDrafts(draft('2', 'k2'));
      await queue.replay();
      expect(queue.conflict).toMatchObject({ count: 2, subject: 'Subject 1', id: 'new-1', accounts: ['k1', 'k2'] });
    });

    it('counts only the drafts with a conflict', async () => {
      const { queue, seedDrafts, replayer } = setup();
      replayer.replay.mockImplementation((d) => Promise.resolve({ id: `new-${d.key}`, conflict: d.key === '2' }));
      await seedDrafts(draft('1'), draft('2'));
      await queue.replay();
      expect(queue.conflict).toMatchObject({ count: 1, subject: 'Subject 2', id: 'new-2' });
    });
  });

  describe('During the replay', () => {
    it('replaces the draft just created with a newer version', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      const first = draft('1', 'k1', { replace: { account: 'k1', id: 'old' } }, 'first');
      await seedDrafts(first);
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      const second = draft('1', 'k1', { replace: { account: 'k1', id: 'old' } }, 'second');
      await queue.addDraft(second, false, true);
      answer.open({ id: 'middle', conflict: false });
      await run;

      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(replayer.replay.mock.calls[1]?.[0]).toEqual({ ...second, replace: { account: 'k1', id: 'middle' } });
      expect(replayer.replayed.mock.calls.map(([d, id, newer]) => [d.email.text, id, newer])).toEqual([
        ['first', 'middle', true],
        ['second', 'new-1', false],
      ]);
      expect(queue.drafts).toEqual([]);
      expect(draftRows.size).toBe(0);
      // Both versions are one draft: one change.
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('puts the new state into the database too, in case the page goes away first', async () => {
      const { queue, seedDrafts, replayer, draftRows } = setup();
      const answer = gate<ReplayedDraft>();
      const stop = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise).mockReturnValueOnce(stop.promise);
      await seedDrafts(draft('1', 'k1', {}, 'first'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await queue.addDraft(draft('1', 'k1', {}, 'second'), false, true);
      answer.open({ id: 'middle', conflict: false });
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledTimes(2));
      expect(draftRows.get('1')).toMatchObject({ replace: { account: 'k1', id: 'middle' }, moved: null });
      stop.open({ id: 'x', conflict: false });
      await run;
    });

    it('takes the finished deletion away from a move in the newer version', async () => {
      const { queue, seedDrafts, replayer } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      const old = { account: 'k2', id: 'there' };
      await seedDrafts(draft('1', 'k1', { moved: old }, 'first'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await queue.addDraft(draft('1', 'k1', { moved: old }, 'second'), false, true);
      answer.open({ id: 'middle', conflict: false });
      await run;
      expect(replayer.replay.mock.calls[1]?.[0]).toMatchObject({
        moved: null,
        replace: { account: 'k1', id: 'middle' },
      });
    });

    it('sets `moved` on an account switch and replays the version in the new account right away', async () => {
      const { queue, seedDrafts, replayer, draftRows, transferred } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1', 'k1', { replace: { account: 'k1', id: 'old' } }, 'first'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      // `closing`: nothing else triggers the pass for k2.
      await queue.addDraft(draft('1', 'k2', {}, 'second'), false, true);
      answer.open({ id: 'middle', conflict: false });
      await run;

      expect(replayer.replay).toHaveBeenCalledTimes(2);
      expect(replayer.replay.mock.calls[1]?.[0]).toMatchObject({
        account: 'k2',
        replace: null,
        moved: { account: 'k1', id: 'middle' },
        email: { text: 'second' },
      });
      expect(replayer.replayed.mock.calls.map(([d, id, newer]) => [d.account, id, newer])).toEqual([
        ['k1', 'middle', true],
        ['k2', 'new-1', false],
      ]);
      expect(queue.drafts).toEqual([]);
      expect(draftRows.size).toBe(0);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('records the move in the database, in case the page goes away first', async () => {
      const { queue, seedDrafts, replayer, draftRows } = setup();
      const answer = gate<ReplayedDraft>();
      const stop = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise).mockReturnValueOnce(stop.promise);
      await seedDrafts(draft('1', 'k1', {}, 'first'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await queue.addDraft(draft('1', 'k2', {}, 'second'), false, true);
      answer.open({ id: 'middle', conflict: false });
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledTimes(2));
      expect(draftRows.get('1')).toMatchObject({
        account: 'k2',
        replace: null,
        moved: { account: 'k1', id: 'middle' },
      });
      stop.open({ id: 'x', conflict: false });
      await run;
    });

    it('reports a conflict once, even if a newer version follows', async () => {
      const { queue, seedDrafts, replayer } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1', 'k1', {}, 'first'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await queue.addDraft(draft('1', 'k1', {}, 'second'), false, true);
      answer.open({ id: 'middle', conflict: true });
      await run;
      expect(queue.conflict).toMatchObject({ count: 1, id: 'middle' });
    });

    it('removes a draft discarded during the replay again', async () => {
      const { queue, seedDrafts, replayer, transferred } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1'), draft('2'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      await queue.dropDraft('1');
      answer.open({ id: 'gone', conflict: true });
      await run;
      expect(replayer.revoke).toHaveBeenCalledExactlyOnceWith('k1', 'gone');
      // No notice about a draft that no longer exists; the next one goes out anyway.
      expect(queue.conflict).toBeNull();
      expect(replayer.replayed.mock.calls.map(([d]) => d.key)).toEqual(['2']);
      expect(queue.drafts).toEqual([]);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('`dropDraft`', () => {
    it('takes the version out of memory and database', async () => {
      const { queue, seedDrafts, draftRows } = setup();
      await seedDrafts(draft('1'), draft('2'));
      await queue.dropDraft('1');
      expect(draftKeys(queue)).toEqual(['2']);
      expect([...draftRows.keys()]).toEqual(['2']);
    });

    it('leaves unknown ones alone', async () => {
      const { queue, seedDrafts, draftRows } = setup();
      await seedDrafts(draft('1'));
      await queue.dropDraft('missing');
      expect(draftKeys(queue)).toEqual(['1']);
      expect(draftRows.size).toBe(1);
    });

    it('does not bring the version back from an older read either', async () => {
      const { queue, seedDrafts, state } = setup();
      await seedDrafts(draft('1'));
      const stale = gate<QueuedDraft[] | null>();
      state.readDrafts = stale.promise;
      const reading = queue.restore();
      state.readDrafts = null;
      await queue.dropDraft('1');
      stale.open([draft('1')]);
      await reading;
      expect(queue.drafts).toEqual([]);
    });
  });

  describe('`restore()`', () => {
    it('fetches drafts from the database, once and without `restored`', async () => {
      const { queue, draftRows, restored } = setup();
      draftRows.set('2', draft('2'));
      draftRows.set('1', draft('1'));
      await queue.restore();
      await queue.restore();
      expect(draftKeys(queue)).toEqual(['1', '2']);
      expect(restored).not.toHaveBeenCalled();
    });

    it('does not bring back finished ones, even if `drafts()` read before the deletion', async () => {
      const { queue, seedDrafts, state, replayer } = setup();
      await seedDrafts(draft('1'));
      const stale = gate<QueuedDraft[] | null>();
      state.readDrafts = stale.promise;
      const reading = queue.restore();
      state.readDrafts = null;
      await queue.replay();
      expect(queue.drafts).toEqual([]);

      stale.open([draft('1')]);
      await reading;
      expect(queue.drafts).toEqual([]);
      await queue.replay();
      expect(replayer.replay).toHaveBeenCalledOnce();
    });

    it('forgets what another tab has finished', async () => {
      const { queue, seedDrafts, draftRows } = setup();
      await seedDrafts(draft('1'), draft('2'));
      draftRows.delete('1');
      await queue.restore();
      expect(draftKeys(queue)).toEqual(['2']);
    });

    it('prefers a newer version of this tab over the one read', async () => {
      const { queue, draftRows } = setup();
      await queue.addDraft(draft('1', 'k1', {}, 'new'), true);
      draftRows.set('1', draft('1', 'k1', {}, 'old'));
      await queue.restore();
      expect(queue.drafts.map((d) => d.email.text)).toEqual(['new']);
    });

    it('keeps versions whose writing failed', async () => {
      const { queue, state } = setup();
      state.refuse = true;
      await queue.addDraft(draft('1'), true);
      await queue.restore();
      expect(draftKeys(queue)).toEqual(['1']);
    });

    it('leaves everything as it is if the database does not answer', async () => {
      const { queue, seedDrafts, state } = setup();
      await seedDrafts(draft('1'));
      state.readDrafts = Promise.resolve(null);
      await queue.restore();
      expect(draftKeys(queue)).toEqual(['1']);
    });

    it("works from the tab's memory without a database", async () => {
      const { queue, replayer, transferred } = setup({ log: () => null });
      await queue.addDraft(draft('1'), true);
      expect(queue.count).toBe(1);
      await queue.replay();
      expect(replayer.replayed).toHaveBeenCalledOnce();
      expect(queue.count).toBe(0);
      expect(transferred).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('`findDraft`', () => {
    it('finds the version via the replaced state in the same account', async () => {
      const { queue } = setup();
      const entry = draft('1', 'k1', { replace: { account: 'k1', id: 'd1' } });
      await queue.addDraft(entry, true);
      expect(queue.findDraft('k1', 'd1')).toBe(entry);
      expect(queue.findDraft('k2', 'd1')).toBeUndefined();
      expect(queue.findDraft('k1', 'd2')).toBeUndefined();
    });

    it('finds the version via the draft in the previous account', async () => {
      const { queue } = setup();
      const entry = draft('1', 'k2', { moved: { account: 'k1', id: 'd1' } });
      await queue.addDraft(entry, true);
      expect(queue.findDraft('k1', 'd1')).toBe(entry);
      expect(queue.findDraft('k2', 'd1')).toBeUndefined();
    });

    it('finds a draft that exists only in the queue via `~<key>`', async () => {
      const { queue } = setup();
      const entry = draft('1');
      await queue.addDraft(entry, true);
      expect(LOCAL_DRAFT).toBe('~');
      expect(queue.findDraft('k1', '~1')).toBe(entry);
      expect(queue.findDraft('k2', '~1')).toBeUndefined();
      expect(queue.findDraft('k1', '~2')).toBeUndefined();
      expect(queue.findDraft('k1', '1')).toBeUndefined();
    });
  });

  describe('`retain`', () => {
    it('discards the drafts of foreign accounts including the database, without a notice', async () => {
      const { queue, seedDrafts, draftRows, finished } = setup();
      await seedDrafts(draft('1', 'k1'), draft('2', 'k2'));
      queue.retain(['k1']);
      expect(draftKeys(queue)).toEqual(['1']);
      await vi.waitFor(() => expect([...draftRows.keys()]).toEqual(['1']));
      expect(queue.lost).toBeNull();
      expect(finished).not.toHaveBeenCalled();
    });

    it('does not bring discarded drafts back from an older read either', async () => {
      const { queue, seedDrafts, state } = setup();
      await seedDrafts(draft('1', 'k1'), draft('2', 'k2'));
      const stale = gate<QueuedDraft[] | null>();
      state.readDrafts = stale.promise;
      const reading = queue.restore();
      state.readDrafts = null;
      queue.retain(['k1']);
      stale.open([draft('1', 'k1'), draft('2', 'k2')]);
      await reading;
      expect(draftKeys(queue)).toEqual(['1']);
      expect(queue.count).toBe(1);
    });

    it('leaves the list alone if there is nothing to discard', async () => {
      const { queue, seedDrafts } = setup();
      await seedDrafts(draft('1', 'k1'));
      const before = queue.drafts;
      queue.retain(['k1']);
      expect(queue.drafts).toBe(before);
    });
  });

  describe('`reset()`', () => {
    it('forgets versions, `conflict` and `stuck`; the database ends with the session', async () => {
      const { queue, seedDrafts, replayer } = setup();
      replayer.replay.mockResolvedValueOnce({ id: 'x', conflict: true });
      await seedDrafts(draft('1'));
      await queue.replay();
      await queue.addDraft(draft('2'), true);
      expect(queue.conflict).not.toBeNull();
      expect(queue.stuck).toHaveLength(1);
      queue.reset();
      expect(queue.drafts).toEqual([]);
      expect(queue.conflict).toBeNull();
      expect(queue.stuck).toEqual([]);
      expect(queue.count).toBe(0);
    });

    it('ends a run without reporting to the replay', async () => {
      const { queue, seedDrafts, replayer, transferred, draftRows } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1'), draft('2'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      queue.reset();
      answer.open({ id: 'x', conflict: true });
      await run;
      expect(replayer.replay).toHaveBeenCalledOnce();
      expect(replayer.replayed).not.toHaveBeenCalled();
      expect(replayer.revoke).not.toHaveBeenCalled();
      expect(queue.conflict).toBeNull();
      expect(transferred).not.toHaveBeenCalled();
      expect(draftRows.size).toBe(2);
    });

    it('also skips the failure of the running draft', async () => {
      const { queue, seedDrafts, replayer } = setup();
      const answer = gate<ReplayedDraft>();
      replayer.replay.mockReturnValueOnce(answer.promise);
      await seedDrafts(draft('1'));
      const run = queue.replay();
      await vi.waitFor(() => expect(replayer.replay).toHaveBeenCalledOnce());
      queue.reset();
      answer.fail(offline());
      await run;
      await queue.addDraft(draft('2'), false, true);
      expect(queue.stuck).toEqual([]);
    });
  });
});

describe('Sync pill', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays at least 1500 ms and names the changes at the start', async () => {
    const { queue, seed } = setup();
    await seed(item('1', 'k1', ['a', 'b']), item('2'));
    await queue.replay();
    expect(queue.count).toBe(0);
    expect(queue.replaying).toBe(3);
    await vi.advanceTimersByTimeAsync(1499);
    expect(queue.replaying).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.replaying).toBe(0);
  });

  it('shows only the explicit attempt after a failure', async () => {
    const { queue, seed, replay } = setup();
    await seed(item('1'));
    replay.mockRejectedValue(new JmapError('unreachable'));
    await queue.replay();
    await vi.advanceTimersByTimeAsync(1500);
    expect(queue.replaying).toBe(0);
    await queue.replay();
    expect(queue.replaying).toBe(0);
    await queue.replay(true);
    expect(queue.replaying).toBe(1);
  });

  it('goes off right away after a long run', async () => {
    const { queue, seed, replay } = setup();
    const slow = gate();
    replay.mockReturnValueOnce(slow.promise);
    await seed(item('1'));
    const run = queue.replay();
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.replaying).toBe(1);
    slow.open([]);
    await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.replaying).toBe(0);
  });

  it('stays on for a second run and counts from the first', async () => {
    const { queue, seed, transferred } = setup();
    await seed(item('1'));
    await queue.replay();
    await vi.advanceTimersByTimeAsync(1000);
    await queue.add(item('2'), false);
    await vi.advanceTimersByTimeAsync(0);
    expect(transferred).toHaveBeenCalledTimes(2);
    expect(queue.replaying).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(queue.replaying).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.replaying).toBe(0);
  });

  it('shows nothing if only accounts without access wait', async () => {
    const { queue, seed, noAccess } = setup();
    noAccess.add('k1');
    await seed(item('1'));
    await queue.replay();
    expect(queue.replaying).toBe(0);
  });

  it('stays off if the browser reports offline, and tries anyway', async () => {
    const { queue, seed, replay, browser } = setup();
    browser.offline = true;
    await seed(item('1'));
    await queue.replay();
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.replaying).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays off after a failure and goes on again after `resume()`', async () => {
    const { queue, seed, replay } = setup();
    replay.mockRejectedValue(offline());
    await seed(item('1'));
    await queue.replay();
    expect(queue.replaying).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(queue.replaying).toBe(0);

    await queue.replay();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(queue.replaying).toBe(0);

    queue.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(replay).toHaveBeenCalledTimes(3);
    expect(queue.replaying).toBe(1);
  });

  it('stays off if the entry itself already got no response', async () => {
    const { queue, replay } = setup();
    await queue.add(item('1'), true);
    await queue.replay();
    expect(replay).toHaveBeenCalledOnce();
    expect(queue.replaying).toBe(0);
  });

  it('stays on if another account runs next to a failed one', async () => {
    const { queue, seed } = setup();
    await queue.add(item('1', 'k1'), true);
    await seed(item('2', 'k2'));
    await queue.replay();
    expect(queue.replaying).toBe(2);
  });

  it('ends with `reset()` including the timer', async () => {
    const { queue, seed } = setup();
    await seed(item('1'));
    await queue.replay();
    expect(vi.getTimerCount()).toBe(1);
    queue.reset();
    expect(queue.replaying).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Two tabs on one database', () => {
  let logs: EditLogs;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    logs = new EditLogs();
  });

  afterEach(async () => {
    await logs.dropAll();
    vi.unstubAllGlobals();
  });

  const tab = () => setup({ log: () => logs.of('u1') });

  it('transfers nothing twice', async () => {
    const a = tab();
    const b = tab();
    await a.queue.add(item('1'), true);
    await a.queue.add(item('2'), true);
    await b.queue.restore();
    expect(b.queue.count).toBe(2);
    expect(b.restored).toHaveBeenCalledTimes(2);

    await a.queue.replay();
    expect(a.replay).toHaveBeenCalledOnce();
    expect(a.transferred).toHaveBeenCalledExactlyOnceWith(2);

    await b.queue.replay();
    expect(b.replay).not.toHaveBeenCalled();
    expect(b.queue.count).toBe(0);
    expect(b.finished).toHaveBeenCalledWith('1', []);
    expect(b.finished).toHaveBeenCalledWith('2', []);
    expect(b.transferred).not.toHaveBeenCalled();
  });

  it('takes over before the run what another tab has queued', async () => {
    const a = tab();
    const b = tab();
    await a.queue.add(item('1'), true);
    await b.queue.add(item('2', 'k2'), true);
    await a.queue.replay();
    expect(replayed(a.replay)).toEqual([
      ['k1', 'e1'],
      ['k2', 'e2'],
    ]);
    await b.queue.replay();
    expect(b.replay).not.toHaveBeenCalled();
    expect(b.queue.count).toBe(0);
    expect(await logs.of('u1')?.all()).toEqual([]);
  });

  it('survives reloading: a new instance finds the entries again', async () => {
    const a = tab();
    const entry = item('1', 'k1', ['x'], { subjects: { x: 'Invoice' }, quiet: true });
    await a.queue.add(entry, true);
    const reloaded = tab();
    await reloaded.queue.restore();
    expect(reloaded.queue.items).toEqual([entry]);
  });

  it('survives reloading with drafts', async () => {
    const a = tab();
    const entry = draft('1', 'k1', { replace: { account: 'k1', id: 'd1' } });
    await a.queue.addDraft(entry, true);
    const reloaded = tab();
    await reloaded.queue.restore();
    expect(reloaded.queue.drafts).toEqual([entry]);
    expect(reloaded.queue.findDraft('k1', 'd1')).toEqual(entry);
  });

  it('forgets drafts that the other tab has replayed', async () => {
    const a = tab();
    const b = tab();
    await a.queue.addDraft(draft('1'), true);
    await b.queue.restore();
    expect(b.queue.count).toBe(1);
    await a.queue.replay();
    expect(a.replayer.replayed).toHaveBeenCalledOnce();
    await b.queue.restore();
    expect(b.queue.count).toBe(0);
    expect(await logs.of('u1')?.drafts()).toEqual([]);
  });
});
