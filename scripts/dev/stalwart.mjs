// Helpers for scripts/dev/stalwart.sh: digest of the release asset, setup of a
// fresh Stalwart v1 via bootstrap mode and JMAP `x:` methods (capability
// `urn:stalwart:jmap`), compatibility checks against the running server.
// Tests: stalwart.test.mjs (node --test scripts/).
//
//   node scripts/dev/stalwart.mjs digest <asset> < release.json
//   node scripts/dev/stalwart.mjs credentials <file> [url]
//   node scripts/dev/stalwart.mjs bootstrap <file> <recovery-url> <data-dir>
//   node scripts/dev/stalwart.mjs configure <file> <recovery-url>
//   node scripts/dev/stalwart.mjs accounts <file>
//   node scripts/dev/stalwart.mjs check [file]
//   node scripts/dev/stalwart.mjs log <file> <log-file> [lines]
//
// Flow (driven by the shell script within a single invocation):
// `credentials` generates random credentials and next to them `stalwart.env` for
// the server; start 1 without config.json in bootstrap mode, `bootstrap` writes
// database, domain and admin account with `x:Bootstrap/set`; start 2 in
// recovery mode (only the recovery port, no default listeners), where
// `configure` creates the HTTP listener on 127.0.0.1, CORS and the user account;
// start 3 is normal operation, where `accounts` creates the app passwords and
// the OAuth client (recovery mode does not let accounts reach JMAP).
//
// Credentials ($STALWART_CREDENTIALS, JSON, mode 600, directory with mode 700):
//
//   {
//     "version": 1,
//     "url": "http://127.0.0.1:18080",   base URL: issuer, JMAP, OAuth
//     "domain": "example.test",
//     "recoveryAdmin": { "login", "password" },
//         STALWART_RECOVERY_ADMIN: full rights via Basic, no mail account
//     "admin": { "name", "login", "email", "password", "appPassword", "accountId" },
//         role Admin (admin@example.test); the app password inherits the rights
//         (among others SysOAuthClientCreate for the confidential DCR)
//     "user": { "name", "login", "email", "password", "appPassword", "accountId" },
//         role User (user@example.test)
//     "oauthClient": { "clientId", "clientSecret", "tokenEndpointAuthMethod",
//                      "scopes", "redirectUris" }
//         confidential client created by the admin (client_secret_basic),
//         scopes Mail and Contacts, redirect URIs from STALWART_REDIRECT_URIS
//   }
//
// `login` is the sign-in name for Basic and /api/auth, `accountId` the JMAP
// account ID. Credentials, tokens and codes appear in no output: messages go
// through `redact`, responses with secrets are not shown.

import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { argv, env, exit, stdin } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_URL = 'http://127.0.0.1:18080';
export const DEFAULT_REDIRECT_URIS = ['http://127.0.0.1:8080/oauth/callback', 'http://127.0.0.1:5173/oauth/callback'];
export const DOMAIN = 'example.test';
export const HOSTNAME = `mail.${DOMAIN}`;
const SCOPE = 'urn:ietf:params:oauth:scope:';
const JMAP = 'urn:ietf:params:jmap:';
const STALWART = 'urn:stalwart:jmap';
const HOLD_MAX = 604800;

/** SHA-256 (hex) of asset `name` from the release API response, otherwise null. */
export function assetDigest(release, name) {
  const asset = release?.assets?.find((a) => a.name === name);
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? '');
  return match ? match[1] : null;
}

// --- Randomness, encodings, redaction ---------------------------------------

