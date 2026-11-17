import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { freshForm, MailLogin, type FlowState } from '#lib/auth/mail-login.svelte.ts';
import type { MailServer, ServerList } from '#lib/auth/stalwart-login.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { mailCheck } from '#lib/mail-account.svelte.ts';
import { mailPush } from '#lib/mail-push.svelte.ts';
import {
  mailConnectionValues,
  MailConnectionPage,
  RE_DONE_DELAY,
  type MailConnectionNav,
} from './mail-connection.svelte.ts';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const MAIL = 'https://mail.s1.test';

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
  username: 'alex',
  email: 'alex@example.com',
  display_name: 'Alex Morgan',
  role: 'user',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-07-24T10:00:00Z',
  email_change: null,
};

const VPS1: MailServer = {
  id: 's1',
  label: 'VPS 1',
  url: MAIL,
  host: 'mail.s1.test',
  domains: ['s1.test'],
  client_id: 'roedy',
  backend_exchange: false,
  reach: 'ok',
  cors: 'ok',
  oauth: 'ok',
};
const VPS2: MailServer = { ...VPS1, id: 's2', label: 'VPS 2', url: 'https://mail.s2.test', host: 'mail.s2.test' };
const SERVERS: ServerList = { servers: [VPS1, VPS2], allow_custom_servers: false };

/** Account a1 (password, VPS 1); `M2` below is the account with a token on VPS 2. */
function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    username: 'account1@s1.test',
    url: MAIL,
    host: 'mail.s1.test',
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

const M2 = {
  id: 'a2',
  email: 'account2@s2.test',
  url: 'https://mail.s2.test',
  host: 'mail.s2.test',
  server_id: 's2',
  auth_kind: 'token',
  state: 'needs_reauth',
} as const satisfies Partial<MailAccount>;

let nav: { [K in keyof MailConnectionNav]: ReturnType<typeof vi.fn> };
let ml: MailLogin;

function page(id = 'a1'): MailConnectionPage {
  const p = new MailConnectionPage(id, nav as unknown as MailConnectionNav, ml);
  p.start();
  return p;
}

function values(p: MailConnectionPage) {
  const v = mailConnectionValues(p);
  if (!v) throw new Error('account unknown');
  return v;
}

/** Open "Sign in again" form of the account, as `mailLogin.re` sets it. */
function setForm(patch: Partial<FlowState> = {}, a: MailAccount = accounts.get('a1') ?? account()): void {
  ml.re.account = a.id;
  ml.re.form = { ...freshForm(a), ...patch };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
  nav = { servers: vi.fn() };
  ml = new MailLogin(() => ({
    fetch: (input, init) => fetch(input, init),
    storage: sessionStorage,
    assign: () => {},
    now: () => Date.now(),
    origin: 'https://app.example.com',
    user: () => session.user?.id ?? null,
  }));
  ml.servers = SERVERS;
  accounts.reset();
  accounts.list = [account()];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  session.config = null;
  session.user = null;
  accounts.reset();
  ui.reset();
  prefs.reset();
  mailCheck.busy = null;
  mailCheck.rot = 0;
});

