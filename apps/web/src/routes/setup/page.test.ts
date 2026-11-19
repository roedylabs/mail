import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

afterEach(() => {
  nav.goto.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
  session.user = null;
  session.status = 'idle';
  prefs.reset();
  ui.reset();
  sessionStorage.clear();
});

/** Types into a field (via its label). */
async function type(label: string | RegExp, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

async function next(name: string | RegExp = 'Continue') {
  await fireEvent.click(screen.getByRole('button', { name }));
}

/** Opens the wizard at the administrator step (via the token step). */
async function atAdmin() {
  mockApi({ 'POST setup/token': [{ body: {} }] });
  atToken();
  const view = render(Page);
  // After the focus of entering step 2 (40 ms), as a person would.
  await vi.waitFor(() => expect(view.getByLabelText('Setup token')).toHaveFocus());
  await type('Setup token', 'abcd-efgh-jklm');
  await next();
  await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
  return view;
}

/** Opens the wizard at the password step (via the token and administrator steps). */
async function atPassword() {
  const view = await atAdmin();
  await type('Your name', 'Anna Becker');
  await type('Email address', 'anna@example.com');
  await next();
  await vi.waitFor(() => expect(view.getByLabelText(/^Password$/)).toHaveFocus());
  return view;
}

/** Opens the wizard at the review step (via the token, administrator and password steps). */
async function atReview() {
  const view = await atPassword();
  await type(/^Password$/, 'Safe-enough1');
  await type('Confirm password', 'Safe-enough1');
  await next();
  await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveFocus());
  expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
  return view;
}

/** Opens the wizard at the token step (a reload there after step 1). */
function atToken() {
  sessionStorage.setItem('roedy-setup-step', '2');
}

