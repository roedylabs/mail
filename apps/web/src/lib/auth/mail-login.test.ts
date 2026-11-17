import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { MailLogin, formOf } from './mail-login.svelte.ts';
import { savePending, type MailServer, type Pending } from './stalwart-login.ts';

const APP = 'https://app.example.com';
const MAIL = 'https://mail.example.com';
const NOW = Date.parse('2026-10-27T12:00:00Z');

const SERVER: MailServer = {
  id: 's1',
  label: 'Example',
  url: MAIL,
  host: 'mail.example.com',
  domains: ['example.com'],
  client_id: 'roedy',
  backend_exchange: false,
  reach: 'ok',
  cors: 'ok',
  oauth: 'ok',
};
const SERVERS = { servers: [SERVER], allow_custom_servers: false };
const METADATA = {
  issuer: MAIL,
  authorization_endpoint: `${MAIL}/login`,
  token_endpoint: `${MAIL}/auth/token`,
};

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1',
    email: 'max@example.com',
    username: 'max@example.com',
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

function pending(overrides: Partial<Pending> = {}): Pending {
  return {
    state: 'st',
    verifier: 'v'.repeat(43),
    purpose: { kind: 'new' },
    form: { email: 'max@example.com', srv: 's1', url: '', auth: 'oauth' },
    url: MAIL,
    serverId: 's1',
    clientId: 'roedy',
    backendExchange: true,
    issuer: MAIL,
    tokenEndpoint: METADATA.token_endpoint,
    issRequired: false,
    redirectUri: `${APP}/oauth/callback`,
    created: NOW,
    user: 'u1',
    ...overrides,
  };
}

let assigned: string[] = [];
let now = NOW;
let user: string | null = 'u1';

function login(): MailLogin {
  return new MailLogin(() => ({
    fetch: (input, init) => fetch(input, init),
    storage: sessionStorage,
    assign: (url) => assigned.push(url),
    now: () => now,
    origin: APP,
    user: () => user,
  }));
}