describe('sign-in required', () => {
  it('shows the notice about the sign-in page and "Continue to sign-in" for a password', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    const v = values(page());
    expect(v).toMatchObject({
      raShow: true,
      raNeeds: true,
      raIdle: false,
      raFree: false,
      raForm: true,
      raBlocked: false,
      raIntro: 'mail.s1.test rejected the sign-in. Sign in again.',
    });
    expect(v.ra).toMatchObject({
      isCred: true,
      isPw: true,
      isTok: false,
      pwHint: 'You’ll sign in as account1@s1.test on the sign-in page of mail.s1.test, then return here.',
      btnLabel: 'Continue to sign-in',
      btnIcon: 'ti-login-2',
      btnDis: false,
      hasErr: false,
    });
    // The form is there with the account's details, but not opened yet.
    expect(ml.re.form).toBeNull();
  });

  it('requires an access token for a token and opens the form with the first input', () => {
    accounts.list = [account(), account(M2)];
    const p = page('a2');
    let v = values(p);
    expect(v.raNeeds).toBe(true);
    expect(v.ra).toMatchObject({
      isTok: true,
      isPw: false,
      btnLabel: 'Connect',
      btnIcon: 'ti-plug-connected',
      btnDis: true,
      hot: false,
      sec: '',
      secType: 'password',
      eyeIcon: 'ti-eye',
      eyeTip: 'Show',
    });
    // "Show" before the first input stays when that input opens the form.
    v.ra.onEye();
    v.ra.onSec('secret');
    expect(ml.re.account).toBe('a2');
    expect(ml.re.form).toMatchObject({ email: 'account2@s2.test', srv: 's2', auth: 'token', token: 'secret' });
    v = values(p);
    expect(v.ra).toMatchObject({ sec: 'secret', btnDis: false, hot: true, secType: 'text', eyeTip: 'Hide' });
    expect(v.raFree).toBe(false);
  });

  it('takes over the account after "Connect" and closes after done with the toast', async () => {
    accounts.list = [account(), account(M2)];
    mockApi({
      'GET servers': [{ body: SERVERS }],
      'POST mail-accounts/a2/reauth': [{ body: account({ ...M2, state: 'ok' }) }],
    });
    const p = page('a2');
    values(p).ra.onSec('new');
    values(p).ra.submit();
    expect(values(p).ra).toMatchObject({
      busy: true,
      busyText: 'Checking access token …',
      btnLabel: 'Connecting …',
    });
    await vi.waitFor(() => expect(ml.re.form?.step).toBe('done'));
    expect(accounts.get('a2')?.state).toBe('ok');
    const v = values(p);
    expect(v).toMatchObject({ raNeeds: false, raFree: true, raIdle: false });
    expect(v.ra).toMatchObject({
      isDone: true,
      isCred: false,
      doneTitle: 'Reconnected',
      doneText: 'Syncing messages from mail.s2.test.',
    });
    p.arm(p.form);
    vi.advanceTimersByTime(RE_DONE_DELAY - 1);
    expect(ml.re.form).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(ml.re.form).toBeNull();
    expect(ui.toast?.text).toBe('Signed in to mail.s2.test');
    expect(values(p)).toMatchObject({ raShow: false, raIdle: true, raFree: false });
  });

  it('sends with Enter even without an opened form', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    mockApi({ 'GET servers': [{ body: SERVERS }] });
    const p = page();
    const event = { key: 'Enter', preventDefault: vi.fn() };
    values(p).ra.key(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ml.re.account).toBe('a1');
    expect(values(p).ra).toMatchObject({
      busy: true,
      busyText: 'Opening the sign-in page of mail.s1.test …',
      btnLabel: 'Opening …',
      btnIcon: 'ti-loader-2',
      btnSpin: true,
      btnDis: true,
    });
    p.dispose();
    expect(ml.re.form).toBeNull();
  });
});

describe('connected account', () => {
  it('offers "Sign in again" and closes with "Cancel"', () => {
    const p = page();
    let v = values(p);
    expect(v).toMatchObject({ raShow: false, raNeeds: false, raIdle: true, raFree: false, raForm: true });
    v.raStart();
    v = values(p);
    expect(v).toMatchObject({ raShow: true, raIdle: false, raFree: true });
    expect(v.ra).toMatchObject({ isCred: true, isPw: true, btnLabel: 'Continue to sign-in', btnDis: false });
    expect(ml.re.form).toMatchObject({ email: 'account1@s1.test', srv: 's1', url: '', auth: 'oauth' });
    v.ra.cancel();
    expect(ml.re.form).toBeNull();
    expect(values(p)).toMatchObject({ raShow: false, raIdle: true });
  });

  it('signs in with an own server via its address', () => {
    accounts.list = [account({ server_id: null, url: 'https://own.example.com', host: 'own.example.com' })];
    const p = page();
    values(p).raStart();
    expect(ml.re.form).toMatchObject({ srv: 'other', url: 'https://own.example.com' });
    expect(values(p).ra.pwHint).toBe(
      'You’ll sign in as account1@s1.test on the sign-in page of own.example.com, then return here.',
    );
  });

  it('shows the form only for its own account', () => {
    accounts.list = [account(), account(M2)];
    setForm({}, account(M2));
    expect(values(page())).toMatchObject({ raShow: false, raIdle: true, raFree: false });
  });
});

