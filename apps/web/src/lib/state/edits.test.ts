import { JmapClient, JmapError, MethodError } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import type { EmailEdit } from '#lib/mail-actions.ts';
import type { ListThread } from '#lib/mail-list.ts';
import type { EditLog, QueuedEdit } from '#lib/mail-queue.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { EditError, EmailEdits, jmapEditApi, lacksAccess, refusedBy, stamp, type EditApi } from './edits.svelte.ts';
import { m } from '#lib/paraglide/messages.js';

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
      maxObjectsInSet: 2,
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

/** Fake mail server: answers every call via `answer` and remembers `keepalive` per request. */
function server(answer: (call: Invocation) => [string, unknown], limits: Record<string, number> = {}) {
  const seen: Invocation[] = [];
  const keepalive: boolean[] = [];
  const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    keepalive.push(init.keepalive ?? false);
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
  const session = {
    ...SESSION,
    capabilities: { ...SESSION.capabilities, [CORE]: { ...SESSION.capabilities[CORE], ...limits } },
  };
  const client = new JmapClient({ url: MAIL, tokens: { token: () => Promise.resolve('t1') }, session, fetch });
  return { api: jmapEditApi(() => Promise.resolve(client)), seen, keepalive };
}

const SET_OK = { accountId: 'j1', oldState: 'm1', newState: 'm2' };

describe('jmapEditApi', () => {
  it('sends changes and deletions as one Email/set, with keepalive on request', async () => {
    const { api, seen, keepalive } = server(() => [
      'Email/set',
      { ...SET_OK, notUpdated: { gone: { type: 'notFound' } } },
    ]);
    const edits = new Map<string, EmailEdit>([
      ['e1', { keywords: { $seen: true }, mailboxIds: { in: false, trash: true } }],
      ['e2', { destroyed: true }],
      ['gone', { keywords: { $seen: true } }],
    ]);
    await api.set('k1', edits, true);
    expect(seen).toEqual([
      [
        'Email/set',
        {
          accountId: 'j1',
          update: {
            e1: { 'keywords/$seen': true, 'mailboxIds/in': null, 'mailboxIds/trash': true },
            gone: { 'keywords/$seen': true },
          },
          destroy: ['e2'],
        },
        'c0',
      ],
    ]);
    expect(keepalive).toEqual([true]);
  });

  it('fails if the server rejects a change', async () => {
    const { api } = server(() => ['Email/set', { ...SET_OK, notDestroyed: { e2: { type: 'forbidden' } } }]);
    const error = await api.set('k1', new Map([['e2', { destroyed: true }]]), false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EditError);
    expect((error as EditError).errors).toEqual([{ type: 'forbidden' }]);
  });

  it('empties a mailbox in blocks by maxObjectsInSet and only removes emails that are in further mailboxes', async () => {
    const blocks = [['a', 'b'], ['c', 'd'], ['e']];
    const boxes: Record<string, Record<string, true>> = {
      a: { trash: true },
      b: { trash: true, tag1: true },
      c: { trash: true, archiv: true },
      d: { trash: true },
      e: { trash: true },
    };
    let i = 0;
    const { api, seen } = server(([name, args]) => {
      if (name === 'Email/query') return ['Email/query', { accountId: 'j1', ids: blocks[i] ?? [], position: 0 }];
      if (name === 'Email/get')
        return ['Email/get', { accountId: 'j1', list: (blocks[i] ?? []).map((id) => ({ id, mailboxIds: boxes[id] })) }];
      i++;
      const update = (args['update'] ?? {}) as Record<string, unknown>;
      return [
        'Email/set',
        {
          ...SET_OK,
          destroyed: args['destroy'],
          updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])),
        },
      ];
    });
    expect(await api.clear('k1', 'trash', (box) => box.startsWith('tag'))).toBe(5);
    expect(seen.filter(([name]) => name === 'Email/query')).toHaveLength(3);
    expect(seen.slice(0, 3)).toEqual([
      ['Email/query', { accountId: 'j1', filter: { inMailbox: 'trash' }, limit: 2 }, 'c0'],
      [
        'Email/get',
        {
          accountId: 'j1',
          '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'mailboxIds'],
        },
        'c1',
      ],
      ['Email/set', { accountId: 'j1', update: {}, destroy: ['a', 'b'] }, 'c2'],
    ]);
    expect(seen[5]).toEqual([
      'Email/set',
      { accountId: 'j1', update: { c: { 'mailboxIds/trash': null } }, destroy: ['d'] },
      'c5',
    ]);
  });

  it('stops emptying when a full block changes nothing or the mailbox is empty', async () => {
    const { api, seen } = server(([name]) =>
      name === 'Email/query'
        ? ['Email/query', { accountId: 'j1', ids: ['a', 'b'], position: 0 }]
        : name === 'Email/get'
          ? ['Email/get', { accountId: 'j1', list: [] }]
          : ['Email/set', { ...SET_OK, notDestroyed: { a: { type: 'notFound' } } }],
    );
    expect(await api.clear('k1', 'trash', () => false)).toBe(0);
    expect(seen.map(([name]) => name)).toEqual(['Email/query', 'Email/get', 'Email/set']);
    const empty = server(([name]) =>
      name === 'Email/query'
        ? ['Email/query', { accountId: 'j1', ids: [], position: 0 }]
        : ['Email/get', { accountId: 'j1', list: [] }],
    );
    expect(await empty.api.clear('k1', 'trash', () => false)).toBe(0);
    expect(empty.seen).toHaveLength(2);
  });
});

function fakeApi() {
  const set = vi.fn<EditApi['set']>(() => Promise.resolve());
  const clear = vi.fn<EditApi['clear']>(() => Promise.resolve(2));
  const replay = vi.fn<EditApi['replay']>(() => Promise.resolve([]));
  return { api: { set, replay, clear } satisfies EditApi, set, replay, clear };
}

const SEEN = new Map<string, EmailEdit>([['e1', { keywords: { $seen: true } }]]);

