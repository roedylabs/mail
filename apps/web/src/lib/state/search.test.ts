import { JmapClient } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import { SF0, type FilterEnv } from '#lib/search-filter.ts';
import { searchCats, type MailHit } from '#lib/search.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  jmapSearchApi,
  MAIL_PAGE,
  scopeOf,
  Search,
  SEARCH_DELAY,
  TILE_TTL,
  type MailPage,
  type SearchApi,
} from './search.svelte.ts';
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

function hit(account: string, id: string, at = '2026-11-02T09:00:00Z'): MailHit {
  return {
    account,
    id,
    threadId: `t-${id}`,
    mailboxIds: { in: true },
    keywords: {},
    receivedAt: at,
    from: null,
    to: null,
    subject: id,
    attachments: [],
    snippet: null,
  };
}

/** Accounts `ids` with trash and spam, without own folders and tags. */
function testEnv(ids: readonly string[]): FilterEnv {
  return {
    accounts: ids.map((id) => ({ id, email: `${id}@example.com` })),
    allowed: searchCats(true),
    folders: [{ key: 'role:inbox', label: 'Inbox' }],
    tags: [],
    folderBoxes: (key, a) => (key === 'role:trash' ? [`${a}-trash`] : key === 'role:spam' ? [`${a}-junk`] : []),
    tagBoxes: () => [],
    tz: 'Europe/Berlin',
  };
}

describe('jmapSearchApi', () => {
  it('query, emails and snippets in one request, in the order of the server', async () => {
    const { client, seen } = server(([name]) => {
      if (name === 'Email/query')
        return [
          name,
          { accountId: 'j1', queryState: 'q', canCalculateChanges: false, position: 0, ids: ['e2', 'e1'], total: 7 },
        ];
      if (name === 'Email/get')
        return [
          name,
          {
            accountId: 'j1',
            state: 's',
            notFound: [],
            list: ['e1', 'e2'].map((id) => ({
              id,
              threadId: `t${id}`,
              mailboxIds: { in: true },
              keywords: {},
              receivedAt: '2026-11-02T09:00:00Z',
              from: null,
              to: null,
              subject: `S ${id}`,
              attachments: id === 'e1' ? [{ name: 'a.pdf' }, { name: null }] : [],
            })),
          },
        ];
      return [
        name,
        { accountId: 'j1', notFound: [], list: [{ emailId: 'e1', subject: '<mark>S</mark> e1', preview: null }] },
      ];
    });
    const filter = { text: 's' };
    const page = await jmapSearchApi(() => Promise.resolve(client)).page('k1', { filter, snippets: true }, 50, 50);
    expect(seen.map((c) => c[0])).toEqual(['Email/query', 'Email/get', 'SearchSnippet/get']);
    expect(seen[0]![1]).toMatchObject({
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: false,
      position: 50,
      limit: 50,
      calculateTotal: true,
    });
    expect(seen[1]![1]).toMatchObject({ bodyProperties: ['name'] });
    expect(seen[2]![1]).toMatchObject({ filter, '#emailIds': { name: 'Email/query', path: '/ids' } });
    expect(page.total).toBe(7);
    expect(page.hits.map((h) => [h.account, h.id, h.snippet, h.attachments])).toEqual([
      ['k1', 'e2', null, []],
      ['k1', 'e1', '<mark>S</mark> e1', ['a.pdf']],
    ]);
  });

  it('no snippets without search words; an error with the snippets only costs the highlighting', async () => {
    const answer = ([name]: Invocation): [string, unknown] =>
      name === 'Email/query'
        ? [name, { accountId: 'j1', queryState: 'q', canCalculateChanges: false, position: 0, ids: [], total: 0 }]
        : name === 'Email/get'
          ? [name, { accountId: 'j1', state: 's', notFound: [], list: [] }]
          : ['error', { type: 'unsupportedFilter' }];
    const a = server(answer);
    await jmapSearchApi(() => Promise.resolve(a.client)).page('k1', { filter: { from: 'x' }, snippets: false }, 0, 5);
    expect(a.seen.map((c) => c[0])).toEqual(['Email/query', 'Email/get']);
    const b = server(answer);
    const page = await jmapSearchApi(() => Promise.resolve(b.client)).page(
      'k1',
      { filter: { text: 'x' }, snippets: true },
      0,
      5,
    );
    expect(page).toEqual({ hits: [], positions: 0, total: 0 });
  });

  it('skips emails from notFound like deleted ones and counts their position', async () => {
    const { client } = server(([name]) =>
      name === 'Email/query'
        ? [
            name,
            { accountId: 'j1', queryState: 'q', canCalculateChanges: false, position: 0, ids: ['e2', 'e1'], total: 2 },
          ]
        : name === 'Email/get'
          ? [
              name,
              {
                accountId: 'j1',
                state: 's',
                notFound: ['e2'],
                list: [{ id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, receivedAt: '2026-11-02T09:00:00Z' }],
              },
            ]
          : [
              name,
              {
                accountId: 'j1',
                notFound: ['e2'],
                list: [{ emailId: 'e1', subject: '<mark>x</mark>', preview: null }],
              },
            ],
    );
    const page = await jmapSearchApi(() => Promise.resolve(client)).page(
      'k1',
      { filter: { text: 'x' }, snippets: true },
      0,
      5,
    );
    expect(page.hits.map((h) => [h.id, h.snippet])).toEqual([['e1', '<mark>x</mark>']]);
    expect(page.positions).toBe(2);
  });
});

