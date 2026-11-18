import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { forgetAccount } from '#lib/state/account.ts';
import {
  keptSecurity,
  SecurityPage,
  securityValues,
  type ListedSession,
  type MfaOverview,
  type SecurityValues,
} from './security.svelte.ts';

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
  role: 'user',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: minutesAgo(94 * 24 * 60),
  email_change: { email: 'new@example.com', expires_at: minutesAgo(-60) },
};

const NO_MFA: MfaOverview = { devices: [], recovery: null };
const IPHONE = { id: 't1', name: 'iPhone', created_at: '2026-10-01T09:00:00Z', last_used_at: minutesAgo(120) };
const LAPTOP = { id: 't2', name: 'Authenticator app 2', created_at: '2026-10-20T09:00:00Z', last_used_at: null };
const MFA: MfaOverview = {
  devices: [IPHONE, LAPTOP],
  recovery: { total: 10, unused: 8, created_at: minutesAgo(3 * 24 * 60) },
};
const CODES = [
  'ABCD-EFGH',
  'JKLM-NPQR',
  'STUV-WXYZ',
  '2345-6789',
  'AB23-CD45',
  'EF67-GH89',
  'JK23-LM45',
  'NP67-QR89',
  'ST23-UV45',
  'WX67-YZ89',
];

const session0 = (id: string, extra: Partial<ListedSession> = {}): ListedSession => ({
  id,
  current: false,
  device: 'Firefox on Linux',
  device_type: 'desktop',
  app: null,
  place: null,
  ip: null,
  created_at: minutesAgo(600),
  last_seen_at: minutesAgo(600),
  ...extra,
});
const SESSIONS = [
  session0('s0', { current: true, place: 'Berlin, Germany', last_seen_at: minutesAgo(0) }),
  session0('s1', {
    device: 'Safari on iPhone',
    device_type: 'mobile',
    place: 'Hamburg, Germany',
    last_seen_at: minutesAgo(120),
  }),
  session0('s2', { device: 'Chrome on iPad', device_type: 'tablet', ip: '203.0.113.0' }),
];

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
  keptSecurity.forget();
});

async function loaded(routes: Parameters<typeof mockApi>[0] = {}, mfa = MFA, sessions = SESSIONS) {
  const api = mockApi({
    'GET auth/totp/devices': [{ body: mfa }, { body: mfa }],
    'GET auth/sessions': [{ body: { sessions } }, { body: { sessions } }],
    ...routes,
  });
  const p = new SecurityPage();
  await p.load();
  return { p, v: () => securityValues(p, ctx, NOW), ...api };
}

const key = (k: string) => ({ key: k, preventDefault: vi.fn() });
const sent = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.map((c) => ({ call: `${c.method} ${c.path}`, body: c.body }));
const field = (v: SecurityValues, ac: string, n = 0) => {
  const found = v.pwFields.filter((f) => f.ac === ac)[n];
  if (!found) throw new Error(`no field ${ac}`);
  return found;
};