describe('return and loading', () => {
  it('shows the "finishing" step after the return', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    setForm({ step: 'ret' });
    expect(values(page()).ra).toMatchObject({
      isRet: true,
      isCred: false,
      busy: false,
      retTitle: 'Finishing sign-in to mail.s1.test …',
      retText: 'Roedy Mail is applying the new sign-in.',
    });
  });

  it('closes once after done and lets a rebuild of the page take over the timer', () => {
    setForm({ step: 'done', done: 'a1', as: 'account1@s1.test' });
    const p = page();
    p.arm(p.form);
    vi.advanceTimersByTime(1000);
    // Desktop ↔ mobile: the new page is created before the old one goes.
    const q = page();
    q.arm(q.form);
    p.dispose();
    expect(ml.re.form?.step).toBe('done');
    vi.advanceTimersByTime(RE_DONE_DELAY);
    expect(ml.re.form).toBeNull();
    expect(ui.toast?.text).toBe('Signed in to mail.s1.test');
  });

  it('closes the form when leaving the page', () => {
    const p = page();
    values(p).raStart();
    p.dispose();
    expect(ml.re.form).toBeNull();
  });
});

describe('errors', () => {
  it('shows the errors with the account host', () => {
    const cases: [Partial<FlowState>, string, string, string][] = [
      [
        { err: 'reach' },
        'ti-plug-connected-x',
        'Server unreachable',
        'mail.s1.test isn’t responding. Check your internet connection or try again later.',
      ],
      [
        { err: 'expired' },
        'ti-clock-x',
        'Sign-in expired',
        'The sign-in was canceled or has expired. Please start again.',
      ],
      [
        { err: 'denied', sErr: 'server_error' },
        'ti-circle-x',
        'Sign-in not completed',
        'mail.s1.test didn’t complete the sign-in. Try again. If the problem persists, contact your administrator.',
      ],
      [
        { err: 'iss' },
        'ti-shield-x',
        'Response from a different server',
        'The sign-in response didn’t come from mail.s1.test and was discarded for security reasons. Please start again.',
      ],
      [
        { err: 'other', as: 'info@s1.test' },
        'ti-user-x',
        'Different account signed in',
        'You signed in to mail.s1.test as info@s1.test. Sign in as account1@s1.test.',
      ],
      [
        { err: 'cors' },
        'ti-world-off',
        'CORS not enabled',
        'mail.s1.test doesn’t allow requests directly from the browser. Your administrator needs to turn on “Permissive CORS” in Stalwart.',
      ],
      [
        { err: 'oauth' },
        'ti-key-off',
        'OAuth client not registered',
        'No OAuth client is set up for mail.s1.test yet. Ask your administrator to register it under Administration › Mail servers.',
      ],
    ];
    accounts.list = [account({ state: 'needs_reauth' })];
    for (const [patch, icon, title, text] of cases) {
      setForm(patch);
      const ra = values(page()).ra;
      expect(ra, title).toMatchObject({ isCred: true, hasErr: true, eIcon: icon, eTitle: title, eText: text });
      expect(ra.eHasCode, title).toBe(patch.err === 'denied');
      expect(ra.btnLabel, title).toBe('Continue to sign-in');
    }
    setForm({ err: 'denied', sErr: 'server_error' });
    expect(values(page()).ra.eCode).toBe('server_error');
  });

  it('reports a rejected access token and clears the field', () => {
    accounts.list = [account(), account(M2)];
    setForm({ err: 'tok', token: '' }, account(M2));
    expect(values(page('a2')).ra).toMatchObject({
      eIcon: 'ti-lock-x',
      eTitle: 'Invalid access token',
      eText: 'mail.s2.test rejected the access token. Check it or create a new one.',
      sec: '',
      btnDis: true,
    });
  });

  it('offers "Check mail servers" for CORS and OAuth only to the administration', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    setForm({ err: 'oauth' });
    expect(values(page()).ra).toMatchObject({ eHasAct: false, eAct: '' });
    session.user = { ...ME, role: 'admin' };
    const ra = values(page()).ra;
    expect(ra).toMatchObject({ eHasAct: true, eAct: 'Check mail servers' });
    ra.eFn?.();
    expect(nav.servers).toHaveBeenCalledOnce();
    setForm({ err: 'reach' });
    expect(values(page()).ra.eHasAct).toBe(false);
  });

  it('locks after "Too many attempts" with a waiting time until its end', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    setForm({ err: 'rate', rl: true });
    ml.re.lockUntil = NOW + 30_000;
    const p = page();
    p.watchLock(ml.re.lockUntil);
    expect(values(p).ra).toMatchObject({
      hasErr: true,
      eIcon: 'ti-hourglass',
      eTitle: 'Too many attempts',
      eText: 'mail.s1.test isn’t accepting sign-ins right now. Try again in 30 seconds.',
      btnLabel: 'Try again in 0:30',
      btnIcon: 'ti-lock',
      locked: true,
      btnDis: true,
    });
    vi.advanceTimersByTime(30_000);
    expect(values(p).ra).toMatchObject({ hasErr: false, locked: false, btnLabel: 'Continue to sign-in' });
  });

  it('reports errors without a key of their own once as an error toast', () => {
    const p = page();
    setForm({ failure: new ApiError(500, { error: 'internal' }) });
    p.report(p.form);
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    ui.toast = null;
    p.report(p.form);
    expect(ui.toast).toBeNull();
    expect(values(p).ra.hasErr).toBe(false);
  });
});

