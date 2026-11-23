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
    expect(flow.otpIdent).toBe('max@example.net');
    expect(flow.otpInitial).toBe('M');
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
    await vi.waitFor(() => expect(flow.otpUsed).toBe(true));
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
    expect(flow.codeLockBtn).toBe('Confirm in 15:00');
    expect(flow.otpReady).toBe(false);
    expect(flow.otpDis).toBe(true);
    expect(flow.otp).toBe('');
    flow.useBackup();
    expect(flow.codeLocked).toBe(true);
    expect(flow.bcDis).toBe(true);
    expect(flow.bcReady).toBe(false);
    flow.useApp();
    vi.advanceTimersByTime(900_000);
    expect(flow.codeLocked).toBe(false);
    expect(h.focus).toHaveBeenLastCalledWith('otp');
    flow.dispose();
  });

  it('names only the wait time for short locks (limit per IP address)', async () => {
    vi.useFakeTimers();
    const { flow } = await atCode();
    mockApi({ 'POST auth/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }] });
    flow.editOtp('654321');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    expect(flow.codeLockText).toBe('Try again in 30 seconds.');
    expect(flow.codeLockBtn).toBe('Confirm in 0:30');
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
    expect(flow.fgLockBtn).toBe('Send link in 6:00');
    expect(flow.fgReady).toBe(false);
    expect(flow.fgDis).toBe(true);
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('max@example.net');
    expect(h.fail).toHaveBeenCalledWith();
    vi.advanceTimersByTime(360_000);
    expect(flow.fgLocked).toBe(false);
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

  it('opens the step from the link and checks the rules before sending', async () => {
    const { calls } = mockApi({});
    const { flow, h } = atNewPw();
    expect(flow.showNewPw).toBe(true);
    expect(flow.npReady).toBe(true);
    expect(flow.npRules.find((r) => r.id === 'len')?.ok).toBe(false);
    expect(h.focus).toHaveBeenCalledWith('np');
    flow.editNp('short');
    await flow.submitNp();
    expect(flow.npErr).toBe('The new password must be at least 10 characters long.');
    expect(flow.npRules.map((r) => [r.id, r.ok, r.bad])).toEqual([
      ['len', false, true],
      ['case', false, true],
      ['num', false, true],
    ]);
    expect(flow.phase('np', false)).toBe('error');
    expect(h.fail).toHaveBeenCalledWith('np');
    expect(calls).toHaveLength(0);
  });

  it('reports “Password changed” without sign-in', async () => {
    const { calls } = mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 2 } }],
    });
    const { flow, h } = atNewPw();
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(calls[0]?.body).toEqual({ password: 'New-password1' });
    expect(flow.showPwDone).toBe(true);
    expect(flow.showNewPw).toBe(false);
    expect(flow.pwDoneEnded).toBe(true);
    expect(flow.np).toBe('');
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
    const { flow } = atNewPw();
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(flow.showPwDone).toBe(true);
    expect(flow.pwDoneEnded).toBe(false);
  });

  it('reports a changed password also after “Back” in the browser', async () => {
    let answer: (value: { body: unknown }) => void = () => undefined;
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [() => new Promise((resolve) => (answer = resolve))] });
    const { flow, h } = atNewPw();
    flow.editNp('New-password1');
    const pending = flow.submitNp();
    flow.backToLogin();
    expect(flow.view).toBe('newpw');
    flow.route({ kind: 'login' });
    answer({ body: { status: 'ok', sessions_ended: 1 } });
    await pending;
    expect(h.passwordReset).toHaveBeenCalledOnce();
    expect(flow.view).toBe('login');
  });

  it('shows “Link expired or invalid” and requests a new one', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }] });
    const { flow, h } = atNewPw();
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(flow.showLinkBad).toBe(true);
    expect(flow.np).toBe('');
    expect(flow.phase(null, false)).toBe('linkbad');
    flow.ident = 'old@example.com';
    flow.reqNewLink();
    expect(flow.view).toBe('forgot');
    expect(flow.ident).toBe('');
    expect(h.navigate).toHaveBeenCalledWith('forgot');
  });

  it('takes over the rules of the server and “too long”', async () => {
    mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'policy', rules: ['num'] } } } },
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'too_long' } } } },
      ],
    });
    const { flow } = atNewPw();
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(flow.npErr).toBe('The new password needs a number or special character.');
    const num = flow.npRules.find((r) => r.id === 'num');
    expect(num?.ok).toBe(false);
    expect(num?.bad).toBe(true);
    expect(flow.np).toBe('New-password1');
    expect(flow.showNewPw).toBe(true);
    await flow.submitNp();
    expect(flow.npErr).toBe('The password is too long.');
  });

  it('locks “Save password” after 429, the password stays', async () => {
    vi.useFakeTimers();
    mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    const { flow } = atNewPw();
    flow.editNp('New-password1');
    await flow.submitNp();
    expect(flow.npLocked).toBe(true);
    expect(flow.npLockText).toBe('Try again in 15 minutes.');
    expect(flow.npLockBtn).toBe('Save password in 15:00');
    expect(flow.npReady).toBe(false);
    expect(flow.npDis).toBe(true);
    expect(flow.np).toBe('New-password1');
    expect(flow.phase('np', false)).toBe('locked');
    flow.dispose();
  });

  it('opens a new link also from another step', () => {
    const { flow } = atNewPw();
    flow.editNp('something');
    flow.route({ kind: 'newpw', token: 'b'.repeat(64) });
    expect(flow.token).toBe('b'.repeat(64));
    expect(flow.np).toBe('');
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