/** Random secret of `bytes` bytes, base64url (only [A-Za-z0-9_-]). */
export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/** Form encoding (application/x-www-form-urlencoded) of a value. */
export function formEncode(value) {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

/** HTTP Basic for accounts (RFC 7617): name and secret unchanged. */
export function basicAuth(login, secret) {
  return `Basic ${Buffer.from(`${login}:${secret}`).toString('base64')}`;
}

/** HTTP Basic for OAuth clients (RFC 6749 › 2.3.1): both parts form-encoded. */
export function clientBasicAuth(clientId, clientSecret) {
  return basicAuth(formEncode(clientId), formEncode(clientSecret));
}

/** PKCE S256 (RFC 7636): verifier (random if not given) and challenge. */
export function pkce(verifier = randomSecret(32)) {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) without padding, as in otpauth URLs. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** TOTP (RFC 6238, HOTP per RFC 4226) for key `key` at time `time` (seconds). */
export function totp(key, { time = Date.now() / 1000, period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / period)));
  const mac = createHmac(algorithm, key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * Replaces every known secret in `text` with `***`, also URL- and
 * form-encoded. Short values (below six characters) stay, so that ordinary
 * words do not disappear.
 */
export function redact(text, secrets) {
  let out = String(text);
  const variants = new Set();
  for (const s of secrets ?? []) {
    if (typeof s !== 'string' || s.length < 6) continue;
    variants.add(s);
    variants.add(encodeURIComponent(s));
    variants.add(formEncode(s));
  }
  for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.split(v).join('***');
  return out;
}

/** All secrets of a credentials file (for `redact`). */
export function secretsOf(cred) {
  return [
    cred?.recoveryAdmin?.password,
    cred?.admin?.password,
    cred?.admin?.appPassword,
    cred?.user?.password,
    cred?.user?.appPassword,
    cred?.oauthClient?.clientSecret,
  ].filter(Boolean);
}

/** Removes ANSI color codes (Stalwart colors its log in bootstrap mode). */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// --- Credentials ------------------------------------------------------------

/** New credentials with random secrets; admin password and app passwords follow in `bootstrap`/`configure`. */
export function createCredentials({ url = DEFAULT_URL, redirectUris = DEFAULT_REDIRECT_URIS } = {}) {
  const account = (name) => ({ name, login: `${name}@${DOMAIN}`, email: `${name}@${DOMAIN}` });
  return {
    version: 1,
    url,
    domain: DOMAIN,
    recoveryAdmin: { login: 'recovery', password: randomSecret() },
    admin: { ...account('admin'), password: null, appPassword: null, accountId: null },
    user: { ...account('user'), password: randomSecret(), appPassword: null, accountId: null },
    oauthClient: {
      clientId: 'roedy-local',
      clientSecret: randomSecret(32),
      tokenEndpointAuthMethod: 'client_secret_basic',
      scopes: [`${SCOPE}mail`, `${SCOPE}contacts`],
      redirectUris,
    },
  };
}

/** Writes `text` with mode 600 (even if the file already existed). */
export function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readCredentials(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Environment for the Stalwart process (loaded in the shell script with `set -a; .`). Stalwart checks the part after
 * the colon of `STALWART_RECOVERY_ADMIN` like a stored hash (`verify_secret_hash`): if it starts with `_`, `$` or `{`,
 * Stalwart reads it as a hash and rejects the password – with base64url a leading `_` hit on average one in 64 runs.
 * `{PLAIN}` marks it as plain text.
 */
export function serverEnv(cred) {
  const vars = {
    STALWART_RECOVERY_ADMIN: `${cred.recoveryAdmin.login}:{PLAIN}${cred.recoveryAdmin.password}`,
    STALWART_HOSTNAME: HOSTNAME,
    STALWART_PUBLIC_URL: cred.url,
  };
  return Object.entries(vars)
    .map(([k, v]) => `${k}='${v}'\n`)
    .join('');
}

// --- HTTP and JMAP -----------------------------------------------------------

/** HTTP request without redirects; `localAddress` chooses the source address. */
export function request(url, { method = 'GET', headers = {}, body, localAddress, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url), { method, headers, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: parseJson(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout on ${method} ${new URL(url).pathname}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function postJson(url, data, headers = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
}

function postForm(url, params, headers = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

/** JMAP request; returns the methodResponses or throws on HTTP ≠ 200. */
export async function jmap(base, authorization, methodCalls, using = [`${JMAP}core`, STALWART]) {
  const res = await postJson(`${base}/jmap/`, { using, methodCalls }, { authorization });
  if (res.status !== 200) {
    throw Object.assign(new Error(`JMAP responds ${res.status}: ${res.text.slice(0, 300)}`), { status: res.status });
  }
  return res.json.methodResponses;
}

/**
 * After a start in bootstrap or recovery mode, waits until Stalwart accepts the recovery admin: the JMAP session
 * with its credentials responds 200 and names it as `username` (without credentials it responds 200 with an empty
 * name, with wrong ones 401). `wait_ready` in the shell script only waits until the port responds. 401 means "not
 * yet"; any other response and a network error abort immediately. With the `{PLAIN}` prefix (see `serverEnv`) the
 * recovery admin is valid as soon as the port responds, so `timeout` is tight, as is every single
 * request. If it waits, it reports the duration on stderr. Returns the Authorization header.
 */
export async function waitForRecoveryAdmin(
  base,
  { login, password },
  { timeout = 5000, delay = 250, log = console.error } = {},
) {
  const authorization = basicAuth(login, password);
  const start = Date.now();
  for (let waited = false; ; waited = true) {
    const res = await request(`${base}/jmap/session`, { headers: { authorization }, timeout });
    if (res.status === 200) {
      const user = res.json?.username;
      if (user !== login) throw new Error(`session without recovery admin (username ${JSON.stringify(user ?? null)})`);
      if (waited) {
        log(`stalwart.mjs: recovery admin accepted after ${((Date.now() - start) / 1000).toFixed(1)} s`);
      }
      return authorization;
    }
    if (res.status !== 401) throw Object.assign(new Error(`session responds ${res.status}`), { status: res.status });
    if (Date.now() - start >= timeout) {
      const seconds = String(timeout / 1000);
      throw Object.assign(new Error(`recovery admin not accepted after ${seconds} s (401)`), { status: 401 });
    }
    await sleep(delay);
  }
}

/** Response `callId` from methodResponses; throws on a JMAP error. */
export function pick(responses, callId) {
  const hit = responses.find((r) => r[2] === callId);
  if (!hit) throw new Error(`no response for ${callId}`);
  if (hit[0] === 'error') throw new Error(`${callId}: ${hit[1].type} ${hit[1].description ?? ''}`.trim());
  return hit[1];
}

/** Result of `<x>/set` for the one entry `key` (created/updated), otherwise an error with description. */
export function setResult(result, key, kind = 'created') {
  const ok = result?.[kind]?.[key];
  if (ok !== undefined) return ok ?? {};
  const err = result?.[kind === 'created' ? 'notCreated' : 'notUpdated']?.[key];
  const validation = err?.validationErrors ? ` ${JSON.stringify(err.validationErrors)}` : '';
  const detail = err ? `${err.type} ${err.description ?? ''}${validation}` : '?';
  throw new Error(`not saved (${key}): ${detail}`.trim());
}

async function session(base, authorization) {
  const res = await request(`${base}/jmap/session`, { headers: authorization ? { authorization } : {} });
  if (res.status !== 200 || !res.json) throw new Error(`session responds ${res.status}`);
  return res.json;
}

function primaryAccount(sess) {
  return (
    sess.primaryAccounts?.[`${JMAP}mail`] ?? sess.primaryAccounts?.[`${JMAP}core`] ?? Object.keys(sess.accounts)[0]
  );
}

// --- Setup ---------------------------------------------------------------------

/** x:Bootstrap/set: RocksDB in the run directory, log to stdout, domain example.test, no ACME/DKIM. */
export async function bootstrap(cred, recoveryUrl, dataDir) {
  const auth = await waitForRecoveryAdmin(recoveryUrl, cred.recoveryAdmin);
  const responses = await jmap(recoveryUrl, auth, [
    [
      'x:Bootstrap/set',
      {
        update: {
          singleton: {
            defaultHostname: HOSTNAME,
            defaultDomain: cred.domain,
            requestTlsCertificate: false,
            generateDkimKeys: false,
            dataStore: { '@type': 'RocksDb', path: dataDir },
            tracer: { '@type': 'Stdout', ansi: false, level: 'info', enable: true },
          },
        },
      },
      'b',
    ],
  ]);
  const admin = setResult(pick(responses, 'b'), 'singleton', 'updated');
  if (!admin.username || !admin.secret) throw new Error('x:Bootstrap/set without admin account');
  return {
    ...cred,
    admin: { ...cred.admin, login: admin.username, email: admin.username, password: admin.secret },
  };
}

async function createAppPassword(base, login, password, description) {
  const auth = basicAuth(login, password);
  const sess = await session(base, auth);
  const responses = await jmap(base, auth, [
    ['x:AppPassword/set', { create: { p: { description, permissions: { '@type': 'Inherit' } } } }, 'p'],
  ]);
  const created = setResult(pick(responses, 'p'), 'p');
  if (!created.secret) throw new Error(`x:AppPassword/set without secret (${login})`);
  return { appPassword: created.secret, accountId: primaryAccount(sess) };
}

/** In recovery mode as the recovery admin: HTTP listener, CORS, user account, web interface and ASN data off. */
export async function setup(cred, recoveryUrl) {
  const url = new URL(cred.url);
  if (url.protocol !== 'http:' || !url.hostname.startsWith('127.')) throw new Error(`URL not allowed: ${cred.url}`);

  const recovery = await waitForRecoveryAdmin(recoveryUrl, cred.recoveryAdmin);
  const found = await jmap(recoveryUrl, recovery, [
    ['x:Domain/get', {}, 'd'],
    ['x:Application/get', {}, 'a'],
  ]);
  const domain = pick(found, 'd').list.find((d) => d.name === cred.domain);
  if (!domain) throw new Error(`domain ${cred.domain} missing after the bootstrap`);
  // Otherwise Stalwart loads the web interface (webui.zip) and ASN data from GitHub on every start.
  const apps = pick(found, 'a').list.filter((app) => app.enable);
  const offline = [
    // `Disabled` is the initial value and is not stored on its own; without a stored object the normal start
    // creates the default sources. So first a source without addresses, then `Disabled`.
    ['x:Asn/set', { update: { singleton: { '@type': 'Resource', asnUrls: {}, geoUrls: {} } } }, 'r'],
    ['x:Asn/set', { update: { singleton: { '@type': 'Disabled' } } }, 'n'],
    ...(apps.length
      ? [['x:Application/set', { update: Object.fromEntries(apps.map((app) => [app.id, { enable: false }])) }, 'w']]
      : []),
  ];

  // Only HTTP on 127.0.0.1; without its own listener start 3 would create the default listeners (25, 443, 993 …) on [::].
  const responses = await jmap(recoveryUrl, recovery, [
    [
      'x:NetworkListener/set',
      {
        create: {
          http: {
            name: 'http',
            protocol: 'http',
            bind: { [`${url.hostname}:${url.port || 80}`]: true },
            useTls: false,
          },
        },
      },
      'l',
    ],
    ['x:Http/set', { update: { singleton: { usePermissiveCors: true } } }, 'h'],
    [
      'x:Account/set',
      {
        create: {
          u: {
            '@type': 'User',
            name: cred.user.name,
            domainId: domain.id,
            description: 'Roedy Mail test account',
            credentials: { 0: { '@type': 'Password', secret: cred.user.password } },
            roles: { '@type': 'User' },
          },
        },
      },
      'u',
    ],
    ...offline,
  ]);
  setResult(pick(responses, 'r'), 'singleton', 'updated');
  setResult(pick(responses, 'n'), 'singleton', 'updated');
  for (const app of apps) setResult(pick(responses, 'w'), app.id, 'updated');
  setResult(pick(responses, 'l'), 'http');
  setResult(pick(responses, 'h'), 'singleton', 'updated');
  setResult(pick(responses, 'u'), 'u');

  return cred;
}

/**
 * In normal operation (recovery mode only lets the recovery admin reach JMAP,
 * accounts get 403): app passwords for admin and user, then the confidential
 * OAuth client, created with the admin's app password.
 */
export async function setupAccounts(cred) {
  const base = cred.url;
  const admin = await createAppPassword(base, cred.admin.login, cred.admin.password, 'Roedy local (admin)');
  const user = await createAppPassword(base, cred.user.login, cred.user.password, 'Roedy local (user)');

  const c = cred.oauthClient;
  const client = await jmap(base, basicAuth(cred.admin.login, admin.appPassword), [
    [
      'x:OAuthClient/set',
      {
        create: {
          c: {
            clientId: c.clientId,
            description: 'Roedy Mail (local test)',
            secret: c.clientSecret,
            redirectUris: Object.fromEntries(c.redirectUris.map((u) => [u, true])),
            scopes: Object.fromEntries(c.scopes.map((s) => [s.slice(SCOPE.length), true])),
            grantTypes: { authorizationCode: true, refreshToken: true },
          },
        },
      },
      'c',
    ],
  ]);
  setResult(pick(client, 'c'), 'c');

  return { ...cred, admin: { ...cred.admin, ...admin }, user: { ...cred.user, ...user } };
}

// --- Checks --------------------------------------------------------------------

/**
 * Short description of a response without secrets: status and OAuth error
 * (`error`), otherwise the type of an /api/auth response or the title of a
 * problem details object (RFC 9457, where `type` is a URI).
 */
export function summarize(res) {
  const j = res.json ?? {};
  const type = typeof j.type === 'string' && !/[:/]/.test(j.type) ? j.type : null;
  const text = j.error ?? type ?? j.title;
  return text ? `${res.status} ${text}` : String(res.status);
}

const has = (v) => v !== undefined && v !== null && v !== '';

/** OAuth metadata (RFC 8414) as Stalwart v1 publishes it and the app relies on. */
export function evalMetadata(res, base) {
  const m = res.json ?? {};
  const parts = [
    [res.status === 200, String(res.status)],
    [m.issuer === base, m.issuer === base ? 'issuer = base' : `issuer ${m.issuer}`],
    [m.authorization_endpoint === `${base}/login`, `authorization_endpoint ${pathOf(m.authorization_endpoint)}`],
    [(m.code_challenge_methods_supported ?? []).includes('S256'), `PKCE ${m.code_challenge_methods_supported}`],
    [
      m.authorization_response_iss_parameter_supported === true,
      `iss ${m.authorization_response_iss_parameter_supported}`,
    ],
    [
      (m.token_endpoint_auth_methods_supported ?? []).includes('none'),
      `auth ${m.token_endpoint_auth_methods_supported}`,
    ],
    ...['revocation_endpoint', 'introspection_endpoint', 'end_session_endpoint'].map((k) => [
      has(m[k]),
      `${k.replace('_endpoint', '')} ${pathOf(m[k])}`,
    ]),
    [Array.isArray(m.protected_resources), `protected_resources ${JSON.stringify(m.protected_resources)}`],
    [
      typeof m.client_id_metadata_document_supported === 'boolean',
      `client_id_metadata_document_supported ${m.client_id_metadata_document_supported}`,
    ],
  ];
  return combine(parts);
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

function combine(parts) {
  return { ok: parts.every(([ok]) => ok), actual: parts.map(([, text]) => text).join('; ') };
}

export function evalDiscovery(res) {
  const location = res.headers?.location ?? '';
  return combine([
    [res.status === 307, String(res.status)],
    [/\/jmap\/session$/.test(location), `Location ${pathOf(location) || location || '–'}`],
  ]);
}

export function evalAnonymousSession(res) {
  const accounts = res.json?.accounts;
  return combine([
    [res.status === 200, String(res.status)],
    [accounts && Object.keys(accounts).length === 0, `accounts ${JSON.stringify(accounts)}`],
  ]);
}

export function evalCors(simple, preflight) {
  const allowHeaders = String(preflight.headers?.['access-control-allow-headers'] ?? '');
  const origin = simple.headers?.['access-control-allow-origin'];
  const expose = simple.headers?.['access-control-expose-headers'];
  return combine([
    [simple.status === 200 && origin === '*', `GET ${simple.status}, Allow-Origin ${origin ?? '–'}`],
    [expose === undefined, `Expose-Headers ${expose ?? '–'}`],
    [
      preflight.status < 300 && /(^|,\s*)authorization(\s*,|$)/i.test(allowHeaders),
      `Preflight ${preflight.status}, Allow-Headers ${allowHeaders || '–'}`,
    ],
  ]);
}

/** Expected status and OAuth error code (`error`), e.g. 400 invalid_grant. */
export function evalError(res, status, error) {
  return {
    ok: res.status === status && (!error || res.json?.error === error),
    actual: summarize(res),
  };
}

export function evalTokenResponse(res) {
  const t = res.json ?? {};
  return combine([
    [res.status === 200, String(res.status)],
    [t.expires_in === 3600, `expires_in ${t.expires_in}`],
    [/^bearer$/i.test(t.token_type ?? ''), `token_type ${t.token_type}`],
    [
      has(t.access_token) && has(t.refresh_token),
      `access_token ${mark(t.access_token)}, refresh_token ${mark(t.refresh_token)}`,
    ],
  ]);
}

const mark = (v) => (has(v) ? 'present' : 'missing');

/** 101 anonymous requests from 127.0.0.2: 100 × 200, then 429 with Retry-After; 127.0.0.1 still 200 afterwards. */
export function evalRateLimit(statuses, last, exempt) {
  const before = statuses.slice(0, -1);
  const okBefore = before.filter((s) => s === 200).length;
  const retry = last?.headers?.['retry-after'];
  return combine([
    [okBefore === 100 && before.length === 100, `requests 1–100: ${okBefore} × 200`],
    [last?.status === 429 && has(retry), `request 101: ${last?.status}, Retry-After ${retry ?? '–'}`],
    [exempt?.status === 200, `afterwards from 127.0.0.1: ${exempt?.status}`],
  ]);
}

/** Result lines of a check (✓/✗, expected, actual). */
export function formatResult({ name, expected, ok, actual }) {
  return `${ok ? '✓' : '✗'} ${name}\n    expected: ${expected}\n    actual: ${actual}`;
}

/** All checks in order; errors of a check only end that check. */
export async function runChecks(cred, { log = console.log } = {}) {
  const base = cred.url;
  const ctx = { base, cred, secrets: [...secretsOf(cred)] };
  const results = [];
  const started = Date.now();
  for (const check of CHECKS) {
    let result;
    try {
      result = await check.run(ctx);
    } catch (err) {
      result = { ok: false, actual: `Error: ${err.message}` };
    }
    const line = { name: check.name, expected: check.expected, ...result };
    line.actual = redact(line.actual, ctx.secrets);
    results.push(line);
    log(formatResult(line));
  }
  const failed = results.filter((r) => !r.ok).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`\n${results.length - failed} of ${results.length} checks passed (${seconds} s)`);
  return failed === 0;
}

/** Sign-in via /api/auth (like the sign-in page, without a browser) up to the code at the redirect URI. */
async function authorize(ctx, { scope, account = ctx.cred.user, mfaToken } = {}) {
  const c = ctx.cred.oauthClient;
  const { verifier, challenge } = pkce();
  const state = randomSecret(16);
  const redirectUri = c.redirectUris[0];
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const steps = [];
  const login = { type: 'authCode', accountName: account.login, accountSecret: account.password, query };
  if (mfaToken) login.mfaToken = mfaToken;
  let res = await postJson(`${ctx.base}/api/auth`, login);
  steps.push(summarize(res));
  if (res.json?.type === 'consentRequired') {
    ctx.secrets.push(res.json.token);
    res = await postJson(`${ctx.base}/api/auth`, { type: 'authConsent', token: res.json.token, query, consent: true });
    steps.push(summarize(res));
  }
  const result = { steps, verifier, redirectUri };
  if (res.json?.type !== 'authenticated') return result;
  const location = new URL(res.json.location);
  result.code = location.searchParams.get('code');
  ctx.secrets.push(result.code);
  result.stateOk = location.searchParams.get('state') === state;
  result.iss = location.searchParams.get('iss');
  result.redirectOk = `${location.origin}${location.pathname}` === redirectUri;
  return result;
}

async function token(ctx, params) {
  const c = ctx.cred.oauthClient;
  const res = await postForm(`${ctx.base}/auth/token`, params, {
    authorization: clientBasicAuth(c.clientId, c.clientSecret),
  });
  for (const k of ['access_token', 'refresh_token', 'id_token']) if (res.json?.[k]) ctx.secrets.push(res.json[k]);
  return res;
}

const exchange = (ctx, auth) =>
  token(ctx, {
    grant_type: 'authorization_code',
    code: auth.code,
    redirect_uri: auth.redirectUri,
    code_verifier: auth.verifier,
  });
const refresh = (ctx, refreshToken) => token(ctx, { grant_type: 'refresh_token', refresh_token: refreshToken });
const bearer = (t) => `Bearer ${t}`;

function need(value, what) {
  if (!value) throw new Error(`prerequisite missing: ${what}`);
  return value;
}

/** Sign-in with code exchange; returns tokens or throws with the steps. */
async function grant(ctx, scope) {
  const auth = await authorize(ctx, { scope });
  if (!auth.code) throw new Error(`sign-in: ${auth.steps.join(' → ')}`);
  const res = await exchange(ctx, auth);
  if (res.status !== 200) throw new Error(`code exchange: ${summarize(res)}`);
  return { auth, res, access: res.json.access_token, refresh: res.json.refresh_token };
}

/** JMAP request with the whole HTTP response, for checks that evaluate status or errors. */
const jmapStatus = (base, authorization, methodCalls, using) =>
  postJson(`${base}/jmap/`, { using, methodCalls }, { authorization });

const DCR_BASE = {
  client_name: 'Roedy Mail Test',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: `${SCOPE}mail ${SCOPE}contacts`,
};

export const CHECKS = [
  {
    name: 'OAuth metadata',
    expected:
      '200; issuer = base; authorization_endpoint /login; PKCE S256; iss true; auth with none; ' +
      'revocation, introspection, end_session present; protected_resources; client_id_metadata_document_supported',
    run: async (ctx) => evalMetadata(await request(`${ctx.base}/.well-known/oauth-authorization-server`), ctx.base),
  },
  {
    name: 'JMAP discovery',
    expected: '307; Location /jmap/session',
    run: async (ctx) => evalDiscovery(await request(`${ctx.base}/.well-known/jmap`)),
  },
  {
    name: 'Session without authentication',
    expected: '200; accounts {}',
    run: async (ctx) => evalAnonymousSession(await request(`${ctx.base}/jmap/session`)),
  },
  {
    name: 'CORS',
    expected: 'GET 200, Allow-Origin *; Expose-Headers –; Preflight 2xx, Allow-Headers with Authorization',
    run: async (ctx) => {
      const origin = 'http://127.0.0.1:5173';
      const simple = await request(`${ctx.base}/jmap/session`, { headers: { origin } });
      const preflight = await request(`${ctx.base}/jmap/`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      return evalCors(simple, preflight);
    },
  },
  {
    name: 'DCR public with https redirect',
    expected: '400 invalid_redirect_uri',
    run: async (ctx) => {
      const res = await postJson(`${ctx.base}/auth/register`, {
        ...DCR_BASE,
        redirect_uris: [`https://roedy.${DOMAIN}/oauth/callback`],
        token_endpoint_auth_method: 'none',
      });
      return evalError(res, 400, 'invalid_redirect_uri');
    },
  },
  {
    name: 'DCR confidential without authentication',
    expected: '401',
    run: async (ctx) => {
      const res = await postJson(`${ctx.base}/auth/register`, {
        ...DCR_BASE,
        redirect_uris: [`https://roedy.${DOMAIN}/oauth/callback`],
        token_endpoint_auth_method: 'client_secret_basic',
      });
      return evalError(res, 401);
    },
  },
  {
    name: 'DCR confidential with admin app password',
    expected: '201; client_secret present; client_secret_expires_at 0',
    run: async (ctx) => {
      const { admin } = ctx.cred;
      const res = await postJson(
        `${ctx.base}/auth/register`,
        {
          ...DCR_BASE,
          redirect_uris: [`https://roedy.${DOMAIN}/oauth/callback`],
          token_endpoint_auth_method: 'client_secret_basic',
        },
        { authorization: basicAuth(admin.login, admin.appPassword) },
      );
      if (res.json?.client_secret) ctx.secrets.push(res.json.client_secret);
      return combine([
        [res.status === 201, summarize(res)],
        [has(res.json?.client_secret), `client_secret ${mark(res.json?.client_secret)}`],
        [res.json?.client_secret_expires_at === 0, `client_secret_expires_at ${res.json?.client_secret_expires_at}`],
      ]);
    },
  },
  {
    name: 'Sign-in via /api/auth and code exchange',
    expected:
      'authCode → consentRequired → authenticated; redirect URI, state and iss match; 200; expires_in 3600; token_type Bearer; access_token and refresh_token',
    run: async (ctx) => {
      const auth = await authorize(ctx, { scope: `${SCOPE}mail ${SCOPE}contacts` });
      const steps = {
        ok: auth.steps.length === 2 && /authenticated$/.test(auth.steps[1]),
        actual: auth.steps.join(' → '),
      };
      if (!auth.code) return { ok: false, actual: steps.actual };
      const res = await exchange(ctx, auth);
      ctx.flowA = { auth, refresh: res.json?.refresh_token, access: res.json?.access_token };
      const tokens = evalTokenResponse(res);
      return combine([
        [steps.ok && /consentRequired/.test(auth.steps[0]), steps.actual],
        [
          auth.redirectOk && auth.stateOk && auth.iss === ctx.base,
          `Redirect ${auth.redirectOk}, state ${auth.stateOk}, iss ${auth.iss === ctx.base ? '= base' : auth.iss}`,
        ],
        [tokens.ok, tokens.actual],
      ]);
    },
  },
  {
    name: 'Code a second time',
    expected: '400 invalid_grant',
    run: async (ctx) => evalError(await exchange(ctx, need(ctx.flowA, 'code exchange').auth), 400, 'invalid_grant'),
  },
  {
    name: 'Scope Mail and Contacts',
    expected: 'session with urn:ietf:params:jmap:contacts',
    run: async (ctx) => {
      const sess = await session(ctx.base, bearer(need(ctx.flowA?.access, 'access token')));
      const account = sess.accounts?.[primaryAccount(sess)];
      const hasContacts = `${JMAP}contacts` in (sess.capabilities ?? {});
      const inAccount = `${JMAP}contacts` in (account?.accountCapabilities ?? {});
      return { ok: hasContacts && inAccount, actual: `contacts in session ${hasContacts}, in account ${inAccount}` };
    },
  },
  {
    name: 'Refresh rotates',
    expected: '200; new refresh_token ≠ old',
    run: async (ctx) => {
      const a = need(ctx.flowA?.refresh, 'refresh token');
      const res = await refresh(ctx, a);
      ctx.flowA.r2 = res.json?.refresh_token;
      return combine([
        [res.status === 200, summarize(res)],
        [
          has(ctx.flowA.r2) && ctx.flowA.r2 !== a,
          `new refresh_token ${has(ctx.flowA.r2) ? (ctx.flowA.r2 !== a ? 'different' : 'same') : 'missing'}`,
        ],
      ]);
    },
  },
  {
    name: 'Old refresh token while the new one is unused',
    expected: '200',
    run: async (ctx) => {
      const res = await refresh(ctx, need(ctx.flowA?.r2 && ctx.flowA.refresh, 'rotation'));
      return { ok: res.status === 200 && has(res.json?.refresh_token), actual: summarize(res) };
    },
  },
  {
    name: 'Replaced refresh token after the new one was used',
    expected: 'new → 200; old → 400 invalid_grant; newest → 400 invalid_grant; access token → 401',
    run: async (ctx) => {
      const f = need(ctx.flowA?.r2 && ctx.flowA, 'rotation');
      const next = await refresh(ctx, f.r2);
      const r3 = next.json?.refresh_token;
      const old = await refresh(ctx, f.refresh);
      const newest = r3 ? await refresh(ctx, r3) : { status: '–', json: null };
      const access = next.json?.access_token ?? f.access;
      const jmapRes = await request(`${ctx.base}/jmap/session`, { headers: { authorization: bearer(access) } });
      return combine([
        [next.status === 200 && has(r3), `new ${summarize(next)}`],
        [old.status === 400 && old.json?.error === 'invalid_grant', `old ${summarize(old)}`],
        [newest.status === 400 && newest.json?.error === 'invalid_grant', `newest ${summarize(newest)}`],
        [jmapRes.status === 401, `access token ${jmapRes.status}`],
      ]);
    },
  },
  {
    name: 'Scope Mail only',
    expected: 'session without urn:ietf:params:jmap:contacts; AddressBook/get → unknownMethod',
    run: async (ctx) => {
      const g = await grant(ctx, `${SCOPE}mail`);
      ctx.flowB = g;
      const sess = await session(ctx.base, bearer(g.access));
      const accountId = primaryAccount(sess);
      const hasContacts = `${JMAP}contacts` in (sess.capabilities ?? {});
      const res = await jmapStatus(
        ctx.base,
        bearer(g.access),
        [['AddressBook/get', { accountId }, 'a']],
        [`${JMAP}core`, `${JMAP}contacts`],
      );
      const answer = res.json?.methodResponses?.[0];
      const result = answer ? `${answer[0]} ${answer[1]?.type ?? ''}`.trim() : summarize(res);
      return combine([
        [!hasContacts, `contacts in session ${hasContacts}`],
        [answer?.[0] === 'error' && answer[1]?.type === 'unknownMethod', `AddressBook/get → ${result}`],
      ]);
    },
  },
  {
    name: 'Revocation via /auth/revoke',
    expected: 'revoke 200; refresh → 400 invalid_grant; access token → 401',
    run: async (ctx) => {
      const g = need(ctx.flowB, 'token with scope Mail');
      const c = ctx.cred.oauthClient;
      const revoke = await postForm(
        `${ctx.base}/auth/revoke`,
        { token: g.refresh, token_type_hint: 'refresh_token' },
        { authorization: clientBasicAuth(c.clientId, c.clientSecret) },
      );
      const again = await refresh(ctx, g.refresh);
      const jmapRes = await request(`${ctx.base}/jmap/session`, { headers: { authorization: bearer(g.access) } });
      return combine([
        [revoke.status === 200, `revoke ${summarize(revoke)}`],
        [again.status === 400 && again.json?.error === 'invalid_grant', `refresh ${summarize(again)}`],
        [jmapRes.status === 401, `access token ${jmapRes.status}`],
      ]);
    },
  },
  {
    name: 'App password via Basic on JMAP',
    expected: 'Mailbox/get 200 with mailboxes (user)',
    run: async (ctx) => {
      const { user } = ctx.cred;
      const auth = basicAuth(user.login, user.appPassword);
      const sess = await session(ctx.base, auth);
      const res = await jmapStatus(
        ctx.base,
        auth,
        [['Mailbox/get', { accountId: primaryAccount(sess), properties: ['role'] }, 'm']],
        [`${JMAP}core`, `${JMAP}mail`],
      );
      const list = res.json?.methodResponses?.[0]?.[1]?.list ?? [];
      return { ok: res.status === 200 && list.length > 0, actual: `${res.status}, ${list.length} mailboxes` };
    },
  },
  {
    name: 'Push subscriptions',
    expected:
      'capabilities webpush-vapid with key and emailpush; create with token (scope Mail), expiry cut to 7 days; ' +
      'emailPush with filter stored; verificationCode null before verification, also without properties (as the ' +
      'app reads it); wrong code rejected; url not changeable; http and private host rejected; remove',
    run: async (ctx) => {
      // The same calls as the app; nothing is delivered locally, Stalwart only sends to public hosts. Hence the
      // verified case stays unchecked: the code only arrives with the `PushVerification`. From v1.1.0 `get` returns
      // it for a verified subscription (up to v1.0.x always `null`); the app counts that as confirmed.
      const {
        JmapClient,
        createPushSubscription,
        destroyPushSubscriptions,
        listPushSubscriptions,
        renewPushSubscription,
        verifyPushSubscription,
        webPushKey,
      } = await import('../../packages/jmap/src/index.ts');
      const { access } = await grant(ctx, `${SCOPE}mail`);
      const tokens = { token: () => Promise.resolve(access) };
      const client = new JmapClient({ url: ctx.base, tokens });
      const sess = await client.session();
      const key = webPushKey(sess);
      const accountId = await client.accountId();
      const inbox = (await client.call('Mailbox/query', { accountId, filter: { role: 'inbox' } })).ids[0];
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keys = {
        p256dh: publicKey.export({ format: 'der', type: 'spki' }).subarray(-65).toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      };
      const entry = (over = {}) => ({
        deviceClientId: 'roedy-mail-check',
        url: 'https://push.example.com/check',
        keys,
        types: ['EmailDelivery'],
        ...over,
      });
      const emailPush = {
        [accountId]: { filter: { inMailbox: need(inbox, 'inbox') }, properties: ['id', 'threadId'] },
      };
      const far = new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const created = await createPushSubscription(client, { ...entry({ emailPush }), expires: far });
      const days = (Date.parse(created.expires) - Date.now()) / 86_400_000;
      const stored = await client.call('PushSubscription/get', {
        ids: [created.id],
        properties: ['deviceClientId', 'emailPush', 'verificationCode'],
      });
      const refusal = (promise) =>
        promise.then(
          () => 'accepted',
          (err) => err.details?.detail ?? err.message,
        );
      const listed = (await listPushSubscriptions(client)).find((item) => item.id === created.id);
      const wrong = await refusal(verifyPushSubscription(client, created.id, 'wrong'));
      await renewPushSubscription(client, created.id, far);
      const urlUpdate = await client.call('PushSubscription/set', {
        update: { [created.id]: { url: 'https://push.example.com/other' } },
      });
      const http = await refusal(createPushSubscription(client, entry({ url: 'http://push.example.com/a' })));
      const local = await refusal(createPushSubscription(client, entry({ url: 'https://localhost/a' })));
      await destroyPushSubscriptions(client, [created.id, 'zzzzzz']);
      const after = await listPushSubscriptions(client);
      const config = stored.list[0]?.emailPush?.[accountId];
      return combine([
        [typeof key === 'string' && key.length > 40, 'key in the session'],
        [`${JMAP}emailpush` in sess.capabilities, 'emailpush in the session'],
        [days > 6.9 && days <= 7.01, `expiry ${days.toFixed(1)} days`],
        [stored.list[0]?.verificationCode === null, 'verificationCode null'],
        [listed?.verificationCode === null, 'verificationCode without properties'],
        [config?.filter?.inMailbox === inbox && config?.properties?.join() === 'id,threadId', 'emailPush stored'],
        [wrong === 'Verification code does not match.', `wrong code: ${wrong}`],
        [!!urlUpdate.notUpdated?.[created.id], 'url immutable'],
        [http === 'URL scheme is not permitted', `http: ${http}`],
        [local === 'Host is not a public domain name', `localhost: ${local}`],
        [!after.some((item) => item.id === created.id), 'removed'],
      ]);
    },
  },
  {
    name: 'Sieve',
    expected:
      'capability sieve with scope Mail and Contacts; rules script valid, broken one invalidScript; create with ' +
      'activation, model readable from the download; vacation reply (script vacation) displaces the rules, after ' +
      'its end none is active, activating the rules turns it off; saving above maxSizeScript ' +
      '→ tooLarge, broken script → invalidScript (page texts)',
    run: async (ctx) => {
      // The same calls as `jmapRulesApi` (apps/web/src/lib/rules.svelte.ts), the script from the app's generator.
      const { JmapClient, SIEVE, SIEVE_TYPE, hasAccountCapability, sieveCapability } =
        await import('../../packages/jmap/src/index.ts');
      const { readModel, SCRIPT_NAME, storedScript } = await import('../../apps/web/src/lib/sieve/generate.ts');
      const { access } = await grant(ctx, `${SCOPE}mail ${SCOPE}contacts`);
      const client = new JmapClient({ url: ctx.base, tokens: { token: () => Promise.resolve(access) } });
      const sess = await client.session();
      const accountId = await client.accountId();
      const cap = sieveCapability(sess, accountId);
      const model = {
        forward: { on: true, to: 'copy@example.test', keep: true },
        rules: [
          {
            id: 'r1',
            name: 'Invoices “file” \\ "quoted"',
            on: true,
            match: 'any',
            conds: [
              ['from', 'invoice@'],
              ['subj', 'Invoice'],
            ],
            acts: [
              ['move', 'f1'],
              ['tag', 't1'],
              ['read', ''],
            ],
          },
          {
            id: 'r2',
            name: 'Café\ntwo lines',
            on: true,
            match: 'all',
            conds: [
              ['size', '1,5'],
              ['att', ''],
            ],
            acts: [['del', '']],
          },
          {
            id: 'r3',
            name: 'Off',
            on: false,
            match: 'all',
            conds: [['to', 'team@']],
            acts: [['fwd', 'x@example.test']],
          },
          {
            id: 'r4',
            name: 'Target missing',
            on: true,
            match: 'all',
            conds: [['size', '10']],
            acts: [['move', 'gone']],
          },
        ],
      };
      const targets = {
        folder: (id) => (id === 'f1' ? 'Invoices/2026' : null),
        tag: (id) => (id === 't1' ? 'Tags/Important' : null),
      };
      const upload = async (text) => (await client.upload(accountId, text, SIEVE_TYPE)).blobId;
      const good = await upload(storedScript(model, targets));
      const bad = await upload('require ["fileinto"];\nif header :contains "from" {\n  fileinto "x"\n}\n');
      const valid = await client.call('SieveScript/validate', { accountId, blobId: good });
      const broken = await client.call('SieveScript/validate', { accountId, blobId: bad });
      const scripts = async () => (await client.call('SieveScript/get', { accountId })).list;
      const active = async () => (await scripts()).find((s) => s.isActive)?.name ?? 'none';
      const created = await client.call('SieveScript/set', {
        accountId,
        create: { r: { name: SCRIPT_NAME, blobId: good } },
        onSuccessActivateScript: '#r',
      });
      const id = need(created.created?.r?.id, `script created (${JSON.stringify(created.notCreated)})`);
      const ours = (await scripts()).find((s) => s.id === id);
      const blob = await client.download({ accountId, blobId: ours.blobId, type: SIEVE_TYPE });
      const back = readModel(await blob.text());
      const afterCreate = await active();
      const vacation = (isEnabled) =>
        client.call('VacationResponse/set', {
          accountId,
          update: { singleton: isEnabled ? { isEnabled, subject: 'Away', textBody: 'Out of office' } : { isEnabled } },
        });
      await vacation(true);
      const withVacation = await active();
      await vacation(false);
      const afterVacation = await active();
      await vacation(true);
      await client.call('SieveScript/set', { accountId, onSuccessActivateScript: id });
      const reactivated = await active();
      const get = await client.call('VacationResponse/get', { accountId, ids: ['singleton'] });
      const vacationAfter = get.list[0]?.isEnabled;
      // Rejections when saving select the page's error toast (`saveErrorText`).
      const big = cap.maxSizeScript ? await upload(`# ${'x'.repeat(cap.maxSizeScript)}\nkeep;\n`) : null;
      const tooBig = big
        ? await client.call('SieveScript/set', { accountId, create: { b: { name: 'too-large', blobId: big } } })
        : null;
      const refused = await client.call('SieveScript/set', {
        accountId,
        create: { k: { name: 'broken', blobId: bad } },
      });
      const extra = [tooBig?.created?.b?.id, refused.created?.k?.id].filter(Boolean);
      // Clean up: an active script cannot be deleted (`scriptIsActive`).
      await client.call('SieveScript/set', { accountId, onSuccessDeactivateScript: true });
      await client.call('SieveScript/set', { accountId, destroy: [id, ...extra] });
      const error = broken.error;
      const bigError = tooBig?.notCreated?.b?.type ?? (tooBig ? 'created' : 'without maxSizeScript');
      const refusedError = refused.notCreated?.k?.type ?? 'created';
      return combine([
        [hasAccountCapability(sess, accountId, SIEVE), 'sieve on the account'],
        [cap.maxNumberRedirects !== null, `maxNumberRedirects ${cap.maxNumberRedirects}`],
        [
          ['fileinto', 'imap4flags', 'copy'].every((e) => cap.sieveExtensions.includes(e)),
          'fileinto, imap4flags, copy offered',
        ],
        [valid.error === null, `validate ${valid.error ? valid.error.description : 'valid'}`],
        [error?.type === 'invalidScript', `broken: ${error?.type}`],
        [afterCreate === SCRIPT_NAME, `active after creating: ${afterCreate}`],
        [JSON.stringify(back) === JSON.stringify(model), 'model read'],
        [withVacation === 'vacation', `active with vacation reply: ${withVacation}`],
        [afterVacation === 'none', `active after its end: ${afterVacation}`],
        [reactivated === SCRIPT_NAME && vacationAfter === false, `rules activated, vacation reply ${vacationAfter}`],
        [bigError === 'tooLarge', `above ${cap.maxSizeScript} bytes: ${bigError}`],
        [refusedError === 'invalidScript', `broken saved: ${refusedError}`],
      ]);
    },
  },
  {
    name: 'FUTURERELEASE',
    expected: `maxDelayedSend in the session, FUTURERELEASE offered; HOLDFOR 8 days → rejected "Requested hold time exceeds maximum of ${HOLD_MAX} seconds"`,
    run: async (ctx) => {
      const { user, admin } = ctx.cred;
      const auth = basicAuth(user.login, user.appPassword);
      const sess = await session(ctx.base, auth);
      const accountId = primaryAccount(sess);
      const sub = sess.accounts?.[accountId]?.accountCapabilities?.[`${JMAP}submission`] ?? {};
      const using = [`${JMAP}core`, `${JMAP}mail`, `${JMAP}submission`];
      const drafts = pick(
        await jmap(ctx.base, auth, [['Mailbox/query', { accountId, filter: { role: 'drafts' } }, 'q']], using),
        'q',
      ).ids[0];
      const responses = await jmap(
        ctx.base,
        auth,
        [
          ['Identity/set', { accountId, create: { i: { name: 'User', email: user.email } } }, 'i'],
          [
            'Email/set',
            {
              accountId,
              create: {
                e: {
                  mailboxIds: { [need(drafts, 'drafts')]: true },
                  keywords: { $draft: true },
                  from: [{ name: 'User', email: user.email }],
                  to: [{ email: admin.email }],
                  subject: 'HOLDFOR-Test',
                  bodyValues: { t: { value: 'Test' } },
                  textBody: [{ partId: 't', type: 'text/plain' }],
                },
              },
            },
            'e',
          ],
          [
            'EmailSubmission/set',
            {
              accountId,
              create: {
                s: {
                  identityId: '#i',
                  emailId: '#e',
                  envelope: {
                    mailFrom: { email: user.email, parameters: { HOLDFOR: String(8 * 86400) } },
                    rcptTo: [{ email: admin.email }],
                  },
                },
              },
            },
            's',
          ],
        ],
        using,
      );
      const result = pick(responses, 's');
      const err = result.notCreated?.s;
      const text = err ? `${err.type}: ${err.description ?? ''}` : result.created?.s ? 'accepted' : '?';
      return combine([
        [Number.isInteger(sub.maxDelayedSend), `maxDelayedSend ${sub.maxDelayedSend}`],
        [
          'FUTURERELEASE' in (sub.submissionExtensions ?? {}),
          `FUTURERELEASE ${JSON.stringify(sub.submissionExtensions?.FUTURERELEASE)}`,
        ],
        [String(err?.description).includes(`Requested hold time exceeds maximum of ${HOLD_MAX} seconds`), text],
      ]);
    },
  },
  {
    name: 'Anonymous rate limit',
    expected: 'from 127.0.0.2: requests 1–100 × 200, request 101 → 429 with Retry-After; 127.0.0.1 exempt (200)',
    run: async (ctx) => {
      const url = `${ctx.base}/.well-known/oauth-authorization-server`;
      // Stalwart counts in fixed windows from the epoch (`RateWindow`: now / period, here one minute); if the
      // requests cross a window change, the counter starts anew. With less than 10 s left, wait for the next one.
      const left = 60 - ((Date.now() / 1000) % 60);
      if (left < 10) await sleep(left * 1000 + 200);
      const statuses = [];
      let last;
      for (let i = 0; i < 101; i++) {
        last = await request(url, { localAddress: '127.0.0.2' });
        statuses.push(last.status);
      }
      return evalRateLimit(statuses, last, await request(url));
    },
  },
  {
    name: 'TOTP for the admin account',
    expected:
      'x:AccountPassword/set with otpUrl; Basic with password → 402 "MFA code required"; app password → 200; ' +
      '/api/auth without code → mfaRequired, with code → consentRequired',
    run: async (ctx) => {
      const { admin } = ctx.cred;
      const key = randomBytes(20);
      const secret = base32Encode(key);
      ctx.secrets.push(secret);
      const label = encodeURIComponent(`Roedy Mail:${admin.login}`);
      const otpUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Roedy Mail')}`;
      const set = pick(
        await jmap(ctx.base, basicAuth(admin.login, admin.password), [
          [
            'x:AccountPassword/set',
            { update: { singleton: { currentSecret: admin.password, otpAuth: { otpUrl } } } },
            't',
          ],
        ]),
        't',
      );
      setResult(set, 'singleton', 'updated');
      const using = [`${JMAP}core`, `${JMAP}mail`];
      const calls = [['Mailbox/get', { ids: [] }, 'm']];
      const withPassword = await jmapStatus(ctx.base, basicAuth(admin.login, admin.password), calls, using);
      const withApp = await jmapStatus(ctx.base, basicAuth(admin.login, admin.appPassword), calls, using);
      const scope = `${SCOPE}mail`;
      const noCode = await authorize(ctx, { scope, account: admin });
      const withCode = await authorize(ctx, { scope, account: admin, mfaToken: totp(key) });
      const title = withPassword.json?.title ?? '';
      return combine([
        [withPassword.status === 402 && title === 'MFA code required', `password ${withPassword.status} "${title}"`],
        [withApp.status === 200, `app password ${withApp.status}`],
        [noCode.steps[0] === '200 mfaRequired', `without code ${noCode.steps.join(' → ')}`],
        [/consentRequired|authenticated/.test(withCode.steps[0] ?? ''), `with code ${withCode.steps[0]}`],
      ]);
    },
  },
];

// --- Entry point -----------------------------------------------------------------

// Downloads of the first two starts (web interface; ASN data, if created after all) that fail
// without network access: only noise in the log.
const LOG_NOISE = /Failed to (fetch|download|unpack) (https:\/\/github\.com\/|ASN\/Geo data|application)/;

/** Last lines of the Stalwart log, without colors, without known noise, with secrets redacted. */
export function logTail(text, secrets, lines = 40) {
  const all = stripAnsi(text)
    .split('\n')
    .filter((line) => line && !LOG_NOISE.test(line));
  return redact(all.slice(-lines).join('\n'), secrets);
}

async function main(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'digest': {
      const digest = assetDigest(JSON.parse(readFileSync(stdin.fd, 'utf8')), rest[0]);
      if (!digest) return 1;
      console.log(digest);
      return 0;
    }
    case 'credentials': {
      const [file, url = env.STALWART_URL || DEFAULT_URL] = rest;
      const uris = (env.STALWART_REDIRECT_URIS ?? '').split(/\s+/).filter(Boolean);
      const cred = createCredentials({ url, redirectUris: uris.length ? uris : DEFAULT_REDIRECT_URIS });
      writePrivate(file, `${JSON.stringify(cred, null, 2)}\n`);
      writePrivate(join(dirname(file), 'stalwart.env'), serverEnv(cred));
      return 0;
    }
    case 'bootstrap':
    case 'configure':
    case 'accounts': {
      const [file, recoveryUrl, dataDir] = rest;
      const cred = readCredentials(file);
      try {
        const next =
          cmd === 'bootstrap'
            ? await bootstrap(cred, recoveryUrl, dataDir)
            : cmd === 'configure'
              ? await setup(cred, recoveryUrl)
              : await setupAccounts(cred);
        writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
      } catch (err) {
        console.error(`stalwart.mjs ${cmd}: ${redact(err.message, secretsOf(cred))}`);
        return 1;
      }
      return 0;
    }
    case 'check': {
      const file = rest[0] ?? env.STALWART_CREDENTIALS;
      if (!file) {
        console.error('stalwart.mjs check: no credentials (STALWART_CREDENTIALS)');
        return 2;
      }
      return (await runChecks(readCredentials(file))) ? 0 : 1;
    }
    case 'log': {
      const [file, logFile, lines = '40'] = rest;
      const secrets = file && existsSync(file) ? secretsOf(readCredentials(file)) : [];
      if (existsSync(logFile)) console.log(logTail(readFileSync(logFile, 'utf8'), secrets, Number(lines)));
      return 0;
    }
    default:
      console.error(
        'Usage: stalwart.mjs digest <asset> | credentials <file> [url] | bootstrap <file> <recovery-url> <data-dir> | ' +
          'configure <file> <recovery-url> | accounts <file> | check [file] | log <file> <log-file> [lines]',
      );
      return 2;
  }
}

if (import.meta.url === pathToFileURL(argv[1]).href) {
  exit(await main(argv.slice(2)));
}
