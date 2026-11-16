// Tests of the helpers for the local Stalwart (node --test scripts/): encodings,
// credentials, redaction and the evaluation of the checks on fixed responses;
// network only to a test server on 127.0.0.1.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECKS,
  DEFAULT_REDIRECT_URIS,
  assetDigest,
  base32Encode,
  basicAuth,
  clientBasicAuth,
  createCredentials,
  evalCors,
  evalError,
  evalMetadata,
  evalRateLimit,
  evalTokenResponse,
  formatResult,
  formEncode,
  logTail,
  pick,
  pkce,
  randomSecret,
  redact,
  request,
  secretsOf,
  serverEnv,
  setResult,
  summarize,
  totp,
  waitForRecoveryAdmin,
  writePrivate,
} from './stalwart.mjs';

const SCRIPT = fileURLToPath(new URL('./stalwart.mjs', import.meta.url));
const decodeBasic = (header) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8');
const mode = (file) => statSync(file).mode & 0o777;

describe('assetDigest', () => {
  const digest = 'a'.repeat(64);
  const release = {
    assets: [
      { name: 'stalwart-x86_64-unknown-linux-gnu.tar.gz', digest: `sha256:${digest}` },
      { name: 'without.tar.gz', digest: null },
      { name: 'broken.tar.gz', digest: 'sha256:xyz' },
    ],
  };

  test('returns the hex digest of the asset', () => {
    assert.equal(assetDigest(release, 'stalwart-x86_64-unknown-linux-gnu.tar.gz'), digest);
  });

  test('null without asset, without or with a wrong digest', () => {
    assert.equal(assetDigest(release, 'missing.tar.gz'), null);
    assert.equal(assetDigest(release, 'without.tar.gz'), null);
    assert.equal(assetDigest(release, 'broken.tar.gz'), null);
    assert.equal(assetDigest(null, 'x'), null);
  });
});

describe('encodings', () => {
  test('PKCE S256 per RFC 7636 appendix B', () => {
    const { challenge } = pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('PKCE without input: random verifier with 43 characters', () => {
    const a = pkce();
    const b = pkce();
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.verifier, b.verifier);
    assert.equal(pkce(a.verifier).challenge, a.challenge);
  });

  test('Basic unchanged for accounts, form-encoded for OAuth clients (RFC 6749 › 2.3.1)', () => {
    assert.equal(decodeBasic(basicAuth('user@example.test', 'a+b:c')), 'user@example.test:a+b:c');
    assert.equal(decodeBasic(clientBasicAuth('client id', 'a+b:c/d=ü')), 'client+id:a%2Bb%3Ac%2Fd%3D%C3%BC');
    assert.equal(formEncode('a b*-._~'), 'a+b*-._%7E');
  });

  test('Base32 per RFC 4648 (without padding)', () => {
    const vectors = {
      '': '',
      f: 'MY',
      fo: 'MZXQ',
      foo: 'MZXW6',
      foob: 'MZXW6YQ',
      fooba: 'MZXW6YTB',
      foobar: 'MZXW6YTBOI',
    };
    for (const [input, output] of Object.entries(vectors)) assert.equal(base32Encode(Buffer.from(input)), output);
  });

  test('TOTP per RFC 6238 appendix B', () => {
    const keys = {
      sha1: Buffer.from('12345678901234567890'),
      sha256: Buffer.from('12345678901234567890123456789012'),
      sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
    };
    const vectors = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [time, sha1, sha256, sha512] of vectors) {
      assert.equal(totp(keys.sha1, { time, digits: 8 }), sha1, `SHA-1 at ${time}`);
      assert.equal(totp(keys.sha256, { time, digits: 8, algorithm: 'sha256' }), sha256, `SHA-256 at ${time}`);
      assert.equal(totp(keys.sha512, { time, digits: 8, algorithm: 'sha512' }), sha512, `SHA-512 at ${time}`);
    }
    assert.equal(totp(keys.sha1, { time: 59 }), '287082'); // six digits: the last six of the eight
  });
});