describe('Loading', () => {
  it('shows password, apps, codes and devices', async () => {
    const { v } = await loaded();
    const values = v();
    expect(values.secTabs.map((t) => t.label)).toEqual(['Password', 'Multi-factor', 'Devices']);
    values.secTabs[1]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('2fa');
    expect([values.secSso, values.secNotSso]).toEqual([false, true]);
    expect(values.pwDesc).toBe('Last changed 94 days ago');
    expect(values.pwFields.map((f) => [f.label, f.desc, f.ac, f.sep, f.hasEye])).toEqual([
      ['Current password', 'To confirm it’s you', 'current-password', false, true],
      ['Verification code', 'From your authenticator app', 'one-time-code', true, false],
      [
        'New password',
        'At least 10 characters with upper- and lowercase letters and a number or special character',
        'new-password',
        true,
        true,
      ],
      ['Confirm new password', 'Enter it again to make sure', 'new-password', true, false],
    ]);
    expect(values.tfaEntries.map((e) => [e.name, e.sub, e.sep, e.delLabel])).toEqual([
      ['iPhone', 'Added on 01.10.2026 · Last used 2 hours ago', false, 'Remove iPhone'],
      ['Authenticator app 2', 'Added on 20.10.2026', true, 'Remove Authenticator app 2'],
    ]);
    expect([values.tfaEmpty, values.totpPanel, values.totpNoPanel]).toEqual([false, false, true]);
    expect([values.rcOn, values.rcOff, values.rcShow, values.rcForm, values.rcNoForm]).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(values.rcSum).toBe('8 of 10 unused');
    expect(values.rcSub).toBe('Generated 3 days ago');
    expect(values.sessList.map((s) => [s.icon, s.name, s.sub, s.current, s.notCurrent])).toEqual([
      ['ti-device-desktop', 'Firefox on Linux', 'Berlin, Germany · Active now', true, false],
      ['ti-device-mobile', 'Safari on iPhone', 'Hamburg, Germany · Last active 2 hours ago', false, true],
      ['ti-device-tablet', 'Chrome on iPad', 'IP 203.0.113.0 · Last active 10 hours ago', false, true],
    ]);
    expect(values.hasOtherSess).toBe(true);
  });

  it('names sessions of the installed app "‹App› on ‹System›"', async () => {
    const app = session0('s3', { device: 'Browser on iPhone', device_type: 'mobile', app: 'iPhone' });
    const { v } = await loaded({}, undefined, [SESSIONS[0] as ListedSession, app]);
    expect(v().sessList.map((s) => [s.icon, s.name])).toEqual([
      ['ti-device-desktop', 'Firefox on Linux'],
      ['ti-device-mobile', `${session.appName} on iPhone`],
    ]);
  });

  it('without an app: no code field, no codes; date in the chosen format', async () => {
    const { v } = await loaded({}, NO_MFA, [SESSIONS[0] as ListedSession]);
    const values = v();
    expect(values.pwFields.map((f) => f.ac)).toEqual(['current-password', 'new-password', 'new-password']);
    expect([values.tfaEmpty, values.rcOff, values.rcOn, values.hasOtherSess]).toEqual([true, true, false, false]);
    prefs.values.dateFmt = 'iso';
    const p2 = await loaded();
    expect(p2.v().tfaEntries[0]?.sub).toContain('Added on 2026-10-01');
  });

  it('shows the load card if the first load fails, and loads again', async () => {
    mockApi({
      'GET auth/totp/devices': [{ status: 500, body: {} }, { body: MFA }],
      'GET auth/sessions': [{ body: { sessions: SESSIONS } }, { body: { sessions: SESSIONS } }],
    });
    const p = new SecurityPage();
    await p.load();
    expect([p.status, p.failure]).toEqual(['failed', m.error_act()]);
    p.retry();
    await vi.waitFor(() => expect(p.status).toBe('ready'));
  });

  it('offline without a response from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const p = new SecurityPage();
    await p.load();
    expect([p.status, p.failure]).toEqual(['failed', m.error_offline()]);
  });

  it('names the wait after too many requests on the first load', async () => {
    mockApi({
      'GET auth/totp/devices': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }],
      'GET auth/sessions': [{ body: { sessions: SESSIONS } }],
    });
    const p = new SecurityPage();
    await p.load();
    expect([p.status, p.failure]).toEqual(['failed', 'Too many requests. Try again in 30 seconds.']);
  });

  it('reports a failed reload with an error toast and keeps the list', async () => {
    const { p, v } = await loaded({
      'GET auth/totp/devices': [{ body: MFA }, { status: 500, body: {} }],
    });
    await p.load();
    expect(p.status).toBe('ready');
    expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    // Without a connection: "No connection" instead of the list's text.
    mockApi({});
    await p.load();
    expect(ui.toast?.text).toBe('No connection. Please try again.');
  });
});

