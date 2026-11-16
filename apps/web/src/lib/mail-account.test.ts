import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  checkErrorText,
  loadErrorText,
  loadFailureOf,
  mailAccountNavValues,
  mailAccountPath,
  mailAccountRouteOf,
  mailCheck,
  NO_ACCOUNT,
  overviewValues,
  sameMailAccountPage,
  storageNoteOf,
  storageOf,
  type MailAccountNavInput,
  type MailAccountTargets,
} from './mail-account.svelte.ts';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const GIB = 1024 ** 3;

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    username: 'account1@s1.test',
    url: 'https://mail.s1.test',
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

let targets: { [K in keyof MailAccountTargets]: ReturnType<typeof vi.fn> };

function navInput(patch: Partial<MailAccountNavInput> = {}): MailAccountNavInput {
  return {
    route: { id: 'a1', slug: 'overview' },
    isMobile: false,
    collapsed: false,
    pickerOpen: false,
    togglePicker: vi.fn(),
    closePicker: vi.fn(),
    targets: targets as unknown as MailAccountTargets,
    ...patch,
  };
}

beforeEach(() => {
  targets = { open: vi.fn(), switchTo: vi.fn(), add: vi.fn(), manage: vi.fn() };
  accounts.reset();
  accounts.list = [account(), account({ id: 'a2', email: 'maya@s2.test', host: 'mail.s2.test', color: 3 })];
});

afterEach(() => {
  vi.unstubAllGlobals();
  mailCheck.busy = null;
  mailCheck.rot = 0;
  accounts.reset();
  prefs.reset();
  ui.reset();
});

describe('mail account addresses', () => {
  it('recognizes account and subpage, but not the form of the list', () => {
    expect(mailAccountRouteOf('/account/mail-accounts/a1/overview')).toEqual({ id: 'a1', slug: 'overview' });
    expect(mailAccountRouteOf('/account/mail-accounts/a%201/connection/')).toEqual({ id: 'a 1', slug: 'connection' });
    expect(mailAccountRouteOf('/account/mail-accounts/new')).toBeNull();
    expect(mailAccountRouteOf('/account/mail-accounts')).toBeNull();
    expect(mailAccountRouteOf('/account/mail-accounts/a1/unknown')).toBeNull();
    expect(mailAccountRouteOf('/account/mail-accounts/a1/overview/more')).toBeNull();
    expect(mailAccountRouteOf('/account/mail-accounts/%E0%A4%A/overview')).toBeNull();
    expect(mailAccountPath('a 1', 'rules')).toBe('/account/mail-accounts/a%201/rules');
    expect(sameMailAccountPage('/account/mail-accounts/a2/overview', '/account/mail-accounts/a1/overview')).toBe(true);
    expect(sameMailAccountPage('/account/mail-accounts/a2/rules', '/account/mail-accounts/a1/overview')).toBe(false);
    expect(sameMailAccountPage(null, '/account/mail-accounts/a1/overview')).toBe(false);
    expect(sameMailAccountPage('/account/mail-accounts/a1/overview', '/account/mail-accounts')).toBe(false);
  });
});

