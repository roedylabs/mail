import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { normalizeName } from '#lib/name.ts';
import { BRAND0, session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { DONE_MS, InviteFlow, STEP_REQUEST_MS, type InviteField, type InviteInfo } from './invite.svelte.ts';

const TOKEN = 'b'.repeat(43);
const INFO: InviteInfo = {
  email: 'jordan.hale@example.com',
  name: 'Jordan Hale',
  role: 'user',
  inviter: 'Alice Baker',
  expires_at: '2026-11-02T10:00:00.000Z',
  expired: false,
};
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ENROLL = { secret: SECRET, uri: `otpauth://totp/Roedy%20Mail:jordan.hale%40example.com?secret=${SECRET}` };
const USER = { id: '01K', username: 'jordan.hale', email: INFO.email, display_name: 'Jordan Hale', role: 'user' };
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD-EF${String(i).padStart(2, '2')}`);

const CONFIG: PublicConfig = {
  name: 'Acme Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
});

function hooks() {
  return {
    fail: vi.fn<(field?: InviteField) => void>(),
    focus: vi.fn<(field: InviteField) => void>(),
    missing: vi.fn<(field: InviteField) => void>(),
    accepted: vi.fn<(left: boolean) => void>(),
    signedIn: vi.fn(() => Promise.resolve(true)),
    error: vi.fn<(text: string) => void>(),
    offline: vi.fn<() => void>(),
  };
}

const show = `GET invites/${TOKEN}`;
const totp = `POST invites/${TOKEN}/totp`;
const accept = `POST invites/${TOKEN}/accept`;
const request = `POST invites/${TOKEN}/request`;

/** Loaded invitation in step 1. */
async function opened(routes: Parameters<typeof mockApi>[0] = {}, info: InviteInfo = INFO, h = hooks()) {
  const api = mockApi({ [show]: [{ body: info }], ...routes });
  const flow = new InviteFlow(h);
  await flow.open(TOKEN);
  return { flow, h, ...api };
}

/** Password and its confirmation. */
function setPw(flow: InviteFlow, value: string) {
  flow.editPw(value);
  flow.editPw2(value);
}

/** In step 3 with name, password and secret. */
async function atMfa(routes: Parameters<typeof mockApi>[0] = {}, h = hooks()) {
  const ctx = await opened({ [totp]: [{ body: ENROLL }], ...routes }, INFO, h);
  ctx.flow.accept();
  setPw(ctx.flow, 'Safe-enough1');
  await ctx.flow.submitName();
  return ctx;
}

describe('loading', () => {
  it('shows “Welcome” with the details of the invitation', async () => {
    const { flow, calls } = await opened();
    expect(calls[0]?.headers['X-Requested-With']).toBe('roedy-mail');
    expect(flow.status).toBe('ready');
    expect(flow.showS1).toBe(true);
    expect(flow.inviteFrom).toBe('Alice Baker');
    expect(flow.fromInitials).toBe('AB');
    expect(flow.inviteEmail).toBe('jordan.hale@example.com');
    expect(flow.roleName).toBe('User');
    expect(flow.untilLabel).toMatch(/2 November/);
    // Name prefilled from the invitation
    expect(flow.name).toBe('Jordan Hale');
  });

  it('names “Your administrator” without an inviter and administrators as such', async () => {
    const { flow } = await opened({}, { ...INFO, inviter: null, name: null, role: 'admin' });
    expect(flow.inviteFrom).toBe('your administrator');
    expect(flow.inviteFromSubject).toBe('Your administrator');
    expect(flow.roleName).toBe('Administrator');
    expect(flow.name).toBe('');
  });

  it('treats an empty inviter like a missing one', async () => {
    const { flow } = await opened({}, { ...INFO, inviter: '' });
    expect(flow.inviteFrom).toBe('your administrator');
    expect(flow.inviteFromSubject).toBe('Your administrator');
    expect(flow.fromInitials).toBe('R');
  });

  it('shows the first letter of the app name in the tile without an inviter', async () => {
    const none = { ...INFO, inviter: null };
    // Default app name "Roedy Mail".
    expect((await opened({}, none)).flow.fromInitials).toBe('R');
    session.config = { ...CONFIG, name: 'mira mail' };
    const { flow } = await opened({}, none);
    expect(flow.fromInitials).toBe('M');
    // The fallback text of the pill stays.
    expect(flow.inviteFrom).toBe('your administrator');
    session.config = { ...CONFIG, name: '  post' };
    expect(flow.fromInitials).toBe('P');
    // The whole first character, also outside the Basic Multilingual Plane.
    session.config = { ...CONFIG, name: ' \u{10428} Mail' };
    expect(flow.fromInitials).toBe('\u{10400}');
    // Without an app name "A".
    session.config = { ...CONFIG, name: '   ' };
    expect(flow.fromInitials).toBe('A');
    // With an inviter the initials of the name, whatever the app is called.
    session.config = { ...CONFIG, name: 'Zeta' };
    expect((await opened()).flow.fromInitials).toBe('AB');
  });

  it('shows expired invitations without steps', async () => {
    const { flow } = await opened({}, { ...INFO, expired: true });
    expect(flow.showExpired).toBe(true);
    expect(flow.form).toBe(false);
  });

  it('distinguishes unknown links, server errors and a missing connection', async () => {
    mockApi({
      [show]: [
        { status: 404, body: { error: 'not_found' } },
        { status: 500, body: { error: 'internal' } },
      ],
    });
    const flow = new InviteFlow(hooks());
    await flow.open(TOKEN);
    expect(flow.status).toBe('missing');
    await flow.load();
    expect(flow.status).toBe('failed');
    expect(flow.offline).toBe(false);
    // Retry: the error card stays until the response is there.
    let answer: (value: { body: InviteInfo }) => void = () => {};
    mockApi({ [show]: [() => new Promise((resolve) => (answer = resolve)), { status: 500, body: {} }] });
    const retry = flow.load();
    expect(flow.status).toBe('failed');
    expect(flow.retrying).toBe(true);
    answer({ body: INFO });
    await retry;
    expect(flow.status).toBe('ready');
    expect(flow.retrying).toBe(false);
    await flow.load();
    expect(flow.status).toBe('failed');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await flow.load();
    expect(flow.status).toBe('failed');
    expect(flow.offline).toBe(true);
  });

  it('discards the response of an earlier link', async () => {
    let answer: (value: { body: InviteInfo }) => void = () => {};
    mockApi({
      [show]: [() => new Promise((resolve) => (answer = resolve))],
      'GET invites/new': [{ body: { ...INFO, email: 'new@example.com' } }],
    });
    const flow = new InviteFlow(hooks());
    const first = flow.open(TOKEN);
    await flow.open('new');
    answer({ body: INFO });
    await first;
    expect(flow.inviteEmail).toBe('new@example.com');
  });
});

describe('step name and password', () => {
  it('prefills the name from the invitation while it is empty and keeps it over “Back”', async () => {
    const { flow, h } = await opened();
    flow.accept();
    expect(flow.showS2).toBe(true);
    expect(h.focus).toHaveBeenCalledWith('name');
    expect(flow.name).toBe('Jordan Hale');
    flow.editName('Sam Rivers');
    setPw(flow, 'Safe-enough1');
    flow.back();
    expect(flow.showS1).toBe(true);
    flow.accept();
    expect(flow.name).toBe('Sam Rivers');
    expect(flow.pw).toBe('Safe-enough1');
    expect(flow.pw2).toBe('Safe-enough1');
    flow.editName(' ');
    // Continue on the empty name, then Back: the prefilled name leaves no stale message.
    await flow.submitName();
    expect(flow.nameMsg).toBe('Please enter your name.');
    flow.back();
    flow.accept();
    expect(flow.name).toBe('Jordan Hale');
    expect(flow.nameMsg).toBeNull();
    expect(flow.s2Ready).toBe(true);
    // Without a name in the invitation the field stays empty.
    const other = await opened({}, { ...INFO, name: null });
    other.flow.accept();
    expect(other.flow.name).toBe('');
  });

  it('greys out Continue until the name is valid and all four chips are met', async () => {
    const { flow } = await opened();
    flow.accept();
    expect(flow.s2Ready).toBe(false);
    flow.editPw('Safe-enough1');
    expect(flow.pwOk).toBe(true);
    expect(flow.pwMatch).toBe(false);
    expect(flow.s2Ready).toBe(false);
    flow.editPw2('Safe-enough');
    expect(flow.s2Ready).toBe(false);
    flow.editPw2('Safe-enough1');
    expect(flow.pwMatch).toBe(true);
    expect(flow.s2Ready).toBe(true);
    // Checked while typing: the message goes as soon as the name fits again.
    flow.editName('Jordan (Sales)');
    expect(flow.nameMsg).toBe('The name contains invalid characters.');
    expect(flow.s2Ready).toBe(false);
    flow.editName('O’Brien-Núñez');
    expect(flow.nameMsg).toBeNull();
    expect(flow.s2Ready).toBe(true);
    flow.editName('   ');
    expect(flow.nameMsg).toBeNull();
    expect(flow.s2Ready).toBe(false);
    flow.editName('Jordan');
    // Over 1024 bytes: the message under the password while typing.
    setPw(flow, 'aA1' + '€'.repeat(400)); // fewer than 1024 characters, but more bytes
    expect(flow.pwMsg).toBe('The password is too long.');
    expect(flow.pwInvalid).toBe(true);
    expect(flow.s2Ready).toBe(false);
    setPw(flow, 'Safe-enough1');
    expect(flow.pwMsg).toBeNull();
    expect(flow.s2Ready).toBe(true);
  });

  it('moves Enter to the first field that is missing something, without a request', async () => {
    const { flow, h, calls } = await opened();
    flow.accept();
    // Empty name: its message with the shake.
    flow.editName('  ');
    await flow.submitName();
    expect(flow.nmErr).toBe('Please enter your name.');
    expect(flow.nameMsg).toBe('Please enter your name.');
    expect(h.fail).toHaveBeenLastCalledWith('name');
    flow.editName('Jordan');
    expect(flow.nameMsg).toBeNull();
    // Invalid name: shake and focus, the message is there already.
    flow.editName('Jordan2');
    h.fail.mockClear();
    await flow.submitName();
    expect(h.fail).toHaveBeenCalledExactlyOnceWith('name');
    expect(flow.nameMsg).toBe('The name contains invalid characters.');
    flow.editName('Jordan');
    // Password incomplete: only the focus, no message, no shake.
    h.fail.mockClear();
    flow.editPw('short');
    await flow.submitName();
    expect(h.missing).toHaveBeenLastCalledWith('pw');
    flow.editPw('Safe-enough1');
    await flow.submitName();
    expect(h.missing).toHaveBeenLastCalledWith('pw2');
    expect(h.fail).not.toHaveBeenCalled();
    expect(flow.pw2Msg).toBeNull();
    // A filled confirmation that differs: the mismatch with the shake.
    flow.editPw2('Safe-enough2');
    await flow.submitName();
    expect(flow.pw2Err).toBe(true);
    expect(flow.pw2Msg).toBe('The passwords don’t match.');
    expect(h.fail).toHaveBeenLastCalledWith('pw2');
    // Editing either password clears it.
    flow.editPw2('Safe-enough');
    expect(flow.pw2Msg).toBeNull();
    await flow.submitName();
    expect(flow.pw2Msg).not.toBeNull();
    flow.editPw('Safe-enough');
    expect(flow.pw2Msg).toBeNull();
    expect(flow.s2Ready).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('fetches the secret on Continue and shows it in groups of four with a QR code', async () => {
    const { flow, h, calls } = await atMfa();
    expect(calls.at(-1)?.method).toBe('POST');
    expect(flow.showS3).toBe(true);
    expect(flow.secretLabel).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(flow.qr?.size).toBeGreaterThanOrEqual(21);
    expect(flow.qr?.d.startsWith('M0 0h7v1h-7z')).toBe(true);
    expect(h.focus).toHaveBeenLastCalledWith('otp');
  });

  it('fetches a new secret on the next Continue after “Back”', async () => {
    const other = { secret: 'KRSXG5CTMVRXEZLU', uri: 'otpauth://totp/x?secret=KRSXG5CTMVRXEZLU' };
    const { flow, calls } = await atMfa({ [totp]: [{ body: ENROLL }, { body: other }] });
    flow.editOtp('12');
    flow.back();
    expect(flow.showS2).toBe(true);
    expect(flow.otp).toBe('');
    expect(flow.secret).toBe('');
    await flow.submitName();
    expect(calls.filter((c) => c.path.endsWith('/totp'))).toHaveLength(2);
    expect(flow.secretLabel).toBe('KRSX G5CT MVRX EZLU');
  });

  it('locks Continue after 429 with a bar that runs empty, the fields stay editable', async () => {
    vi.useFakeTimers();
    const { flow, h, calls } = await opened({
      [totp]: [
        { status: 429, body: { error: 'rate_limited', retry_after: 90 } },
        { status: 429, body: { error: 'rate_limited' } },
        { body: ENROLL },
      ],
    });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    await flow.submitName();
    expect(flow.linkLocked).toBe(true);
    expect(flow.linkLockText).toBe('Try again in 2 minutes.');
    expect(flow.linkLock).toEqual({ left: 90, total: 90 });
    expect(flow.s2Ready).toBe(false);
    expect(h.fail).toHaveBeenCalledWith();
    expect(flow.showS2).toBe(true);
    // Locked: editable, but Continue sends nothing.
    flow.editName('Jordan');
    await flow.submitName();
    expect(calls.filter((c) => c.path.endsWith('/totp'))).toHaveLength(1);
    vi.advanceTimersByTime(45_000);
    expect(flow.linkLockText).toBe('Try again in 45 seconds.');
    expect(flow.linkLock).toEqual({ left: 45, total: 90 });
    vi.advanceTimersByTime(45_000);
    expect(flow.linkLock).toBeNull();
    expect(flow.linkLockText).toBe('');
    expect(flow.s2Ready).toBe(true);
    // Without `retry_after`: 30 seconds.
    await flow.submitName();
    expect(flow.linkLock).toEqual({ left: 30, total: 30 });
    vi.advanceTimersByTime(30_000);
    await flow.submitName();
    expect(flow.showS3).toBe(true);
    flow.dispose();
  });

  it('shows “Saving …” and locks Back while the key is requested', async () => {
    let answer: (value: { body: unknown }) => void = () => {};
    const { flow } = await opened({ [totp]: [() => new Promise((resolve) => (answer = resolve))] });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    const done = flow.submitName();
    expect(flow.loading).toBe(true);
    expect(flow.busy).toBe(true);
    flow.back();
    expect(flow.showS2).toBe(true);
    answer({ body: ENROLL });
    await done;
    expect(flow.showS3).toBe(true);
  });

  it('ignores the key when the page was left meanwhile', async () => {
    let answer: (value: { body: unknown }) => void = () => {};
    const { flow } = await opened({ [totp]: [() => new Promise((resolve) => (answer = resolve))] });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    const done = flow.submitName();
    flow.dispose();
    answer({ body: ENROLL });
    await done;
    expect(flow.showS2).toBe(true);
    expect(flow.secret).toBe('');
  });

  it('wipes the passwords and the key when the invitation expired on Continue', async () => {
    const { flow } = await opened({ [totp]: [{ status: 422, body: { error: 'invite_expired' } }] });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    await flow.submitName();
    expect(flow.showExpired).toBe(true);
    expect(flow.pw).toBe('');
    expect(flow.pw2).toBe('');
    expect(flow.secret).toBe('');
  });

  it('shows other answers as the error toast and stays on the step', async () => {
    const { flow, h } = await opened({ [totp]: [{ status: 500, body: { error: 'internal' } }] });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    await flow.submitName();
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
    expect(flow.showS2).toBe(true);
    expect(flow.loading).toBe(false);
    expect(flow.pw2).toBe('Safe-enough1');
  });

  it('never writes the passwords to storage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const { flow } = await atMfa();
    flow.back();
    flow.editPw2('Safe-enough1');
    const stored = [localStorage, sessionStorage].flatMap((store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`),
    );
    expect(stored.join('\n')).not.toContain('Safe-enough1');
  });

  it('shows the error page if the invitation is gone meanwhile', async () => {
    const { flow } = await opened({ [totp]: [{ status: 404, body: { error: 'not_found' } }] });
    flow.accept();
    setPw(flow, 'Safe-enough1');
    await flow.submitName();
    expect(flow.status).toBe('missing');
  });
});

