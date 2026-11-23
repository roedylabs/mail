import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { session } from '#lib/state/session.svelte.ts';
import { DONE_MS, LoginFlow, formatOtp, formatRecovery, type Field } from './login.svelte.ts';

const USER = { id: '01J', username: 'max', email: 'max@example.net', display_name: 'Max Example', role: 'user' };
const TOKEN = 'a'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hooks() {
  return {
    fail: vi.fn<(field?: Field) => void>(),
    focus: vi.fn<(field: Field) => void>(),
    missing: vi.fn<(field: Field) => void>(),
    unlocked: vi.fn<(field: Field) => void>(),
    navigate: vi.fn<(to: 'login' | 'forgot') => void>(),
    home: vi.fn(),
    signedIn: vi.fn(() => Promise.resolve(true)),
    signOut: vi.fn(),
    passwordReset: vi.fn(),
    error: vi.fn<(text: string) => void>(),
    offline: vi.fn(),
  };
}

/** Flow with identifier and password in the password step. */
function filled(h = hooks()) {
  const flow = new LoginFlow(h);
  flow.editIdent('max@example.net');
  flow.editPw('Safe-enough1');
  return { flow, h };
}

/** Flow in the code step (after `totp_required`). */
async function atCode(h = hooks()) {
  mockApi({ 'POST auth/login': [{ body: { status: 'totp_required' } }] });
  const { flow } = filled(h);
  await flow.submit();
  return { flow, h };
}

describe('helpers', () => {
  it('formats the authenticator code and the recovery code', () => {
    expect(formatOtp('12 34-567')).toBe('123456');
    expect(formatRecovery('abcd')).toBe('ABCD');
    expect(formatRecovery('abcd efgh x')).toBe('ABCD-EFGH');
    expect(formatRecovery('ab-c')).toBe('ABC');
  });
});

