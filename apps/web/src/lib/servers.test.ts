import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csp } from '#lib/csp.ts';
import { KEPT_WAIT_MS } from '#lib/state/kept.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { forgetAccount } from '#lib/state/account.ts';
import { forgetRegistered } from '#lib/state/forget.ts';
import { dialogValues, ServersPage, serversValues, type AdminServer } from './servers.svelte.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const ME: Me = {
  id: 'u0',
  username: 'max',
  email: 'max@example.com',
  display_name: 'Max Miller',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: minutesAgo(6000),
  email_change: null,
  system_mail_configured: true,
};

const server = (id: string, label: string, url: string, extra: Partial<AdminServer> = {}): AdminServer => ({
  id,
  label,
  url,
  host: new URL(url).host,
  domains: [],
  client_id: null,
  has_secret: false,
  reach: 'unk',
  cors: 'unk',
  oauth: 'unk',
  tested_at: null,
  ...extra,
});
const S1 = server('s1', 'VPS 1', 'https://mail.s1.test', {
  domains: ['s1.test', 'example.com'],
  client_id: 'roedy-abc123',
  reach: 'ok',
  cors: 'ok',
  oauth: 'ok',
  tested_at: minutesAgo(25),
});
const S2 = server('s2', 'VPS 2', 'https://mail.s2.test', {
  client_id: 'c2',
  has_secret: true,
  reach: 'ok',
  cors: 'err',
  oauth: 'ok',
  tested_at: minutesAgo(120),
});
const DEV = server('sdev', 'Development', 'http://localhost:8080');
const REDIRECT = 'https://app.example.com/oauth/callback';
const list = (servers: AdminServer[], extra: Record<string, unknown> = {}) => ({
  body: { servers, redirect_uri: REDIRECT, system_mail_server: 's1', ...extra },
});
const POLICY = { body: { allow_custom_servers: false } };

const ctx = { scrollTo: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ctx.scrollTo.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  csp.stale = false;
  // Kept list and the toggles of the policy still on their way.
  forgetRegistered();
});

/** Loaded page with the test data; further responses per route. */
async function loaded(routes: Parameters<typeof mockApi>[0] = {}, servers = [S1, S2]) {
  const api = mockApi({
    'GET admin/servers': [list(servers), list(servers)],
    'GET admin/servers/policy': [POLICY, POLICY],
    ...routes,
  });
  const p = new ServersPage();
  await p.load();
  return { p, v: () => serversValues(p, ctx, NOW), sd: () => dialogValues(p), ...api };
}

