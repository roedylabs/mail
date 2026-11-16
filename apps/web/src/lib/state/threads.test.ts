import { JmapClient } from '@roedy/jmap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import type { ListEmail, ListOrder, ListThread } from '#lib/mail-list.ts';
import { MAX_LIST_THREADS, type SavedList } from '#lib/mail-store.ts';
import { edits } from '#lib/state/edits.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type { EmailEdit } from '#lib/mail-actions.ts';
import type { QueuedDraft } from '#lib/mail-queue.ts';
import {
  addedRows,
  draftRow,
  editedPart,
  editedThread,
  jmapThreadApi,
  listKey,
  mergeParts,
  PAGE_SIZE,
  savedOf,
  sortOf,
  sourceFilter,
  ThreadList,
  Threads,
  type ChangesResult,
  type Part,
  type ThreadApi,
  type ThreadSource,
  threads,
  withRows,
} from './threads.svelte.ts';

const NEWEST: ListOrder = { by: 'date', ascending: false };
const OLDEST: ListOrder = { by: 'date', ascending: true };

const MAIL = 'https://mail.example.com';
const CORE = 'urn:ietf:params:jmap:core';
const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const SESSION = {
  capabilities: {
    [CORE]: {
      maxSizeUpload: 1000,
      maxConcurrentUpload: 2,
      maxSizeRequest: 100_000,
      maxConcurrentRequests: 4,
      maxCallsInRequest: 16,
      maxObjectsInGet: 100,
      maxObjectsInSet: 100,
      collationAlgorithms: [],
    },
    [MAIL_CAP]: {},
  },
  accounts: { j1: { name: 'a1@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
  primaryAccounts: { [MAIL_CAP]: 'j1' },
  username: 'a1@example.com',
  apiUrl: `${MAIL}/jmap/`,
  downloadUrl: `${MAIL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${MAIL}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${MAIL}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: 's1',
};

type Invocation = [string, Record<string, unknown>, string];

/** Fake mail server: answers every call of a request via `answer`. */
function server(answer: (call: Invocation) => [string, unknown]) {
  const seen: Invocation[] = [];
  const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    const methodResponses = methodCalls.map((call) => {
      seen.push(call);
      const [name, args] = answer(call);
      return [name, args, call[2]];
    });
    return Promise.resolve(
      new Response(JSON.stringify({ methodResponses, sessionState: 's1' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  const client = new JmapClient({ url: MAIL, tokens: { token: () => Promise.resolve('t1') }, session: SESSION, fetch });
  return { client, seen };
}

const INBOX: ThreadSource = { account: 'k1', boxes: ['in'], exclude: [] };

const rep = (id: string, threadId: string, keywords: Record<string, true> = {}) => ({
  id,
  threadId,
  mailboxIds: { in: true },
  keywords,
  receivedAt: '2026-10-28T10:00:00Z',
  from: [{ name: 'Anna', email: 'anna@example.com' }],
  to: null,
  subject: 'Hello',
  preview: 'Text',
  hasAttachment: false,
});

describe('sourceFilter', () => {
  it('combines mailboxes, exclusion and segment', () => {
    expect(sourceFilter(INBOX, 'all')).toEqual({ inMailbox: 'in' });
    expect(sourceFilter({ account: 'k1', boxes: ['a', 'b'], exclude: ['tr'] }, 'unread')).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [{ inMailbox: 'a' }, { inMailbox: 'b' }] },
        { operator: 'NOT', conditions: [{ inMailbox: 'tr' }] },
        { notKeyword: '$seen' },
      ],
    });
    expect(sourceFilter(INBOX, 'flagged')).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'in' }, { hasKeyword: '$flagged' }],
    });
  });
});

describe('jmapThreadApi', () => {
  it('fetches a page with threads, their emails and the counters in one request', async () => {
    const { client, seen } = server(([name, args]) => {
      if (name === 'Email/query' && args['position'] === 0)
        return [
          name,
          { accountId: 'j1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: ['e1'], total: 12 },
        ];
      if (name === 'Email/query') {
        const total = JSON.stringify(args['filter']).includes('$seen') ? 3 : 1;
        return [name, { accountId: 'j1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: [], total }];
      }
      if (name === 'Email/get' && (args['properties'] as string[]).includes('preview'))
        return [name, { accountId: 'j1', state: 's', list: [rep('e1', 't1', { $seen: true })], notFound: [] }];
      if (name === 'Thread/get')
        return [name, { accountId: 'j1', state: 's', list: [{ id: 't1', emailIds: ['e0', 'e1'] }], notFound: [] }];
      return [
        name,
        {
          accountId: 'j1',
          state: 's',
          list: [
            { id: 'e0', mailboxIds: { in: true, tg: true }, keywords: { $flagged: true } },
            { id: 'e1', mailboxIds: { in: true }, keywords: { $seen: true } },
          ],
          notFound: [],
        },
      ];
    });
    const api = jmapThreadApi(() => Promise.resolve(client));
    const page = await api.page({
      source: INBOX,
      segment: 'all',
      order: NEWEST,
      position: 0,
      limit: 50,
      counts: ['all', 'unread', 'flagged'],
    });
    expect(seen.map(([n]) => n)).toEqual([
      'Email/query',
      'Email/get',
      'Thread/get',
      'Email/get',
      'Email/query',
      'Email/query',
    ]);
    expect(seen[0]![1]).toMatchObject({
      filter: { inMailbox: 'in' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
      limit: 50,
      calculateTotal: true,
    });
    expect(seen[1]![1]['#ids']).toEqual({ resultOf: seen[0]![2], name: 'Email/query', path: '/ids' });
    expect(seen[2]![1]['#ids']).toMatchObject({ path: '/list/*/threadId' });
    expect(seen[3]![1]['#ids']).toMatchObject({ path: '/list/*/emailIds' });
    expect(page).toMatchObject({
      ids: ['e1'],
      total: 12,
      queryState: 'q1',
      counts: { all: 12, unread: 3, flagged: 1 },
    });
    // Unread and flagged via the emails of the conversation in the mailbox; mailboxes of all for the tags.
    expect(page.threads[0]).toMatchObject({
      key: 'k1/e1',
      unread: true,
      flagged: true,
      count: 2,
      mailboxIds: ['in', 'tg'],
    });
  });

  it('takes the representative one without the emails of the thread', async () => {
    const { client } = server(([name]) => {
      if (name === 'Email/query')
        return [
          name,
          { accountId: 'j1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: ['e1'], total: 1 },
        ];
      if (name === 'Thread/get')
        return [name, { accountId: 'j1', state: 's', list: [{ id: 't1', emailIds: ['e0', 'e1'] }], notFound: [] }];
      return name === 'Email/get' && seenGets++ === 0
        ? [name, { accountId: 'j1', state: 's', list: [rep('e1', 't1')], notFound: [] }]
        : ['error', { type: 'requestTooLarge' }];
    });
    let seenGets = 0;
    const page = await jmapThreadApi(() => Promise.resolve(client)).page({
      source: INBOX,
      segment: 'unread',
      order: NEWEST,
      position: 0,
      limit: 50,
      counts: [],
    });
    expect(page.threads[0]).toMatchObject({ unread: true, flagged: false, count: 2 });
    expect(page.counts).toEqual({ unread: 1 });
  });

  it('leaves out conversations without a found email but keeps their position (notFound, Stalwart v1)', async () => {
    const { client } = server(([name]) => {
      if (name === 'Email/query')
        return [
          name,
          { accountId: 'j1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: ['e1', 'e2'], total: 2 },
        ];
      if (name === 'Thread/get')
        return [name, { accountId: 'j1', state: 's', list: [{ id: 't1', emailIds: ['e1'] }], notFound: [] }];
      return [name, { accountId: 'j1', state: 's', list: [rep('e1', 't1')], notFound: ['e2'] }];
    });
    const page = await jmapThreadApi(() => Promise.resolve(client)).page({
      source: INBOX,
      segment: 'all',
      order: NEWEST,
      position: 0,
      limit: 50,
      counts: [],
    });
    expect(page.ids).toEqual(['e1', 'e2']);
    expect(page.threads.map((t) => t.id)).toEqual(['e1']);
  });

  it('loads further pages after an email and without one from `position`', async () => {
    const { client, seen } = server(([name, args]) => {
      if (name === 'Email/query' && args['anchor']) return ['error', { type: 'anchorNotFound' }];
      if (name === 'Email/query')
        return [name, { accountId: 'j1', queryState: 'q1', canCalculateChanges: true, position: 50, ids: [] }];
      if (name === 'Email/get' || name === 'Thread/get')
        return [name, { accountId: 'j1', state: 's', list: [], notFound: [] }];
      return ['error', { type: 'invalidResultReference' }];
    });
    const page = await jmapThreadApi(() => Promise.resolve(client)).page({
      source: INBOX,
      segment: 'all',
      order: NEWEST,
      position: 50,
      anchor: 'e49',
      limit: 50,
      counts: [],
    });
    expect(seen[0]![1]).toMatchObject({ anchor: 'e49', anchorOffset: 1 });
    expect(seen[0]![1]).not.toHaveProperty('position');
    expect(seen[4]![1]).toMatchObject({ position: 50 });
    expect(page).toMatchObject({ ids: [], total: null });
  });

  it('reports `cannotCalculateChanges` as `reset`', async () => {
    const { client, seen } = server(([name]) =>
      name === 'Email/queryChanges'
        ? ['error', { type: 'cannotCalculateChanges' }]
        : ['error', { type: 'invalidResultReference' }],
    );
    const res = await jmapThreadApi(() => Promise.resolve(client)).changes({
      source: INBOX,
      segment: 'all',
      order: NEWEST,
      sinceQueryState: 'q1',
      upToId: 'e9',
      reload: [],
      counts: ['all', 'unread', 'flagged'],
    });
    expect(res).toEqual({ reset: true });
    expect(seen[0]![1]).toMatchObject({ sinceQueryState: 'q1', upToId: 'e9', collapseThreads: true });
    expect(seen[1]![1]['#ids']).toMatchObject({ path: '/added/*/id' });
    expect(seen.filter(([name]) => name === 'Email/get')).toHaveLength(2);
  });

  it('refetches reported conversations in the same request', async () => {
    const { client, seen } = server(([name]) =>
      name === 'Email/queryChanges'
        ? ['error', { type: 'cannotCalculateChanges' }]
        : ['error', { type: 'invalidResultReference' }],
    );
    await jmapThreadApi(() => Promise.resolve(client)).changes({
      source: INBOX,
      segment: 'all',
      order: NEWEST,
      sinceQueryState: 'q1',
      upToId: 'e9',
      reload: ['e3', 'e5'],
      counts: [],
    });
    const gets = seen.filter(([name]) => name === 'Email/get');
    expect(gets.map(([, args]) => args['ids'] ?? null)).toEqual([null, null, ['e3', 'e5'], null]);
    expect(seen.filter(([name]) => name === 'Thread/get')).toHaveLength(2);
  });
});

const T0 = Date.parse('2026-10-28T12:00:00Z');

function item(account: string, id: string, minutesAgo: number): ListThread {
  return {
    key: `${account}/${id}`,
    account,
    id,
    threadId: `t-${id}`,
    receivedAt: T0 - minutesAgo * 60_000,
    from: [],
    to: [],
    subject: id,
    preview: '',
    hasAttachment: false,
    unread: false,
    flagged: false,
    count: 1,
    mailboxIds: [],
    members: [],
    seq: 0,
  };
}

function part(account: string, list: ListThread[], overrides: Partial<Part> = {}): Part {
  return {
    source: { account, boxes: ['in'], exclude: [] },
    ids: list.map((t) => t.id),
    items: new Map(list.map((t) => [t.id, t])),
    total: list.length,
    counts: {},
    countSeq: 0,
    totalSeq: 0,
    queryState: 'q',
    emailState: 'e',
    loaded: true,
    done: true,
    error: null,
    ...overrides,
  };
}

describe('mergeParts', () => {
  it('shows waiting drafts at their place and behind every limit at the end, without setting one itself', () => {
    const draft = item('a', '~0001', 600);
    const a = part('a', [item('a', 'a1', 1), item('a', '~0002', 3), item('a', 'a2', 10), draft]);
    const b = part('b', [item('b', 'b1', 5)], { done: false, total: 9 });
    expect(mergeParts([a, b], NEWEST)).toMatchObject({ next: 1 });
    expect(mergeParts([a, b], NEWEST).threads.map((t) => t.id)).toEqual(['a1', '~0002', 'b1', '~0001']);
    // The limit of an account with further pages stays its last server conversation, not the draft behind it.
    const own = part('a', [item('a', 'a1', 1), draft], { done: false, total: 9 });
    const done = part('b', [item('b', 'b1', 5), item('b', 'b2', 100)]);
    expect(mergeParts([own, done], NEWEST)).toMatchObject({ next: 0 });
    expect(mergeParts([own, done], NEWEST).threads.map((t) => t.id)).toEqual(['a1', '~0001']);
  });

  it('merges accounts by date and ends at the last conversation of an account with further pages', () => {
    const a = part('a', [item('a', 'a1', 1), item('a', 'a2', 10)], { done: false, total: 9 });
    const b = part('b', [item('b', 'b1', 5), item('b', 'b2', 20), item('b', 'b3', 30)]);
    expect(mergeParts([a, b], NEWEST)).toMatchObject({ next: 0 });
    expect(mergeParts([a, b], NEWEST).threads.map((t) => t.id)).toEqual(['a1', 'b1', 'a2']);
    expect(mergeParts([{ ...a, done: true }, b], NEWEST)).toMatchObject({ next: -1 });
    expect(mergeParts([{ ...a, done: true }, b], NEWEST).threads.map((t) => t.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
      'b3',
    ]);
    const up = (p: Part): Part => ({ ...p, ids: [...p.ids].reverse() });
    expect(mergeParts([up({ ...a, done: true }), up(b)], OLDEST).threads.map((t) => t.id)).toEqual([
      'b3',
      'b2',
      'a2',
      'b1',
      'a1',
    ]);
    // An account with an error does not hold up the others.
    expect(mergeParts([{ ...a, error: new Error('x') }, b], NEWEST).threads).toHaveLength(5);
    // An open account whose emails were already gone on loading does not hold up the others and keeps loading.
    const gone = part('a', [], { ids: ['a9'], done: false, total: 5 });
    expect(mergeParts([gone, b], NEWEST)).toMatchObject({ next: 0 });
    expect(mergeParts([gone, b], NEWEST).threads).toHaveLength(3);
  });

  it("sorts by sender, with the same name the newest first, and keeps the server's order per account", () => {
    const from = (t: ListThread, name: string, email = ''): ListThread => ({ ...t, from: [{ name, email }] });
    const a = part('a', [
      from(item('a', 'a1', 5), 'Anna'),
      from(item('a', 'a2', 1), 'Zoe'),
      from(item('a', 'a3', 3), 'Zoe'),
      // The server sorts "Åsa" after "Zoe" (different collation); the browser would put it after "Anna".
      from(item('a', 'a4', 2), '\u00c5sa'),
    ]);
    const b = part('b', [from(item('b', 'b1', 2), '', 'bernd@example.com'), from(item('b', 'b2', 0), 'Zoe')]);
    const byName: ListOrder = { by: 'from', ascending: true };
    const all = ['a1', 'b1', 'b2', 'a2', 'a3', 'a4'];
    expect(mergeParts([a, b], byName).threads.map((t) => t.id)).toEqual(all);
    const ids = ({ threads, next }: ReturnType<typeof mergeParts>) => [threads.map((t) => t.id), next];
    expect(ids(mergeParts([{ ...a, done: false, total: 9 }, b], byName))).toEqual([all, 0]);
    expect(ids(mergeParts([a, { ...b, done: false, total: 9 }], byName))).toEqual([['a1', 'b1', 'b2'], 1]);
  });
});

const member = (id: string, mailboxIds: string[], keywords: Record<string, true> = {}): ListEmail => ({
  id,
  mailboxIds,
  keywords,
  from: '',
});

/** Conversation with emails in the inbox `in` and a sent reply. */
function convo(account: string, id: string, patch: Partial<ListThread> = {}): ListThread {
  return {
    ...item(account, id, 1),
    unread: true,
    flagged: false,
    count: 2,
    mailboxIds: ['in', 'sent'],
    members: [member(id, ['in']), member(`${id}-r`, ['sent'], { $seen: true })],
    seq: 1,
    ...patch,
  };
}

describe('Own changes over the list', () => {
  const source = { account: 'a', boxes: ['in'], exclude: [] };
  afterEach(() => {
    // Do not carry anything pending into other tests (it would otherwise go to the real server).
    ui.toasts.undo();
    ui.reset();
    edits.reset();
  });

  it('does not count again what counters and count already know', () => {
    // Confirmed with stamp 5; the conversation comes from 1, counters and count from 7.
    const edit = (id: string, seq: number, until = Infinity) =>
      id === 'a1' && 5 >= seq && 5 < until ? { keywords: { $seen: true } } : undefined;
    const p = part('a', [convo('a', 'a1')], {
      total: 4,
      counts: { all: 4, unread: 3, flagged: 0 },
      countSeq: 7,
      totalSeq: 7,
    });
    const out = editedPart(p, edit);
    expect(out.items.get('a1')).toMatchObject({ unread: false });
    expect(out.counts).toEqual({ all: 4, unread: 3, flagged: 0 });
    expect(editedPart({ ...p, countSeq: 0 }, edit).counts).toEqual({ all: 4, unread: 2, flagged: 0 });
    const gone = (id: string, seq: number, until = Infinity) =>
      id === 'a1' && 5 >= seq && 5 < until ? { mailboxIds: { in: false, trash: true } } : undefined;
    expect(editedPart(p, gone)).toMatchObject({ ids: [], total: 4, counts: { all: 4, unread: 3 } });
    expect(editedPart({ ...p, totalSeq: 0 }, gone).total).toBe(3);
  });

  it('leaves a conversation without a change as it is', () => {
    const t = convo('a', 'a1');
    expect(editedThread(t, source, () => undefined)).toBe(t);
  });

  it('follows read and flagged and drops a conversation that leaves the view', () => {
    const t = convo('a', 'a1');
    const read = editedThread(t, source, (id) =>
      id === 'a1' ? { keywords: { $seen: true, $flagged: true } } : undefined,
    );
    expect(read).toMatchObject({ unread: false, flagged: true, count: 2 });
    expect(read?.members[0]?.keywords).toEqual({ $seen: true, $flagged: true });
    // The reply in Sent does not count in the inbox.
    expect(
      editedThread(t, source, (id) => (id === 'a1-r' ? { keywords: { $flagged: true } } : undefined)),
    ).toMatchObject({ flagged: false });
    const gone = editedThread(t, source, (id) =>
      id === 'a1' ? { mailboxIds: { in: false, trash: true } } : undefined,
    );
    expect(gone).toBeNull();
    const destroyed = editedThread({ ...t, members: [...t.members, member('a1-b', ['in'])], count: 3 }, source, (id) =>
      id === 'a1' ? { destroyed: true } : undefined,
    );
    expect(destroyed).toMatchObject({ count: 2, mailboxIds: ['sent', 'in'] });
  });

  it('takes left conversations out of list, count and counters and changes the counters of the segments', () => {
    const p = part(
      'a',
      [convo('a', 'a1'), convo('a', 'a2', { flagged: true, members: [member('a2', ['in'], { $flagged: true })] })],
      {
        total: 10,
        counts: { all: 10, unread: 4, flagged: 1 },
      },
    );
    const out = editedPart(p, (id) =>
      id === 'a1'
        ? { mailboxIds: { in: false, trash: true } }
        : id === 'a2'
          ? { keywords: { $seen: true } }
          : undefined,
    );
    expect(out.ids).toEqual(['a2']);
    expect(out.total).toBe(9);
    expect(out.counts).toEqual({ all: 9, unread: 2, flagged: 1 });
    expect(out.items.get('a2')).toMatchObject({ unread: false, flagged: true });
    expect(editedPart(p, () => undefined)).toBe(p);
  });

  it('knows the subject even if an own change takes the row out of the display', async () => {
    const { api } = fakeApi({ a: [convo('a', 'a1')] });
    const list = new ThreadList(api, [source], 'all', NEWEST);
    await list.ready;
    const subject = list.threads[0]!.subject;
    edits.run({
      account: 'a',
      edits: new Map([['a1', { mailboxIds: { in: false, trash: true } }]]),
      text: 'Moved to Trash',
    });
    expect(list.threads).toEqual([]);
    expect(list.subjectOf('a', 'a1')).toBe(subject);
    expect(list.subjectOf('b', 'a1')).toBeNull();
    ui.toasts.undo();
  });

  it('lays the changes over ThreadList and reverts them with "undo"', async () => {
    const { api } = fakeApi({ a: [convo('a', 'a1'), convo('a', 'a2')] });
    const list = new ThreadList(api, [source], 'all', NEWEST);
    await list.ready;
    // Another account is not hit by the change.
    edits.run({ account: 'b', edits: new Map([['a2', { destroyed: true }]]), text: 'Message deleted' });
    expect(list.threads.map((t) => t.id)).toEqual(['a1', 'a2']);
    ui.toasts.undo();
    edits.run({
      account: 'a',
      edits: new Map([['a1', { mailboxIds: { in: false, trash: true } }]]),
      text: 'Moved to Trash',
    });
    expect(list.threads.map((t) => t.id)).toEqual(['a2']);
    expect([list.total, list.counts.all]).toEqual([1, 1]);
    // "Undo": nothing sent, the conversation is back.
    ui.toasts.undo();
    expect(list.threads.map((t) => t.id)).toEqual(['a1', 'a2']);
  });

  it('keeps the limit of an account in "all accounts" whose loaded conversations are all gone', async () => {
    const at = (account: string, id: string, minutes: number) =>
      convo(account, id, { receivedAt: T0 - minutes * 60_000 });
    const a = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => at('a', `a${i}`, i + 1));
    const { api } = fakeApi({ a, b: [at('b', 'b0', 30), at('b', 'b1', 500)] });
    const b = { account: 'b', boxes: ['in'], exclude: [] };
    const list = new ThreadList(api, [source, b], 'all', NEWEST);
    await list.ready;
    expect(list.threads.map((t) => t.id)).toContain('b0');
    expect(list.threads.map((t) => t.id)).not.toContain('b1');
    const trashed = new Map(a.slice(0, PAGE_SIZE).map((t) => [t.id, { mailboxIds: { in: false, trash: true } }]));
    edits.run({ account: 'a', edits: trashed, text: 'Moved to Trash' });
    expect(list.threads.map((t) => t.id)).toEqual(['b0']);
  });
});

describe('Rows before the confirmation', () => {
  const ARCH: ThreadSource = { account: 'a', boxes: ['arch'], exclude: [] };
  const DRAFTS: ThreadSource = { account: 'a', boxes: ['dr'], exclude: [] };
  const INBOX_A: ThreadSource = { account: 'a', boxes: ['in'], exclude: [] };
  const toArch = (): EmailEdit => ({ mailboxIds: { in: false, arch: true } });
  const at = (account: string, id: string, minutes: number, boxes = ['in']) =>
    convo(account, id, {
      receivedAt: T0 - minutes * 60_000,
      mailboxIds: boxes,
      members: [member(id, boxes)],
      unread: false,
      count: 1,
    });
  function queued(key: string, patch: Partial<QueuedDraft> = {}): QueuedDraft {
    return {
      key,
      account: 'a',
      email: {
        from: { name: 'Me', email: 'Me@Example.com' },
        to: [{ name: 'Anna', email: 'anna@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Offer',
        text: 'Hello Anna,\n\n  the offer  follows.',
        attachments: [],
        inReplyTo: null,
        references: null,
        keywords: {},
        mailboxIds: ['dr', 'tag'],
      },
      replace: null,
      moved: null,
      at: T0 - 5 * 60_000,
      ...patch,
    };
  }
  afterEach(() => {
    ui.toasts.undo();
    ui.reset();
    edits.reset();
    edits.carry((account, ids) => threads.rowsOf(account, ids));
  });

  it('builds the row of a waiting draft that opens compose with its key', () => {
    expect(draftRow(queued('0001'), 'dr')).toEqual({
      key: 'a/~0001',
      account: 'a',
      id: '~0001',
      threadId: '~0001',
      receivedAt: T0 - 5 * 60_000,
      from: [{ name: 'Me', email: 'Me@Example.com' }],
      to: [{ name: 'Anna', email: 'anna@example.com' }],
      subject: 'Offer',
      preview: 'Hello Anna, the offer follows.',
      hasAttachment: false,
      unread: false,
      flagged: false,
      count: 1,
      mailboxIds: ['dr', 'tag'],
      members: [
        { id: '~0001', mailboxIds: ['dr', 'tag'], keywords: { $draft: true, $seen: true }, from: 'me@example.com' },
      ],
      seq: 0,
    });
  });

  it('inserts a moved conversation at its place, with count and counters', () => {
    const raw = part('a', [at('a', 'x1', 1, ['arch']), at('a', 'x3', 30, ['arch'])], {
      source: ARCH,
      total: 2,
      counts: { all: 2, unread: 0, flagged: 0 },
    });
    const moved = { ...at('a', 'm1', 10), unread: true, members: [member('m1', ['in'])] };
    const added = addedRows(raw, { rows: [moved], drafts: [], replaced: new Set() }, toArch, 'all');
    expect(added.rows.map((t) => [t.id, t.mailboxIds, t.unread])).toEqual([['m1', ['arch'], true]]);
    const out = withRows(raw, added, NEWEST);
    expect(out.ids).toEqual(['x1', 'm1', 'x3']);
    expect([out.total, out.counts]).toEqual([3, { all: 3, unread: 1, flagged: 0 }]);
    // It is missing in the segment "Flagged", and a list not loaded stays empty.
    expect(addedRows(raw, { rows: [moved], drafts: [], replaced: new Set() }, toArch, 'flagged').rows).toEqual([]);
    const empty = { ...raw, loaded: false };
    expect(addedRows(empty, { rows: [moved], drafts: [], replaced: new Set() }, toArch, 'all').rows).toEqual([]);
  });

  it('inserts nothing the server already shows or that already stood in the view', () => {
    const raw = part('a', [at('a', 'x1', 1, ['arch'])], { source: ARCH });
    const known = { ...at('a', 'other', 5), threadId: 't-x1' };
    const already = { ...at('a', 'm2', 5), members: [member('m2', ['in']), member('m2-b', ['arch'])] };
    const untouched = at('a', 'm3', 5);
    const rows = [known, already, untouched];
    const edit = (id: string) => (id === 'm3' ? undefined : toArch());
    expect(addedRows(raw, { rows, drafts: [], replaced: new Set() }, edit, 'all').rows).toEqual([]);
  });

  it('leaves out a row behind the last loaded conversation as long as further pages are missing', () => {
    const raw = part('a', [at('a', 'x1', 1, ['arch'])], { source: ARCH, done: false });
    const added = addedRows(raw, { rows: [at('a', 'm1', 10)], drafts: [], replaced: new Set() }, toArch, 'all');
    expect(withRows(raw, added, NEWEST).ids).toEqual(['x1']);
    expect(withRows({ ...raw, done: true }, added, NEWEST).ids).toEqual(['x1', 'm1']);
  });

  it('shows a conversation moved offline in the target until "undo" reverts it', async () => {
    const { api } = fakeApi({ a: [at('a', 'm1', 10), at('a', 'm2', 20)] });
    const inbox = new ThreadList(api, [INBOX_A], 'all', NEWEST);
    const { api: archApi } = fakeApi({ a: [at('a', 'x1', 1, ['arch']), at('a', 'x3', 30, ['arch'])] });
    const arch = new ThreadList(archApi, [ARCH], 'all', NEWEST);
    await Promise.all([inbox.ready, arch.ready]);
    edits.carry((account, ids) => {
      const into = new Map<string, ListThread>();
      inbox.rowsOf(account, ids, into);
      return [...into.values()];
    });
    edits.run({ account: 'a', edits: new Map([['m1', toArch()]]), text: 'Moved' });
    expect(inbox.threads.map((t) => t.id)).toEqual(['m2']);
    expect(arch.threads.map((t) => t.id)).toEqual(['x1', 'm1', 'x3']);
    expect(arch.total).toBe(3);
    ui.toasts.undo();
    expect(arch.threads.map((t) => t.id)).toEqual(['x1', 'x3']);
    expect(inbox.threads.map((t) => t.id)).toEqual(['m1', 'm2']);
  });

  it('shows waiting drafts in "Drafts" instead of the version they replace', async () => {
    const { api } = fakeApi({ a: [at('a', 'd1', 1, ['dr']), at('a', 'd2', 30, ['dr'])] });
    const list = new ThreadList(api, [DRAFTS], 'all', NEWEST, undefined, { draftsOf: () => 'dr' });
    await list.ready;
    edits.queue.drafts = [queued('0001'), queued('0002', { replace: { account: 'a', id: 'd2' }, at: T0 })];
    expect(list.threads.map((t) => t.id)).toEqual(['~0002', 'd1', '~0001']);
    expect(list.total).toBe(3);
    // Drafts are never unread; without a known "Drafts" mailbox the list shows none.
    const unread = new ThreadList(api, [DRAFTS], 'unread', NEWEST, undefined, { draftsOf: () => 'dr' });
    await unread.ready;
    expect(unread.threads.map((t) => t.id)).not.toContain('~0001');
    const plain = new ThreadList(api, [DRAFTS], 'all', NEWEST);
    await plain.ready;
    expect(plain.threads.map((t) => t.id)).toEqual(['d1', 'd2']);
    edits.queue.drafts = [];
    expect(list.threads.map((t) => t.id)).toEqual(['d1', 'd2']);
  });

  it('shows a waiting draft also behind the limit and keeps the row for further drafts', () => {
    const raw = part('a', [at('a', 'd1', 1, ['dr'])], { source: DRAFTS, done: false });
    const old = draftRow(queued('0001', { at: T0 - 600 * 60_000 }), 'dr');
    const added = addedRows(raw, { rows: [], drafts: [old], replaced: new Set() }, () => undefined, 'all');
    expect(withRows(raw, added, NEWEST).ids).toEqual(['d1', '~0001']);
    const both = {
      ...at('a', 'd1', 1, ['dr']),
      preview: 'Old state',
      members: [member('d0', ['dr']), member('d1', ['dr'])],
    };
    const shared = part('a', [both], { source: DRAFTS });
    const kept = addedRows(shared, { rows: [], drafts: [], replaced: new Set(['a/d1']) }, () => undefined, 'all');
    expect(kept).toMatchObject({ hide: [], swap: [{ from: 'd1', to: 'd0' }] });
    // The row opens the remaining draft, not the replaced one (`compose.openDraft` would otherwise find the version).
    const swapped = withRows(shared, kept, NEWEST);
    expect(swapped.ids).toEqual(['d0']);
    expect(swapped.items.get('d0')).toMatchObject({ id: 'd0', key: 'a/d0', preview: '', threadId: both.threadId });
    // In the segment only a draft that would stand there counts.
    const flagged = {
      ...both,
      flagged: true,
      members: [member('d0', ['dr']), member('d1', ['dr'], { $flagged: true })],
    };
    const marked = part('a', [flagged], { source: DRAFTS });
    const only = { rows: [], drafts: [], replaced: new Set(['a/d1']) };
    expect(addedRows(marked, only, () => undefined, 'flagged')).toMatchObject({ hide: ['d1'], swap: [] });
    expect(addedRows(marked, only, () => undefined, 'all')).toMatchObject({
      hide: [],
      swap: [{ from: 'd1', to: 'd0' }],
    });
    // Only the replaced draft was flagged: the row no longer is, the counter follows.
    const flaggedAll = part('a', [flagged], { source: DRAFTS, counts: { all: 3, flagged: 2 } });
    const unmarked = withRows(
      flaggedAll,
      addedRows(flaggedAll, only, () => undefined, 'all'),
      NEWEST,
    );
    expect(unmarked.items.get('d0')).toMatchObject({ flagged: false });
    expect(unmarked.counts).toEqual({ all: 3, flagged: 1 });
    // A draft that an own change deletes or moves does not remain.
    const three = { ...both, members: [member('dx', ['dr']), member('d0', ['dr']), member('d1', ['dr'])] };
    const gone = (id: string): EmailEdit | undefined =>
      id === 'd0' ? { mailboxIds: { dr: false, arch: true } } : undefined;
    const triple = part('a', [three], { source: DRAFTS });
    expect(addedRows(triple, only, gone, 'all')).toMatchObject({ hide: [], swap: [{ from: 'd1', to: 'dx' }] });
    expect(addedRows(shared, only, gone, 'all')).toMatchObject({ hide: ['d1'], swap: [] });
    // Hidden only in the segment: the counters of the other segments stay.
    const counted = part('a', [flagged], { source: DRAFTS, counts: { all: 5, flagged: 2 }, total: 2 });
    const out = withRows(
      counted,
      addedRows(counted, only, () => undefined, 'flagged'),
      NEWEST,
    );
    expect(out).toMatchObject({ ids: [], total: 1, counts: { all: 5, flagged: 1 } });
    const alone = part('a', [at('a', 'd1', 1, ['dr'])], { source: DRAFTS, counts: { all: 5 }, total: 5 });
    expect(
      withRows(
        alone,
        addedRows(alone, only, () => undefined, 'all'),
        NEWEST,
      ).counts,
    ).toEqual({ all: 4 });
    expect(addedRows(raw, { rows: [], drafts: [], replaced: new Set(['a/d1']) }, () => undefined, 'all').hide).toEqual([
      'd1',
    ]);
  });

  it('opens a different draft from each row when a version replaces one of two', async () => {
    const both = { ...at('a', 'd1', 1, ['dr']), members: [member('d0', ['dr']), member('d1', ['dr'])] };
    const { api } = fakeApi({ a: [both] });
    const list = new ThreadList(api, [DRAFTS], 'all', NEWEST, undefined, { draftsOf: () => 'dr' });
    await list.ready;
    edits.queue.drafts = [queued('0002', { replace: { account: 'a', id: 'd1' }, at: T0 })];
    expect(list.threads.map((t) => t.id)).toEqual(['~0002', 'd0']);
  });

  it('keeps the limit of an account whose last loaded row a waiting version hides', async () => {
    const a = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => at('a', `a${i}`, i + 1, ['dr']));
    const last = `a${PAGE_SIZE - 1}`;
    const B: ThreadSource = { account: 'b', boxes: ['dr'], exclude: [] };
    const { api } = fakeApi({ a, b: [at('b', 'b0', PAGE_SIZE - 0.5, ['dr'])] });
    const list = new ThreadList(api, [DRAFTS, B], 'all', NEWEST, undefined, { draftsOf: () => 'dr' });
    await list.ready;
    expect(list.threads.map((t) => t.id)).toContain('b0');
    edits.queue.drafts = [queued('0001', { replace: { account: 'a', id: last }, at: T0 })];
    const ids = list.threads.map((t) => t.id);
    expect(ids).toContain('b0');
    expect(ids).not.toContain(last);
    expect(ids[0]).toBe('~0001');
  });

  it('does not show waiting drafts in tags; the replaced state stays there', async () => {
    const TAG: ThreadSource = { account: 'a', boxes: ['tag'], exclude: [] };
    const { api } = fakeApi({ a: [at('a', 'd2', 30, ['dr', 'tag'])] });
    const list = new ThreadList(api, [TAG], 'all', NEWEST, undefined, { draftsOf: () => 'dr' });
    await list.ready;
    edits.queue.drafts = [queued('0001'), queued('0002', { replace: { account: 'a', id: 'd2' } })];
    expect(list.threads.map((t) => t.id)).toEqual(['d2']);
  });

  it('finds the most recent row per conversation across all lists in one run', async () => {
    const t = new Threads(fakeApi({ a: [at('a', 'm1', 10), at('a', 'm2', 20)] }).api);
    const first = t.open([INBOX_A], 'all', NEWEST).list;
    await first.ready;
    const second = t.open([INBOX_A], 'unread', NEWEST).list;
    await second.ready;
    const rows = t.rowsOf('a', new Set(['m1', 'm2', 'x']));
    expect(rows.map((r) => r.id).toSorted()).toEqual(['m1', 'm2']);
    expect(rows.every((r) => second.rowOf('a', r.id) === r)).toBe(true);
    expect(t.rowOf('a', 'm1')).toBe(second.rowOf('a', 'm1'));
    expect(t.rowsOf('b', new Set(['m1']))).toEqual([]);
  });
});

describe('sortOf', () => {
  it('sorts by date or by name and then by date', () => {
    expect(sortOf(NEWEST)).toEqual([{ property: 'receivedAt', isAscending: false }]);
    expect(sortOf(OLDEST)).toEqual([{ property: 'receivedAt', isAscending: true }]);
    expect(sortOf({ by: 'to', ascending: false })).toEqual([
      { property: 'to', isAscending: false },
      { property: 'receivedAt', isAscending: false },
    ]);
  });
});

/** `ThreadApi` with pages from fixed lists per account. */
function fakeApi(data: Record<string, ListThread[]>, result?: (account: string) => ChangesResult) {
  const page = vi.fn(({ source, position, limit }: Parameters<ThreadApi['page']>[0]) => {
    const all = data[source.account];
    if (!all) return Promise.reject(new Error(`Account ${source.account} unreachable`));
    const slice = all.slice(position, position + limit);
    return Promise.resolve({
      ids: slice.map((t) => t.id),
      threads: slice,
      total: all.length,
      queryState: 'q1',
      emailState: 'e1',
      counts: { all: all.length, unread: 0, flagged: 0 },
    });
  });
  const changes = vi.fn((request: Parameters<ThreadApi['changes']>[0]) =>
    Promise.resolve(result?.(request.source.account) ?? ({ reset: true } as const)),
  );
  const emailChanges = vi.fn<ThreadApi['emailChanges']>(() =>
    Promise.resolve({ reset: false, state: 'e2', threads: new Set(), destroyed: new Set() }),
  );
  const api: ThreadApi = { page, changes, emailChanges };
  return { api, page, changes, emailChanges };
}

/** In-memory storage; `lists` are the records by key. */
function memoryStore(saved: SavedList[] = []) {
  const lists = new Map(saved.map((s) => [s.key, s]));
  return {
    lists,
    list: vi.fn((key: string) => Promise.resolve(lists.get(key) ?? null)),
    saveList: vi.fn((s: SavedList) => void lists.set(s.key, s)),
    dropEmails: vi.fn(),
  };
}

const SOURCE: ThreadSource = { account: 'a', boxes: ['in'], exclude: [] };

function record(threads: ListThread[], overrides: Partial<SavedList> = {}): SavedList {
  return {
    key: listKey(SOURCE, 'all'),
    account: 'a',
    ids: threads.map((t) => t.id),
    threads,
    total: threads.length,
    counts: { all: threads.length, unread: 1, flagged: 0 },
    queryState: 'q0',
    emailState: 'e0',
    done: true,
    ...overrides,
  };
}

const unchanged: ChangesResult = {
  reset: false,
  removed: [],
  added: [],
  threads: [],
  reloaded: [],
  total: 2,
  queryState: 'q2',
  counts: { all: 2 },
};

const many = (account: string, n: number, step: number) =>
  Array.from({ length: n }, (_, i) => item(account, `${account}${i}`, i * step + 1));

describe('ThreadList', () => {
  it('loads the first page of all accounts and then that of the account at the limit', async () => {
    const { api, page } = fakeApi({ a: many('a', PAGE_SIZE + 10, 1), b: many('b', 3, 100) });
    const list = new ThreadList(api, [part('a', []).source, part('b', []).source], 'all', NEWEST);
    expect(list.status).toBe('loading');
    await list.ready;
    expect(list.status).toBe('ready');
    expect(list.total).toBe(PAGE_SIZE + 13);
    expect(list.counts.all).toBe(PAGE_SIZE + 13);
    // Account a has more; b's conversations (from 100 minutes) lie behind a's last loaded one (49 minutes).
    expect(list.threads).toHaveLength(PAGE_SIZE + 1);
    expect(list.hasMore).toBe(true);
    await list.loadMore();
    expect(page).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: PAGE_SIZE, anchor: `a${PAGE_SIZE - 1}`, counts: [] }),
    );
    expect(list.threads).toHaveLength(PAGE_SIZE + 13);
    expect(list.hasMore).toBe(false);
  });

  it('loads by name the account at which the list ends, even if the browser orders the names differently', async () => {
    const named = (account: string, name: (i: number) => string) =>
      many(account, PAGE_SIZE + 5, 1).map((t, i) => ({ ...t, from: [{ name: name(i), email: '' }] }));
    // The server orders "Åsa" after "Zoe"; a ends with it, b with "Carl".
    const a = named('a', (i) =>
      i < PAGE_SIZE - 2 ? 'Anna' : i === PAGE_SIZE - 2 ? 'Zoe' : i === PAGE_SIZE - 1 ? '\u00c5sa' : 'Zz',
    );
    const b = named('b', (i) => (i < PAGE_SIZE - 1 ? 'Bernd' : i === PAGE_SIZE - 1 ? 'Carl' : 'Zz'));
    const { api, page } = fakeApi({ a, b });
    const list = new ThreadList(api, [part('a', []).source, part('b', []).source], 'all', {
      by: 'from',
      ascending: true,
    });
    await list.ready;
    expect(list.threads.at(-1)?.id).toBe(`b${PAGE_SIZE - 1}`);
    await list.loadMore();
    const last = page.mock.lastCall?.[0];
    expect([last?.source.account, last?.anchor]).toEqual(['b', `b${PAGE_SIZE - 1}`]);
  });

  it('shows the other accounts if one does not answer, and fails without any response', async () => {
    const { api } = fakeApi({ a: many('a', 2, 1) });
    const list = new ThreadList(api, [part('a', []).source, part('x', []).source], 'all', NEWEST);
    await list.ready;
    expect(list.threads).toHaveLength(2);
    expect(list.failed).toEqual(['x']);
    const none = new ThreadList(api, [part('x', []).source], 'all', NEWEST);
    await expect(none.ready).rejects.toThrow('unreachable');
    expect(none.status).toBe('error');
  });

  it("keeps loading without the server's `total` as long as pages are full", async () => {
    const all = many('a', PAGE_SIZE + 5, 1);
    const { api } = fakeApi({ a: all });
    const page = vi.fn(async (request: Parameters<ThreadApi['page']>[0]) => ({
      ...(await api.page(request)),
      total: null,
    }));
    const list = new ThreadList({ ...api, page }, [part('a', []).source], 'all', NEWEST);
    await list.ready;
    expect(list.hasMore).toBe(true);
    await list.loadMore();
    expect(list.threads).toHaveLength(PAGE_SIZE + 5);
    expect(list.hasMore).toBe(false);
  });

  it('is empty immediately without sources', async () => {
    const list = new ThreadList(fakeApi({}).api, [], 'all', NEWEST);
    await list.ready;
    expect(list).toMatchObject({ status: 'ready', threads: [], total: 0, hasMore: false });
  });

  it('applies `Email/queryChanges` and counts new ones', async () => {
    const data = { a: many('a', 2, 10) };
    const fresh = item('a', 'n1', 0);
    const { api, changes } = fakeApi(data, () => ({
      reset: false,
      removed: ['a1'],
      added: [{ id: 'n1', index: 0 }],
      threads: [fresh],
      reloaded: [],
      total: 2,
      queryState: 'q2',
      counts: { all: 2, unread: 1, flagged: 0 },
    }));
    const list = new ThreadList(api, [part('a', []).source], 'all', NEWEST);
    await list.ready;
    expect(await list.refresh()).toEqual({ added: 1, failed: 0 });
    expect(list.threads.map((t) => t.id)).toEqual(['n1', 'a0']);
    expect(list.counts.unread).toBe(1);
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ sinceQueryState: 'q1', upToId: 'a1' }));
  });

  it('reloads on `reset` and retries failed accounts', async () => {
    const data: Record<string, ListThread[]> = { a: many('a', 2, 10) };
    const { api, page } = fakeApi(data);
    const list = new ThreadList(api, [part('a', []).source, part('b', []).source], 'all', NEWEST);
    await list.ready;
    expect(list.failed).toEqual(['b']);
    data['a'] = [item('a', 'n1', 0), ...data['a']!];
    data['b'] = many('b', 1, 5);
    expect(await list.refresh()).toEqual({ added: 1, failed: 0 });
    expect(page).toHaveBeenCalledTimes(4);
    expect(list.threads.map((t) => t.id)).toEqual(['n1', 'a0', 'b0', 'a1']);
  });

  it('refetches conversations reported by the live sync on the next sync', async () => {
    const data = { a: many('a', 3, 10) };
    const read = { ...item('a', 'a1', 20), unread: true };
    const { api, changes } = fakeApi(data, () => ({
      reset: false,
      removed: [],
      added: [],
      threads: [],
      reloaded: [read],
      total: 3,
      queryState: 'q2',
      counts: {},
    }));
    const list = new ThreadList(api, [part('a', []).source, part('b', []).source], 'all', NEWEST);
    await list.ready;
    list.touch({ account: 'a', reset: false, threads: new Set(['t-a1', 't-x']), destroyed: new Set() });
    list.touch({ account: 'a', reset: false, threads: new Set(['t-a2']), destroyed: new Set() });
    list.touch({ account: 'z', reset: true, threads: new Set(), destroyed: new Set() });
    await list.refresh('a');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ reload: ['a1', 'a2'] }));
    expect(list.threads.find((t) => t.id === 'a1')?.unread).toBe(true);
    // Reported is reported: the next sync fetches nothing more.
    await list.refresh();
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reload: [] }));
  });

  it('loads the first page after `reset` of the live sync and keeps reports after errors', async () => {
    const data: Record<string, ListThread[]> = { a: many('a', 2, 10) };
    const { api, page, changes } = fakeApi(data, () => ({
      reset: false,
      removed: [],
      added: [],
      threads: [],
      reloaded: [],
      total: 2,
      queryState: 'q2',
      counts: {},
    }));
    const list = new ThreadList(api, [part('a', []).source], 'all', NEWEST);
    await list.ready;
    list.touch({ account: 'a', reset: true, threads: new Set(), destroyed: new Set() });
    await list.refresh();
    expect(page).toHaveBeenCalledTimes(2);
    expect(changes).not.toHaveBeenCalled();
    list.touch({ account: 'a', reset: false, threads: new Set(['t-a0']), destroyed: new Set() });
    changes.mockRejectedValueOnce(new Error('offline'));
    expect(await list.refresh()).toEqual({ added: 0, failed: 1 });
    await list.refresh();
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reload: ['a0'] }));
  });

  it('reloads the first page if the list was still loading when reported or more than one page would need refetching', async () => {
    const data = { a: many('a', PAGE_SIZE + 5, 1) };
    const { api, page, changes } = fakeApi(data, () => ({
      reset: false,
      removed: [],
      added: [],
      threads: [],
      reloaded: [],
      total: PAGE_SIZE + 5,
      queryState: 'q2',
      counts: {},
    }));
    const list = new ThreadList(api, [part('a', []).source], 'all', NEWEST);
    list.touch({ account: 'a', reset: false, threads: new Set(['t-a0']), destroyed: new Set() });
    await list.ready;
    await list.refresh();
    expect(page).toHaveBeenCalledTimes(2);
    await list.loadMore();
    expect(list.threads).toHaveLength(PAGE_SIZE + 5);
    list.touch({ account: 'a', reset: false, threads: new Set(data.a.map((t) => t.threadId)), destroyed: new Set() });
    await list.refresh();
    expect(page).toHaveBeenCalledTimes(4);
    expect(changes).not.toHaveBeenCalled();
  });

  it('discards responses after `dispose()`', async () => {
    const { api } = fakeApi({ a: many('a', 2, 1) });
    const list = new ThreadList(api, [part('a', []).source], 'all', NEWEST);
    list.dispose();
    await list.ready;
    expect(list.threads).toEqual([]);
  });
});

describe('Storage', () => {
  const saved = () => [item('a', 'a0', 1), { ...item('a', 'a1', 2), unread: true }];

  it('shows the list from storage before the network answers, and then syncs via */changes', async () => {
    const store = memoryStore([record(saved())]);
    const { api, page, changes, emailChanges } = fakeApi({ a: [] }, () => unchanged);
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    expect(list.status).toBe('ready');
    expect(list.threads.map((t) => t.id)).toEqual(['a0', 'a1']);
    expect(page).not.toHaveBeenCalled();
    await list.refresh();
    expect(emailChanges).toHaveBeenCalledExactlyOnceWith('a', 'e0');
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ sinceQueryState: 'q0', reload: [] }));
    expect(page).not.toHaveBeenCalled();
    // The sync has seen everything up to e2; that goes into storage.
    expect(store.lists.get(listKey(SOURCE, 'all'))).toMatchObject({ queryState: 'q2', emailState: 'e2' });
  });

  it('refetches threads that changed since the record', async () => {
    const store = memoryStore([record(saved())]);
    const { api, changes, emailChanges } = fakeApi({ a: [] }, () => unchanged);
    emailChanges.mockResolvedValue({
      reset: false,
      state: 'e2',
      threads: new Set(['t-a1', 'fremd']),
      destroyed: new Set(),
    });
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    await list.refresh();
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ reload: ['a1'] }));
  });

  it('discards emails in storage that were deleted while the app was closed', async () => {
    const store = memoryStore([record(saved())]);
    const { api, emailChanges } = fakeApi({ a: [] }, () => unchanged);
    const destroyed = new Set(['gone']);
    emailChanges.mockResolvedValue({ reset: false, state: 'e2', threads: new Set(), destroyed });
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    await list.refresh();
    expect(store.dropEmails).toHaveBeenCalledExactlyOnceWith('a', destroyed);
  });

  it('reloads the first page if the server cannot calculate the changes', async () => {
    const store = memoryStore([record(saved())]);
    const { api, page, emailChanges } = fakeApi({ a: many('a', 3, 1) });
    emailChanges.mockResolvedValue({ reset: true });
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    await vi.waitFor(() => expect(list.threads.map((t) => t.id)).toEqual(['a0', 'a1', 'a2']));
    expect(page).toHaveBeenCalledTimes(1);
    expect(store.lists.get(listKey(SOURCE, 'all'))).toMatchObject({ queryState: 'q1', emailState: 'e1' });
  });

  it('reloads the first page if the server rejects the stored state', async () => {
    const store = memoryStore([record(saved())]);
    const { api, page, emailChanges } = fakeApi({ a: many('a', 3, 1) });
    emailChanges.mockRejectedValueOnce(new Error('invalidArguments'));
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(1));
    expect(list.failed).toEqual([]);
  });

  it('stays readable and silent without network, and a later sync catches up', async () => {
    const store = memoryStore([record(saved(), { done: false, total: 10 })]);
    const { api, emailChanges, changes } = fakeApi({ a: [] }, () => unchanged);
    emailChanges.mockRejectedValueOnce(new NetworkError(new TypeError('offline')));
    const threads = new Threads(api, () => store);
    const { list } = threads.open([SOURCE], 'all', NEWEST);
    await expect(list.ready).resolves.toBeUndefined();
    await vi.waitFor(() => expect(list.failed).toEqual(['a']));
    expect(list.threads).toHaveLength(2);
    expect(list.status).toBe('ready');
    expect(list.hasMore).toBe(false);
    expect(list.truncated).toBe(true);
    const stop = threads.show(list);
    await threads.resume('a');
    stop();
    expect(emailChanges).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(list.failed).toEqual([]);
  });

  it('goes to the network as before without a record and writes the response', async () => {
    const store = memoryStore();
    const { api, page, emailChanges } = fakeApi({ a: many('a', 2, 1) });
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    expect(page).toHaveBeenCalledTimes(1);
    expect(emailChanges).not.toHaveBeenCalled();
    expect(store.saveList).toHaveBeenCalledTimes(1);
    expect(store.lists.get(listKey(SOURCE, 'all'))).toMatchObject({ ids: ['a0', 'a1'], emailState: 'e1', done: true });
  });

  it('takes over a reported state only with the sync that processes the report', async () => {
    const store = memoryStore();
    const { api, changes } = fakeApi({ a: many('a', 2, 1) }, () => unchanged);
    const list = new ThreadList(api, [SOURCE], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    list.touch({ account: 'a', reset: false, threads: new Set(['t-a0']), destroyed: new Set(), state: 'e5' });
    expect(store.lists.get(listKey(SOURCE, 'all'))?.emailState).toBe('e1');
    changes.mockRejectedValueOnce(new Error('offline'));
    await list.refresh();
    expect(store.lists.get(listKey(SOURCE, 'all'))?.emailState).toBe('e1');
    await list.refresh();
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reload: ['a0'] }));
    expect(store.lists.get(listKey(SOURCE, 'all'))?.emailState).toBe('e5');
  });

  it('derives segments without a record from "All" and then loads the first page', async () => {
    const store = memoryStore([record(saved())]);
    const { api, page, emailChanges } = fakeApi({ a: [] });
    const list = new ThreadList(api, [SOURCE], 'unread', NEWEST, undefined, { store: () => store });
    await list.ready;
    expect(list.threads.map((t) => t.id)).toEqual(['a1']);
    expect(list.total).toBe(1);
    expect(page).not.toHaveBeenCalled();
    expect(emailChanges).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(1));
  });

  it('sorts lists differing from the default from storage itself and does not write them', async () => {
    const named = [
      { ...item('a', 'a0', 1), from: [{ name: 'Zoe', email: 'z@b.example' }] },
      { ...item('a', 'a1', 2), from: [{ name: 'Anna', email: 'a@b.example' }] },
    ];
    const store = memoryStore([record(named)]);
    const { api } = fakeApi({ a: many('a', 1, 1) });
    const order: ListOrder = { by: 'from', ascending: true };
    const list = new ThreadList(api, [SOURCE], 'all', order, undefined, { store: () => store, sorted: true });
    await list.ready;
    expect(list.threads.map((t) => t.id)).toEqual(['a1', 'a0']);
    await vi.waitFor(() => expect(list.threads).toHaveLength(1));
    expect(store.saveList).not.toHaveBeenCalled();
  });

  it('truncates records to the window', () => {
    const list = many('a', MAX_LIST_THREADS + 5, 1);
    const saved = savedOf(part('a', list, { source: SOURCE }), 'all');
    expect(saved.ids).toHaveLength(MAX_LIST_THREADS);
    expect(saved.threads).toHaveLength(MAX_LIST_THREADS);
    expect(saved.done).toBe(false);
  });

  it('reads accounts without access only from storage', async () => {
    const source = { ...SOURCE, frozen: true };
    const store = memoryStore([record(saved(), { done: false, total: 10 })]);
    const { api, page, changes, emailChanges } = fakeApi({ a: [] }, () => unchanged);
    const list = new ThreadList(api, [source], 'all', NEWEST, undefined, { store: () => store });
    await list.ready;
    expect(list.threads).toHaveLength(2);
    expect(list.hasMore).toBe(false);
    expect(list.truncated).toBe(false);
    await list.refresh();
    expect([page, changes, emailChanges].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(store.saveList).not.toHaveBeenCalled();
    const none = new ThreadList(api, [source], 'all', NEWEST, undefined, { store: () => memoryStore() });
    await none.ready;
    expect([none.status, none.threads.length]).toEqual(['ready', 0]);
  });
});

describe('Threads', () => {
  it('keeps opened lists and discards those of removed accounts', () => {
    const t = new Threads(fakeApi({ a: many('a', 1, 1) }).api);
    const first = t.open([INBOX], 'all', NEWEST);
    expect(first.cached).toBe(false);
    expect(t.open([INBOX], 'all', NEWEST)).toEqual({ list: first.list, cached: true });
    expect(t.open([INBOX], 'unread', NEWEST).list).not.toBe(first.list);
    t.retain(['k2']);
    expect(t.open([INBOX], 'all', NEWEST).cached).toBe(false);
    t.reset();
    expect(t.open([INBOX], 'all', NEWEST).cached).toBe(false);
  });

  it('syncs displayed lists of the account immediately, the others on the next opening', async () => {
    const { api, changes } = fakeApi({ k1: many('k1', 2, 1) }, () => ({
      reset: false,
      removed: [],
      added: [],
      threads: [],
      reloaded: [],
      total: 2,
      queryState: 'q2',
      counts: {},
    }));
    const t = new Threads(api);
    const shown = t.open([INBOX], 'all', NEWEST).list;
    const other = t.open([INBOX], 'unread', NEWEST).list;
    await Promise.all([shown.ready, other.ready]);
    const hide = t.show(shown);
    const change = { account: 'k1', reset: false, threads: new Set(['t-k10']), destroyed: new Set<string>() };
    await t.touch(change);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ segment: 'all', reload: ['k10'] }));
    await t.touch({ ...change, account: 'k2' });
    expect(changes).toHaveBeenCalledTimes(1);
    hide();
    await t.touch(change);
    expect(changes).toHaveBeenCalledTimes(1);
    await other.refresh();
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ segment: 'unread', reload: ['k10'] }));
  });

  it('keeps only the most recently opened of sorted lists', () => {
    const t = new Threads(fakeApi({ a: many('a', 1, 1) }).api);
    t.open([INBOX], 'all', NEWEST);
    const byName = t.open([INBOX], 'all', { by: 'from', ascending: true }, undefined, true).list;
    t.open([INBOX], 'all', { by: 'from', ascending: false }, undefined, true);
    expect(t.open([INBOX], 'all', NEWEST).cached).toBe(true);
    const again = t.open([INBOX], 'all', { by: 'from', ascending: true }, undefined, true);
    expect(again).toMatchObject({ cached: false });
    expect(again.list).not.toBe(byName);
  });
});