describe('Change password', () => {
  async function filled(routes: Parameters<typeof mockApi>[0], mfa = MFA) {
    const page = await loaded(routes, mfa);
    const v = page.v();
    field(v, 'current-password').onChange('Old-Password1');
    if (mfa.devices.length) field(v, 'one-time-code').onChange('123456');
    field(v, 'new-password').onChange('New-Password1');
    field(v, 'new-password', 1).onChange('New-Password1');
    return page;
  }

  it('checks rules, repetition and code before sending', async () => {
    const { p, v, calls } = await loaded();
    expect(v().pwDis).toBe(true);
    field(v(), 'current-password').onChange('Old-Password1');
    field(v(), 'one-time-code').onChange('12345');
    field(v(), 'new-password').onChange('short');
    field(v(), 'new-password', 1).onChange('short');
    expect(v().pwDis).toBe(false);
    v().pwSubmit();
    expect(p.pwErr).toBe('The new password must be at least 10 characters long.');
    field(v(), 'new-password').onChange('new-password1');
    expect(p.pwErr).toBeNull();
    v().pwSubmit();
    expect(p.pwErr).toBe('The new password needs upper- and lowercase letters.');
    field(v(), 'new-password').onChange('New-Password1');
    v().pwSubmit();
    expect(p.pwErr).toBe('The passwords don’t match.');
    field(v(), 'new-password', 1).onChange('New-Password1');
    v().pwSubmit();
    expect(v().pwMsg).toBe('The code must be 6 digits.');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reports signed-out devices and keeps only its own', async () => {
    const { p, v, calls } = await filled({
      'PUT auth/password': [{ body: { password_changed_at: minutesAgo(0), sessions_ended: 2 } }],
    });
    v().pwKey(key('Enter'));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Password changed. Other devices were signed out.'));
    expect(sent(calls).at(-1)).toEqual({
      call: 'PUT auth/password',
      body: { current_password: 'Old-Password1', new_password: 'New-Password1', code: '123456' },
    });
    expect(v().sessList.map((s) => s.name)).toEqual(['Firefox on Linux']);
    expect(v().pwDesc).toBe('Last changed just now');
    expect([p.pwCur, p.pwNew, p.pwConf, p.pwOtp]).toEqual(['', '', '', '']);
    // Open links from mails are discarded.
    expect(session.user?.email_change).toBeNull();
  });

  it('without other devices only "Password changed"', async () => {
    const { v } = await filled(
      { 'PUT auth/password': [{ body: { password_changed_at: minutesAgo(0), sessions_ended: 0 } }] },
      NO_MFA,
    );
    v().pwSubmit();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Password changed'));
  });

  it('reports server responses and clears only the affected field', async () => {
    const { p, v } = await filled({
      'PUT auth/password': [
        { status: 422, body: { error: 'invalid_password' } },
        { status: 422, body: { error: 'invalid', fields: { new_password: { code: 'policy', rules: ['num'] } } } },
        { status: 429, body: { error: 'rate_limited', retry_after: 900 } },
      ],
    });
    await p.changePassword();
    expect([v().pwMsg, p.pwCur, p.pwOtp]).toEqual(['The password is incorrect.', '', '123456']);
    p.setPw('pwCur', 'Old-Password1');
    await p.changePassword();
    expect(p.pwErr).toBe('The new password needs a number or special character.');
    await p.changePassword();
    expect([p.pwErr, p.pwCur, p.pwOtp]).toEqual([
      'Too many failed attempts. Try again in 15 minutes.',
      'Old-Password1',
      '123456',
    ]);
    expect(v().hasPwMsg).toBe(true);
  });
});

