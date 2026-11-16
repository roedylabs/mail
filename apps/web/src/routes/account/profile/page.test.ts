import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const ME: Me = {
  id: 'u0',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'user',
  mfa_enabled: true,
  sole_admin: false,
  password_changed_at: '2026-10-20T10:00:00Z',
  email_change: null,
};
const USER = { id: 'u0', username: 'jane', email: 'jane@example.com', display_name: 'Jane Doe', role: 'user' };

beforeEach(() => {
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('Profile page', () => {
  it('shows account, display name, username, email and sign-in', () => {
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Profile');
    expect(view.getByText('The local account you sign in with.')).toBeInTheDocument();
    expect(view.getByText('JD')).toBeInTheDocument();
    expect(view.getByText('jane · No email account')).toBeInTheDocument();
    expect(view.getByText('Shown to other people')).toBeInTheDocument();
    expect(view.getByText('jane@example.com')).toBeInTheDocument();
    expect(view.getByText('Password')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Edit display name' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Edit Username' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Edit Email' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit Sign-in' })).toBeNull();
  });

  it('edits the name with the "Unsaved changes" bar and saves', async () => {
    const { calls } = mockApi({
      'PATCH auth/me': [{ body: { status: 'ok', user: { ...USER, display_name: 'Jane D.' } } }],
    });
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Edit display name' }));
    const input = view.getByRole('textbox', { name: 'Display name' });
    expect(input).toHaveFocus();
    await fireEvent.input(input, { target: { value: 'Jane D.' } });
    const bar = view.getByRole('region', { name: 'Unsaved changes' });
    await fireEvent.click(within(bar).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Changes saved'));
    expect(calls.map((c) => c.body)).toEqual([{ display_name: 'Jane D.' }]);
    expect(view.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(view.getAllByText('Jane D.')).toHaveLength(2);
  });

  it('asks for password and code for a new address and then shows "Confirmation pending"', async () => {
    const open = { email: 'new@example.com', expires_at: '2026-10-27T10:00:00Z' };
    const { calls } = mockApi({
      'PATCH auth/me': [
        { body: { status: 'reauth_required', user: USER } },
        { status: 502, body: { error: 'mail_failed' } },
        { body: { status: 'email_sent', user: USER, email_change: open } },
      ],
    });
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Edit Email' }));
    const input = view.getByRole('textbox', { name: 'Email' });
    await fireEvent.input(input, { target: { value: 'new@example.com' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    const group = await view.findByRole('group', { name: 'Confirm email address change' });
    expect(
      within(group).getByText('Confirm the change with your password and a code from your authenticator app.'),
    ).toBeInTheDocument();
    const send = within(group).getByRole('button', { name: 'Send confirmation link' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    const pw = within(group).getByLabelText('Current password');
    expect(pw).toHaveFocus();
    await fireEvent.input(pw, { target: { value: 'Secret-123' } });
    await fireEvent.input(within(group).getByLabelText('Verification code'), { target: { value: '123456' } });
    expect(send).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(send);
    await vi.waitFor(() =>
      expect(
        within(group).getByText(
          'The email couldn’t be sent. Your email address wasn’t changed. Try again later with a new code.',
        ),
      ).toBeInTheDocument(),
    );
    expect(within(group).getByLabelText('Verification code')).toHaveValue('');
    await fireEvent.input(within(group).getByLabelText('Verification code'), { target: { value: '654321' } });
    await fireEvent.click(send);
    const status = await view.findByRole('status');
    expect(status).toHaveTextContent('Confirmation pending');
    expect(status).toHaveTextContent('We sent a confirmation link to new@example.com.');
    expect(within(status).getByRole('button', { name: 'Resend link' })).toBeInTheDocument();
    expect(within(status).getByRole('button', { name: 'Discard change' })).toBeInTheDocument();
    expect(calls).toHaveLength(3);
  });

  it('shows list, field below the row and the bar with two buttons on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    session.user = { ...ME, email_change: { email: 'new@example.com', expires_at: '2026-10-27T10:00:00Z' } };
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Profile');
    expect(view.getByRole('status')).toHaveTextContent('Confirmation pending');
    await fireEvent.click(view.getByRole('button', { name: 'Edit Username' }));
    await fireEvent.input(view.getByRole('textbox', { name: 'Username' }), { target: { value: 'Jane!' } });
    const bar = view.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).queryByText('Unsaved changes')).toBeNull();
    await fireEvent.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(view.getByRole('alert')).toHaveTextContent(
      'Only lowercase letters, digits, periods, hyphens, and underscores, 2 to 32 characters.',
    );
    await fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(view.queryByRole('alert')).toBeNull();
  });
});
