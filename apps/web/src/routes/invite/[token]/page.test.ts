import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InviteInfo } from '#lib/invite.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { RESET0, prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/invite/tok'), params: { token: 'tok' } },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: {
    name: 'Example Ltd',
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
const INFO: InviteInfo = {
  email: 'jonas.schulz@example.com',
  name: null,
  role: 'user',
  inviter: 'Anna Becker',
  expires_at: '2026-11-02T10:00:00.000Z',
  expired: false,
};
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const USER = { id: '01K', username: 'jonas.schulz', email: INFO.email, display_name: 'Jonas Schulz', role: 'user' };
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD-EF${String(i + 2)}A`);
const ME = {
  ...USER,
  mfa_enabled: true,
  password_changed_at: '2026-10-26T10:00:00Z',
  email_change: null,
  sole_admin: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  nav.goto.mockClear();
  session.config = null;
  session.user = null;
  session.status = 'idle';
  prefs.reset();
  ui.reset();
});

async function type(label: string | RegExp, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

async function click(name: string | RegExp) {
  await fireEvent.click(screen.getByRole('button', { name }));
}

function renderPage() {
  session.config = CONFIG;
  return render(Page);
}

describe('Invitation page', () => {
  it('shows “Welcome” with inviter, details and progress', async () => {
    mockApi({ 'GET invites/tok': [{ body: INFO }] });
    const view = renderPage();
    expect(await view.findByRole('heading', { level: 1 })).toHaveTextContent('Welcome to Roedy Mail');
    expect(view.getByText('Invitation from Anna Becker')).toBeInTheDocument();
    expect(view.getByText('AB')).toBeInTheDocument();
    expect(
      view.getByText('Anna Becker has invited you. Review the details and accept the invitation.'),
    ).toBeInTheDocument();
    expect(view.getByText('jonas.schulz@example.com')).toBeInTheDocument();
    expect(view.getByText('User · Example Ltd')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Step 1 of 4' })).toBeInTheDocument();
    await click('Sign in');
    expect(nav.goto).toHaveBeenCalledWith('/login');
  });

  it('switches the theme without the API', async () => {
    const { calls } = mockApi({ 'GET invites/tok': [{ body: INFO }] });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    const dark = ui.dark;
    await click(dark ? 'Light theme' : 'Dark theme');
    expect(ui.dark).toBe(!dark);
    expect(calls.map((c) => c.path)).toEqual(['invites/tok']);
  });

  it('leads through all four steps to the start page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { calls } = mockApi({
      'GET invites/tok': [{ body: INFO }],
      'POST invites/tok/totp': [{ body: { secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` } }],
      'POST invites/tok/accept': [{ status: 201, body: { user: USER, recovery_codes: CODES } }],
      'GET settings': [{ body: { version: 1, settings: { ...RESET0, tzAuto: false } } }],
      'GET auth/me': [{ body: ME }],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');

    // Step 2: name and password
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your account');
    expect(view.getByRole('img', { name: 'Step 2 of 4' })).toBeInTheDocument();
    await click('Continue');
    expect(view.getByText('Please enter your name.')).toBeInTheDocument();
    await type('Your name', 'Jonas Schulz');
    await type('Choose a password', 'Safe-enough1');
    const rules = view.getByRole('list', { name: 'Password requirements' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(3);
    await click('Continue');

    // Step 3: QR code, key and code
    expect(await view.findByRole('heading', { name: 'Multi-factor authentication' })).toBeInTheDocument();
    const qr = view.getByRole('img', { name: 'QR code for the authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M0 0h7v1h-7z/);
    expect(view.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await click('Copy key');
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(await view.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    // Pasted with spaces, the code arrives complete.
    await type('Verification code', '123 456');

    // Step 4: recovery codes
    expect(await view.findByRole('heading', { name: 'Recovery codes' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === 'invites/tok/accept')?.body).toEqual({
      name: 'Jonas Schulz',
      password: 'Safe-enough1',
      code: '123456',
    });
    const list = view.getByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(view.queryByRole('button', { name: 'Back' })).toBeNull();
    await click('Activate account');
    expect(view.getByText('Confirm that you’ve saved the codes.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }));
    await click('Activate account');

    // Welcome, then load settings and account and go to the start page
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Jonas');
    await vi.advanceTimersByTimeAsync(2700);
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/start'));
    expect(calls.map((c) => `${c.method} ${c.path}`).slice(-2)).toEqual(['GET settings', 'GET auth/me']);
    expect(session.user?.email).toBe('jonas.schulz@example.com');
  });

  it('reports a wrong code and locks after too many with a countdown', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
      'POST invites/tok/totp': [{ body: { secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` } }],
      'POST invites/tok/accept': [
        { status: 422, body: { error: 'invalid_code' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 900 } },
      ],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');
    // Name from the invitation is prefilled
    expect(view.getByLabelText('Your name')).toHaveValue('Jonas Schulz');
    await type('Choose a password', 'Safe-enough1');
    await click('Continue');
    await view.findByRole('heading', { name: 'Multi-factor authentication' });
    await type('Verification code', '000000');
    expect(await view.findByText('Invalid code.')).toBeInTheDocument();
    await type('Verification code', '111111');
    expect(await view.findByText('Too many incorrect codes.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Confirm in 15:00' })).toBeDisabled();
    expect(view.getByLabelText('Verification code')).toBeDisabled();
  });

  it('locks “Continue” after 429 with lock and countdown', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
      'POST invites/tok/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 360 } }],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');
    await type('Choose a password', 'Safe-enough1');
    await click('Continue');
    const button = await view.findByRole('button', { name: 'Continue in 6:00' });
    expect(button).toBeDisabled();
    expect(button.style.opacity).toBe('0.55');
    expect(view.getByText('Too many requests.')).toBeInTheDocument();
  });

  it('locks “Request a new invitation” after 429 with lock and countdown', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, expired: true } }],
      'POST invites/tok/request': [{ status: 429, body: { error: 'rate_limited', retry_after: 360 } }],
    });
    const view = renderPage();
    await view.findByRole('heading', { name: 'Invitation expired' });
    await click('Request a new invitation');
    const button = await view.findByRole('button', { name: 'Request a new invitation in 6:00' });
    expect(button).toBeDisabled();
    expect(button.style.opacity).toBe('0.55');
  });

  it('ends a previous session of the browser on accepting', async () => {
    session.user = {
      ...ME,
      id: '01J',
      email: 'old@example.com',
      display_name: 'Alt',
      role: 'admin',
      mfa_enabled: false,
      sole_admin: false,
    };
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
      'POST invites/tok/totp': [{ body: { secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` } }],
      'POST invites/tok/accept': [{ status: 201, body: { user: USER, recovery_codes: CODES } }],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');
    await type('Choose a password', 'Safe-enough1');
    await click('Continue');
    await view.findByRole('heading', { name: 'Multi-factor authentication' });
    await type('Verification code', '123456');
    await view.findByRole('heading', { name: 'Recovery codes' });
    expect(session.user).toBeNull();
  });

  it('requests a new invitation for an expired one', async () => {
    const { calls } = mockApi({
      'GET invites/tok': [{ body: { ...INFO, expired: true } }],
      'POST invites/tok/request': [{ status: 202 }],
    });
    const view = renderPage();
    expect(await view.findByRole('heading', { level: 1 })).toHaveTextContent('Invitation expired');
    expect(view.getByText('jonas.schulz@example.com').closest('p')).toHaveTextContent(
      /^The invitation for jonas\.schulz@example\.com was valid until .+\. Ask Anna Becker for a new one\.$/,
    );
    expect(view.queryByRole('img', { name: /^Step / })).toBeNull();
    await click('Request a new invitation');
    expect(await view.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: 'invites/tok/request' });
    expect(view.getByText(/Anna Becker has been notified/)).toBeInTheDocument();
    await click('Go to sign-in');
    expect(nav.goto).toHaveBeenCalledWith('/login');
  });

  it('reports an unexpected error as an error toast', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, expired: true } }],
      'POST invites/tok/request': [{ status: 500, body: { error: 'internal' } }],
    });
    const view = renderPage();
    expect(await view.findByRole('heading', { level: 1 })).toHaveTextContent('Invitation expired');
    await click('Request a new invitation');
    await vi.waitFor(() => expect(ui.toast).not.toBeNull());
    expect(ui.toast).toMatchObject({
      text: 'That didn’t work. Please try again.',
      error: true,
      undo: false,
    });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Invitation expired');
  });

  it('shows the 404 error page for unknown links', async () => {
    mockApi({ 'GET invites/tok': [{ status: 404, body: { error: 'not_found' } }] });
    const view = renderPage();
    expect(await view.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(view.getByText('Error 404')).toBeInTheDocument();
  });

  it('reloads after an error with “Try again”', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({ 'GET invites/tok': [{ status: 500, body: { error: 'internal' } }, { body: INFO }] });
    const view = renderPage();
    expect(await view.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    await click('Try again');
    await vi.advanceTimersByTimeAsync(900);
    expect(await view.findByRole('heading', { name: 'Welcome to Roedy Mail' })).toBeInTheDocument();
  });
});
