import { JmapClient } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import {
  CONTACTS_STALE_MS,
  Contacts,
  fold,
  jmapContactsApi,
  mergeContacts,
  type ContactsApi,
  type Person,
  type SentEmail,
} from '#lib/state/contacts.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';

const p = (name: string, email: string): Person => ({ name, email });

function fakeApi(overrides: Partial<ContactsApi> = {}) {
  const api: ContactsApi = {
    directory: vi.fn(() => Promise.resolve([p('Anna Becker', 'anna@team.test'), p('Me Myself', 'me@team.test')])),
    accounts: vi.fn(() =>
      Promise.resolve([
        { id: 'k1', ready: true },
        { id: 'k2', ready: true },
      ]),
    ),
    sent: vi.fn((account: string) =>
      Promise.resolve<SentEmail[]>(
        account === 'k1'
          ? [
              { at: 2000, to: [p('', 'jonas@example.com'), p('Lea Fischer', 'lea@example.com')] },
              { at: 1000, to: [p('Jonas Wagner', 'Jonas@example.com')] },
            ]
          : [{ at: 3000, to: [p('', 'lea@example.com')] }],
      ),
    ),
    cards: vi.fn((account: string) => Promise.resolve(account === 'k2' ? [p('Chloë Cruz', 'chloe@example.com')] : [])),
    ...overrides,
  };
  return api;
}

describe('Contacts: helpers', () => {
  it('compares in lower case, umlauts spelled out, without accents', () => {
    expect(fold('J\u00fcrgen Gr\u00f6\u00dfe')).toBe('juergen groesse');
    expect(fold('\u00d6mer \u00c7elik')).toBe('oemer celik');
    expect(fold('René')).toBe('rene');
  });

  it('merges sources per address and orders by frequency, then last sent', () => {
    const list = mergeContacts(
      [
        { at: 1000, to: [p('Jonas Wagner', 'jonas@example.com'), p('', 'lea@example.com')] },
        { at: 3000, to: [p('', 'JONAS@example.com'), p('ben@example.com', 'ben@example.com')] },
        { at: 2000, to: [p('Lea', 'lea@example.com')] },
      ],
      [p('Zoe Adler', 'zoe@team.test'), p('Anna Becker', 'anna@team.test'), p('Benjamin', 'ben@example.com')],
    );
    expect(list.map((c) => [c.name, c.email, c.count, c.at])).toEqual([
      // The spelling of the newest email stays, the name comes from the older one.
      ['Jonas Wagner', 'JONAS@example.com', 2, 3000],
      ['Lea', 'lea@example.com', 2, 2000],
      // An address as name does not count as a name.
      ['Benjamin', 'ben@example.com', 1, 3000],
      ['Anna Becker', 'anna@team.test', 0, 0],
      ['Zoe Adler', 'zoe@team.test', 0, 0],
    ]);
    expect(list[0]?.match).toBe('jonas wagner\njonas@example.com');
  });

  it('counts an address once per email and skips entries without an address', () => {
    const broken = { name: 'Kaputt' } as unknown as Person;
    const list = mergeContacts(
      [{ at: 1, to: [p('Lea', 'lea@example.com'), p('', 'LEA@example.com'), broken] }],
      [broken, p(null as unknown as string, 'ben@example.com')],
    );
    expect(list.map((c) => [c.name, c.email, c.count])).toEqual([
      ['Lea', 'lea@example.com', 1],
      ['', 'ben@example.com', 0],
    ]);
  });
});