const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);
const rowOf = (v: ReturnType<typeof serversValues>, id: string) => {
  const found = v.srvRows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

/** Response that only comes after `release()`. */
function later(answer: { status?: number; body?: unknown }) {
  let release = () => {};
  const reply = () =>
    new Promise<typeof answer>((resolve) => {
      release = () => resolve(answer);
    });
  return { reply, release: () => release() };
}

describe('List', () => {
  it('shows servers with domains, status, system mail and summary', async () => {
    const { v } = await loaded();
    const values = v();
    expect(values.srvHas).toBe(true);
    expect(values.srvEmpty).toBe(false);
    expect(values.srvSum).toBe('2 servers · 1 with warnings');
    expect(values.srvRedirect).toBe(REDIRECT);
    expect(values.srvOwnSum).toBe('Users can only choose from the servers in this list.');
    expect(values.tgSrvOwn.on).toBe(false);
    const r1 = rowOf(values, 's1');
    expect(r1).toMatchObject({
      label: 'VPS 1',
      host: 'mail.s1.test',
      url: 'https://mail.s1.test',
      sep: false,
      doms: [{ d: 's1.test' }, { d: 'example.com' }],
      noDoms: false,
      accts: 'No linked accounts',
      isSys: true,
      plain: false,
      warn: false,
      tested: 'Last tested 25 min ago',
      testLabel: 'Test connection',
      canDiag: true,
      diagOpen: false,
      diagBusy: false,
      diagDone: false,
      diagRows: [],
      diagLabel: 'Show diagnostics',
    });
    expect(r1.chips.map((c) => c.aria)).toEqual(['Reachable: OK', 'CORS enabled: OK', 'OAuth client registered: OK']);
    expect(r1.chips[0]).toMatchObject({ icon: 'ti-check', ic: '#4fae64', ink: 'var(--fg)', tip: 'OK' });
    const r2 = rowOf(values, 's2');
    expect(r2).toMatchObject({
      sep: true,
      isSys: false,
      warn: true,
      noDoms: true,
      tested: 'Last tested 2 hours ago',
    });
    expect(r2.chips[1]).toMatchObject({
      label: 'CORS enabled',
      status: 'err',
      icon: 'ti-x',
      ic: 'var(--danger)',
      aria: 'CORS enabled: missing',
      tip: 'Missing',
    });
  });

  it('marks http://localhost as unencrypted (example state "Development")', async () => {
    const { v } = await loaded({}, [S1, S2, { ...DEV, accounts: 2 }]);
    const values = v();
    expect(values.srvSum).toBe('3 servers · 1 with warnings');
    const dev = rowOf(values, 'sdev');
    expect(dev).toMatchObject({
      label: 'Development',
      url: 'http://localhost:8080',
      host: 'localhost:8080',
      plain: true,
      accts: '2 linked accounts',
      tested: 'Not tested yet',
      canDiag: false,
    });
    expect(dev.chips[0]).toMatchObject({ icon: 'ti-question-mark', aria: 'Reachable: unknown', tip: 'Unknown' });
    expect(rowOf(values, 's1').plain).toBe(false);
  });

  it('shows "No mail server yet" without servers and names the browser address without a public address', async () => {
    const api = mockApi({
      'GET admin/servers': [{ body: { servers: [], redirect_uri: null, system_mail_server: null } }],
      'GET admin/servers/policy': [{ body: { allow_custom_servers: true } }],
    });
    const p = new ServersPage();
    await p.load();
    const values = serversValues(p, ctx, NOW);
    expect(values.srvEmpty).toBe(true);
    expect(values.srvHas).toBe(false);
    expect(values.srvRedirect).toBe(`${location.origin}/oauth/callback`);
    expect(values.tgSrvOwn.on).toBe(true);
    expect(values.srvOwnSum).toBe('When adding an account, users can choose “Other server …”.');
    expect(sent(api.calls)).toEqual(['GET admin/servers', 'GET admin/servers/policy']);
  });

  it('scrolls to the sections via the tabs', async () => {
    const { v } = await loaded();
    const [list, policy] = v().srvTabs;
    expect([list?.label, policy?.label]).toEqual(['Servers', 'Policy']);
    policy?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('policy');
  });

  it('shows the card if the first load fails (offline or error)', async () => {
    mockApi({
      'GET admin/servers': [{ status: 500, body: { error: 'internal' } }],
      'GET admin/servers/policy': [POLICY],
    });
    const p = new ServersPage();
    await p.load();
    expect(p.status).toBe('failed');
    expect(p.failure).toBe('That didn’t work. Please try again.');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const q = new ServersPage();
    await q.load();
    expect(q.failure).toBe('No connection. Please try again.');
  });

  it('reloads the account without a session (sign-in or "Access denied")', async () => {
    const api = mockApi({
      'GET admin/servers': [{ status: 403, body: { error: 'forbidden' } }],
      'GET admin/servers/policy': [POLICY],
      'GET auth/me': [{ body: { ...ME, role: 'user' } }],
    });
    const p = new ServersPage();
    await p.load();
    await vi.waitFor(() => expect(session.isAdmin).toBe(false));
    expect(sent(api.calls)).toContain('GET auth/me');
  });

  it('reports a failed reload with an error toast and keeps the list', async () => {
    const { p, v } = await loaded({
      'GET admin/servers': [list([S1, S2]), { status: 500, body: { error: 'internal' } }],
    });
    await p.load();
    expect(p.status).toBe('ready');
    expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
    expect(v().srvRows.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('discards outdated responses', async () => {
    const slow = later(list([S1]));
    mockApi({
      'GET admin/servers': [slow.reply, list([S1, S2])],
      'GET admin/servers/policy': [POLICY, POLICY],
    });
    const p = new ServersPage();
    const first = p.load();
    await p.load();
    slow.release();
    await first;
    expect(p.rows.map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('Test connection', () => {
  it('tests, shows the progress in the row and reports the result', async () => {
    const reply = later({ body: { server: { ...S2, cors: 'ok', tested_at: minutesAgo(0) }, reasons: {} } });
    const { p, v, calls } = await loaded({ 'POST admin/servers/s2/test': [reply.reply] });
    const running = p.test('s2');
    let row = rowOf(v(), 's2');
    expect(row).toMatchObject({
      busy: true,
      diagOpen: true,
      diagBusy: true,
      diagDone: false,
      diagRows: [],
      tested: 'Testing …',
      testLabel: 'Testing',
    });
    // Only one test at a time.
    await p.test('s1');
    expect(sent(calls).filter((c) => c.endsWith('/test'))).toEqual(['POST admin/servers/s2/test']);
    reply.release();
    await running;
    row = rowOf(v(), 's2');
    expect(row).toMatchObject({ busy: false, diagDone: true, warn: false, tested: 'Last tested just now' });
    expect(ui.toast).toMatchObject({ text: 'VPS 2: connection OK', undo: false });
  });

  it('does not report a throttled test as "OK"', async () => {
    const tested = { ...S1, reach: 'unk', cors: 'unk', oauth: 'unk', tested_at: minutesAgo(0) } as const;
    const throttled = { reach: 'throttled', cors: 'throttled', oauth: 'throttled' };
    const { p, v } = await loaded({
      'POST admin/servers/s1/test': [{ body: { server: tested, reasons: throttled, retry_after: 60 } }],
    });
    await p.test('s1');
    expect(ui.toast?.text).toBe('VPS 1: test finished with warnings');
    // With the wait time from the response (`retry_after`), after it expires "in a few minutes".
    const texts = () => rowOf(v(), 's1').diagRows.map((r) => r.text);
    expect(texts()).toEqual(
      Array(3).fill(
        'Not checked because the mail server is throttling requests from Roedy Mail. Test again in 1 minute.',
      ),
    );
    p.testWait.clear('s1');
    expect(texts()).toEqual(
      Array(3).fill(
        'Not checked because the mail server is throttling requests from Roedy Mail. Test again in a few minutes.',
      ),
    );
  });

  it('shows the diagnosis with notices and actions', async () => {
    const tested = { ...S1, reach: 'ok', cors: 'err', oauth: 'err', tested_at: minutesAgo(0) } as const;
    const { p, v, sd } = await loaded({
      'POST admin/servers/s1/test': [
        // Unknown reasons: the general text of the row.
        { body: { server: tested, reasons: { cors: 'missing_origin', oauth: 'no_pkce' } } },
        { body: { server: tested, reasons: {} } },
      ],
    });
    await p.test('s1');
    expect(ui.toast?.text).toBe('VPS 1: test finished with warnings');
    const [jmap, cors, oauth] = rowOf(v(), 's1').diagRows;
    expect(jmap).toMatchObject({
      label: 'JMAP session',
      sub: 'GET https://mail.s1.test/.well-known/jmap',
      sep: false,
      icon: 'ti-circle-check',
      ic: '#4fae64',
      text: 'Session found. JMAP Core and Mail are available.',
      isErr: false,
    });
    expect(cors).toMatchObject({
      label: 'CORS headers',
      sub: 'Access-Control-Allow-Origin for app.example.com',
      sep: true,
      icon: 'ti-alert-triangle',
      isErr: true,
      actLabel: 'Test again',
    });
    expect(oauth).toMatchObject({
      label: 'OAuth client',
      sub: 'Client ID roedy-abc123',
      text: `In the Stalwart web admin, create an OAuth client with the redirect URI ${REDIRECT} and enter the client ID here, or have the client registered automatically.`,
      actLabel: 'Register client',
    });
    cors?.act();
    await vi.waitFor(() => expect(p.testing).toBeNull());
    // "Register client" opens the dialog with automatic registration.
    rowOf(v(), 's1').diagRows[2]?.act();
    expect(sd()).toMatchObject({ title: 'Edit server', isAuto: true, aNotOk: true });
    p.closeDialog();
    rowOf(v(), 's1').diagRows[0]?.act();
    expect(sd()).toMatchObject({ title: 'Edit server', isManual: true });
  });

  it('chooses the action of the OAuth row by reason', async () => {
    const tested = { ...S1, reach: 'ok', cors: 'ok', oauth: 'err', tested_at: minutesAgo(0) } as const;
    const { p, v, sd, calls } = await loaded({
      'POST admin/servers/s1/test': [
        { body: { server: tested, reasons: { oauth: 'unsupported_version' } } },
        { body: { server: tested, reasons: { oauth: 'revocation_endpoint_mismatch' } } },
      ],
    });
    await p.test('s1');
    let oauth = rowOf(v(), 's1').diagRows[2];
    expect(oauth).toMatchObject({
      text: 'This server isn’t Stalwart v1. Roedy Mail supports Stalwart 1.0 and later. Update Stalwart and test again.',
      actLabel: 'Test again',
    });
    // A registration would not help here: "Test again" tests instead of opening the dialog.
    oauth?.act();
    await vi.waitFor(() => expect(p.testing).toBeNull());
    expect(sent(calls).filter((c) => c.endsWith('/test'))).toHaveLength(2);
    expect(sd()).toBeNull();
    oauth = rowOf(v(), 's1').diagRows[2];
    expect(oauth?.actLabel).toBe('Edit URL');
    oauth?.act();
    expect(sd()).toMatchObject({ isManual: true, url: 'https://mail.s1.test' });
  });

  it('names unchecked rows as not reachable or not checked yet', async () => {
    const down = { ...S2, reach: 'err', cors: 'unk', oauth: 'unk', tested_at: minutesAgo(0) } as const;
    const { p, v } = await loaded({
      'POST admin/servers/s2/test': [{ body: { server: down, reasons: { reach: 'unreachable' } } }],
    });
    await p.test('s2');
    const rows = rowOf(v(), 's2').diagRows;
    expect(rows[0]).toMatchObject({
      isErr: true,
      actLabel: 'Edit URL',
      text: 'Can’t connect to this URL. Check the base URL, port, firewall, and TLS certificate.',
    });
    expect(rows[1]).toMatchObject({
      icon: 'ti-circle-dashed',
      ic: 'var(--mfg)',
      text: 'Not checked because the server isn’t reachable.',
    });
    p.rows = [{ ...S2, reach: 'ok', cors: 'unk', oauth: 'ok' }];
    expect(rowOf(v(), 's2').diagRows[1]?.text).toBe('Not checked yet.');
    rowOf(v(), 's2').diagToggle();
    expect(rowOf(v(), 's2')).toMatchObject({ diagOpen: false, diagLabel: 'Show diagnostics', diagRows: [] });
  });

  it('names reasons from the test response and forgets them on saving', async () => {
    const tested = { ...S1, reach: 'err', cors: 'unk', oauth: 'unk', tested_at: minutesAgo(0) } as const;
    const fixed = { ...S1, reach: 'ok', cors: 'err', oauth: 'ok', tested_at: minutesAgo(0) } as const;
    const retest = later({ body: { server: fixed, reasons: {} } });
    const { p, v } = await loaded({
      'POST admin/servers/s1/test': [
        { body: { server: tested, reasons: { reach: 'api_url_mismatch' } } },
        { body: { server: fixed, reasons: { cors: 'authorization_not_allowed' } } },
        retest.reply,
      ],
      'PATCH admin/servers/s1': [{ body: fixed }],
    });
    await p.test('s1');
    let rows = rowOf(v(), 's1').diagRows;
    expect(rows.map((r) => r.text)).toEqual([
      'Stalwart reports a different URL in the session. Enter the public URL that Stalwart itself uses.',
      'Not checked because the server isn’t reachable.',
      'Not checked because the server isn’t reachable.',
    ]);
    await p.test('s1');
    rows = rowOf(v(), 's1').diagRows;
    expect(rows.map((r) => r.text)).toEqual([
      'Session found. JMAP Core and Mail are available.',
      'The server doesn’t allow the Authorization header. Check the CORS settings in Stalwart and in the reverse proxy.',
      'Client ID set, and the server supports sign-in. The first sign-in shows whether it accepts the client.',
    ]);
    expect(p.reasons.get('s1')).toEqual({ cors: 'authorization_not_allowed' });
    // Saved: the reasons no longer apply, the following test brings new ones (none here).
    p.openDialog(p.rows[0]);
    await p.save();
    expect(p.reasons.has('s1')).toBe(false);
    retest.release();
    await vi.waitFor(() => expect(p.testing).toBeNull());
    expect(rowOf(v(), 's1').diagRows[1]?.text).toBe(
      'The browser isn’t allowed to reach the server directly. In the Stalwart web admin, turn on “Permissive CORS” in the HTTP settings, save, and reload the configuration.',
    );
  });

  it('names the general texts without a reason (e.g. after loading the page)', async () => {
    const down = { ...S2, reach: 'err', cors: 'unk', oauth: 'unk', tested_at: minutesAgo(5) } as const;
    const { v } = await loaded({}, [S1, down]);
    rowOf(v(), 's2').diagToggle();
    expect(rowOf(v(), 's2').diagRows.map((r) => r.text)).toEqual([
      'No JMAP server responds at this URL. Check the base URL, port, and firewall. The path /.well-known/jmap must be reachable from outside.',
      'Not checked because the server isn’t reachable.',
      'Not checked because the server isn’t reachable.',
    ]);
  });

  it('reports a failed test and reloads the list', async () => {
    const { p, calls } = await loaded({ 'POST admin/servers/s1/test': [{ status: 500, body: { error: 'internal' } }] });
    await p.test('s1');
    expect(ui.toast).toMatchObject({
      text: 'That didn’t work. Please try again.',
      error: true,
      undo: false,
    });
    expect(p.testing).toBeNull();
    // Without a result the row stays collapsed.
    expect(p.diag.has('s1')).toBe(false);
    await vi.waitFor(() => expect(sent(calls).filter((c) => c === 'GET admin/servers')).toHaveLength(2));
  });

  it('keeps open diagnostics open after a failed test', async () => {
    const { p, v } = await loaded({ 'POST admin/servers/s1/test': [{ status: 500, body: { error: 'internal' } }] });
    rowOf(v(), 's1').diagToggle();
    await p.test('s1');
    expect(ui.toast).toMatchObject({ error: true });
    expect(rowOf(v(), 's1')).toMatchObject({
      canDiag: true,
      diagOpen: true,
      diagDone: true,
      diagLabel: 'Hide diagnostics',
    });
    expect(rowOf(v(), 's1').diagRows).toHaveLength(3);
  });

  it('collapses the diagnostics of a server never tested after a failed test', async () => {
    const fresh = server('s3', 'New', 'https://mail.new.test');
    const { p, v } = await loaded({ 'POST admin/servers/s3/test': [{ status: 500, body: { error: 'internal' } }] }, [
      S1,
      fresh,
    ]);
    const running = p.test('s3');
    expect(rowOf(v(), 's3')).toMatchObject({ diagOpen: true, canDiag: false });
    await running;
    expect(ui.toast).toMatchObject({ error: true });
    expect(rowOf(v(), 's3')).toMatchObject({ diagOpen: false, canDiag: false, diagRows: [] });
  });

  it('discards a test result if the server was saved in the meantime', async () => {
    const reply = later({ body: { server: { ...S1, label: 'Alt' }, reasons: {} } });
    const { p } = await loaded({
      'POST admin/servers/s1/test': [reply.reply],
      'PATCH admin/servers/s1': [{ body: { ...S1, label: 'New' } }],
    });
    const running = p.test('s1');
    p.openDialog(S1);
    p.setLabel('New');
    await p.save();
    reply.release();
    await running;
    expect(p.rows.find((s) => s.id === 's1')?.label).toBe('New');
  });
});

describe('Saved during a test', () => {
  it('tests a saved server after the running test', async () => {
    const running = later({ body: { server: S1, reasons: {} } });
    const { p, calls } = await loaded({
      'POST admin/servers/s1/test': [running.reply],
      'PATCH admin/servers/s2': [{ body: { ...S2, url: 'https://mail.new.test', tested_at: null, cors: 'unk' } }],
      'POST admin/servers/s2/test': [{ body: { server: { ...S2, url: 'https://mail.new.test' }, reasons: {} } }],
    });
    const first = p.test('s1');
    p.openDialog(p.rows[1]);
    p.setUrl('https://mail.new.test');
    await p.save();
    expect(sent(calls).filter((c) => c.endsWith('/test'))).toEqual(['POST admin/servers/s1/test']);
    running.release();
    await first;
    await vi.waitFor(() => expect(sent(calls)).toContain('POST admin/servers/s2/test'));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('VPS 2: test finished with warnings'));
  });

  it('loads again if the list changed during loading', async () => {
    const stale = later(list([S1, S2]));
    const created = server('s3', 'New', 'https://mail.new.test');
    const { p, calls } = await loaded({
      'GET admin/servers': [list([S1, S2]), stale.reply, list([S1, S2, created])],
      'POST admin/servers': [{ status: 201, body: created }],
      'POST admin/servers/s3/test': [{ body: { server: created, reasons: {} } }],
    });
    const reload = p.load();
    p.openDialog();
    p.setLabel('New');
    p.setUrl('https://mail.new.test');
    await p.save();
    // The CSP of this tab does not know the new server: the next navigation reloads.
    expect(csp.stale).toBe(true);
    stale.release();
    await reload;
    await vi.waitFor(() => expect(sent(calls).filter((c) => c === 'GET admin/servers')).toHaveLength(3));
    await vi.waitFor(() => expect(p.rows.map((s) => s.id)).toEqual(['s1', 's2', 's3']));
  });
});

describe('Remove', () => {
  it('asks with a warning about the system mail, removes with undo and reloads the account after expiry', async () => {
    const { p, v, calls } = await loaded({
      'DELETE admin/servers/s1': [{ status: 204 }],
      'GET auth/me': [{ body: { ...ME, system_mail_configured: false } }],
    });
    rowOf(v(), 's1').remove();
    expect(ui.confirm).toMatchObject({
      title: 'Remove “VPS 1”?',
      text: 'No account is linked to this server. System emails are sent through this server and will stop working.',
      icon: 'ti-server-off',
      ok: 'Remove',
      danger: true,
    });
    ui.confirmOk();
    expect(v().srvRows.map((r) => r.id)).toEqual(['s2']);
    expect(ui.toast).toMatchObject({ text: '“VPS 1” removed', undo: true });
    // "Undo": back at its place, nothing sent.
    ui.toasts.undo();
    expect(v().srvRows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(sent(calls)).not.toContain('DELETE admin/servers/s1');
    rowOf(v(), 's1').remove();
    ui.confirmOk();
    expect(sent(calls)).not.toContain('DELETE admin/servers/s1');
    await ui.toasts.flush();
    await vi.waitFor(() => expect(session.user?.system_mail_configured).toBe(false));
    expect(sent(calls)).toContain('DELETE admin/servers/s1');
    expect(p.systemServer).toBeNull();
  });

  it('names linked accounts and reverts the removal if the server rejects it', async () => {
    const { p, v, calls } = await loaded(
      { 'DELETE admin/servers/s2': [{ status: 500, body: { error: 'internal' } }] },
      [S1, { ...S2, accounts: 3 }],
    );
    p.remove(p.rows[1] as AdminServer);
    expect(ui.confirm?.text).toBe(
      '3 linked accounts will lose their connection until they’re assigned to another server.',
    );
    ui.confirmOk();
    expect(v().srvRows.map((r) => r.id)).toEqual(['s1']);
    await ui.toasts.flush();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(v().srvRows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(sent(calls)).not.toContain('GET auth/me');
    p.rows = [{ ...S2, accounts: 1 }];
    p.remove(p.rows[0] as AdminServer);
    expect(ui.confirm?.text).toBe('One linked account will lose its connection until it’s assigned to another server.');
  });

  it('counts as removed on 404 and keeps the server out of reloaded lists', async () => {
    const del = later({ status: 404, body: { error: 'not_found' } });
    const { p } = await loaded({ 'DELETE admin/servers/s2': [del.reply] });
    p.remove(p.rows[1] as AdminServer);
    ui.confirmOk();
    // Waiting in the toast and then on its way: reloaded lists leave it out.
    await p.load();
    expect(p.rows.map((s) => s.id)).toEqual(['s1']);
    const sending = ui.toasts.flush();
    await p.load();
    expect(p.rows.map((s) => s.id)).toEqual(['s1']);
    del.release();
    await sending;
    expect(ui.toast?.text).not.toBe('That didn’t work. Please try again.');
    expect(p.rows.map((s) => s.id)).toEqual(['s1']);
  });

  it('sends a waiting removal immediately when leaving the page and reports a later error', async () => {
    const { p, v, calls } = await loaded({ 'DELETE admin/servers/s2': [{ status: 500, body: { error: 'internal' } }] });
    rowOf(v(), 's2').remove();
    ui.confirmOk();
    p.dispose();
    // The toast closes: "Undo" no longer applies.
    expect(ui.toast).toBeNull();
    expect(sent(calls)).toContain('DELETE admin/servers/s2');
    await ui.toasts.flush();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    // The left page loads nothing any more; the kept list still has the server.
    expect(sent(calls).filter((c) => c === 'GET admin/servers')).toHaveLength(1);
    expect(new ServersPage().rows.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('brings back the row as it was shown at the confirmation', async () => {
    const { p } = await loaded();
    const old = p.rows[1] as AdminServer;
    // A reload changed the label while the dialog was open.
    p.rows = [p.rows[0] as AdminServer, { ...old, label: 'VPS 2 new' }];
    p.remove(old);
    ui.confirmOk();
    expect(ui.toast?.text).toBe('“VPS 2 new” removed');
    ui.toasts.undo();
    expect(p.rows.map((s) => s.label)).toEqual(['VPS 1', 'VPS 2 new']);
  });

  it('clears the system mail server only if it still is the removed one', async () => {
    const { p, v, calls } = await loaded({ 'DELETE admin/servers/s1': [{ status: 204 }] });
    rowOf(v(), 's1').remove();
    ui.confirmOk();
    // Reloaded in the meantime with another server for the system mail.
    p.systemServer = 's2';
    await ui.toasts.flush();
    expect(p.systemServer).toBe('s2');
    expect(sent(calls)).not.toContain('GET auth/me');
  });

  it('a reopened page loads only after the removal sent on leaving, with `keepalive`', async () => {
    const del = later({ status: 204 });
    const { p, v } = await loaded({ 'DELETE admin/servers/s2': [del.reply] });
    rowOf(v(), 's2').remove();
    ui.confirmOk();
    p.dispose();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', keepalive: true });
    const { calls } = mockApi({ 'GET admin/servers': [list([S1])], 'GET admin/servers/policy': [POLICY] });
    const q = new ServersPage();
    const load = q.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls)).toEqual([]);
    del.release();
    await load;
    expect(sent(calls)).toEqual(['GET admin/servers', 'GET admin/servers/policy']);
    expect(q.rows.map((s) => s.id)).toEqual(['s1']);
  });

  it('a reopened page loads again once a removal that took too long is through', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const del = later({ status: 204 });
    const { p, v } = await loaded({ 'DELETE admin/servers/s2': [del.reply] });
    rowOf(v(), 's2').remove();
    ui.confirmOk();
    p.dispose();
    const { calls } = mockApi({
      'GET admin/servers': [list([S1, S2]), list([S1])],
      'GET admin/servers/policy': [POLICY, POLICY],
    });
    const q = new ServersPage();
    const load = q.load();
    await vi.advanceTimersByTimeAsync(KEPT_WAIT_MS);
    await load;
    expect(q.rows.map((s) => s.id)).toEqual(['s1', 's2']);
    del.release();
    await vi.waitFor(() => expect(q.rows.map((s) => s.id)).toEqual(['s1']));
    expect(sent(calls).filter((c) => c === 'GET admin/servers')).toHaveLength(2);
  });

  it('a reopened page loads only after a removal sent before leaving', async () => {
    const del = later({ status: 204 });
    const { p, v } = await loaded({ 'DELETE admin/servers/s2': [del.reply] });
    rowOf(v(), 's2').remove();
    ui.confirmOk();
    // Sent before leaving (toast expired), still on its way.
    const sending = ui.toasts.flush();
    p.dispose();
    const { calls } = mockApi({ 'GET admin/servers': [list([S1])], 'GET admin/servers/policy': [POLICY] });
    const q = new ServersPage();
    const load = q.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls)).toEqual([]);
    del.release();
    await load;
    await sending;
    expect(q.rows.map((s) => s.id)).toEqual(['s1']);
  });

  it('leaves an action of another page waiting when leaving', async () => {
    const { p } = await loaded();
    const other = { text: 'Elsewhere', revert: vi.fn(), commit: vi.fn(() => Promise.resolve()) };
    ui.toasts.defer(other);
    p.dispose();
    expect(other.commit).not.toHaveBeenCalled();
    expect(ui.toast?.text).toBe('Elsewhere');
  });
});

describe('Policy and redirect URI', () => {
  it('toggles custom server URLs, one after the other and reverting on errors', async () => {
    const first = later({ body: { allow_custom_servers: true } });
    const { p, v, calls } = await loaded({
      'PUT admin/servers/policy': [first.reply, { status: 500, body: { error: 'internal' } }],
      // After the error the page reloads: on the server the first call applies.
      'GET admin/servers/policy': [POLICY, { body: { allow_custom_servers: true } }],
    });
    expect(csp.stale).toBe(false);
    v().tgSrvOwn.onClick();
    expect(p.allowOwn).toBe(true);
    // Already before the response: the CSP of this tab allows custom servers only after reloading.
    expect(csp.stale).toBe(true);
    expect(ui.toast?.text).toBe('Custom server URLs allowed');
    expect(v().srvOwnSum).toBe('When adding an account, users can choose “Other server …”.');
    v().tgSrvOwn.onClick();
    expect(ui.toast?.text).toBe('Only servers from the list allowed');
    // The second call waits for the first.
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    first.release();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('That didn’t work. Please try again.'));
    expect(ui.toast?.error).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { allow_custom_servers: true },
      { allow_custom_servers: false },
    ]);
    expect(p.allowOwn).toBe(true);
  });

  it('copies the redirect URI', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { v } = await loaded();
    v().srvCopyRedirect();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Redirect URI copied'));
    expect(writeText).toHaveBeenCalledWith(REDIRECT);
  });

  it('reports if the redirect URI cannot be copied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no'))) } });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const { p } = await loaded();
    await p.copyRedirect();
    expect(ui.toast).toMatchObject({
      text: 'Couldn’t copy. Select the URI and copy it manually.',
      error: true,
    });
    Reflect.deleteProperty(document, 'execCommand');
  });
});

