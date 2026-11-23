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
/** Heading of the authenticator step (with its soft hyphen). */
const MFA_TITLE = 'Multi-factor authen\u00adtication';
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
  vi.restoreAllMocks();
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
    expect(view.getByText('AB')).toHaveAttribute('aria-hidden', 'true');
    expect(
      view.getByText('Anna Becker has invited you. Review the details and accept the invitation.'),
    ).toBeInTheDocument();
    const details = view.getByRole('list', { name: 'Invitation details' });
    expect(
      within(details)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Email address jonas.schulz@example.com',
      'Role User · Example Ltd',
      expect.stringMatching(/^Invitation valid until \S+ 2 November$/),
    ]);
    expect(view.getByRole('img', { name: 'Step 1 of 4' })).toBeInTheDocument();
    expect(ui.authTitle).toBe('Welcome to Roedy Mail');
    // Mobile (jsdom has no layout): “Accept invitation” alone in the bottom bar, no Back on step 1.
    expect(view.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Back/ })).toBeNull();
    expect(view.queryByRole('list', { name: 'Invitation steps' })).toBeNull();
    expect(view.getByText('Already registered?', { exact: false })).toHaveTextContent('Already registered? Sign in');
    expect(view.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    // No footer: no © line and no legal links.
    expect(view.queryByText(/©/)).toBeNull();
    expect(view.queryByRole('contentinfo')).toBeNull();
  });

  it('shows the step overview in two columns and “Accept invitation” as the form’s submit button', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(860);
    mockApi({ 'GET invites/tok': [{ body: INFO }] });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    const steps = view.getByRole('list', { name: 'Invitation steps' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toEqual(['1 Invitation', '2 Name and password', '3 Authenticator app', '4 Recovery codes']);
    expect(within(steps).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');
    const accept = view.getByRole('button', { name: 'Accept invitation' });
    expect(accept).toHaveAttribute('type', 'submit');
    expect(accept.closest('form')).not.toBeNull();
    // No focus anywhere on opening.
    expect(document.activeElement).toBe(document.body);
  });

  it('names “your administrator” without an inviter and the role without an organisation name', async () => {
    mockApi({ 'GET invites/tok': [{ body: { ...INFO, inviter: null, role: 'admin' } }] });
    session.config = { ...CONFIG, org: { ...CONFIG.org, name: null } };
    const view = render(Page);
    await view.findByRole('heading', { level: 1 });
    expect(view.getByText('Invitation from your administrator')).toBeInTheDocument();
    expect(view.getByText('R')).toHaveAttribute('aria-hidden', 'true');
    expect(
      view.getByText('Your administrator has invited you. Review the details and accept the invitation.'),
    ).toBeInTheDocument();
    const details = view.getByRole('list', { name: 'Invitation details' });
    expect(within(details).getAllByRole('listitem')[1]).toHaveTextContent(/^Role Administrator$/);
  });

  it('keeps step 1 when coming back from step 2', async () => {
    const { calls } = mockApi({ 'GET invites/tok': [{ body: INFO }] });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    // Enter on the step does what “Accept invitation” does.
    await fireEvent.keyDown(view.getByRole('heading', { level: 1 }), { key: 'Enter' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your account');
    await type('Your name', 'Jonas Schulz');
    await click('Back');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome to Roedy Mail');
    await click('Accept invitation');
    expect(view.getByLabelText('Your name')).toHaveValue('Jonas Schulz');
    expect(calls.map((c) => c.path)).toEqual(['invites/tok']);
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
    expect(await view.findByRole('heading', { name: MFA_TITLE })).toBeInTheDocument();
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
    await view.findByRole('heading', { name: MFA_TITLE });
    await type('Verification code', '000000');
    expect(await view.findByText('Invalid code.')).toBeInTheDocument();
    // Under the code boxes, as the setup token's messages.
    const bad = view.container.querySelector('#in-code-alert');
    expect(bad).not.toBeNull();
    expect(
      view.getByLabelText('Verification code').compareDocumentPosition(bad!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await type('Verification code', '111111');
    expect(await view.findByText('Too many incorrect codes.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Confirm in 15:00' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Confirm in 15:00' }).style.opacity).toBe('0.55');
    const input = view.getByLabelText('Verification code');
    expect(input).toBeDisabled();
    // Only field and button are locked, the boxes stay opaque.
    expect(input.closest<HTMLElement>('.code-ctl')?.style.opacity).toBe('1');
  });

  it('shows maintenance mode as a status rather than an alert', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
      'POST invites/tok/totp': [{ body: { secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` } }],
      'POST invites/tok/accept': [{ status: 503, body: { error: 'maintenance', message: 'Back at 6 pm.' } }],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');
    await type('Choose a password', 'Safe-enough1');
    await click('Continue');
    await view.findByRole('heading', { name: MFA_TITLE });
    await type('Verification code', '123456');
    expect(await view.findByRole('status')).toHaveTextContent('Back at 6 pm.');
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
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
    await view.findByRole('heading', { name: MFA_TITLE });
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

  it('shows only the placeholders of the card until the invitation is loaded', () => {
    mockApi({ 'GET invites/tok': [() => new Promise(() => {})] });
    const view = renderPage();
    const status = view.getByRole('status', { name: 'Checking …' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.textContent?.trim()).toBe('');
    for (const shape of status.children) expect(shape).toHaveAttribute('aria-hidden', 'true');
    expect(view.queryByRole('heading', { level: 1 })).toBeNull();
    expect(view.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    // No step bars yet; the light/dark button is there.
    expect(view.queryByRole('img', { name: /^Step / })).toBeNull();
    expect(view.getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeInTheDocument();
    expect(ui.authTitle).toBe('Welcome to Roedy Mail');
  });

  it('shows the error card in the page frame and keeps it with “Checking …” while trying again', async () => {
    let answer: (value: { body: InviteInfo }) => void = () => {};
    mockApi({
      'GET invites/tok': [
        () => Promise.reject(new TypeError('Failed to fetch')),
        () => new Promise((resolve) => (answer = resolve)),
      ],
    });
    const view = renderPage();
    const card = await view.findByRole('alert');
    expect(within(card).getByRole('heading', { level: 1 })).toHaveTextContent('No connection');
    expect(card).toHaveTextContent('Check your internet connection and try again.');
    expect(view.queryByText('Copy details')).toBeNull();
    expect(view.queryByRole('img', { name: /^Step / })).toBeNull();
    // Desktop: the focus on “Try again”.
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Try again' }));
    await click('Try again');
    const busy = within(card).getByRole('button', { name: 'Checking …' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(busy);
    answer({ body: INFO });
    expect(await view.findByRole('heading', { name: 'Welcome to Roedy Mail' })).toBeInTheDocument();
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

  it('shows “No connection” when a request of a step gets no answer and keeps what was entered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockApi({
      'GET invites/tok': [{ body: INFO }],
      'POST invites/tok/totp': [() => Promise.reject(new TypeError('Failed to fetch'))],
      'GET public/config': [{ body: CONFIG }],
    });
    const view = renderPage();
    await view.findByRole('heading', { level: 1 });
    await click('Accept invitation');
    await type('Your name', 'Jonas Schulz');
    await type('Choose a password', 'Safe-enough1');
    await click('Continue');
    const dialog = await view.findByRole('alertdialog', { name: 'No connection' });
    expect(ui.toast).toBeNull();
    // The screen behind is hidden while the message covers it.
    expect(view.getByRole('heading', { level: 1, hidden: true }).closest('[aria-hidden="true"]')).not.toBeNull();
    // The first answer of `public/config` closes it; everything entered stays.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Try now' }));
    await vi.waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: 'public/config' });
    expect(view.getByLabelText('Your name')).toHaveValue('Jonas Schulz');
    expect(view.getByLabelText('Choose a password')).toHaveValue('Safe-enough1');
  });

  it('shows “No connection” when the window goes offline, but not for a server error', async () => {
    mockApi({
      'GET invites/tok': [{ body: { ...INFO, expired: true } }],
      'POST invites/tok/request': [{ status: 500, body: { error: 'internal' } }],
    });
    const view = renderPage();
    await view.findByRole('heading', { name: 'Invitation expired' });
    await click('Request a new invitation');
    await vi.waitFor(() => expect(ui.toast).not.toBeNull());
    expect(view.queryByRole('alertdialog')).toBeNull();
    await fireEvent(window, new Event('offline'));
    expect(await view.findByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
  });
});
