import { fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { freshForm, mailLogin, type FlowState } from '#lib/auth/mail-login.svelte.ts';
import type { MailServer } from '#lib/auth/stalwart-login.ts';
import { mailCheck } from '#lib/mail-account.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MailConnectionView from './MailConnectionView.svelte';

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
  username: 'max',
  email: 'max@example.com',
  display_name: 'Jane Doe',
  role: 'user',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-07-24T10:00:00Z',
  email_change: null,
};

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

/** Open "Sign in again" for the account, as `mailLogin.re` sets it. */
function setRe(patch: Partial<FlowState> = {}, acct: MailAccount = account()): void {
  mailLogin.re.form = { ...freshForm(acct), ...patch };
  mailLogin.re.account = acct.id;
}

function mobile(): void {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

function view(id = 'a1') {
  return render(MailConnectionView, { id });
}

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

/** Rows of the facts box as "label: value". */
function facts(v: ReturnType<typeof view>): string[] {
  return [...v.container.querySelectorAll('.fact')].map(
    (row) => `${row.querySelector('.fact-k')?.textContent}: ${row.querySelector('.fact-v')?.textContent}`,
  );
}

/** Buttons outside the box "Sign in again". */
function rowButtons(v: ReturnType<typeof view>): (string | null)[] {
  return within(v.container.querySelector('.row') as HTMLElement)
    .getAllByRole('button')
    .map((b) => b.textContent);
}

async function tipOf(el: Element): Promise<string | undefined> {
  vi.useFakeTimers();
  await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_DELAY);
  const text = ui.tip?.text;
  await fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  vi.useRealTimers();
  return text;
}

beforeEach(() => {
  session.config = CONFIG;
  session.user = ME;
  accounts.list = [account()];
});