describe('Setup page', () => {
  it('shows the token step with brand, terminal, progress and document title', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    atToken();
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Roedy Mail');
    expect(view.getByText('Roedy Mail')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Step 2 of 5' })).toBeInTheDocument();
    expect(ui.setupTitle).toBe('Setup token · Setup');
    expect(view.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    // One line of text with its spaces (a selection copies the command as it is).
    expect(view.container.querySelector('.cmd-parts')?.textContent).toBe(
      'docker logs roedy-mail 2>&1 | grep Setup-Token',
    );
    expect(view.getByText('Setup-Token:')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Copy: docker logs roedy-mail 2>&1 | grep Setup-Token' }));
    expect(writeText).toHaveBeenCalledWith('docker logs roedy-mail 2>&1 | grep Setup-Token');
    expect(view.getByRole('button', { name: /^Copied:/ })).toBeInTheDocument();
  });

  it('keeps the log lines in English in German', () => {
    sessionStorage.setItem('roedy-setup-lang', 'de');
    atToken();
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Roedy Mail einrichten');
    expect(ui.setupTitle).toBe('Setup-Token · Einrichtung');
    expect(view.getByText('[setup] Not set up yet')).toBeInTheDocument();
    expect(view.getByRole('button', { name: /^Kopieren:/ })).toBeInTheDocument();
  });

  it('shows “Copied” only if copying worked, otherwise “Couldn’t copy.”', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    atToken();
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: /^Copy:/ }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    await vi.waitFor(() => expect(ui.toast).toMatchObject({ text: 'Couldn’t copy.', error: true }));
    expect(view.queryByRole('button', { name: /^Copied:/ })).toBeNull();
    execCommand.mockReturnValue(true);
    await fireEvent.click(view.getByRole('button', { name: /^Copy:/ }));
    await vi.waitFor(() => expect(view.getByRole('button', { name: /^Copied:/ })).toBeInTheDocument());
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('applies the stored language and appearance only in the browser', () => {
    sessionStorage.setItem('roedy-setup-dark', '1');
    sessionStorage.setItem('roedy-setup-accent', 'sage');
    const { calls } = mockApi({});
    render(Page);
    expect(prefs.values.mode).toBe('dark');
    expect(prefs.values.accent).toBe('sage');
    expect(prefs.values.lang).toBe('system');
    expect(calls).toHaveLength(0);
  });

  it('goes back keeping the values; Enter on the heading continues', async () => {
    mockApi({ 'POST setup/token': [{ body: {} }] });
    atToken();
    const view = render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    await type('Your name', 'Anna Becker');
    await type('Email address', 'anna@example.com');
    await fireEvent.keyDown(view.getByRole('heading', { level: 1 }), { key: 'Enter' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set password');
    expect(ui.setupTitle).toBe('Password · Setup');
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator');
    expect(view.getByLabelText('Your name')).toHaveValue('Anna Becker');
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByLabelText('Setup token')).toHaveValue('ABCD-EFGH-JKLM');
    expect(sessionStorage.getItem('roedy-setup-name')).toBe('Anna Becker');
  });

  it('shows "No connection" without an answer and closes on the first answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({
      'POST setup/token': [],
      'GET public/config': [{ body: { setup_required: true } }],
    });
    atToken();
    const view = render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    const field = view.getByLabelText('Setup token');
    field.focus();
    await next();
    const dialog = await view.findByRole('alertdialog', { name: 'No connection' });
    expect(dialog).toHaveAccessibleDescription('Check your internet connection. Your details are kept.');
    expect(view.getByText('Trying again in 5 seconds')).toBeInTheDocument();
    const retry = within(dialog).getByRole('button', { name: 'Try now' });
    await vi.waitFor(() => expect(retry).toHaveFocus());
    // The step behind it is hidden from screen readers; Tab stays on the button.
    expect(view.container.querySelector('[aria-hidden="true"] form')).not.toBeNull();
    await fireEvent.keyDown(retry, { key: 'Tab' });
    expect(retry).toHaveFocus();
    // The window is online again: an attempt at once, the answer closes the message.
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    expect(field).toHaveValue('ABCD-EFGH-JKLM');
    expect(field).toHaveFocus();
    expect(view.container.querySelector('[aria-hidden="true"] form')).toBeNull();
  });

  it('retries after the setup status hung at start, then enters the step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    session.status = 'error';
    session.failure = 'offline';
    const config = {
      name: 'Roedy Mail',
      branding: BRAND0,
      org: {},
      maintenance: { on: false, message: null },
      version: '0.2.0',
      update: null,
      setup_required: true,
    };
    let call = 0;
    const fetch = vi.fn((_input: string, init: RequestInit = {}) => {
      call += 1;
      // The first attempt hangs until its deadline, the second gets the status.
      if (call === 1)
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('No answer', 'TimeoutError')));
        });
      return Promise.resolve(new Response(JSON.stringify(config), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    atToken();
    const view = render(Page);
    expect(await view.findByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    // First attempt after 5 s; it hangs and ends after 10 s without an answer.
    await vi.advanceTimersByTimeAsync(5_000 + 10_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.getByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    expect(view.getByText('Trying again in 10 seconds')).toBeInTheDocument();
    // The next attempt starts a new load and gets the answer.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.status).toBe('ready');
    await vi.waitFor(() => expect(view.getByLabelText('Setup token')).toHaveFocus());
  });

  it('does not count a start from the local copy as an answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    session.status = 'error';
    session.failure = 'offline';
    const load = vi.spyOn(session, 'load').mockImplementation(() => {
      session.status = 'ready';
      session.fromCopy = true;
      return Promise.resolve();
    });
    const view = render(Page);
    expect(await view.findByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(5_000 + 1_200);
    expect(load).toHaveBeenCalledOnce();
    expect(view.getByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    load.mockRestore();
    session.fromCopy = false;
  });

  it('shows "No connection" on the offline event', async () => {
    mockApi({});
    const view = render(Page);
    window.dispatchEvent(new Event('offline'));
    expect(await view.findByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    expect(ui.toast).toBeNull();
  });

  it('focuses the first field unless someone already chose another one', async () => {
    mockApi({ 'POST setup/token': [{ body: {} }] });
    vi.useFakeTimers();
    atToken();
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

  it('shows a server error under the boxes, not as a toast', async () => {
    mockApi({ 'POST setup/token': [{ status: 500, body: { error: 'internal' } }] });
    atToken();
    const view = render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Something went wrong.'));
    expect(view.getByRole('alert')).toHaveTextContent(
      'The token couldn’t be checked. Details are in the container log.',
    );
    expect(view.getByLabelText('Setup token')).toHaveValue('ABCD-EFGH-JKLM');
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false');
    expect(ui.toast).toBeNull();
  });

  it('reports a wrong token with the attempts left', async () => {
    mockApi({
      'POST setup/token': [
        { status: 422, body: { error: 'invalid_token', remaining: 4 } },
        { status: 422, body: { error: 'invalid_token', remaining: 1 } },
      ],
    });
    atToken();
    const view = render(Page);
    const input = view.getByLabelText('Setup token');
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Invalid token.'));
    expect(view.getByRole('alert')).toHaveTextContent('Check the token in the container log.');
    expect(view.getByRole('alert')).toHaveTextContent('4 attempts left');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Invalid token\./);
    await next();
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('1 attempt left'));
    await type('Setup token', 'abcd-efgh-jkl');
    expect(view.queryByRole('alert')).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('keeps the accepted token when coming back; editing makes it unaccepted', async () => {
    const { calls } = mockApi({ 'POST setup/token': [{ body: {} }] });
    atToken();
    const view = render(Page);
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('status')).toHaveTextContent('Token accepted.');
    expect(view.getByRole('status')).toHaveTextContent('Next, you’ll create the administrator account.');
    expect(view.getByLabelText('Setup token')).toHaveAccessibleDescription(/Token accepted\./);
    await next();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator');
    expect(calls).toHaveLength(1);
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    await type('Setup token', 'abcd-efgh-jkl');
    expect(view.queryByRole('status')).toBeNull();
  });

  it('shows the token in boxes, greys out Continue until complete, and locks', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({
      'POST setup/token': [{ status: 429, body: { error: 'rate_limited', retry_after: 12 } }],
    });
    atToken();
    const view = render(Page);
    const input = view.getByLabelText('Setup token');
    const cont = view.getByRole('button', { name: 'Continue' });
    await fireEvent.input(input, { target: { value: 'ab23' } });
    expect(input).toHaveValue('AB23');
    expect(input).not.toHaveAttribute('aria-describedby');
    // Rejected characters do not stay invisibly in the field.
    await fireEvent.input(input, { target: { value: 'AB23!' } });
    expect(input).toHaveValue('AB23');
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    // Incomplete: no message, nothing sent; Enter on the heading moves the focus into the field.
    await fireEvent.keyDown(view.getByRole('heading', { level: 1 }), { key: 'Enter' });
    expect(input).toHaveFocus();
    await next();
    expect(view.queryByRole('alert')).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(calls).toHaveLength(0);
    await fireEvent.input(input, { target: { value: 'Setup-Token: ab23-cd45-ef67' } });
    expect(input).toHaveValue('AB23-CD45-EF67');
    expect(cont).toHaveAttribute('aria-disabled', 'false');
    await next();
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Too many attempts.'));
    expect(view.getByRole('alert')).toHaveTextContent('Entry is locked for a moment. Then you can try again.');
    // The countdown bar is relative to the 30 s lock.
    expect(view.getByRole('alert')).toHaveTextContent('0:12');
    expect(view.getByRole('alert').querySelector('.lock-bar span')).toHaveStyle({ width: '40%' });
    expect(input).toHaveAccessibleDescription(/Too many attempts\./);
    expect(input).toBeDisabled();
    expect(input).toHaveValue('');
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(view.getByRole('alert')).toHaveTextContent('0:10');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.queryByRole('alert')).toBeNull();
    expect(input).toBeEnabled();
  });

  it('leads through the steps and then signs in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockApi({
      'POST setup/token': [{ body: {} }],
      'POST setup/complete': [{ status: 201, body: { user: {} } }],
      // The check that the server answers, then the session.
      'GET public/config': Array.from({ length: 2 }, () => ({
        body: {
          name: 'Roedy Mail',
          branding: BRAND0,
          org: {},
          maintenance: { on: false, message: null },
          version: '0.2.0',
          update: null,
          setup_required: false,
        },
      })),
      'GET auth/me': [{ body: { id: '1', email: 'anna@example.com', display_name: 'Anna Becker', role: 'admin' } }],
      'GET settings': [{ body: { version: 1, settings: {} } }],
    });
    const view = render(Page);

    // 1: language and appearance
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome');
    await fireEvent.click(view.getByRole('radio', { name: 'Dark' }));
    await fireEvent.click(view.getByRole('radio', { name: 'Sage' }));
    await next('Get started');

    // 2: Token
    await type('Setup token', 'abcd-efgh-jklm');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    expect(view.getByRole('img', { name: 'Step 3 of 5' })).toBeInTheDocument();

    // 3: administrator (incomplete: Continue greyed out, a click only moves to the empty field)
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await next();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByLabelText('Your name')).toHaveFocus();
    await type('Your name', 'Anna Becker');
    await type('Email address', 'anna@example.com');
    await next();

    // 4: password with the check card (Continue greyed out until all four chips are met)
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set password');
    expect(view.getByText('anna@example.com')).toBeInTheDocument();
    const rules = view.getByRole('list', { name: 'Password requirements' });
    await type(/^Password$/, 'kurz');
    await next();
    expect(view.queryByRole('alert')).toBeNull();
    expect(within(rules).getAllByText(': not met yet')).toHaveLength(4);
    await type(/^Password$/, 'Safe-enough1');
    expect(within(rules).getAllByText(': met')).toHaveLength(3);
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await type('Confirm password', 'Safe-enough1');
    expect(within(rules).getAllByText(': met')).toHaveLength(4);
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false');
    await next();

    // 5: summary and completion
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
    expect(view.getByRole('img', { name: 'Step 5 of 5' })).toBeInTheDocument();
    expect(ui.setupTitle).toBe('Review · Setup');
    const summary = view.getByRole('list', { name: 'Your details' });
    const rows = within(summary).getAllByRole('listitem');
    // (The page renders at mobile width here: "Change" is a pencil with its label.)
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Language and appearance System · Dark · Sage',
      'AB Administrator Anna Becker anna@example.com',
      'Password •••••••••• Set',
    ]);
    expect(summary).not.toHaveTextContent('Safe-enough1');
    expect(view.getByText('Next, connect the mail server.')).toBeInTheDocument();
    // No field in the summary: the focus moves to its heading.
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveFocus());
    // Focus order: Change × 3, Back, Finish setup.
    const order = [...view.container.querySelectorAll<HTMLElement>('button:not([tabindex="-1"])')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent?.trim(),
    );
    expect(order).toEqual([
      'Change Language and appearance',
      'Change Administrator',
      'Change Password',
      'Back',
      'Finish setup',
    ]);
    // "Change" walks forward again through the following steps; the accepted token needs no new check.
    await fireEvent.click(view.getByRole('button', { name: 'Change Language and appearance' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome');
    await next('Get started');
    expect(view.getByLabelText('Setup token')).toHaveValue('ABCD-EFGH-JKLM');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    expect(calls.filter((c) => c.path === 'setup/token')).toHaveLength(1);
    await next();
    // On through 4 again: both passwords are still there.
    expect(view.getByLabelText('Confirm password')).toHaveValue('Safe-enough1');
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?'));
    // Enter on the heading finishes.
    await fireEvent.keyDown(view.getByRole('heading', { level: 1 }), { key: 'Enter' });
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    expect(view.getByText('Roedy Mail is set up.')).toBeInTheDocument();
    expect(view.getByText('Signing you in …')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Setup complete' })).toBeInTheDocument();
    const chips = view.getByRole('list', { name: 'Done' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toEqual(['Administrator created', 'Setup token revoked']);
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveFocus());
    const complete = calls.find((c) => c.path === 'setup/complete');
    expect(complete?.headers['X-Setup-Token']).toBe('ABCD-EFGH-JKLM');
    expect(complete?.body).toEqual({
      name: 'Anna Becker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      settings: { lang: 'system', mode: 'dark', accent: 'sage' },
    });
    expect(ui.setupTitle).toBe('Done · Setup');
    // The done screen has read the first name: the session keys go.
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('roedy-setup-'))).toEqual([]);

    // The look chosen on step 1 stays applied without the session keys.
    expect([prefs.values.mode, prefs.values.accent]).toEqual(['dark', 'sage']);
    expect(nav.goto).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2700);
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers', { replace: true }));
    expect(session.authed).toBe(true);
    // The layout keeps the setup until Administration › Mail servers is there.
    expect(ui.setupLeaving).toBe(true);
    expect(calls.map((c) => c.path)).toContain('settings');
  });
});

