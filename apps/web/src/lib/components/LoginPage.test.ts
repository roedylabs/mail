import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginRoute } from '#lib/login.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { RESET0, prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import LoginPage from './LoginPage.svelte';

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: {
    name: null,
    website: null,
    help: null,
    email: null,
    imprint: null,
    privacy: null,
    terms: null,
    source: null,
  },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};

const ME = {
  id: '01J',
  username: 'max',
  email: 'max@example.net',
  display_name: 'Jane Doe',
  role: 'user',
  mfa_enabled: true,
  sole_admin: false,
  password_changed_at: '2026-10-25T10:00:00Z',
  email_change: null,
};

const TOKEN = 'c'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
  session.user = null;
  session.status = 'idle';
  prefs.reset();
  ui.reset();
});

function show(route: LoginRoute = { kind: 'login' }, config: Partial<PublicConfig> = {}) {
  session.config = { ...CONFIG, ...config };
  session.status = 'ready';
  const navigate = vi.fn<(to: 'login' | 'forgot') => void>();
  const home = vi.fn();
  const view = render(LoginPage, { route, navigate, home });
  return { ...view, navigate, home };
}

async function type(label: string | RegExp, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

describe('page sign-in', () => {
  it('shows title and text of the branding, "Stay signed in" preselected, no footer', () => {
    const view = show({ kind: 'login' }, { branding: { ...BRAND0, loginTitle: 'Hello team', loginText: '' } });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Hello team');
    expect(view.queryByText('Sign in with your account.')).toBeNull();
    expect(view.getByRole('checkbox', { name: 'Stay signed in' })).toHaveAttribute('aria-checked', 'true');
    expect(view.queryByText(`© ${new Date().getFullYear()} Roedy Mail`)).toBeNull();
    expect(view.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    expect(ui.authTitle).toBe('Sign in · Roedy Mail');
  });

  it('shows maintenance mode above the fields with a custom hint or the default text', () => {
    const view = show({ kind: 'login' }, { maintenance: { on: true, message: null } });
    const maint = view.container.querySelector('#ln-maint');
    expect(maint).toHaveAttribute('role', 'status');
    expect(maint).toHaveTextContent('Maintenance');
    expect(maint).toHaveTextContent('We’re performing maintenance right now. Please try again in an hour.');
    expect(
      maint!.compareDocumentPosition(view.getByLabelText('Email or username')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    view.unmount();
    const custom = show({ kind: 'login' }, { maintenance: { on: true, message: 'Until 2 pm' } });
    expect(custom.container.querySelector('#ln-maint')).toHaveTextContent('Until 2 pm');
  });

  it('fills the account preview live from the identifier and "Stay signed in"', async () => {
    const view = show();
    const preview = () => view.container.querySelector('.acct')!;
    expect(preview()).toHaveAttribute('aria-hidden', 'true');
    expect(preview()).toHaveTextContent('Your account');
    expect(preview()).toHaveTextContent('Stays signed in');
    expect(preview()).toHaveTextContent('You stay signed in on this device until you sign out.');
    await type('Email or username', '  ändrea@example.com ');
    expect(preview().querySelector('.avatar')).toHaveTextContent('Ä');
    expect(preview()).toHaveTextContent('ändrea@example.com');
    expect(preview()).toHaveTextContent('Roedy Mail');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Stay signed in' }));
    expect(view.getByRole('checkbox', { name: 'Stay signed in' })).toHaveAttribute('aria-checked', 'false');
    expect(preview()).toHaveTextContent('This session only');
    expect(preview()).toHaveTextContent('You’re signed out when you close the browser.');
  });

  it('keeps the Tab order identifier, "Forgot password?", password, "Stay signed in", the eye out of it', () => {
    const view = show();
    const order = [
      view.getByLabelText('Email or username'),
      view.getByRole('link', { name: 'Forgot password?' }),
      view.getByLabelText('Password'),
      view.getByRole('checkbox', { name: 'Stay signed in' }),
    ];
    for (const [a, b] of order.slice(0, -1).map((el, i) => [el, order[i + 1]!] as const)) {
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(view.getByRole('button', { name: 'Show password' })).toHaveAttribute('tabindex', '-1');
    expect(view.getByLabelText('Email or username')).toHaveAttribute('maxlength', '254');
    expect(view.getByLabelText('Email or username')).toHaveAttribute('autocomplete', 'username');
    expect(view.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('focuses the identifier when entering, on mobile the heading (the keyboard stays closed)', async () => {
    const desktop = show();
    await vi.waitFor(() => expect(document.activeElement).toBe(desktop.getByLabelText('Email or username')));
    desktop.unmount();
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
    window.dispatchEvent(new Event('resize'));
    try {
      const view = show();
      await vi.waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 })));
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('switches the theme only in the browser', async () => {
    const { calls } = mockApi({});
    const view = show();
    await fireEvent.click(view.getByRole('button', { name: 'Light theme' }));
    expect(prefs.values.mode).toBe('light');
    expect(view.getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('reports missing input and wrong credentials under the password field', async () => {
    mockApi({ 'POST auth/login': [{ status: 422, body: { error: 'invalid_credentials' } }] });
    const view = show();
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    expect(view.getByText('Please enter your email address or username.')).toBeInTheDocument();
    expect(view.getByText('Please enter your password.')).toBeInTheDocument();
    expect(view.getByLabelText('Email or username')).toHaveAttribute('aria-describedby', 'ln-id-err');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Email or username')));
    await type('Email or username', 'max');
    await type('Password', 'wrong');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    const failed = await view.findByRole('alert');
    expect(failed).toHaveTextContent(`${m.login_failed_title()} ${m.login_failed_text()}`);
    // Under the password field, as the setup's field messages.
    expect(
      view.getByLabelText('Password').compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByLabelText('Password')).toHaveValue('');
    expect(view.getByLabelText('Email or username')).toHaveValue('max');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Password')));
  });

  it('greys out "Sign in" while locked, the time left only in the message', async () => {
    mockApi({ 'POST auth/login': [{ status: 429, body: { error: 'rate_limited', retry_after: 300 } }] });
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'wrong');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    const lock = await view.findByRole('alert');
    expect(lock).toHaveTextContent('Too many attempts. Try again in 5 minutes.');
    expect(lock.querySelector('.time')).toHaveTextContent('5:00');
    expect(lock.querySelector('.lock')).toHaveAttribute('aria-hidden', 'true');
    const button = view.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveClass('off');
    // Both fields stay editable.
    expect(view.getByLabelText('Password')).not.toBeDisabled();
    expect(view.getByLabelText('Email or username')).not.toBeDisabled();
  });

  it('shows "No connection" when the sign-in gets no answer, the input stays', async () => {
    mockApi({});
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'secret');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    expect(await view.findByRole('alertdialog')).toHaveTextContent(m.net_title());
    expect(view.getByLabelText('Email or username')).toHaveValue('max');
    expect(view.getByLabelText('Password')).toHaveValue('secret');
    expect(ui.toast).toBeNull();
  });

  it('makes "Forgot password?" inert while the sign-in runs', async () => {
    mockApi({ 'POST auth/login': [() => new Promise(() => undefined)] });
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'secret');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    const busy = view.getByRole('button', { name: 'Signing in …' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(view.getByRole('checkbox', { name: 'Stay signed in' })).toHaveAttribute('aria-disabled', 'true');
    const link = view.container.querySelector('a[href="/password/forgot"]');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect((link as HTMLElement).inert).toBe(true);
  });

  it('reports an unexpected error as an error toast', async () => {
    mockApi({ 'POST auth/login': [{ status: 500, body: { error: 'internal' } }] });
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'secret');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(ui.toast).not.toBeNull());
    expect(ui.toast).toMatchObject({
      text: 'That didn’t work. Please try again.',
      error: true,
      undo: false,
    });
  });

  it('signs in with a code, greets and then loads settings and account', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockApi({
      'POST auth/login': [{ body: { status: 'totp_required' } }],
      'POST auth/totp': [{ body: { status: 'ok', user: ME } }],
      'GET settings': [{ body: { version: 1, settings: { ...RESET0, tzAuto: false } } }],
      'GET auth/me': [{ body: ME }],
    });
    const view = show();
    await type('Email or username', 'max@example.net');
    await type('Password', 'Secure-enough1');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Stay signed in' }));
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    expect(await view.findByRole('heading', { name: m.login_otp_title() })).toBeInTheDocument();
    expect(calls[0]?.body).toEqual({ login: 'max@example.net', password: 'Secure-enough1', remember: false });
    expect(view.getByText('max@example.net')).toBeInTheDocument();
    await type('Verification code', '123456');
    expect(await view.findByRole('heading', { name: 'Hello, Jane' })).toBeInTheDocument();
    expect(view.getByText('Redirecting you to Roedy Mail …')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2700);
    await vi.waitFor(() => expect(session.user?.id).toBe('01J'));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST auth/login',
      'POST auth/totp',
      'GET settings',
      'GET auth/me',
    ]);
  });

  it('greets on "Hello" with the stay-signed-in chip; "Back to sign-in" ends the new session', async () => {
    const { calls } = mockApi({
      'POST auth/login': [{ body: { status: 'ok', user: { ...ME, display_name: '' } } }],
      'POST auth/logout': [{ status: 204 }],
    });
    const view = show();
    await type('Email or username', 'anna@example.com');
    await type('Password', 'Secure-enough1');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Stay signed in' }));
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    const heading = await view.findByRole('heading', { name: 'Hello, Anna' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(ui.authTitle).toBe('Signed in · Roedy Mail');
    expect(view.getByRole('status')).toHaveTextContent('Signed in for this session only.');
    expect(view.getByText('Redirecting you to Roedy Mail …')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.getByLabelText('Email or username')).toHaveValue('anna@example.com');
    expect(view.getByLabelText('Password')).toHaveValue('');
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain('auth/logout'));
  });

  it('switches to the recovery code and shows the lock', async () => {
    mockApi({
      'POST auth/login': [{ body: { status: 'totp_required' } }],
      'POST auth/recovery': [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'Secure-enough1');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Use a recovery code' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Recovery code');
    await type('Recovery code', 'abcdefgh');
    expect(await view.findByText(/Too many incorrect codes\./)).toBeInTheDocument();
    // Under the code boxes, as the setup token's messages.
    const lock = view.container.querySelector('#ln-code-alert');
    expect(lock).not.toBeNull();
    expect(
      view.getByLabelText('Recovery code').compareDocumentPosition(lock!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'true');
    expect(view.getByLabelText('Recovery code')).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Use a code from the app' }));
    expect(view.getByRole('heading', { name: m.login_otp_title() })).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.getByLabelText('Email or username')).toHaveValue('max');
    expect(view.getByLabelText('Password')).toHaveValue('');
  });
  it('opens "Reset password" with the identifier and reports the route', async () => {
    mockApi({ 'POST auth/password/forgot': [{ status: 202 }] });
    const view = show();
    await type('Email or username', 'max@example.net');
    await fireEvent.click(view.getByRole('link', { name: 'Forgot password?' }));
    expect(view.navigate).toHaveBeenCalledWith('forgot');
    await view.rerender({ route: { kind: 'forgot' } });
    expect(view.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
    expect(view.getByLabelText('Email address')).toHaveValue('max@example.net');
    await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
    expect(await view.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(view.getByText('max@example.net')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Resend in 0:30' })).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.navigate).toHaveBeenLastCalledWith('login');
  });

  it('shows /password/forgot signed in with "Back to ‹app name›"', async () => {
    session.user = { ...ME, role: 'user' };
    mockApi({ 'POST auth/password/forgot': [{ status: 202 }] });
    const view = show({ kind: 'forgot' });
    expect(view.getByLabelText('Email address')).toHaveValue('');
    const back = view.getByRole('button', { name: 'Back to Roedy Mail' });
    expect(back).toHaveTextContent('Back');
    await fireEvent.click(back);
    expect(view.home).toHaveBeenCalledOnce();
    await type('Email address', 'max@example.net');
    await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
    await view.findByRole('heading', { name: 'Check your inbox' });
    await fireEvent.click(view.getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(view.home).toHaveBeenCalledTimes(2);
  });
  it('accepts pasted codes with spaces in full', async () => {
    const { calls } = mockApi({
      'POST auth/login': [{ body: { status: 'totp_required' } }],
      'POST auth/totp': [{ status: 422, body: { error: 'invalid_code' } }],
    });
    const view = show();
    await type('Email or username', 'max');
    await type('Password', 'Secure-enough1');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    await view.findByRole('heading', { name: m.login_otp_title() });
    expect(view.getByLabelText('Verification code')).not.toHaveAttribute('maxlength');
    await type('Verification code', '123 456');
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ code: '123456' }));
  });
});

/** Signs in up to the code step (`auth/login` answers `totp_required`). */
async function atCode(routes: Parameters<typeof mockApi>[0] = {}) {
  const { calls } = mockApi({ 'POST auth/login': [{ body: { status: 'totp_required' } }], ...routes });
  const view = show();
  await type('Email or username', 'max@example.net');
  await type('Password', 'Secure-enough1');
  await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
  await view.findByRole('heading', { name: m.login_otp_title() });
  return { ...view, calls };
}

/** Runs `body` in a phone-sized window. */
async function onPhone(body: () => Promise<void>) {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
  window.dispatchEvent(new Event('resize'));
  try {
    await body();
  } finally {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    window.dispatchEvent(new Event('resize'));
  }
}

describe('page code steps', () => {
  it('shows the authenticator step with its preview, field and Back', async () => {
    const view = await atCode();
    expect(ui.authTitle).toBe('Multi-factor authentication · Roedy Mail');
    const preview = view.container.querySelector('.acct')!;
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview).toHaveTextContent('Authenticator app');
    expect(preview).toHaveTextContent('max@example.net');
    expect(preview).toHaveTextContent('Roedy Mail');
    expect(preview).toHaveTextContent('A new code every 30 seconds');
    expect(preview).toHaveTextContent('••• •••');
    const field = view.getByLabelText('Verification code');
    expect(field).toHaveAttribute('id', 'ln-otp');
    expect(field).toHaveAttribute('name', 'otp');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).not.toHaveAttribute('maxlength');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    const back = view.getByRole('button', { name: 'Back to sign-in' });
    expect(back).toHaveTextContent('Back');
    expect(view.getByText(m.login_no_app())).toBeInTheDocument();
    // Entering on desktop: the code field.
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('focuses the heading when entering on mobile', async () => {
    await onPhone(async () => {
      const view = await atCode();
      await vi.waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 })));
    });
  });

  it('runs the ring of the 30-second window from the device clock', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-23T10:00:07.100Z') });
    const view = await atCode();
    const secs = () => view.container.querySelector('.ring .secs');
    expect(secs()).toHaveTextContent('23');
    await vi.advanceTimersByTimeAsync(1000);
    expect(secs()).toHaveTextContent('22');
    await vi.advanceTimersByTimeAsync(22_000);
    // A new window: full again, without running back.
    expect(secs()).toHaveTextContent('30');
    expect(view.container.querySelector<SVGElement>('.ring .run')!.style.transition).toBe('none');
  });

  it('shows the short-code line on Confirm with too few digits, without a request', async () => {
    const view = await atCode();
    await type('Verification code', '123');
    await fireEvent.click(view.getByRole('button', { name: 'Confirm' }));
    const short = view.container.querySelector('#ln-otp-err');
    expect(short).toHaveTextContent('Please enter all 6 digits.');
    expect(short).toHaveAttribute('role', 'alert');
    const field = view.getByLabelText('Verification code');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'ln-otp-err');
    expect(view.calls.map((c) => c.path)).toEqual(['auth/login']);
    // Confirm is never greyed out for an incomplete code.
    expect(view.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'false');
    await type('Verification code', '1234');
    expect(view.container.querySelector('#ln-otp-err')).toBeNull();
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(field).not.toHaveAttribute('aria-describedby');
  });

  it('reports a wrong and a used code under the boxes and clears the code', async () => {
    const view = await atCode({
      'POST auth/totp': [
        { status: 422, body: { error: 'invalid_code' } },
        { status: 422, body: { error: 'code_used' } },
      ],
    });
    await type('Verification code', '111111');
    const alert = await vi.waitFor(() => {
      const el = view.container.querySelector('#ln-code-alert');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Invalid code. Check the current code in your app and try again.');
    const field = view.getByLabelText('Verification code');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'ln-code-alert');
    expect(view.container.querySelectorAll('.box.bad')).toHaveLength(6);
    expect(field.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The next character clears it.
    await type('Verification code', '2');
    expect(view.container.querySelector('#ln-code-alert')).toBeNull();
    expect(view.container.querySelectorAll('.box.bad')).toHaveLength(0);
    await type('Verification code', '222222');
    await vi.waitFor(() =>
      expect(view.container.querySelector('#ln-code-alert')).toHaveTextContent(
        'Code already used. Wait for the next code in your app.',
      ),
    );
    expect(view.getByLabelText('Verification code')).toHaveValue('');
  });

  it('locks both codes with a bar, greys out Confirm and frees the field afterwards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await atCode({
      'POST auth/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    await type('Verification code', '123456');
    const lock = await vi.waitFor(() => {
      const el = view.container.querySelector('#ln-code-alert');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(lock).toHaveTextContent(
      'Too many incorrect codes. Try again in 15 minutes. After that, enter your password again.',
    );
    expect(lock.querySelector('.time')).toHaveTextContent('15:00');
    expect(lock.querySelector('.lock')).toHaveAttribute('aria-hidden', 'true');
    const field = view.getByLabelText('Verification code');
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(field).toHaveAttribute('aria-describedby', 'ln-code-alert');
    const confirm = view.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveClass('off');
    // Back and the switch stay usable; the lock stays when switching.
    expect(view.getByRole('button', { name: 'Back to sign-in' })).not.toHaveAttribute('aria-disabled');
    await fireEvent.click(view.getByRole('button', { name: 'Use a recovery code' }));
    expect(view.getByLabelText('Recovery code')).toBeDisabled();
    expect(view.container.querySelector('#ln-code-alert')).toHaveTextContent('Too many incorrect codes.');
    await fireEvent.click(view.getByRole('button', { name: 'Use a code from the app' }));
    await vi.advanceTimersByTimeAsync(900_000);
    expect(view.container.querySelector('#ln-code-alert')).toBeNull();
    expect(view.getByLabelText('Verification code')).not.toBeDisabled();
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Verification code')));
  });

  it('shows the recovery code step with its own field, preview and note', async () => {
    const view = await atCode();
    await fireEvent.click(view.getByRole('button', { name: 'Use a recovery code' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(m.login_bc_title());
    expect(ui.authTitle).toBe('Recovery code · Roedy Mail');
    const field = view.getByLabelText('Recovery code');
    expect(field).toHaveAttribute('id', 'ln-bc');
    expect(field).toHaveAttribute('name', 'backup-code');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'characters');
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    const preview = view.container.querySelector('.acct')!;
    expect(preview).toHaveTextContent('Recovery codes');
    expect(preview).toHaveTextContent('Single use');
    expect(preview.querySelectorAll('.rc')).toHaveLength(10);
    expect(preview.querySelector('.rc.on')).toBeNull();
    await type('Recovery code', 'ab-c');
    expect(field).toHaveValue('ABC');
    expect(preview.querySelector('.rc.on')).toHaveTextContent('ABC•-••••');
    expect(view.getByText('Don’t have your codes? Contact your administrator.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Confirm' }));
    expect(view.container.querySelector('#ln-bc-err')).toHaveTextContent('Please enter the full code.');
    expect(field).toHaveAttribute('aria-describedby', 'ln-bc-err');
  });

  it('keeps Back and the switch inert while a code is checked', async () => {
    const view = await atCode({ 'POST auth/totp': [() => new Promise(() => undefined)] });
    await type('Verification code', '123456');
    const busy = view.getByRole('button', { name: 'Checking …' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).not.toHaveClass('off');
    const back = view.getByRole('button', { name: 'Back to sign-in' });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(back).toHaveClass('fade');
    await fireEvent.click(back);
    const link = view.container.querySelector('.alt .link') as HTMLElement;
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link.inert).toBe(true);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(m.login_otp_title());
  });

  it('goes back to the password with the identifier kept and the focus in the password', async () => {
    const view = await atCode();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.getByLabelText('Email or username')).toHaveValue('max@example.net');
    expect(view.getByLabelText('Password')).toHaveValue('');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Password')));
  });

  it('keeps the code on another answer and shows an error toast', async () => {
    const view = await atCode({ 'POST auth/totp': [{ status: 500, body: { error: 'internal' } }] });
    await type('Verification code', '123456');
    await vi.waitFor(() => expect(ui.toast).not.toBeNull());
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(view.getByLabelText('Verification code')).toHaveValue('123456');
  });

  it('returns to the password screen with "Sign-in expired."', async () => {
    const view = await atCode({ 'POST auth/totp': [{ status: 422, body: { error: 'login_expired' } }] });
    await type('Verification code', '123456');
    expect(await view.findByText(m.login_expired_title())).toBeInTheDocument();
    expect(view.getByLabelText('Password')).toHaveValue('');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Password')));
  });
});

/** Opens `/password/forgot` directly. */
function atForgot(routes: Parameters<typeof mockApi>[0] = {}) {
  const { calls } = mockApi(routes);
  const view = show({ kind: 'forgot' });
  return { ...view, calls };
}

/** Sends the link from `/password/forgot` up to "Check your inbox". */
async function atSent(routes: Parameters<typeof mockApi>[0] = {}) {
  const view = atForgot({ 'POST auth/password/forgot': [{ status: 202 }], ...routes });
  await type('Email address', 'max@example.net');
  await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
  await view.findByRole('heading', { name: 'Check your inbox' });
  return view;
}

describe('page reset password', () => {
  it('shows the field, the mail preview, Back and "Send link" on the shared shell', async () => {
    const view = atForgot();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Reset password');
    expect(view.getByText(m.login_forgot_intro())).toBeInTheDocument();
    expect(ui.authTitle).toBe('Reset password · Roedy Mail');
    expect(view.container.querySelector('.login')).toBeNull();
    const field = view.getByLabelText('Email address');
    expect(field).toHaveAttribute('id', 'ln-fg');
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('name', 'email');
    expect(field).toHaveAttribute('autocomplete', 'email');
    expect(field).toHaveAttribute('inputmode', 'email');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('maxlength', '254');
    expect(field).toHaveAttribute('placeholder', 'name@example.com');
    const back = view.getByRole('button', { name: 'Back to sign-in' });
    expect(back).toHaveTextContent('Back');
    // Back sits left of "Send link".
    const send = view.getByRole('button', { name: 'Send link' });
    expect(back.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send.style.padding).toBe('0px 18px');
    expect(send.querySelector('.nowrap')).toHaveTextContent('Send link');
    // Entering on desktop: the field.
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('fills the mail preview live from the field, without saying whether an account exists', async () => {
    const view = atForgot();
    const preview = () => view.container.querySelector('.acct')!;
    expect(preview()).toHaveAttribute('aria-hidden', 'true');
    expect(preview()).toHaveTextContent('Reset your password');
    expect(preview().querySelector('.who-email')).toHaveTextContent('To: name@example.com');
    expect(preview().querySelector('.who-email')).toHaveClass('empty');
    expect(preview()).toHaveTextContent('Reset link');
    expect(preview()).toHaveTextContent('Valid for 60 minutes');
    expect(preview()).toHaveTextContent('Works only once');
    await type('Email address', ' max@example.net ');
    expect(preview().querySelector('.who-email')).toHaveTextContent('To: max@example.net');
    expect(preview().querySelector('.who-email')).not.toHaveClass('empty');
  });

  it('focuses the heading when entering on mobile', async () => {
    await onPhone(async () => {
      const view = atForgot();
      await vi.waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 })));
    });
  });

  it('shows what is missing under the field and moves the focus there, on mobile too', async () => {
    await onPhone(async () => {
      const view = atForgot();
      const field = view.getByLabelText('Email address');
      await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
      const err = view.container.querySelector('#ln-fg-err');
      expect(err).toHaveTextContent('Please enter your email address.');
      expect(err).toHaveAttribute('role', 'alert');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAttribute('aria-describedby', 'ln-fg-err');
      await vi.waitFor(() => expect(document.activeElement).toBe(field));
      await type('Email address', 'max@example');
      expect(view.container.querySelector('#ln-fg-err')).toBeNull();
      await fireEvent.submit(field.closest('form')!);
      expect(view.container.querySelector('#ln-fg-err')).toHaveTextContent('Please enter a valid email address.');
      expect(view.calls).toHaveLength(0);
    });
  });

  it('shows the request lock under the field; the field stays editable, "Send link" greyed out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = atForgot({
      'POST auth/password/forgot': [{ status: 429, body: { error: 'rate_limited', retry_after: 360 } }],
    });
    const field = view.getByLabelText('Email address');
    await type('Email address', 'max@example.net');
    await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
    const lock = await vi.waitFor(() => {
      const el = view.container.querySelector('#ln-fg-lock');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(lock).toHaveAttribute('role', 'alert');
    expect(lock).toHaveTextContent('Too many requests.');
    expect(lock).toHaveTextContent('Try again in 6 minutes.');
    expect(lock).toHaveTextContent('6:00');
    expect(field.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field).toHaveAttribute('aria-describedby', 'ln-fg-err ln-fg-lock');
    expect(field).not.toBeDisabled();
    expect(field).toHaveValue('max@example.net');
    // The normal label, greyed out: the time left is only in the lock message.
    const send = view.getByRole('button', { name: 'Send link' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(view.queryByText(/Send link in/)).toBeNull();
    // Enter while locked checks nothing (no error line under the lock).
    await type('Email address', '');
    await fireEvent.submit(field.closest('form')!);
    expect(view.container.querySelector('#ln-fg-err')).toBeNull();
    expect(field).toHaveAttribute('aria-describedby', 'ln-fg-err ln-fg-lock');
    await type('Email address', 'max');
    vi.advanceTimersByTime(360_000);
    await vi.waitFor(() => expect(view.container.querySelector('#ln-fg-lock')).toBeNull());
    expect(view.getByRole('button', { name: 'Send link' })).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
    expect(field).toHaveAttribute('aria-describedby', 'ln-fg-err');
  });

  it('sends with a spinner and shows "No connection" without an answer, the address kept', async () => {
    const view = atForgot();
    await type('Email address', 'max@example.net');
    await fireEvent.click(view.getByRole('button', { name: 'Send link' }));
    expect(await view.findByRole('alertdialog')).toBeInTheDocument();
    expect(view.getByLabelText('Email address', { selector: 'input' })).toHaveValue('max@example.net');
  });

  it('takes the typed address back to sign-in, the focus in the password', async () => {
    const view = atForgot();
    await type('Email address', 'max@example.net');
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.navigate).toHaveBeenLastCalledWith('login');
    expect(view.getByLabelText('Email or username')).toHaveValue('max@example.net');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Password')));
  });
});

describe('page check your inbox', () => {
  it('shows the address, the link chips and "Back to sign-in"; the focus on the heading', async () => {
    const view = await atSent();
    const heading = view.getByRole('heading', { level: 1 });
    expect(ui.authTitle).toBe('Check your inbox · Roedy Mail');
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    const status = view.getByRole('status');
    expect(status).toHaveTextContent(
      'If an account exists for max@example.net, you’ll receive an email with a reset link shortly.',
    );
    expect(status.querySelector('strong')).toHaveTextContent('max@example.net');
    const chips = view.getByRole('list', { name: 'About the link' });
    expect(chips).toHaveTextContent('Valid for 60 minutes');
    expect(chips).toHaveTextContent('Works only once');
    expect(view.getByText('Didn’t get an email?')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.navigate).toHaveBeenLastCalledWith('login');
    expect(view.getByLabelText('Email or username')).toHaveValue('max@example.net');
  });

  it('counts "Resend" down for 30 s, sends the same address with a spinner and counts again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: () => void = () => undefined;
    const view = await atSent({
      'POST auth/password/forgot': [
        { status: 202 },
        () => new Promise<{ status: number }>((resolve) => (answer = () => resolve({ status: 202 }))),
      ],
    });
    const resend = view.getByRole('button', { name: 'Resend in 0:30' });
    expect(resend).toBeDisabled();
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Resend' })).not.toBeDisabled());
    await fireEvent.click(view.getByRole('button', { name: 'Resend' }));
    const busy = view.getByRole('button', { name: 'Resend' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('.spin')).not.toBeNull();
    answer();
    expect(await view.findByRole('button', { name: 'Resend in 0:30' })).toHaveAttribute('aria-busy', 'false');
    expect(view.calls.map((c) => c.body)).toEqual([{ email: 'max@example.net' }, { email: 'max@example.net' }]);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('counts down to retry_after after a 429 with a red line under "Resend"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await atSent({
      'POST auth/password/forgot': [
        { status: 202 },
        { status: 429, body: { error: 'rate_limited', retry_after: 360 } },
      ],
    });
    vi.advanceTimersByTime(30_000);
    await fireEvent.click(await view.findByRole('button', { name: 'Resend' }));
    expect(await view.findByRole('button', { name: 'Resend in 6:00' })).toBeDisabled();
    const line = view.getByRole('alert');
    expect(line).toHaveTextContent('Too many requests. Try again in 6 minutes.');
    expect(line.querySelector('strong')).toHaveTextContent('Too many requests.');
    vi.advanceTimersByTime(360_000);
    await vi.waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(view.getByRole('button', { name: 'Resend' })).not.toBeDisabled();
  });

  it('puts "Back to sign-in" into the bottom bar on mobile', async () => {
    await onPhone(async () => {
      const view = await atSent();
      const back = view.getByRole('button', { name: 'Back to sign-in' });
      expect(back.closest('.bottom')).not.toBeNull();
    });
  });
});

/** Opens the link from the mail (`/password/reset/‹token›`). */
function atNewPw(routes: Parameters<typeof mockApi>[0] = {}) {
  const { calls } = mockApi(routes);
  const view = show({ kind: 'newpw', token: TOKEN });
  return { ...view, calls };
}

/** Both passwords filled in, "Save password" ready. */
async function fillNewPw(pw = 'New-password-1', pw2 = pw) {
  await type('New password', pw);
  await type('Confirm password', pw2);
}

const save = () => screen.getByRole('button', { name: 'Save password' });

describe('page set a new password', () => {
  it('shows the check card, both fields, Back and "Save password" on the shared shell', async () => {
    const view = atNewPw();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set a new password');
    expect(view.getByText(m.login_newpw_intro())).toBeInTheDocument();
    expect(ui.authTitle).toBe('Set a new password · Roedy Mail');
    expect(view.container.querySelector('.login')).toBeNull();
    const rules = view.getByRole('list', { name: 'Password requirements' });
    expect(rules).toHaveAttribute('id', 'ln-np-rules');
    expect(rules).toHaveTextContent('At least 10 characters');
    expect(rules).toHaveTextContent('Passwords match');
    expect(view.getByText('Not set yet')).toBeInTheDocument();
    const pw = view.getByLabelText('New password');
    expect(pw).toHaveAttribute('id', 'ln-np');
    expect(pw).toHaveAttribute('type', 'password');
    expect(pw).toHaveAttribute('name', 'new-password');
    expect(pw).toHaveAttribute('autocomplete', 'new-password');
    expect(pw).toHaveAttribute('placeholder', 'New password');
    expect(pw).toHaveAttribute('aria-describedby', 'ln-np-rules');
    const pw2 = view.getByLabelText('Confirm password');
    expect(pw2).toHaveAttribute('id', 'ln-np2');
    expect(pw2).toHaveAttribute('name', 'confirm-password');
    expect(pw2).toHaveAttribute('autocomplete', 'new-password');
    expect(pw2).toHaveAttribute('placeholder', 'Enter it again');
    // The rules come before the fields; no hidden username field (the link does not name the account).
    expect(rules.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('input[autocomplete="username"]')).toBeNull();
    const back = view.getByRole('button', { name: 'Back to sign-in' });
    expect(back).toHaveTextContent('Back');
    expect(back.compareDocumentPosition(save()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    // Its own padding (here the mobile bottom bar's) and a label on one line.
    expect(save().style.padding).toBe('0px 18px');
    expect(save().querySelector('.nowrap')).toHaveTextContent('Save password');
    // Entering on desktop: the new password.
    await vi.waitFor(() => expect(document.activeElement).toBe(pw));
  });

  it('gives each field its own eye, out of the Tab order', async () => {
    const view = atNewPw();
    const eye = view.getByRole('button', { name: 'Show password' });
    const eye2 = view.getByRole('button', { name: 'Show confirmed password' });
    expect(eye).toHaveAttribute('tabindex', '-1');
    expect(eye2).toHaveAttribute('tabindex', '-1');
    await fireEvent.click(eye);
    expect(view.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(view.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
    await fireEvent.click(eye2);
    expect(view.getByLabelText('Confirm password')).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Hide confirmed password' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('focuses the heading when entering on mobile', async () => {
    await onPhone(async () => {
      const view = atNewPw();
      await vi.waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 })));
    });
  });

  it('keeps "Save password" greyed out until complete; Enter moves to what is missing, on mobile too', async () => {
    await onPhone(async () => {
      const view = atNewPw();
      const pw = view.getByLabelText('New password');
      const pw2 = view.getByLabelText('Confirm password');
      await fireEvent.click(save());
      await vi.waitFor(() => expect(document.activeElement).toBe(pw));
      await type('New password', 'New-password-1');
      expect(save()).toHaveAttribute('aria-disabled', 'true');
      await fireEvent.submit(pw.closest('form')!);
      await vi.waitFor(() => expect(document.activeElement).toBe(pw2));
      // Nothing to say yet: no error line, no request.
      expect(view.container.querySelector('#ln-np2-err')).toBeNull();
      await type('Confirm password', 'New-password-1');
      expect(save()).toHaveAttribute('aria-disabled', 'false');
      expect(view.container.querySelector('#ln-np2-ok')).toHaveTextContent('Passwords match');
      expect(view.calls).toHaveLength(0);
    });
  });

  it('shows the mismatch under the confirmation with the focus there', async () => {
    const view = atNewPw();
    await fillNewPw('New-password-1', 'New-password-2');
    const pw2 = view.getByLabelText('Confirm password');
    await fireEvent.click(save());
    const err = view.container.querySelector('#ln-np2-err');
    expect(err).toHaveTextContent('The passwords don’t match.');
    expect(err).toHaveAttribute('role', 'alert');
    expect(pw2).toHaveAttribute('aria-invalid', 'true');
    expect(pw2).toHaveAttribute('aria-describedby', 'ln-np2-err ln-np2-ok');
    await vi.waitFor(() => expect(document.activeElement).toBe(pw2));
    await type('Confirm password', 'New-password-1');
    expect(view.container.querySelector('#ln-np2-err')).toBeNull();
    expect(view.calls).toHaveLength(0);
  });

  it('shows "too long" under the field while typing', async () => {
    const view = atNewPw();
    const pw = view.getByLabelText('New password');
    await fillNewPw(`Aa1${'ü'.repeat(511)}`);
    expect(view.container.querySelector('#ln-np-err')).toHaveTextContent('The password is too long.');
    expect(pw).toHaveAttribute('aria-invalid', 'true');
    expect(pw).toHaveAttribute('aria-describedby', 'ln-np-err ln-np-rules');
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    await type('New password', 'New-password-1');
    expect(view.container.querySelector('#ln-np-err')).toBeNull();
  });

  it('shows the rules the server named under the field and as red chips; typing clears them', async () => {
    const view = atNewPw({
      [`POST auth/password/reset/${TOKEN}`]: [
        { status: 422, body: { error: 'invalid', fields: { password: { code: 'policy', rules: ['num'] } } } },
      ],
    });
    await fillNewPw();
    const pw = view.getByLabelText('New password');
    await fireEvent.click(save());
    await vi.waitFor(() =>
      expect(view.container.querySelector('#ln-np-err')).toHaveTextContent(
        'The new password needs a number or special character.',
      ),
    );
    const num = view.getByText('A number or special character').closest('li')!;
    expect(num).toHaveClass('bad');
    expect(num).toHaveTextContent('not met yet');
    expect(pw).toHaveAttribute('aria-invalid', 'true');
    expect(pw).toHaveAttribute('aria-describedby', 'ln-np-err ln-np-rules');
    expect(pw).toHaveValue('New-password-1');
    expect(view.getByLabelText('Confirm password')).toHaveValue('New-password-1');
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    await vi.waitFor(() => expect(document.activeElement).toBe(pw));
    await type('New password', 'New-password-12');
    expect(view.container.querySelector('#ln-np-err')).toBeNull();
    expect(view.getByText('A number or special character').closest('li')).not.toHaveClass('bad');
  });

  it('shows the save lock under the fields; they stay editable, "Save password" greyed out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = atNewPw({
      [`POST auth/password/reset/${TOKEN}`]: [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
    });
    await fillNewPw();
    await fireEvent.click(save());
    const lock = await vi.waitFor(() => {
      const el = view.container.querySelector('#ln-np-lock');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(lock).toHaveAttribute('role', 'alert');
    expect(lock).toHaveTextContent('Too many requests.');
    expect(lock).toHaveTextContent('Try again in 15 minutes.');
    expect(lock).toHaveTextContent('15:00');
    const pw2 = view.getByLabelText('Confirm password');
    expect(pw2.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pw2).not.toBeDisabled();
    expect(pw2).toHaveValue('New-password-1');
    // The normal label, greyed out: the time left is only in the lock message.
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    expect(view.queryByText(/Save password in/)).toBeNull();
    vi.advanceTimersByTime(900_000);
    await vi.waitFor(() => expect(view.container.querySelector('#ln-np-lock')).toBeNull());
    expect(save()).toHaveAttribute('aria-disabled', 'false');
  });

  it('saves with a spinner and shows "No connection" without an answer, the passwords kept', async () => {
    const view = atNewPw();
    await fillNewPw();
    await fireEvent.click(save());
    expect(await view.findByRole('alertdialog')).toBeInTheDocument();
    expect(view.getByLabelText('New password', { selector: 'input' })).toHaveValue('New-password-1');
    expect(view.getByLabelText('Confirm password', { selector: 'input' })).toHaveValue('New-password-1');
  });

  it('goes back to sign-in', async () => {
    const view = atNewPw();
    await fillNewPw();
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.navigate).toHaveBeenLastCalledWith('login');
    expect(view.getByLabelText('Email or username')).toBeInTheDocument();
  });
});