beforeEach(() => {
  assigned = [];
  now = NOW;
  user = 'u1';
  sessionStorage.clear();
  accounts.reset();
  // Signed in without a mail account: list loaded and empty.
  accounts.list = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('add account', () => {
  it('connects an access token and remembers the new account', async () => {
    const created = account({ id: 'a2', email: 'eva@example.com', auth_kind: 'token' });
    mockApi({ 'GET servers': [{ body: SERVERS }], 'POST mail-accounts': [{ status: 201, body: created }] });
    const ml = login();
    ml.add.open();
    ml.add.update({ email: 'eva@example.com', auth: 'token', token: 'secret' });
    const run = ml.add.submit();
    expect(ml.add.form?.busy).toBe(true);
    await run;
    expect(ml.add.form).toMatchObject({ step: 'done', busy: false, done: 'a2', as: 'eva@example.com', token: '' });
    expect(accounts.list?.map((a) => a.id)).toEqual(['a2']);
    expect(ml.servers).toEqual(SERVERS);
  });

  it('reports errors before the redirect without a request to the mail server', async () => {
    const { calls } = mockApi({ 'GET servers': [{ body: SERVERS }] });
    const ml = login();
    ml.add.open();
    ml.add.update({ email: 'max@other.example' });
    await ml.add.submit();
    expect(ml.add.form).toMatchObject({ step: 'cred', busy: false, err: 'nosrv' });
    expect(calls.map((c) => c.path)).toEqual(['servers']);
    ml.add.update({ email: 'max@example.com' });
    expect(ml.add.form?.err).toBeNull();
  });

  it('stays in the loading state after the redirect until the page comes back from the cache', async () => {
    mockApi({
      'GET servers': [{ body: SERVERS }],
      [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [{ body: METADATA }],
    });
    const ml = login();
    const detach = ml.attach(window);
    ml.add.open();
    ml.add.update({ email: 'max@example.com' });
    await ml.add.submit();
    expect(assigned).toHaveLength(1);
    expect(ml.add.form?.busy).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(ml.add.form?.busy).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(ml.add.form).toMatchObject({ busy: false, step: 'cred', err: null });
    detach();
  });

  it('keeps the form closed after closing, but takes over the created account', async () => {
    let release: ((value: { status: number; body: unknown }) => void) | null = null;
    mockApi({
      'GET servers': [{ body: SERVERS }],
      'POST mail-accounts': [() => new Promise((resolve) => (release = resolve))],
      'GET mail-accounts': [{ body: { accounts: [account({ id: 'a2' })] } }],
    });
    accounts.reset();
    const ml = login();
    ml.add.open();
    ml.add.update({ email: 'eva@example.com', auth: 'token', token: 't' });
    const run = ml.add.submit();
    await vi.waitFor(() => expect(release).not.toBeNull());
    ml.add.close();
    release!({ status: 201, body: account({ id: 'a2' }) });
    await run;
    expect(ml.add.form).toBeNull();
    // The list was unknown: reloaded, with the new account.
    await vi.waitFor(() => expect(accounts.list?.map((a) => a.id)).toEqual(['a2']));
  });

  it('does not redirect if the form closes while the metadata is fetched', async () => {
    let release: ((value: { body: unknown }) => void) | null = null;
    mockApi({
      'GET servers': [{ body: SERVERS }],
      [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [() => new Promise((resolve) => (release = resolve))],
    });
    const ml = login();
    ml.add.open();
    ml.add.update({ email: 'max@example.com' });
    const run = ml.add.submit();
    await vi.waitFor(() => expect(release).not.toBeNull());
    ml.add.close();
    release!({ body: METADATA });
    await run;
    expect(assigned).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows general errors via failure', async () => {
    mockApi({
      'GET servers': [{ body: SERVERS }],
      'POST mail-accounts': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }],
    });
    const ml = login();
    ml.add.open();
    ml.add.update({ email: 'eva@example.com', auth: 'token', token: 't' });
    await ml.add.submit();
    expect(ml.add.form?.err).toBeNull();
    expect(ml.add.form?.failure).toBeInstanceOf(ApiError);
  });
});

describe('return via /oauth/callback', () => {
  it('opens the empty form with expired without a known attempt', () => {
    const ml = login();
    ml.re.open(account());
    expect(ml.receive(new URL(`${APP}/oauth/callback?code=c&state=unknown`))).toEqual({ kind: 'new' });
    expect(ml.add.form).toMatchObject({ email: '', srv: 'auto', step: 'cred', err: 'expired' });
    expect(ml.re.form).toBeNull();
  });

  it('treats the attempt of another app user as unknown, without its details', async () => {
    const { calls } = mockApi({});
    savePending(pending({ purpose: { kind: 're', account: 'a1' } }), sessionStorage);
    user = 'u2';
    const ml = login();
    expect(ml.receive(new URL(`${APP}/oauth/callback?code=c&state=st`))).toEqual({ kind: 'new' });
    expect(ml.add.form).toMatchObject({ email: '', srv: 'auto', step: 'cred', err: 'expired' });
    expect(ml.re.form).toBeNull();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it('shows the return step and completes the sign-in', async () => {
    const { calls } = mockApi({ 'POST mail-accounts': [{ status: 201, body: account() }] });
    savePending(pending(), sessionStorage);
    const ml = login();
    expect(ml.receive(new URL(`${APP}/oauth/callback?code=c&state=st`))).toEqual({ kind: 'new' });
    expect(ml.add.form).toMatchObject({ step: 'ret', email: 'max@example.com', srv: 's1', busy: false });
    await vi.waitFor(() => expect(ml.add.form?.step).toBe('done'));
    expect(calls[0]?.body).toEqual({
      email: 'max@example.com',
      server_id: 's1',
      auth_kind: 'oauth',
      code: 'c',
      code_verifier: 'v'.repeat(43),
      client_id: 'roedy',
      user_id: 'u1',
    });
    expect(accounts.count).toBe(1);
    // The attempt is used up.
    expect(ml.receive(new URL(`${APP}/oauth/callback?code=c&state=st`))).toEqual({ kind: 'new' });
  });

  it('fills the form after an error with the details from before the redirect', async () => {
    savePending(pending(), sessionStorage);
    const ml = login();
    ml.receive(new URL(`${APP}/oauth/callback?error=access_denied&state=st`));
    await vi.waitFor(() => expect(ml.add.form?.step).toBe('cred'));
    expect(ml.add.form).toMatchObject({ email: 'max@example.com', srv: 's1', err: 'denied', sErr: 'access_denied' });
  });

  it('reports a different account when signing in again', async () => {
    mockApi({
      'POST mail-accounts/a1/reauth': [
        { status: 409, body: { error: 'other_account', account: { email: 'eva@example.com' } } },
      ],
    });
    savePending(pending({ purpose: { kind: 're', account: 'a1' } }), sessionStorage);
    const ml = login();
    expect(ml.receive(new URL(`${APP}/oauth/callback?code=c&state=st`))).toEqual({ kind: 're', account: 'a1' });
    expect(ml.re.account).toBe('a1');
    await vi.waitFor(() => expect(ml.re.form?.err).toBe('other'));
    expect(ml.re.form?.as).toBe('eva@example.com');
  });

  it('locks after 429 with a readable wait time until it ends', async () => {
    // `mockApi` sets no headers; the token endpoint answers by itself here.
    mockApi({});
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })),
    );
    savePending(pending({ backendExchange: false }), sessionStorage);
    const ml = login();
    ml.receive(new URL(`${APP}/oauth/callback?code=c&state=st`));
    await vi.waitFor(() => expect(ml.add.form?.err).toBe('rate'));
    expect(ml.add.form?.rl).toBe(true);
    expect(ml.add.lockUntil).toBe(NOW + 30_000);
    await ml.add.submit(NOW + 10_000);
    expect(ml.add.form?.busy).toBe(false);
    ml.reset();
    expect(ml.add.lockUntil).toBe(0);
  });
});

describe('sign in again', () => {
  it('takes over address, server and sign-in method of the account', () => {
    expect(formOf(account())).toEqual({ email: 'max@example.com', srv: 's1', url: '', auth: 'oauth', token: '' });
    expect(formOf(account({ server_id: null, url: 'https://own.example', auth_kind: 'token' }))).toEqual({
      email: 'max@example.com',
      srv: 'other',
      url: 'https://own.example',
      auth: 'token',
      token: '',
    });
  });

  it('replaces the account after signing in again with an access token', async () => {
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [account({ auth_kind: 'token', state: 'needs_reauth' })] } }],
      'GET servers': [{ body: SERVERS }],
      'POST mail-accounts/a1/reauth': [{ body: account({ auth_kind: 'token' }) }],
    });
    await accounts.load();
    const ml = login();
    ml.re.open(accounts.get('a1'));
    ml.re.update({ token: 'new' });
    await ml.re.submit();
    expect(ml.re.form?.step).toBe('done');
    expect(accounts.get('a1')?.state).toBe('ok');
  });
});
