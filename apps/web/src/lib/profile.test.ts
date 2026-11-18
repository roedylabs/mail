import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { ProfilePage, profileValues, type ProfileValues } from './profile.svelte.ts';

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
  password_changed_at: '2026-07-24T10:00:00Z',
  email_change: null,
};
const USER = { id: 'u0', username: 'max', email: 'max@example.com', display_name: 'Max Miller', role: 'user' };
const OPEN = { email: 'new@example.com', expires_at: '2026-10-27T12:00:00Z' };

beforeEach(() => {
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
});

const key = (k: string) => ({ key: k, preventDefault: vi.fn() });
const rowOf = (v: ProfileValues, k: string) => {
  const found = v.acctRows.find((r) => r.k === k);
  if (!found) throw new Error(`no row ${k}`);
  return found;
};
const sent = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.map((c) => ({ call: `${c.method} ${c.path}`, body: c.body }));

describe('values', () => {
  it('shows account, rows and initials', () => {
    const v = profileValues(new ProfilePage());
    expect(v.acct).toEqual({
      name: 'Max Miller',
      initials: 'MM',
      chip: 'var(--acc)',
      ink: 'var(--accink)',
      nameDesc: 'Shown to other people',
      nameLocked: false,
      sub: 'max · No email account',
    });
    expect(profileValues(new ProfilePage(), 2).acct.sub).toBe('max · 2 email accounts');
    expect(profileValues(new ProfilePage(), 1).acct.sub).toBe('max · 1 email account');
    expect(v.acctRows.map((r) => [r.k, r.v, r.canEdit, r.noEdit])).toEqual([
      ['Username', 'max', true, false],
      ['Email', 'max@example.com', true, false],
      ['Sign-in', 'Password', false, true],
    ]);
    expect(rowOf(v, 'Username').editLabel).toBe('Edit Username');
    expect(v.acctNameRead).toBe(true);
    expect(v.nameDirty).toBe(false);
  });

  it('edits display name and rows; empty or unchanged goes back to reading', () => {
    const p = new ProfilePage();
    profileValues(p).acctNameEdit();
    let v = profileValues(p);
    expect(v.acctNameEditing).toBe(true);
    expect(v.acctNameVal).toBe('Max Miller');
    expect(v.nameDirty).toBe(false);
    v.onNameDraft('Max M.');
    expect(profileValues(p).nameDirty).toBe(true);
    v.onNameDraft('  ');
    profileValues(p).onNameBlur();
    expect(profileValues(p).acctNameRead).toBe(true);

    rowOf(profileValues(p), 'Username').edit();
    v = profileValues(p);
    expect(rowOf(v, 'Username')).toMatchObject({ editing: true, read: false, val: 'max' });
    rowOf(v, 'Username').onChange('max2');
    expect(profileValues(p).nameDirty).toBe(true);
    rowOf(profileValues(p), 'Username').onKey(key('Escape'));
    expect(rowOf(profileValues(p), 'Username').editing).toBe(false);
    expect(profileValues(p).nameDirty).toBe(false);
  });

  it('checks before saving', async () => {
    const { calls } = mockApi({});
    const p = new ProfilePage();
    p.edit('login');
    p.setField('login', 'Max!');
    p.edit('email');
    p.setField('email', 'no-at');
    await p.save();
    const v = profileValues(p);
    expect(rowOf(v, 'Username')).toMatchObject({
      hasErr: true,
      err: 'Only lowercase letters, digits, periods, hyphens, and underscores, 2 to 32 characters.',
    });
    expect(rowOf(v, 'Email').err).toBe('Please enter a valid email address.');
    expect(calls).toEqual([]);
    // A new input clears the message.
    rowOf(v, 'Username').onChange('max2');
    expect(rowOf(profileValues(p), 'Username').hasErr).toBe(false);

    p.discardDrafts();
    p.editName();
    p.setName('   ');
    await p.save();
    expect(ui.toast?.text).toBe('Please enter a name');
    expect(calls).toEqual([]);
    // Invisible characters are rejected as when inviting.
    p.setName('Max\u200BMiller');
    await p.save();
    expect(ui.toast).toMatchObject({ text: 'The name contains invalid characters.', error: true });
    expect(calls).toEqual([]);
  });
});