describe('step password', () => {
  it('requires identifier and password before asking', async () => {
    const h = hooks();
    const { calls } = mockApi({});
    const flow = new LoginFlow(h);
    await flow.submit();
    expect(flow.idErr).toBe('Please enter your email address or username.');
    expect(flow.pwErr).toBe('Please enter your password.');
    expect(h.fail).toHaveBeenCalledWith('id');
    flow.editIdent('max');
    expect(flow.idErr).toBeNull();
    flow.editPw('é'.repeat(513));
    await flow.submit();
    expect(flow.pwErr).toBe('The password is too long.');
    expect(h.fail).toHaveBeenLastCalledWith('pw');
    expect(calls).toHaveLength(0);
  });

  it('reports wrong credentials and clears the password', async () => {
    const { calls } = mockApi({ 'POST auth/login': [{ status: 422, body: { error: 'invalid_credentials' } }] });
    const { flow, h } = filled();
    flow.toggleRemember();
    await flow.submit();
    expect(calls[0]?.body).toEqual({ login: 'max@example.net', password: 'Safe-enough1', remember: false });
    expect(flow.authErr).toBe(true);
    expect(flow.pw).toBe('');
    expect(flow.ident).toBe('max@example.net');
    expect(flow.phase(null, false)).toBe('error');
    expect(h.fail).toHaveBeenCalledWith('pw');
  });

  it('locks after 429 with a countdown, the fields stay editable', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ status: 429, body: { error: 'rate_limited', retry_after: 300 } }] });
    const { flow, h } = filled();
    await flow.submit();
    expect(flow.pwLocked).toBe(true);
    expect(flow.pwLockText).toBe('Try again in 5 minutes.');
    // The lock bar: full at the answer, empty at `retry_after`.
    expect(flow.pwLock).toEqual({ left: 300, total: 300 });
    expect(flow.authErr).toBe(false);
    expect(flow.pw).toBe('');
    expect(h.fail).toHaveBeenCalledWith('pw');
    flow.editPw('once-more');
    expect(flow.pw).toBe('once-more');
    // Locked: a submit sends nothing.
    await flow.submit();
    expect(flow.loading).toBe(false);
    vi.advanceTimersByTime(275_000);
    expect(flow.pwLockText).toBe('Try again in 25 seconds.');
    expect(flow.pwLock).toEqual({ left: 25, total: 300 });
    expect(h.unlocked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25_000);
    expect(flow.pwLocked).toBe(false);
    expect(flow.pwLock).toBeNull();
    expect(flow.pwLockText).toBe('');
    // Ran out: the message goes and the password field may take the focus.
    expect(h.unlocked).toHaveBeenCalledWith('pw');
  });

  it('keeps “Stay signed in” while the sign-in runs', async () => {
    let answer: (value: { body: unknown }) => void = () => undefined;
    mockApi({ 'POST auth/login': [() => new Promise((resolve) => (answer = resolve))] });
    const { flow } = filled();
    const sent = flow.submit();
    flow.toggleRemember();
    expect(flow.remember).toBe(true);
    answer({ body: { status: 'ok', user: USER } });
    await sent;
    expect(flow.done).toBe(true);
    expect(flow.remember).toBe(true);
    flow.reset();
    flow.toggleRemember();
    expect(flow.remember).toBe(false);
  });

  it('shows “No connection” without an answer, everything typed stays', async () => {
    mockApi({});
    const { flow, h } = filled();
    await flow.submit();
    expect(h.offline).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    expect(flow.loading).toBe(false);
    expect(flow.ident).toBe('max@example.net');
    expect(flow.pw).toBe('Safe-enough1');
    expect(flow.authErr).toBe(false);
  });

  it('reports a busy server as an error toast, the input stays', async () => {
    mockApi({ 'POST auth/login': [{ status: 503, body: { error: 'busy' } }] });
    const { flow, h } = filled();
    await flow.submit();
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
    expect(h.offline).not.toHaveBeenCalled();
    expect(flow.pw).toBe('Safe-enough1');
  });

  it('clears the failed and expired notices on a rejected submit', async () => {
    mockApi({ 'POST auth/login': [{ status: 422, body: { error: 'invalid_credentials' } }] });
    const { flow } = filled();
    await flow.submit();
    expect(flow.authErr).toBe(true);
    flow.loginExpired = true;
    // Typing keeps the messages until the next submit.
    flow.editIdent('');
    expect(flow.authErr).toBe(true);
    await flow.submit();
    expect(flow.authErr).toBe(false);
    expect(flow.loginExpired).toBe(false);
    expect(flow.idErr).toBe('Please enter your email address or username.');
    expect(flow.pwErr).toBe('Please enter your password.');
  });

  it('reports maintenance mode with the custom notice', async () => {
    mockApi({
      'POST auth/login': [
        { status: 503, body: { error: 'maintenance', message: 'Until 2 pm' } },
        { status: 503, body: { error: 'maintenance' } },
      ],
    });
    const noted = vi.spyOn(session, 'noteMaintenance');
    const { flow, h } = filled();
    await flow.submit();
    expect(noted).toHaveBeenLastCalledWith('Until 2 pm');
    expect(flow.pw).toBe('Safe-enough1');
    expect(h.fail).toHaveBeenCalledWith('pw');
    await flow.submit();
    expect(noted).toHaveBeenLastCalledWith(null);
  });

  it('shows “Hello, ‹first name›” and reports the sign-in afterwards', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: USER } }] });
    const { flow, h } = filled();
    await flow.submit();
    expect(flow.done).toBe(true);
    expect(flow.greetName).toBe('Max');
    expect(flow.pw).toBe('');
    expect(flow.phase(null, false)).toBe('success');
    vi.advanceTimersByTime(DONE_MS - 1);
    expect(h.signedIn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.signedIn).toHaveBeenCalledOnce();
  });

  it('“Back to sign-in” after sign-in ends the new session', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: USER } }] });
    const { flow, h } = filled();
    await flow.submit();
    flow.reset();
    expect(flow.done).toBe(false);
    expect(h.signOut).toHaveBeenCalledOnce();
    // The form with the identifier, the password cleared, the focus in the password field.
    expect(flow.view).toBe('login');
    expect(flow.ident).toBe('max@example.net');
    expect(flow.pw).toBe('');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
    vi.advanceTimersByTime(DONE_MS);
    expect(h.signedIn).not.toHaveBeenCalled();
  });

  it('ends the new session also on “Back” in the browser during “Hello”', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: USER } }] });
    const { flow, h } = filled();
    await flow.submit();
    flow.route({ kind: 'forgot' });
    expect(flow.done).toBe(false);
    expect(flow.view).toBe('forgot');
    expect(h.signOut).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(DONE_MS);
    expect(h.signedIn).not.toHaveBeenCalled();
  });

  it('keeps “Hello” as soon as account and settings load', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: USER } }] });
    const h = hooks();
    let loaded: (ok: boolean) => void = () => undefined;
    h.signedIn.mockImplementation(() => new Promise<boolean>((resolve) => (loaded = resolve)));
    const { flow } = filled(h);
    await flow.submit();
    vi.advanceTimersByTime(DONE_MS);
    expect(h.signedIn).toHaveBeenCalledOnce();
    flow.reset();
    flow.route({ kind: 'forgot' });
    flow.dispose();
    expect(flow.done).toBe(true);
    expect(h.signOut).not.toHaveBeenCalled();
    loaded(true);
  });

  it('goes back to the form and names cookies if the account is not signed in afterwards', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: USER } }] });
    const h = hooks();
    h.signedIn.mockResolvedValue(false);
    const { flow } = filled(h);
    await flow.submit();
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(flow.done).toBe(false);
    expect(flow.view).toBe('login');
    expect(h.error).toHaveBeenCalledWith('Couldn’t sign in. Allow cookies for this site and try again.');
    expect(flow.ident).toBe('max@example.net');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
  });

  it('greets with the part before the “@” without a name', async () => {
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: { ...USER, display_name: '  ' } } }] });
    const { flow } = filled();
    await flow.submit();
    expect(flow.greetName).toBe('Max');
    flow.reset();
    flow.editIdent('anna');
    expect(flow.greetName).toBe('Anna');
  });

  it('signs out a session whose response only arrives after leaving', async () => {
    let answer: (value: { body: unknown }) => void = () => undefined;
    mockApi({ 'POST auth/login': [() => new Promise((resolve) => (answer = resolve))] });
    const { flow, h } = filled();
    const pending = flow.submit();
    flow.dispose();
    answer({ body: { status: 'ok', user: USER } });
    await pending;
    expect(flow.done).toBe(false);
    expect(h.signOut).toHaveBeenCalledOnce();
  });

  it('does not change the step while a request is running', async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => undefined;
    mockApi({ 'POST auth/login': [() => new Promise((resolve) => (answer = resolve))] });
    const { flow, h } = filled();
    const pending = flow.submit();
    expect(flow.busy).toBe(true);
    flow.openForgot();
    expect(flow.view).toBe('login');
    expect(h.navigate).not.toHaveBeenCalled();
    answer({ status: 422, body: { error: 'invalid_credentials' } });
    await pending;
    expect(flow.authErr).toBe(true);
  });

  it('names a too long identifier like wrong credentials', async () => {
    mockApi({
      'POST auth/login': [{ status: 422, body: { error: 'invalid', fields: { login: { code: 'too_long' } } } }],
    });
    const { flow } = filled();
    await flow.submit();
    expect(flow.authErr).toBe(true);
    expect(flow.pw).toBe('');
  });

  it('names the part of the identifier before the "@" without a display name', async () => {
    mockApi({ 'POST auth/login': [{ body: { status: 'ok', user: { ...USER, display_name: '' } } }] });
    const { flow } = filled();
    await flow.submit();
    expect(flow.greetName).toBe('Max');
    flow.dispose();
  });

  it('goes to the code step with active multi-factor', async () => {
    const { flow, h } = await atCode();
    expect(flow.view).toBe('otp');
    expect(flow.stepAt).toBeGreaterThan(0);
    expect(h.focus).toHaveBeenCalledWith('otp');
  });

  it('reports other errors via toast, without a connection with its own text', async () => {
    mockApi({ 'POST auth/login': [{ status: 500, body: {} }] });
    const { flow, h } = filled();
    await flow.submit();
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
    expect(flow.loading).toBe(false);
    // Without a server response (`fetch` fails) and without "No connection" on the page: its own text.
    const rest: Partial<ReturnType<typeof hooks>> = hooks();
    delete rest.offline;
    const bare = new LoginFlow(rest);
    bare.editIdent('max');
    bare.editPw('Safe-enough1');
    mockApi({});
    await bare.submit();
    expect(rest.error).toHaveBeenLastCalledWith('No connection. Please try again.');
    expect(bare.loading).toBe(false);
  });
});

