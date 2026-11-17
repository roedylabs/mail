import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '#lib/api.ts';
import { MailLogin, type FlowState } from '#lib/auth/mail-login.svelte.ts';
import { FORM0, type MailServer, type ServerList } from '#lib/auth/stalwart-login.ts';
import { mailCheck } from '#lib/mail-account.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  DONE_DELAY,
  loginErrorText,
  MailAccountsPage,
  mailAccountsValues,
  type MailAccountsNav,
} from './mail-accounts.svelte.ts';

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
const VPS2: MailServer = {
  ...VPS1,
  id: 's2',
  label: 'VPS 2',
  url: 'https://mail.s2.test',
  host: 'mail.s2.test',
  domains: [],
};
const SERVERS: ServerList = { servers: [VPS1, VPS2], allow_custom_servers: true };

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

const STATUS0 = {
  step: 'cred',
  busy: false,
  err: null,
  as: '',
  sErr: '',
  rl: false,
  dupId: null,
  failure: null,
  done: null,
} as const;

let nav: { [K in keyof MailAccountsNav]: ReturnType<typeof vi.fn> };
let ml: MailLogin;

function page(adding = true): MailAccountsPage {
  return new MailAccountsPage(nav as unknown as MailAccountsNav, adding, ml);
}

/** Form with details and state as `mailLogin.add` sets it. */
function setForm(patch: Partial<FlowState> = {}): void {
  ml.add.form = { ...FORM0, ...STATUS0, email: 'alex@s1.test', ...patch };
}

function af(p: MailAccountsPage, isMobile = false) {
  const v = mailAccountsValues(p, { isMobile, now: NOW }).af;
  if (!v) throw new Error('form closed');
  return v;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
  nav = { add: vi.fn(), list: vi.fn(), account: vi.fn(), servers: vi.fn() };
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
  accounts.list = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  session.config = null;
  session.user = null;
  accounts.reset();
  prefs.reset();
  ui.reset();
});

describe('list of accounts', () => {
  it('shows address, server, status and the default account', () => {
    accounts.list = [
      account(),
      account({ id: 'a2', email: 'maya@s2.test', host: 'mail.s2.test', color: 1, state: 'needs_reauth' }),
    ];
    const v = mailAccountsValues(page(false), { isMobile: false, now: NOW });
    expect(v.maEmpty).toBe(false);
    expect(v.maList.map((a) => [a.email, a.sub, a.st, a.needsAuth, a.isDefault, a.last])).toEqual([
      ['account1@s1.test', 'mail.s1.test', 'Connected', false, true, 'Not checked yet'],
      ['maya@s2.test', 'mail.s2.test', 'Sign-in required', true, false, 'Not checked yet'],
    ]);
    expect(v.maList[1]?.chip).not.toBe(v.maList[0]?.chip);
    prefs.values.defaultAccount = 'a2';
    expect(mailAccountsValues(page(false), { isMobile: false }).maList.map((a) => a.isDefault)).toEqual([false, true]);
    v.maList[0]?.openAcct();
    expect(nav.account).toHaveBeenCalledWith('a1');
  });

  it('leads to the overview also with "Sign-in required" and a locked server', () => {
    accounts.list = [account({ state: 'needs_reauth' }), account({ id: 'a2', blocked: true })];
    const [auth, blocked] = mailAccountsValues(page(false), { isMobile: false }).maList;
    auth?.openAcct();
    blocked?.openAcct();
    expect(nav.account.mock.calls).toEqual([['a1'], ['a2']]);
  });

  it('shows "Checking …" while "Check connection" runs, and "Server blocked"', () => {
    accounts.list = [account(), account({ id: 'a2', state: 'needs_reauth' }), account({ id: 'a3', blocked: true })];
    mailCheck.busy = 'a1';
    try {
      const rows = mailAccountsValues(page(false), { isMobile: false }).maList;
      expect(rows.map((a) => [a.kind, a.st])).toEqual([
        ['busy', 'Checking …'],
        ['auth', 'Sign-in required'],
        ['blocked', 'Server blocked'],
      ]);
    } finally {
      mailCheck.busy = null;
    }
  });

  it('names storage and last check as soon as they are known', () => {
    accounts.list = [
      account({ quota_used: 2.4 * 1024 ** 3, quota_total: 10 * 1024 ** 3, last_check_at: '2026-10-28T11:58:00Z' }),
      account({ id: 'a2', state: 'needs_reauth', last_check_at: '2026-10-28T09:00:00Z' }),
    ];
    const [ok, auth] = mailAccountsValues(page(false), { isMobile: false, now: NOW }).maList;
    expect(ok?.sub).toBe('mail.s1.test · 2.4 GB of 10 GB');
    expect(ok?.last).toBe('Checked 2 min ago');
    expect(auth?.last).toBe('Last checked 3 hours ago');
  });

  it('reports "No email account connected yet" only once the list is known', () => {
    expect(mailAccountsValues(page(false), { isMobile: false }).maEmpty).toBe(true);
    accounts.list = null;
    expect(mailAccountsValues(page(false), { isMobile: false }).maEmpty).toBe(false);
  });

  it('shows no form on the list and leads to /new with "Add email account"', () => {
    setForm();
    const p = page(false);
    p.start();
    const v = mailAccountsValues(p, { isMobile: false });
    expect([v.afOpen, v.afClosed, v.af]).toEqual([false, true, null]);
    v.afStart();
    expect(nav.add).toHaveBeenCalledOnce();
    p.dispose();
    expect(ml.add.form).not.toBeNull();
  });
});

