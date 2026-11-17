/**
 * Sign-in to mail accounts in the browser:
 * authorization code flow with PKCE (RFC 6749, RFC 7636). Determines the server
 * (domain → registry, list or own address), loads its OAuth metadata
 * (RFC 8414) and redirects by script to the `authorization_endpoint` – no
 * form, the CSP only allows `form-action` for the app. After returning
 * via `/oauth/callback` it checks `state` and `iss` (RFC 9207). For the
 * confidential client the backend exchanges the code (`backend_exchange`,
 * the usual case with Stalwart v1): code and verifier go to
 * `POST mail-accounts` or `POST mail-accounts/:id/reauth`. For a manually
 * created public client the browser exchanges at the `token_endpoint` and
 * hands over the tokens. Access tokens (`token`) go to the
 * same endpoints without a redirect. Errors are plain keys (`LoginError`);
 * the pages show the texts.
 */
import { retryAfterSeconds } from '@roedy/jmap';
import { ApiError, api, fieldsOf, isRecord, type FieldDetail } from '#lib/api.ts';
import type { DiagStatus } from '#lib/diagnosis.ts';
import { isEmail } from '#lib/email.ts';
import { isInstalled } from '#lib/installed.ts';
import { localStore } from '#lib/last-page.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import { appFetch } from '#lib/state/network.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { originOf } from '#lib/url.ts';

/**
 * Scope of the sign-in, like `broker::dcr::SCOPE` (Stalwart does not
 * know `mail` alone). Contacts for the recipient suggestions.
 */
export const SCOPE = 'offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts';
/** Redirect URI of the OAuth client under the address of the app. */
export const CALLBACK_PATH = '/oauth/callback';
/** An attempt can return for this long (sign-in page left open). */
export const PENDING_TTL = 60 * 60 * 1000;
const PENDING_PREFIX = 'roedy-mail.oauth.';

/** Server from `GET servers`, as every signed-in user sees it. */
export interface MailServer {
  id: string;
  label: string;
  /** Origin of the server. */
  url: string;
  host: string;
  domains: string[];
  client_id: string | null;
  /** Confidential client: the backend exchanges the code. */
  backend_exchange: boolean;
  /** Last test status of the backend (diagnosis). */
  reach: DiagStatus;
  cors: DiagStatus;
  oauth: DiagStatus;
}

export interface ServerList {
  servers: MailServer[];
  /** "Other server …" (own addresses) allowed. */
  allow_custom_servers: boolean;
}

/** Errors of the flow as keys; the pages show the texts. */
export type LoginError =
  | 'email'
  | 'dup'
  | 'nosrv'
  | 'url'
  | 'sec'
  | 'tok'
  | 'reach'
  | 'cors'
  | 'oauth'
  | 'expired'
  | 'denied'
  | 'iss'
  | 'other'
  | 'rate';

export type AuthKind = 'oauth' | 'token';

/**
 * Form details: server `auto` (via the domain of the address), the ID
 * of a registry server or `other` (own address in `url`).
 */
export interface LoginForm {
  email: string;
  srv: string;
  url: string;
  auth: AuthKind;
  token: string;
}

export const FORM0: LoginForm = { email: '', srv: 'auto', url: '', auth: 'oauth', token: '' };

/** New account or "Sign in again" for an existing one. */
export type Purpose = { kind: 'new' } | { kind: 're'; account: string };

/** Server of the sign-in: origin and, if it is one, the registry entry. */
export interface Target {
  url: string;
  server: MailServer | null;
}

/** What the flow needs from the browser; faked in tests. */
export interface LoginDeps {
  fetch: typeof fetch;
  /** Open attempts: in the browser those of the tab (`sessionStorage`), in the installed app those of the device. */
  storage: Storage;
  /** `localStorage`: a window without the app's tab storage also looks for the attempt there. */
  device?: Storage | null;
  /** Redirect to the sign-in page (`location.assign`). */
  assign: (url: string) => void;
  now: () => number;
  /** Origin of the app for the redirect URI. */
  origin: string;
  /** ID of the signed-in app user, `null` without a session: an attempt only completes for the user who started it. */
  user: () => string | null;
}

export function browserDeps(): LoginDeps {
  const device = localStore();
  return {
    fetch: appFetch,
    storage: isInstalled() ? (device ?? sessionStorage) : sessionStorage,
    device,
    assign: (url) => location.assign(url),
    now: () => Date.now(),
    origin: location.origin,
    user: () => session.user?.id ?? null,
  };
}