describe('server no longer allowed', () => {
  it('shows the notice instead of the form, "Check mail servers" only to the administration', () => {
    accounts.list = [account({ blocked: true, server_id: null })];
    setForm();
    const p = page();
    expect(values(p)).toMatchObject({
      raShow: true,
      raForm: false,
      raBlocked: true,
      raIdle: false,
      raFree: false,
      raBlockAdm: false,
      raBlockText:
        'mail.s1.test is no longer an approved server. You can sign in again once your administrator approves it. You can also remove the account.',
    });
    expect(p.form).toBeNull();
    session.user = { ...ME, role: 'admin' };
    const v = values(p);
    expect(v.raBlockAdm).toBe(true);
    v.raBlockGo();
    expect(nav.servers).toHaveBeenCalledOnce();
  });

  it('shows both with "Sign-in required" and sends nothing', () => {
    accounts.list = [account({ blocked: true, state: 'needs_reauth' })];
    const p = page();
    const v = values(p);
    expect(v).toMatchObject({ raNeeds: true, raBlocked: true, raForm: false });
    v.ra.submit();
    v.raStart();
    expect(ml.re.form).toBeNull();
  });
});

describe('account', () => {
  it('returns no values while the list is unknown or the account is missing (the layout leads to the list)', () => {
    accounts.list = null;
    const p = page('a9');
    expect(mailConnectionValues(p)).toBeNull();
    accounts.list = [account()];
    expect(mailConnectionValues(p)).toBeNull();
  });
});

