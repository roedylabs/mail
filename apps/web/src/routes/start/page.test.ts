import { render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberPage } from '#lib/last-page.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

type AfterNavigate = (navigation: { from: { url: URL | null } | null }) => void;
const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  after: null as (() => void) | null,
  /** Predecessor of the navigation in the app (`from`); `null` = full load, without a running navigation. */
  from: null as string | null,
}));
vi.mock('$app/state', () => ({
  navigating: {
    get to() {
      return nav.from === null ? null : { url: new URL('/start', 'https://mail.example.test') };
    },
  },
}));
vi.mock('$app/navigation', async () => {
  const { onMount } = await import('svelte');
  return {
    goto: nav.goto,
    // Like SvelteKit: after every navigation in the app (here `nav.after()`). After a full load the layout
    // only mounts the page once the app is ready: `enter` is over by then and nothing follows.
    afterNavigate: (fn: AfterNavigate) => {
      const run = () =>
        fn({ from: { url: nav.from === null ? null : new URL(nav.from, 'https://mail.example.test') } });
      nav.after = run;
      // SvelteKit only reports the navigation after mounting (after the page's effects).
      onMount(() => {
        if (nav.from !== null) void Promise.resolve().then(run);
      });
    },
  };
});

function account(id: string): MailAccount {
  return {
    id,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    url: 'https://mail.example.com',
    host: 'mail.example.com',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
  };
}

beforeEach(() => {
  accounts.reset();
  prefs.reset();
  prefs.loaded = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  nav.from = null;
  session.user = null;
  localStorage.clear();
  accounts.reset();
  prefs.reset();
  ui.reset();
});

describe('Start page', () => {
  it('leads to the inbox of the default account and replaces itself in the history', async () => {
    accounts.list = [account('a1'), account('a2')];
    prefs.values.defaultAccount = 'a2';
    render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a2/inbox', { replace: true }));
  });

  it('leads to the first account without a default, to all with “All accounts” as default', async () => {
    accounts.list = [account('a1'), account('a2')];
    const first = render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/a1/inbox', { replace: true }));
    first.unmount();
    prefs.values.defaultAccount = 'all';
    render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/all/inbox', { replace: true }));
  });

  it('shows the inbox of the only account even if “All accounts” is the default', async () => {
    accounts.list = [account('a1')];
    prefs.values.defaultAccount = 'all';
    render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox', { replace: true }));
  });

  it('opens the last page on entry with “Last opened page”, the inbox via the logo', async () => {
    accounts.list = [account('a1')];
    session.user = {
      id: 'u0',
      username: 'alex',
      email: 'alex@example.com',
      display_name: 'Alex',
      role: 'user',
      mfa_enabled: false,
      sole_admin: false,
      password_changed_at: '2026-10-25T10:00:00Z',
      email_change: null,
    };
    rememberPage('u0', { pathname: '/settings/general', search: '' });
    // Default "Inbox": the inbox on entry too.
    const inbox = render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox', { replace: true }));
    inbox.unmount();
    nav.goto.mockClear();

    prefs.values.gStart = 'last';
    nav.from = '/login';
    const entry = render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/settings/general', { replace: true }));
    // Not to the inbox first: the page waits until it knows the predecessor.
    expect(nav.goto).toHaveBeenCalledOnce();
    entry.unmount();
    nav.goto.mockClear();

    nav.from = '/mailbox/a1/inbox';
    render(Page);
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox', { replace: true }));
    expect(nav.goto).not.toHaveBeenCalledWith('/settings/general', expect.anything());
  });

  it('waits for the settings before redirecting', async () => {
    accounts.list = [account('a1'), account('a2')];
    prefs.loaded = false;
    const view = render(Page);
    await Promise.resolve();
    expect(nav.goto).not.toHaveBeenCalled();
    expect(view.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    prefs.values.defaultAccount = 'a2';
    prefs.loaded = true;
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a2/inbox', { replace: true }));
  });

  it('shows the skeleton until the accounts are there', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (answer = r))),
    );
    const view = render(Page);
    expect(view.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    // `afterNavigate` queries the accounts; it only runs after mounting.
    await waitFor(() => expect(answer).toBeDefined());
    answer(Response.json({ accounts: [account('a1')] }));
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox', { replace: true }));
  });

  it('shows “Nothing here yet” when the accounts do not load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: 'internal' }, { status: 500 }))),
    );
    const view = render(Page);
    expect(await view.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    expect(view.getByText('Content will appear here as soon as it’s available.')).toBeInTheDocument();
    expect(nav.goto).not.toHaveBeenCalled();
    // Also on a repeated visit when the layout no longer reports anything.
    expect(ui.toast).toMatchObject({ error: true });
    // A further visit (logo) tries again.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ accounts: [account('a1')] }))),
    );
    nav.after?.();
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox', { replace: true }));
  });
});
