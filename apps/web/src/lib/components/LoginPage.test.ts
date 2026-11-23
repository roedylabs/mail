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
  it('shows title and text of the branding, "Stay signed in" preselected', () => {
    const view = show({ kind: 'login' }, { branding: { ...BRAND0, loginTitle: 'Hello team', loginText: '' } });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Hello team');
    expect(view.queryByText('Sign in with your account.')).toBeNull();
    expect(view.getByRole('checkbox', { name: 'Stay signed in' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText(`© ${new Date().getFullYear()} Roedy Mail`)).toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
  });

  it('shows maintenance mode with a custom hint or the default text', () => {
    const view = show({ kind: 'login' }, { maintenance: { on: true, message: null } });
    expect(view.getByRole('status')).toHaveTextContent(
      'We’re performing maintenance right now. Please try again in an hour.',
    );
    view.unmount();
    const custom = show({ kind: 'login' }, { maintenance: { on: true, message: 'Until 2 pm' } });
    expect(custom.getByRole('status')).toHaveTextContent('Until 2 pm');
  });

  it('shows the organization links in the footer when they are set', () => {
    const view = show({ kind: 'login' }, { org: { ...CONFIG.org, privacy: 'https://example.com/privacy' } });
    expect(view.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://example.com/privacy');
    expect(view.queryByRole('link', { name: 'Legal notice' })).toBeNull();
  });

  it('switches the theme only in the browser', async () => {
    const { calls } = mockApi({});
    const view = show();
    await fireEvent.click(view.getByRole('button', { name: 'Light theme' }));
    expect(prefs.values.mode).toBe('light');
    expect(view.getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('reports missing input and wrong credentials', async () => {
    mockApi({ 'POST auth/login': [{ status: 422, body: { error: 'invalid_credentials' } }] });
    const view = show();
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    expect(view.getByText('Please enter your email address or username.')).toBeInTheDocument();
    expect(view.container.querySelector('#ln-id-err')).not.toHaveClass('wrap');
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
    expect(await view.findByRole('heading', { name: 'Multi-factor authentication' })).toBeInTheDocument();
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
    expect(view.getByRole('button', { name: /Confirm in 15:00/ })).toBeDisabled();
    expect(view.getByLabelText('Recovery code')).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Use a code from the app' }));
    expect(view.getByRole('heading', { name: 'Multi-factor authentication' })).toBeInTheDocument();
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
    const view = show({ kind: 'forgot' });
    expect(view.getByLabelText('Email address')).toHaveValue('');
    await fireEvent.click(view.getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(view.home).toHaveBeenCalledOnce();
  });

  it('sets a new password via the link; signed in, this session ends too', async () => {
    session.user = { ...ME, role: 'user' };
    prefs.remote = true;
    const { calls } = mockApi({
      [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 3 } }],
    });
    const view = show({ kind: 'newpw', token: TOKEN });
    expect(view.getByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(view.getByRole('list', { name: 'Password requirements' })).toBeInTheDocument();
    await type('New password', 'short');
    await fireEvent.click(view.getByRole('button', { name: 'Save password' }));
    expect(view.getByText('The new password must be at least 10 characters long.')).toBeInTheDocument();
    // Only this error line wraps with the icon at the top; the sign-in lines stay centred.
    expect(view.container.querySelector('#ln-np-err')).toHaveClass('wrap');
    await type('New password', 'New-password-1');
    await fireEvent.click(view.getByRole('button', { name: 'Save password' }));
    expect(await view.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(view.getByText('You’ve been signed out on all devices.')).toBeInTheDocument();
    expect(session.user).toBeNull();
    // Guest afterwards: the theme switches only in the browser again.
    expect(prefs.remote).toBe(false);
    expect(calls.map((c) => c.path)).toEqual([`auth/password/reset/${TOKEN}`]);
    await fireEvent.click(view.getByRole('button', { name: m.login_to_login() }));
    expect(view.navigate).toHaveBeenCalledWith('login');
  });

  it('shows a shown password hidden again in the next step', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ body: { status: 'ok', sessions_ended: 0 } }] });
    const view = show({ kind: 'newpw', token: TOKEN });
    await fireEvent.click(view.getByRole('button', { name: 'Show password' }));
    expect(view.getByLabelText('New password')).toHaveAttribute('type', 'text');
    await type('New password', 'New-password-1');
    await fireEvent.click(view.getByRole('button', { name: 'Save password' }));
    await fireEvent.click(await view.findByRole('button', { name: m.login_to_login() }));
    expect(view.getByLabelText('Password')).toHaveAttribute('type', 'password');
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
    await view.findByRole('heading', { name: 'Multi-factor authentication' });
    expect(view.getByLabelText('Verification code')).not.toHaveAttribute('maxlength');
    await type('Verification code', '123 456');
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ code: '123456' }));
  });

  it('shows an expired link with "Request a new link"', async () => {
    mockApi({ [`POST auth/password/reset/${TOKEN}`]: [{ status: 422, body: { error: 'invalid_token' } }] });
    const view = show({ kind: 'newpw', token: TOKEN });
    await type('New password', 'New-password-1');
    await fireEvent.click(view.getByRole('button', { name: 'Save password' }));
    expect(await view.findByRole('heading', { name: 'Link expired or invalid' })).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Request a new link' }));
    expect(view.navigate).toHaveBeenCalledWith('forgot');
    expect(view.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
  });
});