describe('mail account navigation', () => {
  it('shows the subpages with the current one and opens the chosen one', () => {
    const v = mailAccountNavValues(navInput({ route: { id: 'a1', slug: 'connection' } }));
    expect(v.maNav.map((n) => [n.id, n.label, n.on])).toEqual([
      ['overview', 'Overview', false],
      ['identities', 'Identities', false],
      ['vacation', 'Vacation reply', false],
      ['connection', 'Connection', true],
      ['rules', 'Rules', false],
    ]);
    v.maNav[1]?.onClick();
    expect(targets.open).toHaveBeenCalledWith('a1', 'identities');
    expect(v.maCur).toMatchObject({ email: 'account1@s1.test', letter: 'A', kind: 'ok', st: 'Connected' });
  });

  it('names the address as tooltip only when collapsed and with the account picker closed', () => {
    expect(mailAccountNavValues(navInput()).maSwTip).toBeUndefined();
    expect(mailAccountNavValues(navInput({ collapsed: true })).maSwTip).toBe('account1@s1.test');
    expect(mailAccountNavValues(navInput({ collapsed: true, pickerOpen: true })).maSwTip).toBeUndefined();
    expect(mailAccountNavValues(navInput({ collapsed: true })).maNav[0]?.tip).toBe('Overview');
  });

  it('shows the empty tile without a known account', () => {
    accounts.list = null;
    expect(mailAccountNavValues(navInput()).maCur).toEqual(NO_ACCOUNT);
  });

  it('switches the account in the account picker and keeps the subpage', () => {
    accounts.list = [account(), account({ id: 'a2', email: 'maya@s2.test', state: 'needs_reauth', color: 3 })];
    prefs.values.defaultAccount = 'a2';
    const input = navInput({ route: { id: 'a1', slug: 'vacation' } });
    const { picker } = mailAccountNavValues(input);
    expect(picker.maSwList.map((a) => [a.email, a.checked, a.ok, a.warn, a.isDef, a.letter])).toEqual([
      ['account1@s1.test', true, true, false, false, 'A'],
      ['maya@s2.test', false, false, true, true, 'M'],
    ]);
    expect(picker.maSwList[1]?.tileBg).not.toBe(picker.maSwList[0]?.tileBg);
    picker.maSwList[1]?.onClick();
    expect(input.closePicker).toHaveBeenCalledTimes(1);
    expect(targets.switchTo).toHaveBeenCalledWith('a2', 'vacation');
    picker.maSwList[0]?.onClick();
    expect(input.closePicker).toHaveBeenCalledTimes(2);
    expect(targets.switchTo).toHaveBeenCalledTimes(1);
    picker.maSwAdd();
    picker.maSwManage();
    expect(targets.add).toHaveBeenCalledOnce();
    expect(targets.manage).toHaveBeenCalledOnce();
    expect(input.closePicker).toHaveBeenCalledTimes(4);
  });
});

describe('overview', () => {
  it('shows the storage only with a known limit', () => {
    expect(storageOf(account())).toBeNull();
    expect(storageOf(account({ quota_used: 5, quota_total: null }))).toBeNull();
    expect(storageOf(account({ quota_used: 0, quota_total: 0 }))).toBeNull();
    expect(storageOf(account({ quota_used: 2.4 * GIB, quota_total: 10 * GIB }))).toEqual({
      quota: '2.4 GB of 10 GB used',
      usedT: '2.4 GB',
      totalT: '10 GB',
      freeT: '7.6 GB free',
      pctT: '24%',
      pctN: 24,
      quotaW: '24%',
      full: false,
    });
    expect(storageOf(account({ quota_used: 9.5 * GIB, quota_total: 10 * GIB }))?.full).toBe(true);
    expect(storageOf(account({ quota_used: 12 * GIB, quota_total: 10 * GIB }))).toMatchObject({
      pctN: 100,
      freeT: '0 GB free',
    });
  });

  it('shows status, colours and default and leads to "Sign in again"', () => {
    const connection = vi.fn();
    const a = account({ state: 'needs_reauth', color: 2, last_check_at: '2026-11-03T09:00:00Z' });
    const v = overviewValues(a, { connection, now: NOW });
    expect(v).toMatchObject({
      email: 'account1@s1.test',
      st: 'Sign-in required',
      kind: 'auth',
      needsAuth: true,
      okAuth: false,
      last: 'Last checked 3 hours ago',
      checkLabel: 'Check connection',
      storage: null,
      isDefault: true,
    });
    expect(v.colors.map((c) => c.on)).toEqual([false, false, true, false, false, false]);
    expect(v.colors[0]).toMatchObject({ name: 'apricot', base: '#f5a06e', ink: '#3a1b06' });
    v.goCon();
    expect(connection).toHaveBeenCalledWith('a1');
  });

  it('shows a locked server with notice, "Go to connection" and the state of the last check', () => {
    const v = overviewValues(
      account({
        blocked: true,
        state: 'needs_reauth',
        last_check_at: '2026-11-03T09:00:00Z',
        quota_used: 1,
        quota_total: 2,
      }),
      { connection: vi.fn(), now: NOW },
    );
    expect(v).toMatchObject({
      kind: 'blocked',
      st: 'Server blocked',
      stSub: 'mail.s1.test is no longer an approved server.',
      blocked: true,
      reauth: false,
      okAuth: false,
      asOf: 'Last checked 3 hours ago',
    });
    expect(storageNoteOf(account({ blocked: true }), false)?.text).toBe(
      'Storage usage can’t be read while mail.s1.test is blocked.',
    );
    expect(overviewValues(account({ blocked: true }), { connection: vi.fn() }).asOf).toBe('');
    expect(overviewValues(account(), { connection: vi.fn() })).toMatchObject({
      blocked: false,
      okAuth: true,
      asOf: '',
    });
  });

  it('sets the default account with undo', () => {
    const second = accounts.get('a2');
    if (!second) throw new Error('account missing');
    const v = overviewValues(second, { connection: vi.fn() });
    expect(v.isDefault).toBe(false);
    v.makeDefault();
    expect(prefs.values.defaultAccount).toBe('a2');
    expect(ui.toast?.text).toBe('maya@s2.test is now the default account');
    expect(overviewValues(second, { connection: vi.fn() }).isDefault).toBe(true);
    ui.toasts.undo();
    expect(prefs.values.defaultAccount).toBeNull();
  });

  it('saves the colour and reports a failure', async () => {
    const { calls } = mockApi({
      'PATCH mail-accounts/a1': [{ body: account({ color: 4 }) }, { status: 500, body: { error: 'internal' } }],
    });
    const first = accounts.get('a1');
    if (!first) throw new Error('account missing');
    overviewValues(first, { connection: vi.fn() }).colors[4]?.onClick();
    expect(accounts.get('a1')?.color).toBe(4);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const after = accounts.get('a1');
    if (!after) throw new Error('account missing');
    overviewValues(after, { connection: vi.fn() }).colors[1]?.onClick();
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(ui.toast?.text).toBe('That didn’t work. Please try again.');
    expect(accounts.get('a1')?.color).toBe(4);
  });
});

