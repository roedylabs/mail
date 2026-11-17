import { afterEach, describe, expect, it, vi } from 'vitest';
import { csp } from '#lib/csp.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { domainsOf } from '#lib/url.ts';
import { DONE_MS, SetupFlow, formatToken, redirectOf, type Field, type Step } from './setup.svelte.ts';

const TOKEN = 'ABCD-EFGH-JKLM';
const OK = { url: 'https://mail.example.com', host: 'mail.example.com', reach: 'ok', cors: 'ok', oauth: 'ok' };
const PROBE_IP = { ...OK, url: 'https://203.0.113.5', host: '203.0.113.5' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  csp.stale = false;
});

function hooks() {
  return {
    fail: vi.fn<(field?: Field) => void>(),
    entered: vi.fn<(step: Step, field?: Field) => void>(),
    error: vi.fn<(text: string) => void>(),
    reload: vi.fn(() => Promise.resolve()),
  };
}

/** Flow up to the start of step `step` (without API, fields as after the steps). */
function at(step: 2 | 3 | 4 | 5 | 6, h = hooks()) {
  const flow = new SetupFlow(h);
  flow.token = TOKEN;
  flow.name = 'Anna Baker';
  flow.email = 'anna@example.com';
  flow.pw = 'Safe-enough1';
  flow.pw2 = 'Safe-enough1';
  flow.pub = 'https://webmail.example.com';
  if (step >= 5) {
    flow.srv = 'https://mail.example.com';
    flow.srvOk = 'https://mail.example.com';
    flow.srvSt = 'ok';
    flow.oaSt = 'ok';
    flow.oaCid = 'roedy-abc';
    flow.sysUser = 'noreply@example.com';
  }
  flow.step = step;
  return { flow, h };
}

describe('Helpers', () => {
  it('formats the token input', () => {
    expect(formatToken('abcd')).toBe('ABCD');
    expect(formatToken('abcdefghjklmn')).toBe('ABCD-EFGH-JKLM');
    expect(formatToken('[setup] Setup-Token: abcd-efgh-jklm (valid until …)')).toBe('ABCD-EFGH-JKLM');
    expect(formatToken('ab cd–ef')).toBe('ABCD-EF');
  });

  it('reads domains and builds the redirect URI from the public address', () => {
    expect(domainsOf(' @Example.com, company.de;new.de  ')).toEqual(['example.com', 'company.de', 'new.de']);
    expect(redirectOf('webmail.example.com/')).toBe('https://webmail.example.com/oauth/callback');
    expect(redirectOf('http://localhost:5173')).toBe('http://localhost:5173/oauth/callback');
    expect(redirectOf('')).toBe('https://webmail.example.com/oauth/callback');
  });
});

describe('Step 1: setup token', () => {
  it('requires twelve characters before asking', async () => {
    const h = hooks();
    const { calls } = mockApi({});
    const flow = new SetupFlow(h);
    flow.editToken('abcd-ef');
    await flow.submitToken();
    expect(flow.tokErr).toBe('short');
    expect(h.fail).toHaveBeenCalledWith('token');
    expect(calls).toHaveLength(0);
  });

  it('reports a wrong token with the remaining attempts', async () => {
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 422, body: { error: 'invalid_token', remaining: 3 } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(flow.tokErr).toBe('invalid');
    expect(flow.tokErrText).toBe('Check the token in the container log. 3 attempts left.');
    expect(flow.phase).toBe('error');
    flow.remaining = 1;
    expect(flow.tokErrText).toBe('Check the token in the container log. 1 attempt left.');
    // Typing clears the error.
    flow.editToken('ABCD');
    expect(flow.tokErr).toBeNull();
  });

  it('locks after 429 with a running wait time and releases afterwards', async () => {
    vi.useFakeTimers();
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(flow.locked).toBe(true);
    expect(flow.token).toBe('');
    expect(flow.phase).toBe('locked');
    expect(flow.tokErrText).toBe('Entry is locked for 30 seconds.');
    vi.advanceTimersByTime(29_000);
    expect(flow.tokErrText).toBe('Entry is locked for 1 second.');
    // While locked the page does not ask.
    flow.token = TOKEN;
    await flow.submitToken();
    vi.advanceTimersByTime(1_000);
    expect(flow.locked).toBe(false);
    expect(flow.tokErr).toBeNull();
    expect(h.entered).toHaveBeenCalledWith(1, 'token');
    flow.dispose();
  });

  it('continues with the right token and takes over a preset public address', async () => {
    const h = hooks();
    const { calls } = mockApi({
      'POST setup/token': [{ body: { public_url: 'https://mail-app.example.com' } }, { body: { public_url: null } }],
    });
    const flow = new SetupFlow(h);
    flow.editToken('abcdefghjklm');
    await flow.submitToken();
    expect(calls[0]?.body).toEqual({ token: TOKEN });
    expect(flow.step).toBe(2);
    expect(h.entered).toHaveBeenCalledWith(2, 'name');
    expect(flow.pub).toBe('https://mail-app.example.com');
    expect(flow.pubLocked).toBe(true);

    const other = new SetupFlow(h);
    other.editToken(TOKEN);
    await other.submitToken();
    expect(other.pubLocked).toBe(false);
    expect(other.pub).toBe(location.origin);
  });

  it('reloads if the setup is already complete', async () => {
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 409, body: { error: 'setup_done' } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(h.reload).toHaveBeenCalled();
  });
});