describe('Contacts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
    session.user = { email: 'Me@team.test' } as Me;
  });
  afterEach(() => {
    session.user = null;
    vi.useRealTimers();
  });

  it('loads directory, recent recipients and contact cards of all accounts, without the own entry', async () => {
    const api = fakeApi();
    const c = new Contacts(api);
    await c.ensure();
    expect(c.list.map((x) => [x.name, x.email, x.count])).toEqual([
      ['Lea Fischer', 'lea@example.com', 2],
      ['Jonas Wagner', 'jonas@example.com', 2],
      ['Anna Becker', 'anna@team.test', 0],
      ['Chloë Cruz', 'chloe@example.com', 0],
    ]);
    expect(api.sent).toHaveBeenCalledTimes(2);
    expect(api.cards).toHaveBeenCalledTimes(2);
  });

  it('suggests at most five, by name or address, without the skipped ones', async () => {
    const c = new Contacts(fakeApi());
    await c.ensure();
    expect(c.suggest('  ', () => false)).toEqual([]);
    expect(c.suggest('chloe', () => false).map((x) => x.email)).toEqual(['chloe@example.com']);
    expect(c.suggest('Chlo\u00eb', () => false).map((x) => x.email)).toEqual(['chloe@example.com']);
    expect(c.suggest('example', (e) => e === 'lea@example.com').map((x) => x.email)).toEqual([
      'jonas@example.com',
      'chloe@example.com',
    ]);
    c.list = mergeContacts(
      [],
      Array.from({ length: 8 }, (_, i) => p(`Person ${i}`, `p${i}@example.com`)),
    );
    expect(c.suggest('person', () => false)).toHaveLength(5);
    // Name and address are separate: no match across the boundary.
    expect(c.suggest('0p0', () => false)).toEqual([]);
  });

  it('finds the name for an address case-insensitively', async () => {
    const c = new Contacts(fakeApi());
    await c.ensure();
    expect(c.find(' LEA@example.com ')?.name).toBe('Lea Fischer');
    expect(c.find('never@example.com')).toBeUndefined();
  });

  it('reloads only after five minutes; failed sources keep their state', async () => {
    const api = fakeApi();
    const c = new Contacts(api);
    await Promise.all([c.ensure(), c.ensure()]);
    expect(api.directory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CONTACTS_STALE_MS - 1);
    await c.ensure();
    expect(api.directory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(api.directory).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(api.sent).mockImplementation((account) =>
      account === 'k1' ? Promise.reject(new Error('offline')) : Promise.resolve([]),
    );
    vi.mocked(api.accounts).mockResolvedValueOnce([{ id: 'k1', ready: true }]);
    await c.ensure();
    expect(api.directory).toHaveBeenCalledTimes(2);
    // k1 keeps its recent recipients, k2 is gone (its contact card too).
    expect(c.list.map((x) => [x.email, x.count])).toEqual([
      ['jonas@example.com', 2],
      ['lea@example.com', 1],
      ['anna@team.test', 0],
    ]);
  });

  it('keeps the sources of an account with "sign-in required" without reading it', async () => {
    const api = fakeApi();
    const c = new Contacts(api);
    await c.ensure();
    vi.mocked(api.accounts).mockResolvedValueOnce([
      { id: 'k1', ready: true },
      { id: 'k2', ready: false },
    ]);
    await vi.advanceTimersByTimeAsync(CONTACTS_STALE_MS);
    await c.ensure();
    expect(api.sent).toHaveBeenCalledTimes(3);
    expect(api.sent).toHaveBeenLastCalledWith('k1');
    expect(c.find('chloe@example.com')?.name).toBe('Chloë Cruz');
    expect(c.find('lea@example.com')?.count).toBe(2);
  });

  it('tries again on the next focus if everything failed', async () => {
    const fail = () => Promise.reject(new Error('offline'));
    const api = fakeApi({ directory: vi.fn(fail), accounts: vi.fn(fail) });
    const c = new Contacts(api);
    await c.ensure();
    expect(c.list).toEqual([]);
    await c.ensure();
    expect(api.directory).toHaveBeenCalledTimes(2);
  });

  it('counts recipients immediately after sending until "Sent" is reloaded', async () => {
    const api = fakeApi({ sent: vi.fn(() => Promise.resolve([])), cards: vi.fn(() => Promise.resolve([])) });
    const c = new Contacts(api);
    await c.ensure();
    c.remember([p('New Person', 'new@example.com'), p('', 'anna@team.test')]);
    expect(c.list.map((x) => [x.email, x.count])).toEqual([
      ['anna@team.test', 1],
      ['new@example.com', 1],
    ]);
    // If "Sent" of an account fails, the remembered recipients stay.
    await vi.advanceTimersByTimeAsync(CONTACTS_STALE_MS);
    vi.mocked(api.sent).mockRejectedValueOnce(new Error('offline'));
    await c.ensure();
    expect(c.find('new@example.com')?.count).toBe(1);
    await vi.advanceTimersByTimeAsync(CONTACTS_STALE_MS);
    vi.mocked(api.sent).mockResolvedValueOnce([{ at: 10_000, to: [p('New Person', 'new@example.com')] }]);
    await c.ensure();
    expect(c.list.map((x) => [x.email, x.count])).toEqual([
      ['new@example.com', 1],
      ['anna@team.test', 0],
    ]);
  });

  it('discards everything on sign-out, also a running load', async () => {
    let release = () => {};
    const api = fakeApi({
      directory: vi.fn(
        () =>
          new Promise<Person[]>((resolve) => {
            release = () => resolve([p('Anna', 'anna@team.test')]);
          }),
      ),
    });
    const c = new Contacts(api);
    const loading = c.ensure();
    c.reset();
    release();
    await loading;
    expect(c.list).toEqual([]);
    const again = c.ensure();
    release();
    await again;
    expect(api.directory).toHaveBeenCalledTimes(2);
    expect(c.list.map((x) => x.email)).toContain('anna@team.test');
  });
});