describe('page password changed', () => {
  it('shows the result with the signed-out chip; signed in, this session ends too', async () => {
    session.user = { ...ME, role: 'user' };
    prefs.remote = true;
    const view = atNewPw({
      [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 3 } }],
    });
    await fillNewPw();
    await fireEvent.click(save());
    const heading = await view.findByRole('heading', { name: 'Password changed' });
    expect(ui.authTitle).toBe('Password changed · Roedy Mail');
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    const status = view.getByRole('status');
    expect(status).toHaveTextContent(m.login_done_text());
    expect(status).toHaveTextContent('You’ve been signed out on all devices.');
    expect(session.user).toBeNull();
    // Guest afterwards: the theme switches only in the browser again.
    expect(prefs.remote).toBe(false);
    expect(view.calls.map((c) => [c.path, c.body])).toEqual([
      [`auth/password/reset/${TOKEN}`, { password: 'New-password-1' }],
    ]);
    await fireEvent.click(view.getByRole('button', { name: 'Go to sign-in' }));
    expect(view.navigate).toHaveBeenCalledWith('login');
    expect(view.getByLabelText('Email or username')).toHaveValue('');
    expect(view.getByLabelText('Password')).toHaveValue('');
    expect(view.getByLabelText('Password')).toHaveAttribute('type', 'password');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Email or username')));
  });

  it('leaves the chip out when no session ended', async () => {
    const view = atNewPw({ [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 0 } }] });
    await fillNewPw();
    await fireEvent.click(save());
    await view.findByRole('heading', { name: 'Password changed' });
    expect(view.queryByText('You’ve been signed out on all devices.')).toBeNull();
  });
});

describe('page link expired or invalid', () => {
  it('shows the dead end with "Request a new link"; the focus on the heading', async () => {
    const view = atNewPw({
      [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }],
    });
    await fillNewPw();
    await fireEvent.click(save());
    const heading = await view.findByRole('heading', { name: 'Link expired or invalid' });
    expect(ui.authTitle).toBe('Link expired or invalid · Roedy Mail');
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(view.getByRole('alert')).toHaveTextContent(m.login_link_bad_text());
    await fireEvent.click(view.getByRole('button', { name: 'Request a new link' }));
    expect(view.navigate).toHaveBeenCalledWith('forgot');
    expect(view.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
    expect(view.getByLabelText('Email address')).toHaveValue('');
  });

  it('goes back to sign-in with the identifier kept, the focus in the password', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }] });
    const view = show();
    await type('Email or username', 'max@example.net');
    await view.rerender({ route: { kind: 'newpw', token: TOKEN } });
    await fillNewPw();
    await fireEvent.click(save());
    await view.findByRole('heading', { name: 'Link expired or invalid' });
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(view.navigate).toHaveBeenLastCalledWith('login');
    expect(view.getByLabelText('Email or username')).toHaveValue('max@example.net');
    await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Password')));
  });
});