describe('Authenticator apps', () => {
  const ENROLL = {
    id: 't3',
    secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    uri: 'otpauth://totp/Roedy%20Mail:max@example.com?secret=JBSWY3DPEHPK3PXP',
  };

  it('adds the first app, shows QR code, key and then the codes', async () => {
    const after: MfaOverview = {
      devices: [{ id: 't3', name: 'Authenticator-App', created_at: minutesAgo(0), last_used_at: null }],
      recovery: { total: 10, unused: 10, created_at: minutesAgo(0) },
      recovery_codes: CODES,
    };
    const { p, v, calls } = await loaded(
      {
        'POST auth/totp/devices/enroll': [{ body: ENROLL }],
        'POST auth/totp/devices/confirm': [{ body: after }],
      },
      NO_MFA,
    );
    v().tfaAdd();
    expect([v().totpPanel, v().totpSetup, v().totpBusy]).toEqual([true, true, true]);
    await vi.waitFor(() => expect(v().totpSecret).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP'));
    expect(v().totpQr?.size).toBeGreaterThan(20);
    expect(v().totpIntro).toBe('Enter your password and the 6-digit code from the new app.');
    expect(v().totpGoLabel).toBe('Add');
    v().totpGo();
    expect(v().tErr).toBe('Please enter your password.');
    v().onTPw('Secret-123');
    v().totpGo();
    expect(v().tErr).toBe('Please enter the 6-digit code.');
    v().onTCode('123 456');
    v().tKey(key('Enter'));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Multi-factor authentication turned on'));
    expect(sent(calls).at(-1)).toEqual({
      call: 'POST auth/totp/devices/confirm',
      body: { id: 't3', password: 'Secret-123', code: '123456' },
    });
    const values = v();
    expect([values.totpPanel, values.rcShow, values.rcOn]).toEqual([false, true, true]);
    expect(values.rcCodes[0]).toEqual({ code: 'ABCD-EFGH', n: '1' });
    expect(values.rcCodes).toHaveLength(10);
    expect(session.user?.mfa_enabled).toBe(true);
    values.rcDone();
    expect(v().rcShow).toBe(false);
    expect(p.enrollment).toBeNull();
  });

  it('adds another app with a name', async () => {
    const after: MfaOverview = {
      devices: [...MFA.devices, { id: 't3', name: 'Laptop', created_at: minutesAgo(0), last_used_at: null }],
      recovery: MFA.recovery,
    };
    const { v, calls } = await loaded({
      'POST auth/totp/devices/enroll': [{ body: ENROLL }],
      'POST auth/totp/devices/confirm': [{ body: after }],
    });
    v().tfaAdd();
    await vi.waitFor(() => expect(v().totpSecret).not.toBe(''));
    v().onTName(' Laptop ');
    v().onTPw('Secret-123');
    v().onTCode('123456');
    v().totpGo();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Laptop added'));
    expect((sent(calls).at(-1)?.body as { name: string }).name).toBe('Laptop');
    expect(v().rcShow).toBe(false);
  });

  it('reports a wrong code of the new app, and cancel discards the enrolment', async () => {
    const { p, v } = await loaded({
      'POST auth/totp/devices/enroll': [{ body: ENROLL }],
      'POST auth/totp/devices/confirm': [{ status: 422, body: { error: 'invalid_code' } }],
    });
    await p.addApp();
    v().onTPw('Old-Password1');
    v().onTCode('123456');
    await p.confirmTotp();
    expect([v().tErr, p.tPw, p.tCode]).toEqual([
      'That code isn’t right. Enter the current code from the new app.',
      'Old-Password1',
      '',
    ]);
    expect(v().hasTErr).toBe(true);
    v().tKey(key('Escape'));
    expect([v().totpPanel, p.enrollment, p.tPw]).toEqual([false, null, '']);
  });

  it('offers "Start over" if the enrolment was replaced in the meantime, and keeps name and password', async () => {
    const NEXT = { ...ENROLL, id: 't4', secret: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU' };
    const { p, v, calls } = await loaded({
      'POST auth/totp/devices/enroll': [{ body: ENROLL }, { body: NEXT }],
      'POST auth/totp/devices/confirm': [{ status: 404, body: { error: 'not_found' } }],
    });
    await p.addApp();
    v().onTName('Laptop');
    v().onTPw('Secret-123');
    v().onTCode('123456');
    await p.confirmTotp();
    // No toast: the box shows "Start over", the code is moot.
    expect(v().tStale).toBe(true);
    expect([p.tCode, p.tName, p.tPw]).toEqual(['', 'Laptop', 'Secret-123']);
    expect(v().totpPanel).toBe(true);
    expect(ui.toast).toBeNull();
    v().tRestart();
    expect(v().tStale).toBe(false);
    expect([p.tName, p.tPw, p.tCode]).toEqual(['Laptop', 'Secret-123', '']);
    await vi.waitFor(() => expect(p.enrollment?.id).toBe('t4'));
    expect(v().totpSecret).toBe('KRSX G5CT MVRX EZLU KRSX G5CT MVRX EZLU');
    expect(calls.filter((c) => c.path === 'auth/totp/devices/enroll')).toHaveLength(2);
  });

  it('checks the app name before password and code, without a request', async () => {
    const { p, v, calls } = await loaded({ 'POST auth/totp/devices/enroll': [{ body: ENROLL }] });
    await p.addApp();
    v().onTName('Lap\u200Btop');
    // Without password and code the name error comes first, and only it.
    await p.confirmTotp();
    expect(v()).toMatchObject({
      tNameErr: 'The name contains invalid characters.',
      hasTNameErr: true,
      tErr: '',
      hasTErr: false,
    });
    v().onTPw('Secret-123');
    v().onTCode('123456');
    await p.confirmTotp();
    expect(v().hasTNameErr).toBe(true);
    expect(calls.filter((c) => c.path === 'auth/totp/devices/confirm')).toHaveLength(0);
    expect(ui.toast).toBeNull();
    // A change to the name clears the error; then password and code are checked as before.
    v().onTName('Laptop');
    v().onTPw('');
    expect(v()).toMatchObject({ tNameErr: '', hasTNameErr: false });
    await p.confirmTotp();
    expect(v()).toMatchObject({ tErr: 'Please enter your password.', hasTNameErr: false });
  });

  it.each([
    ['a control character', 'Lap\u0007top'],
    ['a tab at the end', 'Laptop\t'],
    ['a line break at the start', '\nLaptop'],
    ['a C1 control character', 'Lap\u0085top'],
    ['a soft hyphen', 'Lap\u00ADtop'],
    ['an Arabic letter mark', 'Lap\u061Ctop'],
    ['a Mongolian vowel separator', 'Lap\u180Etop'],
    ['a right-to-left mark', 'Lap\u200Ftop'],
    ['a line separator', 'Lap\u2028top'],
    ['a direction override', 'Lap\u202Etop'],
    ['a word joiner', 'Lap\u2060top'],
    ['a byte order mark', '\uFEFFLaptop'],
  ])('rejects an app name with %s before sending', async (_, name) => {
    const { p, v, calls } = await loaded({ 'POST auth/totp/devices/enroll': [{ body: ENROLL }] });
    await p.addApp();
    v().onTName(name);
    v().onTPw('Secret-123');
    v().onTCode('123456');
    await p.confirmTotp();
    expect(v().tNameErr).toBe('The name contains invalid characters.');
    expect(calls.filter((c) => c.path === 'auth/totp/devices/confirm')).toHaveLength(0);
  });

  it('keeps the server check of the app name as a fallback', async () => {
    const { p, v, calls } = await loaded({
      'POST auth/totp/devices/enroll': [{ body: ENROLL }],
      'POST auth/totp/devices/confirm': [
        { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
      ],
    });
    await p.addApp();
    // Interlinear annotation anchor: only the server rejects it.
    v().onTName('Lap\uFFF9top');
    v().onTPw('Secret-123');
    v().onTCode('123456');
    await p.confirmTotp();
    expect(calls.filter((c) => c.path === 'auth/totp/devices/confirm')).toHaveLength(1);
    expect(v()).toMatchObject({ tNameErr: 'The name contains invalid characters.', hasTNameErr: true });
    expect(ui.toast).toBeNull();
  });

  it('does not check the name when removing an app', async () => {
    const after: MfaOverview = { devices: [LAPTOP], recovery: MFA.recovery };
    const { p, v } = await loaded({ 'DELETE auth/totp/devices/t1': [{ body: after }] });
    v().tfaEntries[0]?.onRemove();
    p.tName = 'Lap\u200Btop';
    v().onTPw('Secret-123');
    v().onTCode('654321');
    await p.confirmTotp();
    expect(v().hasTNameErr).toBe(false);
    expect(ui.toast?.text).toBe('iPhone removed');
  });

  it('removes an app with password and code', async () => {
    const after: MfaOverview = { devices: [LAPTOP], recovery: MFA.recovery };
    const { v, calls } = await loaded({ 'DELETE auth/totp/devices/t1': [{ body: after }] });
    v().tfaEntries[0]?.onRemove();
    let values = v();
    expect([values.totpPanel, values.totpSetup, values.totpGoLabel]).toEqual([true, false, 'Remove']);
    expect(values.tfaEntries[0]?.selected).toBe(true);
    expect(values.totpIntro).toBe('To remove “iPhone”, confirm with your password and a code from one of your apps.');
    values.onTPw('Secret-123');
    values.onTCode('654321');
    values.totpGo();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('iPhone removed'));
    expect(sent(calls).at(-1)).toEqual({
      call: 'DELETE auth/totp/devices/t1',
      body: { password: 'Secret-123', code: '654321' },
    });
    values = v();
    expect(values.tfaEntries.map((e) => e.name)).toEqual(['Authenticator app 2']);
    expect(values.totpPanel).toBe(false);
  });

  it('the last app switches off multi-factor and the codes', async () => {
    const one: MfaOverview = { devices: [IPHONE], recovery: MFA.recovery };
    const { p, v } = await loaded({ 'DELETE auth/totp/devices/t1': [{ body: NO_MFA }] }, one);
    session.user = { ...ME, mfa_enabled: true };
    v().tfaEntries[0]?.onRemove();
    expect(v().totpIntro).toBe(
      'To remove “iPhone”, confirm with your password and a code from one of your apps. Multi-factor authentication will then be turned off.',
    );
    p.setTPw('Secret-123');
    p.setTCode('123456');
    await p.confirmTotp();
    expect(ui.toast?.text).toBe('Multi-factor authentication turned off');
    const values = v();
    expect([values.tfaEmpty, values.rcOff, values.rcShow]).toEqual([true, true, false]);
    expect(values.pwFields.some((f) => f.ac === 'one-time-code')).toBe(false);
    expect(session.user?.mfa_enabled).toBe(false);
  });

  it('reports an already used code and reloads on 404', async () => {
    const { p, v, calls } = await loaded({
      'DELETE auth/totp/devices/t1': [
        { status: 422, body: { error: 'code_used' } },
        { status: 404, body: { error: 'not_found' } },
      ],
    });
    p.askRemove('t1');
    p.setTPw('Secret-123');
    p.setTCode('123456');
    await p.confirmTotp();
    expect(v().tErr).toBe('This code has already been used. Wait for the next code in your app.');
    p.setTCode('654321');
    await p.confirmTotp();
    expect(v().totpPanel).toBe(false);
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'auth/totp/devices')).toHaveLength(2));
  });

  it('copies the key without spaces', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { p, v } = await loaded({ 'POST auth/totp/devices/enroll': [{ body: ENROLL }] });
    await p.addApp();
    v().copyTotp();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Key copied'));
    expect(writeText).toHaveBeenCalledWith(ENROLL.secret);
  });
});

