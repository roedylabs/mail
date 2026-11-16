import { fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailLogin, type FlowState } from '#lib/auth/mail-login.svelte.ts';
import { FORM0, type MailServer, type ServerList } from '#lib/auth/stalwart-login.ts';
import { m } from '#lib/paraglide/messages.js';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MailAccountsView from './MailAccountsView.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

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
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-07-24T10:00:00Z',
  email_change: null,
};

const VPS1: MailServer = {
  id: 's1',
  label: 'VPS 1',
  url: 'https://mail.s1.test',
  host: 'mail.s1.test',
  domains: ['s1.test'],
  client_id: 'roedy',
  backend_exchange: false,
  reach: 'ok',
  cors: 'ok',
  oauth: 'ok',
};
const VPS2: MailServer = {
  ...VPS1,
  id: 's2',
  label: 'VPS 2',
  url: 'https://mail.s2.test',
  host: 'mail.s2.test',
  domains: [],
};
const SERVERS: ServerList = { servers: [VPS1, VPS2], allow_custom_servers: true };
const GIB = 1024 ** 3;

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    username: 'account1@s1.test',
    url: 'https://mail.s1.test',
    host: 'mail.s1.test',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
    ...overrides,
  };
}

const STATUS0 = {
  step: 'cred',
  busy: false,
  err: null,
  as: '',
  sErr: '',
  rl: false,
  dupId: null,
  failure: null,
  done: null,
} as const;

/** Form with input and state, as `mailLogin.add` sets it. */
function setForm(patch: Partial<FlowState> = {}): void {
  mailLogin.add.form = { ...FORM0, ...STATUS0, email: 'max@s1.test', ...patch };
}

