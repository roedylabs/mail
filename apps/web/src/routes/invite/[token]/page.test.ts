// Page tests of the invitation, one block per screen (the components in
// `#lib/components/invite/`) plus the whole way through; the flow's rules
// (requests, locks, what stays in memory) are in `#lib/invite.test.ts`.
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
/** Heading of the recovery codes step. */
const CODES_TITLE = 'Recovery codes';
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

/** Invitation with a name and a key for step 3 (fresh answers for each test). */
function mfaRoutes() {
  return {
    'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
    'POST invites/tok/totp': [{ body: { secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` } }],
  };
}

/** Through steps 1 and 2 to step 3. */
async function toStep3() {
  const view = renderPage();
  await view.findByRole('heading', { level: 1 });
  await click('Accept invitation');
  await type('Choose a password', 'Safe-enough1');
  await type('Confirm password', 'Safe-enough1');
  await click('Continue');
  await view.findByRole('heading', { name: MFA_TITLE });
  return view;
}

/** Through steps 1–3 to step 4 (the codes from `accept`); `more` adds answers (settings, account). */
async function toStep4(more: Record<string, unknown[]> = {}) {
  const api = mockApi({
    ...mfaRoutes(),
    'POST invites/tok/accept': [{ status: 201, body: { user: USER, recovery_codes: CODES } }],
    ...more,
  });
  const view = await toStep3();
  await type('Verification code', '123456');
  await view.findByRole('heading', { name: CODES_TITLE });
  return { view, calls: api.calls };
}

/** Desktop at 1280 × 860 (jsdom has no layout). */
function desktop() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(860);
}

/** Runs `body` at the reference phone's width (393 px). */
async function onMobile(body: () => Promise<void>) {
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

describe('Invitation page', () => {
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
    expect(ui.authTitle).toBe('Set up your account · Invitation');
    // Greyed out until complete; pressed anyway, it says what is missing.
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await click('Continue');
    expect(view.getByText('Please enter your name.')).toBeInTheDocument();
    await type('Your name', 'Jonas Schulz');
    await type('Choose a password', 'Safe-enough1');
    await type('Confirm password', 'Safe-enough1');
    const rules = view.getByRole('list', { name: 'Password requirements' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(4);
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false');
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

  describe('loading and load error', () => {
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

    it('shows the 404 error page for unknown links', async () => {
      mockApi({ 'GET invites/tok': [{ status: 404, body: { error: 'not_found' } }] });
      const view = renderPage();
      expect(await view.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      expect(view.getByText('Error 404')).toBeInTheDocument();
    });
  });

  describe('step 1: invitation', () => {
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
      desktop();
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
  });

  describe('step 2: name and password', () => {
    it('builds step 2 with the name, the check card and both password fields', async () => {
      mockApi({ 'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }] });
      const view = renderPage();
      await view.findByRole('heading', { level: 1 });
      await click('Accept invitation');
      const name = view.getByLabelText('Your name');
      const pw = view.getByLabelText('Choose a password');
      const pw2 = view.getByLabelText('Confirm password');
      expect(name).toHaveAttribute('autocomplete', 'name');
      expect(name).toHaveAttribute('maxlength', '100');
      expect(name).toHaveAttribute('placeholder', 'First and last name');
      expect(pw).toHaveAttribute('id', 'in-pw');
      expect(pw).toHaveAttribute('name', 'new-password');
      expect(pw).toHaveAttribute('autocomplete', 'new-password');
      expect(pw).toHaveAttribute('aria-describedby', 'in-pw-rules in-pw-kbd');
      expect(pw2).toHaveAttribute('id', 'in-pw2');
      expect(pw2).toHaveAttribute('name', 'confirm-password');
      expect(pw2).toHaveAttribute('placeholder', 'Enter it again');
      // The invited address for password managers: hidden, not focusable.
      const user = view.container.querySelector<HTMLInputElement>('input[name="username"]');
      expect(user?.value).toBe('jonas.schulz@example.com');
      expect(user).toHaveAttribute('autocomplete', 'username');
      expect(user).toHaveAttribute('tabindex', '-1');
      expect(user?.hidden).toBe(true);
      // Tab order: name → password → confirm → Back → Continue; the eyes are out of it, each field has its own.
      const order = [
        name,
        pw,
        pw2,
        view.getByRole('button', { name: 'Back' }),
        view.getByRole('button', { name: 'Continue' }),
      ];
      for (const [a, b] of order.slice(0, -1).map((el, i) => [el, order[i + 1]!] as const)) {
        expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      const eye = view.getByRole('button', { name: 'Show password' });
      const eye2 = view.getByRole('button', { name: 'Show confirmed password' });
      expect(eye).toHaveAttribute('tabindex', '-1');
      expect(eye2).toHaveAttribute('tabindex', '-1');
      await fireEvent.click(eye2);
      expect(pw2).toHaveAttribute('type', 'text');
      expect(pw).toHaveAttribute('type', 'password');
      expect(view.getByRole('button', { name: 'Hide confirmed password' })).toHaveAttribute('aria-pressed', 'true');

      // Invalid characters while typing: the message right under the field.
      await type('Your name', 'Jonas (Sales)');
      const nameErr = view.getByRole('alert');
      expect(nameErr).toHaveAttribute('id', 'in-name-err');
      expect(nameErr).toHaveTextContent('The name contains invalid characters.');
      expect(name).toHaveAttribute('aria-invalid', 'true');
      expect(name).toHaveAttribute('aria-describedby', 'in-name-err');
      await type('Your name', 'Jonas Schulz');
      expect(view.queryByRole('alert')).toBeNull();

      // Too long while typing; “Passwords match” for screen readers, no mark in the field.
      await type('Choose a password', 'aA1' + '€'.repeat(400));
      expect(view.getByRole('alert')).toHaveTextContent('The password is too long.');
      expect(pw).toHaveAttribute('aria-describedby', 'in-pw-err in-pw-rules in-pw-kbd');
      await type('Choose a password', 'Safe-enough1');
      expect(view.container.querySelector('#in-pw2-ok')).toHaveTextContent(/^$/);
      await type('Confirm password', 'Safe-enough1');
      expect(view.container.querySelector('#in-pw2-ok')).toHaveTextContent('Passwords match');

      // A filled confirmation that differs: the message under it on Continue.
      await type('Confirm password', 'Safe-enough2');
      await click('Continue');
      const mismatch = view.getByRole('alert');
      expect(mismatch).toHaveAttribute('id', 'in-pw2-err');
      expect(mismatch).toHaveTextContent('The passwords don’t match.');
      expect(pw2).toHaveAttribute('aria-invalid', 'true');
      await vi.waitFor(() => expect(document.activeElement).toBe(pw2));
      await type('Choose a password', 'Safe-enough2');
      expect(view.queryByRole('alert')).toBeNull();

      // Back and forward again: the eyes are hidden again, everything else as it was.
      await click('Back');
      await click('Accept invitation');
      expect(view.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
      expect(view.getByLabelText('Confirm password')).toHaveValue('Safe-enough2');
    });

    it('focuses the name when entering step 2, on mobile the heading (the keyboard stays closed)', async () => {
      mockApi({ 'GET invites/tok': [{ body: INFO }, { body: INFO }] });
      const desktop = renderPage();
      await desktop.findByRole('heading', { level: 1 });
      await fireEvent.click(desktop.getByRole('button', { name: 'Accept invitation' }));
      await vi.waitFor(() => expect(document.activeElement).toBe(desktop.getByLabelText('Your name')));
      desktop.unmount();
      await onMobile(async () => {
        const view = renderPage();
        await view.findByRole('heading', { level: 1 });
        await fireEvent.click(view.getByRole('button', { name: 'Accept invitation' }));
        await vi.waitFor(() =>
          expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Set up your account' })),
        );
        // A missing field gets the focus on mobile too.
        await type('Your name', 'Jonas Schulz');
        await click('Continue');
        await vi.waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Choose a password')));
      });
    });

    it('greys out “Continue” after 429 and shows the lock under the confirmation', async () => {
      mockApi({
        'GET invites/tok': [{ body: { ...INFO, name: 'Jonas Schulz' } }],
        'POST invites/tok/totp': [{ status: 429, body: { error: 'rate_limited', retry_after: 360 } }],
      });
      const view = renderPage();
      await view.findByRole('heading', { level: 1 });
      await click('Accept invitation');
      await type('Choose a password', 'Safe-enough1');
      await type('Confirm password', 'Safe-enough1');
      await click('Continue');
      const lock = await view.findByRole('alert');
      expect(lock).toHaveAttribute('id', 'in-lock');
      expect(lock).toHaveTextContent(/^Too many requests\.\s*Try again in 6 minutes\./);
      // The bar and m:ss are not read (the alert would be announced every second).
      expect(within(lock).getByText('6:00').closest('[aria-hidden="true"]')).not.toBeNull();
      expect(
        view.getByLabelText('Confirm password').compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // No time on the button; the fields stay editable.
      expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
      expect(view.queryByRole('button', { name: /Continue in/ })).toBeNull();
      expect(view.getByLabelText('Your name')).toBeEnabled();
    });
  });

  describe('step 3: authenticator app', () => {
    it('builds step 3 with the authenticator box, the code field and Confirm', async () => {
      desktop();
      const { calls } = mockApi(mfaRoutes());
      const view = await toStep3();
      expect(ui.authTitle).toBe('Authenticator app · Invitation');
      expect(view.getByRole('img', { name: 'Step 3 of 4' })).toBeInTheDocument();
      expect(
        view.getByText('Scan the QR code with your authenticator app and enter the code it shows.'),
      ).toBeInTheDocument();
      const steps = view.getByRole('list', { name: 'Invitation steps' });
      expect(within(steps).getAllByRole('listitem')[2]).toHaveAttribute('aria-current', 'step');
      // The QR code on its white tile, the key in groups of four.
      const qr = view.getByRole('img', { name: 'QR code for the authenticator app' });
      expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M0 0h7v1h-7z/);
      expect(view.getByText('Or enter the key manually')).toBeInTheDocument();
      expect(view.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
      const input = view.getByLabelText('Verification code');
      expect(input).toHaveAttribute('id', 'in-otp');
      expect(input).toHaveAttribute('type', 'text');
      expect(input).toHaveAttribute('name', 'otp');
      expect(input).toHaveAttribute('inputmode', 'numeric');
      expect(input).toHaveAttribute('autocomplete', 'one-time-code');
      // Entering: the code field on desktop.
      await vi.waitFor(() => expect(document.activeElement).toBe(input));
      // Focus order: Copy key → code → Back → Confirm.
      const form = input.closest('form')!;
      const order = [...form.querySelectorAll<HTMLElement>('button, input:not([hidden])')]
        .filter((el) => el.tabIndex >= 0)
        .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.textContent?.trim());
      expect(order.slice(-4)).toEqual(['Copy key', 'otp', 'Back', 'Confirm']);
      // Confirm is a real submit button, not greyed out for an empty code.
      const confirm = view.getByRole('button', { name: 'Confirm' });
      expect(confirm).toHaveAttribute('type', 'submit');
      expect(confirm).toHaveAttribute('aria-disabled', 'false');
      expect(calls.filter((c) => c.path === 'invites/tok/totp')).toHaveLength(1);
    });

    it('asks for all six digits on Confirm or Enter with fewer, without a request', async () => {
      const { calls } = mockApi(mfaRoutes());
      const view = await toStep3();
      await type('Verification code', '12a3');
      const input = view.getByLabelText('Verification code');
      expect(input).toHaveValue('123');
      await click('Confirm');
      const short = view.getByRole('alert');
      expect(short).toHaveAttribute('id', 'in-otp-err');
      expect(short).toHaveTextContent('Please enter all 6 digits.');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAttribute('aria-describedby', 'in-otp-err');
      expect(document.activeElement).toBe(input);
      // Any edit clears it; Enter on the step does the same as Confirm.
      await type('Verification code', '1234');
      expect(view.queryByRole('alert')).toBeNull();
      expect(input).toHaveAttribute('aria-invalid', 'false');
      await fireEvent.keyDown(view.getByRole('heading', { name: MFA_TITLE }), { key: 'Enter' });
      expect(view.getByRole('alert')).toHaveTextContent('Please enter all 6 digits.');
      expect(calls.filter((c) => c.path === 'invites/tok/accept')).toHaveLength(0);
    });

    it('shows “Checking …” and locks Back while the code is checked', async () => {
      let answer: (value: { status: number; body: unknown }) => void = () => {};
      mockApi({ ...mfaRoutes(), 'POST invites/tok/accept': [() => new Promise((resolve) => (answer = resolve))] });
      const view = await toStep3();
      await type('Verification code', '123456');
      const busy = view.getByRole('button', { name: 'Checking …' });
      expect(busy).toHaveAttribute('aria-busy', 'true');
      expect(view.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true');
      await click('Back');
      expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(MFA_TITLE);
      answer({ status: 201, body: { user: USER, recovery_codes: CODES } });
      expect(await view.findByRole('heading', { name: 'Recovery codes' })).toBeInTheDocument();
    });

    it('reports a wrong code under the code boxes until the next edit', async () => {
      mockApi({ ...mfaRoutes(), 'POST invites/tok/accept': [{ status: 422, body: { error: 'invalid_code' } }] });
      const view = await toStep3();
      await type('Verification code', '000000');
      const bad = await view.findByRole('alert');
      expect(bad).toHaveAttribute('id', 'in-code-alert');
      expect(bad).toHaveTextContent(/^Invalid code\.\s*Check the current code in your app and try again\.$/);
      const input = view.getByLabelText('Verification code');
      expect(input.compareDocumentPosition(bad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(input).toHaveValue('');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAttribute('aria-describedby', 'in-code-alert');
      expect(document.activeElement).toBe(input);
      await type('Verification code', '1');
      expect(view.queryByRole('alert')).toBeNull();
      expect(input).toHaveAttribute('aria-invalid', 'false');
    });

    it('locks the code after too many with a greyed-out Confirm until the time has run out', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockApi({
        ...mfaRoutes(),
        'POST invites/tok/accept': [{ status: 429, body: { error: 'rate_limited', retry_after: 900 } }],
      });
      const view = await toStep3();
      await type('Verification code', '111111');
      const lock = await view.findByRole('alert');
      expect(lock).toHaveAttribute('id', 'in-code-alert');
      expect(lock).toHaveTextContent(/^Too many incorrect codes\.\s*Try again in 15 minutes\./);
      // The bar and m:ss are not read.
      expect(within(lock).getByText('15:00').closest('[aria-hidden="true"]')).not.toBeNull();
      // Confirm greyed out, without a time on it.
      expect(view.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'true');
      expect(view.queryByRole('button', { name: /Confirm in/ })).toBeNull();
      const input = view.getByLabelText('Verification code');
      expect(input).toBeDisabled();
      expect(input).toHaveAttribute('aria-invalid', 'false');
      expect(input).toHaveAttribute('aria-describedby', 'in-code-alert');
      expect(input.closest('.code-ctl')?.querySelector<HTMLElement>('.boxes')?.style.opacity).toBe('0.5');
      // When it runs out: the field is usable again and gets the focus, the message goes.
      await vi.advanceTimersByTimeAsync(900_000);
      await vi.waitFor(() => expect(view.queryByRole('alert')).toBeNull());
      expect(input).toBeEnabled();
      expect(view.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'false');
      await vi.waitFor(() => expect(document.activeElement).toBe(input));
    });

    it('shows the same key again after “Back” from step 3, without a second request', async () => {
      const { calls } = mockApi(mfaRoutes());
      const view = await toStep3();
      await type('Verification code', '12');
      await click('Back');
      expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your account');
      expect(view.getByLabelText('Confirm password')).toHaveValue('Safe-enough1');
      await click('Continue');
      await view.findByRole('heading', { name: MFA_TITLE });
      expect(view.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
      expect(view.getByLabelText('Verification code')).toHaveValue('');
      expect(calls.filter((c) => c.path === 'invites/tok/totp')).toHaveLength(1);
    });

    it('shows maintenance mode above the code as a status rather than an alert', async () => {
      mockApi({
        ...mfaRoutes(),
        'POST invites/tok/accept': [
          { status: 503, body: { error: 'maintenance', message: 'Back at 6 pm.' } },
          { status: 503, body: { error: 'maintenance' } },
        ],
      });
      const view = await toStep3();
      await type('Verification code', '123456');
      const notice = await vi.waitFor(() => {
        const el = view.container.querySelector<HTMLElement>('#in-code-alert');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(notice).toHaveAttribute('role', 'status');
      expect(notice).toHaveTextContent(/^Maintenance\s*Back at 6 pm\.$/);
      expect(view.queryByRole('alert')).not.toBeInTheDocument();
      const input = view.getByLabelText('Verification code');
      expect(input.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(input).toHaveValue('');
      expect(input).toHaveAttribute('aria-invalid', 'false');
      expect(input).toHaveAttribute('aria-describedby', 'in-code-alert');
      expect(document.activeElement).toBe(input);
      // It stays while typing; without the administrator's notice the default text.
      await type('Verification code', '12345');
      expect(view.getByText('Back at 6 pm.')).toBeInTheDocument();
      await type('Verification code', '123456');
      expect(
        await view.findByText('We’re performing maintenance right now. Please try again in an hour.'),
      ).toBeInTheDocument();
    });

    it('shows the error toast when copying the key fails, without “Copied”', async () => {
      vi.stubGlobal('navigator', {
        ...navigator,
        clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no'))) },
      });
      mockApi(mfaRoutes());
      const view = await toStep3();
      await click('Copy key');
      await vi.waitFor(() => expect(ui.toast).toMatchObject({ text: 'Couldn’t copy.', error: true }));
      expect(view.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
      expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
    });

    it('focuses the heading when entering step 3 on mobile and leaves the keyboard alone after a short code', async () => {
      mockApi(mfaRoutes());
      await onMobile(async () => {
        const view = await toStep3();
        const heading = view.getByRole('heading', { name: MFA_TITLE });
        await vi.waitFor(() => expect(document.activeElement).toBe(heading));
        await click('Confirm');
        expect(view.getByRole('alert')).toHaveTextContent('Please enter all 6 digits.');
        expect(document.activeElement).not.toBe(view.getByLabelText('Verification code'));
        // Back in the bottom bar goes to step 2.
        await click('Back');
        expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your account');
      });
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
      await toStep4();
      expect(session.user).toBeNull();
    });
  });

  describe('step 4: recovery codes', () => {
    it('builds step 4 with the codes card, the checkbox and “Activate account” only', async () => {
      desktop();
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const { view, calls } = await toStep4();
      expect(ui.authTitle).toBe('Recovery codes · Invitation');
      expect(view.getByRole('img', { name: 'Step 4 of 4' })).toBeInTheDocument();
      const steps = view.getByRole('list', { name: 'Invitation steps' });
      expect(within(steps).getAllByRole('listitem')[3]).toHaveAttribute('aria-current', 'step');
      expect(
        view.getByText(
          'Use these codes to sign in if you can’t access your authenticator app. Each code can only be used once.',
        ),
      ).toBeInTheDocument();
      // Entering: the heading, reading the codes comes first.
      const heading = view.getByRole('heading', { name: CODES_TITLE });
      await vi.waitFor(() => expect(document.activeElement).toBe(heading));
      expect(heading).toHaveAttribute('tabindex', '-1');
      // The ten codes, numbered 1–10 (the numbers hidden from screen readers).
      const list = view.getByRole('list', { name: 'Recovery codes' });
      const items = within(list).getAllByRole('listitem');
      expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual(
        CODES.map((code, i) => `${i + 1} ${code}`),
      );
      expect(items[0]?.querySelector('[aria-hidden="true"]')).toHaveTextContent('1');
      // No Back on this step: the account exists.
      expect(view.queryByRole('button', { name: /Back/ })).toBeNull();
      // Focus order: Copy → Download → checkbox → Activate account.
      const copy = view.getByRole('button', { name: 'Copy: Recovery codes' });
      const download = view.getByRole('button', { name: 'Download' });
      const box = view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' });
      const activate = view.getByRole('button', { name: 'Activate account' });
      const order = [copy, download, box, activate];
      for (let i = 1; i < order.length; i++) {
        expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(box).toHaveAttribute('type', 'button');
      expect(box).toHaveAttribute('aria-checked', 'false');
      expect(activate).toHaveAttribute('type', 'submit');
      expect(activate).not.toHaveAttribute('aria-disabled', 'true');
      expect(activate.closest('form')).not.toBeNull();
      // Copy: one code per line, "Copied" for 2 s.
      await fireEvent.click(copy);
      expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
      expect(await view.findByRole('button', { name: 'Copied' })).toHaveTextContent('Copied');
      // The step sends nothing.
      expect(calls.at(-1)?.path).toBe('invites/tok/accept');
    });

    it('downloads the codes with the invited address', async () => {
      let blob: Blob | undefined;
      Object.defineProperty(URL, 'createObjectURL', {
        value: vi.fn((b: Blob) => ((blob = b), 'blob:codes')),
        configurable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
      const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      await toStep4();
      await click('Download');
      expect(clicked).toHaveBeenCalledOnce();
      expect((clicked.mock.contexts[0] as HTMLAnchorElement).download).toBe('recovery-codes.txt');
      expect(await blob?.text()).toBe(`Roedy Mail – Recovery codes\n${INFO.email}\n\n${CODES.join('\n')}\n`);
    });

    it('shows the error toast when copying the codes fails, without “Copied”', async () => {
      vi.stubGlobal('navigator', {
        ...navigator,
        clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no'))) },
      });
      const { view } = await toStep4();
      await click('Copy: Recovery codes');
      await vi.waitFor(() => expect(ui.toast).toMatchObject({ text: 'Couldn’t copy.', error: true }));
      expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
    });

    it('asks to confirm the saved codes under the checkbox and moves the focus there', async () => {
      desktop();
      const { view } = await toStep4();
      const box = view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' });
      // Enter on the step (here the heading) does what “Activate account” does.
      await fireEvent.keyDown(view.getByRole('heading', { name: CODES_TITLE }), { key: 'Enter' });
      // (The height fit measures the other language first: wait until it settled.)
      await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Confirm that you’ve saved the codes.'));
      expect(view.getByRole('alert')).toHaveAttribute('id', 'in-saved-err');
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(box).toHaveAttribute('aria-describedby', 'in-saved-err');
      await vi.waitFor(() => expect(document.activeElement).toBe(box));
      // Enter on the checkbox stays the checkbox's own.
      await fireEvent.keyDown(box, { key: 'Enter' });
      expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(CODES_TITLE);
      // Ticking clears the error.
      await fireEvent.click(box);
      expect(box).toHaveAttribute('aria-checked', 'true');
      expect(box).toHaveAttribute('aria-invalid', 'false');
      expect(box).not.toHaveAttribute('aria-describedby');
      expect(view.queryByRole('alert')).toBeNull();
    });
  });

  describe('welcome', () => {
    it('welcomes with the first name and what was set up, then opens the start page', async () => {
      desktop();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { view, calls } = await toStep4({
        'GET settings': [{ body: { version: 1, settings: { ...RESET0, tzAuto: false } } }],
        'GET auth/me': [{ body: ME }],
      });
      await fireEvent.click(view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }));
      await click('Activate account');
      const heading = view.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('Welcome, Jonas');
      expect(ui.authTitle).toBe('Welcome to Roedy Mail');
      await vi.waitFor(() => expect(document.activeElement).toBe(heading));
      const status = view.getByRole('status');
      expect(status).toContainElement(heading);
      expect(within(status).getByText('Your account is set up.')).toBeInTheDocument();
      expect(within(status).getByText('Redirecting you to Roedy Mail …')).toBeInTheDocument();
      const chips = view.getByRole('list', { name: 'Done' });
      expect(
        within(chips)
          .getAllByRole('listitem')
          .map((li) => li.textContent?.trim()),
      ).toEqual(['Account created', 'Authenticator app linked', 'Recovery codes saved']);
      // No step bars, no actions.
      expect(view.queryByRole('img', { name: /Step \d of 4/ })).toBeNull();
      expect(view.queryByRole('button', { name: 'Activate account' })).toBeNull();
      expect(nav.goto).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2700);
      await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/start'));
      expect(calls.map((c) => `${c.method} ${c.path}`).slice(-2)).toEqual(['GET settings', 'GET auth/me']);
    });

    it('goes back to the codes with the ticked box when the session did not arrive', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { view } = await toStep4({
        'GET settings': [{ status: 401, body: { error: 'unauthorized' } }],
        'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
      });
      await fireEvent.click(view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }));
      await click('Activate account');
      await vi.advanceTimersByTimeAsync(2700);
      await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(CODES_TITLE));
      expect(ui.toast).toMatchObject({
        text: 'Couldn’t sign in. Allow cookies for this site and try again.',
        error: true,
      });
      expect(view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(within(view.getByRole('list', { name: 'Recovery codes' })).getAllByRole('listitem')).toHaveLength(10);
      expect(nav.goto).not.toHaveBeenCalled();
      // "Activate account" again tries again.
      await click('Activate account');
      expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Jonas');
    });

    it('focuses the heading of step 4 and of “Welcome” on mobile, “Activate account” in the bottom bar', async () => {
      await onMobile(async () => {
        const { view } = await toStep4();
        const heading = view.getByRole('heading', { name: CODES_TITLE });
        await vi.waitFor(() => expect(document.activeElement).toBe(heading));
        expect(view.queryByRole('button', { name: /Back/ })).toBeNull();
        await click('Activate account');
        expect(view.getByRole('alert')).toHaveTextContent('Confirm that you’ve saved the codes.');
        await vi.waitFor(() =>
          expect(document.activeElement).toBe(
            view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }),
          ),
        );
        await fireEvent.click(view.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }));
        await click('Activate account');
        const welcome = view.getByRole('heading', { level: 1 });
        expect(welcome).toHaveTextContent('Welcome, Jonas');
        await vi.waitFor(() => expect(document.activeElement).toBe(welcome));
      });
    });
  });

  describe('invitation expired and request sent', () => {
    it('requests a new invitation for an expired one', async () => {
      const { calls } = mockApi({
        'GET invites/tok': [{ body: { ...INFO, expired: true } }],
        'POST invites/tok/request': [{ status: 202 }],
      });
      const view = renderPage();
      const expired = await view.findByRole('heading', { level: 1 });
      expect(expired).toHaveTextContent('Invitation expired');
      expect(ui.authTitle).toBe('Welcome to Roedy Mail');
      // Screen readers start at the result.
      await vi.waitFor(() => expect(document.activeElement).toBe(expired));
      expect(view.getByText('jonas.schulz@example.com').closest('p')).toHaveTextContent(
        /^The invitation for jonas\.schulz@example\.com was valid until .+\. Ask Anna Becker for a new one\.$/,
      );
      expect(view.queryByRole('img', { name: /^Step / })).toBeNull();
      expect(view.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
      await click('Request a new invitation');
      const sent = await view.findByRole('heading', { name: 'Request sent' });
      await vi.waitFor(() => expect(document.activeElement).toBe(sent));
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: 'invites/tok/request' });
      expect(view.getByRole('status')).toHaveTextContent(
        /Anna Becker has been notified\. The new invitation will be sent to jonas\.schulz@example\.com\./,
      );
      await click('Go to sign-in');
      expect(nav.goto).toHaveBeenCalledWith('/login');
    });

    it('locks “Request a new invitation” after 429 with lock and countdown', async () => {
      mockApi({
        'GET invites/tok': [{ body: { ...INFO, expired: true } }],
        'POST invites/tok/request': [{ status: 429, body: { error: 'rate_limited', retry_after: 360 } }],
      });
      const view = renderPage();
      await view.findByRole('heading', { name: 'Invitation expired' });
      await click('Request a new invitation');
      const lock = await view.findByRole('alert');
      expect(lock).toHaveAttribute('id', 'iv-lock');
      expect(lock).toHaveTextContent(/^Too many requests\.\s*Try again in 6 minutes\./);
      // The bar and m:ss are not read (the alert would be announced every second).
      expect(within(lock).getByText('6:00').closest('[aria-hidden="true"]')).not.toBeNull();
      // Greyed out with its normal label: no time on the button.
      const button = view.getByRole('button', { name: 'Request a new invitation' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveClass('off');
      expect(lock.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(view.queryByRole('button', { name: /in 6:00/ })).toBeNull();
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
  });

  describe('no connection', () => {
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
      await type('Confirm password', 'Safe-enough1');
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

    it('focuses the heading of step 4 once “No connection” closes when the codes arrived behind it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let answer: (reply: { status: number; body: unknown }) => void = () => {};
      mockApi({
        ...mfaRoutes(),
        'POST invites/tok/accept': [() => new Promise((resolve) => (answer = resolve))],
        'GET public/config': [{ body: CONFIG }],
      });
      const view = await toStep3();
      await type('Verification code', '123456');
      // The window goes offline while the code is checked; the codes arrive behind the message.
      await fireEvent(window, new Event('offline'));
      const dialog = await view.findByRole('alertdialog', { name: 'No connection' });
      answer({ status: 201, body: { user: USER, recovery_codes: CODES } });
      const heading = await view.findByRole('heading', { name: CODES_TITLE, hidden: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(document.activeElement).not.toBe(heading);
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Try now' }));
      await vi.waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(heading));
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
});