describe('jmapContactsApi', () => {
  const MAIL = 'https://mail.example.com';
  const MAIL_CAP = 'urn:ietf:params:jmap:mail';
  const CONTACTS_CAP = 'urn:ietf:params:jmap:contacts';
  type Invocation = [string, Record<string, unknown>, string];

  function server(answer: (call: Invocation) => unknown, contacts = true, primary = contacts) {
    const seen: Invocation[] = [];
    const using: string[][] = [];
    const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const req = JSON.parse(init.body as string) as { using: string[]; methodCalls: Invocation[] };
      using.push(req.using);
      const methodResponses = req.methodCalls.map((call) => {
        seen.push(call);
        return [call[0], answer(call), call[2]];
      });
      return Promise.resolve(
        new Response(JSON.stringify({ methodResponses, sessionState: 's1' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const client = new JmapClient({
      url: MAIL,
      tokens: { token: () => Promise.resolve('t1') },
      session: {
        capabilities: {
          'urn:ietf:params:jmap:core': {
            maxSizeUpload: 1000,
            maxConcurrentUpload: 2,
            maxSizeRequest: 100_000,
            maxConcurrentRequests: 4,
            maxCallsInRequest: 16,
            maxObjectsInGet: 150,
            maxObjectsInSet: 100,
            collationAlgorithms: [],
          },
          [MAIL_CAP]: {},
          ...(contacts ? { [CONTACTS_CAP]: {} } : {}),
        },
        accounts: {},
        primaryAccounts: { [MAIL_CAP]: 'j1', ...(primary ? { [CONTACTS_CAP]: 'c1' } : {}) },
        username: 'k1@example.com',
        apiUrl: `${MAIL}/jmap/`,
        downloadUrl: `${MAIL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        uploadUrl: `${MAIL}/jmap/upload/{accountId}/`,
        eventSourceUrl: `${MAIL}/jmap/eventsource/`,
        state: 's1',
      },
      fetch,
    });
    return { client, seen, using };
  }

  afterEach(() => {
    accounts.list = null;
    vi.unstubAllGlobals();
  });

  it('reads the recent emails in "Sent" with all recipients', async () => {
    const { client, seen } = server(([name]) =>
      name === 'Email/query'
        ? { accountId: 'j1', ids: ['e1', 'e2'], position: 0, queryState: 'q1', canCalculateChanges: false }
        : {
            accountId: 'j1',
            state: 'e1',
            notFound: [],
            list: [
              {
                id: 'e1',
                receivedAt: '2026-11-01T09:00:00Z',
                to: [{ name: 'Lea Fischer ', email: 'lea@example.com' }],
                cc: null,
                bcc: [{ name: null, email: 'ben@example.com' }],
              },
              {
                id: 'e2',
                receivedAt: 'broken',
                to: null,
                cc: [{ name: 'Jonas', email: 'jonas@example.com' }],
                bcc: null,
              },
            ],
          },
    );
    const api = jmapContactsApi(
      () => Promise.resolve(client),
      () => Promise.resolve('se'),
    );
    expect(await api.sent('k1')).toEqual([
      { at: Date.UTC(2026, 10, 1, 9), to: [p('Lea Fischer', 'lea@example.com'), p('', 'ben@example.com')] },
      { at: 0, to: [p('Jonas', 'jonas@example.com')] },
    ]);
    expect(seen[0]?.[1]).toMatchObject({
      accountId: 'j1',
      filter: { inMailbox: 'se' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      // At most 200, but not more than the server's `maxObjectsInGet`.
      limit: 150,
    });
    expect(seen[1]?.[1]).toMatchObject({ properties: ['to', 'cc', 'bcc', 'receivedAt'] });
  });

  it('no recipients and no request without "Sent"', async () => {
    const { client, seen } = server(() => ({}));
    const api = jmapContactsApi(
      () => Promise.resolve(client),
      () => Promise.resolve(null),
    );
    expect(await api.sent('k1')).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('reads contact cards via JMAP for Contacts, otherwise nothing', async () => {
    const { client, seen, using } = server(([name]) =>
      name === 'ContactCard/query'
        ? { accountId: 'c1', ids: ['c1', 'c2'], position: 0, queryState: 'q1', canCalculateChanges: false }
        : {
            accountId: 'c1',
            state: 'c1',
            notFound: [],
            list: [
              {
                id: 'c1',
                name: {
                  components: [
                    { kind: 'title', value: 'Dr.' },
                    { kind: 'given', value: 'Anna' },
                    { kind: 'surname', value: 'Becker' },
                  ],
                },
                emails: { a: { address: 'anna@example.com' }, b: { address: 'anna.b@work.test', pref: 1 } },
              },
              { id: 'c2', name: { full: ' Ben White ' }, emails: null },
              { id: 'c3', name: null, emails: { a: { address: 'none@example.com' }, b: { pref: 1 } } },
            ],
          },
    );
    const api = jmapContactsApi(
      () => Promise.resolve(client),
      () => Promise.resolve(null),
    );
    expect(await api.cards('k1')).toEqual([
      p('Anna Becker', 'anna@example.com'),
      p('Anna Becker', 'anna.b@work.test'),
      p('', 'none@example.com'),
    ]);
    expect(seen[0]?.[1]).toEqual({ accountId: 'c1', limit: 150 });
    expect(seen[1]?.[1]).toMatchObject({ accountId: 'c1', properties: ['name', 'emails'] });
    expect(using[0]).toContain(CONTACTS_CAP);

    const without = server(() => ({}), false);
    const plain = jmapContactsApi(
      () => Promise.resolve(without.client),
      () => Promise.resolve(null),
    );
    expect(await plain.cards('k1')).toEqual([]);
    expect(without.seen).toEqual([]);

    // Server capability without an account for it (token without scope contacts): silently empty as well.
    const unassigned = server(() => ({}), true, false);
    const none = jmapContactsApi(
      () => Promise.resolve(unassigned.client),
      () => Promise.resolve(null),
    );
    expect(await none.cards('k1')).toEqual([]);
    expect(unassigned.seen).toEqual([]);
  });

  it('reads the directory and only accounts without "sign-in required"', async () => {
    const { calls } = mockApi({ 'GET directory': [{ body: { users: [p('Anna Becker', 'anna@team.test')] } }] });
    accounts.list = [{ id: 'k1', state: 'ok' } as MailAccount, { id: 'k2', state: 'needs_reauth' } as MailAccount];
    const api = jmapContactsApi();
    expect(await api.directory()).toEqual([p('Anna Becker', 'anna@team.test')]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET directory']);
    expect(await api.accounts()).toEqual([
      { id: 'k1', ready: true },
      { id: 'k2', ready: false },
    ]);
  });
});