function mobile(): void {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  session.config = CONFIG;
  session.user = ME;
  mockApi({ 'GET servers': [{ body: SERVERS }, { body: SERVERS }] });
  mailLogin.servers = SERVERS;
  accounts.list = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  mailLogin.reset();
  accounts.reset();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('page email accounts', () => {
  it('shows the accounts with default, status and last sync', async () => {
    accounts.list = [
      account({
        quota_used: 2.4 * GIB,
        quota_total: 10 * GIB,
        last_check_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      account({ id: 'a2', email: 'max@s2.test', host: 'mail.s2.test', color: 1, state: 'needs_reauth' }),
    ];
    const view = render(MailAccountsView, { adding: false });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Email accounts');
    expect(
      view.getByText('Mailboxes you use here. Each account can be on a different JMAP server.'),
    ).toBeInTheDocument();
    const first = view.getByRole('button', { name: /^account1@s1\.test/ });
    expect(within(first).getByText('Default')).toBeInTheDocument();
    expect(within(first).getByText('mail.s1.test · 2.4 GB of 10 GB')).toBeInTheDocument();
    expect(within(first).getByText('Connected').closest('.st')).not.toHaveClass('auth');
    expect(within(first).getByText('Checked 2 min ago')).toBeInTheDocument();
    const second = view.getByRole('button', { name: /^max@s2\.test/ });
    expect(within(second).queryByText('Default')).toBeNull();
    expect(within(second).getByText('Sign-in required').closest('.st')).toHaveClass('auth');
    expect(view.queryByText('No email account connected yet.')).toBeNull();
    expect(view.queryByText('New email account')).toBeNull();
    await fireEvent.click(first);
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a1/overview');
    // "Sign-in required" also leads to the overview, which shows the way to the connection.
    await fireEvent.click(second);
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a2/overview');
    await fireEvent.click(view.getByRole('button', { name: 'Add email account' }));
    expect(nav.goto).toHaveBeenLastCalledWith('/account/mail-accounts/new');
  });

  it('shows "All accounts" only from two accounts on and sets it as the default', async () => {
    accounts.list = [account()];
    const view = render(MailAccountsView, { adding: false });
    expect(view.queryByText('All accounts')).toBeNull();
    accounts.list = [account(), account({ id: 'a2', email: 'max@s2.test', host: 'mail.s2.test', color: 1 })];
    await tick();
    const row = view.getByText('All accounts').closest('.all') as HTMLElement;
    expect(within(row).getByText('Folders from all accounts combined')).toBeInTheDocument();
    expect(within(row).getByText('A')).toBeInTheDocument();
    expect(within(row).getByText('M')).toBeInTheDocument();
    expect(within(row).queryByText('Default')).toBeNull();
    expect(within(view.getByRole('button', { name: /^account1@s1\.test/ })).getByText('Default')).toBeInTheDocument();
    await fireEvent.click(within(row).getByRole('button', { name: 'Set as default' }));
    expect(prefs.values.defaultAccount).toBe('all');
    expect(ui.toast).toMatchObject({ text: m.mail_accounts_all_default_done(), undo: true });
    expect(within(row).getByText('Default')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(view.getByRole('button', { name: /^account1@s1\.test/ })).queryByText('Default')).toBeNull();
  });

  it('shows "All accounts" on mobile with the star as a button', async () => {
    mobile();
    accounts.list = [account(), account({ id: 'a2', email: 'max@s2.test', host: 'mail.s2.test', color: 1 })];
    const view = render(MailAccountsView, { adding: false });
    const row = view.getByText('All accounts').closest('.all') as HTMLElement;
    const star = within(row).getByRole('button', { name: 'Set as default' });
    expect(star).not.toHaveTextContent('Set as default');
    await fireEvent.click(star);
    expect(prefs.values.defaultAccount).toBe('all');
    expect(within(row).getByText('Default')).toBeInTheDocument();
  });

  it('reports an empty list only once it is known', async () => {
    accounts.list = null;
    const view = render(MailAccountsView, { adding: false });
    expect(view.queryByText('No email account connected yet.')).toBeNull();
    accounts.list = [];
    await tick();
    expect(view.getByText('No email account connected yet.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Add email account' })).toBeInTheDocument();
  });

  it('opens the form on /new with focus on the email address', async () => {
    const view = render(MailAccountsView, { adding: true });
    expect(view.getByText('New email account')).toBeInTheDocument();
    expect(
      view.getByText('You’ll sign in on your mail server’s page, then return here. The server must support JMAP.'),
    ).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Add email account' })).toBeNull();
    const email = view.getByLabelText('Email address');
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute('placeholder', 'name@example.com');
    // Name from the field label and the visible value (WCAG 2.5.3).
    expect(view.getByRole('combobox', { name: 'Server Automatic' })).toHaveTextContent('Automatic');
    const auth = view.getByRole('radiogroup', { name: 'Sign-in method' });
    expect(within(auth).getByRole('radio', { name: 'Password' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText(/on your mail server’s sign-in page/)).toBeInTheDocument();
    const go = view.getByRole('button', { name: 'Continue to sign-in' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    expect(go).not.toHaveClass('hot');

    await fireEvent.input(email, { target: { value: 'max@s1.test' } });
    expect(view.getByText('Server: mail.s1.test')).toBeInTheDocument();
    expect(view.getByText(/on the sign-in page of mail\.s1\.test/)).toBeInTheDocument();
    expect(go).toHaveAttribute('aria-disabled', 'false');
    expect(go).toHaveClass('hot', 'ready');

    await fireEvent.click(within(auth).getByRole('radio', { name: 'Token' }));
    const token = view.getByLabelText('Access token');
    expect(token).toHaveAttribute('type', 'password');
    const connect = view.getByRole('button', { name: 'Connect' });
    expect(connect).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Show' }));
    expect(token).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    await fireEvent.input(token, { target: { value: 'secret' } });
    expect(connect).toHaveAttribute('aria-disabled', 'false');

    await fireEvent.keyDown(email, { key: 'Escape' });
    expect(mailLogin.add.form).toBeNull();
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts');
  });

  it('cancels with "Cancel"', async () => {
    setForm();
    const view = render(MailAccountsView, { adding: true });
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(mailLogin.add.form).toBeNull();
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts');
  });

  it('shows "Account already connected" with "Open account"', async () => {
    setForm({ err: 'dup', as: 'account1@s1.test', dupId: 'a1' });
    const view = render(MailAccountsView, { adding: true });
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Account already connected');
    expect(alert).toHaveTextContent('account1@s1.test is already connected to Roedy Mail.');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Open account' }));
    expect(mailLogin.add.form).toBeNull();
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a1/overview');
  });

  it('offers "Check mail servers" only to the administration and names the server error code', async () => {
    setForm({ err: 'cors' });
    const view = render(MailAccountsView, { adding: true });
    expect(view.getByRole('alert')).toHaveTextContent('CORS not enabled');
    expect(within(view.getByRole('alert')).queryByRole('button')).toBeNull();
    session.user = { ...ME, role: 'admin' };
    await tick();
    await fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: 'Check mail servers' }));
    expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers');
    setForm({ err: 'denied', sErr: 'server_error' });
    await tick();
    expect(view.getByRole('alert')).toHaveTextContent('Sign-in not completed');
    expect(view.getByText('Server message: server_error')).toBeInTheDocument();
  });

  it('locks after "Too many attempts" with a countdown on the button', async () => {
    vi.useFakeTimers();
    setForm({ err: 'rate', rl: true });
    mailLogin.add.lockUntil = Date.now() + 30_000;
    const view = render(MailAccountsView, { adding: true });
    await tick();
    expect(view.getByRole('alert')).toHaveTextContent(
      'mail.s1.test isn’t accepting sign-ins right now. Try again in 30 seconds.',
    );
    const go = view.getByRole('button', { name: 'Try again in 0:30' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    expect(go).toHaveClass('locked');
    expect(go).not.toHaveClass('hot');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(go).toHaveTextContent('Try again in 0:01');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(go).toHaveTextContent('Continue to sign-in');
    expect(go).toHaveAttribute('aria-disabled', 'false');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the loading state before the redirect', () => {
    setForm({ busy: true });
    const view = render(MailAccountsView, { adding: true });
    expect(view.getByRole('status')).toHaveTextContent('Opening the sign-in page of mail.s1.test …');
    const go = view.getByRole('button', { name: 'Opening …' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    expect(go).toHaveClass('hot', 'busy');
    expect(go.querySelector('.btn-icon')).toHaveClass('spin');
    expect(view.getByRole('combobox', { name: /^Server / })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows only the status line after the return', () => {
    setForm({ step: 'ret', srv: 's1' });
    const view = render(MailAccountsView, { adding: true });
    const status = view.getByRole('status');
    expect(status).toHaveTextContent('Finishing sign-in to mail.s1.test …');
    expect(status).toHaveTextContent('Roedy Mail is setting up the account.');
    expect(view.queryByLabelText('Email address')).toBeNull();
    expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('opens the account with "Open now" after connecting', async () => {
    setForm({ step: 'done', done: 'a9', as: 'max@s1.test' });
    const view = render(MailAccountsView, { adding: true });
    const status = view.getByRole('status');
    expect(status).toHaveTextContent('max@s1.test is connected');
    expect(status).toHaveTextContent('Taking you to the account overview …');
    await fireEvent.click(within(status).getByRole('button', { name: 'Open now' }));
    expect(nav.goto).toHaveBeenCalledExactlyOnceWith('/account/mail-accounts/a9/overview');
    expect(ui.toast?.text).toBe('max@s1.test connected');
  });

  it('chooses the server by click and shows the address with "Other server"', async () => {
    setForm();
    const view = render(MailAccountsView, { adding: true });
    const btn = view.getByRole('combobox', { name: /^Server / });
    expect(view.queryByRole('listbox')).toBeNull();
    await fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveClass('open');
    const list = view.getByRole('listbox', { name: 'Server' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Automatic Server: mail.s1.test',
      'VPS 1 mail.s1.test',
      'VPS 2 mail.s2.test',
      'Other server … Enter the address yourself',
    ]);
    expect(within(list).getByRole('option', { name: /^Automatic/ })).toHaveAttribute('aria-selected', 'true');
    await fireEvent.click(within(list).getByRole('option', { name: /^VPS 2/ }));
    expect(view.queryByRole('listbox')).toBeNull();
    expect(btn).toHaveTextContent('VPS 2');
    expect(view.queryByText('Server: mail.s1.test')).toBeNull();
    await fireEvent.click(btn);
    await fireEvent.click(view.getByRole('option', { name: /^Other server/ }));
    const url = view.getByLabelText('Server address');
    expect(url).toHaveAttribute('placeholder', 'https://mail.example.com');
    await fireEvent.input(url, { target: { value: 'https://mail.custom.example.com' } });
    expect(view.getByText(/on the sign-in page of mail\.custom\.example\.com/)).toBeInTheDocument();
  });

  it('names the list and the marked server at the button when open', async () => {
    setForm();
    const view = render(MailAccountsView, { adding: true });
    const btn = view.getByRole('combobox', { name: /^Server / });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).not.toHaveAttribute('aria-controls');
    expect(btn).not.toHaveAttribute('aria-activedescendant');

    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    const list = view.getByRole('listbox', { name: 'Server' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(list.id).not.toBe('');
    expect(btn).toHaveAttribute('aria-controls', list.id);
    const opts = within(list).getAllByRole('option');
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(btn).toHaveAttribute('aria-activedescendant', opts[0]!.id);

    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(opts[1]).toHaveTextContent('VPS 1');
    expect(opts[1]).toHaveClass('hi');
    expect(btn).toHaveAttribute('aria-activedescendant', opts[1]!.id);
  });

  it('shows status without time, the server picker in the sheet and the buttons stacked on mobile', async () => {
    mobile();
    accounts.list = [account({ last_check_at: new Date(Date.now() - 120_000).toISOString() })];
    setForm();
    const view = render(MailAccountsView, { adding: true });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Email accounts');
    expect(view.getByText('Connect and manage mailboxes.')).toBeInTheDocument();
    expect(
      view.getByText('Mailboxes you use here. Each account can be on a different JMAP server.'),
    ).toBeInTheDocument();
    const row = view.getByRole('button', { name: /^account1@s1\.test/ });
    expect(within(row).getByText('Connected')).toBeInTheDocument();
    expect(within(row).queryByText('Checked 2 min ago')).toBeNull();
    expect(within(row).queryByText('mail.s1.test')).toBeNull();
    expect(view.getByLabelText('Email address')).not.toHaveFocus();
    await fireEvent.click(view.getByRole('button', { name: /^Server / }));
    expect(ui.menu).toBe('pick');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(ui.pick?.()).toMatchObject({ title: 'Server' });
    expect(ui.pick?.().opts.map((o) => o.label)).toEqual(['Automatic', 'VPS 1', 'VPS 2', 'Other server …']);
    const buttons = within(view.container.querySelector('.acts') as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue to sign-in', 'Cancel']);
  });
});