describe('Accounts without access', () => {
  const stale = { id: 'k1', email: 'a@example.com', host: 'mail.example.com', state: 'needs_reauth', blocked: false };

  afterEach(() => {
    accounts.list = null;
    ui.reset();
  });

  it('runs nothing and reports the account as an error', () => {
    accounts.list = [stale] as MailAccount[];
    const { api, set } = fakeApi();
    const out = new EmailEdits(api);
    expect(out.run({ account: 'k1', edits: SEEN })).toBe(false);
    expect(out.edit('k1', 'e1', 0)).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'Sign in to a@example.com again first', error: true });
  });

  it('lets quiet actions fail without a toast', () => {
    accounts.list = [stale] as MailAccount[];
    const { api, set } = fakeApi();
    expect(new EmailEdits(api).run({ account: 'k1', edits: SEEN, quiet: true })).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(ui.toast).toBeNull();
  });

  it('names the host for a blocked server', () => {
    accounts.list = [{ ...stale, state: 'ok', blocked: true }] as MailAccount[];
    expect(refusedBy(['k1'])).toBe(true);
    expect(ui.toast?.text).toBe('mail.example.com is no longer an approved server.');
  });

  it('lets accounts with access through', () => {
    accounts.list = [{ ...stale, state: 'ok' }] as MailAccount[];
    expect(refusedBy(['k1', 'unknown'])).toBe(false);
    expect(lacksAccess('k1')).toBe(false);
    accounts.list = [stale] as MailAccount[];
    expect(lacksAccess('k1')).toBe(true);
  });
});

