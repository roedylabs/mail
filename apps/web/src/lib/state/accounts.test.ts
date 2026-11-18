import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from './fetch-mock.ts';
import { Accounts, colorOf, markedDefaultOf, tilesOf, type MailAccount } from './accounts.svelte.ts';

const MAIL = 'https://mail.example.com';
const CORE = 'urn:ietf:params:jmap:core';
const MAIL_CAP = 'urn:ietf:params:jmap:mail';

function account(id: string, overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    url: MAIL,
    host: 'mail.example.com',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
    ...overrides,
  };
}

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

const grant = (token: string) => ({ accessToken: token, expiresAt: '2099-01-01T00:00:00Z', session: SESSION });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accounts', () => {
  it('knows the count only after loading and loads only once with ensure', async () => {
    const { calls } = mockApi({ 'GET mail-accounts': [{ body: { accounts: [account('a1'), account('a2')] } }] });
    const accounts = new Accounts();
    expect(accounts.count).toBeNull();
    await Promise.all([accounts.ensure(), accounts.ensure()]);
    await accounts.ensure();
    expect(calls).toHaveLength(1);
    expect(accounts.count).toBe(2);
    expect(accounts.get('a2')?.email).toBe('a2@example.com');
    accounts.reset();
    expect(accounts.count).toBeNull();
  });

  it('marks a failed load until the next successful one, without a count', async () => {
    mockApi({
      'GET mail-accounts': [{ status: 500, body: { error: 'internal' } }, { body: { accounts: [account('a1')] } }],
    });
    const accounts = new Accounts();
    expect(accounts.failed).toBe(false);
    await expect(accounts.ensure()).rejects.toThrow();
    expect(accounts.failed).toBe(true);
    expect(accounts.count).toBeNull();
    await accounts.ensure();
    expect(accounts.failed).toBe(false);
    expect(accounts.count).toBe(1);
  });

  it('clears a failed load when a new one starts and on sign-out', async () => {
    let answer: (a: { body: unknown }) => void = () => {};
    mockApi({
      'GET mail-accounts': [
        { status: 500, body: { error: 'internal' } },
        () => new Promise((resolve) => (answer = resolve)),
        { status: 500, body: { error: 'internal' } },
      ],
    });
    const accounts = new Accounts();
    await expect(accounts.load()).rejects.toThrow();
    expect(accounts.failed).toBe(true);
    // Retry: not failed while it runs.
    const retry = accounts.load();
    expect(accounts.failed).toBe(false);
    answer({ body: { accounts: [account('a1')] } });
    await retry;
    // A failed refresh keeps the list.
    await expect(accounts.load()).rejects.toThrow();
    expect(accounts.failed).toBe(true);
    expect(accounts.count).toBe(1);
    accounts.reset();
    expect(accounts.failed).toBe(false);
  });

  it('reloads when an account arrives during loading or before the first load', async () => {
    let release: (value: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'GET mail-accounts': [
        () => new Promise((resolve) => (release = resolve)),
        { body: { accounts: [account('a1'), account('new')] } },
        { body: { accounts: [account('a1'), account('b')] } },
      ],
    });
    const accounts = new Accounts();
    const loading = accounts.load();
    accounts.put(account('new'));
    // The response of the older load does not know the new account and expires.
    release({ body: { accounts: [account('a1')] } });
    await loading;
    await vi.waitFor(() => expect(accounts.list?.map((a) => a.id)).toEqual(['a1', 'new']));
    // Without a known list, no half list with only the new account.
    accounts.reset();
    accounts.put(account('b'));
    expect(accounts.list).toBeNull();
    await vi.waitFor(() => expect(accounts.list?.map((a) => a.id)).toEqual(['a1', 'b']));
    expect(calls).toHaveLength(3);
  });

  it('fetches tokens via the broker and renews after rejection', async () => {
    const { calls } = mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1')] } }],
      'GET mail-accounts/a1/token': [{ body: grant('t1') }],
      'GET mail-accounts/a1/token?refresh=true': [{ body: grant('t2') }],
    });
    const accounts = new Accounts();
    await accounts.load();
    const tokens = accounts.tokens('a1');
    expect(accounts.tokens('a1')).toBe(tokens);
    expect(await tokens.token()).toBe('t1');
    expect(await tokens.token({ rejected: 't1' })).toBe('t2');
    expect(calls.map((c) => c.path)).toEqual([
      'mail-accounts',
      'mail-accounts/a1/token',
      'mail-accounts/a1/token?refresh=true',
    ]);
  });

  it('shows needs_reauth and blocked from the broker in the list', async () => {
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1'), account('a2')] } }],
      'GET mail-accounts/a1/token': [{ status: 409, body: { error: 'needs_reauth' } }],
      'GET mail-accounts/a2/token': [{ status: 409, body: { error: 'blocked' } }],
    });
    const accounts = new Accounts();
    await accounts.load();
    await expect(accounts.tokens('a1').token()).rejects.toMatchObject({ code: 'needs_reauth' });
    await expect(accounts.tokens('a2').token()).rejects.toMatchObject({ code: 'blocked' });
    expect(accounts.get('a1')?.state).toBe('needs_reauth');
    expect(accounts.get('a2')?.blocked).toBe(true);
  });

  it('builds the JMAP client with the broker session', async () => {
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1')] } }],
      'GET mail-accounts/a1/token': [
        { status: 502, body: { error: 'refresh_failed', reason: 'unreachable' } },
        { body: grant('t1') },
      ],
    });
    const accounts = new Accounts();
    await accounts.load();
    await expect(accounts.client('a1')).rejects.toMatchObject({ code: 'refresh_failed' });
    const client = await accounts.client('a1');
    expect(await accounts.client('a1')).toBe(client);
    expect(client.currentSession?.apiUrl).toBe(`${MAIL}/jmap/`);
    await expect(accounts.client('missing')).rejects.toThrow('Unknown mail account');
  });

  it('replaces a re-authenticated account and then fetches a new token', async () => {
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1', { state: 'needs_reauth' })] } }],
      'GET mail-accounts/a1/token': [{ body: grant('old') }, { body: grant('new') }],
    });
    const accounts = new Accounts();
    await accounts.load();
    expect(await accounts.tokens('a1').token()).toBe('old');
    accounts.put(account('a1'));
    expect(accounts.count).toBe(1);
    expect(accounts.get('a1')?.state).toBe('ok');
    expect(await accounts.tokens('a1').token()).toBe('new');
  });

  it('takes the color from MA_COLORS, otherwise the first', () => {
    expect(colorOf({ color: 2 })).toEqual({ bg: '#b0a2f2', ink: '#21134d' });
    expect(colorOf({ color: 9 })).toEqual({ bg: '#f5a06e', ink: '#3a1b06' });
  });
});