describe('Steps 2 and 3', () => {
  it('checks name and email', () => {
    const { flow, h } = at(2);
    flow.name = ' ';
    flow.email = '';
    flow.submitAdmin();
    expect(flow.err).toEqual({
      name: 'Please enter your name.',
      email: 'Please enter your email address.',
    });
    expect(h.fail).toHaveBeenCalledWith('name');
    flow.edit('name', 'Anna');
    expect(flow.err.name).toBeUndefined();
    flow.email = 'anna@example';
    flow.submitAdmin();
    expect(flow.err.email).toBe('Please check the email address.');
    flow.email = 'anna@example.com';
    flow.submitAdmin();
    expect(flow.step).toBe(3);
  });

  it('checks policy, length and repetition of the password', () => {
    const { flow, h } = at(3);
    flow.pw = 'tooshort';
    flow.submitPw();
    expect(flow.err.pw).toBe(true);
    expect(h.fail).toHaveBeenCalledWith('pw');
    flow.pw = `A1${'a'.repeat(1023)}`;
    flow.submitPw();
    expect(flow.err.pw).toBe('The password is too long.');
    flow.edit('pw', 'Safe-enough1');
    flow.pw2 = '';
    flow.submitPw();
    expect(flow.err.pw2).toBe('Please confirm the password.');
    flow.pw2 = 'Safe-enough2';
    flow.submitPw();
    expect(flow.err.pw2).toBe('The passwords don’t match.');
    flow.pw2 = 'Safe-enough1';
    flow.submitPw();
    expect(flow.step).toBe(4);
    expect(h.entered).toHaveBeenLastCalledWith(4, 'srv');
  });
});