describe('resend', () => {
  it('reports a resend without an answer only while “Email sent” is open', async () => {
    mockApi({ 'POST auth/password/forgot': [{ status: 202 }] });
    const h = hooks();
    const flow = new LoginFlow(h);
    flow.openForgot();
    flow.editEmail('max@example.net');
    await flow.submitForgot();
    expect(flow.view).toBe('sent');
    flow.locks.clear('resend');
    let fail: (error: Error) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((_, reject) => (fail = reject))),
    );
    const sent = flow.resend();
    flow.backToLogin();
    fail(new TypeError('Failed to fetch'));
    await sent;
    expect(h.offline).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
    // Still on "Email sent": "No connection".
    flow.openForgot();
    flow.editEmail('max@example.net');
    mockApi({ 'POST auth/password/forgot': [{ status: 202 }] });
    await flow.submitForgot();
    flow.locks.clear('resend');
    mockApi({});
    await flow.resend();
    expect(h.offline).toHaveBeenCalledOnce();
  });
});

describe('steps code and recovery code', () => {
  it('requires six digits and sends by itself on the sixth', async () => {
    const { flow, h } = await atCode();
    const { calls } = mockApi({ 'POST auth/totp': [{ body: { status: 'ok', user: USER } }] });
    await flow.submitOtp();
    expect(flow.otpErr).toBe('short');
    expect(h.fail).toHaveBeenCalledWith('otp');
    flow.editOtp('12a345');
    expect(flow.otp).toBe('12345');
    expect(calls).toHaveLength(0);
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.done).toBe(true));
    expect(calls[0]?.body).toEqual({ code: '123456' });
    flow.dispose();
  });

  it('reports wrong and already used codes', async () => {
    const { flow, h } = await atCode();
    mockApi({
      'POST auth/totp': [
        { status: 422, body: { error: 'invalid_code' } },
        { status: 422, body: { error: 'code_used' } },
      ],
    });
    flow.editOtp('111111');
    await vi.waitFor(() => expect(flow.otpErr).toBe('invalid'));
    expect(flow.otp).toBe('');
    expect(flow.phase('otp', false)).toBe('error');
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    flow.editOtp('222222');
    await vi.waitFor(() => expect(flow.otpErr).toBe('used'));
    expect(flow.otp).toBe('');
  });

  it('reports a used recovery code as invalid', async () => {
    const { flow } = await atCode();
    flow.useBackup();
    expect(flow.view).toBe('backup');
    const { calls } = mockApi({ 'POST auth/recovery': [{ status: 422, body: { error: 'code_used' } }] });
    await flow.submitBc();
    expect(flow.bcErr).toBe('short');
    flow.editBc('abcd-efgh');
    await vi.waitFor(() => expect(flow.bcErr).toBe('invalid'));
    expect(calls[0]?.body).toEqual({ code: 'ABCD-EFGH' });
    expect(flow.bc).toBe('');
  });

  it('locks both steps after 429; beyond the intermediate step from the start', async () => {
    vi.useFakeTimers();
    const { flow, h } = await atCode();
    mockApi({ 'POST auth/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }] });
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    expect(flow.codeLockText).toBe('Try again in 15 minutes. After that, enter your password again.');
    expect(flow.codeLock).toEqual({ left: 900, total: 900 });
    expect(flow.otp).toBe('');
    // A code while locked sends nothing.
    flow.editOtp('123456');
    await flow.submitOtp();
    expect(flow.otpLoading).toBe(false);
    flow.useBackup();
    expect(flow.codeLocked).toBe(true);
    vi.advanceTimersByTime(300_000);
    expect(flow.codeLock).toEqual({ left: 600, total: 900 });
    flow.useApp();
    expect(h.unlocked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600_000);
    expect(flow.codeLocked).toBe(false);
    expect(flow.codeLock).toBeNull();
    expect(h.unlocked).toHaveBeenLastCalledWith('otp');
    flow.dispose();
  });

  it('names only the wait time for short locks (limit per IP address)', async () => {
    vi.useFakeTimers();
    const { flow } = await atCode();
    mockApi({ 'POST auth/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }] });
    flow.editOtp('654321');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    expect(flow.codeLockText).toBe('Try again in 30 seconds.');
    expect(flow.codeLock).toEqual({ left: 30, total: 30 });
    expect(flow.phase('otp', false)).toBe('locked');
    flow.dispose();
  });

  it('goes back to the password with a notice on login_expired', async () => {
    const { flow, h } = await atCode();
    mockApi({ 'POST auth/totp': [{ status: 422, body: { error: 'login_expired' } }] });
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.view).toBe('login'));
    expect(flow.loginExpired).toBe(true);
    expect(flow.ident).toBe('max@example.net');
    expect(flow.pw).toBe('');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
    mockApi({ 'POST auth/login': [{ status: 422, body: { error: 'invalid_credentials' } }] });
    flow.editPw('wrong');
    await flow.submit();
    expect(flow.loginExpired).toBe(false);
  });

  it('“Back to sign-in” waits for the response of the code', async () => {
    const { flow, h } = await atCode();
    let answer: (value: { status: number; body: unknown }) => void = () => undefined;
    mockApi({ 'POST auth/totp': [() => new Promise((resolve) => (answer = resolve))] });
    flow.editOtp('123456');
    flow.leaveOtp();
    flow.useBackup();
    expect(flow.view).toBe('otp');
    answer({ status: 422, body: { error: 'invalid_code' } });
    await vi.waitFor(() => expect(flow.otpErr).toBe('invalid'));
    flow.leaveOtp();
    expect(flow.view).toBe('login');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
  });
});