describe('jmapSearchApi.counts', () => {
  it('one Email/query with calculateTotal per filter in one request; an error counts as unknown', async () => {
    const { client, seen } = server(([name, args]) =>
      (args['filter'] as { hasKeyword?: string } | null)?.hasKeyword
        ? ['error', { type: 'unsupportedFilter' }]
        : [name, { accountId: 'j1', queryState: 'q', canCalculateChanges: false, position: 0, ids: ['e1'], total: 12 }],
    );
    const got = await jmapSearchApi(() => Promise.resolve(client)).counts('k1', [
      { notKeyword: '$seen' },
      { hasKeyword: '$flagged' },
    ]);
    expect(got).toEqual([12, null]);
    expect(seen.map(([name, args]) => [name, args['limit'], args['calculateTotal'], args['collapseThreads']])).toEqual([
      ['Email/query', 1, true, false],
      ['Email/query', 1, true, false],
    ]);
  });
});

describe('Search', () => {
  let pages: Map<string, MailPage[]>;
  let page: ReturnType<typeof vi.fn<SearchApi['page']>>;
  let counts: ReturnType<typeof vi.fn<SearchApi['counts']>>;
  let ids: string[];
  let s: Search;
  /** Sets the accounts of the search and aligns (effect of the page). */
  const sync = (list: string[]) => {
    ids = list;
    s.sync();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    pages = new Map();
    page = vi.fn<SearchApi['page']>((account) => {
      const list = pages.get(account) ?? [];
      const next = list.shift();
      return next ? Promise.resolve(next) : Promise.reject(new TypeError('Failed to fetch'));
    });
    counts = vi.fn<SearchApi['counts']>(() => Promise.resolve([3, 1, 0, 2]));
    ids = [];
    s = new Search(
      { page, counts },
      () => testEnv(ids),
      () => Promise.resolve(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks immediately after Enter, while typing after the delay, and only the latest query counts', async () => {
    pages.set('k1', [{ hits: [hit('k1', 'e1')], positions: 1, total: 1 }]);
    s.open('inv', null);
    sync(['k1']);
    expect(s.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(page).toHaveBeenCalledWith('k1', { filter: { text: 'inv' }, snippets: true }, 0, MAIL_PAGE);
    expect(s.hits.map((h) => h.id)).toEqual(['e1']);
    expect(s.loading).toBe(false);

    pages.set('k1', [
      { hits: [hit('k1', 'e2')], positions: 1, total: 1 },
      { hits: [hit('k1', 'e3')], positions: 1, total: 1 },
    ]);
    s.q = 'invo';
    sync(['k1']);
    s.q = 'invoi';
    sync(['k1']);
    expect(s.loading).toBe(true);
    expect(s.pending).toBe(false);
    expect(s.hits.map((h) => h.id)).toEqual(['e1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenCalledTimes(2);
    expect(s.hits.map((h) => h.id)).toEqual(['e2']);
  });

  it('no query without word, filter and area, or with only local areas', async () => {
    sync(['k1']);
    s.set({ cats: ['folders'] });
    sync(['k1']);
    s.q = 'x';
    sync([]);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).not.toHaveBeenCalled();
    // While typing without previous hits: only after the delay.
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY - 1);
    expect(page).not.toHaveBeenCalled();
    expect(s.hits).toEqual([]);
    expect(s.mailTotal).toBeNull();
  });

  it('merges the accounts, newest first; a failed account reports an error', async () => {
    pages.set('k1', [{ hits: [hit('k1', 'a', '2026-11-01T10:00:00Z')], positions: 1, total: 3 }]);
    pages.set('k2', [{ hits: [hit('k2', 'b', '2026-11-02T10:00:00Z')], positions: 1, total: 4 }]);
    s.q = 'x';
    sync(['k2', 'k1', 'k3']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(s.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(s.mailTotal).toBe(7);
    expect(ui.toast?.text).toBe(m.error_act());
  });

  it('a local area parks the hits; back, they are there immediately and get refreshed', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'e1')], positions: 1, total: 1 },
      { hits: [hit('k1', 'e2')], positions: 1, total: 1 },
    ]);
    s.open('x', null);
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(0);
    s.set({ cats: ['folders'] });
    sync(['k1']);
    expect(s.hits).toEqual([]);
    s.set({ cats: [] });
    sync(['k1']);
    expect([s.pending, s.loading, s.hits.map((h) => h.id)]).toEqual([false, false, ['e1']]);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenCalledTimes(2);
    expect(s.hits.map((h) => h.id)).toEqual(['e2']);
  });

  it('reports consecutive errors only once', async () => {
    const error = vi.spyOn(ui.toasts, 'error');
    s.q = 'a';
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    s.q = 'ab';
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('loads more pages per account from what is loaded', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'a', '2026-11-02T10:00:00Z')], positions: 1, total: 2 },
      { hits: [hit('k1', 'b', '2026-11-01T10:00:00Z')], positions: 1, total: 2 },
    ]);
    pages.set('k2', [{ hits: [hit('k2', 'c')], positions: 1, total: 1 }]);
    s.searchFrom('anna@example.com');
    sync(['k1', 'k2']);
    await vi.advanceTimersByTimeAsync(0);
    await s.more();
    expect(page).toHaveBeenLastCalledWith(
      'k1',
      { filter: { from: 'anna@example.com' }, snippets: false },
      1,
      MAIL_PAGE,
    );
    expect(page).toHaveBeenCalledTimes(3);
    expect(s.hits.map((h) => h.id)).toEqual(['a', 'c', 'b']);
    await s.more();
    expect(page).toHaveBeenCalledTimes(3);
  });

  it('counts the query positions when loading more, also without found emails (notFound)', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'a')], positions: 3, total: 6 },
      { hits: [], positions: 2, total: 6 },
      { hits: [hit('k1', 'b')], positions: 1, total: 6 },
    ]);
    s.searchFrom('anna@example.com');
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(0);
    await s.more();
    expect(page).toHaveBeenLastCalledWith('k1', expect.anything(), 3, MAIL_PAGE);
    await s.more();
    expect(page).toHaveBeenLastCalledWith('k1', expect.anything(), 5, MAIL_PAGE);
    expect(s.hits.map((h) => h.id)).toEqual(['a', 'b']);
    await s.more();
    expect(page).toHaveBeenCalledTimes(3);
  });

  it('stops loading more at a page without positions, even if total promises more', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'a')], positions: 1, total: 5 },
      { hits: [], positions: 0, total: 5 },
    ]);
    s.searchFrom('anna@example.com');
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(0);
    await s.more();
    await s.more();
    expect(page).toHaveBeenCalledTimes(2);
    expect(s.hits.map((h) => h.id)).toEqual(['a']);
  });

  it('filter panel: hide when docked, otherwise overlay; leaving the search closes the overlay', () => {
    let width = 1440;
    const p = new Search(
      { page, counts },
      () => testEnv(ids),
      () => Promise.resolve(),
      () => width,
    );
    expect([p.dock, p.panelShown, p.panelOverlaid]).toEqual([true, true, false]);
    p.togglePanel();
    expect([p.panelHidden, p.panelShown]).toEqual([true, false]);
    // Docked from a width of 992 px (`rfDock()`: width − 32 px ≥ 960 px).
    width = 991;
    expect([p.dock, p.panelShown]).toEqual([false, false]);
    p.togglePanel();
    expect([p.panelOver, p.panelHidden, p.panelShown, p.panelOverlaid]).toEqual([true, true, true, true]);
    p.closePanel();
    expect(p.panelShown).toBe(false);
    p.togglePanel();
    expect([p.panelOverlaid, p.panelHidden]).toEqual([true, true]);
    width = 992;
    expect([p.dock, p.panelShown, p.panelOverlaid]).toEqual([true, false, false]);
    p.togglePanel();
    expect([p.panelHidden, p.panelShown]).toEqual([false, true]);
    p.set({ st: ['u'] });
    p.leave();
    expect([p.panelOver, p.panelHidden, p.filtered]).toEqual([false, false, false]);
    p.panelOver = true;
    p.done();
    expect(p.panelOver).toBe(false);
    p.panelHidden = true;
    p.panelOver = true;
    p.close();
    expect([p.panelOver, p.panelHidden]).toEqual([false, true]);
    p.panelOver = true;
    p.reset();
    expect([p.panelOver, p.panelHidden]).toEqual([false, false]);
  });

  it('open, contact, hit, close and history', () => {
    s.open('Invoice', '/mailbox/k1/inbox');
    s.open('  Reminder ', null);
    s.open('Invoice', '/start');
    expect(s.recent).toEqual(['Invoice', 'Reminder']);
    s.searchFrom('anna@example.com');
    expect([s.q, s.sf.from, s.sf.cats]).toEqual(['', 'anna@example.com', ['mail']]);
    expect(s.close()).toBe('/start');
    expect([s.sf.from, s.sf.cats, s.filtered, s.close()]).toEqual(['', [], false, null]);
    s.set({ st: ['u'] });
    s.open('Quarter', '/mailbox/k1/inbox');
    // Set filters stay on opening (`openResults`), an opened hit clears them.
    expect(s.sf.st).toEqual(['u']);
    s.set({ cats: ['files'] });
    s.done();
    expect([s.q, s.sf.cats, s.sf.st, s.recent[0], s.back]).toEqual(['', [], [], 'Quarter', '/mailbox/k1/inbox']);
    s.forget('Reminder');
    expect(s.recent).toEqual(['Quarter', 'Invoice']);
    for (const q of ['1', '2', '3', '4', '5']) s.remember(q);
    expect(s.recent).toEqual(['5', '4', '3', '2', '1']);
    s.reset();
    expect([s.q, s.recent, s.mail]).toEqual(['', [], null]);
  });

  it('filters without text ask immediately with status, without snippets; operators add to them', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'e1')], positions: 1, total: 1 },
      { hits: [hit('k1', 'e2')], positions: 1, total: 1 },
    ]);
    s.set({ st: ['u'] });
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenLastCalledWith('k1', { filter: { notKeyword: '$seen' }, snippets: false }, 0, MAIL_PAGE);
    s.q = 'Report is:flagged';
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenLastCalledWith(
      'k1',
      {
        filter: {
          operator: 'AND',
          conditions: [{ text: 'report' }, { notKeyword: '$seen' }, { hasKeyword: '$flagged' }],
        },
        snippets: true,
      },
      0,
      MAIL_PAGE,
    );
    expect(s.terms.raw).toEqual(['report']);
  });

  it('a time range does not ask anew every minute, only after a change of the filters', async () => {
    pages.set('k1', [
      { hits: [hit('k1', 'e1')], positions: 1, total: 1 },
      { hits: [hit('k1', 'e2')], positions: 1, total: 1 },
    ]);
    s.set({ time: '7d' });
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenCalledTimes(1);
    s.set({ time: '7d' });
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('an operator without hits does not ask and shows nothing', async () => {
    s.q = 'invoice in:doesnotexist';
    sync(['k1']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).not.toHaveBeenCalled();
    expect(s.effective().mailF).toBe(true);
    expect([s.hits, s.loading]).toEqual([[], false]);
  });

  it('an account in the filter asks only this account; chips with names and removal', async () => {
    pages.set('k2', [{ hits: [hit('k2', 'e1')], positions: 1, total: 1 }]);
    s.set({ account: 'k2', cats: ['mail'] });
    sync(['k1', 'k2']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0]![0]).toBe('k2');
    expect(s.chips.map((c) => c.label)).toEqual(['Messages only', 'Account: k2@example.com']);
    expect(s.filtered).toBe(true);
    s.chips[1]!.remove();
    expect(s.sf.account).toBeNull();
    s.chips[0]!.remove();
    expect(s.filtered).toBe(false);
  });

  it('tile counters across all accounts without trash and spam, at most once per minute', async () => {
    counts.mockImplementation((account) =>
      account === 'k2' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve([3, 1, null, 2]),
    );
    ids = ['k1', 'k2', 'k3'];
    const now = Date.parse('2026-11-02T10:30:00Z');
    await s.loadTiles(now);
    expect(s.tileCounts).toEqual([6, 2, null, 4]);
    expect(counts).toHaveBeenCalledTimes(3);
    const filters = counts.mock.calls[0]![1];
    expect(filters[0]).toEqual({
      operator: 'AND',
      conditions: [{ inMailboxOtherThan: ['k1-trash', 'k1-junk'] }, { notKeyword: '$seen' }],
    });
    expect(filters[3]).toEqual({
      operator: 'AND',
      conditions: [
        { inMailboxOtherThan: ['k1-trash', 'k1-junk'] },
        { after: '2026-11-01T23:00:00Z', before: '2026-11-02T23:00:00Z' },
      ],
    });
    await s.loadTiles(now + TILE_TTL - 1);
    expect(counts).toHaveBeenCalledTimes(3);
    await s.loadTiles(now + TILE_TTL);
    expect(counts).toHaveBeenCalledTimes(6);
    s.reset();
    expect(s.tileCounts).toBeNull();
  });

  it('search suggestions under "In … only" ask only in the view\'s folder, "Everywhere" in all accounts', async () => {
    for (const a of ['k1', 'k2'])
      pages.set(a, [
        { hits: [hit(a, `${a}-1`)], positions: 1, total: 1 },
        { hits: [hit(a, `${a}-2`)], positions: 1, total: 1 },
      ]);
    s.context = scopeOf('/mailbox/k1/trash', false, testEnv(['k1', 'k2']));
    s.q = 'inv';
    sync(['k1', 'k2']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['k1', { filter: { operator: 'AND', conditions: [{ text: 'inv' }, { inMailbox: 'k1-trash' }] }, snippets: true }],
    ]);
    expect(s.sf).toBe(SF0);
    s.scope = 'all';
    sync(['k1', 'k2']);
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY);
    expect(page.mock.calls.slice(1).map((c) => [c[0], c[1].filter])).toEqual([
      ['k1', { text: 'inv' }],
      ['k2', { text: 'inv' }],
    ]);
    expect(s.hits.map((h) => h.id)).toEqual(['k1-2', 'k2-1']);
  });

  describe('return path to the search', () => {
    const THREAD = '/mailbox/k1/inbox/t1';

    it('a hit remembers text, filters, area and way back; its navigation becomes the target', () => {
      s.open('inv', '/mailbox/k1/inbox');
      s.set({ st: ['u'] });
      s.scope = 'all';
      s.expectReturn('results');
      s.done();
      expect([s.q, s.sf]).toEqual(['', SF0]);
      s.navigating(THREAD, true);
      expect(s.returnAt(THREAD)?.kind).toBe('results');
      expect(s.returnAt('/mailbox/k1/inbox')).toBeNull();
      s.arrived(THREAD);
      s.scope = 'here';
      expect(s.takeReturn(THREAD)).toBe(true);
      expect([s.q, s.sf.st, s.scope, s.back, s.ret]).toEqual(['inv', ['u'], 'all', '/mailbox/k1/inbox', null]);
    });

    it('returning asks again at once; the parked hits are there immediately', async () => {
      pages.set('k1', [
        { hits: [hit('k1', 'e1')], positions: 1, total: 1 },
        { hits: [hit('k1', 'e2')], positions: 1, total: 1 },
      ]);
      s.open('inv', null);
      sync(['k1']);
      await vi.advanceTimersByTimeAsync(0);
      s.expectReturn('search');
      s.done();
      sync(['k1']);
      expect(s.hits).toEqual([]);
      s.navigating(THREAD, true);
      s.takeReturn(THREAD);
      sync(['k1']);
      expect(s.hits.map((h) => h.id)).toEqual(['e1']);
      await vi.advanceTimersByTimeAsync(0);
      expect(page).toHaveBeenCalledTimes(2);
      expect(s.hits.map((h) => h.id)).toEqual(['e2']);
    });

    it('the refresh after returning keeps the pages loaded before', async () => {
      pages.set('k1', [
        { hits: [hit('k1', 'e1')], positions: 1, total: 2 },
        { hits: [hit('k1', 'e2', '2026-11-01T09:00:00Z')], positions: 1, total: 2 },
        { hits: [hit('k1', 'f1')], positions: 1, total: 2 },
        { hits: [hit('k1', 'f2', '2026-11-01T09:00:00Z')], positions: 1, total: 2 },
      ]);
      s.open('inv', null);
      sync(['k1']);
      await vi.advanceTimersByTimeAsync(0);
      await s.more();
      expect(s.hits.map((h) => h.id)).toEqual(['e1', 'e2']);
      s.expectReturn('results');
      s.done();
      sync(['k1']);
      s.navigating(THREAD, true);
      s.takeReturn(THREAD);
      sync(['k1']);
      await vi.advanceTimersByTimeAsync(0);
      expect(page.mock.calls.map((c) => c[2])).toEqual([0, 1, 0, 1]);
      expect(s.hits.map((h) => h.id)).toEqual(['f1', 'f2']);
    });

    /** Two pages loaded, back from the opened hit: the refresh is scheduled. */
    async function returned() {
      s.open('inv', null);
      sync(['k1']);
      await vi.advanceTimersByTimeAsync(0);
      await s.more();
      s.expectReturn('results');
      s.done();
      sync(['k1']);
      s.navigating(THREAD, true);
      s.takeReturn(THREAD);
      sync(['k1']);
    }

    it('loading more asked during the refresh follows it', async () => {
      pages.set('k1', [
        { hits: [hit('k1', 'e1')], positions: 1, total: 3 },
        { hits: [hit('k1', 'e2', '2026-11-01T09:00:00Z')], positions: 1, total: 3 },
        { hits: [hit('k1', 'f1')], positions: 1, total: 3 },
        { hits: [hit('k1', 'f2', '2026-11-01T09:00:00Z')], positions: 1, total: 3 },
        { hits: [hit('k1', 'f3', '2026-10-31T09:00:00Z')], positions: 1, total: 3 },
      ]);
      await returned();
      // Asked during the refresh (sentinel visible): it follows the refresh instead of getting lost.
      await s.more();
      expect(s.loadingMore).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect([s.loadingMore, s.hits.map((h) => h.id)]).toEqual([false, ['f1', 'f2', 'f3']]);
      expect(page.mock.calls.map((c) => c[2])).toEqual([0, 1, 0, 1, 2]);
    });

    it('the refresh skips a hit that a shifted position repeats', async () => {
      pages.set('k1', [
        { hits: [hit('k1', 'e1')], positions: 1, total: 2 },
        { hits: [hit('k1', 'e2', '2026-11-01T09:00:00Z')], positions: 1, total: 2 },
        { hits: [hit('k1', 'n1', '2026-11-03T09:00:00Z')], positions: 1, total: 3 },
        { hits: [hit('k1', 'n1', '2026-11-03T09:00:00Z')], positions: 1, total: 3 },
      ]);
      await returned();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.hits.map((h) => h.id)).toEqual(['n1']);
    });

    it('a refresh that fails on a later page keeps the hits loaded before and reports it', async () => {
      pages.set('k1', [
        { hits: [hit('k1', 'e1')], positions: 1, total: 2 },
        { hits: [hit('k1', 'e2', '2026-11-01T09:00:00Z')], positions: 1, total: 2 },
        { hits: [hit('k1', 'f1')], positions: 1, total: 2 },
      ]);
      const error = vi.spyOn(ui.toasts, 'error');
      await returned();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.hits.map((h) => h.id)).toEqual(['e1', 'e2']);
      expect(error).toHaveBeenCalledOnce();
      error.mockRestore();
    });

    it('a discarded page of "load more" does not leave loading stuck', async () => {
      let answer: (p: MailPage) => void = () => {};
      pages.set('k1', [{ hits: [hit('k1', 'e1')], positions: 1, total: 2 }]);
      s.open('inv', null);
      sync(['k1']);
      await vi.advanceTimersByTimeAsync(0);
      page.mockImplementationOnce(() => new Promise<MailPage>((r) => (answer = r)));
      const more = s.more();
      expect(s.loadingMore).toBe(true);
      s.mail = { ...s.mail! };
      answer({ hits: [hit('k1', 'e2')], positions: 1, total: 2 });
      await more;
      expect(s.loadingMore).toBe(false);
    });

    it('none without a navigation in the same task (contact, action) or to a list', async () => {
      s.expectReturn('results');
      await vi.advanceTimersByTimeAsync(0);
      s.navigating(THREAD, true);
      expect(s.ret).toBeNull();
      s.expectReturn('results');
      s.navigating('/mailbox/k1/inbox', false);
      expect(s.ret).toBeNull();
    });

    it('ends as soon as the user leaves the target: J/K, another page, back in the browser', () => {
      for (const leave of [
        (x: Search) => x.navigating('/mailbox/k1/inbox/t2', true),
        (x: Search) => x.arrived('/settings/general'),
      ]) {
        s.expectReturn('results');
        s.navigating(THREAD, true);
        leave(s);
        expect(s.ret).toBeNull();
        expect(s.takeReturn(THREAD)).toBe(false);
      }
      // Staying at the target (also navigating to it again) keeps it.
      s.expectReturn('search');
      s.navigating(THREAD, true);
      s.navigating(THREAD, true);
      s.arrived(THREAD);
      expect(s.returnAt(THREAD)?.kind).toBe('search');
    });

    it('applies only at its target and goes with sign-out', () => {
      s.expectReturn('search');
      s.navigating('/settings/general', true);
      expect(s.takeReturn('/settings/appearance')).toBe(false);
      expect(s.ret).toBeNull();
      s.expectReturn('search');
      s.navigating('/settings/general', true);
      s.reset();
      expect(s.ret).toBeNull();
    });
  });

  describe('without connection', () => {
    const mail = (id: string, subject: string) => ({
      id,
      threadId: `t-${id}`,
      receivedAt: 1000,
      from: [{ name: 'Anna', email: 'anna@x' }],
      to: [],
      subject,
      preview: '',
      mailboxIds: ['m1'],
      keywords: {},
      hasAttachment: false,
      attachments: [],
    });
    let local: Search;

    beforeEach(() => {
      ui.reset();
      ids = [];
      local = new Search(
        { page, counts },
        () => testEnv(ids),
        () => Promise.resolve(),
        undefined,
        () => Promise.resolve([mail('e1', 'Invoice Zurich'), mail('e2', 'Vacation')]),
      );
    });

    const find = async (q: string) => {
      local.open(q, null);
      ids = ['k1'];
      local.sync();
      await vi.advanceTimersByTimeAsync(0);
    };

    it('searches in storage, without an error toast, and knows it', async () => {
      page.mockImplementation(() => Promise.reject(new NetworkError('gone')));
      await find('inv');
      expect(local.hits.map((h) => h.id)).toEqual(['e1']);
      expect(local.hits[0]?.snippet).toBe('<mark>Inv</mark>oice Zurich');
      expect(local.mailTotal).toBe(1);
      expect(local.local).toBe(true);
      expect(ui.toast).toBeNull();
      await local.more();
      expect(page).toHaveBeenCalledTimes(1);
    });

    it('fetches the hits from the server after the network returns', async () => {
      page.mockImplementation(() => Promise.reject(new NetworkError('gone')));
      await find('inv');
      page.mockImplementation(() => Promise.resolve({ hits: [hit('k1', 'e9')], positions: 1, total: 1 }));
      local.resume();
      expect(local.hits.map((h) => h.id)).toEqual(['e1']);
      await vi.advanceTimersByTimeAsync(0);
      expect(local.hits.map((h) => h.id)).toEqual(['e9']);
      expect(local.local).toBe(false);
      local.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(page).toHaveBeenCalledTimes(2);
    });

    it('does not search in storage on other errors', async () => {
      page.mockImplementation(() => Promise.reject(new Error('500')));
      await find('inv');
      expect(local.hits).toEqual([]);
      expect(local.local).toBe(false);
    });
  });
});