/** A failed attempt. */
export interface Failure {
  /** Error key; `null` means a general error (`cause`, text via `failText`). */
  error: LoginError | null;
  /** Signed-in address for `dup` and `other`. */
  as?: string;
  /** Already connected account for `dup` ("Open account"). */
  account?: string;
  /** Error code of the mail server for `denied`. */
  code?: string;
  /** Wait time in seconds for `rate` if the mail server names it readably (`Retry-After` via CORS). */
  wait?: number;
  cause?: unknown;
}

export type Outcome = { ok: true; account: MailAccount } | ({ ok: false } & Failure);

const fail = (error: LoginError | null, more: Omit<Failure, 'error'> = {}): Outcome => ({ ok: false, error, ...more });

/** Server for the domain of an address (`auto`). */
export function serverForEmail(email: string, servers: readonly MailServer[]): MailServer | null {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return (domain && servers.find((s) => s.domains.includes(domain))) || null;
}

/** Origin of an own address, only with `https://` ("Other server …"); empty if it is none. */
export function customOrigin(value: string): string {
  const url = value.trim();
  return /^https:\/\//i.test(url) ? originOf(url) : '';
}

/**
 * Server for the form's choice; `null` if none is assigned. An own
 * address with the origin of a registry server counts as that
 * server (as in the backend); otherwise only if own servers
 * are allowed. `url` is empty if the own address is invalid.
 */
export function targetOf(form: LoginForm, list: ServerList): Target | null {
  if (form.srv === 'other') {
    const url = customOrigin(form.url);
    const server = (url && list.servers.find((s) => s.url === url)) || null;
    return server || list.allow_custom_servers ? { url, server } : null;
  }
  const server =
    form.srv === 'auto' ? serverForEmail(form.email, list.servers) : list.servers.find((s) => s.id === form.srv);
  return server ? { url: server.url, server } : null;
}

/** Result of the check: error or server, for `oauth` with the registry client. */
export type Checked = { failure: Failure } | { target: Target; client: { server: MailServer; id: string } | null };

/** Account of the user with this address (`dup` before the sign-in). */
function connected(email: string, accounts: readonly MailAccount[]): MailAccount | undefined {
  const address = email.trim().toLowerCase();
  return accounts.find((a) => a.email.toLowerCase() === address);
}

/**
 * Check before the redirect: `email`, `dup` (only
 * new accounts), `nosrv`, `url`, `sec`. Plus what the backend diagnosis
 * already knows and the browser would only notice after the redirect: `cors`
 * (the code exchange failed) and `oauth` (no or a faulty
 * OAuth client). Whether the server is reachable shows in the attempt
 * itself – an outdated test status does not block the sign-in. For
 * sign-in at the server (`oauth`) the check also returns the client.
 */
export function check(form: LoginForm, purpose: Purpose, list: ServerList, accounts: readonly MailAccount[]): Checked {
  if (purpose.kind === 'new') {
    if (!isEmail(form.email.trim())) return { failure: { error: 'email' } };
    const dup = connected(form.email, accounts);
    if (dup) return { failure: { error: 'dup', as: dup.email, account: dup.id } };
  }
  const target = targetOf(form, list);
  if (!target) return { failure: { error: 'nosrv' } };
  if (!target.url) return { failure: { error: 'url' } };
  if (form.auth === 'token' && !form.token.trim()) return { failure: { error: 'sec' } };
  const server = target.server;
  if (server?.cors === 'err') return { failure: { error: 'cors' } };
  if (form.auth === 'token') return { target, client: null };
  if (!server?.client_id || server.oauth === 'err') return { failure: { error: 'oauth' } };
  return { target, client: { server, id: server.client_id } };
}

/** OAuth metadata (RFC 8414), as far as the sign-in needs it. */
export interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 9207: the server appends `iss` to every redirect back. */
  iss_supported: boolean;
}

/**
 * Loads the metadata; `issuer` and endpoints must be on the origin of the
 * server as in the diagnosis, otherwise `null`. A
 * network error (also CORS) throws.
 */