describe('credentials', () => {
  test('random secrets, accounts in example.test, default redirects', () => {
    const a = createCredentials();
    const b = createCredentials();
    assert.equal(a.url, 'http://127.0.0.1:18080');
    assert.equal(a.user.email, 'user@example.test');
    assert.equal(a.admin.email, 'admin@example.test');
    assert.deepEqual(a.oauthClient.redirectUris, DEFAULT_REDIRECT_URIS);
    assert.equal(a.oauthClient.tokenEndpointAuthMethod, 'client_secret_basic');
    for (const s of [a.recoveryAdmin.password, a.user.password, a.oauthClient.clientSecret]) {
      assert.match(s, /^[A-Za-z0-9_-]{32,}$/);
    }
    assert.notEqual(a.user.password, b.user.password);
    assert.notEqual(a.oauthClient.clientSecret, b.oauthClient.clientSecret);
    assert.notEqual(randomSecret(), randomSecret());
  });

  test('secretsOf lists all set secrets', () => {
    const cred = createCredentials();
    cred.admin.password = 'admin-secret';
    cred.admin.appPassword = 'admin-app-secret';
    assert.deepEqual(
      new Set(secretsOf(cred)),
      new Set([
        cred.recoveryAdmin.password,
        'admin-secret',
        'admin-app-secret',
        cred.user.password,
        cred.oauthClient.clientSecret,
      ]),
    );
  });

  test('server environment with recovery admin and public URL', () => {
    const cred = createCredentials({ url: 'http://127.0.0.1:18090' });
    const text = serverEnv(cred);
    // {PLAIN}: otherwise Stalwart reads a secret starting with `_` as a BSDi crypt hash.
    assert.match(
      text,
      new RegExp(`^STALWART_RECOVERY_ADMIN='recovery:\\{PLAIN\\}${cred.recoveryAdmin.password}'$`, 'm'),
    );
    assert.match(text, /^STALWART_PUBLIC_URL='http:\/\/127\.0\.0\.1:18090'$/m);
    assert.match(text, /^STALWART_HOSTNAME='mail\.example\.test'$/m);
  });

  describe('files', () => {
    let dir;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'roedy-stalwart-'));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    test('writePrivate sets mode 600, also for an existing file', () => {
      const file = join(dir, 'old.json');
      writeFileSync(file, '{}', { mode: 0o644 });
      writePrivate(file, '{"new":true}');
      assert.equal(mode(file), 0o600);
      assert.equal(readFileSync(file, 'utf8'), '{"new":true}');
    });

    test('CLI credentials writes credentials.json and stalwart.env with mode 600, without output', () => {
      const file = join(dir, 'credentials.json');
      const res = spawnSync(process.execPath, [SCRIPT, 'credentials', file, 'http://127.0.0.1:18080'], {
        encoding: 'utf8',
        env: { ...process.env, STALWART_REDIRECT_URIS: 'http://127.0.0.1:9999/cb  http://127.0.0.1:9998/cb' },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
      assert.equal(mode(file), 0o600);
      assert.equal(mode(join(dir, 'stalwart.env')), 0o600);
      const cred = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(cred.oauthClient.redirectUris, ['http://127.0.0.1:9999/cb', 'http://127.0.0.1:9998/cb']);
      assert.ok(readFileSync(join(dir, 'stalwart.env'), 'utf8').includes(cred.recoveryAdmin.password));
    });
  });
});

describe('redaction', () => {
  const secret = 'Ab+c/d=ef:gh';

  test('replaces secrets raw, URL- and form-encoded', () => {
    const text = `raw ${secret}, url ${encodeURIComponent(secret)}, form ${formEncode(secret)}`;
    assert.equal(redact(text, [secret]), 'raw ***, url ***, form ***');
  });

  test('longer secrets first, short and empty values stay', () => {
    assert.equal(redact('token-123456789 token-1234', ['token-1234', 'token-123456789']), '*** ***');
    assert.equal(redact('abc admin', ['abc', '', null, undefined]), 'abc admin');
  });

  test('log tail: without colors and noise, redacted, last lines', () => {
    const log = [
      '\x1b[37m2026-11-03\x1b[0m \x1b[31;1mERROR\x1b[0m Failed to fetch https://github.com/x/webui.zip',
      'line 1',
      `line 2 with ${secret}`,
      'line 3 Failed to download ASN/Geo data',
      '\x1b[32;1mline 4\x1b[0m',
      '',
    ].join('\n');
    assert.equal(logTail(log, [secret], 2), 'line 2 with ***\nline 4');
    assert.equal(logTail(log, [], 10), `line 1\nline 2 with ${secret}\nline 4`);
  });
});