describe('Step 4: mail server', () => {
  it('checks addresses, domains and requires a client', async () => {
    const { flow, h } = at(4);
    const { calls } = mockApi({});
    flow.srv = 'http://stalwart:8080';
    flow.pub = '';
    flow.srvDoms = 'example.com, broken';
    await flow.submitServer();
    expect(flow.err).toEqual({
      srv: 'Use an HTTPS URL. http:// only works for localhost.',
      pub: 'Please enter the URL where the app is reachable.',
      srvDoms: '“broken” isn’t a valid domain.',
      oa: 'Register the OAuth client first.',
    });
    expect(flow.oaErrText).toBe('Register the OAuth client first.');
    expect(h.fail).toHaveBeenCalledWith('srv');
    flow.setOaMode('manual');
    flow.srv = '';
    flow.pub = 'https://webmail.example.com';
    flow.srvDoms = '';
    await flow.submitServer();
    expect(flow.err).toEqual({
      srv: 'Please enter the URL of your Stalwart server.',
      oaCid: 'Please enter the client ID.',
    });
    expect(calls).toHaveLength(0);
  });

  it('checks the manual client ID and secret like the backend before testing', async () => {
    const { flow, h } = at(4);
    const { calls } = mockApi({ 'POST setup/servers/test': [{ body: OK }] });
    flow.srv = 'https://mail.example.com';
    flow.setOaMode('manual');
    flow.oaCid = 'roedy\u0001abc';
    flow.oaSec = 'x'.repeat(1025);
    await flow.submitServer();
    expect(flow.err).toEqual({
      oaCid: 'The client ID contains invalid characters or is too long.',
      oaSec: 'The secret contains invalid characters or is too long.',
    });
    expect(h.fail).toHaveBeenLastCalledWith(undefined);
    // The secret is checked as it is sent: a trailing line break counts.
    flow.edit('oaCid', ' roedy-abc ');
    flow.edit('oaSec', 'secret\n');
    await flow.submitServer();
    expect(flow.err).toEqual({ oaSec: 'The secret contains invalid characters or is too long.' });
    expect(calls).toHaveLength(0);
    flow.edit('oaSec', 'secret');
    await flow.submitServer();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ client_id: 'roedy-abc', has_secret: true });
  });

  it('registers the client automatically with the token in the header', async () => {
    const { flow, h } = at(4);
    const { calls } = mockApi({
      'POST setup/servers/register-client': [{ body: { client_id: 'roedy-x1', redirect_uri: 'unused' } }],
    });
    flow.srv = 'mail.example.com';
    flow.oaUser = ' admin ';
    flow.oaPw = 'secret';
    await flow.registerClient();
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(calls[0]?.body).toEqual({
      url: 'https://mail.example.com',
      username: 'admin',
      password: 'secret',
      public_url: 'https://webmail.example.com',
    });
    expect(flow.oaSt).toBe('ok');
    expect([flow.oaCid, flow.oaRegCid]).toEqual(['roedy-x1', 'roedy-x1']);
    expect([flow.oaUser, flow.oaPw]).toEqual(['', '']);
    // A new public address no longer matches the client's redirect URI
    // (`redirect_mismatch`): "Test connection" leads back to the sign-in.
    flow.edit('pub', 'https://other.example.com');
    expect(flow.oaSt).toBe('ok');
    await flow.submitServer();
    expect([flow.oaSt, flow.oaCid, flow.oaRegCid]).toEqual([null, '', '']);
    expect(flow.oaErrText).toBe(
      'The public URL of Roedy Mail has changed since registration. Register the client again.',
    );
    expect(h.fail).toHaveBeenLastCalledWith(undefined);
    expect(calls).toHaveLength(1);
  });

  it('names the registration at the secret and reports a changed public address at the client ID field', async () => {
    const { flow, h } = at(4);
    const { calls } = mockApi({
      'POST setup/servers/register-client': [{ body: { client_id: 'roedy-x1' } }],
      'POST setup/servers/test': [{ body: OK }],
    });
    flow.srv = 'https://mail.example.com';
    flow.oaUser = 'admin';
    flow.oaPw = 'app-pw';
    expect(flow.oaSecHint).toBe(
      'Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only.',
    );
    await flow.registerClient();
    // "Manual" with the client ID of the registration: its secret lives in the backend.
    flow.setOaMode('manual');
    expect(flow.oaCid).toBe('roedy-x1');
    expect(flow.oaSecHint).toBe(
      'The secret from the automatic registration is stored in the backend and applied when you save. Leave empty to use it.',
    );
    flow.edit('oaCid', 'other-client');
    expect(flow.oaSecHint).toBe(
      'Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only.',
    );
    // Another server has no registration with this client ID.
    flow.edit('oaCid', 'roedy-x1');
    flow.edit('srv', 'https://mail.other.example.com');
    expect(flow.oaSecHint).toMatch(/^Only needed/);
    flow.edit('srv', 'https://mail.example.com');
    expect(flow.oaSecHint).toMatch(/^The secret from the automatic registration/);
    // Public address changed afterwards: error at the client ID field with the client's redirect URI.
    flow.edit('pub', 'https://new.example.com');
    await flow.submitServer();
    expect(flow.err).toEqual({
      oaCid:
        'This client was registered for the redirect URI https://webmail.example.com/oauth/callback, which no longer matches the public URL. Register the client again or enter a different client.',
    });
    expect(h.fail).toHaveBeenLastCalledWith('oaCid');
    expect(calls).toHaveLength(1);
    // The address of the registration again: the test runs.
    flow.edit('pub', 'https://webmail.example.com/');
    await flow.submitServer();
    expect(flow.srvGood).toBe(true);
    expect(calls.map((c) => c.body)).toContainEqual(expect.objectContaining({ client_id: 'roedy-x1' }));
    // "Redo" discards the registration including the notice.
    flow.setOaMode('auto');
    flow.resetClient();
    expect(flow.oaRegCid).toBe('');
    expect(flow.oaSecHint).toBe(
      'Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only.',
    );
  });

  it('reports a rejected sign-in, lock and other registration errors', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(4);
    const { calls } = mockApi({
      'POST setup/servers/register-client': [
        { status: 422, body: { error: 'registration_failed', reason: 'auth_failed' } },
        { status: 502, body: { error: 'registration_failed', reason: 'unsupported' } },
        { status: 502, body: { error: 'registration_failed', reason: 'unreachable' } },
        { status: 502, body: { error: 'registration_failed', reason: 'throttled' } },
        { status: 502, body: { error: 'registration_failed', reason: 'bad_response' } },
        { status: 422, body: { error: 'registration_failed', reason: 'mfa_required' } },
        { status: 422, body: { error: 'registration_failed', reason: 'forbidden' } },
        { status: 502, body: { error: 'registration_failed', reason: 'unsupported_version' } },
        { status: 502, body: { error: 'registration_failed', reason: 'rejected', detail: 'invalid_redirect_uri' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 90 } },
      ],
    });
    flow.srv = 'https://mail.example.com';
    flow.oaUser = 'admin';
    flow.oaPw = 'wrong';
    await flow.registerClient();
    expect(flow.oaErrText).toBe('Administrator sign-in failed. Check the username and app password.');
    expect(flow.oaPw).toBe('');
    expect(h.fail).toHaveBeenCalled();
    flow.edit('oaPw', 'new');
    expect(flow.oaErrText).toBe('');
    await flow.registerClient();
    expect([flow.oaErr, flow.oaReason]).toEqual(['reg', 'unsupported']);
    expect(flow.oaErrText).toBe(
      'This mail server doesn’t allow automatic registration. Choose “Manual” and create the client in the Stalwart web admin.',
    );
    expect(flow.oaPw).toBe('new');
    await flow.registerClient();
    expect(flow.oaErrText).toBe('The mail server can’t be reached. Check the server URL.');
    // Throttled without a wait time: text instead of a box.
    await flow.registerClient();
    expect([flow.oaThr, flow.oaErrText]).toEqual([
      false,
      'The mail server isn’t accepting requests right now. Try again in a few minutes.',
    ]);
    await flow.registerClient();
    expect(flow.oaErrText).toBe(
      'The mail server rejected the registration. Choose “Manual” and create the client in the Stalwart web admin.',
    );
    // Stalwart v1: password with a second factor clears the app password,
    // a missing permission keeps the fields; a server without v1 and a rejection with detail.
    flow.edit('oaPw', 'password');
    await flow.registerClient();
    expect([flow.oaErrText, flow.oaPw]).toEqual([
      'This account requires a second factor. Sign in with an app password instead of your password.',
      '',
    ]);
    flow.edit('oaPw', 'app-password');
    await flow.registerClient();
    expect([flow.oaErrText, flow.oaUser, flow.oaPw]).toEqual([
      'This account isn’t allowed to create OAuth clients. Sign in with an administrator account or grant the account the “SysOAuthClientCreate” permission in Stalwart.',
      'admin',
      'app-password',
    ]);
    await flow.registerClient();
    expect(flow.oaErrText).toBe(
      'This server isn’t Stalwart v1. Roedy Mail supports Stalwart 1.0 and later. Update Stalwart and try again.',
    );
    await flow.registerClient();
    expect([flow.oaReason, flow.oaDetail]).toEqual(['rejected', 'invalid_redirect_uri']);
    expect(flow.oaErrText).toBe(
      'The mail server rejected the registration (invalid_redirect_uri). Choose “Manual” and create the client in the Stalwart web admin.',
    );
    // 429: own box with a running wait time instead of text below the button.
    await flow.registerClient();
    expect(flow.oaLocked).toBe(true);
    expect(flow.oaLockText).toBe('Try again in 2 minutes.');
    expect([flow.oaErrText, flow.oaThr]).toEqual(['', false]);
    await flow.registerClient();
    expect(calls).toHaveLength(10);
    vi.advanceTimersByTime(60_000);
    expect(flow.oaLockText).toBe('Try again in 30 seconds.');
    vi.advanceTimersByTime(30_000);
    expect([flow.oaLocked, flow.oaErr, flow.oaSt]).toEqual([false, null, null]);
    flow.dispose();
  });

  it('shows "Too many requests." with a wait time on a throttled registration and keeps the fields', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(4);
    const { calls } = mockApi({
      'POST setup/servers/register-client': [
        { status: 502, body: { error: 'registration_failed', reason: 'throttled', retry_after: 90 } },
        { body: { client_id: 'roedy-x1' } },
      ],
    });
    flow.srv = 'https://mail.example.com';
    flow.oaUser = 'admin';
    flow.oaPw = 'app-pw';
    await flow.registerClient();
    expect([flow.oaThr, flow.oaLocked, flow.oaErrText, flow.oaLeft]).toEqual([true, false, '', 90]);
    expect(flow.oaThrText).toBe('The mail server is throttling requests from Roedy Mail. Try again in 2 minutes.');
    expect([flow.oaUser, flow.oaPw]).toEqual(['admin', 'app-pw']);
    expect(h.fail).toHaveBeenCalled();
    // Inputs leave the box in place; until expiry the button does not ask.
    flow.edit('oaPw', 'app-pw2');
    expect(flow.oaThr).toBe(true);
    await flow.registerClient();
    expect(calls).toHaveLength(1);
    // The throttling applies only to this server.
    flow.edit('srv', 'https://mail.other.example.com');
    expect([flow.oaThr, flow.oaWait]).toEqual([false, 0]);
    flow.edit('srv', 'https://mail.example.com');
    expect([flow.oaThr, flow.oaWait]).toEqual([true, 90]);
    vi.advanceTimersByTime(60_000);
    expect(flow.oaThrText).toBe('The mail server is throttling requests from Roedy Mail. Try again in 30 seconds.');
    vi.advanceTimersByTime(30_000);
    expect([flow.oaThr, flow.oaErr, flow.oaSt]).toEqual([false, null, null]);
    await flow.registerClient();
    expect([flow.oaSt, flow.oaCid]).toEqual(['ok', 'roedy-x1']);
    flow.dispose();
  });

  it('tests, suggests sender and domain and continues the second time', async () => {
    const { flow, h } = at(4);
    const { calls } = mockApi({ 'POST setup/servers/test': [{ body: OK }] });
    flow.oaSt = 'ok';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'mail.example.com/';
    await flow.submitServer();
    expect(calls[0]?.body).toEqual({
      url: 'https://mail.example.com',
      public_url: 'https://webmail.example.com',
      client_id: 'roedy-x1',
    });
    expect(flow.srvGood).toBe(true);
    expect(flow.srvPlain).toBe(false);
    expect(flow.sysUser).toBe('noreply@example.com');
    expect(flow.srvDoms).toBe('example.com');
    expect(flow.diag.map((r) => [r.label, r.sub, r.status])).toEqual([
      ['JMAP session', 'mail.example.com/.well-known/jmap', 'ok'],
      ['CORS headers', 'Requests from webmail.example.com allowed', 'ok'],
      ['OAuth client', 'Client ID roedy-x1', 'ok'],
    ]);
    await flow.submitServer();
    expect(flow.step).toBe(5);
    expect(h.entered).toHaveBeenLastCalledWith(5, undefined);
    // Another address must be tested again.
    flow.edit('srv', 'https://mail2.example.com');
    expect(flow.srvGood).toBe(false);
  });

  it('names an entered secret when testing (confidential client)', async () => {
    const { flow } = at(4);
    const { calls } = mockApi({ 'POST setup/servers/test': [{ body: OK }] });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.oaSec = 'secret';
    flow.srv = 'mail.example.com';
    await flow.submitServer();
    expect(calls[0]?.body).toEqual({
      url: 'https://mail.example.com',
      public_url: 'https://webmail.example.com',
      client_id: 'roedy-x1',
      has_secret: true,
    });
  });

  it('marks http://localhost and shows notices for CORS', async () => {
    const { flow } = at(4);
    mockApi({
      'POST setup/servers/test': [
        { body: { ...OK, url: 'http://localhost:8080', host: 'localhost:8080' } },
        { body: { ...OK, cors: 'err', oauth: 'unk' } },
        { body: { ...OK, reach: 'err', cors: 'unk', oauth: 'unk' } },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'http://localhost:8080';
    await flow.submitServer();
    expect(flow.srvPlain).toBe(true);
    expect(flow.sysUser).toBe('noreply@example.com');

    flow.edit('srv', 'https://mail.example.com');
    await flow.submitServer();
    expect(flow.srvSt).toBe('warn');
    expect(flow.srvGood).toBe(false);
    expect(flow.phase).toBe('error');
    expect(flow.srvWarn).toBe(true);
    expect(flow.diag.map((r) => [r.status, r.text])).toEqual([
      ['ok', 'Session found. JMAP Core and Mail are available.'],
      ['err', expect.stringContaining('“Permissive CORS”') as string],
      ['unk', 'Not checked yet.'],
    ]);

    flow.srvSt = null;
    await flow.submitServer();
    expect(flow.srvSt).toBe('err');
    expect(flow.srvOk).toBe('');
    // Without a reason: the general text; unchecked rows because the server is not reachable.
    expect(flow.srvBadText).toBe(
      'No JMAP server responds at this URL. Check the base URL, port, and firewall. The path /.well-known/jmap must be reachable from outside.',
    );
    expect(flow.diag.map((r) => r.text).slice(1)).toEqual([
      'Not checked because the server isn’t reachable.',
      'Not checked because the server isn’t reachable.',
    ]);
  });

  it('continues to step 5 with "Continue anyway" after a test with notices and marks the server', async () => {
    const { flow, h } = at(4);
    mockApi({
      'POST setup/servers/test': [
        {
          body: {
            ...OK,
            cors: 'err',
            oauth: 'err',
            reasons: { cors: 'preflight_status', oauth: 'pkce' },
          },
        },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'https://mail.example.com';
    flow.pub = 'webmail.example.com/';
    // Without a test with notices "Continue anyway" does nothing.
    flow.goOn();
    expect(flow.step).toBe(4);
    await flow.submitServer();
    expect([flow.srvSt, flow.srvWarn, flow.srvGood]).toEqual(['warn', true, false]);
    expect(h.fail).toHaveBeenCalled();
    expect(flow.diag.map((r) => r.text)).toEqual([
      'Session found. JMAP Core and Mail are available.',
      'The browser’s preflight request (OPTIONS) is rejected. Check the reverse proxy in front of Stalwart.',
      'The server doesn’t support sign-in for browser apps (refresh tokens, PKCE with S256, or clients without a secret). Check the OAuth settings in Stalwart.',
    ]);
    // "Continue anyway" checks the fields like "Continue": more than 100 domains stay in step 4.
    flow.srvDoms = Array.from({ length: 101 }, (_, i) => `d${String(i)}.de`).join(', ');
    flow.goOn();
    expect(flow.step).toBe(4);
    expect(flow.err.srvDoms).toBe('Up to 100 domains per server.');
    flow.srvDoms = '';
    flow.goOn();
    expect(flow.step).toBe(5);
    expect(flow.pub).toBe('https://webmail.example.com');
    expect(h.entered).toHaveBeenLastCalledWith(5, undefined);
    flow.skipSystem();
    expect(flow.review.find((r) => r.step === 4 && r.label === 'Stalwart server')).toMatchObject({
      value: 'mail.example.com',
      warn: true,
    });
    // Another address no longer counts as checked.
    flow.edit('srv', 'https://mail2.example.com');
    expect(flow.srvWarn).toBe(false);
  });

  it('names the reason if the server is not reachable', async () => {
    const { flow } = at(4);
    mockApi({
      'POST setup/servers/test': [
        { body: { ...OK, reach: 'err', cors: 'unk', oauth: 'unk', reasons: { reach: 'no_mail' } } },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'https://mail.example.com';
    // Before the first test the general text.
    expect(flow.srvBadText).toBe(
      'No JMAP server responds at this URL. Check the base URL, port, and firewall. The path /.well-known/jmap must be reachable from outside.',
    );
    await flow.submitServer();
    expect(flow.srvSt).toBe('err');
    expect(flow.srvBadText).toBe('The server responds but doesn’t offer JMAP for email.');
    expect(flow.phase).toBe('error');
  });

  it('shows "Too many requests." on a throttled JMAP session and locks "Test connection"', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(4);
    const throttled = { reach: 'throttled', cors: 'throttled', oauth: 'throttled' };
    const { calls } = mockApi({
      'POST setup/servers/test': [
        { body: { ...OK, reach: 'unk', cors: 'unk', oauth: 'unk', reasons: throttled, retry_after: 90 } },
        { body: OK },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'https://mail.example.com';
    await flow.submitServer();
    expect([flow.srvSt, flow.srvThr, flow.srvDis, flow.srvWarn, flow.srvGood]).toEqual([
      'thr',
      true,
      true,
      false,
      false,
    ]);
    expect(flow.srvLeft).toBe(90);
    expect(flow.srvThrText).toBe('The mail server is throttling requests from Roedy Mail. Test again in 2 minutes.');
    expect(flow.phase).toBe('server');
    expect(h.fail).toHaveBeenCalled();
    // Until expiry "Test connection" does not test.
    await flow.submitServer();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(flow.srvThrText).toBe('The mail server is throttling requests from Roedy Mail. Test again in 30 seconds.');
    vi.advanceTimersByTime(30_000);
    expect([flow.srvSt, flow.srvThr, flow.srvDis]).toEqual([null, false, false]);
    await flow.submitServer();
    expect(flow.srvGood).toBe(true);
    flow.dispose();
  });

  it('names the wait time in the rows if only a later check was throttled', async () => {
    vi.useFakeTimers();
    const { flow } = at(4);
    const later =
      'Not checked because the mail server is throttling requests from Roedy Mail. Test again in a few minutes.';
    mockApi({
      'POST setup/servers/test': [
        {
          body: {
            ...OK,
            cors: 'unk',
            oauth: 'unk',
            reasons: { cors: 'throttled', oauth: 'throttled' },
            retry_after: 90,
          },
        },
        { body: { ...OK, cors: 'unk', reasons: { cors: 'throttled' } } },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-x1';
    flow.srv = 'https://mail.example.com';
    await flow.submitServer();
    // With notices instead of the box; "Test again" stays enabled.
    expect([flow.srvSt, flow.srvWarn, flow.srvThr, flow.srvDis]).toEqual(['warn', true, false, false]);
    expect(flow.diag.slice(1).map((r) => r.text)).toEqual([
      'Not checked because the mail server is throttling requests from Roedy Mail. Test again in 2 minutes.',
      'Not checked because the mail server is throttling requests from Roedy Mail. Test again in 2 minutes.',
    ]);
    vi.advanceTimersByTime(90_000);
    expect(flow.diag[1]?.text).toBe(later);
    // Without a wait time "in a few minutes".
    await flow.submitServer();
    expect(flow.diag[1]?.text).toBe(later);
    flow.dispose();
  });

  it('requires HTTPS for the public address and suggests no IP address as domain', async () => {
    // The admin address from step 2 has the domain example.com.
    const { flow } = at(4);
    mockApi({ 'POST setup/servers/test': [{ body: { ...PROBE_IP } }] });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy';
    flow.srv = 'https://203.0.113.5';
    flow.pub = 'http://192.168.1.10:8080';
    await flow.submitServer();
    expect(flow.err.pub).toBe('Use an HTTPS URL. http:// only works for localhost.');
    flow.edit('pub', 'http://[::1]:8080');
    await flow.submitServer();
    expect(flow.err.pub).toBeUndefined();
    // Like without a dot in the host: the domain of the admin address instead of the IP address.
    expect(flow.srvDoms).toBe('example.com');
    expect(flow.sysUser).toBe('noreply@example.com');
    // Preset (`ROEDY_PUBLIC_URL`): no check in the field.
    flow.pubLocked = true;
    flow.pub = 'http://internal:8080';
    flow.srvSt = null;
    await flow.submitServer();
    expect(flow.err.pub).toBeUndefined();
  });

  it('discards registration and test if the server or public address changes', async () => {
    const { flow } = at(4);
    let answer: (a: { body: unknown }) => void = () => {};
    mockApi({
      'POST setup/servers/register-client': [
        () => new Promise((resolve) => (answer = resolve)),
        { body: { client_id: 'roedy-2' } },
      ],
      'POST setup/servers/test': [() => new Promise((resolve) => (answer = resolve))],
    });
    flow.srv = 'https://mail.example.com';
    flow.oaUser = 'admin';
    flow.oaPw = 'secret';
    // Changed during the registration: result discarded.
    const pending = flow.registerClient();
    await vi.waitFor(() => expect(flow.oaSt).toBe('busy'));
    flow.edit('pub', 'https://new.example.com');
    expect(flow.oaSt).toBeNull();
    answer({ body: { client_id: 'roedy-old' } });
    await pending;
    expect(flow.oaSt).toBeNull();
    expect(flow.oaCid).toBe('');
    // After the registration: another server address discards the client, the same one does not.
    flow.oaUser = 'admin';
    flow.oaPw = 'secret';
    await flow.registerClient();
    expect(flow.oaCid).toBe('roedy-2');
    flow.edit('srv', 'https://mail.example.com/');
    expect(flow.oaCid).toBe('roedy-2');
    flow.edit('srv', 'https://mail2.example.com');
    expect(flow.oaSt).toBeNull();
    // A running test no longer applies after a change.
    flow.setOaMode('manual');
    flow.oaCid = 'roedy';
    const test = flow.submitServer();
    await vi.waitFor(() => expect(flow.srvSt).toBe('busy'));
    flow.edit('srv', 'https://mail3.example.com');
    answer({ body: OK });
    await test;
    expect(flow.srvSt).toBeNull();
    expect(flow.srvGood).toBe(false);
  });

  it('shows API field errors and returns to step 1 on a rejected token', async () => {
    const { flow, h } = at(4);
    mockApi({
      'POST setup/servers/test': [
        {
          status: 422,
          body: { error: 'invalid', fields: { url: { code: 'invalid' }, public_url: { code: 'invalid' } } },
        },
        { status: 422, body: { error: 'invalid_token', remaining: 4 } },
      ],
    });
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy';
    flow.srv = 'https://mail.example.com';
    await flow.submitServer();
    expect(flow.err).toEqual({ srv: 'Please check the URL.', pub: 'Please check the URL.' });
    expect(h.fail).toHaveBeenLastCalledWith('srv');
    await flow.submitServer();
    expect(flow.step).toBe(1);
    expect(flow.tokErr).toBe('invalid');
    expect(flow.remaining).toBe(4);
  });
});

describe('Step 5: system emails', () => {
  it('checks the sender account and reports success, wrong credentials and lock', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(5);
    const { calls } = mockApi({
      'POST setup/system-mail/test': [
        { status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } },
        { status: 429, body: { error: 'mail_failed', reason: 'auth_locked', retry_after: 45 } },
        { body: { identities: [] } },
      ],
    });
    flow.sysUser = 'noreply';
    await flow.submitSystem();
    expect(flow.err).toEqual({
      sysUser: 'Please check the URL.',
      sysPw: 'Please enter the app password.',
    });
    flow.sysUser = 'noreply@example.com';
    flow.sysPw = 'wrong';
    await flow.submitSystem();
    expect(calls[0]?.body).toEqual({
      url: 'https://mail.example.com',
      user: 'noreply@example.com',
      app_password: 'wrong',
    });
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(flow.sysSt).toBe('err');
    flow.edit('sysPw', 'right');
    expect(flow.sysSt).toBeNull();
    expect(flow.sysError).toEqual({
      icon: 'ti-lock-x',
      title: 'Sign-in failed.',
      text: 'The account or app password is incorrect.',
    });
    await flow.submitSystem();
    expect(flow.sysSt).toBe('locked');
    expect(flow.sysLimitText).toBe(
      'Roedy Mail will try again in 45 seconds so the mail server doesn’t block the address.',
    );
    expect(h.fail).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(45_000);
    expect(flow.sysSt).toBeNull();
    await flow.submitSystem();
    expect(flow.sysGood).toBe(true);
    await flow.submitSystem();
    expect(flow.step).toBe(6);
    expect(flow.review.at(-1)).toMatchObject({ value: 'noreply@example.com', muted: false });
    flow.dispose();
  });

  it('names icon, title and text per reason if the mail server rejects the test (502)', async () => {
    const { flow, h } = at(5);
    const failed = (reason: string) => ({ status: 502, body: { error: 'mail_failed', reason } });
    mockApi({
      'POST setup/system-mail/test': [
        failed('no_identity'),
        failed('no_mailbox'),
        failed('unreachable'),
        failed('unexpected'),
        { status: 502, body: { error: 'mail_failed' } },
      ],
    });
    flow.sysPw = 'app-pw';
    await flow.submitSystem();
    expect([flow.sysSt, flow.sysReason, flow.phase]).toEqual(['err', 'no_identity', 'error']);
    expect(flow.sysError).toEqual({
      icon: 'ti-id-off',
      title: 'No identity.',
      text: 'The account has no identity for sending. Create an identity for this account in Stalwart.',
    });
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    const next = async () => {
      flow.edit('sysPw', 'app-pw');
      await flow.submitSystem();
      return flow.sysError;
    };
    expect(await next()).toEqual({
      icon: 'ti-folder-off',
      title: 'Mailbox missing.',
      text: 'The account is missing the “Drafts” mailbox.',
    });
    expect(await next()).toMatchObject({ icon: 'ti-plug-connected-x', title: 'Unreachable.' });
    const other = {
      icon: 'ti-alert-triangle',
      title: 'Unexpected response.',
      text: 'The mail server responded unexpectedly. Try again or set up system emails later.',
    };
    expect(await next()).toEqual(other);
    // Without a reason like an unknown one.
    expect(await next()).toEqual(other);
    expect(flow.sysReason).toBeNull();
  });

  it('discards the result of a test if the credentials were changed in the meantime', async () => {
    const { flow } = at(5);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/system-mail/test': [() => new Promise((resolve) => (answer = resolve))] });
    flow.sysPw = 'old';
    const pending = flow.submitSystem();
    await vi.waitFor(() => expect(flow.sysSt).toBe('busy'));
    flow.edit('sysPw', 'new');
    expect(flow.sysSt).toBeNull();
    answer({ status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } });
    await pending;
    expect(flow.sysSt).toBeNull();
  });

  it('"Set up later" continues without system mail', () => {
    const { flow } = at(5);
    flow.skipSystem();
    expect(flow.step).toBe(6);
    expect(flow.review.at(-1)).toMatchObject({ value: 'Not set up', muted: true, icon: 'ti-mail-off' });
  });
});

describe('Step 6: completion', () => {
  it('shows the overview and sets up, then reloads the session', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(6);
    flow.srvLabel = 'Main server';
    flow.srvDoms = 'example.com';
    flow.sysSkip = true;
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: { user: {} } }] });
    expect(flow.review.map((r) => [r.label, r.value])).toEqual([
      ['Administrator', 'Anna Baker · anna@example.com'],
      ['Stalwart server', 'Main server · mail.example.com'],
      ['OAuth client', 'roedy-abc'],
      ['Public URL', 'webmail.example.com'],
      ['System emails', 'Not set up'],
    ]);
    await flow.finish();
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(calls[0]?.body).toEqual({
      name: 'Anna Baker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      server: {
        label: 'Main server',
        url: 'https://mail.example.com',
        domains: ['example.com'],
        client_id: 'roedy-abc',
      },
      public_url: 'https://webmail.example.com',
    });
    expect(flow.view).toBe('done');
    expect(flow.phase).toBe('success');
    // The page dates from the time without a server: the next navigation loads the new CSP.
    expect(csp.stale).toBe(true);
    expect(flow.firstName).toBe('Anna');
    expect(flow.pw).toBe('');
    expect(h.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DONE_MS);
    expect(h.reload).toHaveBeenCalled();
  });

  it('sends system mail and client secret only if they apply', async () => {
    const { flow } = at(6);
    flow.oaMode = 'manual';
    flow.oaSec = 'secret';
    flow.sysPw = 'app-pw';
    flow.sysSt = 'ok';
    flow.sysOk = flow.sysKey;
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: {} }] });
    await flow.finish();
    expect(calls[0]?.body).toMatchObject({
      server: { client_secret: 'secret' },
      system_mail: { user: 'noreply@example.com', app_password: 'app-pw' },
    });
    flow.dispose();
  });

  it('jumps to the first affected step on field errors', async () => {
    const { flow, h } = at(6);
    const mismatch = {
      status: 422,
      body: {
        error: 'invalid',
        fields: { 'server.client_id': { code: 'redirect_mismatch', redirect_uri: 'https://old/oauth/callback' } },
      },
    };
    mockApi({
      'POST setup/complete': [
        {
          status: 422,
          body: {
            error: 'invalid',
            fields: {
              'server.url': { code: 'invalid' },
              password: { code: 'policy', rules: ['num'] },
              'system_mail.user': { code: 'invalid' },
            },
          },
        },
        mismatch,
        mismatch,
        { status: 422, body: { error: 'invalid', fields: { 'server.label': { code: 'too_long' } } } },
      ],
    });
    await flow.finish();
    expect(flow.step).toBe(3);
    expect(flow.err).toEqual({
      pw: true,
      srv: 'Please check the URL.',
      sysUser: 'Please check the URL.',
    });
    expect(h.fail).toHaveBeenLastCalledWith('pw');

    // Public address changed after the registration (`redirect_mismatch`):
    // "Automatic" back to the sign-in …
    flow.step = 6;
    await flow.finish();
    expect(flow.step).toBe(4);
    expect(flow.oaSt).toBeNull();
    expect(flow.oaCid).toBe('');
    expect(flow.oaErrText).toBe(
      'The public URL of Roedy Mail has changed since registration. Register the client again.',
    );
    expect(h.fail).toHaveBeenLastCalledWith(undefined);
    // … "Manual" at the client ID field with the client's redirect URI.
    flow.oaMode = 'manual';
    flow.oaCid = 'roedy-abc';
    flow.step = 6;
    await flow.finish();
    expect(flow.step).toBe(4);
    expect(flow.err).toEqual({
      oaCid:
        'This client was registered for the redirect URI https://old/oauth/callback, which no longer matches the public URL. Register the client again or enter a different client.',
    });
    expect(h.fail).toHaveBeenLastCalledWith('oaCid');

    // A field without text: error toast, the overview stays.
    flow.step = 6;
    await flow.finish();
    expect(flow.step).toBe(6);
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
  });

  it('names name, domains, client ID and secret with their own texts', async () => {
    const { flow, h } = at(6);
    const invalid = (fields: Record<string, unknown>) => ({ status: 422, body: { error: 'invalid', fields } });
    mockApi({
      'POST setup/complete': [
        invalid({ name: { code: 'too_long' } }),
        invalid({ name: { code: 'invalid' } }),
        invalid({ 'server.domains': { code: 'too_many' } }),
        invalid({ 'server.client_id': { code: 'invalid' } }),
        invalid({ 'server.client_secret': { code: 'too_long' } }),
      ],
    });
    const finish = async (): Promise<[number, unknown]> => {
      flow.step = 6;
      await flow.finish();
      return [flow.step, flow.err];
    };
    expect(await finish()).toEqual([2, { name: 'The name is too long.' }]);
    expect(h.fail).toHaveBeenLastCalledWith('name');
    expect(await finish()).toEqual([2, { name: 'The name contains invalid characters.' }]);
    expect(await finish()).toEqual([4, { srvDoms: 'Up to 100 domains per server.' }]);
    expect(await finish()).toEqual([4, { oaCid: 'The client ID contains invalid characters or is too long.' }]);
    expect(await finish()).toEqual([4, { oaSec: 'The secret contains invalid characters or is too long.' }]);
    expect(h.error).not.toHaveBeenCalled();
  });

  it('allows neither going back nor to a step during completion', async () => {
    const { flow } = at(6);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/complete': [() => new Promise((resolve) => (answer = resolve))] });
    const pending = flow.finish();
    expect(flow.loading).toBe(true);
    flow.back();
    flow.revisit(2);
    expect(flow.step).toBe(6);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('reloads on setup_done and reports other errors and network errors as a toast', async () => {
    const { flow, h } = at(6);
    mockApi({
      'POST setup/complete': [
        { status: 409, body: { error: 'setup_done' } },
        { status: 500, body: {} },
      ],
    });
    await flow.finish();
    expect(h.reload).toHaveBeenCalled();
    await flow.finish();
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
    expect(flow.loading).toBe(false);
    // No response any more: `fetch` fails.
    await flow.finish();
    expect(h.error).toHaveBeenLastCalledWith('No connection. Please try again.');
    expect(flow.loading).toBe(false);
  });

  it('returns to step 1 on a locked token', async () => {
    vi.useFakeTimers();
    const { flow } = at(6);
    mockApi({ 'POST setup/complete': [{ status: 429, body: { error: 'rate_limited', retry_after: 12 } }] });
    await flow.finish();
    expect(flow.step).toBe(1);
    expect(flow.tokErrText).toBe('Entry is locked for 12 seconds.');
    flow.dispose();
  });
});