describe('saving', () => {
  it('saves name and user name immediately with a toast without undo', async () => {
    const { calls } = mockApi({
      'PATCH auth/me': [{ body: { status: 'ok', user: { ...USER, display_name: 'Max M.', username: 'mm' } } }],
    });
    const p = new ProfilePage();
    p.editName();
    p.setName(' Max   M. ');
    p.edit('login');
    p.setField('login', 'mm');
    await p.save();
    expect(sent(calls)).toEqual([{ call: 'PATCH auth/me', body: { display_name: 'Max M.', username: 'mm' } }]);
    expect(session.user).toMatchObject({ display_name: 'Max M.', username: 'mm', mfa_enabled: false });
    expect(ui.toast).toMatchObject({ text: 'Changes saved', undo: false });
    expect(profileValues(p).nameDirty).toBe(false);
  });

  it('asks for the password after a new address (`reauth_required`)', async () => {
    const { calls } = mockApi({ 'PATCH auth/me': [{ body: { status: 'reauth_required', user: USER } }] });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'new@example.com');
    await p.save();
    expect(sent(calls)).toEqual([{ call: 'PATCH auth/me', body: { email: 'new@example.com' } }]);
    // Only the address changed: no toast.
    expect(ui.toast).toBeNull();
    const v = profileValues(p);
    const row = rowOf(v, 'Email');
    expect(row).toMatchObject({ auth: true, v: 'new@example.com', canEdit: false, noEdit: true, pend: false });
    expect(v.eaIntro).toBe('Confirm the change with your password.');
    expect(v.eaFields.map((f) => [f.label, f.desc, f.ac, f.type, f.focus, f.hasEye])).toEqual([
      ['Current password', 'To confirm it’s you', 'current-password', 'password', true, true],
    ]);
    expect(v.eaDis).toBe(true);
    v.eaFields[0]?.onEye?.();
    expect(profileValues(p).eaFields[0]).toMatchObject({
      type: 'text',
      eyeIcon: 'ti-eye-off',
      eyeTip: 'Hide password',
    });
  });

  it('shows a taken address in the row', async () => {
    mockApi({ 'PATCH auth/me': [{ status: 422, body: { error: 'email_taken' } }] });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'anna@example.com');
    await p.save();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({
      editing: true,
      val: 'anna@example.com',
      err: 'This email address is already used by another account.',
    });
  });

  it('reports server field errors in the row and unknown ones as an error toast', async () => {
    mockApi({
      'PATCH auth/me': [
        { status: 422, body: { error: 'invalid', fields: { username: { code: 'invalid' } } } },
        { status: 422, body: { error: 'invalid', fields: { username: { code: 'taken' } } } },
        { status: 500, body: {} },
      ],
    });
    const p = new ProfilePage();
    p.edit('login');
    p.setField('login', 'anna');
    await p.save();
    expect(rowOf(profileValues(p), 'Username')).toMatchObject({
      hasErr: true,
      err: 'Only lowercase letters, digits, periods, hyphens, and underscores, 2 to 32 characters.',
    });
    p.setField('login', 'anna');
    await p.save();
    // Taken: in the row like a taken address, no toast; the input stays.
    expect(ui.toast).toBeNull();
    expect(rowOf(profileValues(p), 'Username')).toMatchObject({
      editing: true,
      val: 'anna',
      hasErr: true,
      err: 'This username is already taken.',
    });
    await p.save();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
  });

  it('reloads the account without a session, without a toast', async () => {
    const { calls } = mockApi({
      'PATCH auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
      'GET auth/me': [{ status: 401, body: {} }],
    });
    const p = new ProfilePage();
    p.editName();
    p.setName('Max M.');
    await p.save();
    await vi.waitFor(() => expect(session.user).toBeNull());
    expect(ui.toast).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['auth/me', 'auth/me']);
  });
});