afterEach(() => {
  hideTooltip();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  mailCheck.busy = null;
  mailCheck.rot = 0;
  mailLogin.reset();
  accounts.reset();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('page connection', () => {
  it('shows "Sign in again" as soon as the account is known; the layout shows the head', async () => {
    accounts.list = null;
    const v = view();
    expect(v.queryByRole('heading', { level: 1 })).toBeNull();
    expect(v.queryByText('account1@s1.test')).toBeNull();
    expect(v.queryByRole('button')).toBeNull();
    expect(nav.goto).not.toHaveBeenCalled();
    accounts.list = [account()];
    await tick();
    expect(v.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(v.queryByRole('button', { name: 'Continue to sign-in' })).toBeNull();
  });

  it('shows hint and "Continue to sign-in" without cancel with "Sign-in required" (password)', () => {
    accounts.list = [account({ state: 'needs_reauth' })];
    const v = view();
    expect(v.getByText('mail.s1.test rejected the sign-in. Sign in again.')).toBeInTheDocument();
    expect(
      v.getByText('You’ll sign in as account1@s1.test on the sign-in page of mail.s1.test, then return here.'),
    ).toBeInTheDocument();
    const go = v.getByRole('button', { name: 'Continue to sign-in' });
    expect(go).toHaveAttribute('aria-disabled', 'false');
    expect(go).toHaveClass('hot', 'ready');
    expect(v.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(v.queryByText('Sign in again')).toBeNull();
    expect(v.queryByLabelText('Access token')).toBeNull();
  });

  it('shows the field with eye and disables "Connect" without input with "Sign-in required" (token)', async () => {
    accounts.list = [account({ state: 'needs_reauth', auth_kind: 'token' })];
    const v = view();
    const token = v.getByLabelText('Access token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).not.toHaveAttribute('placeholder');
    const connect = v.getByRole('button', { name: 'Connect' });
    expect(connect).toHaveAttribute('aria-disabled', 'true');
    expect(connect).not.toHaveClass('hot');
    expect(v.queryByText(/on the sign-in page of/)).toBeNull();
    // The first input opens the account's form.
    await fireEvent.input(token, { target: { value: 'secret' } });
    expect(mailLogin.re.account).toBe('a1');
    expect(mailLogin.re.form?.token).toBe('secret');
    expect(connect).toHaveAttribute('aria-disabled', 'false');
    expect(connect).toHaveClass('hot', 'ready');
    await fireEvent.click(v.getByRole('button', { name: 'Show' }));
    expect(token).toHaveAttribute('type', 'text');
    expect(v.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  it('opens the form with a heading for a connected account and closes it with "Cancel"', async () => {
    const v = view();
    await fireEvent.click(v.getByRole('button', { name: 'Sign in again' }));
    expect(mailLogin.re.account).toBe('a1');
    expect(v.getByText('Sign in again')).toHaveClass('f-title');
    expect(v.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(v.getByText(/^You’ll sign in as .* on the sign-in page of mail\.s1\.test/)).toBeInTheDocument();
    const buttons = within(v.container.querySelector('.acts') as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Continue to sign-in']);
    await fireEvent.click(v.getByRole('button', { name: 'Cancel' }));
    expect(mailLogin.re.form).toBeNull();
    expect(v.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(v.queryByRole('button', { name: 'Continue to sign-in' })).toBeNull();
  });

  it('shows the loading state before the redirect', () => {
    setRe({ busy: true });
    const v = view();
    expect(v.getByRole('status')).toHaveTextContent('Opening the sign-in page of mail.s1.test …');
    const go = v.getByRole('button', { name: 'Opening …' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    expect(go).toHaveClass('hot', 'busy');
    expect(go.querySelector('.btn-icon')).toHaveClass('spin');
  });

  it('offers "Check mail servers" only to the administration and names the server error code', async () => {
    setRe({ err: 'cors' });
    const v = view();
    expect(v.getByRole('alert')).toHaveTextContent('CORS not enabled');
    expect(within(v.getByRole('alert')).queryByRole('button')).toBeNull();
    session.user = { ...ME, role: 'admin' };
    await tick();
    await fireEvent.click(within(v.getByRole('alert')).getByRole('button', { name: 'Check mail servers' }));
    expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers');
    setRe({ err: 'denied', sErr: 'access_denied' });
    await tick();
    expect(v.getByRole('alert')).toHaveTextContent('Sign-in not completed');
    expect(v.getByText('Server message: access_denied')).toBeInTheDocument();
  });

  it('shows the hint instead of the form with a blocked server, "Check mail servers" only to the administration', async () => {
    accounts.list = [account({ blocked: true })];
    const v = view();
    expect(
      v.getByText(
        'mail.s1.test is no longer an approved server. You can sign in again once your administrator approves it. You can also remove the account.',
      ),
    ).toBeInTheDocument();
    const box = v.container.querySelector('.box') as HTMLElement;
    expect(within(box).queryByRole('button')).toBeNull();
    expect(rowButtons(v)).toEqual(['Check connection']);
    session.user = { ...ME, role: 'admin' };
    await tick();
    expect(within(box).getAllByRole('button')).toHaveLength(1);
    await fireEvent.click(v.getByRole('button', { name: 'Check mail servers' }));
    expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers');
  });

  it('shows only the status line after the return', () => {
    setRe({ step: 'ret' });
    const v = view();
    const status = v.getByRole('status');
    expect(status).toHaveTextContent('Finishing sign-in to mail.s1.test …');
    expect(status).toHaveTextContent('Roedy Mail is applying the new sign-in.');
    expect(within(v.container.querySelector('.box') as HTMLElement).queryByRole('button')).toBeNull();
    expect(rowButtons(v)).toEqual(['Check connection']);
    expect(v.queryByText(/on the sign-in page of/)).toBeNull();
  });

  it('reports success and closes the form after a short time with a toast', async () => {
    vi.useFakeTimers();
    setRe({ step: 'done', done: 'a1', as: 'account1@s1.test' });
    const v = view();
    const status = v.getByRole('status');
    expect(status).toHaveTextContent('Reconnected');
    expect(status).toHaveTextContent('Syncing messages from mail.s1.test.');
    expect(within(v.container.querySelector('.box') as HTMLElement).queryByRole('button')).toBeNull();
    await vi.advanceTimersByTimeAsync(1800);
    expect(mailLogin.re.form).toBeNull();
    expect(ui.toast?.text).toBe('Signed in to mail.s1.test');
    expect(v.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('shows nothing for an unknown account; the app layout leads to the list', async () => {
    accounts.list = null;
    const v = view('a9');
    accounts.list = [account()];
    await tick();
    expect(v.container.querySelector('.page')).toBeEmptyDOMElement();
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('closes the form when leaving the page', () => {
    setRe();
    const v = view();
    v.unmount();
    expect(mailLogin.re.form).toBeNull();
  });

  it('shows the field with a placeholder and the buttons stacked on mobile', async () => {
    mobile();
    const acct = account({ auth_kind: 'token' });
    accounts.list = [acct];
    setRe({}, acct);
    const v = view();
    const token = v.getByLabelText('Access token');
    expect(token).toHaveAttribute('placeholder', 'Access token');
    const buttons = within(v.container.querySelector('.acts') as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Connect', 'Cancel']);
    await fireEvent.click(buttons[1] as HTMLElement);
    expect(mailLogin.re.form).toBeNull();
  });
});

describe('page connection: facts, check and remove', () => {
  it('shows the facts box with "Mail server" from the server list', () => {
    mailLogin.servers = { servers: [VPS1], allow_custom_servers: false };
    const v = view();
    expect(facts(v)).toEqual([
      'Mail server: VPS 1 · mail.s1.test',
      'Base URL: https://mail.s1.test',
      'Username: account1@s1.test',
      'Sign-in method: Password',
    ]);
    expect(v.container.querySelector('.warn')).toBeNull();
  });

  it('warns with icon and tooltip for a server outside the list, also for a token without a user name', async () => {
    accounts.list = [account({ blocked: true, auth_kind: 'token' })];
    const v = view();
    expect(facts(v)).toEqual([
      'Mail server: mail.s1.test · not in the server list',
      'Base URL: https://mail.s1.test',
      'Sign-in method: Access token',
    ]);
    const warn = v.container.querySelector('.server .warn') as HTMLElement;
    expect(within(warn).getByRole('img', { name: 'This server is no longer approved' })).toBeInTheDocument();
    expect(await tipOf(warn)).toBe('This server is no longer approved');
  });

  it('shows "Sign in again" and "Check connection" in one row, with "Sign-in required" only "Check connection"', async () => {
    const v = view();
    expect(rowButtons(v)).toEqual(['Sign in again', 'Check connection']);
    accounts.list = [account({ state: 'needs_reauth' })];
    await tick();
    expect(rowButtons(v)).toEqual(['Check connection']);
    // The facts box sits above the open form too.
    expect(facts(v)[0]).toBe('Mail server: mail.s1.test');
  });

  it('checks the connection with `POST mail-accounts/:id/check` and shows "Checking" meanwhile', async () => {
    let answer: (reply: { body: MailAccount }) => void = () => {};
    mailLogin.servers = { servers: [VPS1], allow_custom_servers: false };
    const { calls } = mockApi({
      'POST mail-accounts/a1/check': [() => new Promise((resolve) => (answer = resolve))],
    });
    const v = view();
    await fireEvent.click(v.getByRole('button', { name: 'Check connection' }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST mail-accounts/a1/check']);
    const btn = v.getByRole('button', { name: 'Checking' });
    expect(btn).toHaveClass('busy');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn.querySelector('.rot')).toHaveStyle({ transform: 'rotate(720deg)' });
    // One check at a time.
    await fireEvent.click(btn);
    expect(calls).toHaveLength(1);
    answer({ body: account({ last_check_at: '2026-11-03T12:00:00Z' }) });
    await vi.waitFor(() => expect(v.getByRole('button', { name: 'Check connection' })).not.toHaveClass('busy'));
    expect(ui.toast?.text).toBe('Connection to mail.s1.test is OK');
  });

  it('offers "Remove account" and asks when removing', async () => {
    const v = view();
    expect(v.getByRole('heading', { level: 2, name: 'Remove account' })).toBeInTheDocument();
    expect(
      v.getByText('Removes the account from Roedy Mail. Messages and folders stay on the server.'),
    ).toBeInTheDocument();
    await fireEvent.click(v.getByRole('button', { name: 'Remove' }));
    expect(ui.confirm).toMatchObject({ title: 'Remove account1@s1.test?', ok: 'Remove', danger: true });
    expect(accounts.get('a1')).toBeDefined();
  });
});
