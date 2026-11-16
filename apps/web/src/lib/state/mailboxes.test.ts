import { JmapClient, type Mailbox } from '@roedy/jmap';
import { NetworkError } from '#lib/api.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  FolderError,
  Mailboxes,
  canDelete,
  findFolder,
  folderChain,
  folderLevels,
  folderTree,
  nameTaken,
  roleMailbox,
  sumCounts,
  tagRoot,
} from './mailboxes.svelte.ts';

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
      maxCallsInRequest: 8,
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

function box(id: string, name: string, overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    ...overrides,
  };
}

type Invocation = [string, Record<string, unknown>, string];
type Handler = (call: Invocation) => [string, unknown];

/** Fake mail server: answers every call of a request with the next handler. */
function server(...handlers: Handler[]) {
  const seen: Invocation[] = [];
  const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    const methodResponses = methodCalls.map((call) => {
      seen.push(call);
      const handler = handlers.shift();
      if (!handler) throw new Error(`unexpected call ${call[0]}`);
      const [name, args] = handler(call);
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

const get =
  (state: string, list: Mailbox[]): Handler =>
  () => ['Mailbox/get', { accountId: 'j1', state, list, notFound: [] }];

const INBOX = box('m-in', 'Inbox', { role: 'inbox', unreadThreads: 4, totalThreads: 15 });
const JUNK = box('m-junk', 'Junk Mail', { role: 'junk', totalThreads: 2 });

describe('Mailboxes', () => {
  it('sums the counters of a role across the accounts', () => {
    expect(sumCounts([{ unread: 2, total: 5 }, null, { unread: 1, total: 3 }])).toEqual({ unread: 3, total: 8 });
    expect(sumCounts([null, null])).toBeNull();
  });

  it('finds the sidebar mailboxes via the role, spam via junk', () => {
    const list = [INBOX, JUNK, box('m-in2', 'Inbox 2', { role: 'inbox', sortOrder: 5 })];
    expect(roleMailbox(list, 'inbox')?.id).toBe('m-in');
    expect(roleMailbox(list, 'spam')?.id).toBe('m-junk');
    expect(roleMailbox(list, 'scheduled')).toBeNull();
  });

  it('builds the tree from parentId in the order of sortOrder and name', () => {
    const list = [
      INBOX,
      box('p', 'Projects', { sortOrder: 2 }),
      box('k', 'Customers', { sortOrder: 1 }),
      box('r', 'Website-Relaunch', { parentId: 'p' }),
      box('f', 'Feedback', { parentId: 'r', unreadThreads: 1, totalThreads: 2 }),
      box('e', 'Drafts', { parentId: 'r' }),
      box('a', 'Archive', { sortOrder: 2, role: 'archive' }),
    ];
    const tree = folderTree(list);
    expect(tree.map((n) => n.name)).toEqual(['Customers', 'Archive', 'Projects']);
    const relaunch = tree[2]?.children[0];
    expect(relaunch?.name).toBe('Website-Relaunch');
    expect(relaunch?.children.map((n) => [n.name, n.unread, n.total])).toEqual([
      ['Drafts', 0, 0],
      ['Feedback', 1, 2],
    ]);
  });

  it('leaves out the root "Tags" with everything below it and lifts subfolders of roles to the top', () => {
    const list = [
      INBOX,
      box('t', 'Tags'),
      box('t1', 'Important', { parentId: 't' }),
      box('t2', 'Taxes', { parentId: 't1' }),
      box('sub', 'Under the inbox', { parentId: 'm-in' }),
      box('lost', 'Orphan', { parentId: 'missing' }),
      box('t9', 'Tags', { parentId: 'sub' }),
    ];
    expect(tagRoot(list)?.id).toBe('t');
    expect(folderTree(list).map((n) => [n.name, n.children.map((c) => c.name)])).toEqual([
      ['Orphan', []],
      ['Under the inbox', ['Tags']],
    ]);
  });

  it('puts folders in a parentId cycle on top instead of losing them', () => {
    const list = [
      box('a', 'A', { parentId: 'b' }),
      box('b', 'B', { parentId: 'a' }),
      box('c', 'C', { parentId: 'b' }),
      box('s', 'Self', { parentId: 's' }),
    ];
    expect(folderTree(list).map((n) => [n.name, n.children.map((c) => c.name)])).toEqual([
      ['A', []],
      ['B', ['C']],
      ['Self', []],
    ]);
  });

  it('loads once per account and then syncs with Mailbox/changes', async () => {
    const { client, seen } = server(
      get('b1', [INBOX, box('k', 'Customers', { totalThreads: 3 }), box('x', 'Backup')]),
      () => [
        'Mailbox/changes',
        {
          accountId: 'j1',
          oldState: 'b1',
          newState: 'b2',
          hasMoreChanges: false,
          created: ['n'],
          updated: ['m-in'],
          destroyed: ['x'],
          updatedProperties: ['unreadThreads'],
        },
      ],
      get('b2', [box('n', 'New')]),
      get('b2', [{ ...INBOX, unreadThreads: 3 }]),
    );
    const mailboxes = new Mailboxes(() => Promise.resolve(client));
    expect(mailboxes.of('a1')).toBeUndefined();
    const loading = mailboxes.ensure('a1');
    expect(mailboxes.of('a1')?.status).toBe('loading');
    await Promise.all([loading, mailboxes.ensure('a1')]);
    await mailboxes.ensure('a1');
    expect(seen.filter(([name]) => name === 'Mailbox/get')).toHaveLength(1);
    expect(seen[0]?.[1]).toEqual({ accountId: 'j1', ids: null });
    expect(mailboxes.role('a1', 'inbox')?.unreadThreads).toBe(4);
    expect(mailboxes.tree('a1').map((n) => n.name)).toEqual(['Backup', 'Customers']);

    await Promise.all([mailboxes.sync('a1'), mailboxes.sync('a1')]);
    expect(seen.find(([name]) => name === 'Mailbox/changes')?.[1]).toMatchObject({ sinceState: 'b1' });
    expect(mailboxes.role('a1', 'inbox')?.unreadThreads).toBe(3);
    expect(mailboxes.tree('a1').map((n) => n.name)).toEqual(['Customers', 'New']);
  });

  it('reloads everything on cannotCalculateChanges', async () => {
    const { client } = server(
      get('b1', [INBOX]),
      () => ['error', { type: 'cannotCalculateChanges' }],
      () => ['Mailbox/get', { accountId: 'j1', state: 'b1', list: [], notFound: [] }],
      () => ['Mailbox/get', { accountId: 'j1', state: 'b1', list: [], notFound: [] }],
      get('b9', [INBOX, box('k', 'Customers')]),
    );
    const mailboxes = new Mailboxes(() => Promise.resolve(client));
    await mailboxes.load('a1');
    await mailboxes.sync('a1');
    expect(mailboxes.tree('a1').map((n) => n.name)).toEqual(['Customers']);
  });

  it('reports a failed first load, keeps known mailboxes afterwards and retries ensure', async () => {
    const { client } = server(get('b1', [INBOX]), () => ['error', { type: 'serverFail' }]);
    let fail = true;
    const mailboxes = new Mailboxes(() => (fail ? Promise.reject(new Error('no token')) : Promise.resolve(client)));
    await expect(mailboxes.ensure('a1')).rejects.toThrow('no token');
    expect(mailboxes.of('a1')).toMatchObject({ status: 'error', list: [] });
    fail = false;
    await mailboxes.ensure('a1');
    expect(mailboxes.of('a1')?.status).toBe('ready');
    await expect(mailboxes.load('a1')).rejects.toMatchObject({ type: 'serverFail' });
    expect(mailboxes.of('a1')).toMatchObject({ status: 'ready', list: [INBOX] });
  });

  it('stays with ensure for loaded mailboxes even if a sync fails', async () => {
    const { client } = server(
      get('b1', [INBOX]),
      () => ['error', { type: 'serverFail' }],
      get('b1', []),
      get('b1', []),
    );
    const mailboxes = new Mailboxes(() => Promise.resolve(client));
    await mailboxes.load('a1');
    const sync = mailboxes.sync('a1');
    await expect(mailboxes.ensure('a1')).resolves.toBeUndefined();
    await expect(sync).rejects.toMatchObject({ type: 'serverFail' });
    expect(mailboxes.role('a1', 'inbox')?.id).toBe('m-in');
  });

  it('silences errors of a sync after sign-out and discards removed accounts', async () => {
    const { client } = server(get('b1', [INBOX]));
    let reject: (error: Error) => void = () => {};
    let asked = 0;
    const mailboxes = new Mailboxes(() => {
      asked++;
      return asked === 1 ? Promise.resolve(client) : new Promise((_, r) => (reject = r));
    });
    await mailboxes.load('a1');
    const sync = mailboxes.sync('a1');
    await vi.waitFor(() => expect(asked).toBe(2));
    mailboxes.reset();
    reject(new Error('signed out'));
    await expect(sync).resolves.toBeUndefined();

    const again = server(get('b1', [INBOX]), get('b1', [INBOX]));
    const kept = new Mailboxes(() => Promise.resolve(again.client));
    await kept.load('a1');
    await kept.load('a2');
    kept.toggleAccount('a2');
    kept.retain(['a1']);
    expect(kept.of('a1')?.status).toBe('ready');
    expect(kept.of('a2')).toBeUndefined();
    expect(kept.openAccounts.has('a2')).toBe(false);
  });

  it('discards responses after forget and reset and remembers expanded folders per account', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client } = server(get('b1', [INBOX]));
    const mailboxes = new Mailboxes(() => gate.then(() => client));
    const loading = mailboxes.load('a1');
    mailboxes.toggle('a1', 'k');
    mailboxes.toggle('a2', 'k');
    expect(mailboxes.isOpen('a1', 'k')).toBe(true);
    mailboxes.forget('a1');
    release();
    await loading;
    expect(mailboxes.of('a1')).toBeUndefined();
    expect(mailboxes.isOpen('a1', 'k')).toBe(false);
    expect(mailboxes.isOpen('a2', 'k')).toBe(true);
    mailboxes.toggle('a2', 'k');
    expect(mailboxes.isOpen('a2', 'k')).toBe(false);
    mailboxes.toggle('a2', 'k');
    mailboxes.reset();
    expect(mailboxes.open.size).toBe(0);
  });
});

/** Sync after a change: `Mailbox/changes` and the two `Mailbox/get` (created, updated). */
function changed(
  from: string,
  to: string,
  created: Mailbox[],
  updated: Mailbox[],
  destroyed: string[] = [],
): Handler[] {
  return [
    () => [
      'Mailbox/changes',
      {
        accountId: 'j1',
        oldState: from,
        newState: to,
        hasMoreChanges: false,
        created: created.map((b) => b.id),
        updated: updated.map((b) => b.id),
        destroyed,
        updatedProperties: null,
      },
    ],
    get(to, created),
    get(to, updated),
  ];
}

describe('Create, edit, delete folders', () => {
  const P = box('p', 'Projects');
  const W = box('w', 'Website', { parentId: 'p', totalEmails: 3 });
  const K = box('k', 'Customers');
  const TRASH = box('m-trash', 'Trash', { role: 'trash' });

  it('lays pending changes over the mailboxes and removes them again', async () => {
    const { client } = server(get('s1', [INBOX, P, W, K]));
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    const hide = boxes.stage('a1', { hide: ['p', 'w'] });
    expect(boxes.tree('a1').map((f) => f.id)).toEqual(['k']);
    const move = boxes.stage('a1', { id: 'k', name: 'Clientele', parentId: 'p' });
    boxes.unstage(hide);
    expect(boxes.tree('a1')).toMatchObject([{ id: 'p', children: [{ id: 'k', name: 'Clientele' }, { id: 'w' }] }]);
    boxes.unstage(move);
    expect(boxes.list('a1')).toEqual([INBOX, P, W, K]);
    boxes.stage('a1', { hide: ['k'] });
    boxes.forget('a1');
    expect(boxes.list('a1')).toEqual([]);
  });

  it('finds folders and their levels and detects taken names', () => {
    const X = box('x', 'Relaunch', { parentId: 'w' });
    const tree = folderTree([INBOX, P, W, K, X]);
    expect(findFolder(tree, 'w')).toMatchObject({ node: { id: 'w' }, parent: 'p' });
    expect(findFolder(tree, 'k')?.parent).toBeNull();
    expect(findFolder(tree, 'm-in')).toBeNull();
    expect(folderChain(tree, 'x')?.map((f) => f.name)).toEqual(['Projects', 'Website', 'Relaunch']);
    // Levels by parentId, also with mailboxes the tree does not show.
    const ARCHIVE = box('a', 'Archive', { parentId: 'p', role: 'archive' });
    const levels = folderLevels([INBOX, P, W, K, X, ARCHIVE], 'p');
    expect(levels?.map((level) => level.map((b) => b.id))).toEqual([['p'], ['w', 'a'], ['x']]);
    expect(levels && canDelete(levels)).toBe(false);
    const own = folderLevels([P, W, X], 'p');
    expect(own && canDelete(own)).toBe(true);
    expect(folderLevels([P], 'gone')).toBeNull();
    const list = [INBOX, P, W, K];
    expect(nameTaken(list, 'p', 'website', null)).toBe(true);
    expect(nameTaken(list, 'p', 'Website', 'w')).toBe(false);
    expect(nameTaken(list, null, 'INBOX', null)).toBe(true);
    expect(nameTaken(list, null, 'tags', null)).toBe(true);
    expect(nameTaken(list, 'p', 'Tags', null)).toBe(false);
  });

  it('creates folders subscribed, renames, moves and deletes empty ones again', async () => {
    const N = box('n', 'New', { parentId: 'p' });
    const { client, seen } = server(
      get('s1', [INBOX, P, K]),
      () => ['Mailbox/set', { accountId: 'j1', newState: 's2', created: { folder: { id: 'n' } } }],
      ...changed('s1', 's2', [N], []),
      () => ['Mailbox/set', { accountId: 'j1', newState: 's3', updated: { k: null } }],
      ...changed('s2', 's3', [], [{ ...K, name: 'Clientele', parentId: 'p' }]),
      () => ['Mailbox/set', { accountId: 'j1', newState: 's4', destroyed: ['n'] }],
      ...changed('s3', 's4', [], [], ['n']),
    );
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    expect(await boxes.create('a1', 'New', 'p')).toBe('n');
    expect(seen[1]?.[1]).toEqual({
      accountId: 'j1',
      create: { folder: { name: 'New', parentId: 'p', isSubscribed: true } },
    });
    expect(boxes.tree('a1')[1]).toMatchObject({ id: 'p', children: [{ id: 'n' }] });
    await boxes.update('a1', 'k', { name: 'Clientele', parentId: 'p' });
    expect(seen[5]?.[1]).toEqual({ accountId: 'j1', update: { k: { name: 'Clientele', parentId: 'p' } } });
    await boxes.destroy('a1', ['n']);
    expect(seen[9]?.[1]).toEqual({ accountId: 'j1', destroy: ['n'], onDestroyRemoveEmails: false });
    expect(boxes.tree('a1')).toMatchObject([{ id: 'p', children: [{ id: 'k', name: 'Clientele' }] }]);
  });

  it('creates "Scheduled" with the role scheduled', async () => {
    const G = box('g', 'Scheduled', { role: 'scheduled' });
    const { client, seen } = server(
      get('s1', [INBOX]),
      () => ['Mailbox/set', { accountId: 'j1', newState: 's2', created: { folder: { id: 'g' } } }],
      ...changed('s1', 's2', [G], []),
    );
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    expect(await boxes.create('a1', 'Scheduled', null, 'scheduled')).toBe('g');
    expect(seen[1]?.[1]).toEqual({
      accountId: 'j1',
      create: { folder: { name: 'Scheduled', parentId: null, isSubscribed: true, role: 'scheduled' } },
    });
    expect(boxes.role('a1', 'scheduled')?.id).toBe('g');
  });

  it('reports rejected changes as FolderError', async () => {
    const { client } = server(
      get('s1', [INBOX, P]),
      () => ['Mailbox/set', { accountId: 'j1', newState: 's1', notCreated: { folder: { type: 'invalidProperties' } } }],
      () => ['Mailbox/set', { accountId: 'j1', newState: 's1', notDestroyed: { p: { type: 'mailboxHasEmail' } } }],
    );
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    await expect(boxes.create('a1', 'Projects', null)).rejects.toBeInstanceOf(FolderError);
    await expect(boxes.destroy('a1', ['p'])).rejects.toThrow('Mailbox/set: mailboxHasEmail');
  });

  it('deletes a folder by the state at sending: emails in blocks to the trash, tags stay, then the levels from the bottom', async () => {
    const block = SESSION.capabilities[CORE].maxObjectsInSet;
    const first = Array.from({ length: block }, (_, i) => `e${i}`);
    // A subfolder only arrives with the sync before deleting.
    const X = box('x', 'New', { parentId: 'w' });
    const { client, seen } = server(
      get('s1', [INBOX, TRASH, P, W]),
      ...changed('s1', 's2', [X], []),
      // One full block, then one with an email that also lies in the inbox.
      () => ['Email/query', { accountId: 'j1', ids: first }],
      () => [
        'Email/get',
        {
          accountId: 'j1',
          state: 'e1',
          notFound: [],
          list: first.map((id) => ({ id, mailboxIds: { p: true, tag: true } })),
        },
      ],
      () => [
        'Email/set',
        { accountId: 'j1', newState: 'e2', updated: Object.fromEntries(first.map((id) => [id, null])) },
      ],
      () => ['Email/query', { accountId: 'j1', ids: ['x1'] }],
      () => [
        'Email/get',
        { accountId: 'j1', state: 'e2', notFound: [], list: [{ id: 'x1', mailboxIds: { x: true, 'm-in': true } }] },
      ],
      () => ['Email/set', { accountId: 'j1', newState: 'e3', updated: { x1: null } }],
      () => ['Mailbox/set', { accountId: 'j1', newState: 's3', destroyed: ['x'] }],
      () => ['Mailbox/set', { accountId: 'j1', newState: 's4', destroyed: ['w'] }],
      () => ['Mailbox/set', { accountId: 'j1', newState: 's5', destroyed: ['p'] }],
      ...changed('s2', 's5', [], [], ['p', 'w', 'x']),
    );
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    await boxes.remove('a1', 'p', 'm-trash', (b) => b === 'tag');
    const sets = seen
      .filter(([name]) => name === 'Email/set')
      .map(([, args]) => args.update as Record<string, unknown>);
    expect(sets[0]?.e0).toEqual({
      'mailboxIds/p': null,
      'mailboxIds/m-trash': true,
    });
    expect(sets[1]).toEqual({ x1: { 'mailboxIds/x': null } });
    expect(seen.find(([name]) => name === 'Email/query')?.[1]).toEqual({
      accountId: 'j1',
      filter: { operator: 'OR', conditions: [{ inMailbox: 'p' }, { inMailbox: 'w' }, { inMailbox: 'x' }] },
      limit: block,
    });
    const destroys = seen.filter(([name]) => name === 'Mailbox/set').map(([, args]) => args.destroy);
    expect(destroys).toEqual([['x'], ['w'], ['p']]);
    expect(boxes.tree('a1')).toEqual([]);
  });

  it('deletes nothing if the branch has a role, no right to delete, or emails without a trash', async () => {
    const ARCHIVE = box('a', 'Archive', { parentId: 'p', role: 'archive' });
    const LOCKED = box('l', 'Shared', { myRights: { ...P.myRights, mayDelete: false } });
    const FULL = box('f', 'Full', { totalEmails: 1 });
    const { client, seen } = server(
      get('s1', [INBOX, P, ARCHIVE, LOCKED, FULL]),
      ...changed('s1', 's1', [], []),
      ...changed('s1', 's1', [], []),
      ...changed('s1', 's1', [], []),
      ...changed('s1', 's1', [], []),
    );
    const boxes = new Mailboxes(() => Promise.resolve(client));
    await boxes.load('a1');
    await expect(boxes.remove('a1', 'p', 'm-in', () => false)).rejects.toBeInstanceOf(FolderError);
    await expect(boxes.remove('a1', 'l', 'm-in', () => false)).rejects.toBeInstanceOf(FolderError);
    await expect(boxes.remove('a1', 'f', null, () => false)).rejects.toThrow('Trash missing');
    // Already deleted elsewhere: nothing to do.
    await boxes.remove('a1', 'gone', null, () => false);
    expect(seen.map(([name]) => name)).not.toContain('Email/query');
    expect(seen.map(([name]) => name)).not.toContain('Mailbox/set');
  });
});

describe('Storage', () => {
  const saved = {
    account: 'k',
    accountId: 'j1',
    state: 'old',
    list: [box('in', 'Inbox', { role: 'inbox' })],
  };

  function store(found: typeof saved | null) {
    return { mailboxes: vi.fn(() => Promise.resolve(found)), saveMailboxes: vi.fn() };
  }

  it('shows the mailboxes from storage and syncs from the stored state', async () => {
    const s = store(saved);
    const { client, seen } = server(
      () => [
        'Mailbox/changes',
        {
          accountId: 'j1',
          oldState: 'old',
          newState: 'new',
          hasMoreChanges: false,
          created: ['new1'],
          updated: [],
          destroyed: [],
        },
      ],
      () => ['Mailbox/get', { accountId: 'j1', state: 'new', list: [box('new1', 'New')], notFound: [] }],
      () => ['Mailbox/get', { accountId: 'j1', state: 'new', list: [], notFound: [] }],
    );
    const boxes = new Mailboxes(
      () => Promise.resolve(client),
      () => s,
    );
    await boxes.ensure('k');
    expect(boxes.of('k')?.status).toBe('ready');
    expect(boxes.list('k').map((b) => b.id)).toEqual(['in']);
    await boxes.sync('k');
    expect(seen[0]?.[0]).toBe('Mailbox/changes');
    expect(seen[0]?.[1]).toMatchObject({ sinceState: 'old' });
    expect(boxes.list('k').map((b) => b.id)).toEqual(['in', 'new1']);
    expect(s.saveMailboxes).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: 'k', accountId: 'j1', state: 'new' }),
    );
  });

  it('stays ready with the stored state without network', async () => {
    const boxes = new Mailboxes(
      () => Promise.reject(new NetworkError(new TypeError('offline'))),
      () => store(saved),
    );
    await boxes.ensure('k');
    await boxes.sync('k').catch(() => {});
    expect(boxes.of('k')).toMatchObject({ status: 'ready', error: null });
    expect(boxes.list('k')).toHaveLength(1);
  });

  it('reloads everything if the server rejects the stored state', async () => {
    const { client } = server(
      () => ['error', { type: 'invalidArguments' }],
      get('new', []),
      get('new', []),
      get('new', [box('a', 'A')]),
    );
    const boxes = new Mailboxes(
      () => Promise.resolve(client),
      () => store(saved),
    );
    await boxes.ensure('k');
    await vi.waitFor(() => expect(boxes.list('k').map((b) => b.id)).toEqual(['a']));
  });

  it('loads from the server without a record and writes', async () => {
    const s = store(null);
    const { client } = server(get('s', [box('a', 'A')]));
    const boxes = new Mailboxes(
      () => Promise.resolve(client),
      () => s,
    );
    await boxes.ensure('k');
    expect(boxes.list('k').map((b) => b.id)).toEqual(['a']);
    expect(s.saveMailboxes).toHaveBeenCalledWith(expect.objectContaining({ state: 's' }));
  });

  it('reads accounts without access only from storage', async () => {
    const reject = vi.fn(() => Promise.reject(new Error('no access')));
    const boxes = new Mailboxes(reject, () => store(saved));
    await boxes.restore('k');
    expect(boxes.of('k')?.status).toBe('ready');
    const none = new Mailboxes(reject, () => store(null));
    await none.restore('k');
    expect(none.of('k')).toMatchObject({ status: 'error', list: [] });
    expect(reject).not.toHaveBeenCalled();
  });
});