describe('JMAP responses', () => {
  test('pick returns the result or throws on an error', () => {
    const responses = [
      ['x:Domain/get', { list: [] }, 'd'],
      ['error', { type: 'unknownMethod' }, 'x'],
    ];
    assert.deepEqual(pick(responses, 'd'), { list: [] });
    assert.throws(() => pick(responses, 'x'), /x: unknownMethod/);
    assert.throws(() => pick(responses, 'y'), /no response for y/);
  });

  test('setResult: created, updated without content, rejected', () => {
    assert.deepEqual(setResult({ created: { c: { id: 'b' } } }, 'c'), { id: 'b' });
    assert.deepEqual(setResult({ updated: { singleton: null } }, 'singleton', 'updated'), {});
    assert.throws(
      () => setResult({ notCreated: { c: { type: 'invalidProperties', description: 'Redirect' } } }, 'c'),
      /not saved \(c\): invalidProperties Redirect$/,
    );
  });
});

describe('evaluation of the checks', () => {
  const base = 'http://127.0.0.1:18080';
  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/login`,
    token_endpoint: `${base}/auth/token`,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint: `${base}/auth/revoke`,
    introspection_endpoint: `${base}/auth/introspect`,
    end_session_endpoint: `${base}/auth/logout`,
    protected_resources: ['https://127.0.0.1:18080'],
    client_id_metadata_document_supported: true,
  };

  test('OAuth metadata of Stalwart v1', () => {
    const r = evalMetadata({ status: 200, json: metadata }, base);
    assert.equal(r.ok, true, r.actual);
    assert.match(r.actual, /issuer = base; authorization_endpoint \/login; PKCE S256/);
  });

  test('OAuth metadata: a missing endpoint or another issuer fail', () => {
    const without = { ...metadata, revocation_endpoint: undefined };
    assert.equal(evalMetadata({ status: 200, json: without }, base).ok, false);
    assert.equal(
      evalMetadata({ status: 200, json: { ...metadata, issuer: 'https://x.example.test' } }, base).ok,
      false,
    );
    assert.equal(evalMetadata({ status: 500, json: null }, base).ok, false);
  });

  test('CORS: *, Authorization in the preflight, no Expose-Headers', () => {
    const simple = { status: 200, headers: { 'access-control-allow-origin': '*' } };
    const preflight = {
      status: 204,
      headers: { 'access-control-allow-headers': 'Authorization, Content-Type, Accept, X-Requested-With' },
    };
    assert.equal(evalCors(simple, preflight).ok, true);
    const expose = { ...simple, headers: { ...simple.headers, 'access-control-expose-headers': 'Location' } };
    assert.equal(evalCors(expose, preflight).ok, false);
    assert.equal(
      evalCors(simple, { status: 204, headers: { 'access-control-allow-headers': 'X-Authorization' } }).ok,
      false,
    );
  });

  test('error responses: status and OAuth error code', () => {
    assert.deepEqual(evalError({ status: 400, json: { error: 'invalid_grant' } }, 400, 'invalid_grant'), {
      ok: true,
      actual: '400 invalid_grant',
    });
    assert.equal(evalError({ status: 400, json: { error: 'access_denied' } }, 400, 'invalid_grant').ok, false);
    assert.equal(
      evalError({ status: 401, json: { type: 'about:blank', title: 'Unauthorized' } }, 401).actual,
      '401 Unauthorized',
    );
  });

  test('summarize: OAuth error, type of /api/auth, title of a problem details object', () => {
    assert.equal(summarize({ status: 200, json: { type: 'consentRequired', token: 'secret' } }), '200 consentRequired');
    assert.equal(
      summarize({ status: 402, json: { type: 'about:blank', title: 'MFA code required' } }),
      '402 MFA code required',
    );
    assert.equal(summarize({ status: 204, json: null }), '204');
  });

  test('token response: expires_in 3600 and both tokens, without naming them', () => {
    const res = {
      status: 200,
      json: { access_token: 'a-secret', refresh_token: 'r-secret', token_type: 'bearer', expires_in: 3600 },
    };
    const r = evalTokenResponse(res);
    assert.equal(r.ok, true, r.actual);
    assert.doesNotMatch(r.actual, /secret/);
    assert.equal(evalTokenResponse({ status: 200, json: { ...res.json, expires_in: 7200 } }).ok, false);
  });

  test('rate limit: 100 × 200, then 429 with Retry-After, 127.0.0.1 exempt', () => {
    const statuses = [...Array(100).fill(200), 429];
    const last = { status: 429, headers: { 'retry-after': '42' } };
    assert.equal(evalRateLimit(statuses, last, { status: 200 }).ok, true);
    assert.equal(evalRateLimit(statuses, { status: 429, headers: {} }, { status: 200 }).ok, false);
    assert.equal(evalRateLimit([...Array(99).fill(200), 429, 429], last, { status: 200 }).ok, false);
    assert.equal(evalRateLimit(statuses, last, { status: 429 }).ok, false);
  });

  test('result lines with ✓/✗', () => {
    assert.equal(
      formatResult({ name: 'Test', expected: '200', actual: '200', ok: true }),
      '✓ Test\n    expected: 200\n    actual: 200',
    );
    assert.match(formatResult({ name: 'Test', expected: '200', actual: '500', ok: false }), /^✗ Test/);
  });
});

describe('checks against a test server', () => {
  let server;
  let base;
  const seen = [];
  // Session with authentication: first the statuses from `sessionReplies`, then `sessionAfter`; 200 names `recovery`.
  let sessionReplies = [];
  let sessionAfter = 200;
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.socket.remoteAddress);
      if (req.url === '/.well-known/jmap') {
        res.writeHead(307, { location: '/jmap/session' }).end();
      } else if (req.url === '/jmap/session' && req.headers.authorization) {
        const status = sessionReplies.shift() ?? sessionAfter;
        const body = status === 200 ? { username: 'recovery', accounts: {}, capabilities: {} } : {};
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      } else if (req.url === '/jmap/session') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"accounts":{},"capabilities":{}}');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const check = (name) => CHECKS.find((c) => c.name === name);

  test('JMAP discovery and session without authentication', async () => {
    assert.deepEqual(await check('JMAP discovery').run({ base }), { ok: true, actual: '307; Location /jmap/session' });
    assert.deepEqual(await check('Session without authentication').run({ base }), {
      ok: true,
      actual: '200; accounts {}',
    });
  });

  test('waitForRecoveryAdmin waits until the session names the recovery admin', async () => {
    const logged = [];
    const opts = { delay: 1, log: (line) => logged.push(line) };
    const admin = { login: 'recovery', password: 'secret' };
    try {
      assert.equal(await waitForRecoveryAdmin(base, admin, opts), basicAuth('recovery', 'secret'));
      assert.deepEqual(logged, [], 'no message without waiting');
      sessionReplies = [401, 401];
      await waitForRecoveryAdmin(base, admin, opts);
      assert.match(logged[0], /^stalwart.mjs: recovery admin accepted after \d+\.\d s$/);
      // 200 for another account (or anonymous) is not the state we are looking for.
      await assert.rejects(waitForRecoveryAdmin(base, { ...admin, login: 'other' }, opts), /username "recovery"/);
      // Permanently 401 (like a secret Stalwart reads as a hash): abort at the limit.
      sessionAfter = 401;
      await assert.rejects(waitForRecoveryAdmin(base, admin, { ...opts, timeout: 20 }), {
        status: 401,
        message: /not accepted after 0\.02 s/,
      });
      // Response other than 401: abort immediately.
      sessionAfter = 503;
      await assert.rejects(waitForRecoveryAdmin(base, admin, { ...opts, timeout: 60000 }), { status: 503 });
    } finally {
      sessionReplies = [];
      sessionAfter = 200;
    }
  });

  // 127.0.0.2 only exists out of the box on Linux (all of 127.0.0.0/8 on lo); macOS only knows 127.0.0.1.
  const skip = process.platform !== 'linux' && '127.0.0.2 only on Linux';
  test('request follows no redirect and chooses the source address', { skip }, async () => {
    const res = await request(`${base}/.well-known/jmap`, { localAddress: '127.0.0.2' });
    assert.equal(res.status, 307);
    assert.equal(seen.at(-1), '127.0.0.2');
    const json = await request(`${base}/jmap/session`);
    assert.deepEqual(json.json, { accounts: {}, capabilities: {} });
    assert.equal(seen.at(-1), '127.0.0.1');
  });
});