export async function loadMetadata(
  origin: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Metadata | null> {
  const res = await fetchFn(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json().catch(() => null);
  if (!isRecord(data)) return null;
  const { issuer, authorization_endpoint: authorize, token_endpoint: token } = data;
  if (typeof issuer !== 'string' || typeof authorize !== 'string' || typeof token !== 'string') return null;
  if (![issuer, authorize, token].every((url) => originOf(url) === origin)) return null;
  return {
    issuer,
    authorization_endpoint: authorize,
    token_endpoint: token,
    iss_supported: data.authorization_response_iss_parameter_supported === true,
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random value for `state` and the PKCE verifier (32 bytes: 43 characters, RFC 7636 4.1). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `code_challenge` for a verifier with `S256` (RFC 7636 4.2). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Open attempt, remembered in the tab until the return – per `state`, so that a
 * new attempt does not displace an older one that can still return.
 */
export interface Pending {
  state: string;
  verifier: string;
  purpose: Purpose;
  /** Form details without a token – after an error the app refills the form with them. */
  form: Omit<LoginForm, 'token'>;
  /** Origin and registry entry. */
  url: string;
  serverId: string;
  clientId: string;
  backendExchange: boolean;
  issuer: string;
  tokenEndpoint: string;
  issRequired: boolean;
  redirectUri: string;
  /** ms since 1970 */
  created: number;
  /**
   * App user who started the attempt. `state` and PKCE only bind it to the tab
   * and the flow; if someone else signed in to the app meanwhile, the mail
   * account must not be attached to their account.
   */
  user: string;
}

const strings = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => typeof value[key] === 'string');

/** Checks the shape of a stored attempt – an entry of any other shape counts as unknown. */
function isPending(value: unknown): value is Pending {
  if (!isRecord(value)) return false;
  const { purpose, form } = value;
  return (
    strings(value, [
      'state',
      'verifier',
      'url',
      'serverId',
      'clientId',
      'issuer',
      'tokenEndpoint',
      'redirectUri',
      'user',
    ]) &&
    typeof value.backendExchange === 'boolean' &&
    typeof value.issRequired === 'boolean' &&
    typeof value.created === 'number' &&
    isRecord(purpose) &&
    (purpose.kind === 'new' || (purpose.kind === 're' && typeof purpose.account === 'string')) &&
    isRecord(form) &&
    strings(form, ['email', 'srv', 'url']) &&
    (form.auth === 'oauth' || form.auth === 'token')
  );
}

function readPending(raw: string | null): Pending | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isPending(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers an attempt; discards expired ones. Throws if the storage is blocked or full. */
export function savePending(pending: Pending, storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (!key?.startsWith(PENDING_PREFIX)) continue;
    const old = readPending(storage.getItem(key));
    if (!old || pending.created - old.created >= PENDING_TTL) storage.removeItem(key);
  }
  storage.setItem(PENDING_PREFIX + pending.state, JSON.stringify(pending));
}

/** Fetches and removes the attempt for `state`; `null` if it is missing, unknown or expired. */
export function takePending(state: string | null, storage: Storage, now: number): Pending | null {
  if (!state) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_PREFIX + state);
    storage.removeItem(PENDING_PREFIX + state);
  } catch {
    return null;
  }
  const pending = readPending(raw);
  return pending && pending.state === state && now - pending.created < PENDING_TTL ? pending : null;
}

/** Whether the signed-in app user is the one who started the attempt. */
export function ownAttempt(pending: Pending, deps: Pick<LoginDeps, 'user'>): boolean {
  const user = deps.user();
  return user !== null && user === pending.user;
}

/**
 * Like `takePending`, but also searches the device storage: the return can arrive in a different window than the start.
 * An attempt of another app user (signed in meanwhile in the same browser) counts as unknown and is discarded.
 */
export function takeReturning(
  state: string | null,
  deps: Pick<LoginDeps, 'storage' | 'device' | 'now' | 'user'>,
): Pending | null {
  const pending =
    takePending(state, deps.storage, deps.now()) ?? (deps.device ? takePending(state, deps.device, deps.now()) : null);
  return pending && ownAttempt(pending, deps) ? pending : null;
}

/** Discards the open attempts in the device storage (sign-out): they name the address of the account. */
export function clearPending(storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(PENDING_PREFIX)) storage.removeItem(key);
  }
}

/** Address of the sign-in page with all parameters. */
export function authorizeUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint: string;
}): string {
  const url = new URL(input.endpoint);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('scope', SCOPE);
  params.set('state', input.state);
  params.set('code_challenge', input.challenge);
  // Without it `plain` would apply, and every code exchange would fail.
  params.set('code_challenge_method', 'S256');
  if (input.loginHint) params.set('login_hint', input.loginHint);
  return url.href;
}

/** Parameters of the redirect back (RFC 6749 4.1.2, RFC 9207). */
export interface CallbackParams {
  code: string | null;
  state: string | null;
  iss: string | null;
  error: string | null;
}

export function callbackParams(url: URL): CallbackParams {
  const get = (name: string) => url.searchParams.get(name);
  return { code: get('code'), state: get('state'), iss: get('iss'), error: get('error') };
}

