import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInfo } from '#lib/build-info.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const PROBE = { url: 'https://mail.example.com', host: 'mail.example.com', reach: 'ok', cors: 'ok', oauth: 'ok' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
  session.user = null;
  session.status = 'idle';
  prefs.reset();
  ui.reset();
});

/** Types into a field (via its label). */
async function type(label: string | RegExp, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

async function next(name: string | RegExp = 'Continue') {
  await fireEvent.click(screen.getByRole('button', { name }));
}

/** Steps 1–3 up to "Connect mail server" (response to `setup/token` in the test's mock). */
async function toServer() {
  await type('Setup token', 'abcd-efgh-jklm');
  await next();
  await vi.waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
  await type('Your name', 'Anna Becker');
  await type('Email address', 'anna@example.com');
  await next();
  await type(/^Password$/, 'Safe-enough1');
  await type('Confirm password', 'Safe-enough1');
  await next();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect mail server');
}

describe('Setup page', () => {
  it('shows step 1 with terminal, progress and version', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Roedy Mail');
    expect(view.getByText('Initial setup')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Step 1 of 6' })).toBeInTheDocument();
    expect(view.getByText('docker logs roedy-mail 2>&1 | grep Setup-Token')).toBeInTheDocument();
    expect(view.getByText(`Roedy Mail ${buildInfo.version}`)).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('docker logs roedy-mail 2>&1 | grep Setup-Token');
    expect(view.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows “Copied” only if copying worked', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
    execCommand.mockReturnValue(true);
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('switches the theme only in the browser', async () => {
    const { calls } = mockApi({});
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Light theme' }));
    expect(prefs.values.mode).toBe('light');
    expect(view.getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('focuses the first field unless someone already chose another one', async () => {
    mockApi({ 'POST setup/token': [{ body: { public_url: null } }] });
    vi.useFakeTimers();
    render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    // vi.waitFor advances the fake timers, also past the 40 ms.
    await vi.waitFor(() => expect(screen.getByLabelText('Your name')).toHaveFocus());
    await type('Your name', 'Anna Becker');
    await type('Email address', 'anna@example.com');

    // Step 3 comes immediately without a request; whoever moves to the second
    // field before the 40 ms are up stays there.
    await next();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set password');
    screen.getByLabelText('Confirm password').focus();
    await vi.advanceTimersByTimeAsync(40);
    expect(screen.getByLabelText('Confirm password')).toHaveFocus();
  });

  it('reports an unexpected error as an error toast', async () => {
    mockApi({ 'POST setup/token': [{ status: 500, body: { error: 'internal' } }] });
    render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(ui.toast).not.toBeNull());
    expect(ui.toast).toMatchObject({
      text: 'That didn’t work. Please try again.',
      error: true,
      undo: false,
    });
  });

  it('shows the token in boxes, too short and locked', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST setup/token': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }] });
    const view = render(Page);
    const input = view.getByLabelText('Setup token');
    await fireEvent.input(input, { target: { value: 'ab12' } });
    expect(input).toHaveValue('AB12');
    expect(input).not.toHaveAttribute('aria-describedby');
    // Rejected characters do not stay invisibly in the field.
    await fireEvent.input(input, { target: { value: 'AB12!' } });
    expect(input).toHaveValue('AB12');
    await next();
    expect(view.getByText('The token is 12 characters long.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('The token is 12 characters long.');
    await fireEvent.input(input, { target: { value: 'ab12cd34ef56' } });
    await next();
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Too many attempts.'));
    expect(view.getByRole('alert')).toHaveTextContent('Entry is locked for 30 seconds.');
    expect(input).toHaveAccessibleDescription(/Too many attempts\. Entry is locked for 30 seconds\./);
    expect(input).toBeDisabled();
    expect(view.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.queryByRole('alert')).toBeNull();
    expect(input).toBeEnabled();
  });

  it('shows the app password in step 4 and locks on throttled registration and throttled test', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const throttled = { reach: 'throttled', cors: 'throttled', oauth: 'throttled' };
    mockApi({
      'POST setup/token': [{ body: { public_url: 'https://webmail.example.com' } }],
      'POST setup/servers/register-client': [
        { status: 502, body: { error: 'registration_failed', reason: 'throttled', retry_after: 90 } },
      ],
      'POST setup/servers/test': [
        { body: { ...PROBE, reach: 'unk', cors: 'unk', oauth: 'unk', reasons: throttled, retry_after: 90 } },
      ],
    });
    const view = render(Page);
    await toServer();

    // Preset by ROEDY_PUBLIC_URL: locked field with the lock icon.
    const pub = view.getByLabelText('Public URL of Roedy Mail');
    expect(pub).toHaveAttribute('readonly');
    expect(pub.parentElement).toHaveClass('locked');
    expect(pub.parentElement?.querySelector('.tabler-icon-lock')).not.toBeNull();

    // App password instead of password, with a hint below the field.
    const pw = view.getByLabelText('Administrator’s app password');
    expect(view.getByText('App password', { selector: 'label' })).toBeInTheDocument();
    expect(pw).toHaveAttribute('placeholder', 'App password from Stalwart');
    expect(
      view.getByText(
        'Ideally an app password you create in Stalwart for your administrator account and delete after registration. The regular password only works without a second factor.',
      ),
    ).toBeInTheDocument();

    // Registration throttled: box with clock, button locked, fields stay.
    await type('Stalwart server URL', 'mail.example.com');
    await type('Mail server admin user', 'admin');
    await fireEvent.input(pw, { target: { value: 'app-pw' } });
    await fireEvent.click(view.getByRole('button', { name: 'Register client automatically' }));
    const box = await view.findByRole('alert');
    expect(box).toHaveTextContent(
      'Too many requests. The mail server is throttling requests from Roedy Mail. Try again in 2 minutes.',
    );
    expect(box.querySelector('.tabler-icon-clock')).not.toBeNull();
    const reg = view.getByRole('button', { name: /^Register client automatically in \d:\d\d$/ });
    expect(reg).toBeDisabled();
    expect(reg.querySelector('.tabler-icon-lock')).not.toBeNull();
    expect(pw).toHaveValue('app-pw');

    // Test throttled: box instead of "No connection.", "Test connection" locked until expiry.
    await fireEvent.click(view.getByRole('radio', { name: 'Manual' }));
    await type('Client ID', 'roedy-mail');
    await next('Test connection');
    const test = await view.findByRole('button', { name: /^Test connection in \d:\d\d$/ });
    expect(test).toBeDisabled();
    expect(test.style.opacity).toBe('0.55');
    expect(test.querySelector('.tabler-icon-lock')).not.toBeNull();
    expect(view.getByRole('alert')).toHaveTextContent(
      'Too many requests. The mail server is throttling requests from Roedy Mail. Test again in 2 minutes.',
    );
    expect(view.queryByText('No connection.')).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('names the registration at the client secret and shows it as registered', async () => {
    mockApi({
      'POST setup/token': [{ body: { public_url: 'https://webmail.example.com' } }],
      'POST setup/servers/register-client': [{ body: { client_id: 'roedy-x1' } }],
    });
    const view = render(Page);
    await toServer();
    await type('Stalwart server URL', 'mail.example.com');
    await type('Mail server admin user', 'admin');
    await type('App password', 'app-pw');
    await fireEvent.click(view.getByRole('button', { name: 'Register client automatically' }));
    const done = await view.findByRole('status');
    expect(done).toHaveTextContent('Client registered');
    expect(done).toHaveTextContent('Client ID roedy-x1 · Secret stored in the backend · Admin credentials discarded');
    await fireEvent.click(view.getByRole('radio', { name: 'Manual' }));
    expect(view.getByLabelText('Client ID')).toHaveValue('roedy-x1');
    expect(
      view.getByText(
        'The secret from the automatic registration is stored in the backend and applied when you save. Leave empty to use it.',
      ),
    ).toBeInTheDocument();
    await type('Client ID', 'other-client');
    expect(
      view.getByText(
        'Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only.',
      ),
    ).toBeInTheDocument();
  });

  it('leads through all six steps and then signs in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockApi({
      'POST setup/token': [{ body: { public_url: null } }],
      'POST setup/servers/test': [{ body: { ...PROBE, cors: 'err' } }, { body: PROBE }],
      'POST setup/system-mail/test': [
        { status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } },
        { status: 429, body: { error: 'mail_failed', reason: 'auth_locked', retry_after: 900 } },
      ],
      'POST setup/complete': [{ status: 201, body: { user: {} } }],
      'GET public/config': [
        {
          body: {
            name: 'Roedy Mail',
            branding: BRAND0,
            org: {},
            maintenance: { on: false, message: null },
            version: '0.2.0',
            update: null,
            setup_required: false,
          },
        },
      ],
      'GET auth/me': [{ body: { id: '1', email: 'anna@example.com', display_name: 'Anna Becker', role: 'admin' } }],
      'GET settings': [{ body: { version: 1, settings: {} } }],
    });
    const view = render(Page);

    // 1: Token
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    expect(view.getByRole('img', { name: 'Step 2 of 6' })).toBeInTheDocument();

    // 2: administrator
    await next();
    expect(view.getByText('Please enter your name.')).toBeInTheDocument();
    await type('Your name', 'Anna Becker');
    await type('Email address', 'anna@example.com');
    await next();

    // 3: password with rules as chips
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set password');
    expect(view.getByText('anna@example.com')).toBeInTheDocument();
    const rules = view.getByRole('list', { name: 'Password requirements' });
    await type(/^Password$/, 'kurz');
    await next();
    expect(
      within(rules)
        .getAllByRole('listitem')
        .filter((li) => li.classList.contains('bad')),
    ).toHaveLength(3);
    await type(/^Password$/, 'Safe-enough1');
    expect(
      within(rules)
        .getAllByRole('listitem')
        .filter((li) => li.classList.contains('ok')),
    ).toHaveLength(3);
    await fireEvent.click(view.getByRole('button', { name: 'Show password' }));
    expect(view.getByLabelText(/^Password$/)).toHaveAttribute('type', 'text');
    await type('Confirm password', 'Safe-enough1');
    await next();

    // 4: mail server, manual client, test with warning, then OK
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Connect mail server');
    expect(view.getByLabelText('Public URL of Roedy Mail')).toHaveValue(location.origin);
    expect(view.getByLabelText('Public URL of Roedy Mail').parentElement).not.toHaveClass('locked');
    await type('Public URL of Roedy Mail', 'https://webmail.example.com');
    expect(view.getByText('https://webmail.example.com/oauth/callback')).toBeInTheDocument();
    await type('Stalwart server URL', 'mail.example.com');
    await fireEvent.click(view.getByRole('radio', { name: 'Manual' }));
    await type('Client ID', 'roedy-mail');
    await next('Test connection');
    await vi.waitFor(() => expect(view.getByText(/“Permissive CORS”/)).toBeInTheDocument());
    // With warnings: "Test again" and "Continue anyway".
    expect(view.getByText('Connected, with warnings')).toBeInTheDocument();
    expect(view.getByText('mail.example.com · Stalwart')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Continue anyway' })).toBeInTheDocument();
    await next('Test again');
    await vi.waitFor(() => expect(view.getByText('Connected')).toBeInTheDocument());
    expect(view.queryByRole('button', { name: 'Continue anyway' })).toBeNull();
    expect(view.queryByText(/“Permissive CORS”/)).toBeNull();
    expect(view.getByLabelText('Domains')).toHaveValue('example.com');
    await next();

    // 5: system emails, wrong app password, locked, then later
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('System emails');
    expect(view.getByLabelText('Sender account')).toHaveValue('noreply@example.com');
    expect(view.getByRole('radiogroup', { name: 'Mail server' })).toHaveTextContent('mail.example.com');
    await type('App password', 'wrong');
    await next('Check and continue');
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Sign-in failed.'));
    await type('App password', 'also-wrong');
    await next('Check and continue');
    const locked = await view.findByRole('button', { name: 'Check and continue in 15:00' });
    expect(locked).toBeDisabled();
    expect(locked.style.opacity).toBe('0.55');
    expect(locked.querySelector('.tabler-icon-lock')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Set up later' }));

    // 6: overview and completion
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
    expect(view.getByText('Anna Becker · anna@example.com')).toBeInTheDocument();
    expect(view.getByText('Not set up')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Change Administrator' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator');
    // On through 2, 3 and 4 (server already tested), skip step 5 again.
    await next();
    await next();
    await next();
    await fireEvent.click(view.getByRole('button', { name: 'Set up later' }));
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    expect(view.getByText('Roedy Mail is set up. Signing you in …')).toBeInTheDocument();
    const complete = calls.find((c) => c.path === 'setup/complete');
    expect(complete?.headers['X-Setup-Token']).toBe('ABCD-EFGH-JKLM');
    expect(complete?.body).toMatchObject({ server: { client_id: 'roedy-mail', url: 'https://mail.example.com' } });

    await vi.advanceTimersByTimeAsync(2700);
    await vi.waitFor(() => expect(session.authed).toBe(true));
    expect(calls.map((c) => c.path)).toContain('settings');
  });
});