describe('Recovery codes', () => {
  it('generates new codes with password and code and shows them once', async () => {
    const after: MfaOverview = {
      ...MFA,
      recovery: { total: 10, unused: 10, created_at: minutesAgo(0) },
      recovery_codes: CODES,
    };
    const { v, calls } = await loaded({ 'POST auth/recovery-codes': [{ body: after }] });
    v().rcRegen();
    let values = v();
    expect([values.rcForm, values.rcNoForm]).toEqual([true, false]);
    values.rcGo();
    expect(v().rcErr).toBe('Please enter your password.');
    values.onRcPw('Secret-123');
    v().rcGo();
    expect(v().rcErr).toBe('Please enter the 6-digit code.');
    v().onRcCode('123456');
    v().rcKey(key('Enter'));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('New recovery codes generated'));
    expect(sent(calls).at(-1)).toEqual({
      call: 'POST auth/recovery-codes',
      body: { password: 'Secret-123', code: '123456' },
    });
    values = v();
    expect([values.rcShow, values.rcForm, values.rcSum, values.rcSub]).toEqual([
      true,
      false,
      '10 of 10 unused',
      'Generated just now',
    ]);
  });

  it('reports a lockout and keeps the inputs; Escape closes', async () => {
    const { p, v } = await loaded({
      'POST auth/recovery-codes': [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    p.openRegen();
    p.setRcPw('Old-Password1');
    p.setRcCode('123456');
    await p.regenerate();
    expect([v().rcErr, v().rcPwVal, v().rcCodeVal, v().rcForm]).toEqual([
      'Too many failed attempts. Try again in 15 minutes.',
      'Old-Password1',
      '123456',
      true,
    ]);
    v().rcKey(key('Escape'));
    expect(v().rcForm).toBe(false);
  });

  it('copies and downloads the codes', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // jsdom knows no blob URLs and would navigate when clicking the link.
    const created = vi.fn((blob: Blob) => (blob.size ? 'blob:codes' : ''));
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { p, v } = await loaded();
    p.codes = CODES;
    v().rcCopy();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Codes copied'));
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    v().rcDownload();
    expect(ui.toast?.text).toBe('Codes downloaded');
    expect(created).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });
});

describe('Signed-in devices', () => {
  it('signs out a device with undo only after the toast expires', async () => {
    const { v, calls } = await loaded({ 'DELETE auth/sessions/s1': [{ status: 204 }] });
    v().sessList[1]?.onRevoke();
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's2']);
    expect(ui.toast).toMatchObject({ text: 'Device signed out', undo: true });
    ui.toasts.undo();
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    v().sessList[1]?.onRevoke();
    await ui.toasts.flush();
    expect(sent(calls).filter((c) => c.call.startsWith('DELETE'))).toEqual([
      { call: 'DELETE auth/sessions/s1', body: undefined },
    ]);
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's2']);
  });

  it('reverts the sign-out if the server rejects it, and reloads', async () => {
    const { v, calls } = await loaded({ 'DELETE auth/sessions/s1': [{ status: 500, body: {} }] });
    v().sessList[1]?.onRevoke();
    await ui.toasts.flush();
    expect(ui.toast).toMatchObject({
      text: 'The device wasn’t signed out. Please try again.',
      error: true,
      undo: false,
    });
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'auth/sessions')).toHaveLength(2));
  });

  it('reverts "Sign out all others" if the server rejects it', async () => {
    const { v, calls } = await loaded({ 'POST auth/sessions/revoke-others': [{ status: 500, body: {} }] });
    v().revokeOthers();
    await ui.toasts.flush();
    expect(ui.toast).toMatchObject({
      text: 'The other devices weren’t signed out. Please try again.',
      error: true,
    });
    expect(v().sessList.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'auth/sessions')).toHaveLength(2));
  });

  it('signs out all others with undo and reloads the account', async () => {
    const { v, calls } = await loaded({
      'POST auth/sessions/revoke-others': [{ body: { sessions_ended: 2 } }],
      'GET auth/me': [{ body: { ...ME, email_change: null } }],
    });
    v().revokeOthers();
    expect(v().sessList.map((s) => s.id)).toEqual(['s0']);
    expect(v().hasOtherSess).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Other devices signed out', undo: true });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await ui.toasts.flush();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['auth/sessions/revoke-others']);
    await vi.waitFor(() => expect(session.user?.email_change).toBeNull());
  });
});