describe('facts', () => {
  it('shows base URL, session user name and sign-in, with "Advanced" the JMAP session', () => {
    accounts.list = [account({ username: 'account1' })];
    const p = page();
    const facts = () => values(p).maC.facts.map((f) => [f.k, f.v]);
    expect(facts()).toEqual([
      ['Base URL', MAIL],
      ['Username', 'account1'],
      ['Sign-in method', 'Password'],
    ]);
    prefs.values.advanced = true;
    expect(facts().at(-1)).toEqual(['JMAP session', `${MAIL}/.well-known/jmap`]);
  });

  it('omits the user name for access tokens', () => {
    accounts.list = [account(M2)];
    expect(values(page('a2')).maC.facts.map((f) => [f.k, f.v])).toEqual([
      ['Base URL', 'https://mail.s2.test'],
      ['Sign-in method', 'Access token'],
    ]);
  });

  it('names the server of the list, otherwise the host with a warning', () => {
    const p = page();
    expect(values(p)).toMatchObject({ raServer: 'VPS 1 · mail.s1.test', raServerWarn: false });
    accounts.list = [account({ server_id: null })];
    expect(values(p)).toMatchObject({ raServer: 'mail.s1.test · not in the server list', raServerWarn: true });
    accounts.list = [account({ blocked: true })];
    expect(values(p)).toMatchObject({ raServer: 'mail.s1.test · not in the server list', raServerWarn: true });
  });

  it('reloads the server list if it does not know the account server yet', async () => {
    ml.servers = { servers: [VPS2], allow_custom_servers: false };
    const { calls } = mockApi({ 'GET servers': [{ body: SERVERS }] });
    const p = page();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET servers']);
    expect(values(p).raServer).toBe('VPS 1 · mail.s1.test');
  });

  it('loads the server list if it is missing and shows only the host until then', async () => {
    ml.servers = null;
    const { calls } = mockApi({ 'GET servers': [{ body: SERVERS }] });
    const p = page();
    expect(values(p)).toMatchObject({ raServer: 'mail.s1.test', raServerWarn: false });
    await vi.runAllTimersAsync();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET servers']);
    expect(values(p).raServer).toBe('VPS 1 · mail.s1.test');
  });
});

describe('check connection', () => {
  it('checks via mailCheck with "Checking", rotation and toast', async () => {
    const checked = account({ quota_used: 1, quota_total: 2, last_check_at: '2026-10-28T12:00:00Z' });
    const { calls } = mockApi({ 'POST mail-accounts/a1/check': [{ body: checked }] });
    const p = page();
    values(p).maC.check();
    expect(values(p).maC).toMatchObject({ checkLabel: 'Checking', busy: true, rot: 720 });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST mail-accounts/a1/check']);
    expect(values(p).maC).toMatchObject({ checkLabel: 'Check connection', busy: false });
    expect(ui.toast).toMatchObject({ text: 'Connection to mail.s1.test is OK', error: false });
  });

  it('reports a locked server as an error toast', async () => {
    accounts.list = [account({ blocked: true })];
    mockApi({ 'POST mail-accounts/a1/check': [{ status: 409, body: { error: 'blocked' } }] });
    values(page()).maC.check();
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.toast).toMatchObject({ text: 'mail.s1.test is no longer an approved server.', error: true });
  });
});

describe('remove account', () => {
  it('asks, hides the account with undo and removes it after expiry', async () => {
    accounts.list = [account(), account(M2)];
    const { calls } = mockApi({ 'DELETE mail-accounts/a1': [{ status: 204 }] });
    values(page()).maC.remove();
    expect(ui.confirm).toMatchObject({
      title: 'Remove account1@s1.test?',
      text: 'The account will be removed from Roedy Mail. Messages and folders stay on mail.s1.test.',
      icon: 'ti-mail-off',
      ok: 'Remove',
      danger: true,
    });
    ui.confirmOk();
    expect(accounts.get('a1')).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: 'account1@s1.test removed', undo: true });
    expect(calls).toEqual([]);
    await ui.toasts.flush();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE mail-accounts/a1']);
    expect(accounts.list?.map((a) => a.id)).toEqual(['a2']);
  });

  it('turns off JMAP push before the backend removes the account', async () => {
    accounts.list = [account(), account(M2)];
    const order: string[] = [];
    const disable = vi.spyOn(mailPush, 'disable').mockImplementation((id) => {
      order.push(`disable ${id}`);
      return Promise.resolve();
    });
    const { calls } = mockApi({ 'DELETE mail-accounts/a1': [{ status: 204 }] });
    values(page()).maC.remove();
    ui.confirmOk();
    await ui.toasts.flush();
    expect(order).toEqual(['disable a1']);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE mail-accounts/a1']);
    disable.mockRestore();
  });

  it('brings the account back to its position with undo without removing it', async () => {
    accounts.list = [account(), account(M2)];
    const { calls } = mockApi({});
    values(page()).maC.remove();
    ui.confirmOk();
    ui.toasts.undo();
    expect(accounts.list?.map((a) => a.id)).toEqual(['a1', 'a2']);
    await ui.toasts.flush();
    expect(calls).toEqual([]);
  });

  it('shows the account again with an error toast if the removal fails', async () => {
    mockApi({ 'DELETE mail-accounts/a1': [{ status: 500, body: { error: 'internal' } }] });
    values(page()).maC.remove();
    ui.confirmOk();
    await ui.toasts.flush();
    expect(accounts.get('a1')).toBeDefined();
    expect(ui.toast).toMatchObject({ error: true });
  });
});