describe('Start without network', () => {
  it('takes over the copy without a request, `ensure` then loads nothing', async () => {
    const { calls } = mockApi({});
    const accounts = new Accounts();
    accounts.fromCopy([account('a1')]);
    await accounts.ensure();
    expect(accounts.list?.map((a) => a.id)).toEqual(['a1']);
    expect(calls).toHaveLength(0);
  });
});

describe('Remove account', () => {
  it('hides an account, also after reloading, and brings it back to its place', async () => {
    const list = { accounts: [account('a1'), account('a2'), account('a3')] };
    mockApi({ 'GET mail-accounts': [{ body: list }, { body: list }] });
    const accounts = new Accounts();
    await accounts.load();
    expect(accounts.hide('a2')).toBe(true);
    expect(accounts.hide('a2')).toBe(false);
    expect(accounts.hide('missing')).toBe(false);
    await accounts.load();
    expect(accounts.list?.map((a) => a.id)).toEqual(['a1', 'a3']);
    accounts.restore('a2');
    expect(accounts.list?.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('undo brings back the server state, but not an account already removed there', async () => {
    mockApi({
      'GET mail-accounts': [
        { body: { accounts: [account('a1'), account('a2')] } },
        { body: { accounts: [account('a1', { state: 'needs_reauth' })] } },
      ],
    });
    const accounts = new Accounts();
    await accounts.load();
    accounts.hide('a1');
    accounts.hide('a2');
    await accounts.load();
    accounts.restore('a1');
    accounts.restore('a2');
    expect(accounts.list?.map((a) => [a.id, a.state])).toEqual([['a1', 'needs_reauth']]);
  });

  it('shows a hidden account after put() only with undo and forgets it on sign-out', async () => {
    const list = { accounts: [account('a1')] };
    mockApi({ 'GET mail-accounts': [{ body: list }, { body: list }] });
    const accounts = new Accounts();
    await accounts.load();
    accounts.hide('a1');
    accounts.put(account('a1', { color: 3 }));
    expect(accounts.get('a1')).toBeUndefined();
    accounts.restore('a1');
    expect(accounts.get('a1')?.color).toBe(3);
    accounts.hide('a1');
    accounts.reset();
    await accounts.load();
    expect(accounts.get('a1')).toBeDefined();
  });

  it('removes at the server, forgets the token and treats 404 as removed', async () => {
    const { calls } = mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1'), account('a2')] } }],
      'GET mail-accounts/a1/token': [{ body: grant('t1') }],
      'DELETE mail-accounts/a1': [{ status: 204 }],
      'DELETE mail-accounts/a2': [{ status: 404, body: { error: 'not_found' } }],
    });
    const accounts = new Accounts();
    await accounts.load();
    const tokens = accounts.tokens('a1');
    await tokens.token();
    accounts.hide('a1');
    await accounts.remove('a1', true);
    expect(accounts.tokens('a1')).not.toBe(tokens);
    await accounts.remove('a2');
    expect(accounts.count).toBe(0);
    const del = calls.filter((c) => c.method === 'DELETE');
    expect(del.map((c) => c.path)).toEqual(['mail-accounts/a1', 'mail-accounts/a2']);
    // After the rollback there is nothing to bring back.
    accounts.restore('a1');
    expect(accounts.count).toBe(0);
  });

  it('keeps the account if removing fails', async () => {
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [account('a1')] } }],
      'DELETE mail-accounts/a1': [{ status: 500, body: { error: 'internal' } }],
    });
    const accounts = new Accounts();
    await accounts.load();
    await expect(accounts.remove('a1')).rejects.toMatchObject({ status: 500 });
    expect(accounts.get('a1')).toBeDefined();
  });
});

