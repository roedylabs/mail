import { createEvent, fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { keptUsers, type ListedUser } from '#lib/users.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

const NOW = Date.parse('2026-10-26T12:00:00Z');
const before = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
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
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: before(100),
  email_change: null,
  system_mail_configured: true,
};
const base = { mfa: false, created_at: before(500), last_seen_at: before(2) };
const USERS: ListedUser[] = [
  { ...base, id: 'u0', status: 'active', name: 'Jane Doe', email: ME.email, role: 'admin' },
  { ...base, id: 'u1', status: 'active', name: 'Alice Brown', email: 'alice@example.com', role: 'admin', mfa: true },
  { ...base, id: 'u3', status: 'locked', name: 'Sophie Taylor', email: 'sophie@example.com', role: 'user' },
  {
    ...base,
    id: 'i2',
    status: 'invited',
    name: null,
    email: 'paul@example.com',
    role: 'user',
    mail_sent_at: null,
    expires_at: before(-100),
    expired: false,
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  nav.goto.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  keptUsers.forget();
  window.dispatchEvent(new Event('resize'));
});

function renderPage(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ 'GET users': [{ body: { users: USERS } }, { body: { users: USERS } }], ...routes });
  return { ...render(Page), ...api };
}

describe('Users page', () => {
  it('shows heading, list with columns and "Not sent"', async () => {
    const view = renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Users');
    expect(view.getByText('Create, edit, and suspend accounts.')).toBeInTheDocument();
    expect(await view.findByText('Alice Brown')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sort by Name' })).toBeInTheDocument();
    expect(view.getByText('You')).toBeInTheDocument();
    expect(view.getByText('Not sent')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Multi-factor enabled' })).toBeInTheDocument();
    expect(view.getByRole('checkbox', { name: 'You can’t select your own account' })).toBeInTheDocument();
    expect(view.queryByRole('note')).toBeNull();
    // Initials next to the name are decorative, also faded for locked users.
    const sophie = view.getByRole('button', { name: /^Sophie Taylor/, expanded: false });
    const av = sophie.querySelector('.av');
    expect(av).toHaveClass('locked');
    expect(av).toHaveAttribute('aria-hidden', 'true');
  });

  it('filters via search and resets the filter', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.input(view.getByLabelText('Search users'), { target: { value: 'xyz' } });
    expect(view.getByText(m.users_empty_query({ q: 'xyz' }))).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Clear filter' }));
    expect(view.getByText('Alice Brown')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: /^Suspended/ }));
    expect(view.queryByText('Alice Brown')).toBeNull();
    expect(view.getByRole('button', { name: /^Suspended/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends invitations: chips, cleared field, sending and toast', async () => {
    const view = renderPage({
      'POST invites': [
        {
          status: 201,
          body: {
            invites: [
              { id: 'n1', email: 'eve@example.com', sent: true },
              { id: 'n2', email: 'tim@example.com', sent: true },
            ],
            system_mail: true,
          },
        },
      ],
    });
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    expect(view.getByText('Invite people')).toBeInTheDocument();
    const field = view.getByLabelText('Email addresses') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: 'eve@example.com, tim@example.com ' } });
    // Accepted addresses show as chips and leave the field.
    expect(field.value).toBe('');
    expect(view.getByRole('button', { name: 'Remove eve@example.com' })).toBeInTheDocument();
    expect(view.getByRole('textbox', { name: 'Name' })).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Send 2 invitations' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('2 invitations sent'));
    expect(view.queryByText('Invite people')).toBeNull();
  });

  it('focuses "Email addresses" 40 ms after opening "Invite people"', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    const field = view.getByLabelText('Email addresses');
    expect(field).not.toHaveFocus();
    await vi.waitFor(() => expect(field).toHaveFocus());
  });

  it('focuses "Email addresses" when opened via the search action "Invite user"', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    ui.userInvite = true;
    const field = await view.findByLabelText('Email addresses');
    await vi.waitFor(() => expect(field).toHaveFocus());
  });

  it('reports a name over 100 characters instead of cutting it off', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    await fireEvent.input(view.getByLabelText('Email addresses'), { target: { value: 'eve@example.com' } });
    const name = view.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(name).not.toHaveAttribute('maxlength');
    await fireEvent.input(name, { target: { value: 'E'.repeat(101) } });
    expect(name.value).toHaveLength(101);
    expect(view.getByRole('alert')).toHaveTextContent('The name is too long.');
    expect(view.getByRole('button', { name: 'Send invitation' })).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.input(name, { target: { value: 'E'.repeat(100) } });
    expect(view.getByRole('alert')).toHaveTextContent('');
    expect(view.getByRole('button', { name: 'Send invitation' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('marks taken addresses and shows the message', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    const field = view.getByLabelText('Email addresses');
    await fireEvent.input(field, { target: { value: 'alice@example.com' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(view.getByRole('alert')).toHaveTextContent('alice@example.com already belongs to an account.');
    expect(view.getByRole('button', { name: /Send invitation/ })).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.keyDown(field, { key: 'Escape' });
    expect(view.queryByText('Invite people')).toBeNull();
  });

  it('shows the notice with "Set up email" and "Create invitation" without system mail', async () => {
    session.user = { ...ME, system_mail_configured: false };
    const view = renderPage();
    await view.findByText('Alice Brown');
    expect(view.getByRole('note')).toHaveTextContent('Invitations aren’t sent by email');
    await fireEvent.click(view.getByRole('button', { name: /Set up email/ }));
    expect(nav.goto).toHaveBeenCalledWith('/admin/email');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    expect(
      view.getByText(
        'Separate addresses with commas, spaces, or Enter. You can then copy the invitation link from the list.',
      ),
    ).toBeInTheDocument();
    await fireEvent.input(view.getByLabelText('Email addresses'), { target: { value: 'eve@example.com' } });
    expect(view.getByRole('button', { name: /Create invitation/ })).toBeInTheDocument();
  });

  it('expands a row and asks before locking', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: /Alice Brown/, expanded: false }));
    const radios = view.getByRole('radiogroup', { name: 'Role' });
    expect(within(radios).getByRole('radio', { name: /Administrator/ })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Suspend' }));
    expect(ui.confirm?.title).toBe('Suspend Alice Brown?');
    ui.confirmOk();
    await vi.waitFor(() => expect(view.getAllByText('Suspended').length).toBeGreaterThan(1));
    expect(ui.toast).toMatchObject({ text: 'Alice Brown suspended', undo: true });
    expect(view.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('leads to Account › Profile for the own account', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: /Jane Doe/, expanded: false }));
    expect(view.getByText('Only another administrator can change your own role.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Edit your account' }));
    expect(nav.goto).toHaveBeenCalledWith('/account/profile');
  });

  it('selects and changes the role via the pick list', async () => {
    const view = renderPage({ 'POST users/bulk': [{ body: { changed: ['u3', 'i2'] } }] });
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Select Sophie Taylor' }));
    await fireEvent.click(view.getByRole('checkbox', { name: 'Select paul@example.com' }));
    expect(view.getByRole('toolbar', { name: 'Edit selection' })).toHaveTextContent('2 selected');
    expect(view.queryByRole('group', { name: 'Filter by status' })).toBeNull();
    const roleBtn = view.getByRole('combobox', { name: 'Change role' });
    roleBtn.focus();
    await fireEvent.click(roleBtn);
    const list = view.getByRole('listbox', { name: 'Role for 2 people' });
    const admin = within(list).getByRole('option', { name: /Administrator/ });
    // The mouse click does not take the focus from the button.
    const down = createEvent.mouseDown(admin);
    await fireEvent(admin, down);
    expect(down.defaultPrevented).toBe(true);
    await fireEvent.click(admin);
    expect(view.queryByRole('listbox')).toBeNull();
    expect(ui.toast?.text).toBe('Role changed for 2 people');
    await fireEvent.click(view.getByRole('button', { name: 'Clear selection' }));
    expect(view.getByRole('group', { name: 'Filter by status' })).toBeInTheDocument();
  });

  it('names the list and the highlighted role on "Change role" while open', async () => {
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Select Sophie Taylor' }));
    const roleBtn = view.getByRole('combobox', { name: 'Change role' });
    expect(roleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(roleBtn).not.toHaveAttribute('aria-controls');
    expect(roleBtn).not.toHaveAttribute('aria-activedescendant');

    // ↓ opens with the shared role highlighted (Sophie is a user).
    await fireEvent.keyDown(roleBtn, { key: 'ArrowDown' });
    const list = view.getByRole('listbox', { name: 'Role for 1 person' });
    expect(roleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(list.id).not.toBe('');
    expect(roleBtn).toHaveAttribute('aria-controls', list.id);
    const [admin, user] = within(list).getAllByRole('option');
    expect(user).toHaveAttribute('aria-selected', 'true');
    expect(roleBtn).toHaveAttribute('aria-activedescendant', user!.id);

    await fireEvent.keyDown(roleBtn, { key: 'ArrowDown' });
    expect(admin).toHaveTextContent('Administrator');
    expect(admin).toHaveClass('hi');
    expect(roleBtn).toHaveAttribute('aria-activedescendant', admin!.id);
    expect(admin!.id).not.toBe(user!.id);
  });

  it('shows avatar as selection, row with status and actions stacked on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    await view.findByText('Alice Brown');
    expect(view.getByPlaceholderText('Name or email')).toBeInTheDocument();
    expect(view.getByText('· Not sent')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('checkbox', { name: 'Select Alice Brown' }));
    expect(view.getByRole('button', { name: 'Change role' })).toHaveAttribute('aria-haspopup', 'listbox');
    await fireEvent.click(view.getByRole('button', { name: 'Change role' }));
    // On mobile the layout shows the list as a sheet (`ui.pick`).
    expect(ui.menu).toBe('pick');
    expect(ui.pick?.().title).toBe('Role for 1 person');
    await fireEvent.click(view.getByRole('button', { name: /Alice Brown/, expanded: false }));
    expect(view.getByText('alice@example.com · Last active 2 hours ago', { exact: false })).toBeInTheDocument();
  });

  it('focuses "Email addresses" after opening "Invite people" on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    await view.findByText('Alice Brown');
    await fireEvent.click(view.getByRole('button', { name: 'Invite' }));
    const field = view.getByLabelText('Email addresses');
    await vi.waitFor(() => expect(field).toHaveFocus());
    const name = view.getByRole('textbox', { name: 'Name' });
    expect(name).not.toHaveAttribute('maxlength');
    await fireEvent.input(name, { target: { value: 'E'.repeat(101) } });
    expect(view.getByRole('alert')).toHaveTextContent('The name is too long.');
    expect(view.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers "Extend" instead of "Copy link" for an expired invitation', async () => {
    prefs.values.tzAuto = false;
    prefs.values.tz = 'Europe/Berlin';
    const old: ListedUser = {
      ...base,
      id: 'i3',
      status: 'invited',
      name: 'Eve Moore',
      email: 'eve@example.com',
      role: 'user',
      mail_sent_at: before(200),
      expires_at: before(32),
      expired: true,
    };
    const view = renderPage({
      'GET users': [{ body: { users: [...USERS, old] } }],
      'POST invites/i3/renew': [{ body: { invite: { ...old, expires_at: before(-168), expired: false } } }],
    });
    await view.findByText('Eve Moore');
    expect(view.getAllByText('Expired').length).toBeGreaterThan(0);
    await fireEvent.click(view.getByRole('button', { name: /Eve Moore/, expanded: false }));
    expect(view.getByRole('alert')).toHaveTextContent('This invitation has expired');
    expect(view.queryByRole('button', { name: 'Copy link' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Extend' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Invitation extended until 2 November'));
    expect(view.getByText('Valid until 2 November')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Extend' })).toBeNull();
  });

  it('shows the error page when the list does not load, and reloads', async () => {
    const view = renderPage({
      'GET users': [{ status: 500, body: { error: 'internal' } }, { body: { users: USERS } }],
    });
    expect(await view.findByText('Something went wrong')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Alice Brown')).toBeInTheDocument();
  });

  it('shows the list at once on reopen and keeps it with a toast if loading fails', async () => {
    const first = renderPage();
    expect(await first.findByText('Alice Brown')).toBeInTheDocument();
    first.unmount();
    mockApi({ 'GET users': [{ status: 500, body: { error: 'internal' } }] });
    const view = render(Page);
    expect(view.getByText('Alice Brown')).toBeInTheDocument();
    await vi.waitFor(() => expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true }));
    expect(view.queryByText('Something went wrong')).toBeNull();
    expect(view.getByText('Alice Brown')).toBeInTheDocument();
  });
});