describe('reset password', () => {
  it('takes the identifier from “Forgot password?” and changes the route', () => {
    const { flow, h } = filled();
    flow.openForgot();
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('max@example.net');
    expect(h.navigate).toHaveBeenCalledWith('forgot');
    // The route follows; the step stays.
    flow.route({ kind: 'forgot' });
    expect(flow.ident).toBe('max@example.net');
  });

  it('opens /password/forgot directly with an empty field', () => {
    const { flow, h } = filled();
    flow.route({ kind: 'forgot' });
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('');
    expect(h.focus).toHaveBeenCalledWith('fg');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('checks the address and then always shows “Email sent”', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({ 'POST auth/password/forgot': [{ status: 202 }, { status: 202 }] });
    const h = hooks();
    const flow = new LoginFlow(h);
    flow.route({ kind: 'forgot' });
    await flow.submitForgot();
    expect(flow.fgErr).toBe('Please enter your email address.');
    flow.editEmail('max@');
    await flow.submitForgot();
    expect(flow.fgErr).toBe('Please enter a valid email address.');
    expect(calls).toHaveLength(0);
    flow.editEmail(' max@example.net ');
    await flow.submitForgot();
    expect(calls[0]?.body).toEqual({ email: 'max@example.net' });
    expect(flow.view).toBe('sent');
    expect(flow.sentTo).toBe('max@example.net');
    expect(flow.phase(null, false)).toBe('sent');
    expect(flow.resendLabel).toBe('Resend in 0:30');
    expect(flow.resendBlocked).toBe(true);
    await flow.resend();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(flow.resendLabel).toBe('Resend');
    await flow.resend();
    expect(calls).toHaveLength(2);
    expect(flow.resendLabel).toBe('Resend in 0:30');
    expect(flow.resendLimited).toBe(false);
    flow.dispose();
  });

  it('locks “Send link” and “Resend” after 429', async () => {
    vi.useFakeTimers();
    mockApi({
      'POST auth/password/forgot': [
        { status: 429, body: { error: 'rate_limited', retry_after: 360 } },
        { status: 202 },
        { status: 429, body: { error: 'rate_limited', retry_after: 360 } },
      ],
    });
    const h = hooks();
    const flow = new LoginFlow(h);
    flow.route({ kind: 'forgot' });
    flow.editEmail('max@example.net');
    await flow.submitForgot();
    expect(flow.fgLocked).toBe(true);
    expect(flow.fgLockText).toBe('Try again in 6 minutes.');
    expect(flow.fgLock).toEqual({ left: 360, total: 360 });
    vi.advanceTimersByTime(60_000);
    expect(flow.fgLock).toEqual({ left: 300, total: 360 });
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('max@example.net');
    expect(h.fail).toHaveBeenCalledWith();
    vi.advanceTimersByTime(300_000);
    expect(flow.fgLocked).toBe(false);
    expect(flow.fgLock).toBeNull();
    await flow.submitForgot();
    expect(flow.view).toBe('sent');
    vi.advanceTimersByTime(30_000);
    await flow.resend();
    expect(flow.resendLabel).toBe('Resend in 6:00');
    expect(flow.resendBlocked).toBe(true);
    expect(flow.resendLimited).toBe(true);
    expect(flow.resendLimitText).toBe('Try again in 6 minutes.');
    vi.advanceTimersByTime(360_000);
    expect(flow.resendLimited).toBe(false);
    expect(flow.resendLabel).toBe('Resend');
    flow.dispose();
  });

  it('names and resends the address the request sent, not one typed while it ran', async () => {
    vi.useFakeTimers();
    let answer: () => void = () => undefined;
    const { calls } = mockApi({
      'POST auth/password/forgot': [
        () => new Promise<{ status: number }>((resolve) => (answer = () => resolve({ status: 202 }))),
        { status: 202 },
      ],
    });
    const flow = new LoginFlow(hooks());
    flow.route({ kind: 'forgot' });
    flow.editEmail(' max@example.net ');
    const sending = flow.submitForgot();
    flow.editEmail('other@example.net');
    answer();
    await sending;
    expect(flow.view).toBe('sent');
    expect(flow.sentTo).toBe('max@example.net');
    vi.advanceTimersByTime(30_000);
    await flow.resend();
    expect(calls.map((c) => c.body)).toEqual([{ email: 'max@example.net' }, { email: 'max@example.net' }]);
    flow.dispose();
  });

  it('blocks “Resend” while it runs and starts the countdown again', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST auth/password/forgot': [{ status: 202 }] });
    const flow = new LoginFlow(hooks());
    flow.route({ kind: 'forgot' });
    flow.editEmail('max@example.net');
    await flow.submitForgot();
    vi.advanceTimersByTime(30_000);
    expect(flow.resendBlocked).toBe(false);
    let answer: (res: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetch);
    const running = flow.resend();
    expect(flow.resending).toBe(true);
    expect(flow.resendBlocked).toBe(true);
    expect(flow.resendLabel).toBe('Resend');
    // A second press while it runs sends nothing.
    await flow.resend();
    expect(fetch).toHaveBeenCalledOnce();
    answer(new Response(null, { status: 202 }));
    await running;
    expect(flow.resending).toBe(false);
    expect(flow.resendLabel).toBe('Resend in 0:30');
    expect(flow.resendLimited).toBe(false);
    flow.dispose();
  });

  it('leads back to sign-in or, when signed in, to the start page', () => {
    const { flow, h } = filled();
    flow.openForgot();
    flow.fgBack(true);
    expect(h.home).toHaveBeenCalledOnce();
    flow.fgBack(false);
    expect(flow.view).toBe('login');
    expect(h.navigate).toHaveBeenLastCalledWith('login');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
  });

  it('goes to sign-in on “Back” in the browser without a new navigation', () => {
    const { flow, h } = filled();
    flow.openForgot();
    h.navigate.mockClear();
    flow.route({ kind: 'login' });
    expect(flow.view).toBe('login');
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe('set a new password', () => {
  function atNewPw(h = hooks()) {
    const flow = new LoginFlow(h);
    flow.route({ kind: 'newpw', token: TOKEN });
    return { flow, h };
  }

  /** Both passwords filled in, ready to save. */
  function ready(h = hooks()) {
    const { flow } = atNewPw(h);
    flow.editNp('New-password1');
    flow.editNp2('New-password1');
    return { flow, h };
  }

  it('opens the step from the link, focusing the new password', () => {
    const { flow, h } = atNewPw();
    expect(flow.view).toBe('newpw');
    expect(flow.np).toBe('');
    expect(flow.np2).toBe('');
    expect(flow.npReady).toBe(false);
    expect(h.focus).toHaveBeenCalledWith('np');
  });

  it('is ready once all four chips are met and the password fits', () => {
    const { flow } = atNewPw();
    flow.editNp('short');
    flow.editNp2('short');
    expect([flow.npOk, flow.npMatch, flow.npReady]).toEqual([false, true, false]);
    flow.editNp('New-password1');
    expect([flow.npOk, flow.npMatch, flow.npReady]).toEqual([true, false, false]);
    flow.editNp2('New-password1');
    expect(flow.npReady).toBe(true);
    // Over 1024 bytes: the message at once, not ready; it goes as soon as the password fits.
    const long = `Aa1${'ü'.repeat(511)}`;
    flow.editNp(long);
    flow.editNp2(long);
    expect(flow.npMsg).toBe('The password is too long.');
    expect(flow.npReady).toBe(false);
    flow.editNp('New-password1');
    expect(flow.npMsg).toBeNull();
  });

  it('moves to the field that is missing something, without a request', async () => {
    const { calls } = mockApi({});
    const { flow, h } = atNewPw();
    await flow.submitNp();
    expect(h.missing).toHaveBeenLastCalledWith('np');
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(h.missing).toHaveBeenLastCalledWith('np2');
    expect(flow.np2Msg).toBeNull();
    expect(h.fail).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('shows the mismatch under a filled confirmation that differs; editing either clears it', async () => {
    const { calls } = mockApi({});
    const { flow, h } = atNewPw();
    flow.editNp('New-password1');
    flow.editNp2('New-password2');
    await flow.submitNp();
    expect(flow.np2Msg).toBe('The passwords don’t match.');
    expect(h.fail).toHaveBeenCalledWith('np2');
    flow.editNp2('New-password');
    expect(flow.np2Msg).toBeNull();
    await flow.submitNp();
    expect(flow.np2Msg).not.toBeNull();
    flow.editNp('New-password');
    expect(flow.np2Msg).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports “Password changed” without sign-in, the passwords cleared', async () => {
    const { calls } = mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 2 } }],
    });
    const { flow, h } = ready();
    const pending = flow.submitNp();
    expect(flow.npLoading).toBe(true);
    await pending;
    expect(calls[0]?.body).toEqual({ password: 'New-password1' });
    expect(flow.view).toBe('pwdone');
    expect(flow.pwDoneEnded).toBe(true);
    expect([flow.np, flow.np2]).toEqual(['', '']);
    expect(h.passwordReset).toHaveBeenCalledOnce();
    flow.pwDoneLogin();
    expect(flow.view).toBe('login');
    expect(flow.ident).toBe('');
    expect(flow.pw).toBe('');
    expect(h.navigate).toHaveBeenCalledWith('login');
    expect(h.focus).toHaveBeenLastCalledWith('id');
  });

  it('names signed-out devices only if there were any', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 0 } }] });
    const { flow } = ready();
    await flow.submitNp();
    expect(flow.view).toBe('pwdone');
    expect(flow.pwDoneEnded).toBe(false);
  });

  it('reports a changed password also after “Back” in the browser', async () => {
    let answer: (value: { body: unknown }) => void = () => undefined;
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [() => new Promise((resolve) => (answer = resolve))] });
    const { flow, h } = ready();
    const pending = flow.submitNp();
    flow.backToLogin();
    expect(flow.view).toBe('newpw');
    flow.route({ kind: 'login' });
    answer({ body: { status: 'ok', sessions_ended: 1 } });
    await pending;
    expect(h.passwordReset).toHaveBeenCalledOnce();
    expect(flow.view).toBe('login');
  });

  it('shows “Link expired or invalid”, the passwords discarded, and requests a new one', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }] });
    const { flow, h } = ready();
    await flow.submitNp();
    expect(flow.view).toBe('linkbad');
    expect([flow.np, flow.np2]).toEqual(['', '']);
    expect(flow.phase(null, false)).toBe('linkbad');
    flow.ident = 'old@example.com';
    flow.reqNewLink();
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('');
    expect(h.navigate).toHaveBeenCalledWith('forgot');
    expect(h.focus).toHaveBeenLastCalledWith('fg');
  });

  it('goes back to sign-in from “Link expired or invalid” with the identifier kept', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }] });
    const { flow, h } = ready();
    flow.ident = 'max@example.net';
    await flow.submitNp();
    flow.backToLogin();
    expect(flow.view).toBe('login');
    expect(flow.ident).toBe('max@example.net');
    expect(h.navigate).toHaveBeenLastCalledWith('login');
    expect(h.focus).toHaveBeenLastCalledWith('pw');
  });

  it('takes over the rules of the server until the password is edited, and “too long”', async () => {
    mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'policy', rules: ['case', 'num'] } } } },
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'too_long' } } } },
      ],
    });
    const { flow, h } = ready();
    await flow.submitNp();
    // The first named rule's error; the named chips red; the passwords stay.
    expect(flow.npMsg).toBe('The new password needs upper- and lowercase letters.');
    expect(flow.npBad).toEqual(['case', 'num']);
    expect(flow.npReady).toBe(false);
    expect(h.fail).toHaveBeenLastCalledWith('np');
    expect([flow.np, flow.np2]).toEqual(['New-password1', 'New-password1']);
    expect(flow.phase('np', false)).toBe('error');
    flow.editNp('New-password1');
    expect(flow.npMsg).toBeNull();
    expect(flow.npBad).toEqual([]);
    expect(flow.npReady).toBe(true);
    await flow.submitNp();
    expect(flow.npMsg).toBe('The password is too long.');
    expect(flow.np).toBe('New-password1');
    expect(flow.view).toBe('newpw');
  });

  it('ignores a policy verdict when the password was edited while saving', async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => undefined;
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [() => new Promise((resolve) => (answer = resolve))] });
    const { flow, h } = ready();
    const pending = flow.submitNp();
    flow.editNp('New-password12');
    flow.editNp2('New-password12');
    answer({ status: 422, body: { error: 'invalid', fields: { password: { code: 'policy', rules: ['num'] } } } });
    await pending;
    expect(flow.npLoading).toBe(false);
    expect(flow.npMsg).toBeNull();
    expect(flow.npBad).toEqual([]);
    expect(flow.npReady).toBe(true);
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('falls back to the length rule for a policy without known rules', async () => {
    mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'policy' } } } },
      ],
    });
    const { flow } = ready();
    await flow.submitNp();
    expect(flow.npMsg).toBe('The new password must be at least 10 characters long.');
    expect(flow.npBad).toEqual([]);
  });

  it('locks “Save password” after 429 with a bar running empty; the passwords stay', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    const { flow, h } = ready();
    await flow.submitNp();
    expect(h.fail).toHaveBeenCalledWith();
    expect(flow.npLocked).toBe(true);
    expect(flow.npLockText).toBe('Try again in 15 minutes.');
    expect(flow.npLock).toEqual({ left: 900, total: 900 });
    expect(flow.npReady).toBe(false);
    expect([flow.np, flow.np2]).toEqual(['New-password1', 'New-password1']);
    expect(flow.phase('np', false)).toBe('locked');
    // Enter while locked does nothing.
    await flow.submitNp();
    expect(calls).toHaveLength(1);
    expect(h.missing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300_000);
    expect(flow.npLock).toEqual({ left: 600, total: 900 });
    vi.advanceTimersByTime(600_000);
    expect(flow.npLock).toBeNull();
    expect(flow.npReady).toBe(true);
    flow.dispose();
  });

  it('shows “No connection” without an answer, the passwords kept', async () => {
    mockApi({});
    const { flow, h } = ready();
    await flow.submitNp();
    expect(h.offline).toHaveBeenCalledOnce();
    expect(flow.view).toBe('newpw');
    expect(flow.npLoading).toBe(false);
    expect([flow.np, flow.np2]).toEqual(['New-password1', 'New-password1']);
  });

  it('shows other answers as an error toast', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 500, body: { error: 'internal' } }] });
    const { flow, h } = ready();
    await flow.submitNp();
    expect(h.error).toHaveBeenCalledOnce();
    expect(h.offline).not.toHaveBeenCalled();
    expect(flow.view).toBe('newpw');
  });

  it('never writes the passwords to storage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'too_long' } } } },
      ],
    });
    const { flow } = ready();
    await flow.submitNp();
    const stored = [localStorage, sessionStorage].flatMap((store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`),
    );
    expect(stored.join('\n')).not.toContain('New-password1');
  });

  it('opens a new link also from another step', () => {
    const { flow } = ready();
    flow.route({ kind: 'newpw', token: 'b'.repeat(64) });
    expect(flow.token).toBe('b'.repeat(64));
    expect([flow.np, flow.np2]).toEqual(['', '']);
    flow.route({ kind: 'login' });
    expect(flow.view).toBe('login');
  });
});

describe('tile icon', () => {
  it('follows focus and “Show password” like phase()', () => {
    const flow = new LoginFlow();
    expect(flow.phase(null, false)).toBe('idle');
    expect(flow.phase('id', false)).toBe('id');
    expect(flow.phase('pw', false)).toBe('pw');
    expect(flow.phase('pw', true)).toBe('peek');
    flow.route({ kind: 'forgot' });
    expect(flow.phase('fg', false)).toBe('forgot');
  });
});