describe('check connection', () => {
  it('checks one at a time, turns the icon and reports success', async () => {
    let answer: (value: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'POST mail-accounts/a1/check': [() => new Promise((resolve) => (answer = resolve))],
    });
    const first = accounts.get('a1');
    if (!first) throw new Error('account missing');
    const v = overviewValues(first, { connection: vi.fn() });
    v.check();
    v.check();
    expect(mailCheck.busy).toBe('a1');
    expect(mailCheck.rot).toBe(720);
    const busy = overviewValues(first, { connection: vi.fn() });
    expect(busy).toMatchObject({
      busy: true,
      kind: 'busy',
      st: 'Checking …',
      checkLabel: 'Checking',
      rot: 720,
    });
    answer({ body: account({ quota_used: GIB, quota_total: 2 * GIB, last_check_at: '2026-11-03T12:00:00Z' }) });
    await vi.waitFor(() => expect(mailCheck.busy).toBeNull());
    expect(calls).toHaveLength(1);
    expect(ui.toast?.text).toBe('Connection to mail.s1.test is OK');
    expect(accounts.get('a1')?.quota_total).toBe(2 * GIB);
  });

  it('maps the errors to the toasts', async () => {
    mockApi({
      'POST mail-accounts/a1/check': [
        { status: 409, body: { error: 'needs_reauth' } },
        { status: 502, body: { error: 'check_failed', reason: 'unreachable' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 30 } },
      ],
    });
    await mailCheck.run('a1');
    expect(ui.toast).toMatchObject({ text: 'Sign-in to mail.s1.test required', error: true });
    expect(accounts.get('a1')?.state).toBe('needs_reauth');
    await mailCheck.run('a1');
    expect(ui.toast).toMatchObject({
      text: 'mail.s1.test is unreachable. Try again later.',
      error: true,
    });
    await mailCheck.run('a1');
    expect(ui.toast).toMatchObject({ text: 'Too many requests. Try again in 30 seconds.', error: true });
    expect(mailCheck.busy).toBeNull();
  });

  it('names the reason of the mail server or of the broker', () => {
    const fail = (status: number, body: Record<string, unknown>) => checkErrorText(new ApiError(status, body), 'h');
    expect(fail(502, { error: 'check_failed', reason: 'throttled' })).toBe(
      'Too many requests to h. Try again in a moment.',
    );
    expect(fail(502, { error: 'check_failed', reason: 'auth_failed' })).toBe('h rejected the sign-in. Sign in again.');
    expect(fail(502, { error: 'check_failed', reason: 'forbidden' })).toBe('h denies access to this account.');
    expect(fail(502, { error: 'refresh_failed', reason: 'unreachable' })).toBe('h is unreachable. Try again later.');
    expect(fail(502, { error: 'check_failed', reason: 'invalid_response' })).toBe(
      'Couldn’t check the connection to h.',
    );
    expect(fail(409, { error: 'blocked' })).toBe('h is no longer an approved server.');
    expect(fail(500, { error: 'internal' })).toBe('Couldn’t check the connection to h.');
  });

  it('checks on opening only a never-checked, connected account and without a toast', async () => {
    const { calls } = mockApi({
      'POST mail-accounts/a1/check': [{ body: account({ last_check_at: '2026-11-03T12:00:00Z' }) }],
    });
    accounts.list = [
      account(),
      account({ id: 'a2', state: 'needs_reauth' }),
      account({ id: 'a3', blocked: true }),
      account({ id: 'a4', last_check_at: '2026-11-03T11:00:00Z' }),
    ];
    for (const id of ['a2', 'a3', 'a4', 'missing']) mailCheck.auto(id);
    expect(calls).toHaveLength(0);
    mailCheck.auto('a1');
    await vi.waitFor(() => expect(mailCheck.busy).toBeNull());
    expect(calls).toHaveLength(1);
    expect(ui.toast).toBeNull();
  });

  it('shows "No limit", "Checking …" or "Not checked yet" without storage values', () => {
    expect(storageNoteOf(account({ quota_used: 1, quota_total: 2 }), false)).toBeNull();
    expect(storageNoteOf(account({ last_check_at: '2026-11-03T11:00:00Z' }), false)).toEqual({
      noLimit: true,
      busy: false,
      title: 'No limit',
      text: 'mail.s1.test reports no storage limit for this account.',
    });
    expect(storageNoteOf(account(), true)).toMatchObject({
      busy: true,
      title: 'Checking …',
      text: 'Reading storage usage from mail.s1.test.',
    });
    expect(storageNoteOf(account(), false)).toMatchObject({
      title: 'Not checked yet',
      text: '“Check connection” reads storage usage from mail.s1.test.',
    });
    expect(storageNoteOf(account({ state: 'needs_reauth' }), false)?.text).toBe(
      'Storage usage will be read from mail.s1.test after you sign in again.',
    );
  });

  it('reports a missing connection and reloads the list after a removed account', async () => {
    const { calls } = mockApi({
      'POST mail-accounts/a1/check': [{ status: 404, body: { error: 'not_found' } }],
      'GET mail-accounts': [{ body: { accounts: [] } }],
    });
    await mailCheck.run('a1');
    await vi.waitFor(() => expect(accounts.list).toEqual([]));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST mail-accounts/a1/check', 'GET mail-accounts']);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    accounts.list = [account()];
    await mailCheck.run('a1');
    expect(ui.toast?.text).toBe('No connection. Please try again.');
    expect(ui.toast?.error).toBe(true);
    // Unknown account: nothing.
    ui.toast = null;
    await mailCheck.run('missing');
    expect(ui.toast).toBeNull();
  });
});