describe('Check connection and color', () => {
  it('takes storage and time of the check', async () => {
    const checked = account('a1', { quota_used: 5, quota_total: 10, last_check_at: '2026-11-03T10:00:00Z' });
    const { calls } = mockApi({ 'POST mail-accounts/a1/check': [{ body: checked }] });
    const accounts = new Accounts();
    accounts.list = [account('a1'), account('a2')];
    await expect(accounts.check('a1')).resolves.toEqual(checked);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST mail-accounts/a1/check']);
    expect(accounts.get('a1')).toEqual(checked);
    expect(accounts.get('a2')?.quota_used).toBeNull();
  });

  it('shows needs_reauth and blocked immediately, other errors change nothing', async () => {
    mockApi({
      'POST mail-accounts/a1/check': [
        { status: 409, body: { error: 'needs_reauth' } },
        { status: 409, body: { error: 'blocked' } },
        { status: 502, body: { error: 'check_failed', reason: 'unreachable' } },
      ],
    });
    const accounts = new Accounts();
    accounts.list = [account('a1')];
    await expect(accounts.check('a1')).rejects.toBeTruthy();
    expect(accounts.get('a1')?.state).toBe('needs_reauth');
    await expect(accounts.check('a1')).rejects.toBeTruthy();
    expect(accounts.get('a1')?.blocked).toBe(true);
    const before = accounts.get('a1');
    await expect(accounts.check('a1')).rejects.toBeTruthy();
    expect(accounts.get('a1')).toEqual(before);
  });

  it('sets the color immediately and rolls it back if saving fails', async () => {
    const { calls } = mockApi({
      'PATCH mail-accounts/a1': [{ body: account('a1', { color: 3 }) }, { status: 500, body: { error: 'internal' } }],
    });
    const accounts = new Accounts();
    accounts.list = [account('a1')];
    const saving = accounts.setColor('a1', 3);
    expect(accounts.get('a1')?.color).toBe(3);
    await saving;
    expect(calls[0]?.body).toEqual({ color: 3 });
    await expect(accounts.setColor('a1', 5)).rejects.toBeTruthy();
    expect(accounts.get('a1')?.color).toBe(3);
    // Same color: no call.
    await accounts.setColor('a1', 3);
    expect(calls).toHaveLength(2);
  });

  it('rolls back to the server color after several failed color choices', async () => {
    let fail: (value: { status: number; body: unknown }) => void = () => {};
    mockApi({
      'PATCH mail-accounts/a1': [
        () => new Promise((resolve) => (fail = resolve)),
        { status: 500, body: { error: 'internal' } },
      ],
    });
    const accounts = new Accounts();
    accounts.list = [account('a1')];
    const first = accounts.setColor('a1', 1);
    await expect(accounts.setColor('a1', 2)).rejects.toBeTruthy();
    expect(accounts.get('a1')?.color).toBe(0);
    fail({ status: 500, body: { error: 'internal' } });
    await expect(first).rejects.toBeTruthy();
    expect(accounts.get('a1')?.color).toBe(0);
  });

  it('keeps a newer color choice if an older one fails, also during a check', async () => {
    let fail: (value: { status: number; body: unknown }) => void = () => {};
    let save: (value: { body: unknown }) => void = () => {};
    mockApi({
      'PATCH mail-accounts/a1': [
        () => new Promise((resolve) => (fail = resolve)),
        () => new Promise((resolve) => (save = resolve)),
      ],
      'POST mail-accounts/a1/check': [{ body: account('a1', { color: 0, quota_used: 1, quota_total: 2 }) }],
    });
    const accounts = new Accounts();
    accounts.list = [account('a1')];
    const first = accounts.setColor('a1', 1);
    const second = accounts.setColor('a1', 2);
    await accounts.check('a1');
    expect(accounts.get('a1')).toMatchObject({ color: 2, quota_used: 1 });
    save({ body: account('a1', { color: 2, quota_used: 1, quota_total: 2 }) });
    await second;
    fail({ status: 500, body: { error: 'internal' } });
    await expect(first).rejects.toBeTruthy();
    expect(accounts.get('a1')).toMatchObject({ color: 2, quota_used: 1 });
  });
});

describe('Default account and tiles', () => {
  const list = [
    { id: 'a1', email: 'a@x.example', color: 0 },
    { id: 'a2', email: 'b@x.example', color: 1 },
  ] as MailAccount[];

  it('marks no account with "All accounts", but with one account that one', () => {
    expect(markedDefaultOf(list, 'a2')?.id).toBe('a2');
    expect(markedDefaultOf(list, null)?.id).toBe('a1');
    expect(markedDefaultOf(list, 'all')).toBeNull();
    // Without "all accounts" (one account) the account stays default.
    expect(markedDefaultOf(list.slice(0, 1), 'all')?.id).toBe('a1');
  });

  it('returns the tiles of the first accounts', () => {
    expect(tilesOf(list, 1)).toEqual([{ letter: 'A', ...colorOf(list[0] as MailAccount) }]);
    expect(tilesOf(list, 4)).toHaveLength(2);
  });
});