describe('send confirmation link', () => {
  async function asking(routes: Parameters<typeof mockApi>[0], mfa = false) {
    session.user = { ...ME, mfa_enabled: mfa };
    const api = mockApi({ 'PATCH auth/me': [{ body: { status: 'reauth_required', user: USER } }], ...routes });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'new@example.com');
    await p.save();
    return { p, ...api };
  }

  it('sends with password and code and shows "Confirmation pending"', async () => {
    const { p, calls } = await asking(
      {
        'PATCH auth/me': [
          { body: { status: 'reauth_required', user: USER } },
          { body: { status: 'email_sent', user: USER, email_change: OPEN } },
        ],
      },
      true,
    );
    let v = profileValues(p);
    expect(v.eaIntro).toBe('Confirm the change with your password and a code from your authenticator app.');
    expect(v.eaFields.map((f) => [f.label, f.desc, f.ac, f.im])).toEqual([
      ['Current password', 'To confirm it’s you', 'current-password', 'text'],
      ['Verification code', 'From your authenticator app', 'one-time-code', 'numeric'],
    ]);
    v.eaFields[0]?.onChange('Secret-123');
    expect(profileValues(p).eaDis).toBe(true);
    v.eaFields[1]?.onChange('12 3a45');
    expect(p.eaOtp).toBe('12345');
    v = profileValues(p);
    expect(v.eaDis).toBe(false);
    v.eaGo();
    expect(p.eaErr).toBe('The code must be 6 digits.');
    v.eaFields[1]?.onChange('123456');
    profileValues(p).eaKey(key('Enter'));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Confirmation link sent'));
    expect(sent(calls).at(-1)).toEqual({
      call: 'PATCH auth/me',
      body: { email: 'new@example.com', password: 'Secret-123', code: '123456' },
    });
    v = profileValues(p);
    expect(rowOf(v, 'Email')).toMatchObject({
      auth: false,
      pend: true,
      pendEmail: 'new@example.com',
      v: 'max@example.com',
    });
    expect(session.user?.email_change).toEqual(OPEN);
    expect(ui.toast?.undo).toBe(false);
  });

  it('reports password, code, lockout and sending failures', async () => {
    const answers = [
      { status: 422, body: { error: 'invalid_password' } },
      { status: 422, body: { error: 'invalid_code' } },
      { status: 422, body: { error: 'code_used' } },
      { status: 429, body: { error: 'rate_limited', retry_after: 900 } },
      { status: 502, body: { error: 'mail_failed' } },
    ];
    const { p } = await asking(
      { 'PATCH auth/me': [{ body: { status: 'reauth_required', user: USER } }, ...answers] },
      true,
    );
    const fill = () => {
      p.setEaPw(p.eaPw || 'Secret-123');
      p.setEaOtp('123456');
    };
    fill();
    await p.sendLink();
    expect([p.eaErr, p.eaPw, p.eaOtp]).toEqual(['The password is incorrect.', '', '123456']);
    fill();
    await p.sendLink();
    expect([p.eaErr, p.eaPw, p.eaOtp]).toEqual([
      'That code isn’t right. Enter the current code from your authenticator app.',
      'Secret-123',
      '',
    ]);
    fill();
    await p.sendLink();
    expect(p.eaErr).toBe('This code has already been used. Wait for the next code in your app.');
    fill();
    await p.sendLink();
    expect([p.eaErr, p.eaPw, p.eaOtp]).toEqual([
      'Too many failed attempts. Try again in 15 minutes.',
      'Secret-123',
      '123456',
    ]);
    await p.sendLink();
    // Without a toast; the code is used up, the password stays.
    expect([p.eaErr, p.eaPw, p.eaOtp]).toEqual([
      'The email couldn’t be sent. Your email address wasn’t changed. Try again later with a new code.',
      'Secret-123',
      '',
    ]);
    expect(ui.toast).toBeNull();
    expect(profileValues(p).hasEaMsg).toBe(true);
  });

  it('without multi-factor: sending failed without the sentence about the code', async () => {
    const { p } = await asking({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { status: 502, body: { error: 'mail_failed' } },
      ],
    });
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(p.eaErr).toBe('The email couldn’t be sent. Your email address wasn’t changed. Try again later.');
    expect(rowOf(profileValues(p), 'Email').auth).toBe(true);
  });

  it('shows an address taken in the meantime in the row again', async () => {
    const { p } = await asking({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { status: 422, body: { error: 'email_taken' } },
      ],
    });
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({
      auth: false,
      editing: true,
      val: 'new@example.com',
      err: 'This email address is already used by another account.',
    });
  });

  it('cancel and Escape close the prompt; a late message no longer applies', async () => {
    let release: (a: { status: number; body: unknown }) => void = () => {};
    const { p, calls } = await asking({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        () => new Promise((resolve) => (release = resolve)),
      ],
    });
    p.setEaPw('Secret-123');
    const sending = p.sendLink();
    expect(profileValues(p).eaBusy).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    profileValues(p).eaKey(key('Escape'));
    release({ status: 422, body: { error: 'invalid_password' } });
    await sending;
    expect(p.ea).toBeNull();
    expect(p.eaErr).toBeNull();
    expect(rowOf(profileValues(p), 'Email').auth).toBe(false);
  });

  it('reports the discarded change after `email_change_discarded` and reloads the account', async () => {
    const { p, calls } = await asking({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { status: 409, body: { error: 'email_change_discarded' } },
      ],
      'GET auth/me': [{ body: ME }],
    });
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(ui.toast).toMatchObject({
      text: 'The email address change has since been discarded.',
      error: false,
      undo: false,
    });
    expect(p.ea).not.toBeNull();
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('GET auth/me'));
  });
});