describe('new mail account', () => {
  it('opens an empty form on /new and keeps a step of the return', () => {
    const p = page();
    p.start();
    expect(mailAccountsValues(p, { isMobile: false })).toMatchObject({ afOpen: true, afClosed: false });
    expect(af(p)).toMatchObject({ isCred: true, email: '', isPw: true, btnDis: true, hot: false });
    setForm({ step: 'ret' });
    p.start();
    expect(ml.add.form?.step).toBe('ret');
  });

  it('names the sign-in page of the assigned server for "Password"', () => {
    setForm();
    expect(af(page())).toMatchObject({
      isPw: true,
      isTok: false,
      pwHint:
        'You’ll enter your password or app password, plus the code from your authenticator app if you’ve set one up, on the sign-in page of mail.s1.test.',
      btnLabel: 'Continue to sign-in',
      btnIcon: 'ti-login-2',
      btnDis: false,
      hot: true,
      hint: 'Server: mail.s1.test',
      hintOk: true,
      hintWarn: false,
    });
  });

  it('warns if no server is allowed for the domain', () => {
    setForm({ email: 'alex@unknown.example' });
    expect(af(page())).toMatchObject({
      pwHint:
        'You’ll enter your password or app password, plus the code from your authenticator app if you’ve set one up, on your mail server’s sign-in page.',
      hintWarn: true,
      hintOk: false,
      hint: 'No server is approved for unknown.example. Choose one from the list.',
    });
    // No warning yet without a loaded server list.
    ml.servers = null;
    expect(af(page())).toMatchObject({ hint: '', hasHint: false });
  });

  it('requires an access token for "Token" and shows it on request', () => {
    setForm({ auth: 'token' });
    const p = page();
    expect(af(p)).toMatchObject({
      isTok: true,
      isPw: false,
      btnLabel: 'Connect',
      btnIcon: 'ti-plug-connected',
      btnDis: true,
    });
    expect(af(p)).toMatchObject({ secType: 'password', eyeIcon: 'ti-eye', eyeTip: 'Show' });
    af(p).onEye();
    expect(af(p)).toMatchObject({ secType: 'text', eyeIcon: 'ti-eye-off', eyeTip: 'Hide' });
    af(p).onSec('secret');
    expect(af(p)).toMatchObject({ sec: 'secret', btnDis: false });
    af(p).authOpts[0]?.onClick();
    expect(af(p).authOpts.map((o) => [o.label, o.on])).toEqual([
      ['Password', true],
      ['Token', false],
    ]);
  });

  it('shows the loading state before the redirect and while checking the token', () => {
    setForm({ busy: true });
    expect(af(page())).toMatchObject({
      isCred: true,
      busy: true,
      busyText: 'Opening the sign-in page of mail.s1.test …',
      btnLabel: 'Opening …',
      btnIcon: 'ti-loader-2',
      btnSpin: true,
      btnDis: true,
      hot: true,
    });
    setForm({ busy: true, auth: 'token', token: 'x' });
    expect(af(page())).toMatchObject({
      busyText: 'Checking access token …',
      btnLabel: 'Connecting …',
    });
    setForm({ busy: true, email: 'alex@unknown.example' });
    expect(af(page()).busyText).toBe('Opening the sign-in page of the server …');
  });

  it('shows the "finishing" step after the return', () => {
    setForm({ step: 'ret', srv: 's1' });
    expect(af(page())).toMatchObject({
      isRet: true,
      isCred: false,
      busy: false,
      retTitle: 'Finishing sign-in to mail.s1.test …',
      retText: 'Roedy Mail is setting up the account.',
    });
  });

  it('leads to the account overview after done and reports the address', () => {
    setForm({ step: 'done', done: 'a9', as: 'alex@s1.test' });
    const p = page();
    expect(af(p)).toMatchObject({
      isDone: true,
      notDone: false,
      doneTitle: 'alex@s1.test is connected',
      doneText: 'Taking you to the account overview …',
    });
    p.arm(p.form);
    p.arm(p.form);
    vi.advanceTimersByTime(DONE_DELAY - 1);
    expect(nav.account).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(nav.account).toHaveBeenCalledExactlyOnceWith('a9');
    expect(ml.add.form).toBeNull();
    expect(ui.toast?.text).toBe('alex@s1.test connected');
  });

  it('opens the account immediately with "Open now"', () => {
    setForm({ step: 'done', done: 'a9', as: 'info@s1.test' });
    const p = page();
    p.arm(p.form);
    af(p).doneGo();
    expect(nav.account).toHaveBeenCalledExactlyOnceWith('a9');
    expect(ui.toast?.text).toBe('info@s1.test connected');
    p.arm(p.form);
    vi.advanceTimersByTime(DONE_DELAY);
    expect(nav.account).toHaveBeenCalledOnce();
  });

  it('sends with Enter and cancels with Escape or "Cancel"', () => {
    mockApi({ 'GET servers': [{ body: SERVERS }] });
    setForm();
    const p = page();
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    af(p).key(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(ml.add.form?.busy).toBe(true);
    const escape = { key: 'Escape', preventDefault: vi.fn() };
    af(p).key(escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(ml.add.form).toBeNull();
    expect(nav.list).toHaveBeenCalledOnce();
    setForm();
    af(p).cancel();
    expect(ml.add.form).toBeNull();
    expect(nav.list).toHaveBeenCalledTimes(2);
  });

  it('closes the form when leaving the page', () => {
    setForm();
    const p = page();
    p.start();
    p.dispose();
    expect(ml.add.form).toBeNull();
  });
});

describe('errors', () => {
  it('shows errors before the redirect', () => {
    const cases: [Partial<FlowState>, string, string, string][] = [
      [{ err: 'email' }, 'ti-at', 'Check email address', 'Please enter a valid email address.'],
      [
        { err: 'nosrv', email: 'alex@unknown.example' },
        'ti-server-off',
        'No server assigned',
        'No server is approved for unknown.example. Choose a server from the list.',
      ],
      [
        { err: 'nosrv', email: 'max' },
        'ti-server-off',
        'No server assigned',
        'No server is approved for this domain. Choose a server from the list.',
      ],
      [
        { err: 'url', srv: 'other', url: 'http://mail.example.org' },
        'ti-link-off',
        'Check server address',
        'The address must start with https://, e.g. https://mail.example.com.',
      ],
      [{ err: 'sec', auth: 'token' }, 'ti-key', 'Access token missing', 'Please enter an access token.'],
      [
        { err: 'tok', auth: 'token' },
        'ti-lock-x',
        'Invalid access token',
        'mail.s1.test rejected the access token. Check it or create a new one.',
      ],
      [
        { err: 'reach' },
        'ti-plug-connected-x',
        'Server unreachable',
        'mail.s1.test isn’t responding. Check your internet connection or try again later.',
      ],
      [
        { err: 'oauth', srv: 'other', url: 'https://mail.own.example/' },
        'ti-key-off',
        'OAuth client not registered',
        'No OAuth client is set up for mail.own.example yet. Ask your administrator to register it under Administration › Mail servers.',
      ],
    ];
    for (const [patch, icon, title, text] of cases) {
      setForm(patch);
      expect(af(page())).toMatchObject({
        isCred: true,
        hasErr: true,
        eIcon: icon,
        eTitle: title,
        eText: text,
        eHasAct: false,
        eHasCode: false,
      });
    }
  });

  it('shows errors after the return with the details from before the redirect', () => {
    setForm({ err: 'expired', srv: 's1' });
    expect(af(page())).toMatchObject({
      isCred: true,
      eIcon: 'ti-clock-x',
      eTitle: 'Sign-in expired',
      eText: 'The sign-in was canceled or has expired. Please start again.',
      email: 'alex@s1.test',
      isPw: true,
      btnLabel: 'Continue to sign-in',
    });
    expect(af(page()).sel.label).toBe('VPS 1');
    setForm({ err: 'denied', sErr: 'server_error' });
    expect(af(page())).toMatchObject({
      eIcon: 'ti-circle-x',
      eTitle: 'Sign-in not completed',
      eText:
        'mail.s1.test didn’t complete the sign-in. Try again. If the problem persists, contact your administrator.',
      eHasCode: true,
      eCode: 'server_error',
    });
    setForm({ err: 'iss' });
    expect(af(page())).toMatchObject({
      eIcon: 'ti-shield-x',
      eTitle: 'Response from a different server',
      eText:
        'The sign-in response didn’t come from mail.s1.test and was discarded for security reasons. Please start again.',
      eHasCode: false,
    });
  });

  it('shows "Sign-in expired" without a known attempt in the empty form', () => {
    ml.add.expire();
    expect(af(page())).toMatchObject({ eTitle: 'Sign-in expired', email: '' });
    expect(af(page()).sel.label).toBe('Automatic');
  });

  it('opens the existing account on "Account already connected"', () => {
    setForm({ err: 'dup', as: 'account1@s1.test', dupId: 'a1' });
    const p = page();
    expect(af(p)).toMatchObject({
      eIcon: 'ti-mail-check',
      eTitle: 'Account already connected',
      eText: 'account1@s1.test is already connected to Roedy Mail.',
      eHasAct: true,
      eAct: 'Open account',
    });
    af(p).eFn?.();
    expect(ml.add.form).toBeNull();
    expect(nav.account).toHaveBeenCalledWith('a1');
  });

  it('offers "Check mail servers" for CORS and OAuth only to the administration', () => {
    setForm({ err: 'cors' });
    expect(af(page())).toMatchObject({
      eIcon: 'ti-world-off',
      eTitle: 'CORS not enabled',
      eText:
        'mail.s1.test doesn’t allow requests directly from the browser. Your administrator needs to turn on “Permissive CORS” in Stalwart.',
      eHasAct: false,
      eAct: '',
    });
    session.user = { ...ME, role: 'admin' };
    const p = page();
    expect(af(p)).toMatchObject({ eHasAct: true, eAct: 'Check mail servers' });
    af(p).eFn?.();
    expect(nav.servers).toHaveBeenCalledOnce();
    setForm({ err: 'oauth' });
    expect(af(p)).toMatchObject({ eHasAct: true, eAct: 'Check mail servers' });
  });

  it('names the signed-in address for another account', () => {
    setForm({ err: 'other', as: 'info@s1.test' });
    expect(af(page())).toMatchObject({
      eIcon: 'ti-user-x',
      eTitle: 'Different account signed in',
      eText: 'You signed in to mail.s1.test as info@s1.test. Sign in as alex@s1.test.',
    });
  });

  it('locks after "Too many attempts" with a waiting time until its end', () => {
    setForm({ err: 'rate', rl: true });
    ml.add.lockUntil = NOW + 30_000;
    const p = page();
    p.watchLock(ml.add.lockUntil);
    expect(af(p)).toMatchObject({
      hasErr: true,
      eIcon: 'ti-hourglass',
      eTitle: 'Too many attempts',
      eText: 'mail.s1.test isn’t accepting sign-ins right now. Try again in 30 seconds.',
      btnLabel: 'Try again in 0:30',
      btnIcon: 'ti-lock',
      locked: true,
      btnDis: true,
    });
    vi.advanceTimersByTime(29_000);
    expect(af(p).btnLabel).toBe('Try again in 0:01');
    vi.advanceTimersByTime(1_000);
    expect(af(p)).toMatchObject({ hasErr: false, locked: false, btnLabel: 'Continue to sign-in', btnDis: false });
  });

  it('asks to wait a moment without a readable waiting time', () => {
    setForm({ err: 'rate' });
    expect(af(page())).toMatchObject({
      hasErr: true,
      eText: 'mail.s1.test isn’t accepting sign-ins right now. Wait a moment, then try again.',
      locked: false,
      btnLabel: 'Continue to sign-in',
    });
  });

  it('shows "The server" without an assigned server', () => {
    setForm({ err: 'reach', srv: 's9' });
    expect(af(page())).toMatchObject({
      eIcon: 'ti-plug-connected-x',
      eTitle: 'Server unreachable',
      eText: 'The server isn’t responding. Check your internet connection or try again later.',
      sel: { label: 'No server assigned' },
    });
  });

  it('shows "The server" also while the server list is still missing after the return', () => {
    ml.servers = null;
    setForm({ err: 'reach', srv: 's1' });
    expect(af(page()).eText).toBe('The server isn’t responding. Check your internet connection or try again later.');
  });

  it('uses the substitute by position without an assigned server', () => {
    const cases: [Partial<FlowState>, string][] = [
      [{ err: 'tok', auth: 'token' }, 'The server rejected the access token. Check it or create a new one.'],
      [
        { err: 'cors' },
        'The server doesn’t allow requests directly from the browser. Your administrator needs to turn on “Permissive CORS” in Stalwart.',
      ],
      [
        { err: 'oauth' },
        'No OAuth client is set up for the server yet. Ask your administrator to register it under Administration › Mail servers.',
      ],
      [
        { err: 'denied' },
        'The server didn’t complete the sign-in. Try again. If the problem persists, contact your administrator.',
      ],
      [{ err: 'rate' }, 'The server isn’t accepting sign-ins right now. Wait a moment, then try again.'],
      [
        { err: 'iss' },
        'The sign-in response didn’t come from the server and was discarded for security reasons. Please start again.',
      ],
      [{ err: 'other', as: 'info@s1.test' }, 'You signed in to the server as info@s1.test. Sign in as alex@s1.test.'],
    ];
    for (const [patch, text] of cases) {
      setForm({ srv: 's9', ...patch });
      expect(af(page()).eText).toBe(text);
    }
    const input = { host: '', domain: 's1.test', as: '', email: 'alex@s1.test', wait: 30 };
    expect(loginErrorText('rate', input).text).toBe(
      'The server isn’t accepting sign-ins right now. Try again in 30 seconds.',
    );
  });

  it('reports errors without a key of their own once as an error toast', () => {
    const p = page();
    setForm({ failure: new ApiError(500, { error: 'internal' }) });
    const toast = () => ui.toast;
    p.report(p.form);
    expect(toast()).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    ui.toast = null;
    p.report(p.form);
    expect(toast()).toBeNull();
    setForm({ failure: new NetworkError(new TypeError('Failed to fetch')) });
    p.report(p.form);
    expect(toast()?.text).toMatch(/^No connection/);
    expect(af(p).hasErr).toBe(false);
  });

  it('reloads the account instead of a toast without a session', async () => {
    const { calls } = mockApi({ 'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }] });
    const p = page();
    setForm({ failure: new ApiError(401, { error: 'unauthorized' }) });
    p.report(p.form);
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toEqual(['auth/me']));
    expect(ui.toast).toBeNull();
  });
});

describe('server picker', () => {
  it('offers automatic, the servers of the list and an own server', () => {
    setForm();
    const sel = af(page()).sel;
    expect(sel.title).toBe('Server');
    expect(sel.label).toBe('Automatic');
    expect(sel.opts.map((o) => [o.label, o.sub, o.on, o.fw])).toEqual([
      ['Automatic', 'Server: mail.s1.test', true, 800],
      ['VPS 1', 'mail.s1.test', false, 600],
      ['VPS 2', 'mail.s2.test', false, 600],
      ['Other server …', 'Enter the address yourself', false, 600],
    ]);
    ml.servers = { ...SERVERS, allow_custom_servers: false };
    setForm({ email: 'alex@unknown.example' });
    expect(af(page()).sel.opts.map((o) => o.sub)).toEqual([
      'No server for unknown.example',
      'mail.s1.test',
      'mail.s2.test',
    ]);
    setForm({ email: '' });
    expect(af(page()).sel.opts[0]?.sub).toBe('Based on the email address’s domain');
  });

  it('chooses by click, closes the list and shows the field for "Other server"', () => {
    setForm({ err: 'nosrv' });
    const p = page();
    af(p).sel.toggle();
    expect(ui.menu).toBe('pick');
    expect(af(p).sel.open).toBe(true);
    expect(af(p, true).sel.open).toBe(false);
    af(p).sel.opts[3]?.onClick();
    expect(ui.menu).toBeNull();
    expect(af(p)).toMatchObject({ isOther: true, hasErr: false, url: '' });
    expect(af(p).sel.label).toBe('Other server …');
    af(p).onUrl('https://mail.own.example');
    expect(af(p).pwHint).toContain('sign-in page of mail.own.example');
  });

  it('is operated with arrow keys, Enter and space', () => {
    setForm();
    const p = page();
    const key = (k: string) => ({ key: k, preventDefault: vi.fn() });
    af(p).sel.onKey(key('ArrowDown'));
    expect(ui.menu).toBe('pick');
    expect(af(p).sel.opts.map((o) => o.hi)).toEqual([true, false, false, false]);
    af(p).sel.onKey(key('ArrowDown'));
    af(p).sel.onKey(key('Enter'));
    expect(ml.add.form?.srv).toBe('s1');
    expect(ui.menu).toBeNull();
    af(p).sel.onKey(key('ArrowUp'));
    af(p).sel.onKey(key('ArrowUp'));
    af(p).sel.onKey(key(' '));
    expect(ml.add.form?.srv).toBe('s1');
    af(p).sel.onKeyUp(key(' '));
    expect(ml.add.form?.srv).toBe('auto');
    af(p).sel.opts[2]?.hover();
    expect(p.srvHi).toBe(2);
  });

  it('is disabled while a step is running', () => {
    setForm({ busy: true });
    const p = page();
    expect(af(p).sel.disabled).toBe(true);
    af(p).sel.toggle();
    af(p).sel.onKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(ui.menu).toBeNull();
  });
});

describe('edge cases', () => {
  it('keeps the form when the page is recreated on switching desktop ↔ mobile', () => {
    const before = page();
    before.start();
    af(before).onEmail('alex@s1.test');
    const after = page();
    after.start();
    before.dispose();
    expect(ml.add.form?.email).toBe('alex@s1.test');
    after.dispose();
    expect(ml.add.form).toBeNull();
  });

  it('reports a generic error only once even after the rebuild', () => {
    setForm({ failure: new ApiError(500, { error: 'internal' }) });
    page().report(ml.add.form);
    ui.toast = null;
    page().report(ml.add.form);
    expect(ui.toast).toBeNull();
  });

  it('opens the form on /new with "Add email account" instead of going to the same address', () => {
    const p = page();
    expect(mailAccountsValues(p, { isMobile: false }).afClosed).toBe(true);
    mailAccountsValues(p, { isMobile: false }).afStart();
    expect(nav.add).not.toHaveBeenCalled();
    expect(ml.add.form).not.toBeNull();
  });

  it('loads server list and lock clock only with a form', () => {
    const { calls } = mockApi({ 'GET servers': [{ body: SERVERS }] });
    const list = page(false);
    list.load();
    list.watchLock(NOW + 30_000);
    expect(calls).toEqual([]);
    expect(list.clock.active('rate')).toBe(false);
  });

  it('does not show small mailboxes as "0 GB"', () => {
    accounts.list = [account({ quota_used: 30 * 1024 ** 2, quota_total: 10 * 1024 ** 3 })];
    expect(mailAccountsValues(page(false), { isMobile: false }).maList[0]?.sub).toBe('mail.s1.test · 0.03 GB of 10 GB');
  });

  it('names a server that no longer exists "No server assigned"', () => {
    setForm({ srv: 's9' });
    expect(af(page()).sel.label).toBe('No server assigned');
    ml.servers = null;
    expect(af(page()).sel.label).toBe('');
  });
});