describe('Edge cases', () => {
  const ENROLL = {
    id: 't3',
    secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
  };

  it('a late response neither closes nor locks the prompt opened in the meantime', async () => {
    let release: (a: { body: unknown }) => void = () => {};
    const after: MfaOverview = {
      devices: [...MFA.devices, { id: 't3', name: 'Laptop', created_at: minutesAgo(0), last_used_at: null }],
      recovery: MFA.recovery,
    };
    const { p, v } = await loaded({
      'POST auth/totp/devices/enroll': [{ body: ENROLL }],
      'POST auth/totp/devices/confirm': [() => new Promise((resolve) => (release = resolve))],
    });
    await p.addApp();
    p.setTPw('Secret-123');
    p.setTCode('123456');
    const confirming = p.confirmTotp();
    p.cancelTotp();
    p.askRemove('t1');
    expect(v().totpBusy).toBe(false);
    p.setTPw('Anderes-1');
    release({ body: after });
    await confirming;
    expect([p.totpMode, p.totpTarget, p.tPw]).toEqual(['off', 't1', 'Anderes-1']);
    expect(v().tfaEntries.map((e) => e.name)).toContain('Laptop');
    expect(ui.toast?.text).toBe('Laptop added');
  });

  it('reloads when the password change asks for a code the page did not ask for', async () => {
    const { p, calls } = await loaded(
      { 'PUT auth/password': [{ status: 422, body: { error: 'invalid', fields: { code: { code: 'required' } } } }] },
      NO_MFA,
    );
    p.setPw('pwCur', 'Old-Password1');
    p.setPw('pwNew', 'New-Password1');
    p.setPw('pwConf', 'New-Password1');
    await p.changePassword();
    expect(p.pwErr).toBe('The code must be 6 digits.');
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'auth/totp/devices')).toHaveLength(2));
  });

  it('Escape in the prompts counts as done', async () => {
    const { p } = await loaded();
    for (const handler of [(e: ReturnType<typeof key>) => p.totpKey(e), (e: ReturnType<typeof key>) => p.rcKey(e)]) {
      const e = key('Escape');
      handler(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it('date of the apps in the time zone of the settings', async () => {
    prefs.values.tz = 'Asia/Tokyo';
    const late = { ...IPHONE, created_at: '2026-10-01T20:00:00Z' };
    const { v } = await loaded({}, { ...MFA, devices: [late] });
    expect(v().tfaEntries[0]?.sub).toContain('Added on 02.10.2026');
  });
});

describe('Reopening', () => {
  it('shows apps, codes and devices of the last open page at once and replaces them with the new ones', async () => {
    const { p } = await loaded();
    p.dispose();
    const later = SESSIONS.slice(0, 2);
    mockApi({
      'GET auth/totp/devices': [{ body: NO_MFA }],
      'GET auth/sessions': [{ body: { sessions: later } }],
    });
    const q = new SecurityPage();
    expect([q.status, q.devices, q.recovery, q.sessions]).toEqual(['ready', MFA.devices, MFA.recovery, SESSIONS]);
    await q.load();
    expect([q.devices, q.recovery, q.sessions]).toEqual([[], null, later]);
  });

  it('keeps the page with the toast "Couldn’t update the list." if loading fails, also without a connection', async () => {
    const { p } = await loaded();
    p.dispose();
    const fails = [
      () =>
        mockApi({
          'GET auth/totp/devices': [{ status: 500, body: {} }],
          'GET auth/sessions': [{ body: { sessions: SESSIONS } }],
        }),
      () =>
        vi.stubGlobal(
          'fetch',
          vi.fn(() => Promise.reject(new TypeError('offline'))),
        ),
    ];
    for (const fail of fails) {
      fail();
      const q = new SecurityPage();
      await q.load();
      expect([q.status, q.sessions]).toEqual(['ready', SESSIONS]);
      expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
      ui.reset();
      q.dispose();
    }
  });

  it('keeps a device whose sign-out with undo is pending: it may yet be undone or fail', async () => {
    const { p } = await loaded();
    p.revoke('s1');
    p.dispose();
    expect(new SecurityPage().sessions.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
  });

  it('a reload that started before a removed app does not bring it back', async () => {
    const { p } = await loaded();
    p.dispose();
    const after: MfaOverview = { devices: [LAPTOP], recovery: MFA.recovery };
    let answer: (reply: { body: MfaOverview }) => void = () => {};
    mockApi({
      'GET auth/totp/devices': [() => new Promise((resolve) => (answer = resolve)), { body: after }],
      'GET auth/sessions': [{ body: { sessions: SESSIONS } }, { body: { sessions: SESSIONS } }],
      'DELETE auth/totp/devices/t1': [{ body: after }],
    });
    const q = new SecurityPage();
    const load = q.load();
    q.askRemove('t1');
    q.setTPw('Secret-123');
    q.setTCode('123456');
    await q.confirmTotp();
    expect(q.devices.map((d) => d.id)).toEqual(['t2']);
    answer({ body: MFA });
    await load;
    await vi.waitFor(() => expect(q.devices.map((d) => d.id)).toEqual(['t2']));
    expect(ui.toast?.text).toBe('iPhone removed');
  });

  it('signing out discards the data, also of a page left afterwards', async () => {
    const { p } = await loaded();
    p.dispose();
    const { p: open } = await loaded();
    forgetAccount();
    open.dispose();
    const q = new SecurityPage();
    expect([q.status, q.sessions]).toEqual(['loading', []]);
  });
});