describe('loadErrorText', () => {
  it('names reasons of the broker like the check, otherwise the generic text', () => {
    expect(loadErrorText(new ApiError(409, { error: 'blocked' }), 'h')).toBe('h is no longer an approved server.');
    expect(loadErrorText(new ApiError(500, {}), 'h')).toBe('That didn’t work. Please try again.');
    expect(loadErrorText(new Error('jmap'), 'h')).toBe('That didn’t work. Please try again.');
  });
});

describe('loadFailureOf', () => {
  it('chooses the buttons of the card by reason', () => {
    const of = (status: number, body: Record<string, unknown>) => loadFailureOf(new ApiError(status, body), 'h');
    const buttons = ({ retry, reauth, con }: { retry: boolean; reauth: boolean; con: boolean }) => ({
      retry,
      reauth,
      con,
    });
    expect(buttons(of(409, { error: 'blocked' }))).toEqual({ retry: false, reauth: false, con: true });
    expect(buttons(of(409, { error: 'needs_reauth' }))).toEqual({ retry: false, reauth: true, con: false });
    expect(buttons(of(502, { error: 'refresh_failed', reason: 'auth_failed' }))).toEqual({
      retry: true,
      reauth: true,
      con: false,
    });
    for (const reason of ['unreachable', 'throttled', 'forbidden']) {
      expect(buttons(of(502, { error: 'check_failed', reason }))).toEqual({ retry: true, reauth: false, con: false });
    }
    expect(of(429, { error: 'rate_limited', retry_after: 30 })).toEqual({
      text: 'Too many requests. Try again in 30 seconds.',
      retry: true,
      reauth: false,
      con: false,
    });
    expect(loadFailureOf(new Error('jmap'), 'h')).toEqual({
      text: 'That didn’t work. Please try again.',
      retry: true,
      reauth: false,
      con: false,
    });
  });
});