describe('Step 5: review', () => {
  it('locks Back and "Change" while setting up and shows a server error in place of the note', async () => {
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    const view = await atReview();
    const { calls } = mockApi({
      'POST setup/complete': [{ status: 500, body: {} }, () => new Promise((resolve) => (answer = resolve))],
    });
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Something went wrong.'));
    expect(view.getByRole('alert')).toHaveTextContent('Setup couldn’t be finished. Details are in the container log.');
    // The note stays in its slot, invisible (the card keeps its size).
    expect(view.container.querySelector('.note')).toHaveAttribute('aria-hidden', 'true');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');

    // The next Finish removes the message; while it runs Back and "Change" are locked.
    await next('Finish setup');
    expect(view.queryByRole('alert')).toBeNull();
    const busy = view.getByRole('button', { name: 'Setting up …' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    const back = view.getByRole('button', { name: 'Back' });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(back);
    await fireEvent.click(view.getByRole('button', { name: 'Change Administrator' }));
    expect(view.getByRole('button', { name: 'Change Administrator' })).toHaveAttribute('aria-disabled', 'true');
    expect(view.getByRole('list', { name: 'Your details' })).toHaveClass('busy');
    await fireEvent.click(busy);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
    expect(calls.filter((c) => c.path === 'setup/complete')).toHaveLength(2);
    answer({ status: 201, body: {} });
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
  });

  it('reloads to the sign-in when the setup was finished meanwhile', async () => {
    const view = await atReview();
    mockApi({
      'POST setup/complete': [{ status: 409, body: { error: 'setup_done' } }],
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
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    await next('Finish setup');
    await vi.waitFor(() => expect(session.status).toBe('ready'));
    expect(session.setupRequired).toBe(false);
    expect(session.authed).toBe(false);
    expect(ui.setupLeaving).toBe(false);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('signs in once the server answers again after the done screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await atReview();
    const config = {
      body: {
        name: 'Roedy Mail',
        branding: BRAND0,
        org: {},
        maintenance: { on: false, message: null },
        version: '0.2.0',
        update: null,
        setup_required: false,
      },
    };
    const configs: { body: unknown }[] = [];
    mockApi({
      'POST setup/complete': [{ status: 201, body: {} }],
      'GET public/config': configs,
      'GET auth/me': Array.from({ length: 3 }, () => ({
        body: { id: '1', email: 'anna@example.com', display_name: 'Anna Becker', role: 'admin' },
      })),
      'GET settings': Array.from({ length: 2 }, () => ({ body: { version: 1, settings: {} } })),
    });
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    // No answer to the sign-in: "No connection" over the done screen, no navigation.
    await vi.advanceTimersByTimeAsync(2700);
    await view.findByRole('alertdialog', { name: 'No connection' });
    expect(nav.goto).not.toHaveBeenCalled();
    expect(view.container.querySelector('h1')).toHaveTextContent('Welcome, Anna');
    // The server answers again: the sign-in goes on.
    configs.push(...Array.from({ length: 4 }, () => config));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers', { replace: true }));
    expect(session.authed).toBe(true);
  });

  it('tries Administration › Mail servers again when the page did not load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nav.goto.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
    const view = await atReview();
    const config = {
      body: {
        name: 'Roedy Mail',
        branding: BRAND0,
        org: {},
        maintenance: { on: false, message: null },
        version: '0.2.0',
        update: null,
        setup_required: false,
      },
    };
    const me = { body: { id: '1', email: 'anna@example.com', display_name: 'Anna Becker', role: 'admin' } };
    mockApi({
      'POST setup/complete': [{ status: 201, body: {} }],
      'GET public/config': Array.from({ length: 6 }, () => config),
      'GET auth/me': Array.from({ length: 4 }, () => me),
      'GET settings': Array.from({ length: 3 }, () => ({ body: { version: 1, settings: {} } })),
    });
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    await vi.advanceTimersByTimeAsync(2700);
    // The done screen stays (no redirect to the start page), "No connection" offers the next attempt.
    await view.findByRole('alertdialog', { name: 'No connection' });
    expect(ui.setupLeaving).toBe(true);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledTimes(2));
    expect(nav.goto).toHaveBeenLastCalledWith('/admin/mail-servers', { replace: true });
  });

  it('does not navigate once the page has gone during the sign-in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await atReview();
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({
      'POST setup/complete': [{ status: 201, body: {} }],
      'GET public/config': [() => new Promise((resolve) => (answer = resolve))],
      'GET auth/me': [{ body: { id: '1', email: 'anna@example.com', display_name: 'Anna Becker', role: 'admin' } }],
      'GET settings': [{ body: { version: 1, settings: {} } }],
    });
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    await vi.advanceTimersByTimeAsync(2700);
    view.unmount();
    expect(ui.setupLeaving).toBe(false);
    // The server answers with the signed-in session after all: the old page no longer navigates.
    answer({
      status: 200,
      body: {
        name: 'Roedy Mail',
        branding: BRAND0,
        org: {},
        maintenance: { on: false, message: null },
        version: '0.2.0',
        update: null,
        setup_required: false,
      },
    });
    await vi.waitFor(() => expect(session.authed).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('shows "No connection" when Finish gets no answer', async () => {
    const view = await atReview();
    mockApi({});
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('alertdialog')).toHaveTextContent('No connection'));
    // The step stays behind it as it was, nothing in place of the note.
    expect(view.container.querySelector('h1')).toHaveTextContent('All set?');
    expect(view.container.querySelector('.err.live')).toBeNull();
  });

  it('speaks German, with the pencil for "Change" on narrow screens', async () => {
    sessionStorage.setItem('roedy-setup-lang', 'de');
    sessionStorage.setItem('roedy-setup-accent', 'custom');
    sessionStorage.setItem('roedy-setup-accentHex', '#4a7bd0');
    mockApi({ 'POST setup/token': [{ body: {} }] });
    atToken();
    const view = render(Page);
    await vi.waitFor(() => expect(view.getByLabelText('Setup-Token')).toHaveFocus());
    await type('Setup-Token', 'abcd-efgh-jklm');
    await next('Weiter');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Administrator anlegen'));
    await type('Ihr Name', 'Anna Becker');
    await type('E-Mail-Adresse', 'anna@example.com');
    await next('Weiter');
    await type(/^Passwort$/, 'Safe-enough1');
    await type('Passwort wiederholen', 'Safe-enough1');
    await next('Weiter');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Alles bereit?'));
    expect(ui.setupTitle).toBe('Überprüfen · Einrichtung');
    expect(view.getByRole('list', { name: 'Ihre Angaben' })).toHaveTextContent('Deutsch · System · Eigene #4A7BD0');
    const change = view.getByRole('button', { name: 'Sprache und Design ändern' });
    expect(change).toHaveAttribute('title', 'Sprache und Design ändern');
    expect(change).not.toHaveTextContent('Ändern');
    expect(view.getByText('Festgelegt')).toBeInTheDocument();
  });
});

describe('Step 1: language and appearance', () => {
  /** The radio group `name` and its options. */
  function group(name: string) {
    const el = screen.getByRole('radiogroup', { name });
    return { el, option: (option: string) => within(el).getByRole('radio', { name: option }) };
  }

  it('shows the choices with the defaults and focuses the selected language', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome');
    expect(
      view.getByText(
        'Roedy Mail is set up in a few steps. First, choose your language and appearance. This becomes your default, and you can change it later in Settings.',
      ),
    ).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Step 1 of 5' })).toBeInTheDocument();
    expect(ui.setupTitle).toBe('Language and appearance · Setup');
    expect(view.queryByRole('button', { name: 'Back' })).toBeNull();

    const lang = group('Language');
    expect(
      within(lang.el)
        .getAllByRole('radio')
        .map((r) => r.textContent?.trim()),
    ).toEqual([
      expect.stringContaining('System'),
      expect.stringContaining('Deutsch'),
      expect.stringContaining('English'),
    ]);
    expect(lang.option('System')).toHaveAttribute('aria-checked', 'true');
    expect(group('Theme').option('System')).toHaveAttribute('aria-checked', 'true');
    const accent = group('Accent color');
    expect(within(accent.el).getAllByRole('radio')).toHaveLength(6);
    expect(accent.option('Apricot')).toHaveAttribute('aria-checked', 'true');
    expect(accent.option('More')).toHaveAttribute('aria-checked', 'false');
    await vi.waitFor(() => expect(lang.option('System')).toHaveFocus());
  });

  it('applies every choice at once and keeps it in the session, sending nothing', async () => {
    const { calls } = mockApi({});
    const view = render(Page);
    await fireEvent.click(group('Language').option('Deutsch'));
    expect(prefs.values.lang).toBe('de');
    expect(sessionStorage.getItem('roedy-setup-lang')).toBe('de');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Willkommen');
    expect(ui.setupTitle).toBe('Sprache und Design · Einrichtung');

    await fireEvent.click(group('Design').option('Hell'));
    expect(prefs.values.mode).toBe('light');
    expect(sessionStorage.getItem('roedy-setup-dark')).toBe('0');

    // Arrow keys pick within a group.
    const accent = group('Akzentfarbe');
    await fireEvent.keyDown(accent.option('Aprikose'), { key: 'ArrowRight' });
    expect(accent.option('Salbei')).toHaveAttribute('aria-checked', 'true');
    expect(accent.option('Salbei')).toHaveFocus();
    expect(prefs.values.accent).toBe('sage');
    expect(sessionStorage.getItem('roedy-setup-accent')).toBe('sage');
    expect(calls).toHaveLength(0);
  });

  it('starts with Enter on a card and keeps the choices on the way back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(Page);
    await vi.waitFor(() => expect(group('Language').option('System')).toHaveFocus());
    const dark = group('Theme').option('Dark');
    await fireEvent.click(dark);
    await fireEvent.keyDown(dark, { key: 'Enter' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Roedy Mail');
    await vi.waitFor(() => expect(view.getByLabelText('Setup token')).toHaveFocus());
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome');
    expect(group('Theme').option('Dark')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the choices after a reload on step 1', () => {
    sessionStorage.setItem('roedy-setup-step', '1');
    sessionStorage.setItem('roedy-setup-lang', 'en');
    sessionStorage.setItem('roedy-setup-accent', 'custom');
    sessionStorage.setItem('roedy-setup-accentHex', '#4a7bd0');
    render(Page);
    expect(group('Language').option('English')).toHaveAttribute('aria-checked', 'true');
    expect(group('Accent color').option('Custom #4A7BD0')).toHaveAttribute('aria-checked', 'true');
    expect(prefs.values.accent).toBe('#4a7bd0');
  });

  it('picks a custom colour in the editor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(Page);
    await vi.waitFor(() => expect(group('Language').option('System')).toHaveFocus());
    const accent = group('Accent color');
    // The arrows only move the focus onto "Custom"; it opens on activation.
    await fireEvent.keyDown(accent.option('Rose'), { key: 'ArrowRight' });
    expect(accent.option('More')).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();

    await fireEvent.click(accent.option('More'));
    const dialog = screen.getByRole('dialog', { name: 'More colors' });
    await vi.waitFor(() => expect(dialog).toHaveFocus());
    // Escape closes without a change.
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(accent.option('Apricot')).toHaveAttribute('aria-checked', 'true');

    await fireEvent.click(accent.option('More'));
    const again = screen.getByRole('dialog', { name: 'More colors' });
    await fireEvent.click(within(again).getByRole('radio', { name: 'Mint' }));
    await fireEvent.click(within(again).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(accent.option('Mint')).toHaveAttribute('aria-checked', 'true');
    expect(accent.option('Apricot')).toHaveAttribute('aria-checked', 'false');
    await vi.waitFor(() => expect(accent.option('Mint')).toHaveFocus());
    expect(prefs.values.accent).toBe('#78c895');
    expect(sessionStorage.getItem('roedy-setup-accent')).toBe('custom');
    expect(sessionStorage.getItem('roedy-setup-accentHex')).toBe('#78c895');

    // A named accent again: the swatch keeps the custom colour.
    await fireEvent.click(accent.option('Sky'));
    expect(accent.option('Mint')).toHaveAttribute('aria-checked', 'false');
    expect(prefs.values.accent).toBe('sky');
  });

  it('hides an open colour editor behind "No connection"', async () => {
    mockApi({});
    render(Page);
    await fireEvent.click(group('Accent color').option('More'));
    const editor = screen.getByRole('dialog', { name: 'More colors' });
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByRole('alertdialog', { name: 'No connection' })).toBeInTheDocument();
    const layer = editor.closest<HTMLElement>('[aria-hidden="true"]');
    expect(layer).not.toBeNull();
    expect(layer?.inert).toBe(true);
  });
});

describe('Step 3: administrator', () => {
  it('shows a live preview of the account with the initials', async () => {
    const view = await atAdmin();
    expect(ui.setupTitle).toBe('Administrator · Setup');
    await vi.waitFor(() => expect(view.getByLabelText('Your name')).toHaveFocus());
    const preview = view.container.querySelector<HTMLElement>('.acct');
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    // Empty: a person icon and placeholders.
    expect(preview?.querySelector('.avatar-icon')).not.toBeNull();
    expect(preview?.querySelector('.who-name')).toHaveTextContent('Your name');
    expect(preview?.querySelector('.who-email')).toHaveTextContent('name@example.com');
    expect(preview).toHaveTextContent('Administrator');
    expect(preview).toHaveTextContent('Manage users');
    expect(preview).toHaveTextContent('Change settings');
    await type('Your name', 'anna maria becker');
    await type('Email address', 'anna@example.com');
    expect(preview?.querySelector('.avatar')).toHaveTextContent('AB');
    expect(preview?.querySelector('.who-name')).toHaveTextContent('anna maria becker');
    expect(preview?.querySelector('.who-email')).toHaveTextContent('anna@example.com');
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows the invalid name at once and shakes on Enter', async () => {
    const view = await atAdmin();
    await type('Email address', 'anna@example.com');
    await type('Your name', 'Anna Becker (Admin 1)');
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Invalid name.');
    expect(alert).toHaveTextContent('Use letters, spaces, hyphens and apostrophes only.');
    const name = view.getByLabelText('Your name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', 'su-name-err');
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    view.getByLabelText('Email address').focus();
    await fireEvent.keyDown(view.getByLabelText('Email address'), { key: 'Enter' });
    await vi.waitFor(() => expect(name).toHaveFocus());
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator');
    await type('Your name', 'Anna Becker');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('counts from 80 characters and stops at 100', async () => {
    const view = await atAdmin();
    const count = view.container.querySelector('#su-name-count');
    await type('Your name', 'a'.repeat(79));
    expect(count).not.toHaveClass('on');
    await type('Your name', 'a'.repeat(85));
    expect(count).toHaveClass('on');
    expect(count).toHaveTextContent('85 / 100');
    expect(count).not.toHaveClass('full');
    await type('Your name', 'a'.repeat(140));
    expect(view.getByLabelText('Your name')).toHaveValue('a'.repeat(100));
    expect(count).toHaveTextContent('100 / 100');
    expect(count).toHaveClass('full');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the message for an invalid name kept from before (reload)', async () => {
    sessionStorage.setItem('roedy-setup-name', 'Anna 1');
    sessionStorage.setItem('roedy-setup-email', 'anna@example.com');
    const view = await atAdmin();
    expect(view.getByLabelText('Your name')).toHaveValue('Anna 1');
    expect(view.getByRole('alert')).toHaveTextContent('Invalid name.');
    expect(view.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    // Back and forth keeps it too.
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    await next();
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator'));
    expect(view.getByRole('alert')).toHaveTextContent('Invalid name.');
  });

  it('moves Enter to an invalid address without a message', async () => {
    const view = await atAdmin();
    await type('Your name', 'Anna Becker');
    await type('Email address', 'anna@example');
    await fireEvent.keyDown(view.getByLabelText('Your name'), { key: 'Enter' });
    await vi.waitFor(() => expect(view.getByLabelText('Email address')).toHaveFocus());
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'false');
  });

  it('speaks German', async () => {
    sessionStorage.setItem('roedy-setup-lang', 'de');
    mockApi({ 'POST setup/token': [{ body: {} }] });
    atToken();
    const view = render(Page);
    await vi.waitFor(() => expect(view.getByLabelText('Setup-Token')).toHaveFocus());
    await type('Setup-Token', 'abcd-efgh-jklm');
    await next('Weiter');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Administrator anlegen'));
    expect(ui.setupTitle).toBe('Administrator · Einrichtung');
    expect(view.getByLabelText('E-Mail-Adresse')).toHaveAttribute('placeholder', 'name@beispiel.example');
    await type('Ihr Name', 'Anna 1');
    expect(view.getByRole('alert')).toHaveTextContent('Name ungültig.');
  });
});

describe('Step 4: password', () => {
  it('shows the check card with strength and four chips, live while typing', async () => {
    const view = await atPassword();
    expect(ui.setupTitle).toBe('Password · Setup');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set password');
    const rules = view.getByRole('list', { name: 'Password requirements' });
    expect(
      within(rules)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toEqual([
      'At least 10 characters: not met yet',
      'Upper- and lowercase letters: not met yet',
      'A number or special character: not met yet',
      'Passwords match: not met yet',
    ]);
    expect(view.getByText('Password strength')).toBeInTheDocument();
    const word = view.getByText('Not set yet');
    expect(word).toHaveAttribute('aria-live', 'polite');
    await type(/^Password$/, 'a');
    expect(word).toHaveTextContent('Weak');
    await type(/^Password$/, 'Abcdefghij');
    expect(word).toHaveTextContent('Fair');
    await type(/^Password$/, 'Abcdefghi1');
    expect(word).toHaveTextContent('Good');
    await type(/^Password$/, 'Abcdefghijklm1');
    expect(word).toHaveTextContent('Strong');
    // The match chip does not count towards the strength.
    await type('Confirm password', 'Abcdefghijklm1');
    expect(within(rules).getByText('Passwords match').parentElement).toHaveClass('ok');
    expect(word).toHaveTextContent('Strong');
    expect(view.container.querySelector('#su-pw2-ok')).toHaveTextContent('Passwords match');
  });

  it('has a hidden username field and separate eyes outside the Tab order', async () => {
    const view = await atPassword();
    const user = view.container.querySelector<HTMLInputElement>('input[name="username"]');
    expect(user).toHaveValue('anna@example.com');
    expect(user).toHaveAttribute('autocomplete', 'username');
    expect(user).not.toBeVisible();
    expect(user).toHaveAttribute('tabindex', '-1');
    const pw = view.getByLabelText(/^Password$/);
    const pw2 = view.getByLabelText('Confirm password');
    const eye = view.getByRole('button', { name: 'Show password' });
    const eye2 = view.getByRole('button', { name: 'Show confirmed password' });
    expect([eye.tabIndex, eye2.tabIndex]).toEqual([-1, -1]);
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(eye);
    expect(pw).toHaveAttribute('type', 'text');
    expect(pw2).toHaveAttribute('type', 'password');
    expect(view.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(eye2);
    expect(pw2).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Hide confirmed password' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows "too long" while typing and the mismatch on Enter', async () => {
    const view = await atPassword();
    const pw = view.getByLabelText(/^Password$/);
    const pw2 = view.getByLabelText('Confirm password');
    await type(/^Password$/, `Safe-enough1${'ä'.repeat(507)}`);
    expect(view.getByRole('alert')).toHaveTextContent('The password is too long (1024 bytes at most).');
    expect(pw).toHaveAttribute('aria-invalid', 'true');
    expect(pw).toHaveAttribute('aria-describedby', 'su-pw-err su-pw-rules');
    await type(/^Password$/, 'Safe-enough1');
    expect(view.queryByRole('alert')).toBeNull();
    // Incomplete: Enter moves to the field that is missing something, no message.
    await fireEvent.keyDown(pw, { key: 'Enter' });
    expect(pw2).toHaveFocus();
    expect(view.queryByRole('alert')).toBeNull();
    await type('Confirm password', 'Safe-enough2');
    await fireEvent.keyDown(pw2, { key: 'Enter' });
    expect(view.getByRole('alert')).toHaveTextContent('The passwords don’t match.');
    expect(pw2).toHaveAttribute('aria-invalid', 'true');
    // A new password clears it.
    await type(/^Password$/, 'Safe-enough2');
    expect(view.queryByRole('alert')).toBeNull();
    await fireEvent.keyDown(pw2, { key: 'Enter' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
    // Passwords live in memory only.
    expect(Object.values(sessionStorage)).not.toContain('Safe-enough2');
  });

  it('keeps "too long" after Back and forward again', async () => {
    const view = await atPassword();
    const long = `Safe-enough1${'ä'.repeat(507)}`;
    await type(/^Password$/, long);
    await type('Confirm password', long);
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    await next();
    expect(view.getByLabelText(/^Password$/)).toHaveValue(long);
    expect(view.getByRole('alert')).toHaveTextContent('The password is too long (1024 bytes at most).');
    expect(view.getByLabelText(/^Password$/)).toHaveAttribute('aria-invalid', 'true');
    expect(view.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the Caps Lock hint at the focused field and forgets it on leaving', async () => {
    const view = await atPassword();
    const pw = view.getByLabelText(/^Password$/);
    const pw2 = view.getByLabelText('Confirm password');
    const hints = () => [...view.container.querySelectorAll<HTMLElement>('.note.caps')];
    await fireEvent.keyDown(pw, { key: 'A', modifierCapsLock: true });
    expect(hints()).toHaveLength(1);
    expect(hints()[0]).toHaveTextContent('Caps Lock is on');
    expect(view.getByRole('status')).toHaveTextContent('Caps Lock is on');
    await fireEvent.keyDown(pw, { key: 'a' });
    expect(hints()).toHaveLength(0);
    // The Caps Lock key itself toggles the known state.
    await fireEvent.keyDown(pw, { key: 'CapsLock' });
    await fireEvent.keyUp(pw, { key: 'CapsLock' });
    expect(hints()).toHaveLength(1);
    // To the other password field: kept, shown there.
    await fireEvent.blur(pw, { relatedTarget: pw2 });
    await fireEvent.focus(pw2);
    expect(hints()).toHaveLength(1);
    expect(pw2.closest('.fld')).toContainElement(hints()[0]!);
    // Anywhere else: forgotten.
    await fireEvent.blur(pw2, { relatedTarget: null });
    await fireEvent.focus(pw2);
    expect(hints()).toHaveLength(0);
    expect(view.getByRole('status')).toHaveTextContent('');
  });

  it('speaks German', async () => {
    sessionStorage.setItem('roedy-setup-lang', 'de');
    mockApi({ 'POST setup/token': [{ body: {} }] });
    atToken();
    const view = render(Page);
    await vi.waitFor(() => expect(view.getByLabelText('Setup-Token')).toHaveFocus());
    await type('Setup-Token', 'abcd-efgh-jklm');
    await next('Weiter');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Administrator anlegen'));
    await type('Ihr Name', 'Anna Becker');
    await type('E-Mail-Adresse', 'anna@example.com');
    await next('Weiter');
    expect(ui.setupTitle).toBe('Passwort · Einrichtung');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Passwort festlegen');
    expect(view.getByText('Noch leer')).toBeInTheDocument();
    expect(view.getByRole('list', { name: 'Anforderungen an das Passwort' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Wiederholtes Passwort anzeigen' })).toBeInTheDocument();
    expect(view.getByText(/Damit melden Sie sich künftig an\./)).toBeInTheDocument();
  });
});