describe('Dialog', () => {
  it('opens for adding with the default values', async () => {
    const { p, v, sd } = await loaded();
    expect(sd()).toBeNull();
    ui.toasts.show('Redirect URI copied');
    v().srvAdd();
    // A visible toast disappears.
    expect(ui.toast).toBeNull();
    expect(sd()).toMatchObject({
      title: 'Add server',
      sub: 'JMAP server that users can connect to',
      btn: 'Add and test',
      icon: 'ti-server-2',
      label: '',
      url: 'https://',
      doms: [],
      domPh: 'example.com',
      isAuto: true,
      isManual: false,
      aOk: false,
      aNotOk: true,
      regLabel: 'Register client automatically',
      regIcon: 'ti-wand',
      secPh:
        'Optional. Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only.',
      redirect: REDIRECT,
      plain: false,
      hasELabel: false,
    });
    expect(sd()?.oaOpts.map((o) => [o.label, o.on, o.shadow])).toEqual([
      ['Automatic', true, 'var(--sh1)'],
      ['Manual', false, 'none'],
    ]);
    sd()?.oaOpts[1]?.onClick();
    expect(sd()?.isManual).toBe(true);
    sd()?.close();
    expect(p.dialog).toBeNull();
  });

  it('edits a server with a stored secret only with the same client ID', async () => {
    const { v, sd } = await loaded();
    rowOf(v(), 's2').edit();
    expect(sd()).toMatchObject({
      title: 'Edit server',
      sub: 'mail.s2.test',
      btn: 'Save and test',
      icon: 'ti-server-cog',
      isManual: true,
      cid: 'c2',
      secPh: 'The secret is saved. Leave empty to keep it. It stays in the backend only.',
    });
    sd()?.onCid('c3');
    expect(sd()?.secPh).toMatch(/^Optional\./);
    sd()?.onSecEye();
    expect(sd()).toMatchObject({ showSec: true, secIcon: 'ti-eye-off', secTip: 'Hide' });
  });

  it('points out http://localhost (editing example state "Development")', async () => {
    const { v, sd } = await loaded({}, [S1, DEV]);
    rowOf(v(), 'sdev').edit();
    expect(sd()).toMatchObject({ url: 'http://localhost:8080', plain: true, sub: 'localhost:8080' });
    sd()?.onUrl('http://mail.example.com');
    sd()?.save();
    expect(sd()).toMatchObject({
      plain: false,
      eUrl: 'Use an HTTPS URL. http:// only works for localhost.',
    });
  });

  it('checks the fields and then sends nothing', async () => {
    const { v, sd, calls } = await loaded();
    v().srvAdd();
    sd()?.onUrl('mail.example.com');
    sd()?.onDomIn('Bad_Domain ');
    sd()?.save();
    expect(sd()).toMatchObject({
      eLabel: 'Please enter a label.',
      hasELabel: true,
      eUrl: 'The URL must start with https://, e.g. https://mail.example.com.',
      eDom: '“bad_domain” isn’t a valid domain.',
      hasEDom: true,
    });
    sd()?.onLabel('New');
    expect(sd()?.hasELabel).toBe(false);
    // The scheme in any case like the backend.
    sd()?.onUrl('Https://mail.example.com');
    // Removing the domain makes the message no longer apply.
    sd()?.doms[0]?.rm();
    expect(sd()?.hasEDom).toBe(false);
    sd()?.onDomIn('s1.test');
    sd()?.save();
    expect(sd()?.eDom).toBe('“s1.test” is already assigned to “VPS 1”.');
    expect(sent(calls).filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('turns input into domains (comma, Enter, backspace, leaving the field)', async () => {
    const { v, sd } = await loaded();
    v().srvAdd();
    const key = (k: string) => {
      const event = { key: k, preventDefault: vi.fn() };
      sd()?.domKey(event);
      return event;
    };
    sd()?.onDomIn('A.test, @b.test;a.test c');
    expect(sd()).toMatchObject({ doms: [{ d: 'a.test' }, { d: 'b.test' }], domIn: 'c', domPh: '' });
    sd()?.onDomIn('c.test');
    expect(key('Enter').preventDefault).toHaveBeenCalled();
    expect(sd()?.doms.map((d) => d.d)).toEqual(['a.test', 'b.test', 'c.test']);
    key('Backspace');
    expect(sd()?.doms.map((d) => d.d)).toEqual(['a.test', 'b.test']);
    sd()?.onDomIn('d.test');
    sd()?.domBlur();
    expect(sd()).toMatchObject({ domIn: '', doms: [{ d: 'a.test' }, { d: 'b.test' }, { d: 'd.test' }] });
    expect(sd()?.doms[0]?.rmLabel).toBe('Remove a.test');
  });

  it('registers the client automatically, discards the credentials and saves afterwards', async () => {
    const reply = later({ body: { client_id: 'roedy-xyz', redirect_uri: REDIRECT } });
    const created = server('s3', 'New', 'https://mail.new.test', { client_id: 'roedy-xyz' });
    const { p, v, sd, calls } = await loaded({
      'POST admin/servers/register-client': [reply.reply],
      'POST admin/servers': [{ status: 201, body: created }],
      'POST admin/servers/s3/test': [{ body: { server: created, reasons: {} } }],
    });
    v().srvAdd();
    sd()?.reg();
    expect(sd()).toMatchObject({
      eUrl: 'Enter the server’s URL first.',
      eAdm: 'Please enter the mail server’s admin user and app password.',
      hasEAdm: true,
    });
    sd()?.onLabel('New');
    sd()?.onUrl('https://mail.new.test/');
    sd()?.onAu(' admin ');
    sd()?.onAp('secret');
    expect(sd()?.hasEAdm).toBe(false);
    sd()?.reg();
    expect(sd()).toMatchObject({ aBusy: true, regLabel: 'Registering …', regIcon: 'ti-loader-2' });
    expect(dialogValues(p)).toMatchObject({ aOk: false, cid: '' });
    // Saving waits until the client ID is fixed.
    sd()?.save();
    expect(sd()?.saving).toBe(true);
    expect(sent(calls)).not.toContain('POST admin/servers');
    reply.release();
    await vi.waitFor(() => expect(p.dialog).toBeNull());
    expect(calls.find((c) => c.path === 'admin/servers/register-client')?.body).toEqual({
      url: 'https://mail.new.test',
      username: 'admin',
      password: 'secret',
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === 'admin/servers')?.body).toMatchObject({
      client_id: 'roedy-xyz',
    });
  });

  it('shows the registered client and returns to the stored client ID with "Register again"', async () => {
    const { v, sd } = await loaded({
      'POST admin/servers/register-client': [{ body: { client_id: 'roedy-xyz', redirect_uri: REDIRECT } }],
    });
    rowOf(v(), 's1').edit();
    sd()?.oaOpts[0]?.onClick();
    sd()?.onAu('admin');
    sd()?.onAp('secret');
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aOk).toBe(true));
    expect(sd()).toMatchObject({ aNotOk: false, cid: 'roedy-xyz', cidNote: 'Client ID roedy-xyz', au: '', ap: '' });
    // Otherwise saving afterwards would remove the stored client.
    sd()?.regAgain();
    expect(sd()).toMatchObject({ aNotOk: true, cid: 'roedy-abc123' });
  });

  it('discards the registration if the address changes', async () => {
    const reply = later({ body: { client_id: 'late', redirect_uri: REDIRECT } });
    const { p, v, sd } = await loaded({
      'POST admin/servers/register-client': [{ body: { client_id: 'roedy-1', redirect_uri: REDIRECT } }, reply.reply],
    });
    rowOf(v(), 's1').edit();
    sd()?.oaOpts[0]?.onClick();
    sd()?.onAu('admin');
    sd()?.onAp('pw');
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aOk).toBe(true));
    sd()?.onUrl('https://mail.s1.test');
    expect(sd()?.aOk).toBe(true);
    sd()?.onUrl('https://mail.other.example.com');
    expect(sd()).toMatchObject({ aOk: false, cid: 'roedy-abc123' });
    // Entered by hand: stays even if the address changes afterwards.
    sd()?.onUrl('https://mail.s1.test');
    sd()?.onAu('admin');
    sd()?.onAp('pw');
    p.dialog = p.dialog && {
      ...p.dialog,
      aSt: 'ok',
      regUrl: 'https://mail.s1.test',
      regCid: 'roedy-1',
      cid: 'roedy-1',
    };
    sd()?.oaOpts[1]?.onClick();
    sd()?.onCid('von-hand');
    sd()?.onUrl('https://mail.s1.test/new');
    expect(sd()).toMatchObject({ isManual: true, cid: 'von-hand' });
    sd()?.onUrl('https://mail.s1.test');
    sd()?.oaOpts[0]?.onClick();
    sd()?.onAu('admin');
    sd()?.onAp('pw');
    sd()?.reg();
    sd()?.onUrl('https://mail.third.example.com');
    reply.release();
    await Promise.resolve();
    expect(sd()).toMatchObject({ aBusy: false, aOk: false, cid: 'von-hand' });
  });

  it('shows registration errors per reason', async () => {
    const failed = (reason: string, status = 422) => ({ status, body: { error: 'registration_failed', reason } });
    const { v, sd } = await loaded({
      'POST admin/servers/register-client': [
        failed('auth_failed'),
        failed('unsupported', 502),
        failed('unreachable', 502),
        failed('throttled', 502),
        failed('invalid_response', 502),
        failed('forbidden'),
        failed('mfa_required'),
        failed('unsupported_version', 502),
        { status: 502, body: { error: 'registration_failed', reason: 'rejected', detail: 'invalid_redirect_uri' } },
        failed('rejected', 502),
      ],
    });
    v().srvAdd();
    sd()?.onUrl('https://mail.new.test');
    const attempt = async () => {
      sd()?.onAu('admin');
      sd()?.onAp('wrong');
      sd()?.reg();
      await vi.waitFor(() => expect(sd()?.aBusy).toBe(false));
    };
    await attempt();
    expect(sd()).toMatchObject({
      eAdm: 'Administrator sign-in failed. Check the username and app password.',
      ap: '',
      aNotOk: true,
    });
    await attempt();
    expect(sd()).toMatchObject({
      eAdm: 'This mail server doesn’t allow automatic registration. Choose “Manual” and create the client in the Stalwart web admin.',
      hasEAdm: true,
      aLocked: false,
    });
    await attempt();
    expect(sd()?.eAdm).toBe('The mail server can’t be reached. Check the server URL.');
    // Throttled without a wait time (does not occur per the API): the fallback text.
    await attempt();
    expect(sd()).toMatchObject({
      eAdm: 'The mail server isn’t accepting requests right now. Try again in a few minutes.',
      aThr: false,
    });
    await attempt();
    expect(sd()?.eAdm).toBe(
      'The mail server rejected the registration. Choose “Manual” and create the client in the Stalwart web admin.',
    );
    // Stalwart v1: a missing permission keeps the fields, the second factor clears the app password.
    await attempt();
    expect(sd()).toMatchObject({
      eAdm: 'This account isn’t allowed to create OAuth clients. Sign in with an administrator account or grant the account the “SysOAuthClientCreate” permission in Stalwart.',
      ap: 'wrong',
    });
    await attempt();
    expect(sd()).toMatchObject({
      eAdm: 'This account requires a second factor. Sign in with an app password instead of your password.',
      ap: '',
    });
    await attempt();
    expect(sd()?.eAdm).toBe(
      'This server isn’t Stalwart v1. Roedy Mail supports Stalwart 1.0 and later. Update Stalwart and try again.',
    );
    await attempt();
    expect(sd()?.eAdm).toBe(
      'The mail server rejected the registration (invalid_redirect_uri). Choose “Manual” and create the client in the Stalwart web admin.',
    );
    await attempt();
    expect(sd()?.eAdm).toBe(
      'The mail server rejected the registration. Choose “Manual” and create the client in the Stalwart web admin.',
    );
    expect(sd()?.aLocked).toBe(false);
  });

  it('shows throttling by Stalwart as box "Too many requests." and locks the registration', async () => {
    vi.useFakeTimers();
    const { p, v, sd } = await loaded({
      'POST admin/servers/register-client': [
        { status: 502, body: { error: 'registration_failed', reason: 'throttled', retry_after: 90 } },
        { status: 429, body: { error: 'rate_limited', retry_after: 30 } },
      ],
    });
    v().srvAdd();
    sd()?.onUrl('https://mail.new.test');
    sd()?.onAu('admin');
    sd()?.onAp('app-password');
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aThr).toBe(true));
    expect(sd()).toMatchObject({
      aThrText: 'The mail server is throttling requests from Roedy Mail. Try again in 2 minutes.',
      aLocked: false,
      hasEAdm: false,
      regDis: true,
      regLabel: 'Register client automatically in 1:30',
      regIcon: 'ti-lock',
      au: 'admin',
      ap: 'app-password',
    });
    // The throttling applies only to this server; another one can be registered.
    sd()?.onUrl('https://mail.other.example.com');
    expect(sd()).toMatchObject({
      aThr: false,
      aLocked: false,
      regDis: false,
      regLabel: 'Register client automatically',
    });
    sd()?.onUrl('https://mail.new.test');
    expect(sd()?.aThr).toBe(true);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(sd()).toMatchObject({ aThr: false, regDis: false, regLabel: 'Register client automatically' });
    // Roedy's own lock stays "Too many attempts.".
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aLocked).toBe(true));
    expect(sd()?.aThr).toBe(false);
    p.regLock.stop();
    vi.useRealTimers();
  });

  it('names the linked accounts that must sign in again after a new client when editing', async () => {
    const { p, v, sd } = await loaded();
    const edit = (id: string, accounts: number) => {
      const row = p.rows.find((r) => r.id === id);
      if (row) row.accounts = accounts;
      rowOf(v(), id).edit();
    };
    edit('s1', 3);
    sd()?.oaOpts[0]?.onClick();
    expect(sd()).toMatchObject({
      hasLinkHint: true,
      linkHint: 'With a new client, the 3 linked accounts have to sign in again.',
      hasCidHint: false,
    });
    sd()?.oaOpts[1]?.onClick();
    sd()?.onCid('other-id');
    expect(sd()).toMatchObject({
      hasCidHint: true,
      cidHint: 'With a different client ID, the 3 linked accounts have to sign in again.',
    });
    sd()?.close();
    edit('s1', 1);
    sd()?.oaOpts[0]?.onClick();
    expect(sd()?.linkHint).toBe('With a new client, the linked account has to sign in again.');
    sd()?.close();
    edit('s1', 0);
    expect(sd()).toMatchObject({ hasLinkHint: false, hasCidHint: false });
    sd()?.close();
    // When adding there are no accounts yet.
    v().srvAdd();
    expect(sd()).toMatchObject({ hasLinkHint: false, hasCidHint: false });
  });

  it('names the secret of the registration as stored and sends none', async () => {
    const created = server('s3', 'New', 'https://mail.new.test', { client_id: 'roedy-xyz', has_secret: true });
    const { p, v, sd, calls } = await loaded({
      'POST admin/servers/register-client': [
        { body: { client_id: 'roedy-xyz', redirect_uri: REDIRECT, has_secret: true } },
      ],
      'POST admin/servers': [{ status: 201, body: created }],
      'POST admin/servers/s3/test': [{ body: { server: created, reasons: {} } }],
    });
    v().srvAdd();
    sd()?.onLabel('New');
    sd()?.onUrl('https://mail.new.test');
    sd()?.onAu('admin');
    sd()?.onAp('app-password');
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aOk).toBe(true));
    sd()?.oaOpts[1]?.onClick();
    expect(sd()).toMatchObject({
      isManual: true,
      cid: 'roedy-xyz',
      secPh:
        'The secret from the automatic registration is stored in the backend and applied when you save. Leave empty to use it.',
      secReg: true,
    });
    // Another client ID has no secret.
    sd()?.onCid('other');
    expect(sd()?.secPh).toMatch(/^Optional\./);
    expect(sd()?.secReg).toBe(false);
    sd()?.onCid('roedy-xyz');
    sd()?.save();
    await vi.waitFor(() => expect(p.dialog).toBeNull());
    expect(calls.find((c) => c.method === 'POST' && c.path === 'admin/servers')?.body).toEqual({
      label: 'New',
      url: 'https://mail.new.test',
      domains: [],
      client_id: 'roedy-xyz',
    });
  });

  it('requires a new registration if the redirect URI no longer matches', async () => {
    const mismatch = {
      status: 422,
      body: {
        error: 'invalid',
        fields: { client_id: { code: 'redirect_mismatch', redirect_uri: 'https://old.example.com/oauth/callback' } },
      },
    };
    const registered = { body: { client_id: 'roedy-new', redirect_uri: REDIRECT, has_secret: true } };
    const { p, v, sd } = await loaded({
      'POST admin/servers/register-client': [registered, registered],
      'PATCH admin/servers/s1': [mismatch, mismatch],
    });
    const attempt = async () => {
      sd()?.save();
      await vi.waitFor(() => expect(p.dialog?.saving).toBe(false));
    };
    rowOf(v(), 's1').edit();
    sd()?.oaOpts[0]?.onClick();
    sd()?.onAu('admin');
    sd()?.onAp('app-password');
    sd()?.reg();
    await vi.waitFor(() => expect(sd()?.aOk).toBe(true));
    // "Automatic": back to the sign-in with the stored client ID.
    await attempt();
    expect(sd()).toMatchObject({
      isAuto: true,
      aNotOk: true,
      cid: 'roedy-abc123',
      eAdm: 'The public URL of Roedy Mail has changed since registration. Register the client again.',
      hasECred: false,
    });
    // "Manual": the input stays, the notice with the client's redirect URI sits at the client ID field.
    sd()?.oaOpts[1]?.onClick();
    sd()?.onCid('roedy-new');
    await attempt();
    expect(sd()).toMatchObject({
      isManual: true,
      cid: 'roedy-new',
      eCred:
        'This client was registered for the redirect URI https://old.example.com/oauth/callback, which no longer matches the public URL. Register the client again or enter a different client.',
      hasECred: true,
    });
    expect(ui.toast).toBeNull();
  });

  it('locks the registration after 429 with a running wait time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { p, v, sd, calls } = await loaded({
      'POST admin/servers/register-client': [
        { status: 429, body: { error: 'rate_limited', retry_after: 900 } },
        { body: { client_id: 'roedy-xyz', redirect_uri: REDIRECT } },
      ],
    });
    v().srvAdd();
    sd()?.onUrl('https://mail.new.test');
    sd()?.onAu('admin');
    sd()?.onAp('secret');
    await p.register();
    expect(sd()).toMatchObject({
      aLocked: true,
      aLockText: 'Try again in 15 minutes.',
      regLabel: 'Register client automatically in 15:00',
      regIcon: 'ti-lock',
      regDis: true,
      eAdm: '',
      hasEAdm: false,
    });
    // Locked: no further attempt.
    await p.register();
    expect(sent(calls).filter((c) => c === 'POST admin/servers/register-client')).toHaveLength(1);
    vi.advanceTimersByTime(870_000);
    expect(sd()).toMatchObject({
      aLockText: 'Try again in 30 seconds.',
      regLabel: 'Register client automatically in 0:30',
    });
    vi.advanceTimersByTime(30_000);
    expect(sd()).toMatchObject({
      aLocked: false,
      regDis: false,
      regLabel: 'Register client automatically',
      regIcon: 'ti-wand',
    });
    await p.register();
    expect(sd()).toMatchObject({ aOk: true, cid: 'roedy-xyz' });
    p.dispose();
  });

  it('adds, closes the dialog and tests right away', async () => {
    const created = server('s3', 'New', 'https://mail.new.test', { domains: ['new.test'], client_id: 'roedy-xyz' });
    const { p, v, sd, calls } = await loaded({
      'POST admin/servers': [{ status: 201, body: created }],
      'POST admin/servers/s3/test': [
        { body: { server: { ...created, reach: 'ok', cors: 'ok', oauth: 'ok' }, reasons: {} } },
      ],
    });
    v().srvAdd();
    sd()?.onLabel(' New ');
    sd()?.onUrl('https://mail.new.test/ ');
    sd()?.onDomIn('new.test');
    sd()?.oaOpts[1]?.onClick();
    sd()?.onCid('roedy-xyz');
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    sd()?.key(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('New: connection OK'));
    expect(calls.find((c) => c.method === 'POST' && c.path === 'admin/servers')?.body).toEqual({
      label: 'New',
      url: 'https://mail.new.test',
      domains: ['new.test'],
      client_id: 'roedy-xyz',
    });
    expect(p.dialog).toBeNull();
    expect(rowOf(v(), 's3')).toMatchObject({ diagOpen: true, diagDone: true });
  });

  it('changes a server: secret only if entered, an empty client ID removes the client', async () => {
    const { v, sd, calls } = await loaded({
      'PATCH admin/servers/s2': [{ body: S2 }, { body: { ...S2, client_id: null, has_secret: false } }],
      'POST admin/servers/s2/test': [{ body: { server: S2, reasons: {} } }, { body: { server: S2, reasons: {} } }],
    });
    rowOf(v(), 's2').edit();
    sd()?.onCsec(' new-secret ');
    sd()?.save();
    await vi.waitFor(() => expect(sd()).toBeNull());
    await vi.waitFor(() => expect(ui.toast?.text).toContain('VPS 2'));
    rowOf(v(), 's2').edit();
    sd()?.onCid('');
    sd()?.onCsec('stays-away');
    sd()?.save();
    await vi.waitFor(() => expect(sd()).toBeNull());
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { label: 'VPS 2', url: 'https://mail.s2.test', domains: [], client_id: 'c2', client_secret: 'new-secret' },
      { label: 'VPS 2', url: 'https://mail.s2.test', domains: [], client_id: null },
    ]);
  });

  it('shows field errors of the server', async () => {
    const invalid = (fields: Record<string, unknown>) => ({ status: 422, body: { error: 'invalid', fields } });
    const { p, v, sd } = await loaded({
      'PATCH admin/servers/s2': [
        invalid({ url: { code: 'taken', server: 'VPS 1' } }),
        invalid({ domains: { code: 'taken', domain: 'x.test', server: 'Other' } }),
        invalid({ domains: { code: 'too_many' } }),
        invalid({ client_id: { code: 'invalid' } }),
        invalid({ client_secret: { code: 'too_long' } }),
        invalid({ label: { code: 'too_long' } }),
        { status: 500, body: { error: 'internal' } },
      ],
      'GET admin/servers': [list([S1, S2]), list([S1, S2]), list([S1, S2])],
    });
    rowOf(v(), 's2').edit();
    const attempt = async () => {
      sd()?.save();
      await vi.waitFor(() => expect(p.dialog?.saving).toBe(false));
    };
    await attempt();
    expect(sd()?.eUrl).toBe('This server has already been added.');
    await attempt();
    expect(sd()?.eDom).toBe('“x.test” is already assigned to “Other”.');
    await attempt();
    expect(sd()).toMatchObject({ eDom: 'Up to 100 domains per server.', hasEDom: true });
    await attempt();
    expect(sd()).toMatchObject({
      eCred: 'The client ID contains invalid characters or is too long.',
      hasECred: true,
      hasEUrl: false,
      hasEDom: false,
    });
    await attempt();
    expect(sd()?.eCred).toBe('The secret contains invalid characters or is too long.');
    expect(ui.toast).toBeNull();
    // A field without text in the dialog: error toast.
    await attempt();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(sd()).toMatchObject({ hasECred: false, hasELabel: false });
    ui.toasts.undo();
    await attempt();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(sd()?.title).toBe('Edit server');
  });

  it('reports client ID and secret together without an additional toast', async () => {
    const { p, v, sd } = await loaded({
      'PATCH admin/servers/s2': [
        {
          status: 422,
          body: { error: 'invalid', fields: { client_id: { code: 'invalid' }, client_secret: { code: 'too_long' } } },
        },
      ],
    });
    rowOf(v(), 's2').edit();
    sd()?.save();
    await vi.waitFor(() => expect(p.dialog?.saving).toBe(false));
    expect(sd()?.eCred).toBe('The client ID contains invalid characters or is too long.');
    expect(ui.toast).toBeNull();
  });

  it('checks the number of domains, client ID and secret before sending', async () => {
    const { v, sd, calls } = await loaded();
    rowOf(v(), 's2').edit();
    sd()?.onDomIn(Array.from({ length: 101 }, (_, i) => `d${String(i)}.test`).join(' ') + ' ');
    sd()?.save();
    expect(sd()).toMatchObject({ eDom: 'Up to 100 domains per server.', hasEDom: true });
    sd()?.doms[0]?.rm();
    sd()?.onCid('c2\u0007');
    sd()?.save();
    expect(sd()).toMatchObject({
      hasEDom: false,
      eCred: 'The client ID contains invalid characters or is too long.',
      hasECred: true,
    });
    sd()?.onCid('c2');
    // Typing in client ID or secret clears the message.
    expect(sd()?.hasECred).toBe(false);
    // Over 1024 bytes: umlauts count twice.
    sd()?.onCsec('\u00e4'.repeat(513));
    sd()?.save();
    expect(sd()?.eCred).toBe('The secret contains invalid characters or is too long.');
    expect(sent(calls).filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('checks the domains in the order invalid, already assigned, number', async () => {
    const { v, sd, calls } = await loaded();
    rowOf(v(), 's2').edit();
    const many = Array.from({ length: 101 }, (_, i) => `d${String(i)}.test`);
    sd()?.onDomIn([...many, 'example.com', 'bad_domain'].join(' ') + ' ');
    const rm = (d: string) => {
      const chip = sd()?.doms.find((x) => x.d === d);
      chip?.rm();
    };
    sd()?.save();
    expect(sd()?.eDom).toBe('“bad_domain” isn’t a valid domain.');
    rm('bad_domain');
    sd()?.save();
    expect(sd()?.eDom).toBe('“example.com” is already assigned to “VPS 1”.');
    rm('example.com');
    sd()?.save();
    expect(sd()?.eDom).toBe('Up to 100 domains per server.');
    expect(sent(calls).filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('takes over a response after closing without changing a new dialog', async () => {
    const reply = later({ status: 201, body: server('s3', 'New', 'https://mail.new.test') });
    const { p, v, sd } = await loaded({
      'POST admin/servers': [reply.reply],
      'POST admin/servers/s3/test': [{ body: { server: server('s3', 'New', 'https://mail.new.test'), reasons: {} } }],
    });
    v().srvAdd();
    sd()?.onLabel('New');
    sd()?.onUrl('https://mail.new.test');
    sd()?.save();
    sd()?.close();
    rowOf(v(), 's1').edit();
    reply.release();
    await vi.waitFor(() => expect(p.rows.map((s) => s.id)).toContain('s3'));
    expect(sd()?.title).toBe('Edit server');
  });

  it('closes by clicking the backdrop, not in the dialog', async () => {
    const { v, sd } = await loaded();
    v().srvAdd();
    const inner = document.createElement('div');
    const scrim = document.createElement('div');
    sd()?.overlay({ target: inner, currentTarget: scrim, preventDefault: () => {} });
    expect(sd()).not.toBeNull();
    sd()?.overlay({ target: scrim, currentTarget: scrim, preventDefault: () => {} });
    expect(sd()).toBeNull();
  });
});

describe('Reopening', () => {
  it('shows list and policy of the last open page at once and replaces them with the new ones', async () => {
    const { p } = await loaded({
      'GET admin/servers/policy': [{ body: { allow_custom_servers: true } }],
    });
    p.dispose();
    mockApi({ 'GET admin/servers': [list([S1], { system_mail_server: null })], 'GET admin/servers/policy': [POLICY] });
    const q = new ServersPage();
    expect([q.status, q.rows.map((s) => s.id), q.redirectUri, q.systemServer, q.allowOwn]).toEqual([
      'ready',
      ['s1', 's2'],
      REDIRECT,
      's1',
      true,
    ]);
    await q.load();
    expect([q.rows.map((s) => s.id), q.systemServer, q.allowOwn]).toEqual([['s1'], null, false]);
  });

  it('keeps the list with the toast "Couldn’t update the list." if loading fails, also without a connection', async () => {
    const { p } = await loaded();
    p.dispose();
    const fails = [
      () =>
        mockApi({
          'GET admin/servers': [{ status: 500, body: { error: 'internal' } }],
          'GET admin/servers/policy': [POLICY],
        }),
      () =>
        vi.stubGlobal(
          'fetch',
          vi.fn(() => Promise.reject(new TypeError('offline'))),
        ),
    ];
    for (const fail of fails) {
      fail();
      const q = new ServersPage();
      await q.load();
      expect(q.status).toBe('ready');
      expect(q.rows.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
      ui.reset();
      q.dispose();
    }
  });

  it('keeps list and policy as the server knows them while a removal or toggle may yet fail', async () => {
    const del = later({ status: 204 });
    const { p } = await loaded({
      'DELETE admin/servers/s2': [del.reply],
      'PUT admin/servers/policy': [() => new Promise(() => {})],
    });
    const s2 = p.rows.find((s) => s.id === 's2');
    if (!s2) throw new Error('no s2');
    p.remove(s2);
    ui.confirmOk();
    p.toggleOwn();
    expect([p.rows.map((s) => s.id), p.allowOwn]).toEqual([['s1'], true]);
    p.dispose();
    const q = new ServersPage();
    expect([q.rows.map((s) => s.id), q.allowOwn]).toEqual([['s1', 's2'], false]);
    del.release();
    await ui.toasts.flush();
  });

  it('asks for the policy only after a toggle still on its way', async () => {
    let done: (reply: { body: { allow_custom_servers: boolean } }) => void = () => {};
    const { p, calls } = await loaded({
      'PUT admin/servers/policy': [() => new Promise((resolve) => (done = resolve))],
      'GET admin/servers/policy': [POLICY, { body: { allow_custom_servers: true } }],
    });
    p.toggleOwn();
    const load = p.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls).filter((c) => c === 'GET admin/servers/policy')).toHaveLength(1);
    done({ body: { allow_custom_servers: true } });
    await load;
    expect(sent(calls).slice(-2)).toEqual(['PUT admin/servers/policy', 'GET admin/servers/policy']);
    p.dispose();
    expect(new ServersPage().allowOwn).toBe(true);
  });

  it('keeps a confirmed removal and toggle', async () => {
    const { p } = await loaded({
      'DELETE admin/servers/s2': [{ status: 204 }],
      'PUT admin/servers/policy': [{ body: { allow_custom_servers: true } }],
    });
    const s2 = p.rows.find((s) => s.id === 's2');
    if (!s2) throw new Error('no s2');
    p.remove(s2);
    ui.confirmOk();
    p.toggleOwn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    p.dispose();
    const q = new ServersPage();
    expect([q.rows.map((s) => s.id), q.allowOwn]).toEqual([['s1'], true]);
  });

  it('a save the left page confirms later makes the reopened page load again', async () => {
    let saved: (reply: { body: AdminServer }) => void = () => {};
    let answer: (reply: ReturnType<typeof list>) => void = () => {};
    const { p } = await loaded({ 'PATCH admin/servers/s1': [() => new Promise((resolve) => (saved = resolve))] });
    p.openDialog(S1);
    p.setLabel('New');
    const saving = p.save();
    p.dispose();
    mockApi({
      'GET admin/servers': [() => new Promise((resolve) => (answer = resolve)), list([{ ...S1, label: 'New' }, S2])],
      'GET admin/servers/policy': [POLICY, POLICY],
    });
    const q = new ServersPage();
    const load = q.load();
    saved({ body: { ...S1, label: 'New' } });
    await saving;
    answer(list([S1, S2]));
    await load;
    await vi.waitFor(() => expect(q.rows.find((s) => s.id === 's1')?.label).toBe('New'));
  });

  it('a reopened page asks for the policy only after a toggle of the left page', async () => {
    let done: (reply: { body: { allow_custom_servers: boolean } }) => void = () => {};
    const { p, calls } = await loaded({
      'PUT admin/servers/policy': [() => new Promise((resolve) => (done = resolve))],
    });
    p.toggleOwn();
    p.dispose();
    const q = new ServersPage();
    const load = q.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls).filter((c) => c === 'GET admin/servers/policy')).toHaveLength(1);
    done({ body: { allow_custom_servers: true } });
    await load;
    expect(sent(calls).slice(-2)).toEqual(['PUT admin/servers/policy', 'GET admin/servers/policy']);
  });

  it('a toggle queued before signing out is not sent with a later session', async () => {
    let done: (reply: { body: { allow_custom_servers: boolean } }) => void = () => {};
    const { p, calls } = await loaded({
      'PUT admin/servers/policy': [
        () => new Promise((resolve) => (done = resolve)),
        { body: { allow_custom_servers: false } },
      ],
    });
    p.toggleOwn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls).filter((c) => c === 'PUT admin/servers/policy')).toHaveLength(1);
    p.toggleOwn();
    forgetRegistered();
    done({ body: { allow_custom_servers: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls).filter((c) => c === 'PUT admin/servers/policy')).toHaveLength(1);
  });

  it('signing out discards list and policy, also of a page left afterwards', async () => {
    const { p } = await loaded();
    p.dispose();
    const { p: open } = await loaded();
    forgetAccount();
    open.dispose();
    const q = new ServersPage();
    expect([q.status, q.rows]).toEqual(['loading', []]);
  });
});