/**
 * A `fetch` error in the browser: CORS and "unreachable" cannot be told
 * apart. If the backend reaches the server according to the last test, it is
 * CORS, otherwise `reach` applies. A `TypeError` can
 * also be an address blocked by Fail2Ban – indistinguishable.
 */
async function networkError(url: string, known?: ServerList): Promise<LoginError> {
  let list = known;
  try {
    list ??= await api<ServerList>('GET', 'servers');
  } catch {
    return 'reach';
  }
  return list.servers.find((s) => s.url === url)?.reach === 'ok' ? 'cors' : 'reach';
}

/** Field errors from 422 `invalid` of `POST mail-accounts` as error keys. */
function fieldError(fields: Record<string, FieldDetail>): LoginError | null {
  if (fields.email) return 'email';
  if (fields.server_id) return 'nosrv';
  // Without a policy for own servers no server is assigned to the address.
  if (fields.url) return fields.url.code === 'not_allowed' ? 'nosrv' : 'url';
  if (fields.auth_kind || fields.client_id) return 'oauth';
  if (fields.token) return fields.token.code === 'required' ? 'sec' : 'tok';
  return null;
}

/**
 * Errors of `POST mail-accounts` or `…/reauth`. Everything without its own
 * key – also a 429 of the app API – the page reports with the general error
 * texts.
 */
export function failureOf(error: unknown, kind: AuthKind): Failure {
  if (!(error instanceof ApiError)) return { error: null, cause: error };
  const { body } = error;
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const account = isRecord(body.account) ? body.account : {};
  const email = typeof account.email === 'string' ? account.email : '';
  switch (error.code) {
    case 'session_changed':
      return { error: 'expired' };
    case 'dup':
      return { error: 'dup', as: email, ...(typeof account.id === 'string' ? { account: account.id } : {}) };
    case 'other_account':
      return { error: 'other', as: email };
    case 'check_failed':
      if ((reason === 'auth_failed' || reason === 'forbidden') && kind === 'token') return { error: 'tok' };
      if (reason === 'unreachable') return { error: 'reach' };
      if (reason === 'throttled') return { error: 'rate' };
      break;
    case 'exchange_failed':
      if (reason === 'invalid_grant') return { error: 'expired' };
      // Without a refresh token the client may not use `offline_access` – like a faulty client.
      if (reason === 'invalid_client' || reason === 'no_refresh_token') return { error: 'oauth' };
      if (reason === 'throttled') return { error: 'rate' };
      if (reason === 'unreachable') return { error: 'reach' };
      if (reason === 'rejected') return { error: 'denied', code: typeof body.detail === 'string' ? body.detail : '' };
      break;
    case 'invalid': {
      const field = fieldError(fieldsOf(error));
      if (field) return { error: field };
      break;
    }
  }
  return { error: null, cause: error };
}

/** Hands over tokens, code or access token to the backend. */
async function submit(
  purpose: Purpose,
  email: string,
  server: { id: string | null; url: string },
  kind: AuthKind,
  credentials: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const account =
      purpose.kind === 'new'
        ? await api<MailAccount>('POST', 'mail-accounts', {
            email: email.trim(),
            ...(server.id ? { server_id: server.id } : { url: server.url }),
            auth_kind: kind,
            ...credentials,
          })
        : await api<MailAccount>('POST', `mail-accounts/${encodeURIComponent(purpose.account)}/reauth`, credentials);
    return { ok: true, account };
  } catch (error) {
    return { ok: false, ...failureOf(error, kind) };
  }
}

/**
 * Starts an attempt: check, then for `token` hand over to the backend right
 * away, otherwise load metadata, remember the attempt and redirect to the
 * sign-in page (`redirect` with the address; the page stays in the
 * loading state until the browser leaves it). `list` is the just loaded
 * state of `GET servers`. If `signal` aborts (form closed,
 * signed out), it no longer redirects and throws `AbortError`.
 */