describe('EmailEdits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    ui.reset();
    vi.useRealTimers();
  });

  it('lays an action with undo over immediately and sends it after the toast', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    const before = stamp();
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    expect(e.edit('k1', 'e1', before)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k2', 'e1', before)).toBeUndefined();
    expect(e.pending('k1', before)).toBe(true);
    expect(ui.toast).toMatchObject({ text: 'Marked as read', undo: true });
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).toHaveBeenCalledExactlyOnceWith('k1', SEEN, false);
    // Data loaded before keeps the change, data loaded afterwards shows the server.
    expect(e.edit('k1', 'e1', before)).toEqual({ keywords: { $seen: true } });
    const after = stamp();
    expect(e.edit('k1', 'e1', after)).toBeUndefined();
    expect(e.pending('k1', after)).toBe(false);
  });

  it('reverts the change with "undo" without sending', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    ui.toasts.undo();
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).not.toHaveBeenCalled();
  });

  it('reverts a failed action and reports it', async () => {
    const { api, set } = fakeApi();
    set.mockRejectedValue(new Error('500'));
    const e = new EmailEdits(api);
    e.run({ account: 'k1', edits: SEEN, text: 'Moved to Trash' });
    // Default `gUndo` 5 s; the error toast stays 3.2 s afterwards.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({
      text: m.error_undo(),
      error: true,
    });
  });

  it('sends immediately without text; read on opening fails silently', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    e.run({ account: 'k1', edits: SEEN });
    await vi.waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith('k1', SEEN, false));
    expect(ui.toast).toBeNull();

    set.mockRejectedValue(new Error('500'));
    e.run({ account: 'k1', edits: new Map([['e2', { keywords: { $seen: true } }]]), quiet: true });
    await vi.waitFor(() => expect(e.edit('k1', 'e2', 0)).toBeUndefined());
    expect(ui.toast).toBeNull();

    e.run({ account: 'k1', edits: new Map([['e3', { keywords: { $flagged: true } }]]) });
    await vi.waitFor(() => expect(ui.toast?.text).toBe(m.error_act()));
    expect(e.edit('k1', 'e3', 0)).toBeUndefined();
  });

  it('merges consecutive actions on the same email', () => {
    const e = new EmailEdits(fakeApi().api);
    e.run({ account: 'k1', edits: SEEN });
    e.run({ account: 'k1', edits: new Map([['e1', { keywords: { $seen: false } }]]), text: 'Marked as unread' });
    expect(e.edit('k1', 'e1', 0)).toEqual({ keywords: { $seen: false }, mailboxIds: {} });
  });

  it('deletes permanently right away with a toast and brings back on an error', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    const gone = new Map<string, EmailEdit>([['e1', { destroyed: true }]]);
    e.purge('k1', gone, 'Message deleted');
    expect(ui.toast).toMatchObject({ text: 'Message deleted', undo: false });
    await vi.waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith('k1', gone, false));
    expect(e.apply('k1', { id: 'e1', mailboxIds: ['trash'], keywords: {} }, 0)).toBeNull();

    set.mockRejectedValue(new Error('500'));
    e.purge('k1', new Map([['e2', { destroyed: true }]]), 'Message deleted');
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
  });

  it('hides the loaded ones when emptying and returns them on an error', async () => {
    const { api, clear } = fakeApi();
    const e = new EmailEdits(api);
    const shown = new Map<string, EmailEdit>([['e1', { destroyed: true }]]);
    const keep = () => false;
    await e.clear('k1', 'trash', shown, keep);
    expect(clear).toHaveBeenCalledExactlyOnceWith('k1', 'trash', keep);
    expect(e.edit('k1', 'e1', 0)).toEqual({ destroyed: true });

    clear.mockRejectedValue(new Error('500'));
    await expect(e.clear('k1', 'trash', new Map([['e2', { destroyed: true }]]), keep)).rejects.toThrow('500');
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
    e.reset();
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
  });

  it('empties only once an email just moved to the trash has arrived there', async () => {
    const { api, set, clear } = fakeApi();
    let arrived!: () => void;
    set.mockImplementationOnce(() => new Promise<void>((resolve) => (arrived = resolve)));
    const e = new EmailEdits(api);
    const moved = new Map<string, EmailEdit>([['e1', { mailboxIds: { inbox: false, trash: true } }]]);
    e.run({ account: 'k1', edits: moved, text: 'Moved to Trash' });
    // Like "Empty Trash": first the toast (sends the action), then the emptying.
    ui.toasts.show('2 messages deleted');
    const cleared = e.clear('k1', 'trash', new Map([['e1', { destroyed: true }]]), () => false);
    await vi.waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith('k1', moved, false));
    await vi.advanceTimersByTimeAsync(100);
    expect(clear).not.toHaveBeenCalled();
    arrived();
    await cleared;
    expect(clear).toHaveBeenCalledOnce();
  });

  it('reverts only the rejected emails on a partial rejection and reports it', async () => {
    const { api, set } = fakeApi();
    set.mockRejectedValue(new EditError([['e2', { type: 'forbidden' }]]));
    const e = new EmailEdits(api);
    e.run({
      account: 'k1',
      edits: new Map([
        ['e1', { mailboxIds: { in: false, trash: true } }],
        ['e2', { mailboxIds: { in: false, trash: true } }],
      ]),
      text: 'Moved to Trash',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(e.edit('k1', 'e1', 0)).toEqual({ mailboxIds: { in: false, trash: true } });
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: m.error_undo() });
  });

  it('sends a pending action with the same emails before an immediate one', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    const unread = new Map([['e1', { keywords: { $seen: false } }]]);
    e.run({ account: 'k1', edits: unread, text: 'Marked as unread' });
    e.run({ account: 'k1', edits: new Map([['e9', { keywords: { $seen: true } }]]) });
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(ui.toast?.undo).toBe(true);
    e.run({ account: 'k1', edits: SEEN });
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(3));
    expect(set.mock.calls.map(([, edits]) => [...edits.keys()])).toEqual([['e9'], ['e1'], ['e1']]);
    expect(set.mock.calls[1]?.[1]).toBe(unread);
  });

  it('knows with `until` only what was confirmed before a stamp', async () => {
    const { api } = fakeApi();
    const e = new EmailEdits(api);
    const before = stamp();
    e.run({ account: 'k1', edits: SEEN });
    await vi.waitFor(() => expect(e.edit('k1', 'e1', stamp())).toBeUndefined());
    const later = stamp();
    expect(e.edit('k1', 'e1', before, later)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k1', 'e1', before, before + 1)).toBeUndefined();
  });

  it('runs an action across several accounts with one toast and reverts it together', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    const onRevert = vi.fn();
    const other = new Map<string, EmailEdit>([['e9', { keywords: { $seen: true } }]]);
    expect(e.runAll([{ account: 'k1', edits: new Map() }])).toBe(false);
    e.runAll(
      [
        { account: 'k1', edits: SEEN },
        { account: 'k2', edits: other },
      ],
      { text: '2 messages moved to Trash', onRevert },
    );
    expect(e.edit('k1', 'e1', 0)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k2', 'e9', 0)).toEqual({ keywords: { $seen: true } });
    ui.toasts.undo();
    expect(onRevert).toHaveBeenCalledOnce();
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(e.edit('k2', 'e9', 0)).toBeUndefined();

    e.runAll(
      [
        { account: 'k1', edits: SEEN },
        { account: 'k2', edits: other },
      ],
      { text: '2 messages moved to Trash' },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).toHaveBeenCalledWith('k1', SEEN, false);
    expect(set).toHaveBeenCalledWith('k2', other, false);
  });

  it('reverts only the failed account with several accounts and reports it', async () => {
    const { api, set } = fakeApi();
    set.mockImplementation((account) => (account === 'k2' ? Promise.reject(new Error('500')) : Promise.resolve()));
    const e = new EmailEdits(api);
    const onRevert = vi.fn();
    const other = new Map<string, EmailEdit>([['e9', { destroyed: true }]]);
    const parts = [
      { account: 'k1', edits: SEEN },
      { account: 'k2', edits: other },
    ];
    e.runAll(parts, { text: '2 messages restored', onRevert });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRevert).not.toHaveBeenCalled();
    expect(e.edit('k1', 'e1', 0)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k2', 'e9', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ error: true });

    // Delete permanently: the same, without undo.
    ui.reset();
    e.purgeAll(parts, '2 messages deleted');
    expect(ui.toast).toMatchObject({ text: '2 messages deleted', undo: false });
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(e.apply('k1', { id: 'e1', mailboxIds: ['in'], keywords: {} }, 0)?.keywords).toEqual({ $seen: true });
    expect(e.edit('k2', 'e9', 0)).toBeUndefined();

    // If all fail, everything drops out as with one account.
    set.mockRejectedValue(new Error('500'));
    e.runAll(parts, { text: '2 messages restored', onRevert });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRevert).toHaveBeenCalledOnce();
    expect(e.edit('k1', 'e1', stamp())).toBeUndefined();
  });

  it('takes the changes of own sending (`send`) and reports errors with `failed`', async () => {
    const { api, set } = fakeApi();
    const e = new EmailEdits(api);
    const before = stamp();
    const sent = new Map<string, EmailEdit>([['e1', { mailboxIds: { sent: true } }]]);
    e.runAll([{ account: 'k1', edits: SEEN, send: () => Promise.resolve(sent) }], { text: 'Trash' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).not.toHaveBeenCalled();
    expect(e.edit('k1', 'e1', before)).toEqual({ mailboxIds: { sent: true } });

    e.runAll([{ account: 'k1', edits: SEEN, send: () => Promise.reject(new Error('500')) }], {
      text: 'Trash',
      failed: 'Custom error',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ui.toast).toMatchObject({ text: 'Custom error', error: true });
  });

  it('shows the changes with `hold()` while it runs and discards them if it fails', async () => {
    const e = new EmailEdits(fakeApi().api);
    const before = stamp();
    let finish!: () => void;
    const running = e.hold(
      'k1',
      SEEN,
      () => new Promise<{ kept: typeof SEEN }>((r) => (finish = () => r({ kept: new Map() }))),
    );
    expect(e.edit('k1', 'e1', before)).toEqual({ keywords: { $seen: true } });
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await running;
    expect(e.edit('k1', 'e1', before)).toBeUndefined();
    await expect(e.hold('k1', SEEN, () => Promise.reject(new Error('500')))).rejects.toThrow('500');
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
  });
});

