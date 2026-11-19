import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInfo } from '#lib/build-info.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

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

describe('Setup page', () => {
  it('shows step 1 with terminal, progress and version', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Roedy Mail');
    expect(view.getByText('Initial setup')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Step 1 of 4' })).toBeInTheDocument();
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
    mockApi({ 'POST setup/token': [{ body: {} }] });
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

  it('leads through all four steps and then signs in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockApi({
      'POST setup/token': [{ body: {} }],
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
    expect(view.getByRole('img', { name: 'Step 2 of 4' })).toBeInTheDocument();

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

    // 4: overview and completion
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('All set?');
    expect(view.getByRole('img', { name: 'Step 4 of 4' })).toBeInTheDocument();
    expect(view.getByText('Anna Becker · anna@example.com')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Change Administrator' }));
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Create administrator');
    // On through 2 and 3 again.
    await next();
    await next();
    await next('Finish setup');
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Anna'));
    expect(view.getByText('Roedy Mail is set up. Signing you in …')).toBeInTheDocument();
    const complete = calls.find((c) => c.path === 'setup/complete');
    expect(complete?.headers['X-Setup-Token']).toBe('ABCD-EFGH-JKLM');
    expect(complete?.body).toEqual({
      name: 'Anna Becker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      settings: { lang: 'en', mode: 'system', accent: 'apricot' },
    });

    await vi.advanceTimersByTimeAsync(2700);
    await vi.waitFor(() => expect(session.authed).toBe(true));
    expect(calls.map((c) => c.path)).toContain('settings');
  });
});