describe('scopeOf', () => {
  const env: FilterEnv = {
    ...testEnv(['k1', 'k2']),
    folders: [
      { key: 'role:inbox', label: 'Inbox' },
      { key: 'box:k1:p1', label: 'Projects' },
      { key: 'box:k2:a:b', label: 'Customers' },
    ],
    tags: [{ id: 't1', label: 'Work' }],
  };
  const settings = { here: 'Settings only', icon: 'ti-settings', patch: { cats: ['settings'] } };

  it('settings and account, without the pages of an email account', () => {
    expect(scopeOf('/settings/appearance', false, env)).toEqual(settings);
    expect(scopeOf('/account/profile', false, env)).toEqual(settings);
    expect(scopeOf('/account/mail-accounts', false, env)).toEqual(settings);
    // "Add account" belongs to the account, not to an email account.
    expect(scopeOf('/account/mail-accounts/new', false, env)).toEqual(settings);
    expect(scopeOf('/account/mail-accounts/new-name/overview', false, env)).toBeNull();
    expect(scopeOf('/account/mail-accounts/k1/overview', false, env)).toBeNull();
    expect(scopeOf('/account/mail-accounts/k1', false, env)).toBeNull();
  });

  it('administration only for administrators', () => {
    expect(scopeOf('/admin/users', true, env)).toEqual({
      here: 'Administration only',
      icon: 'ti-shield',
      patch: { cats: ['admin'] },
    });
    expect(scopeOf('/admin/users', false, env)).toBeNull();
  });

  it('sidebar mailboxes, in "all accounts" without an account', () => {
    expect(scopeOf('/mailbox/all/inbox', false, env)).toEqual({
      here: 'In Inbox only',
      icon: 'ti-inbox',
      patch: { folder: 'role:inbox', account: null },
    });
    expect(scopeOf('/mailbox/k1/sent', false, env)).toEqual({
      here: 'In Sent only',
      icon: 'ti-send',
      patch: { folder: 'role:sent', account: 'k1' },
    });
    // With an open thread and without a path (inbox).
    expect(scopeOf('/mailbox/k1/inbox/th1', false, env)?.patch).toEqual({ folder: 'role:inbox', account: 'k1' });
    expect(scopeOf('/mailbox/k2', false, env)?.patch).toEqual({ folder: 'role:inbox', account: 'k2' });
  });

  it('own folder with a name from the environment, also in "all accounts"; unknown none', () => {
    const projects = { here: 'In Projects only', icon: 'ti-folder', patch: { folder: 'box:k1:p1', account: 'k1' } };
    expect(scopeOf('/mailbox/k1/f/p1', false, env)).toEqual(projects);
    expect(scopeOf('/mailbox/all/f/k1/p1', false, env)).toEqual(projects);
    expect(scopeOf('/mailbox/k2/f/a%3Ab', false, env)).toEqual({
      here: 'In Customers only',
      icon: 'ti-folder',
      patch: { folder: 'box:k2:a:b', account: 'k2' },
    });
    expect(scopeOf('/mailbox/k1/f/zz', false, env)).toBeNull();
    // Folder of another account and "all accounts" without an owner.
    expect(scopeOf('/mailbox/k2/f/p1', false, env)).toBeNull();
    expect(scopeOf('/mailbox/all/f/p1', false, env)).toBeNull();
  });

  it('tag with name, also in "all accounts"; unknown none', () => {
    const work = { here: m.search_scope_tag({ name: 'Work' }), icon: 'ti-tag', patch: { tags: ['t1'] } };
    expect(scopeOf('/mailbox/k1/t/t1', false, env)).toEqual(work);
    expect(scopeOf('/mailbox/all/t/t1', false, env)).toEqual(work);
    expect(scopeOf('/mailbox/k1/t/t9', false, env)).toBeNull();
  });

  it('start page, search and foreign paths without an area', () => {
    for (const path of ['/start', '/search', '/', '/mailbox/k1/unknown', '/mailbox/'])
      expect(scopeOf(path, true, env)).toBeNull();
  });
});