describe('jmapEditApi.replay', () => {
  const MOVE: EmailEdit = { mailboxIds: { in: false, trash: true } };
  const FLAG: EmailEdit = { keywords: { $flagged: true } };

  /** Mail server that reports `boxes` as `mailboxIds` and rejects `notUpdated`. */
  function mailbox(
    boxes: Record<string, Record<string, true>>,
    notUpdated: Record<string, { type: string }> = {},
    limits: Record<string, number> = { maxObjectsInSet: 100 },
  ) {
    return server(([name, args]) => {
      if (name === 'Email/set') {
        const ids = Object.keys(args['update'] as object);
        return [
          'Email/set',
          { ...SET_OK, notUpdated: Object.fromEntries(Object.entries(notUpdated).filter(([id]) => ids.includes(id))) },
        ];
      }
      const ids = args['ids'] as string[];
      return [
        'Email/get',
        {
          accountId: 'j1',
          state: 's',
          list: ids.flatMap((id) => (boxes[id] ? [{ id, mailboxIds: boxes[id] }] : [])),
          notFound: ids.filter((id) => !boxes[id]),
        },
      ];
    }, limits);
  }

  const patched = (seen: Invocation[]) =>
    seen.filter(([name]) => name === 'Email/set').map(([, args]) => Object.keys(args['update'] as object));

  it('still sends the keywords of an email moved elsewhere; it counts as lost anyway', async () => {
    const { api, seen } = mailbox({ e1: { archiv: true } });
    const lost = await api.replay('k1', new Map([['e1', { ...MOVE, keywords: { $seen: true } }]]));
    expect(lost).toEqual(['e1']);
    expect(seen.find(([name]) => name === 'Email/set')?.[1]['update']).toEqual({ e1: { 'keywords/$seen': true } });
  });

  it('names an email only once if the server then also rejects its keywords', async () => {
    const { api } = mailbox({ e1: { archiv: true } }, { e1: { type: 'forbidden' } });
    const lost = await api.replay('k1', new Map([['e1', { ...MOVE, keywords: { $seen: true } }]]));
    expect(lost).toEqual(['e1']);
  });

  it('comes to an end with a limit of 0', async () => {
    const { api } = mailbox({}, {}, { maxObjectsInSet: 0 });
    const lost = await api.replay(
      'k1',
      new Map([
        ['e1', FLAG],
        ['e2', FLAG],
      ]),
    );
    expect(lost).toEqual([]);
  });

  it('replays keywords and tags without `Email/get`', async () => {
    const { api, seen, keepalive } = mailbox({});
    const lost = await api.replay(
      'k1',
      new Map<string, EmailEdit>([
        ['e1', FLAG],
        ['e2', { mailboxIds: { tag1: true } }],
      ]),
    );
    expect(lost).toEqual([]);
    expect(seen).toEqual([
      [
        'Email/set',
        {
          accountId: 'j1',
          update: { e1: { 'keywords/$flagged': true }, e2: { 'mailboxIds/tag1': true } },
        },
        'c0',
      ],
    ]);
    expect(keepalive).toEqual([false]);
  });

  it('reads `mailboxIds` before a move, only for the moved emails', async () => {
    const { api, seen } = mailbox({ e1: { in: true } });
    const lost = await api.replay(
      'k1',
      new Map<string, EmailEdit>([
        ['e1', MOVE],
        ['e2', FLAG],
      ]),
    );
    expect(lost).toEqual([]);
    expect(seen.map(([name]) => name)).toEqual(['Email/get', 'Email/set']);
    expect(seen[0]?.[1]).toEqual({ accountId: 'j1', ids: ['e1'], properties: ['id', 'mailboxIds'] });
    expect(seen[1]?.[1]['update']).toEqual({
      e1: { 'mailboxIds/in': null, 'mailboxIds/trash': true },
      e2: { 'keywords/$flagged': true },
    });
  });

  it('skips an email moved elsewhere, the others go through', async () => {
    const { api, seen } = mailbox({ e1: { archiv: true }, e2: { in: true } });
    const lost = await api.replay(
      'k1',
      new Map<string, EmailEdit>([
        ['e1', MOVE],
        ['e2', MOVE],
      ]),
    );
    expect(lost).toEqual(['e1']);
    expect(seen[1]?.[1]['update']).toEqual({ e2: { 'mailboxIds/in': null, 'mailboxIds/trash': true } });
  });

  it('counts an email that `Email/get` does not know as lost', async () => {
    const { api, seen } = mailbox({ e2: { in: true } });
    const lost = await api.replay(
      'k1',
      new Map<string, EmailEdit>([
        ['e1', MOVE],
        ['e2', MOVE],
        ['e3', FLAG],
      ]),
    );
    expect(lost).toEqual(['e1']);
    expect(patched(seen)).toEqual([['e2', 'e3']]);
  });

  it('counts `notUpdated` of any kind as lost, also `notFound`', async () => {
    const { api } = mailbox({}, { e1: { type: 'notFound' }, e2: { type: 'forbidden' }, e3: { type: 'overQuota' } });
    const edits = new Map<string, EmailEdit>([
      ['e1', FLAG],
      ['e2', FLAG],
      ['e3', FLAG],
      ['e4', FLAG],
    ]);
    expect(await api.replay('k1', edits)).toEqual(['e1', 'e2', 'e3']);
  });

  it('names discarded and rejected ones together', async () => {
    const { api } = mailbox({ e1: { archiv: true } }, { e2: { type: 'notFound' } });
    const edits = new Map<string, EmailEdit>([
      ['e1', MOVE],
      ['e2', FLAG],
    ]);
    expect(await api.replay('k1', edits)).toEqual(['e1', 'e2']);
  });

  it('sends no `Email/set` if all are discarded', async () => {
    const { api, seen } = mailbox({ e1: { archiv: true } });
    const edits = new Map<string, EmailEdit>([
      ['e1', MOVE],
      ['e2', MOVE],
    ]);
    expect(await api.replay('k1', edits)).toEqual(['e1', 'e2']);
    expect(seen.map(([name]) => name)).toEqual(['Email/get']);
  });

  it('lets the patch through if the email already lies at the target', async () => {
    const { api, seen } = mailbox({ e1: { trash: true } });
    expect(await api.replay('k1', new Map([['e1', MOVE]]))).toEqual([]);
    expect(seen.map(([name]) => name)).toEqual(['Email/get', 'Email/set']);
  });

  it('names the emails of a block the server rejects with a method error', async () => {
    const { api } = server(() => ['error', { type: 'accountNotFound' }]);
    await expect(api.replay('k1', new Map([['e1', FLAG]]))).resolves.toEqual(['e1']);
  });

  it('passes a method error on to the queue if a retry may help', async () => {
    const { api } = server(() => ['error', { type: 'serverUnavailable' }]);
    await expect(api.replay('k1', new Map([['e1', FLAG]]))).rejects.toBeInstanceOf(MethodError);
  });

  it('splits into blocks by `maxObjectsInSet` and collects `lost` of all blocks', async () => {
    const { api, seen } = mailbox(
      { e1: { archiv: true }, e4: { in: true } },
      { e2: { type: 'notFound' }, e5: { type: 'forbidden' } },
      { maxObjectsInSet: 2 },
    );
    const lost = await api.replay(
      'k1',
      new Map<string, EmailEdit>([
        ['e1', MOVE],
        ['e2', FLAG],
        ['e3', FLAG],
        ['e4', MOVE],
        ['e5', FLAG],
      ]),
    );
    expect(lost).toEqual(['e1', 'e2', 'e5']);
    expect(seen.map(([name]) => name)).toEqual(['Email/get', 'Email/set', 'Email/get', 'Email/set', 'Email/set']);
    expect(patched(seen)).toEqual([['e2'], ['e3', 'e4'], ['e5']]);
  });

  it('also sizes the blocks by `maxObjectsInGet`', async () => {
    const { api, seen } = mailbox({ e1: { in: true }, e2: { in: true } }, {}, { maxObjectsInGet: 1 });
    const edits = new Map<string, EmailEdit>([
      ['e1', MOVE],
      ['e2', MOVE],
    ]);
    expect(await api.replay('k1', edits)).toEqual([]);
    expect(seen.filter(([name]) => name === 'Email/get').map(([, args]) => args['ids'])).toEqual([['e1'], ['e2']]);
    expect(patched(seen)).toEqual([['e1'], ['e2']]);
  });

  it('sends at most 500 emails in one block', async () => {
    const { api, seen } = mailbox({}, {}, { maxObjectsInSet: 1000, maxObjectsInGet: 1000 });
    const edits = new Map<string, EmailEdit>(Array.from({ length: 501 }, (_, i) => [`e${i}`, FLAG]));
    expect(await api.replay('k1', edits)).toEqual([]);
    expect(patched(seen).map((ids) => ids.length)).toEqual([500, 1]);
  });

  it('throws on a transient error in a later block: the next run repeats all', async () => {
    let calls = 0;
    const { api } = server(
      () => {
        calls++;
        return calls === 1 ? ['Email/set', SET_OK] : ['error', { type: 'serverUnavailable' }];
      },
      { maxObjectsInSet: 1 },
    );
    const edits = new Map<string, EmailEdit>([
      ['e1', FLAG],
      ['e2', FLAG],
    ]);
    await expect(api.replay('k1', edits)).rejects.toBeInstanceOf(MethodError);
  });

  // Bug: a method error in the second block throws out of `replay`, `refused()` then reports all emails of the change
  // as lost although the first block has arrived; they drop out of `edits` and count in "Not synced".
  // Expected: the taken-over ones apply, only the rejected block is lost.
  it('names only the emails of a rejected later block as lost', async () => {
    let calls = 0;
    const { api } = server(
      () => {
        calls++;
        return calls === 1 ? ['Email/set', SET_OK] : ['error', { type: 'invalidArguments' }];
      },
      { maxObjectsInSet: 1 },
    );
    const edits = new Map<string, EmailEdit>([
      ['e1', FLAG],
      ['e2', FLAG],
    ]);
    expect(await api.replay('k1', edits)).toEqual(['e2']);
  });
});