describe('edge cases', () => {
  it('closes the form when the page of another account is created before this one ends ({#key})', () => {
    accounts.list = [account({ state: 'needs_reauth' }), account(M2)];
    const p = page();
    values(p).raStart();
    expect(ml.re.account).toBe('a1');
    page('a2');
    p.dispose();
    expect(ml.re.form).toBeNull();
  });

  it('keeps counting the lock even with the form closed', () => {
    ml.re.lockUntil = NOW + 30_000;
    const p = page();
    p.watchLock(ml.re.lockUntil);
    expect(p.clock.active('rate')).toBe(true);
    vi.advanceTimersByTime(31_000);
    values(p).raStart();
    expect(values(p).ra).toMatchObject({ locked: false, btnLabel: 'Continue to sign-in', btnDis: false });
  });

  it('shows raBlocked when the current server list no longer knows the server, and reloads the accounts', async () => {
    accounts.list = [account({ state: 'needs_reauth', server_id: 's9' })];
    const { calls } = mockApi({
      // The page loads the list on opening (s9 missing), "Continue to sign-in" once more.
      'GET servers': [{ body: SERVERS }, { body: SERVERS }],
      'GET mail-accounts': [
        { body: { accounts: [account({ state: 'needs_reauth', server_id: null, blocked: true })] } },
      ],
    });
    const p = page();
    values(p).ra.submit();
    await vi.waitFor(() => expect(ml.re.form?.err).toBe('nosrv'));
    expect(values(p)).toMatchObject({ raBlocked: true, raForm: false, raIdle: false });
    // The error box "No server assigned … choose from the list" does not appear, the form has no server picker.
    expect(values(p).ra.hasErr).toBe(false);
    expect(p.form).toBeNull();
    await vi.waitFor(() => expect(accounts.get('a1')?.blocked).toBe(true));
    expect(calls.map((c) => c.path)).toContain('mail-accounts');
  });

  it('does not report 409 blocked and 404 as an error toast', () => {
    const p = page();
    for (const failure of [new ApiError(409, { error: 'blocked' }), new ApiError(404, { error: 'not_found' })]) {
      setForm({ failure });
      p.report(p.own);
      expect(ui.toast).toBeNull();
    }
  });

  it('closes after done even if the server has been locked in the meantime, without a toast', () => {
    setForm({ step: 'done', done: 'a1' });
    const p = page();
    p.arm(p.own);
    accounts.list = [account({ blocked: true })];
    p.arm(p.own);
    vi.advanceTimersByTime(RE_DONE_DELAY);
    expect(ml.re.form).toBeNull();
    expect(ui.toast).toBeNull();
  });

  it('hides the access token again after a successful sign-in', () => {
    accounts.list = [account(M2)];
    const p = page('a2');
    values(p).ra.onEye();
    setForm({ step: 'done', done: 'a2' }, account(M2));
    p.finish();
    expect(p.showToken).toBe(false);
    expect(ui.toast?.text).toBe('Signed in to mail.s2.test');
  });
});