describe('Search: area of the view', () => {
  const env: FilterEnv = {
    ...testEnv(['k1', 'k2']),
    folderBoxes: (key, a) => (key === 'role:inbox' ? [`${a}-in`] : []),
  };
  const inbox = scopeOf('/mailbox/k1/inbox', false, env)!;
  const make = () =>
    new Search(
      { page: vi.fn<SearchApi['page']>(), counts: vi.fn<SearchApi['counts']>() },
      () => env,
      () => Promise.resolve(),
      () => 1440,
      () => Promise.resolve([]),
    );

  it('effective uses the area only under "In … only" with a set context', () => {
    const s = make();
    expect([s.scope, s.context, s.here]).toEqual(['here', null, null]);
    s.q = 'report';
    expect(s.effective()).toMatchObject({ mailF: false, cats: [] });
    expect(s.effective().queries.map((q) => q.account)).toEqual(['k1', 'k2']);
    s.context = inbox;
    expect(s.here).toBe(inbox);
    expect(s.effective()).toMatchObject({
      mailF: true,
      queries: [
        { account: 'k1', filter: { operator: 'AND', conditions: [{ text: 'report' }, { inMailbox: 'k1-in' }] } },
      ],
    });
    // The area only affects the query, not the filters.
    expect([s.sf, s.filtered]).toEqual([SF0, false]);
    s.scope = 'all';
    expect(s.here).toBeNull();
    expect(s.effective().queries.map((q) => [q.account, q.filter])).toEqual([
      ['k1', { text: 'report' }],
      ['k2', { text: 'report' }],
    ]);
    s.scope = 'here';
    s.context = scopeOf('/settings/appearance', false, env);
    expect(s.effective()).toMatchObject({ cats: ['settings'], mailF: false });
    // A chosen area takes precedence.
    s.set({ cats: ['mail'] });
    expect(s.effective().cats).toEqual(['mail']);
  });

  it('open takes the area under "In … only" into the filters, "Everywhere" does not; reset resets', () => {
    const s = make();
    s.context = inbox;
    s.set({ st: ['u'] });
    s.open('Report', '/mailbox/k1/inbox', true);
    expect(s.sf).toEqual({ ...SF0, st: ['u'], folder: 'role:inbox', account: 'k1' });
    expect([s.q, s.back, s.filtered]).toEqual(['Report', '/mailbox/k1/inbox', true]);
    expect(s.chips.map((c) => c.label)).toEqual(['Account: k1@example.com', 'Folder: Inbox', 'Unread']);
    expect(s.close()).toBe('/mailbox/k1/inbox');
    expect(s.sf).toBe(SF0);
    // A set folder stays, the free account is added.
    s.set({ folder: 'role:trash' });
    s.open('Report', null, true);
    expect([s.sf.folder, s.sf.account]).toEqual(['role:trash', 'k1']);
    s.close();
    s.scope = 'all';
    s.open('Report', null, true);
    expect(s.sf).toBe(SF0);
    s.context = null;
    s.scope = 'here';
    s.open('Report', null, true);
    expect(s.sf).toBe(SF0);
    // Without the suggestions (palette) the area does not apply.
    s.context = inbox;
    s.open('Report', null);
    expect(s.sf).toBe(SF0);
    s.scope = 'all';
    // The same area as a new object changes nothing, a different one replaces it.
    s.context = inbox;
    s.setContext({ ...inbox, patch: { ...inbox.patch } });
    expect(s.context).toBe(inbox);
    s.setContext(null);
    expect(s.context).toBeNull();
    s.context = inbox;
    s.reset();
    expect([s.scope, s.context, s.here]).toEqual(['here', null, null]);
  });
});