/** Queue in memory, shared by instances like the database by tabs. */
function memoryLog() {
  const rows = new Map<string, QueuedEdit>();
  const log: EditLog = {
    all: () => Promise.resolve([...rows.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1))),
    add: (item) => {
      rows.set(item.key, item);
      return Promise.resolve(true);
    },
    remove: (key) => {
      rows.delete(key);
      return Promise.resolve();
    },
    drafts: () => Promise.resolve([]),
    putDraft: () => Promise.resolve(true),
    removeDraft: () => Promise.resolve(),
    retain: () => Promise.resolve(),
  };
  return { log: () => log, rows };
}

describe('Queue', () => {
  const FLAGGED = new Map<string, EmailEdit>([['e2', { keywords: { $flagged: true } }]]);
  const GONE = new Map<string, EmailEdit>([['e1', { destroyed: true }]]);
  const OFFLINE_TOAST = 'No connection. Please try again.';
  const stale = { id: 'k1', email: 'a@example.com', host: 'mail.example.com', state: 'needs_reauth', blocked: false };

  const offline = () => new NetworkError(new Error('gone'));
  const tick = () => vi.advanceTimersByTimeAsync(0);

  function setup() {
    const fake = fakeApi();
    const memory = memoryLog();
    return { ...fake, ...memory, e: new EmailEdits(fake.api, memory.log) };
  }

  it('does not take away a running undo with the toast after the replay', async () => {
    const { e, set } = await waiting();
    e.run({ account: 'k2', edits: FLAGGED, text: 'Flagged' });
    await e.queue.replay();
    expect(e.queue.count).toBe(0);
    expect(ui.toast).toMatchObject({ text: 'Flagged' });
    expect(set).toHaveBeenCalledOnce();
    ui.toasts.undo();
  });

  /** An action without a response: afterwards SEEN waits for `k1`. */
  async function waiting() {
    const out = setup();
    out.set.mockRejectedValue(offline());
    out.e.run({ account: 'k1', edits: SEEN });
    await tick();
    expect(out.e.queue.count).toBe(1);
    return out;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    ui.reset();
    accounts.list = null;
    network.online = true;
    vi.useRealTimers();
  });

  it.each([
    ['visible', false],
    ['quiet', true],
  ])('keeps an action without a response laid over and without a toast (%s)', async (_name, quiet) => {
    const { e, set, rows } = setup();
    set.mockRejectedValue(offline());
    expect(e.run({ account: 'k1', edits: SEEN, quiet })).toBe(true);
    await tick();
    expect(e.edit('k1', 'e1', stamp())).toEqual({ keywords: { $seen: true } });
    expect(ui.toast).toBeNull();
    expect(e.queue.count).toBe(1);
    expect(e.queue.items[0]).toMatchObject({ account: 'k1', edits: [['e1', { keywords: { $seen: true } }]], quiet });
    expect(rows.size).toBe(1);
    expect(e.queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
  });

  it.each([
    ['unreachable', new JmapError('unreachable')],
    ['502', new JmapError('status', { status: 502 })],
    ['503', new JmapError('status', { status: 503 })],
    ['504', new JmapError('status', { status: 504 })],
  ])('counts %s as a missing response', async (_name, error) => {
    const { e, set } = setup();
    set.mockRejectedValue(error);
    e.run({ account: 'k1', edits: SEEN });
    await tick();
    expect(e.queue.count).toBe(1);
    expect(ui.toast).toBeNull();
  });

  it('records an action with undo after the toast expires, without reverting', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    const onRevert = vi.fn();
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read', onRevert });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(e.queue.count).toBe(1);
    expect(onRevert).not.toHaveBeenCalled();
    expect(ui.toast).toBeNull();
    expect(e.edit('k1', 'e1', stamp())).toEqual({ keywords: { $seen: true } });
  });

  it('orders the entry by the time of the action, not by the expiry of the toast', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    const at = Date.now();
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(e.queue.items[0]?.key.startsWith(String(at).padStart(16, '0'))).toBe(true);
  });

  it('queues only the account that does not answer; `runAll()` reports nothing', async () => {
    const { e, set } = setup();
    set.mockImplementation((account) => (account === 'k1' ? Promise.reject(offline()) : Promise.resolve()));
    const onRevert = vi.fn();
    e.runAll(
      [
        { account: 'k1', edits: SEEN },
        { account: 'k2', edits: FLAGGED },
      ],
      { text: '2 messages marked', onRevert },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(e.queue.items.map((i) => i.account)).toEqual(['k1']);
    expect(e.edit('k1', 'e1', stamp())).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k2', 'e2', stamp())).toBeUndefined();
    expect(onRevert).not.toHaveBeenCalled();
    expect(ui.toast).toBeNull();
  });

  it('queues both accounts if neither answers', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.runAll([
      { account: 'k1', edits: SEEN },
      { account: 'k2', edits: FLAGGED },
    ]);
    await tick();
    expect(e.queue.count).toBe(2);
    expect(ui.toast).toBeNull();
  });

  it.each([
    ['500', new JmapError('status', { status: 500 })],
    ['403', new JmapError('forbidden', { status: 403 })],
    ['a method error', new MethodError('Email/set', 'c0', { type: 'serverUnavailable' })],
    ['a rejection', new EditError([['e1', { type: 'forbidden' }]])],
  ])('reverts on %s as before and reports it', async (_name, error) => {
    const { e, set } = setup();
    set.mockRejectedValue(error);
    e.run({ account: 'k1', edits: SEEN });
    await tick();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });

  it('queues the next action instead of overtaking, and keeps the order', async () => {
    const { e, set, replay } = await waiting();
    replay.mockRejectedValue(offline());
    set.mockClear();
    e.run({ account: 'k1', edits: FLAGGED });
    await tick();
    expect(set).not.toHaveBeenCalled();
    expect(e.queue.items.map((i) => i.edits[0]?.[0])).toEqual(['e1', 'e2']);
    // The trigger is the entry itself; both go out together and both stay without a response.
    expect(replay).toHaveBeenCalledOnce();
    expect([...(replay.mock.calls[0]?.[1].keys() ?? [])]).toEqual(['e1', 'e2']);
    expect(e.queue.count).toBe(2);
    expect(ui.toast).toBeNull();
  });

  it('replays the queued action along with it when the server answers again', async () => {
    const { e, set, replay } = await waiting();
    set.mockClear();
    e.run({ account: 'k1', edits: FLAGGED });
    await tick();
    expect(set).not.toHaveBeenCalled();
    expect(replay.mock.calls.map(([, edits]) => [...edits.keys()])).toEqual([['e1', 'e2']]);
    expect(e.queue.count).toBe(0);
    expect(ui.toast).toMatchObject({ text: '2 changes synced', error: false });
  });

  it('lets another account send', async () => {
    const { e, set } = await waiting();
    set.mockClear();
    set.mockResolvedValue();
    e.run({ account: 'k2', edits: FLAGGED });
    await tick();
    expect(set).toHaveBeenCalledExactlyOnceWith('k2', FLAGGED, false);
    expect(e.queue.count).toBe(1);
  });

  it('queues a pending action with the same email before an immediate one', async () => {
    const { e, set, replay } = setup();
    set.mockRejectedValue(offline());
    replay.mockRejectedValue(offline());
    const unread = new Map<string, EmailEdit>([['e1', { keywords: { $seen: false } }]]);
    const flag = new Map<string, EmailEdit>([['e1', { keywords: { $flagged: true } }]]);
    e.run({ account: 'k1', edits: unread, text: 'Marked as unread' });
    e.run({ account: 'k1', edits: flag });
    await tick();
    expect(set).toHaveBeenCalledExactlyOnceWith('k1', unread, false);
    expect(e.queue.items.map((i) => i.edits[0]?.[1])).toEqual([
      { keywords: { $seen: false } },
      { keywords: { $flagged: true } },
    ]);
    expect(e.queue.count).toBe(1);
  });

  it('cancels there and back: nothing goes out, and the actions are done', async () => {
    const { e, set, replay, rows } = await waiting();
    set.mockClear();
    e.run({ account: 'k1', edits: new Map([['e1', { keywords: { $seen: false } }]]) });
    await tick();
    expect(set).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(e.queue.count).toBe(0);
    expect(e.queue.items).toEqual([]);
    expect(rows.size).toBe(0);
    expect(e.edit('k1', 'e1', stamp())).toBeUndefined();
    expect(ui.toast).toBeNull();
  });

  it('does not let `destroyed` in: it fails with a toast', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.run({ account: 'k1', edits: GONE });
    await tick();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('does not let in an action of which only a part deletes either', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.run({
      account: 'k1',
      edits: new Map<string, EmailEdit>([
        ['e1', { destroyed: true }],
        ['e2', { keywords: { $seen: true } }],
      ]),
    });
    await tick();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('tries `destroyed` itself even if something is waiting', async () => {
    const { e, set } = await waiting();
    set.mockClear();
    e.run({ account: 'k1', edits: new Map([['e9', { destroyed: true }]]) });
    await tick();
    expect(set).toHaveBeenCalledOnce();
    expect(e.queue.count).toBe(1);
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('does not let `send` in: it fails with a toast', async () => {
    const { e, set } = setup();
    e.runAll([{ account: 'k1', edits: SEEN, send: () => Promise.reject(offline()) }], {
      text: 'Trash',
      failed: 'Custom error',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(set).not.toHaveBeenCalled();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('lets `send` send itself even if something is waiting', async () => {
    const { e } = await waiting();
    const send = vi.fn(() => Promise.resolve(new Map<string, EmailEdit>()));
    e.runAll([{ account: 'k1', edits: FLAGGED, send }]);
    await tick();
    expect(send).toHaveBeenCalledOnce();
    expect(e.queue.count).toBe(1);
  });

  it('does not let `purge` in: the email returns with a toast', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.purge('k1', GONE, 'Message deleted');
    await tick();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('does not let in `purge` without `destroyed` either: `purgeEdits()` only takes some out of the trash', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.purge('k1', new Map([['e1', { mailboxIds: { trash: false } }]]), 'Message deleted');
    await tick();
    expect(e.queue.count).toBe(0);
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('does not let `online` in, not even if something is waiting', async () => {
    const { e, set } = await waiting();
    set.mockClear();
    e.runAll([{ account: 'k1', edits: FLAGGED, online: true }]);
    await tick();
    expect(set).toHaveBeenCalledExactlyOnceWith('k1', FLAGGED, false);
    expect(e.queue.count).toBe(1);
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
  });

  it('does not let "Empty Trash" and `hold()` in: the error goes to the caller', async () => {
    const { e, clear } = setup();
    clear.mockRejectedValue(offline());
    await expect(e.clear('k1', 'trash', GONE, () => false)).rejects.toBeInstanceOf(NetworkError);
    await expect(e.hold('k1', SEEN, () => Promise.reject(offline()))).rejects.toBeInstanceOf(NetworkError);
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
  });

  it('leaves nothing in the queue after undo before expiry', async () => {
    const { e, set, rows } = setup();
    set.mockRejectedValue(offline());
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    ui.toasts.undo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).not.toHaveBeenCalled();
    expect(e.queue.count).toBe(0);
    expect(rows.size).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
  });

  it('also reverts with undo an action that would queue up', async () => {
    const { e, replay } = await waiting();
    replay.mockRejectedValue(offline());
    e.run({ account: 'k1', edits: FLAGGED, text: 'Flagged' });
    ui.toasts.undo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.queue.count).toBe(1);
    expect(e.edit('k1', 'e2', 0)).toBeUndefined();
  });

  it('does not try `Email/set` offline when the page closes; the entry lies in the database', async () => {
    const { e, set, rows, replay } = setup();
    replay.mockRejectedValue(offline());
    network.online = false;
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    await ui.toasts.flush(true);
    await tick();
    expect(set).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
    expect(e.queue.count).toBe(1);
    expect(ui.toast).toBeNull();
  });

  it('also starts no replay offline when the page closes: nobody would see the result', async () => {
    const { e, replay } = setup();
    replay.mockRejectedValue(offline());
    network.online = false;
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    await ui.toasts.flush(true);
    await tick();
    expect(replay).not.toHaveBeenCalled();
  });

  it('tries with `keepalive` online when the page closes', async () => {
    const { e, set } = setup();
    e.run({ account: 'k1', edits: SEEN, text: 'Marked as read' });
    await ui.toasts.flush(true);
    expect(set).toHaveBeenCalledExactlyOnceWith('k1', SEEN, true);
    expect(e.queue.count).toBe(0);
  });

  it('tries even if the browser reports offline: the failure decides', async () => {
    const { e, set } = setup();
    network.online = false;
    e.run({ account: 'k1', edits: SEEN });
    await tick();
    expect(set).toHaveBeenCalledExactlyOnceWith('k1', SEEN, false);
    expect(e.queue.count).toBe(0);
  });

  it('confirms the change after the replay and reports it', async () => {
    const before = stamp();
    const { e, replay } = await waiting();
    await e.queue.replay();
    expect(replay).toHaveBeenCalledExactlyOnceWith('k1', SEEN);
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', before)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k1', 'e1', stamp())).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: '1 change synced', error: false });
  });

  it('drops lost emails from `edit()`, the others apply', async () => {
    const { e, set, replay } = setup();
    set.mockRejectedValue(offline());
    replay.mockResolvedValue(['e2']);
    const before = stamp();
    e.describe((_account, id) => `Subject ${id}`);
    e.run({
      account: 'k1',
      edits: new Map<string, EmailEdit>([
        ['e1', { keywords: { $seen: true } }],
        ['e2', { keywords: { $seen: true } }],
      ]),
    });
    await tick();
    await e.queue.replay();
    expect(e.edit('k1', 'e1', before)).toEqual({ keywords: { $seen: true } });
    expect(e.edit('k1', 'e2', before)).toBeUndefined();
    expect(e.edit('k1', 'e1', stamp())).toBeUndefined();
    expect(e.queue.lost).toEqual({ count: 1, subject: 'Subject e2' });
    expect(ui.toast).toMatchObject({ text: '1 change synced', error: false });
  });

  it('removes the action entirely if all emails are lost', async () => {
    const { e, replay } = await waiting();
    replay.mockResolvedValue(['e1']);
    await e.queue.replay();
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(e.pending('k1', 0)).toBe(false);
    expect(e.queue.lost?.count).toBe(1);
  });

  it('`restore()` of a new instance lays entries over again until the replay is through', async () => {
    const { log, replay: oldReplay } = await waiting();
    const fresh = fakeApi();
    const reloaded = new EmailEdits(fresh.api, log);
    expect(reloaded.edit('k1', 'e1', 0)).toBeUndefined();
    await reloaded.restore();
    expect(reloaded.queue.count).toBe(1);
    expect(reloaded.edit('k1', 'e1', stamp())).toEqual({ keywords: { $seen: true } });
    expect(reloaded.queue.stuck).toEqual([]);
    expect(oldReplay).not.toHaveBeenCalled();

    // Laying over twice must not count twice.
    await reloaded.restore();
    expect(reloaded.queue.count).toBe(1);

    await reloaded.queue.replay();
    expect(fresh.replay).toHaveBeenCalledExactlyOnceWith('k1', SEEN);
    expect(reloaded.edit('k1', 'e1', stamp())).toBeUndefined();
  });

  it('counts as confirmed if another tab has transferred the entry', async () => {
    const { e, rows } = await waiting();
    rows.clear();
    await e.restore();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', stamp())).toBeUndefined();
    expect(e.edit('k1', 'e1', 0)).toEqual({ keywords: { $seen: true } });
  });

  it('`retry()` reports `ERR offline` if it fails again', async () => {
    const { e, replay } = await waiting();
    replay.mockRejectedValue(offline());
    await e.retry();
    expect(replay).toHaveBeenCalledOnce();
    expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST, error: true });
    expect(e.queue.count).toBe(1);
  });

  it("`retry()` reports success via the queue's toast", async () => {
    const { e } = await waiting();
    await e.retry();
    expect(e.queue.count).toBe(0);
    expect(ui.toast).toMatchObject({ text: '1 change synced', error: false });
  });

  it('`retry()` reports an account without access like `refusedBy()`, not as offline', async () => {
    const { e, replay } = await waiting();
    accounts.list = [stale] as MailAccount[];
    await e.retry();
    expect(replay).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'Sign in to a@example.com again first', error: true });
    expect(e.queue.count).toBe(1);
  });

  it('`describe()` supplies the subjects to the entry; per email the first source with a match wins', async () => {
    const { e, set } = setup();
    set.mockRejectedValue(offline());
    e.describe(() => null);
    e.describe((account, id) => (id === 'e2' ? `${account}: Invoice` : null));
    e.describe((_account, id) => (id === 'e3' ? null : 'Later source'));
    e.run({
      account: 'k1',
      edits: new Map<string, EmailEdit>([
        ['e2', { keywords: { $seen: true } }],
        ['e1', { keywords: { $seen: true } }],
        ['e3', { keywords: { $seen: true } }],
      ]),
    });
    await tick();
    expect(e.queue.items[0]?.subjects).toEqual({ e2: 'k1: Invoice', e1: 'Later source' });
  });

  describe('Rows for the target', () => {
    const MOVE = new Map<string, EmailEdit>([['e1', { mailboxIds: { in: false, arch: true } }]]);
    const row = (threadId: string, seq: number): ListThread => ({
      key: `k1/${threadId}`,
      account: 'k1',
      id: threadId,
      threadId,
      receivedAt: 0,
      from: [],
      to: [],
      subject: threadId,
      preview: '',
      hasAttachment: false,
      unread: false,
      flagged: false,
      count: 1,
      mailboxIds: ['in'],
      members: [{ id: 'e1', mailboxIds: ['in'], keywords: {}, from: '' }],
      seq,
    });

    it('takes the row of a conversation along that an action puts into a mailbox, not for keywords', async () => {
      const { e, set, rows } = setup();
      set.mockRejectedValue(offline());
      const known = row('t1', 3);
      e.carry((account, ids) => (account === 'k1' && ids.has('e1') ? [known] : []));
      e.run({ account: 'k1', edits: SEEN });
      e.run({ account: 'k1', edits: MOVE });
      await tick();
      expect(e.carried('k1', stamp())).toEqual([known]);
      expect(e.carried('k2', 0)).toEqual([]);
      // Stored in the queue, only when moving.
      expect([...rows.values()].map((r) => r.rows)).toEqual([undefined, [known]]);
    });

    it('names confirmed rows only to lists loaded before the confirmation, per conversation the most recent', async () => {
      const { e } = setup();
      let known = row('t1', 3);
      e.carry(() => [known]);
      const before = stamp();
      e.run({ account: 'k1', edits: MOVE });
      await tick();
      const after = stamp();
      expect(e.carried('k1', before)).toEqual([known]);
      expect(e.carried('k1', after)).toEqual([]);
      known = row('t1', 7);
      e.run({ account: 'k1', edits: MOVE });
      expect(e.carried('k1', before)).toEqual([known]);
    });

    it('lays stored rows over again after a restart, older than every change since', async () => {
      const { e, set, rows, log } = setup();
      set.mockRejectedValue(offline());
      e.carry(() => [row('t1', 9)]);
      e.run({ account: 'k1', edits: MOVE });
      await tick();
      expect(rows.size).toBe(1);
      const restarted = new EmailEdits(fakeApi().api, log);
      await restarted.restore();
      expect(restarted.carried('k1', 0)).toEqual([{ ...row('t1', 9), seq: 0 }]);
    });

    it('skips drafts that exist only in the queue and reports it if nothing remains', async () => {
      const { e, set } = setup();
      const local = new Map<string, EmailEdit>([['~0001', { keywords: { $flagged: true } }]]);
      network.online = false;
      expect(e.run({ account: 'k1', edits: local, text: 'Flagged' })).toBe(false);
      expect(ui.toast).toMatchObject({ text: OFFLINE_TOAST });
      ui.reset();
      expect(e.run({ account: 'k1', edits: local, quiet: true })).toBe(false);
      expect(ui.toast).toBeNull();
      network.online = true;
      e.purge('k1', new Map([['~0001', { destroyed: true }]]), 'Trash');
      expect(ui.toast).toMatchObject({ text: m.error_act() });
      expect(set).not.toHaveBeenCalled();
      expect(e.edit('k1', '~0001', 0)).toBeUndefined();
      ui.reset();
      // In a selection the other emails go out.
      expect(e.run({ account: 'k1', edits: new Map([...local, ...SEEN]) })).toBe(true);
      await tick();
      expect(set).toHaveBeenCalledWith('k1', SEEN, false);
      expect(ui.toast).toBeNull();
    });
  });

  it('leaves the subjects empty without a source, also if none knows the email', async () => {
    const { e, set, replay } = setup();
    set.mockRejectedValue(offline());
    replay.mockRejectedValue(offline());
    e.run({ account: 'k1', edits: SEEN });
    await tick();
    e.describe(() => null);
    e.run({ account: 'k1', edits: FLAGGED });
    await tick();
    expect(e.queue.items.map((i) => i.subjects)).toEqual([{}, {}]);
  });

  it('`reset()` clears the queue and the layer', async () => {
    const { e } = await waiting();
    e.reset();
    expect(e.queue.count).toBe(0);
    expect(e.edit('k1', 'e1', 0)).toBeUndefined();
    expect(e.queue.stuck).toEqual([]);
  });
});
