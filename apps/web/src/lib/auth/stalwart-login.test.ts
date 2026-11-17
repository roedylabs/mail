import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '#lib/api.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import {
  CALLBACK_PATH,
  FORM0,
  METADATA_TIMEOUT,
  PENDING_TTL,
  SCOPE,
  begin,
  callbackParams,
  challengeOf,
  check,
  complete,
  failureOf,
  savePending,
  clearPending,
  takeReturning,
  takePending,
  targetOf,
  type LoginDeps,
  type LoginForm,
  type MailServer,
  type Pending,
  type ServerList,
} from './stalwart-login.ts';

const APP = 'https://app.example.com';
const MAIL = 'https://mail.example.com';
const NOW = Date.parse('2026-10-27T12:00:00Z');
/** Signed-in app user who starts the attempts. */
const USER = 'u1';

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
const LIST: ServerList = { servers: [SERVER], allow_custom_servers: false };

const METADATA = {
  issuer: MAIL,
  authorization_endpoint: `${MAIL}/login`,
  token_endpoint: `${MAIL}/auth/token`,
  authorization_response_iss_parameter_supported: true,
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

interface Seen {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

type Reply = Response | Error | ((seen: Seen) => Response);

/**
 * Fake network for the app API (`/api/v1/…`) and mail servers: responses per
 * `METHOD address without query` as a queue; an `Error` is thrown
 * (like a `TypeError` from `fetch`).
 */
function net(routes: Record<string, Reply[]>) {
  const seen: Seen[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, APP);
    const entry: Seen = {
      method: init.method ?? 'GET',
      url: url.href,
      body: init.body === undefined || init.body === null ? '' : String(init.body as string | URLSearchParams),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    seen.push(entry);
    const next = routes[`${entry.method} ${url.origin}${url.pathname}`]?.shift();
    if (!next) return Promise.reject(new Error(`no response for ${entry.method} ${url.href}`));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === 'function' ? next(entry) : next);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function deps(fetch: typeof globalThis.fetch, user: string | null = USER): LoginDeps & { assigned: string[] } {
  const assigned: string[] = [];
  return {
    fetch,
    storage: sessionStorage,
    assign: (url) => assigned.push(url),
    now: () => NOW,
    origin: APP,
    user: () => user,
    assigned,
  };
}

const api = (path: string) => `${APP}/api/v1/${path}`;
const form = (patch: Partial<LoginForm> = {}): LoginForm => ({ ...FORM0, email: 'max@example.com', ...patch });

function pending(overrides: Partial<Pending> = {}): Pending {
  return {
    state: 'st',
    verifier: 'v'.repeat(43),
    purpose: { kind: 'new' },
    form: { email: 'max@example.com', srv: 'auto', url: '', auth: 'oauth' },
    url: MAIL,
    serverId: 's1',
    clientId: 'roedy',
    backendExchange: false,
    issuer: MAIL,
    tokenEndpoint: METADATA.token_endpoint,
    issRequired: true,
    redirectUri: APP + CALLBACK_PATH,
    created: NOW,
    user: USER,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('determine the server', () => {
  it('assigns via the domain, the list or an own address', () => {
    expect(targetOf(form(), LIST)).toEqual({ url: MAIL, server: SERVER });
    expect(targetOf(form({ email: 'max@other.example' }), LIST)).toBeNull();
    expect(targetOf(form({ email: 'max@other.example', srv: 's1' }), LIST)?.server).toBe(SERVER);
    expect(targetOf(form({ srv: 'missing' }), LIST)).toBeNull();
    // An own address with the origin of a registry server counts as that server, even without a policy.
    expect(targetOf(form({ srv: 'other', url: `${MAIL}/` }), LIST)?.server).toBe(SERVER);
    expect(targetOf(form({ srv: 'other', url: 'https://own.example' }), LIST)).toBeNull();
    const own = { ...LIST, allow_custom_servers: true };
    expect(targetOf(form({ srv: 'other', url: 'https://own.example/' }), own)).toEqual({
      url: 'https://own.example',
      server: null,
    });
    expect(targetOf(form({ srv: 'other', url: 'http://own.example' }), own)).toEqual({ url: '', server: null });
  });

  it('checks before the redirect', () => {
    const list = { ...LIST, allow_custom_servers: true };
    const failure = (f: LoginForm, accounts: MailAccount[] = []) => {
      const result = check(f, { kind: 'new' }, list, accounts);
      return 'failure' in result ? result.failure : null;
    };
    expect(failure(form({ email: 'max' }))).toEqual({ error: 'email' });
    expect(failure(form({ email: ' MAX@example.com ' }), [account()])).toEqual({
      error: 'dup',
      as: 'max@example.com',
      account: 'a1',
    });
    expect(failure(form({ email: 'max@other.example' }))).toEqual({ error: 'nosrv' });
    expect(failure(form({ srv: 'other', url: 'mail.own.example' }))).toEqual({ error: 'url' });
    expect(failure(form({ auth: 'token' }))).toEqual({ error: 'sec' });
    expect(failure(form({ srv: 'other', url: 'https://own.example' }))).toEqual({ error: 'oauth' });
    expect(failure(form({ srv: 'other', url: 'https://own.example', auth: 'token', token: 't' }))).toBeNull();
    const withServer = (patch: Partial<MailServer>, f = form()) => {
      const result = check(f, { kind: 'new' }, { ...list, servers: [{ ...SERVER, ...patch }] }, []);
      return 'failure' in result ? result.failure.error : null;
    };
    expect(withServer({ client_id: null })).toBe('oauth');
    expect(withServer({ oauth: 'err' })).toBe('oauth');
    expect(withServer({ cors: 'err' })).toBe('cors');
    expect(withServer({ cors: 'err' }, form({ auth: 'token', token: 't' }))).toBe('cors');
    // Only the attempt checks the test status "unreachable".
    expect(withServer({ reach: 'err' })).toBeNull();
    // Sign in again: the address is fixed, no `dup`.
    const re = check(form(), { kind: 're', account: 'a1' }, list, [account()]);
    expect('target' in re && re.target.server).toBe(SERVER);
  });
});

describe('redirect', () => {
  it('redirects to the sign-in page with PKCE S256, state and login_hint', async () => {
    const { fetch, seen } = net({ [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [json(METADATA)] });
    const d = deps(fetch);
    const result = await begin(form({ email: ' max@example.com ' }), { kind: 'new' }, LIST, [], d);
    expect(seen[0]?.url).toBe(`${MAIL}/.well-known/oauth-authorization-server`);
    expect('redirect' in result).toBe(true);
    expect(d.assigned).toHaveLength(1);
    const url = new URL(d.assigned[0] ?? '');
    expect(url.origin + url.pathname).toBe(`${MAIL}/login`);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: 'roedy',
      redirect_uri: `${APP}/oauth/callback`,
      scope: SCOPE,
      code_challenge_method: 'S256',
      login_hint: 'max@example.com',
    });
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = takePending(q.state ?? '', sessionStorage, NOW);
    expect(saved).toMatchObject({
      purpose: { kind: 'new' },
      form: { email: 'max@example.com', srv: 'auto', url: '', auth: 'oauth' },
      url: MAIL,
      serverId: 's1',
      clientId: 'roedy',
      issuer: MAIL,
      tokenEndpoint: METADATA.token_endpoint,
      issRequired: true,
      user: USER,
    });
    expect(saved?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.code_challenge).toBe(await challengeOf(saved?.verifier ?? ''));
  });

  it('computes the challenge per RFC 7636 appendix B', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('reports missing or foreign metadata as oauth', async () => {
    const foreign = { ...METADATA, authorization_endpoint: 'https://foreign.example/login' };
    const { fetch } = net({
      [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [json({}, 404), json(foreign), json({ issuer: MAIL })],
    });
    for (let i = 0; i < 3; i++) {
      expect(await begin(form(), { kind: 'new' }, LIST, [], deps(fetch))).toEqual({ ok: false, error: 'oauth' });
    }
    expect(sessionStorage.length).toBe(0);
  });

  it('distinguishes reach and cors via the just loaded test status of the backend', async () => {
    const { fetch, seen } = net({
      [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [new TypeError('x'), new TypeError('x')],
    });
    const run = (list: ServerList) => begin(form(), { kind: 'new' }, list, [], deps(fetch));
    expect(await run(LIST)).toEqual({ ok: false, error: 'cors' });
    expect(await run({ ...LIST, servers: [{ ...SERVER, reach: 'err' }] })).toEqual({ ok: false, error: 'reach' });
    // No second fetch of `GET servers`.
    expect(seen.map((x) => x.url)).not.toContain(api('servers'));
  });

  it('gives up on the metadata after the timeout, like on a network error', async () => {
    vi.useFakeTimers();
    try {
      // All connections to the server taken: the request waits until it is aborted.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init: RequestInit = {}) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true }),
          ),
      ) as unknown as typeof globalThis.fetch;
      const d = deps(fetch);
      const result = begin(form(), { kind: 'new' }, LIST, [], d, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT - 1);
      expect(d.assigned).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({ ok: false, error: 'cors' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('no longer redirects after an abort', async () => {
    const controller = new AbortController();
    const { fetch } = net({
      [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [
        () => {
          controller.abort();
          return json(METADATA);
        },
      ],
    });
    const d = deps(fetch);
    await expect(begin(form(), { kind: 'new' }, LIST, [], d, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(d.assigned).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });

  it('hands over an access token without a redirect', async () => {
    const created = account({ auth_kind: 'token' });
    const { fetch, seen } = net({
      [`POST ${api('mail-accounts')}`]: [json(created, 201)],
      [`POST ${api('mail-accounts/a1/reauth')}`]: [json(created)],
    });
    const d = deps(fetch);
    expect(await begin(form({ auth: 'token', token: ' secret ' }), { kind: 'new' }, LIST, [], d)).toEqual({
      ok: true,
      account: created,
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      email: 'max@example.com',
      server_id: 's1',
      auth_kind: 'token',
      token: 'secret',
    });
    await begin(form({ auth: 'token', token: 'new' }), { kind: 're', account: 'a1' }, LIST, [account()], d);
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ token: 'new' });
    expect(d.assigned).toEqual([]);
  });

  it('names the address for an own server', async () => {
    const { fetch, seen } = net({ [`POST ${api('mail-accounts')}`]: [json(account(), 201)] });
    const list = { ...LIST, allow_custom_servers: true };
    await begin(
      form({ srv: 'other', url: 'https://own.example/', auth: 'token', token: 't' }),
      { kind: 'new' },
      list,
      [],
      deps(fetch),
    );
    expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({ url: 'https://own.example', auth_kind: 'token' });
  });
});

describe('open attempts', () => {
  it('returns each attempt once and only within the time limit', () => {
    savePending(pending({ state: 'a' }), sessionStorage);
    savePending(pending({ state: 'b' }), sessionStorage);
    expect(takePending('a', sessionStorage, NOW)?.state).toBe('a');
    expect(takePending('a', sessionStorage, NOW)).toBeNull();
    expect(takePending(null, sessionStorage, NOW)).toBeNull();
    expect(takePending('unknown', sessionStorage, NOW)).toBeNull();
    expect(takePending('b', sessionStorage, NOW + PENDING_TTL)).toBeNull();
  });

  it('finds the return also in the device storage', () => {
    localStorage.clear();
    savePending(pending({ state: 'app' }), localStorage);
    const deps = { storage: sessionStorage, device: localStorage, now: () => NOW, user: () => USER };
    expect(takeReturning('app', deps)?.state).toBe('app');
    expect(takeReturning('app', deps)).toBeNull();
    expect(takeReturning('app', { ...deps, device: null })).toBeNull();
  });

  it('discards the return of an attempt another app user started', () => {
    const deps = { storage: sessionStorage, device: null, now: () => NOW };
    savePending(pending({ state: 'a', user: 'u2' }), sessionStorage);
    expect(takeReturning('a', { ...deps, user: () => USER })).toBeNull();
    // Discarded: the user who started it cannot complete it later either.
    expect(takeReturning('a', { ...deps, user: () => 'u2' })).toBeNull();
    savePending(pending({ state: 'b' }), sessionStorage);
    expect(takeReturning('b', { ...deps, user: () => null })).toBeNull();
  });

  it('discards all attempts of the device on sign-out, other entries stay', () => {
    localStorage.clear();
    localStorage.setItem('other', '1');
    savePending(pending({ state: 'a' }), localStorage);
    savePending(pending({ state: 'b' }), localStorage);
    clearPending(localStorage);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('other')).toBe('1');
    localStorage.clear();
  });

  it('discards expired attempts when remembering', () => {
    savePending(pending({ state: 'old', created: NOW - PENDING_TTL }), sessionStorage);
    sessionStorage.setItem('roedy-mail.oauth.broken', '{');
    sessionStorage.setItem('foreign', 'stays');
    savePending(pending({ state: 'new' }), sessionStorage);
    expect(Object.keys(sessionStorage).sort()).toEqual(['foreign', 'roedy-mail.oauth.new']);
  });

  it('treats entries in a foreign shape as unknown', () => {
    sessionStorage.setItem('roedy-mail.oauth.old', JSON.stringify({ state: 'old', created: NOW }));
    expect(takePending('old', sessionStorage, NOW)).toBeNull();
    // From before the binding to the app user.
    const unbound: Partial<Pending> = pending({ state: 'unbound' });
    delete unbound.user;
    sessionStorage.setItem('roedy-mail.oauth.unbound', JSON.stringify(unbound));
    expect(takePending('unbound', sessionStorage, NOW)).toBeNull();
    sessionStorage.setItem(
      'roedy-mail.oauth.none',
      JSON.stringify({ ...pending({ state: 'none' }), purpose: undefined }),
    );
    expect(takePending('none', sessionStorage, NOW)).toBeNull();
    savePending(pending({ state: 'good', purpose: { kind: 're', account: 'a1' } }), sessionStorage);
    expect(takePending('good', sessionStorage, NOW)?.purpose).toEqual({ kind: 're', account: 'a1' });
  });

  it('reads the parameters of the redirect back', () => {
    expect(callbackParams(new URL(`${APP}/oauth/callback?code=c&state=s&iss=${encodeURIComponent(MAIL)}`))).toEqual({
      code: 'c',
      state: 's',
      iss: MAIL,
      error: null,
    });
  });
});

describe('return', () => {
  const TOKENS = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' };
  const ok = { code: 'c', state: 'st', iss: MAIL, error: null };

  it('exchanges the code in the browser and creates the account', async () => {
    const created = account();
    const { fetch, seen } = net({
      [`POST ${METADATA.token_endpoint}`]: [json(TOKENS)],
      [`POST ${api('mail-accounts')}`]: [json(created, 201)],
    });
    expect(await complete(pending(), ok, deps(fetch))).toEqual({ ok: true, account: created });
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: `${APP}/oauth/callback`,
      client_id: 'roedy',
      code_verifier: 'v'.repeat(43),
    });
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({
      email: 'max@example.com',
      server_id: 's1',
      auth_kind: 'oauth',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      client_id: 'roedy',
      user_id: USER,
    });
  });

  it('reports a sign-in refused for another app user (session_changed) as expired', async () => {
    // Another app user signed in in this browser between the check here and the request.
    const { fetch } = net({
      [`POST ${METADATA.token_endpoint}`]: [json(TOKENS)],
      [`POST ${api('mail-accounts')}`]: [json({ error: 'session_changed' }, 409)],
    });
    expect(await complete(pending(), ok, deps(fetch))).toEqual({ ok: false, error: 'expired' });
  });

  it('does not complete an attempt for another app user', async () => {
    const { fetch, seen } = net({});
    // A's app session expired on the sign-in page and B signed in to the app in the same browser.
    expect(await complete(pending({ user: 'u2' }), ok, deps(fetch))).toEqual({ ok: false, error: 'expired' });
    expect(await complete(pending({ backendExchange: true }), ok, deps(fetch, null))).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(seen).toHaveLength(0);
  });

  it('does not hand over the tokens if the app user changed during the exchange', async () => {
    let user: string | null = USER;
    const { fetch, seen } = net({
      [`POST ${METADATA.token_endpoint}`]: [
        () => {
          user = 'u2';
          return json(TOKENS);
        },
      ],
    });
    expect(await complete(pending(), ok, { ...deps(fetch), user: () => user })).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(seen.map((s) => s.url)).toEqual([METADATA.token_endpoint]);
  });

  it('refuses to start an attempt without a signed-in app user', async () => {
    const { fetch } = net({ [`GET ${MAIL}/.well-known/oauth-authorization-server`]: [json(METADATA)] });
    const d = deps(fetch, null);
    const result = await begin(form(), { kind: 'new' }, LIST, [], d);
    expect(result).toMatchObject({ ok: false, error: null });
    expect(d.assigned).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('requests mail and contacts (like the registration in the backend)', () => {
    expect(SCOPE.split(' ')).toEqual([
      'offline_access',
      'urn:ietf:params:oauth:scope:mail',
      'urn:ietf:params:oauth:scope:contacts',
    ]);
  });

  it('reports a used code as expired when exchanged in the backend', async () => {
    const { fetch } = net({
      [`POST ${api('mail-accounts')}`]: [json({ error: 'exchange_failed', reason: 'invalid_grant' }, 422)],
    });
    expect(await complete(pending({ backendExchange: true }), ok, deps(fetch))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('gives code and verifier to the backend with backend_exchange', async () => {
    const { fetch, seen } = net({ [`POST ${api('mail-accounts/a1/reauth')}`]: [json(account())] });
    const p = pending({ backendExchange: true, purpose: { kind: 're', account: 'a1' } });
    expect((await complete(p, ok, deps(fetch))).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      code: 'c',
      code_verifier: 'v'.repeat(43),
      client_id: 'roedy',
      user_id: USER,
    });
  });

  it('discards responses with a wrong or missing iss', async () => {
    const { fetch, seen } = net({});
    expect(await complete(pending(), { ...ok, iss: 'https://foreign.example' }, deps(fetch))).toEqual({
      ok: false,
      error: 'iss',
    });
    expect(await complete(pending(), { ...ok, iss: null }, deps(fetch))).toEqual({ ok: false, error: 'iss' });
    // An error with a wrong `iss` is also `iss`, not `denied`.
    expect(
      await complete(pending(), { ...ok, iss: 'https://foreign.example', error: 'access_denied' }, deps(fetch)),
    ).toEqual({
      ok: false,
      error: 'iss',
    });
    expect(seen).toEqual([]);
  });

  it('accepts a redirect back without iss if the server does not announce it', async () => {
    const { fetch } = net({
      [`POST ${METADATA.token_endpoint}`]: [json(TOKENS)],
      [`POST ${api('mail-accounts')}`]: [json(account(), 201)],
    });
    expect((await complete(pending({ issRequired: false }), { ...ok, iss: null }, deps(fetch))).ok).toBe(true);
  });

  it('reports error of the redirect back as denied with the error code', async () => {
    const { fetch } = net({});
    expect(await complete(pending(), { ...ok, code: null, error: 'access_denied' }, deps(fetch))).toEqual({
      ok: false,
      error: 'denied',
      code: 'access_denied',
    });
    expect(await complete(pending(), { ...ok, code: null }, deps(fetch))).toEqual({
      ok: false,
      error: 'denied',
      code: '',
    });
  });

  it('maps errors of the token endpoint', async () => {
    const endpoint = `POST ${METADATA.token_endpoint}`;
    const { fetch } = net({
      [endpoint]: [
        json({ error: 'invalid_grant' }, 400),
        json({ error: 'access_denied' }, 400),
        json({ error: 'invalid_client' }, 401),
        json({ error: 'server_error' }, 500),
        json({ error: 'slow_down' }, 429, { 'Retry-After': '42' }),
        new Response('', { status: 429 }),
        new TypeError('x'),
      ],
      [`GET ${api('servers')}`]: [json(LIST)],
    });
    const run = () => complete(pending(), ok, deps(fetch));
    expect(await run()).toEqual({ ok: false, error: 'expired' });
    // Since Stalwart v1 a used code is called `invalid_grant`; `access_denied` is a different error.
    expect(await run()).toEqual({ ok: false, error: 'denied', code: 'access_denied' });
    expect(await run()).toEqual({ ok: false, error: 'oauth' });
    expect(await run()).toEqual({ ok: false, error: 'denied', code: 'server_error' });
    expect(await run()).toEqual({ ok: false, error: 'rate', wait: 42 });
    expect(await run()).toEqual({ ok: false, error: 'rate' });
    expect(await run()).toEqual({ ok: false, error: 'cors' });
  });

  it('requires a refresh token and does not report responses without an OAuth error as denied', async () => {
    const { fetch, seen } = net({
      [`POST ${METADATA.token_endpoint}`]: [
        json({ access_token: 'at', expires_in: 3600 }),
        new Response('<html>Bad Gateway</html>', { status: 502 }),
        json({}, 400),
        json({ ...TOKENS, expires_in: 1.5 }),
      ],
      [`POST ${api('mail-accounts')}`]: [json(account(), 201)],
    });
    const run = () => complete(pending(), ok, deps(fetch));
    expect(await run()).toEqual({ ok: false, error: 'oauth' });
    expect(await run()).toEqual({ ok: false, error: 'reach' });
    const general = await run();
    expect(general).toMatchObject({ ok: false, error: null });
    expect(general.ok === false && general.cause).toBeInstanceOf(Error);
    expect((await run()).ok).toBe(true);
    // An `expires_in` the backend does not accept is left out of the handover.
    expect(JSON.parse(seen.at(-1)?.body ?? '')).not.toHaveProperty('expires_in');
  });

  it('reports a different account with its address when signing in again', async () => {
    const { fetch } = net({
      [`POST ${METADATA.token_endpoint}`]: [json(TOKENS)],
      [`POST ${api('mail-accounts/a1/reauth')}`]: [
        json({ error: 'other_account', account: { email: 'eva@example.com' } }, 409),
      ],
    });
    const p = pending({ purpose: { kind: 're', account: 'a1' } });
    expect(await complete(p, ok, deps(fetch))).toEqual({ ok: false, error: 'other', as: 'eva@example.com' });
  });
});

describe('backend errors', () => {
  const err = (status: number, body: Record<string, unknown>) => new ApiError(status, body);
  const invalid = (field: string, code: string) => err(422, { error: 'invalid', fields: { [field]: { code } } });

  it('maps error codes and reasons to error keys', () => {
    expect(failureOf(err(409, { error: 'dup', account: { id: 'a9', email: 'max@example.com' } }), 'oauth')).toEqual({
      error: 'dup',
      as: 'max@example.com',
      account: 'a9',
    });
    const check = (reason: string, kind: 'oauth' | 'token' = 'token') =>
      failureOf(
        err(reason === 'unreachable' || reason === 'throttled' ? 502 : 422, { error: 'check_failed', reason }),
        kind,
      ).error;
    expect(check('auth_failed')).toBe('tok');
    expect(check('forbidden')).toBe('tok');
    expect(check('auth_failed', 'oauth')).toBeNull();
    expect(check('unreachable')).toBe('reach');
    expect(check('throttled')).toBe('rate');
    expect(check('no_mail')).toBeNull();
    const exchange = (reason: string, detail?: string) =>
      failureOf(err(422, { error: 'exchange_failed', reason, ...(detail ? { detail } : {}) }), 'oauth');
    expect(exchange('invalid_grant')).toEqual({ error: 'expired' });
    expect(exchange('invalid_client')).toEqual({ error: 'oauth' });
    expect(exchange('throttled')).toEqual({ error: 'rate' });
    expect(exchange('unreachable')).toEqual({ error: 'reach' });
    expect(exchange('rejected', 'unauthorized_client')).toEqual({ error: 'denied', code: 'unauthorized_client' });
    expect(exchange('no_refresh_token')).toEqual({ error: 'oauth' });
    expect(exchange('http_status').error).toBeNull();
  });

  it('maps field errors', () => {
    expect(failureOf(invalid('email', 'invalid'), 'oauth').error).toBe('email');
    expect(failureOf(invalid('server_id', 'not_found'), 'oauth').error).toBe('nosrv');
    expect(failureOf(invalid('url', 'not_allowed'), 'token').error).toBe('nosrv');
    expect(failureOf(invalid('url', 'private'), 'token').error).toBe('url');
    expect(failureOf(invalid('auth_kind', 'no_client'), 'oauth').error).toBe('oauth');
    expect(failureOf(invalid('token', 'required'), 'token').error).toBe('sec');
    expect(failureOf(invalid('token', 'too_long'), 'token').error).toBe('tok');
    expect(failureOf(invalid('refresh_token', 'required'), 'oauth').error).toBeNull();
  });

  it('leaves limits of the app API and network errors to the general error texts', () => {
    const limited = err(429, { error: 'rate_limited', retry_after: 30 });
    expect(failureOf(limited, 'oauth')).toEqual({ error: null, cause: limited });
    const offline = new NetworkError(new TypeError('x'));
    expect(failureOf(offline, 'token')).toEqual({ error: null, cause: offline });
  });
});