describe('step multi-factor', () => {
  it('sends six digits by itself and then shows the codes', async () => {
    const h = hooks();
    const { flow, calls } = await atMfa(
      { [accept]: [{ status: 201, body: { user: USER, recovery_codes: CODES } }] },
      h,
    );
    flow.editOtp('123 4');
    expect(flow.otp).toBe('1234');
    await flow.submitOtp();
    expect(flow.otpShort).toBe(true);
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    flow.editOtp('123 456');
    await vi.waitFor(() => expect(flow.showS4).toBe(true));
    expect(calls.at(-1)?.body).toEqual({ name: 'Jordan Hale', password: 'Safe-enough1', code: '123456' });
    expect(h.accepted).toHaveBeenCalledExactlyOnceWith(false);
    expect(flow.accepted).toBe(true);
    expect(flow.codes).toEqual(CODES);
    // Password and secret do not stay in memory.
    expect(flow.pw).toBe('');
    expect(flow.secret).toBe('');
    expect(flow.canBack).toBe(false);
  });

  it('reports a wrong code and locks after too many', async () => {
    const h = hooks();
    const { flow } = await atMfa(
      {
        [accept]: [
          { status: 422, body: { error: 'invalid_code' } },
          { status: 429, body: { error: 'rate_limited', retry_after: 900 } },
        ],
      },
      h,
    );
    flow.editOtp('000000');
    await vi.waitFor(() => expect(flow.otpBad).toBe(true));
    expect(flow.otp).toBe('');
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    flow.editOtp('111111');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    expect(flow.codeLockText).toBe('Try again in 15 minutes.');
    // Only "Invalid code." shows the error icon, not the lock.
    expect(flow.codeLockBtn).toBe('Confirm in 15:00');
    expect(flow.otpDis).toBe(true);
    flow.dispose();
  });

  it('goes back to step 2 on server field errors and keeps the secret', async () => {
    const h = hooks();
    const { flow, calls } = await atMfa(
      {
        [accept]: [
          {
            status: 422,
            body: { error: 'invalid', fields: { password: { code: 'policy', rules: ['case'] } } },
          },
        ],
      },
      h,
    );
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.showS2).toBe(true));
    expect(flow.pwErr).toBe('policy');
    expect(flow.pwBad).toEqual(['case']);
    expect(flow.pwInvalid).toBe(true);
    // The named rule counts as not met until the password is edited.
    expect(flow.pwOk).toBe(false);
    expect(flow.s2Ready).toBe(false);
    expect(h.fail).toHaveBeenLastCalledWith('pw');
    expect(flow.otp).toBe('');
    // The app already has the secret: "Continue" does not request a new one.
    expect(flow.secret).toBe(SECRET);
    setPw(flow, 'Even-safer2');
    expect(flow.pwBad).toEqual([]);
    await flow.submitName();
    expect(flow.showS3).toBe(true);
    expect(calls.filter((c) => c.path.endsWith('/totp'))).toHaveLength(1);
  });

  it('shows name errors in the line and other errors as a toast', async () => {
    const h = hooks();
    const { flow } = await atMfa(
      {
        [totp]: [{ body: ENROLL }, { body: ENROLL }],
        [accept]: [
          { status: 422, body: { error: 'invalid', fields: { name: { code: 'required' } } } },
          { status: 422, body: { error: 'invalid', fields: { name: { code: 'too_long' } } } },
          { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
          { status: 500, body: { error: 'internal' } },
        ],
      },
      h,
    );
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.showS2).toBe(true));
    expect(flow.nmErr).toBe('Please enter your name.');
    expect(h.fail).toHaveBeenLastCalledWith('name');
    // Too long or invalid characters according to the server: also at the name, no toast.
    for (const text of ['The name is too long.', 'The name contains invalid characters.']) {
      flow.editName('Jordan');
      await flow.submitName();
      expect(flow.showS3).toBe(true);
      flow.editOtp('123456');
      await vi.waitFor(() => expect(flow.showS2).toBe(true));
      expect(flow.nmErr).toBe(text);
      expect(h.fail).toHaveBeenLastCalledWith('name');
    }
    expect(h.error).not.toHaveBeenCalled();
    flow.editName('Jordan');
    await flow.submitName();
    expect(flow.showS3).toBe(true);
    flow.editOtp('123456');
    await vi.waitFor(() => expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.'));
    expect(flow.showS3).toBe(true);
  });

  it('checks length and invisible characters of the name before sending', async () => {
    const h = hooks();
    const { flow, calls } = await opened({}, INFO, h);
    flow.accept();
    setPw(flow, 'Safe-enough1');
    flow.editName('J'.repeat(101));
    await flow.submitName();
    expect(flow.nameMsg).toBe('The name is too long.');
    expect(h.fail).toHaveBeenLastCalledWith('name');
    flow.editName('Jordan\u200BHale');
    await flow.submitName();
    expect(flow.nameMsg).toBe('The name contains invalid characters.');
    expect(flow.showS2).toBe(true);
    // No call except loading the invitation.
    expect(calls).toHaveLength(1);
  });

  it('reports “No connection” for a request without an answer and keeps what was entered', async () => {
    const h = hooks();
    const { flow } = await atMfa({}, h);
    // No response for `accept`: `fetch` fails.
    flow.editOtp('123456');
    await vi.waitFor(() => expect(h.offline).toHaveBeenCalledTimes(1));
    expect(h.error).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
    expect(flow.showS3).toBe(true);
    expect(flow.otp).toBe('123456');
    expect(flow.pw).toBe('Safe-enough1');
  });

  it('reports “No connection” when Continue gets no answer in time', async () => {
    const ctrl = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ctrl.signal);
    const h = hooks();
    // The request ends through the signal `fetch` got, so the deadline must reach it.
    let sent: AbortSignal | null | undefined;
    const hang = () => {
      sent = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
      return new Promise<never>((_, reject) =>
        sent?.addEventListener('abort', () => reject(new DOMException('No answer', 'TimeoutError'))),
      );
    };
    const { flow } = await opened({ [totp]: [hang] }, INFO, h);
    flow.accept();
    setPw(flow, 'Safe-enough1');
    const done = flow.submitName();
    expect(flow.loading).toBe(true);
    expect(timeout).toHaveBeenCalledWith(STEP_REQUEST_MS);
    expect(sent).toBe(ctrl.signal);
    ctrl.abort(new DOMException('No answer', 'TimeoutError'));
    await done;
    expect(h.offline).toHaveBeenCalledTimes(1);
    expect(flow.loading).toBe(false);
    expect(flow.showS2).toBe(true);
    timeout.mockRestore();
  });

  it('reports “No connection” when Continue gets no answer', async () => {
    const h = hooks();
    const { flow } = await opened({ [totp]: [() => Promise.reject(new TypeError('Failed to fetch'))] }, INFO, h);
    flow.accept();
    setPw(flow, 'Safe-enough1');
    await flow.submitName();
    expect(h.offline).toHaveBeenCalledTimes(1);
    expect(h.error).not.toHaveBeenCalled();
    expect(flow.showS2).toBe(true);
    expect(flow.loading).toBe(false);
  });

  it('shows maintenance mode and expiry when confirming', async () => {
    const h = hooks();
    const { flow } = await atMfa(
      {
        [accept]: [
          { status: 503, body: { error: 'maintenance', message: 'Until 6 pm' } },
          { status: 422, body: { error: 'invite_expired' } },
        ],
      },
      h,
    );
    h.fail.mockClear();
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.maint).toEqual({ message: 'Until 6 pm' }));
    expect(flow.otp).toBe('');
    // A notice, not a mistake: the card does not shake.
    expect(h.fail).not.toHaveBeenCalled();
    flow.editOtp('654321');
    await vi.waitFor(() => expect(flow.showExpired).toBe(true));
    expect(flow.info?.expired).toBe(true);
  });

  it('waits with “Back” while the check is running', async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => {};
    const { flow } = await atMfa({ [accept]: [() => new Promise((resolve) => (answer = resolve))] });
    flow.editOtp('123456');
    expect(flow.busy).toBe(true);
    flow.back();
    expect(flow.showS3).toBe(true);
    answer({ status: 201, body: { user: USER, recovery_codes: CODES } });
    await vi.waitFor(() => expect(flow.showS4).toBe(true));
  });

  it('reports a created account even after leaving the page', async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => {};
    const h = hooks();
    const { flow } = await atMfa({ [accept]: [() => new Promise((resolve) => (answer = resolve))] }, h);
    flow.editOtp('123456');
    flow.dispose();
    answer({ status: 201, body: { user: USER, recovery_codes: CODES } });
    // The page then loads the new session although nobody sees the codes.
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledExactlyOnceWith(true));
    expect(flow.showS4).toBe(false);
  });

  it('sends the name the way the backend accepts it', async () => {
    const { flow, calls } = await atMfa({ [accept]: [{ status: 201, body: { user: USER, recovery_codes: CODES } }] });
    expect(normalizeName('  Max\tExample \n ')).toBe('Max Example');
    flow.back();
    flow.editName('Jordan\tHale');
    await flow.submitName();
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.showS4).toBe(true));
    expect(calls.at(-1)?.body).toMatchObject({ name: 'Jordan Hale' });
  });
});