describe('confirmation pending', () => {
  beforeEach(() => {
    session.user = { ...ME, email_change: OPEN };
  });

  it('shows the pending change from `auth/me` and resends the link', async () => {
    const renewed = { email: OPEN.email, expires_at: '2026-10-28T12:00:00Z' };
    const { calls } = mockApi({ 'POST auth/me/email/resend': [{ body: renewed }] });
    const p = new ProfilePage();
    const row = rowOf(profileValues(p), 'Email');
    expect(row).toMatchObject({ pend: true, pendEmail: 'new@example.com', hasPendErr: false });
    row.resend();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Confirmation link resent'));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST auth/me/email/resend']);
    expect(session.user?.email_change).toEqual(renewed);
  });

  it('reports a failed sending in the box, with the previous link only if it applies', async () => {
    mockApi({
      'POST auth/me/email/resend': [
        { status: 502, body: { error: 'mail_failed', previous_link_valid: true } },
        { status: 502, body: { error: 'mail_failed', previous_link_valid: false } },
        { status: 422, body: { error: 'email_taken' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 600 } },
      ],
    });
    const p = new ProfilePage();
    await p.resend();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({
      hasPendErr: true,
      pendErr: 'The email couldn’t be sent. The previous link is still valid. Try again later.',
    });
    await p.resend();
    expect(p.pendErr).toBe('The email couldn’t be sent. Try again later.');
    await p.resend();
    expect(p.pendErr).toBe('This email address is already used by another account.');
    await p.resend();
    expect(p.pendErr).toBe('Too many requests. Try again in 10 minutes.');
    expect(ui.toast).toBeNull();
    expect(session.user?.email_change).toEqual(OPEN);
  });

  it('"Resend link" after the change was discarded elsewhere: box gone, regular toast', async () => {
    const { calls } = mockApi({
      'POST auth/me/email/resend': [{ status: 404, body: { error: 'not_found' } }],
      'GET auth/me': [{ body: ME }],
    });
    const p = new ProfilePage();
    await p.resend();
    expect(sent(calls).map((c) => c.call)).toEqual(['POST auth/me/email/resend', 'GET auth/me']);
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({ pend: false, hasPendErr: false });
    expect(ui.toast).toMatchObject({
      text: 'The email address change has since been discarded.',
      error: false,
      undo: false,
    });
  });

  it('"Resend link" after the change was confirmed elsewhere: new address, no toast', async () => {
    mockApi({
      'POST auth/me/email/resend': [{ status: 404, body: { error: 'not_found' } }],
      'GET auth/me': [{ body: { ...ME, email: OPEN.email } }],
    });
    const p = new ProfilePage();
    await p.resend();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({ pend: false, v: OPEN.email });
    expect(ui.toast).toBeNull();
  });

  it('"Resend link" without an answer to `auth/me` still drops the box', async () => {
    mockApi({ 'POST auth/me/email/resend': [{ status: 404, body: { error: 'not_found' } }] });
    const p = new ProfilePage();
    await p.resend();
    expect(session.user?.email_change).toBeNull();
    expect(ui.toast?.text).toBe('The email address change has since been discarded.');
  });

  it('reports `email_change_discarded` after "Resend link" with a regular toast', async () => {
    mockApi({
      'POST auth/me/email/resend': [{ status: 409, body: { error: 'email_change_discarded' } }],
      'GET auth/me': [{ body: ME }],
    });
    const p = new ProfilePage();
    await p.resend();
    expect(ui.toast).toMatchObject({ text: 'The email address change has since been discarded.', error: false });
    await vi.waitFor(() => expect(session.user?.email_change).toBeNull());
  });

  it('"Discard change" after the change was discarded elsewhere: regular toast, no undo, nothing sent', async () => {
    const { calls } = mockApi({ 'GET auth/me': [{ body: ME }] });
    const p = new ProfilePage();
    const discarding = p.discardChange();
    // While `auth/me` loads, both buttons wait.
    expect(rowOf(profileValues(p), 'Email').busy).toBe(true);
    await discarding;
    expect(rowOf(profileValues(p), 'Email').pend).toBe(false);
    expect(ui.toast).toMatchObject({
      text: 'The email address change has since been discarded.',
      error: false,
      undo: false,
    });
    await ui.toasts.flush();
    expect(sent(calls).map((c) => c.call)).toEqual(['GET auth/me']);
  });

  it('"Discard change" after the change was confirmed elsewhere: no toast', async () => {
    mockApi({ 'GET auth/me': [{ body: { ...ME, email: OPEN.email } }] });
    const p = new ProfilePage();
    await p.discardChange();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({ pend: false, v: OPEN.email });
    expect(ui.toast).toBeNull();
  });

  it('"Resend link" applies its answer only to the account and change it was sent for', async () => {
    const other = { ...ME, id: 'u1', email: 'eva@example.com', email_change: { ...OPEN, email: 'eva2@example.com' } };
    const newer = { ...OPEN, email: 'two@example.com' };
    let release: (a: { status: number; body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'POST auth/me/email/resend': [
        () => new Promise((resolve) => (release = resolve)),
        () => new Promise((resolve) => (release = resolve)),
        { status: 409, body: { error: 'email_change_discarded' } },
      ],
      'GET auth/me': [{ status: 500, body: {} }, { status: 500, body: {} }, { body: { ...ME, email: OPEN.email } }],
    });
    const p = new ProfilePage();
    // Another tab switched the account in the meantime.
    let resending = p.resend();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.user = other;
    release({ status: 404, body: { error: 'not_found' } });
    await resending;
    expect(session.user).toEqual(other);
    expect(ui.toast).toBeNull();

    // A new link went out in the meantime; the failed reload must not drop it.
    session.user = { ...ME, email_change: OPEN };
    resending = p.resend();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    session.user = { ...ME, email_change: newer };
    release({ status: 404, body: { error: 'not_found' } });
    await resending;
    expect(session.user?.email_change).toEqual(newer);
    expect(ui.toast).toBeNull();

    // 409 while sending, then confirmed elsewhere: the new address, no "discarded".
    session.user = { ...ME, email_change: OPEN };
    await p.resend();
    expect(session.user?.email).toBe(OPEN.email);
    expect(ui.toast).toBeNull();
  });

  it('"Discard change" does not discard a change that replaced the clicked one', async () => {
    const newer = { ...OPEN, email: 'two@example.com' };
    const { calls } = mockApi({ 'GET auth/me': [{ body: { ...ME, email_change: newer } }] });
    const p = new ProfilePage();
    await p.discardChange();
    expect(rowOf(profileValues(p), 'Email')).toMatchObject({ pend: true, pendEmail: 'two@example.com' });
    expect(ui.toast).toBeNull();
    await ui.toasts.flush();
    expect(sent(calls).map((c) => c.call)).toEqual(['GET auth/me']);
  });

  it('"Discard change" keeps a link sent while `auth/me` loads', async () => {
    const newer = { ...OPEN, email: 'two@example.com' };
    let release: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({ 'GET auth/me': [() => new Promise((resolve) => (release = resolve))] });
    const p = new ProfilePage();
    const discarding = p.discardChange();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.user = { ...ME, email_change: newer };
    // The older read still shows the clicked change.
    release({ body: { ...ME, email_change: OPEN } });
    await discarding;
    expect(session.user?.email_change).toEqual(newer);
    expect(ui.toast).toBeNull();
    await ui.toasts.flush();
    expect(calls).toHaveLength(1);
  });

  it('"Discard change" discards nothing while a new link is being sent', async () => {
    let release: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'GET auth/me': [() => new Promise((resolve) => (release = resolve))],
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { body: { status: 'email_sent', user: USER, email_change: { ...OPEN, email: 'two@example.com' } } },
      ],
    });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'two@example.com');
    await p.save();
    p.setEaPw('Secret-123');
    const discarding = p.discardChange();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const sending = p.sendLink();
    release({ body: { ...ME, email_change: OPEN } });
    await discarding;
    await sending;
    expect(ui.toast?.text).toBe('Confirmation link sent');
    await ui.toasts.flush();
    expect(sent(calls).map((c) => c.call)).not.toContain('DELETE auth/me/email');
    expect(session.user?.email_change?.email).toBe('two@example.com');
  });

  it('keeps a name saved while "Discard change" reads `auth/me`', async () => {
    let release: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'GET auth/me': [() => new Promise((resolve) => (release = resolve))],
      'PATCH auth/me': [{ body: { status: 'ok', user: { ...USER, display_name: 'Max Rivera' } } }],
    });
    const p = new ProfilePage();
    const discarding = p.discardChange();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    p.editName();
    p.setName('Max Rivera');
    await p.save();
    release({ body: { ...ME, email_change: OPEN } });
    await discarding;
    expect(session.user?.display_name).toBe('Max Rivera');
    expect(ui.toast).toMatchObject({ text: 'Change discarded', undo: true });
  });

  it('drops a late "Resend link" answer after a newer link', async () => {
    const newer = { ...OPEN, email: 'two@example.com' };
    let release: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({ 'POST auth/me/email/resend': [() => new Promise((resolve) => (release = resolve))] });
    const p = new ProfilePage();
    const resending = p.resend();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.user = { ...ME, email_change: newer };
    release({ body: { ...OPEN, expires_at: '2026-10-28T12:00:00Z' } });
    await resending;
    expect(session.user?.email_change).toEqual(newer);
    expect(ui.toast).toBeNull();
  });

  it('discards with undo only after the toast expires', async () => {
    const pending = { body: { ...ME, email_change: OPEN } };
    const { calls } = mockApi({
      'GET auth/me': [pending, pending, pending],
      'DELETE auth/me/email': [{ status: 204 }, { status: 404, body: { error: 'not_found' } }],
    });
    const p = new ProfilePage();
    rowOf(profileValues(p), 'Email').discard();
    await vi.waitFor(() => expect(rowOf(profileValues(p), 'Email').pend).toBe(false));
    expect(ui.toast).toMatchObject({ text: 'Change discarded', undo: true });
    expect(sent(calls).map((c) => c.call)).toEqual(['GET auth/me']);
    // Undo: nothing sent, the change is back.
    ui.toasts.undo();
    expect(rowOf(profileValues(p), 'Email').pend).toBe(true);
    expect(calls).toHaveLength(1);

    await p.discardChange();
    await ui.toasts.flush();
    expect(sent(calls).map((c) => c.call)).toEqual(['GET auth/me', 'GET auth/me', 'DELETE auth/me/email']);
    expect(session.user?.email_change).toBeNull();

    // Discarded elsewhere only after the toast appeared (404): counts as done.
    session.user = { ...ME, email_change: OPEN };
    await p.discardChange();
    await ui.toasts.flush();
    expect(session.user?.email_change).toBeNull();
    expect(ui.toast).toBeNull();
  });

  it('reverts the discard if the server rejects it', async () => {
    mockApi({
      'GET auth/me': [{ body: { ...ME, email_change: OPEN } }],
      'DELETE auth/me/email': [{ status: 500, body: {} }],
    });
    const p = new ProfilePage();
    await p.discardChange();
    await ui.toasts.flush();
    expect(session.user?.email_change).toEqual(OPEN);
    expect(ui.toast).toMatchObject({
      text: 'The change wasn’t applied. Please try again.',
      error: true,
    });
  });

  it('keeps the change and shows the error toast if `auth/me` cannot be read', async () => {
    const { calls } = mockApi({ 'GET auth/me': [{ status: 500, body: {} }] });
    const p = new ProfilePage();
    await p.discardChange();
    expect(rowOf(profileValues(p), 'Email').pend).toBe(true);
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true, undo: false });
    // No answer at all: `fetch` fails.
    await p.discardChange();
    expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
    await ui.toasts.flush();
    expect(session.user?.email_change).toEqual(OPEN);
    expect(sent(calls).map((c) => c.call)).toEqual(['GET auth/me', 'GET auth/me']);
  });
});