export async function begin(
  form: LoginForm,
  purpose: Purpose,
  list: ServerList,
  accounts: readonly MailAccount[],
  deps: LoginDeps,
  signal?: AbortSignal,
): Promise<Outcome | { redirect: string }> {
  const checked = check(form, purpose, list, accounts);
  if ('failure' in checked) return { ok: false, ...checked.failure };
  const { target, client } = checked;
  if (!client) {
    return submit(purpose, form.email, { id: target.server?.id ?? null, url: target.url }, 'token', {
      token: form.token.trim(),
    });
  }
  const { server } = client;
  let metadata: Metadata | null;
  try {
    metadata = await loadMetadata(target.url, deps.fetch, signal);
  } catch {
    signal?.throwIfAborted();
    // The test status from `list` is as fresh as possible – just loaded.
    return fail(await networkError(target.url, list));
  }
  signal?.throwIfAborted();
  if (!metadata) return fail('oauth');
  const user = deps.user();
  if (user === null) return fail(null, { cause: new Error('Not signed in') });
  const pending: Pending = {
    state: randomToken(),
    verifier: randomToken(),
    purpose,
    form: { email: form.email.trim(), srv: form.srv, url: form.url, auth: form.auth },
    url: target.url,
    serverId: server.id,
    clientId: client.id,
    backendExchange: server.backend_exchange,
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    issRequired: metadata.iss_supported,
    redirectUri: deps.origin + CALLBACK_PATH,
    created: deps.now(),
    user,
  };
  const url = authorizeUrl({
    endpoint: metadata.authorization_endpoint,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    state: pending.state,
    challenge: await challengeOf(pending.verifier),
    loginHint: pending.form.email,
  });
  signal?.throwIfAborted();
  try {
    savePending(pending, deps.storage);
  } catch (error) {
    return fail(null, { cause: error });
  }
  deps.assign(url);
  return { redirect: url };
}

/** Largest value of `expires_in` the backend accepts (`u32`). */
const U32_MAX = 2 ** 32 - 1;

/** Response of the token endpoint (RFC 6749 5.1). */
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/** Code exchange in the browser (public client, RFC 6749 4.1.3). */
async function exchange(pending: Pending, code: string, deps: LoginDeps): Promise<Tokens | Failure> {
  let res: Response;
  try {
    res = await deps.fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }),
      credentials: 'omit',
    });
  } catch {
    return { error: await networkError(pending.url) };
  }
  if (res.status === 429) {
    // Only readable with `Access-Control-Expose-Headers`; otherwise without a wait time.
    const wait = retryAfterSeconds(res.headers.get('Retry-After'), deps.now());
    return { error: 'rate', ...(wait === undefined ? {} : { wait }) };
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok && isRecord(data) && typeof data.access_token === 'string') {
    // No account without a refresh token: the client may not use `offline_access` (grant types) – a matter for the administration.
    if (typeof data.refresh_token !== 'string') return { error: 'oauth' };
    const expires = data.expires_in;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      ...(typeof expires === 'number' && Number.isInteger(expires) && expires >= 0 && expires <= U32_MAX
        ? { expires_in: expires }
        : {}),
    };
  }
  const error = isRecord(data) && typeof data.error === 'string' ? data.error : '';
  if (!error) {
    // No OAuth response (e.g. the error page of a proxy): on 5xx like unreachable, otherwise general.
    return res.status >= 500
      ? { error: 'reach' }
      : { error: null, cause: new Error(`Token endpoint: HTTP ${res.status}`) };
  }
  // The cause is a client ID or redirect URI the server does not know (diagnosis of the administration).
  if (error === 'invalid_client') return { error: 'oauth' };
  // Used or expired code (Stalwart v1).
  if (error === 'invalid_grant') return { error: 'expired' };
  return { error: 'denied', code: error };
}

/**
 * Completes an attempt after the return: check that the app user is still the one who
 * started it (otherwise `expired`, before and after the exchange), check `iss` (RFC 9207 –
 * otherwise the response could come from another server), report `error` of
 * the redirect back (RFC 6749 4.1.2.1), exchange the code or give it to the
 * backend, then create the account or sign in again.
 */
export async function complete(pending: Pending, params: CallbackParams, deps: LoginDeps): Promise<Outcome> {
  if (!ownAttempt(pending, deps)) return fail('expired');
  if (params.iss !== null ? params.iss !== pending.issuer : pending.issRequired) return fail('iss');
  if (params.error !== null) return fail('denied', { code: params.error });
  if (!params.code) return fail('denied', { code: '' });
  let credentials: Record<string, unknown>;
  if (pending.backendExchange) {
    credentials = { code: params.code, code_verifier: pending.verifier };
  } else {
    const tokens = await exchange(pending, params.code, deps);
    if ('error' in tokens) return { ok: false, ...tokens };
    if (!ownAttempt(pending, deps)) return fail('expired');
    credentials = { ...tokens };
  }
  // The backend refuses (`session_changed`) if another app user signed in meanwhile in this
  // browser: the cookie, not this tab's state, decides whose account it becomes.
  return submit(pending.purpose, pending.form.email, { id: pending.serverId, url: pending.url }, 'oauth', {
    ...credentials,
    client_id: pending.clientId,
    user_id: pending.user,
  });
}