describe('step recovery codes', () => {
  async function atCodes(h = hooks()) {
    const ctx = await atMfa({ [accept]: [{ status: 201, body: { user: USER, recovery_codes: CODES } }] }, h);
    ctx.flow.editOtp('123456');
    await vi.waitFor(() => expect(ctx.flow.showS4).toBe(true));
    return ctx;
  }

  it('requires the confirmation and redirects after “Welcome”', async () => {
    const h = hooks();
    const { flow, calls } = await atCodes(h);
    vi.useFakeTimers();
    const before = calls.length;
    flow.finish();
    expect(flow.savedShown).toBe(true);
    expect(h.fail).toHaveBeenCalled();
    flow.toggleSaved();
    expect(flow.savedShown).toBe(false);
    flow.finish();
    expect(flow.showDone).toBe(true);
    expect(flow.firstName).toBe('Jordan');
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(h.signedIn).toHaveBeenCalledOnce();
    // "Activate account" no longer asks the server: the account already exists.
    expect(calls).toHaveLength(before);
  });

  it('goes back to the codes if the session does not arrive', async () => {
    const h = hooks();
    h.signedIn.mockResolvedValue(false);
    const { flow } = await atCodes(h);
    vi.useFakeTimers();
    flow.toggleSaved();
    flow.finish();
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(flow.showS4).toBe(true);
    expect(h.error).toHaveBeenCalledWith('Couldn’t sign in. Allow cookies for this site and try again.');
  });
});

describe('expired', () => {
  it('requests a new invitation', async () => {
    const { flow, calls } = await opened({ [request]: [{ status: 202 }] }, { ...INFO, expired: true });
    await flow.request();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `invites/${TOKEN}/request` });
    expect(flow.showRequested).toBe(true);
  });

  it('reloads if the invitation applies again meanwhile, and reports locks', async () => {
    const { flow } = await opened(
      {
        [request]: [
          { status: 429, body: { error: 'rate_limited', retry_after: 60 } },
          { status: 422, body: { error: 'invite_valid' } },
        ],
        [show]: [{ body: { ...INFO, expired: true } }, { body: INFO }],
      },
      { ...INFO, expired: true },
    );
    await flow.request();
    expect(flow.linkLocked).toBe(true);
    expect(flow.linkLockText).toBe('Try again in 1 minute.');
    expect(flow.reqLockBtn).toBe('Request a new invitation in 1:00');
    flow.locks.clear('link');
    await flow.request();
    await vi.waitFor(() => expect(flow.showS1).toBe(true));
    expect(flow.expired).toBe(false);
    flow.dispose();
  });
});