describe('edge cases', () => {
  it('sends a pending "Discard change" before the new link', async () => {
    session.user = { ...ME, email_change: OPEN };
    const { calls } = mockApi({
      'GET auth/me': [{ body: { ...ME, email_change: OPEN } }],
      'DELETE auth/me/email': [{ status: 204 }],
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { body: { status: 'email_sent', user: USER, email_change: { ...OPEN, email: 'two@example.com' } } },
      ],
    });
    const p = new ProfilePage();
    await p.discardChange();
    p.edit('email');
    p.setField('email', 'two@example.com');
    await p.save();
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET auth/me',
      'DELETE auth/me/email',
      'PATCH auth/me',
      'PATCH auth/me',
    ]);
    expect(session.user?.email_change?.email).toBe('two@example.com');
  });

  it('does not discard while "Resend link" is running', async () => {
    session.user = { ...ME, email_change: OPEN };
    let release: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({ 'POST auth/me/email/resend': [() => new Promise((resolve) => (release = resolve))] });
    const p = new ProfilePage();
    const resending = p.resend();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(rowOf(profileValues(p), 'Email').busy).toBe(true);
    await p.discardChange();
    expect(ui.toast).toBeNull();
    expect(calls).toHaveLength(1);
    release({ body: OPEN });
    await resending;
    expect(session.user?.email_change).toEqual(OPEN);
  });

  it('reports no link if the address already applies in the meantime', async () => {
    const { calls } = mockApi({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { body: { status: 'ok', user: { ...USER, email: 'new@example.com' } } },
      ],
      'GET auth/me': [{ body: { ...ME, email: 'new@example.com' } }],
    });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'new@example.com');
    await p.save();
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(ui.toast).toBeNull();
    expect(p.ea).toBeNull();
    await vi.waitFor(() => expect(calls.at(-1)?.method).toBe('GET'));
  });

  it('loads the account if the server requires a code the page did not ask for', async () => {
    const { calls } = mockApi({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { status: 422, body: { error: 'invalid', fields: { code: { code: 'required' } } } },
      ],
      'GET auth/me': [{ body: { ...ME, mfa_enabled: true } }],
    });
    const p = new ProfilePage();
    p.edit('email');
    p.setField('email', 'new@example.com');
    await p.save();
    p.setEaPw('Secret-123');
    await p.sendLink();
    expect(p.eaErr).toBe('The code must be 6 digits.');
    await vi.waitFor(() => expect(profileValues(p).eaFields).toHaveLength(2));
    expect(calls.at(-1)?.path).toBe('auth/me');
  });

  it('counts only changes that saving also sends; Escape counts as done', () => {
    const p = new ProfilePage();
    p.editName();
    p.setName('Max  Miller');
    expect(profileValues(p).nameDirty).toBe(false);
    p.blurName();
    expect(p.nameDraft).toBeNull();
    for (const handler of [
      (e: ReturnType<typeof key>) => p.nameKey(e),
      (e: ReturnType<typeof key>) => p.fieldKey('login', e),
      (e: ReturnType<typeof key>) => p.eaKey(e),
    ]) {
      const e = key('Escape');
      handler(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it('reloads the account after a failed discard', async () => {
    session.user = { ...ME, email_change: OPEN };
    const { calls } = mockApi({
      'DELETE auth/me/email': [{ status: 500, body: {} }],
      'GET auth/me': [{ body: { ...ME, email_change: OPEN } }, { body: { ...ME, email_change: OPEN } }],
    });
    await new ProfilePage().discardChange();
    await ui.toasts.flush();
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']));
    expect(ui.toast?.text).toBe('The change wasn’t applied. Please try again.');
  });
});
