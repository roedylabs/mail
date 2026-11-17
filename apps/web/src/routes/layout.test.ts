import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csp } from '#lib/csp.ts';
import { readStartCopy, saveStartCopy, type StartCopy } from '#lib/start-copy.ts';
import { swipe } from '#lib/test/pointer.ts';
import { mailPush } from '#lib/mail-push.svelte.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { compose } from '#lib/state/compose.svelte.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { mailStores } from '#lib/mail-store.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { network } from '#lib/state/network.svelte.ts';
import { notifications } from '#lib/state/notifications.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';
import { RESET0, prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session } from '#lib/state/session.svelte.ts';
import { tags } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Layout from './+layout.svelte';
import { LANG_KEY } from '#lib/locale.ts';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  after: null as ((navigation: { from: { url: URL | null } | null; to?: { url: URL } }) => void) | null,
  page: { url: new URL('http://localhost/'), status: 200, params: {} },
  updated: { current: false, check: vi.fn(() => Promise.resolve(false)) },
}));
vi.mock('$app/navigation', () => ({
  goto: nav.goto,
  afterNavigate: (fn: typeof nav.after) => (nav.after = fn),
  beforeNavigate: () => {},
}));
vi.mock('$app/state', () => ({ page: nav.page, updated: nav.updated }));
// The live sync has its own tests (`live.test.ts`); what counts here is for which accounts the layout starts it.
// For real it would send JMAP requests at startup that would use up the mailbox tests' responses.
const liveRetain = vi.hoisted(() => vi.fn());
const liveReconnect = vi.hoisted(() => vi.fn());
vi.mock('#lib/state/live.svelte.ts', () => ({
  live: { retain: liveRetain, reconnect: liveReconnect, reset: vi.fn(), syncing: false },
}));
// Likewise the "Scheduled" sync (`scheduled.test.ts`): it starts for the same accounts as the live sync.
const scheduledRetain = vi.hoisted(() => vi.fn());
vi.mock('#lib/state/scheduled.svelte.ts', () => ({
  scheduled: { retain: scheduledRetain, reset: vi.fn(), touch: vi.fn(), sendAt: () => undefined },
}));

const CONFIG = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: {},
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
};

const SETTINGS = { version: 1, settings: { ...RESET0, tzAuto: false } };
const NO_ACCOUNTS = { accounts: [] };
const ACCOUNT = {
  id: 'a1',
  email: 'account1@s1.test',
  url: 'https://s1.test',
  host: 's1.test',
  server_id: 's1',
  auth_kind: 'oauth',
  color: 2,
  state: 'needs_reauth',
  blocked: false,
  quota_used: null,
  quota_total: null,
  last_check_at: null,
  created_at: '2026-10-27T10:00:00Z',
};

const me = (role: 'admin' | 'user', extra: Record<string, unknown> = {}) => ({
  id: '01J',
  username: 'alex',
  email: 'alex@example.org',
  display_name: 'Alex Example',
  role,
  mfa_enabled: false,
  password_changed_at: '2026-10-25T10:00:00Z',
  email_change: null,
  ...extra,
});

const content = createRawSnippet(() => ({ render: () => '<p>Page content</p>' }));
/** Dialog of a page (`ui.pageDialog`); shows whether the layout renders it for desktop or mobile. */
const dialog = createRawSnippet((isMobile: () => boolean) => ({
  render: () => `<div class="page-dialog">${isMobile() ? 'Content in the sheet' : 'Dialog above the shell'}</div>`,
}));

/** Renders the layout at an address; navigation and address are mocks. */
/** The sync pill (folder tree and tag list also have `.pill`, but without `role`). */
const SYNC_PILL = '.pill[role="status"]';

function renderAt(path: string) {
  nav.page.url = new URL(`http://localhost${path}`);
  // `go()` compares with the browser's address.
  history.replaceState(null, '', path);
  const view = render(Layout, { children: content, data: {}, params: {} } as never);
  return { ...view, goto: nav.goto };
}

afterEach(() => {
  liveRetain.mockClear();
  liveReconnect.mockClear();
  scheduledRetain.mockClear();
  vi.unstubAllGlobals();
  // Whatever still finishes after the test (e.g. loading behind the token provider's lock) does not hit the network.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('Test finished')));
  // Reset the width after the tests' `innerWidth` mocks (svelte/reactivity/window reads it on resize).
  window.dispatchEvent(new Event('resize'));
  vi.useRealTimers();
  nav.goto.mockClear();
  // State modules are singletons: reset them for the next test.
  session.config = null;
  session.user = null;
  session.status = 'idle';
  session.failure = null;
  prefs.reset();
  accounts.reset();
  mailboxes.reset();
  tags.reset();
  notifications.reset();
  ui.splash = 'on';
  ui.reset();
  ui.navigated = false;
  ui.tip = null;
  ui.syncing = false;
  ui.readError = false;
  csp.stale = false;
  session.fromCopy = false;
  nav.updated.current = false;
  localStorage.clear();
  // Remove theme attributes and logo plate from <html>.
  const root = document.documentElement;
  for (const key of Object.keys(root.dataset)) delete root.dataset[key];
  root.removeAttribute('style');
});

describe('Start without network', () => {
  const copy = {
    config: CONFIG,
    user: me('user'),
    accounts: [{ id: 'a1', email: 'a@example.test', color: 0, state: 'ok', blocked: false }],
    settings: { version: 3, settings: { ...RESET0, gStart: 'last' } },
  } as unknown as StartCopy;
  const offline = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );

  it('shows the app from the copy instead of the error page', async () => {
    saveStartCopy(copy);
    offline();
    const { container } = renderAt('/account/profile');
    await vi.waitFor(() => expect(session.fromCopy).toBe(true));
    await vi.waitFor(() => expect(accounts.list).toHaveLength(1));
    expect(prefs.values.gStart).toBe('last');
    expect(container.querySelector('.bare')).toBeNull();
    expect(ui.toast).toBeNull();
  });

  it('keeps the copy while it applies and deletes it with the session', async () => {
    saveStartCopy(copy);
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    renderAt('/login');
    await vi.waitFor(() => expect(session.status).toBe('ready'));
    await vi.waitFor(() => expect(readStartCopy()).toBeNull());
  });

  it('deletes the mail storage with the session, but not when starting from the copy', async () => {
    const drop = vi.spyOn(mailStores, 'dropAll');
    saveStartCopy(copy);
    offline();
    renderAt('/account/profile');
    await vi.waitFor(() => expect(session.fromCopy).toBe(true));
    expect(drop).not.toHaveBeenCalled();
    drop.mockRestore();
  });

  it('deletes the mail storage when the session has ended', async () => {
    const drop = vi.spyOn(mailStores, 'dropAll');
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    renderAt('/login');
    await vi.waitFor(() => expect(drop).toHaveBeenCalled());
    drop.mockRestore();
  });

  it('discards accounts and settings of the copy if the session ended in the meantime', async () => {
    saveStartCopy(copy);
    offline();
    renderAt('/account/profile');
    await vi.waitFor(() => expect(session.fromCopy).toBe(true));
    await vi.waitFor(() => expect(accounts.list).toHaveLength(1));
    vi.unstubAllGlobals();
    mockApi({
      'GET public/config': [{ body: CONFIG }, { body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    network.simulate(true);
    network.simulate(false);
    await vi.waitFor(() => expect(accounts.list).toBeNull());
    expect(prefs.loaded).toBe(false);
    expect(session.fromCopy).toBe(false);
  });

  it('stores the server state for the next start', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { version: 2, settings: { gStart: 'last' } } }],
      'GET mail-accounts': [{ body: { accounts: [] } }],
    });
    renderAt('/no-account');
    await vi.waitFor(() => expect(readStartCopy()?.user.id).toBe(me('user').id));
    expect(readStartCopy()?.settings.version).toBe(2);
  });

  it('fetches the server state after an offline phase', async () => {
    saveStartCopy(copy);
    offline();
    renderAt('/account/profile');
    await vi.waitFor(() => expect(session.fromCopy).toBe(true));
    vi.unstubAllGlobals();
    const { calls } = mockApi({
      // `watchConfig` also asks again after an offline phase.
      'GET public/config': [{ body: CONFIG }, { body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { version: 9, settings: {} } }],
      'GET mail-accounts': [{ body: { accounts: [] } }],
    });
    network.simulate(true);
    network.simulate(false);
    await vi.waitFor(() => expect(session.fromCopy).toBe(false));
    await vi.waitFor(() => expect(calls.some((c) => c.path === 'mail-accounts')).toBe(true));
    await vi.waitFor(() => expect(accounts.list).toEqual([]));
    expect(liveReconnect).toHaveBeenCalled();
  });
});

describe('New version', () => {
  function started() {
    mockApi({ 'GET public/config': [{ body: { ...CONFIG, setup_required: true } }] });
    const reload = vi.spyOn(csp, 'reload').mockImplementation(() => {});
    renderAt('/setup');
    return reload;
  }

  it('reloads after the next navigation', () => {
    const reload = started();
    nav.after?.({ from: { url: new URL('http://localhost/a') }, to: { url: new URL('http://localhost/b') } });
    expect(reload).not.toHaveBeenCalled();
    nav.updated.current = true;
    nav.after?.({ from: { url: new URL('http://localhost/a') }, to: { url: new URL('http://localhost/b') } });
    expect(reload).toHaveBeenCalledOnce();
    reload.mockRestore();
  });

  it('leaves leaving compose alone, the draft is being saved there', () => {
    const reload = started();
    nav.updated.current = true;
    nav.after?.({
      from: { url: new URL('http://localhost/compose/new') },
      to: { url: new URL('http://localhost/start') },
    });
    expect(reload).not.toHaveBeenCalled();
    reload.mockRestore();
  });

  it('leaves a just opened compose alone', () => {
    const reload = started();
    nav.updated.current = true;
    nav.after?.({
      from: { url: new URL('http://localhost/a') },
      to: { url: new URL('http://localhost/compose/new') },
    });
    expect(reload).not.toHaveBeenCalled();
    reload.mockRestore();
  });
});

describe('Shell layout', () => {
  it('syncs after an offline phase and loads the configuration until it is torn down', async () => {
    const { calls } = mockApi({ 'GET public/config': [{ body: { ...CONFIG, setup_required: true } }] });
    const { goto, unmount } = renderAt('/start');
    await vi.waitFor(() => expect(goto).toHaveBeenCalled());
    const configs = () => calls.filter((c) => c.path === 'public/config').length;
    expect(configs()).toBe(1);

    network.simulate(true);
    network.simulate(false);
    expect(liveReconnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(configs()).toBe(2));

    unmount();
    network.simulate(true);
    network.simulate(false);
    expect(liveReconnect).toHaveBeenCalledTimes(1);
    expect(configs()).toBe(2);
  });

  it('redirects to setup without an administrator', async () => {
    mockApi({ 'GET public/config': [{ body: { ...CONFIG, setup_required: true } }] });
    const { goto, queryByText } = renderAt('/start');
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/setup', { replace: true }));
    expect(queryByText('Page content')).toBeNull();
  });

  it('shows header, content and the theme from the settings when signed in', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: { version: 1, settings: { ...RESET0, mode: 'light', tzAuto: false } } }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, container } = renderAt('/no-account');
    expect(await findByText('Page content')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Administration' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Alex Example' })).toHaveTextContent('AE');
    // The settings arrive after the session, still below the splash screen.
    await vi.waitFor(() => expect(document.documentElement.dataset.mode).toBe('light'));
    await vi.waitFor(() => expect(ui.splash).not.toBe('on'));
    // Without a mail account the sidebar and its switch stay away (`noAcctV`).
    expect(container.querySelector('nav.sidebar')).toHaveClass('hidden');
    expect(container.querySelector('[aria-label="Show or hide sidebar"]')).toBeNull();
  });

  it('shows no administration to users without admin rights', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { version: 1, settings: { ...RESET0, tzAuto: false } } }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, queryByRole, queryByText, container } = renderAt('/admin/users');
    expect(await findByText('Access denied')).toBeInTheDocument();
    expect(queryByText('Page content')).toBeNull();
    // In the main view (content card), not in the settings view.
    expect(container.querySelector('main.card:not(.scroll)')).toHaveTextContent('Access denied');
    expect(queryByRole('button', { name: 'Administration' })).toBeNull();
  });

  it('shows “No account” instead of the start page without a mail account', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { goto, queryByText } = renderAt('/start');
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/no-account', { replace: true }));
    expect(queryByText('Page content')).toBeNull();
  });

  it('stores quiet hours and accounts for the service worker and follows changes', async () => {
    const share = vi.spyOn(mailPush, 'share');
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    renderAt('/start');
    await vi.waitFor(() =>
      expect(share).toHaveBeenLastCalledWith({
        user: '01J',
        quiet: { on: RESET0.nQuiet, from: RESET0.nFrom, to: RESET0.nTo, tz: RESET0.tz },
        accounts: { a1: 'account1@s1.test' },
        appName: 'Roedy Mail',
        lang: 'en',
      }),
    );
    prefs.set({ nFrom: '21:15' });
    await tick();
    expect(share.mock.lastCall?.[0].quiet.from).toBe('21:15');
    share.mockRestore();
  });

  it('sets `<html lang>` from the account language and remembers it for the login', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { ...SETTINGS, settings: { ...SETTINGS.settings, lang: 'de' } } }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    renderAt('/start');
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('de'));
    expect(localStorage.getItem(LANG_KEY)).toBe('de');
    prefs.set({ lang: 'en' });
    await tick();
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    localStorage.removeItem(LANG_KEY);
  });

  it('shows the sidebar with the account with a mail account and stays on the start page', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { goto, findByText, container } = renderAt('/start');
    expect(await findByText('Page content')).toBeTruthy();
    expect(await findByText('account1@s1.test')).toBeTruthy();
    expect(container.querySelector('.acct-title')?.textContent).toBe('account1');
    // "Sign-in required" as a dot on the tile.
    expect(container.querySelector('.warn')).not.toBeNull();
    expect(goto).not.toHaveBeenCalledWith('/no-account', { replace: true });
    // "Sign-in required": no live sync for the account.
    expect(liveRetain).toHaveBeenLastCalledWith([]);
    expect(scheduledRetain).toHaveBeenLastCalledWith([]);
  });

  it('opens “New email” with C, from the palette and the sidebar with the view account', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { goto, findByText, getByRole } = renderAt('/start');
    await findByText('account1@s1.test');
    await fireEvent.keyDown(window, { key: 'c' });
    expect(goto).toHaveBeenLastCalledWith('/compose/new');
    expect(compose.current).toMatchObject({ account: ACCOUNT.id, ret: { href: '/start', label: 'Back' } });
    compose.reset();
    await fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await fireEvent.click(within(getByRole('dialog', { name: 'Command palette' })).getByText('New email'));
    expect(compose.current?.account).toBe(ACCOUNT.id);
    compose.reset();
    goto.mockClear();
    await fireEvent.click(getByRole('button', { name: 'New email' }));
    expect(goto).toHaveBeenCalledWith('/compose/new');
    compose.reset();
  });

  it('closes compose on desktop with Escape, the “Send as” menu first', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { goto, findByText } = renderAt('/compose/new');
    await findByText('account1@s1.test');
    compose.start({}, { href: '/start', label: 'Back' });
    compose.toggleFrom();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(compose.current?.menu).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => expect(compose.current).toBeNull());
    expect(goto).toHaveBeenLastCalledWith('/start');
  });

  it('reports failed loading of the mail accounts and does not redirect to “No account”', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ status: 500, body: { error: 'internal' } }],
    });
    const { goto, findByText } = renderAt('/start');
    expect(await findByText('Page content')).toBeTruthy();
    await vi.waitFor(() => expect(ui.toast?.text).toBeTruthy());
    expect(accounts.count).toBeNull();
    expect(goto).not.toHaveBeenCalledWith('/no-account', { replace: true });
  });

  it('shows “No connection” when the server does not answer and reloads with “Try again”', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetch);
    const { findByRole, getByRole, findByText } = renderAt('/no-account');
    expect(await findByRole('heading', { name: 'No connection' })).toBeInTheDocument();
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    // The error page stays until the response is there.
    expect(getByRole('button', { name: 'Loading' })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(900);
    expect(await findByText('Page content')).toBeInTheDocument();
  });

  it('shows “Something went wrong” when the server answers with an error', async () => {
    mockApi({ 'GET public/config': [{ status: 502, body: {} }] });
    const { findByRole } = renderAt('/no-account');
    expect(await findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
  });

  it('shows guest pages without header', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const { findByText, queryByRole, goto } = renderAt('/login');
    expect(await findByText('Page content')).toBeInTheDocument();
    expect(queryByRole('combobox')).toBeNull();
    expect(goto).not.toHaveBeenCalled();
  });

  it('shows “Forgot password” without header also when signed in', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { version: 1, settings: { ...RESET0, tzAuto: false } } }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, queryByRole, goto } = renderAt('/password/forgot');
    expect(await findByText('Page content')).toBeInTheDocument();
    expect(queryByRole('combobox')).toBeNull();
    expect(goto).not.toHaveBeenCalled();
  });

  it('shows administrators maintenance mode and missing system emails', async () => {
    mockApi({
      'GET public/config': [{ body: { ...CONFIG, maintenance: { on: true, message: null } } }],
      'GET auth/me': [{ body: me('admin', { system_mail_configured: false }) }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByText, goto } = renderAt('/no-account');
    expect(await findByText('Maintenance mode')).toBeInTheDocument();
    expect(queryByText('System emails not set up')).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Manage' }));
    expect(goto).toHaveBeenCalledWith('/admin/maintenance');
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(queryByText('System emails not set up')).toBeNull();
  });

  it('shows no administration banners to users without admin rights', async () => {
    mockApi({
      'GET public/config': [{ body: { ...CONFIG, maintenance: { on: true, message: null } } }],
      'GET auth/me': [{ body: me('user', { system_mail_configured: false }) }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, queryByText } = renderAt('/no-account');
    expect(await findByText('Page content')).toBeInTheDocument();
    expect(queryByText('Maintenance mode')).toBeNull();
    expect(queryByText('System emails not set up')).toBeNull();
  });

  it('shows the custom banner to everyone; closing remembers the revision, the link opens a new tab', async () => {
    const banner = {
      title: 'Maintenance on Saturday',
      text: 'From 8 to 10 am',
      link: 'https://example.com/status',
      linkLabel: 'Status',
      tone: 'dark',
      icon: 'ti-calendar-event',
      closable: true,
      revision: 4,
    };
    const api = mockApi({
      'GET public/config': [{ body: { ...CONFIG, banner } }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'PUT settings': [{ body: { version: 2, settings: { ...SETTINGS.settings, bannerDismissedRev: 4 } } }],
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { findByText, getByRole, queryByText } = renderAt('/no-account');
    expect(await findByText('Maintenance on Saturday')).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Status' }));
    expect(open).toHaveBeenCalledWith('https://example.com/status', '_blank', 'noopener');
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(queryByText('Maintenance on Saturday')).toBeNull();
    await prefs.settled();
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === 'settings')?.body).toMatchObject({
      settings: { bannerDismissedRev: 4 },
    });
    open.mockRestore();
  });

  it('hides a banner closed in this revision (bannerDismissedRev)', async () => {
    mockApi({
      'GET public/config': [
        {
          body: {
            ...CONFIG,
            banner: {
              title: 'Old',
              text: '',
              link: '',
              linkLabel: '',
              tone: 'soft',
              icon: 'ti-info-circle',
              closable: true,
              revision: 2,
            },
          },
        },
      ],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { ...SETTINGS, settings: { ...SETTINGS.settings, bannerDismissedRev: 2 } } }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, queryByText } = renderAt('/no-account');
    expect(await findByText('Page content')).toBeInTheDocument();
    await vi.waitFor(() => expect(queryByText('Old')).toBeNull());
  });

  it('header filter button: opens the search suggestions in filter mode, the panel on the search', async () => {
    search.reset();
    const api = () =>
      mockApi({
        'GET public/config': [{ body: CONFIG }],
        'GET auth/me': [{ body: me('user') }],
        'GET settings': [{ body: SETTINGS }],
        'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      });
    api();
    const away = renderAt('/no-account');
    await away.findByText('Page content');
    search.panelHidden = true;
    const filter = away.getByRole('button', { name: 'Filters' });
    await fireEvent.click(filter);
    // Outside the search: suggestions with quick filters and "Browse", without switching to the search.
    expect(away.goto).not.toHaveBeenCalled();
    expect([ui.menu, search.scope, search.panelHidden]).toEqual(['results', 'all', true]);
    const pop = await away.findByRole('dialog', { name: 'Search' });
    expect(within(pop).getByRole('group', { name: 'Quick filters' })).toBeInTheDocument();
    expect(within(pop).getByRole('group', { name: 'Browse' })).toBeInTheDocument();
    expect(filter).toHaveAttribute('aria-expanded', 'true');
    expect(filter).toHaveClass('fill');
    // Once more: closed.
    await fireEvent.click(filter);
    expect(ui.menu).toBeNull();
    expect(away.queryByRole('dialog', { name: 'Search' })).toBeNull();
    expect(filter).not.toHaveClass('fill');
    away.unmount();
    api();
    const here = renderAt('/search');
    await here.findByText('Page content');
    const btn = here.getByRole('button', { name: 'Filters' });
    // The panel is hidden from before; the button shows and hides it again.
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(btn);
    expect([search.panelHidden, search.panelShown]).toEqual([false, true]);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.click(btn);
    expect([search.panelHidden, search.panelShown]).toEqual([true, false]);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    // Overlaid without room; Escape closes the overlay.
    vi.stubGlobal('innerWidth', 900);
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(search.dock).toBe(false));
    await fireEvent.click(btn);
    expect(search.panelOverlaid).toBe(true);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(search.panelOverlaid).toBe(false);
    search.reset();
  });

  it('opens shortcuts and command palette by keyboard, without ⇧M for users', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByRole, queryByText, goto } = renderAt('/no-account');
    await findByText('Page content');
    await fireEvent.keyDown(window, { key: '?' });
    expect(getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(queryByText('Manage mail servers')).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(queryByText('Administration')).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    // A typed character opens the palette with the search first.
    await fireEvent.keyDown(window, { key: 'z' });
    expect(getByRole('combobox', { name: 'Search' })).toBeInTheDocument();
    expect(queryByText('Search Roedy Mail for “z”')).toBeInTheDocument();
    await fireEvent.keyDown(getByRole('textbox', { name: 'Command palette' }), { key: 'Enter' });
    expect(goto).toHaveBeenCalledWith('/search');
    expect(queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(getByRole('combobox', { name: 'Search' })).toHaveValue('z');
    // ⇧M has no effect for users without admin rights.
    goto.mockClear();
    await fireEvent.keyDown(window, { key: 'M', shiftKey: true });
    expect(goto).not.toHaveBeenCalled();
    expect(queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    await fireEvent.keyDown(window, { key: ',' });
    expect(goto).toHaveBeenCalledWith('/settings/appearance');
  });

  it('reports “New email” without a mail account and switches the theme from the palette', async () => {
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'PUT settings': [{ body: { version: 2, settings: { ...SETTINGS.settings, mode: 'light' } } }],
    });
    const { findByText, getByText } = renderAt('/no-account');
    await findByText('Page content');
    await fireEvent.keyDown(window, { key: 'c' });
    expect(getByText('Connect an email account first')).toBeInTheDocument();
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    await fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(getByText('Manage mail servers')).toBeInTheDocument();
    await fireEvent.click(getByText('Switch to light theme'));
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: 'settings' }));
    expect(calls.at(-1)?.body).toEqual({ version: 1, settings: { mode: 'light' } });
  });

  it('reports failed saving of the settings with an error toast', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'PUT settings': [{ status: 422, body: { error: 'invalid' } }],
    });
    const { findByText, findByRole } = renderAt('/no-account');
    await findByText('Page content');
    // The settings load after the session.
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    prefs.set({ mode: 'light' });
    expect(await findByRole('alert')).toHaveTextContent('Change not saved. Please try again.');
    expect(ui.toast).toMatchObject({ error: true, undo: false });
    expect(prefs.values.mode).toBeNull();
  });

  it('reports a failed sign-out with an error toast and stays signed in', async () => {
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'POST auth/logout': [{ status: 500, body: { error: 'internal' } }],
    });
    const { findByText, getByRole, findByRole, goto } = renderAt('/no-account');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    await fireEvent.click(getByRole('button', { name: 'Alex Example' }));
    await fireEvent.click(getByRole('button', { name: 'Sign out' }));
    expect(await findByRole('alert')).toHaveTextContent('Couldn’t sign out. Check your connection and try again.');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST auth/logout');
    expect(session.user).not.toBeNull();
    expect(goto).not.toHaveBeenCalledWith('/login', expect.anything());
  });

  it('opens apps and account menu on desktop and signs out', async () => {
    let saved!: () => void;
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }, { status: 401, body: { error: 'unauthorized' } }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      // Response only when the test calls `saved()`.
      'PUT settings': [
        () =>
          new Promise((resolve) => {
            saved = () => resolve({ body: { version: 2, settings: { ...SETTINGS.settings, mode: 'light' } } });
          }),
      ],
      'POST auth/logout': [{ status: 204 }],
    });
    const { findByText, getByRole, queryByRole, goto } = renderAt('/no-account');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    await fireEvent.click(getByRole('button', { name: 'Apps' }));
    expect(getByRole('menu', { name: 'Apps' })).toBeInTheDocument();
    // A click outside closes the popover.
    await fireEvent.mouseDown(document.body);
    expect(queryByRole('menu', { name: 'Apps' })).toBeNull();
    await fireEvent.input(getByRole('combobox', { name: 'Search' }), { target: { value: 'Private' } });
    await fireEvent.click(getByRole('button', { name: 'Alex Example' }));
    expect(getByRole('group', { name: 'Alex Example' })).toHaveTextContent('alex@example.org');
    // "Light" and right after "Sign out": sign-out only happens once the setting is saved.
    await fireEvent.click(getByRole('radio', { name: 'Light' }));
    await fireEvent.click(getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain('settings'));
    expect(calls.map((c) => c.path)).not.toContain('auth/logout');
    saved();
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/login', { replace: true }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST auth/logout');
    expect(session.authed).toBe(false);
    expect(prefs.remote).toBe(false);
  });

  it('shows the new notifications on the bell and opens their target', async () => {
    const note = (id: string, over: Record<string, unknown>) => ({
      id,
      topic: 'team',
      kind: 'team.role',
      icon: 'ti-user-cog',
      title: 'Role changed',
      text: 'Anna Becker is now an administrator.',
      target: { view: 'admin', page: 'users', path: '/admin/users', user_id: 'u2' },
      created_at: new Date().toISOString(),
      read_at: null,
      ...over,
    });
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'GET notifications': Array.from({ length: 3 }, () => ({
        body: {
          notifications: [
            note('n1', {}),
            note('n2', {
              topic: 'news',
              kind: 'news.welcome',
              icon: 'ti-sparkles',
              title: 'Welcome',
              text: '',
              target: null,
            }),
          ],
          unread: 2,
        },
      })),
      'POST notifications/read': [{ body: { unread: 1 } }],
    });
    const { findByRole, getByRole, getByText, queryByRole, goto } = renderAt('/no-account');
    const bell = await findByRole('button', { name: 'Notifications, 2 new' });
    expect(bell.parentElement).toHaveTextContent('2');
    await fireEvent.click(bell);
    // Counter in the header only with the number, "‹n› new" for screen readers.
    const pop = getByRole('dialog', { name: 'Notifications' });
    expect(within(pop).getByRole('img', { name: '2 new' })).toHaveTextContent(/^2$/);
    // Without a target the popup stays open, the entry is read.
    await fireEvent.click(getByText('Welcome'));
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ path: 'notifications/read', body: { ids: ['n2'] } }));
    expect(within(pop).getByRole('img', { name: '1 new' })).toHaveTextContent(/^1$/);
    expect(getByRole('button', { name: 'Notifications, 1 new' })).toBeInTheDocument();
    // Team opens the row under Administration › Users.
    await fireEvent.click(getByText('Role changed'));
    expect(goto).toHaveBeenCalledWith('/admin/users');
    expect(ui.userOpen).toBe('u2');
    expect(queryByRole('dialog', { name: 'Notifications' })).toBeNull();
  });

  it('opens the bell as a sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [
        { body: { ...SETTINGS, settings: { ...SETTINGS.settings, nCh: { app: false, mail: true, push: false } } } },
      ],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'GET notifications': [{ body: { notifications: [], unread: 0 } }, { body: { notifications: [], unread: 0 } }],
    });
    const { findByText, getByRole } = renderAt('/no-account');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    await fireEvent.click(getByRole('button', { name: 'Notifications' }));
    const sheet = getByRole('dialog', { name: 'Notifications' });
    expect(sheet).toHaveTextContent('Turned off in the app');
    vi.stubGlobal('innerWidth', 1024);
    window.dispatchEvent(new Event('resize'));
  });

  it('reloads the bell after a language switch once it is saved', async () => {
    const empty = { body: { notifications: [], unread: 0 } };
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'GET notifications': [empty, empty],
      'PUT settings': [{ body: { version: 2, settings: { ...SETTINGS.settings, lang: 'de' } } }],
    });
    const { findByText } = renderAt('/no-account');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'notifications')).toHaveLength(1));
    prefs.set({ lang: 'de' });
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'notifications')).toHaveLength(2));
    const put = calls.findIndex((c) => c.method === 'PUT' && c.path === 'settings');
    expect(calls.findLastIndex((c) => c.path === 'notifications')).toBeGreaterThan(put);
  });

  it('opens account menu and apps as a sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByRole } = renderAt('/settings/appearance');
    await findByText('Page content');
    expect(ui.isMobile).toBe(true);
    ui.menu = 'account';
    await vi.waitFor(() => expect(getByRole('dialog', { name: 'Alex Example' })).toBeInTheDocument());
    expect(getByRole('button', { name: 'Manage account' })).toBeInTheDocument();
    ui.menu = 'apps';
    await vi.waitFor(() => expect(getByRole('dialog', { name: 'Apps' })).toBeInTheDocument());
    await fireEvent.click(getByRole('button', { name: 'Mail' }));
    expect(queryByRole('dialog')).toBeNull();
    vi.stubGlobal('innerWidth', 1024);
    window.dispatchEvent(new Event('resize'));
  });

  it('shows the sync pill on mobile in the page area below the header, not above the sheets', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { findByText, getByRole, container } = renderAt('/start');
    await findByText('Page content');
    expect(container.querySelector(SYNC_PILL)).toBeNull();
    ui.syncing = true;
    await vi.waitFor(() => expect(container.querySelector(SYNC_PILL)).not.toBeNull());
    // Same level as the header: the pill lies in `.page` (below the notice bar) behind it.
    const pill = container.querySelector(SYNC_PILL)!;
    expect(pill).toHaveClass('mobile');
    expect(pill.parentElement).toHaveClass('page');
    const header = pill.parentElement!.querySelector(':scope > header.mobile')!;
    expect(header.compareDocumentPosition(pill)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    ui.menu = 'account';
    const sheet = await vi.waitFor(() => getByRole('dialog', { name: 'Alex Example' }));
    expect(sheet.closest('.page')).toBeNull();
    expect(container.querySelectorAll(SYNC_PILL)).toHaveLength(1);
  });

  it('writes navigations to the session log, but not the app start and the same path', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { findByText } = renderAt('/start');
    await findByText('Page content');
    devLog.clear();
    const url = (path: string) => new URL(path, 'http://localhost');
    nav.after!({ from: { url: null }, to: { url: url('/start') } });
    nav.after!({ from: { url: url('/start') }, to: { url: url('/start') } });
    expect(devLog.entries).toEqual([]);
    nav.after!({ from: { url: url('/start') }, to: { url: url('/admin/maintenance') } });
    expect(devLog.entries.map((entry) => entry.msg)).toEqual(['Navigation › /admin/maintenance']);
  });

  it('reloads on the next navigation after a change of the registry (CSP)', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const reload = vi.spyOn(csp, 'reload').mockImplementation(() => {});
    try {
      const { findByText } = renderAt('/start');
      await findByText('Page content');
      // The app start does not count as a navigation; the error page's "Back" needs a real history.
      nav.after!({ from: { url: null } });
      expect(ui.navigated).toBe(false);
      const from = { url: new URL('http://localhost/admin/mail-servers') };
      // Without a change it stays a navigation within the app.
      nav.after!({ from });
      expect(reload).not.toHaveBeenCalled();
      // A block of another kind (e.g. an image) changes nothing.
      document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'img-src' }));
      expect(csp.stale).toBe(false);
      // If the CSP blocks a fetch (registry changed in another tab), the next navigation reloads.
      document.dispatchEvent(
        Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'connect-src' }),
      );
      expect(csp.stale).toBe(true);
      // First visit of the page (in the SPA with `from.url === null`): no reload, no error.
      nav.after!({ from: { url: null } });
      expect(reload).not.toHaveBeenCalled();
      // After the navigation (history, `replace` and abort as in the app) the reached page reloads.
      nav.after!({ from });
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      reload.mockRestore();
    }
  });

  it('shows header and tab bar in the mobile reading view only for an error page (mRdOff)', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { findByText, container } = renderAt('/mailbox/a1/inbox/x1');
    await findByText('Page content');
    // The reading view has its own header.
    expect(container.querySelector('header.mobile')).toBeNull();
    expect(container.querySelector('nav.tabbar')).toBeNull();
    // An error page (e.g. 404) shows them with header and tab bar.
    ui.readError = true;
    await vi.waitFor(() => expect(container.querySelector('header.mobile')).not.toBeNull());
    expect(container.querySelector('nav.tabbar')).not.toBeNull();
  });

  it('shows the sync pill on mobile in the page area also on pages with a back bar', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNT] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    const { findByText, container } = renderAt('/settings/appearance');
    await findByText('Page content');
    ui.syncing = true;
    await vi.waitFor(() => expect(container.querySelector(SYNC_PILL)).not.toBeNull());
    const pill = container.querySelector(SYNC_PILL)!;
    expect(pill.parentElement).toHaveClass('page');
    const back = pill.parentElement!.querySelector(':scope > .m-back')!;
    expect(back.compareDocumentPosition(pill)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows the settings navigation in administration and toggles “Advanced settings”', async () => {
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'PUT settings': [
        { body: { version: 2, settings: { ...SETTINGS.settings, advanced: true } } },
        { body: { version: 3, settings: { ...SETTINGS.settings, advanced: false } } },
      ],
    });
    const { findByText, getByRole, queryByRole, goto } = renderAt('/admin/developer');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.remote).toBe(true));
    expect(getByRole('navigation', { name: 'Administration' })).toBeInTheDocument();
    // "Developer" is only in the navigation with "Advanced settings".
    expect(queryByRole('button', { name: 'Developer' })).toBeNull();
    await fireEvent.click(getByRole('switch', { name: 'Advanced settings' }));
    expect(getByRole('button', { name: 'Developer' })).toHaveAttribute('aria-current', 'page');
    // The active entry replaces the history entry instead of duplicating it.
    await fireEvent.click(getByRole('button', { name: 'Developer' }));
    expect(goto).toHaveBeenLastCalledWith('/admin/developer', { replace: true });
    await fireEvent.click(getByRole('button', { name: 'Organization' }));
    expect(goto).toHaveBeenLastCalledWith('/admin/organization');
    // Off: away from "Developer" to the first administration page.
    await fireEvent.click(getByRole('switch', { name: 'Advanced settings' }));
    expect(goto).toHaveBeenCalledWith('/admin/users');
    await fireEvent.click(getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(goto).toHaveBeenLastCalledWith('/start');
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ settings: { advanced: true } });
  });

  it('replaces the history entry on a click on the active settings entry', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, goto } = renderAt('/account/security');
    await findByText('Page content');
    await fireEvent.click(getByRole('button', { name: 'Security' }));
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenLastCalledWith('/account/security', { replace: true });
    // Another address (here with a query): new entry like for a link.
    history.replaceState(null, '', '/account/security?x=1');
    await fireEvent.click(getByRole('button', { name: 'Security' }));
    expect(goto).toHaveBeenLastCalledWith('/account/security');
    // After shallow navigation `page.url` stays unchanged; the browser's address is what counts.
    nav.page.url = new URL('http://localhost/account/profile');
    history.replaceState(null, '', '/account/security');
    await fireEvent.click(getByRole('button', { name: 'Security' }));
    expect(goto).toHaveBeenLastCalledWith('/account/security', { replace: true });
  });

  it('collapses the settings navigation with the sidebar', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, container } = renderAt('/account/security');
    await findByText('Page content');
    expect(getByRole('navigation', { name: 'Settings' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Security' })).toHaveAttribute('aria-current', 'page');
    expect(container.querySelector('[role="switch"]')).toBeNull();
    ui.collapsed = true;
    await vi.waitFor(() => expect(container.querySelector('aside.nav')).toHaveClass('collapsed'));
  });

  describe('return path to the search', () => {
    /** A hit of the results page (`results`) or the mobile search (`search`) opened `path`. */
    function openedFromSearch(kind: 'search' | 'results', path: string) {
      search.reset();
      search.q = 'invoice';
      search.set({ st: ['u'] });
      search.expectReturn(kind);
      search.done();
      search.navigating(path, true);
    }

    afterEach(() => search.reset());

    it('desktop: the settings navigation leads back to the search results', async () => {
      mockApi({
        'GET public/config': [{ body: CONFIG }],
        'GET auth/me': [{ body: me('user') }],
        'GET settings': [{ body: SETTINGS }],
        'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      });
      openedFromSearch('results', '/account/security');
      const { findByText, getByRole, goto } = renderAt('/account/security');
      await findByText('Page content');
      await fireEvent.click(getByRole('button', { name: 'Back to search results' }));
      expect(goto).toHaveBeenLastCalledWith('/search');
      expect([search.q, search.sf.st, search.ret]).toEqual(['invoice', ['u'], null]);
      // Used up: the next "Back" leads to the app again.
      await vi.waitFor(() => expect(getByRole('button', { name: 'Back to Roedy Mail' })).toBeInTheDocument());
    });

    it('desktop: no way back to the search on another page than the opened one', async () => {
      mockApi({
        'GET public/config': [{ body: CONFIG }],
        'GET auth/me': [{ body: me('user') }],
        'GET settings': [{ body: SETTINGS }],
        'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      });
      openedFromSearch('search', '/account/profile');
      const { findByText, getByRole, goto } = renderAt('/account/security');
      await findByText('Page content');
      await fireEvent.click(getByRole('button', { name: 'Back to Roedy Mail' }));
      expect(goto).toHaveBeenLastCalledWith('/start');
      expect(search.ret).toBeNull();
    });

    it('mobile: the back bar reads “Search” and returns there first', async () => {
      vi.stubGlobal('innerWidth', 400);
      window.dispatchEvent(new Event('resize'));
      mockApi({
        'GET public/config': [{ body: CONFIG }],
        'GET auth/me': [{ body: me('admin') }],
        'GET settings': [{ body: SETTINGS }],
        'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      });
      openedFromSearch('search', '/admin/users');
      const { findByText, getByRole, goto } = renderAt('/admin/users');
      await findByText('Page content');
      await fireEvent.click(getByRole('button', { name: 'Search' }));
      expect(goto).toHaveBeenLastCalledWith('/search');
      expect(search.q).toBe('invoice');
    });
  });

  it('shows the page first on mobile, then the area list via “Back”', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByText, goto } = renderAt('/admin/users');
    await findByText('Page content');
    await fireEvent.click(getByRole('button', { name: 'Administration' }));
    expect(queryByText('Page content')).toBeNull();
    expect(getByRole('heading', { level: 1 })).toHaveTextContent('Administration');
    expect(getByRole('switch', { name: 'Advanced settings' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Users' }));
    // List and page have the same address: no second history entry.
    expect(goto).toHaveBeenCalledWith('/admin/users', { replace: true });
    expect(await findByText('Page content')).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Administration' }));
    await fireEvent.click(getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(goto).toHaveBeenLastCalledWith('/start');
    // From the "More" menu, "Settings" opens the area list.
    ui.menu = 'nav';
    await vi.waitFor(() => expect(getByRole('dialog', { name: 'More' })).toBeInTheDocument());
    await fireEvent.click(getByRole('button', { name: 'Settings' }));
    expect(goto).toHaveBeenLastCalledWith('/settings/appearance');
    expect(ui.panelList).toBe('/settings/appearance');
  });

  it('goes back like “Back” when swiping right on the mobile panel', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, goto } = renderAt('/admin/users');
    const text = await findByText('Page content');
    // Layer underneath and chip are decorative.
    expect(document.querySelector('[data-back-under]')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('[data-back-chip]')).toHaveAttribute('aria-hidden', 'true');
    swipe(text, 200);
    // From the page to the area list …
    await vi.waitFor(() => expect(getByRole('heading', { level: 1 })).toHaveTextContent('Administration'));
    expect(ui.panelList).toBe('/admin/users');
    expect(goto).not.toHaveBeenCalledWith('/start');
    // … and from the list to the app.
    swipe(getByRole('heading', { level: 1 }), 200);
    await vi.waitFor(() => expect(goto).toHaveBeenLastCalledWith('/start'));
  });

  it('sets the title per route and puts the page in exactly one main, also on mobile', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getAllByRole } = renderAt('/admin/users');
    const text = await findByText('Page content');
    await vi.waitFor(() => expect(document.title).toBe('Users – Roedy Mail'));
    expect(getAllByRole('main')).toHaveLength(1);
    expect(getAllByRole('main')[0]).toContainElement(text);
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(getAllByRole('main')[0]).toHaveClass('m-panel'));
    expect(getAllByRole('main')).toHaveLength(1);
    expect(getAllByRole('main')[0]).toHaveTextContent('Page content');
  });

  it('names an error page in the title and makes it the main landmark', async () => {
    mockApi({ 'GET public/config': [{ status: 502, body: {} }] });
    const { findByRole, getByRole } = renderAt('/no-account');
    const heading = await findByRole('heading', { name: 'Something went wrong' });
    expect(getByRole('main')).toContainElement(heading);
    expect(document.title).toBe('Something went wrong – Roedy Mail');
  });

  it('stays in the list on mobile when “Advanced settings” turns off below “Developer”', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: { version: 1, settings: { ...SETTINGS.settings, advanced: true } } }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
      'PUT settings': [{ body: { version: 2, settings: { ...SETTINGS.settings, advanced: false } } }],
    });
    const { findByText, getByRole, goto } = renderAt('/admin/developer');
    await findByText('Page content');
    await vi.waitFor(() => expect(prefs.values.advanced).toBe(true));
    await fireEvent.click(getByRole('button', { name: 'Administration' }));
    await fireEvent.click(getByRole('switch', { name: 'Advanced settings' }));
    expect(goto).toHaveBeenLastCalledWith('/admin/users');
    expect(ui.panelList).toBe('/admin/users');
  });

  it('shows a pick list of the page as a sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByRole } = renderAt('/admin/users');
    await findByText('Page content');
    const choose = vi.fn();
    ui.pick = () => ({
      title: 'Role for 1 Person',
      opts: [{ label: 'Administrator', sub: '', hasSub: false, on: false, fw: 600, onClick: choose }],
    });
    ui.menu = 'pick';
    await vi.waitFor(() => expect(getByRole('dialog', { name: 'Role for 1 Person' })).toBeInTheDocument());
    await fireEvent.click(getByRole('option', { name: 'Administrator' }));
    expect(choose).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(queryByRole('dialog')).toBeNull();
  });

  it('closes the rules target picker (`rulepick`) with Escape and a click outside, on mobile without sheet', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByText, queryByRole } = renderAt('/admin/users');
    await findByText('Page content');
    // On desktop: click outside (`onDocDown`) and Escape via the layout.
    ui.menu = 'rulepick';
    await fireEvent.mouseDown(getByText('Page content'));
    expect(ui.menu).toBeNull();
    ui.menu = 'rulepick';
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(ui.menu).toBeNull();
    // On mobile it sits in the page: no sheet, even if a page had left values for `pick`.
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    ui.pick = () => ({ title: 'Role', opts: [] });
    ui.menu = 'rulepick';
    await tick();
    expect(queryByRole('dialog')).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(ui.menu).toBeNull();
  });

  it('opens “Add mail server” from the palette and shows the page dialog above the shell', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole, queryByRole, queryByText, goto } = renderAt('/admin/users');
    await findByText('Page content');
    ui.openPalette('Add mail');
    await vi.waitFor(() => expect(getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument());
    await fireEvent.click(getByRole('button', { name: /Add mail server/ }));
    expect(goto).toHaveBeenCalledWith('/admin/mail-servers');
    expect(ui.serverAdd).toBe(true);
    // The page sets its dialog; the layout renders it above the shell.
    const close = vi.fn();
    ui.pageDialog = () => ({ title: 'Add server', close, content: dialog });
    expect(await findByText('Dialog above the shell')).toBeInTheDocument();
    // While it is open, only Escape: neither shortcuts nor a palette below the dialog.
    await fireEvent.keyDown(window, { key: '?' });
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(queryByText('Command palette')).toBeNull();
    expect(ui.palette).toBe(false);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows the page dialog as a sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('admin') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: NO_ACCOUNTS }],
    });
    const { findByText, getByRole } = renderAt('/admin/mail-servers');
    await findByText('Page content');
    const close = vi.fn();
    ui.pageDialog = () => ({ title: 'Add server', close, content: dialog });
    const sheet = await vi.waitFor(() => getByRole('dialog', { name: 'Add server' }));
    expect(sheet).toHaveTextContent('Content in the sheet');
    await fireEvent.mouseDown(document.querySelector('.scrim') as Element);
    expect(close).toHaveBeenCalled();
  });

  it('shows toasts also on pages without a shell', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const { findByText } = renderAt('/login');
    await findByText('Page content');
    ui.toasts.show('Calendar coming soon');
    expect(await findByText('Calendar coming soon')).toBeInTheDocument();
  });
});

describe('Mail account', () => {
  const ACCOUNTS = {
    accounts: [
      { ...ACCOUNT, state: 'ok' },
      { ...ACCOUNT, id: 'a2', email: 'alex@s2.test', host: 'mail.s2.test', state: 'needs_reauth' },
    ],
  };

  function mockShell() {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: ACCOUNTS }],
    });
  }

  it('reads accounts without access only from storage and follows their state', async () => {
    const restore = vi.spyOn(mailboxes, 'restore');
    const ensure = vi.spyOn(mailboxes, 'ensure').mockResolvedValue();
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [{ body: { accounts: [ACCOUNTS.accounts[1]] } }],
      'GET tags': [{ body: { tags: [] } }],
    });
    renderAt('/mailbox/a2/inbox');
    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith('a2'));
    expect(ensure).not.toHaveBeenCalled();
    // "Sign in again" only changes the state; the effect runs without a page change.
    accounts.list![0]!.state = 'ok';
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith('a2'));
    restore.mockRestore();
    ensure.mockRestore();
  });

  it('shows the subpages, the account switch and the account selection on desktop', async () => {
    mockShell();
    const { findByText, getByRole, queryByRole, goto } = renderAt('/account/mail-accounts/a1/vacation');
    await findByText('Page content');
    const nav = getByRole('navigation');
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Overview', 'Identities', 'Vacation reply', 'Connection', 'Rules']);
    expect(within(nav).getByRole('button', { name: 'Vacation reply' })).toHaveAttribute('aria-current', 'page');
    await fireEvent.click(within(nav).getByRole('button', { name: 'Vacation reply' }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts/a1/vacation', { replace: true });
    await fireEvent.click(within(nav).getByRole('button', { name: 'Identities' }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts/a1/identities');
    await fireEvent.click(getByRole('button', { name: 'Back to email accounts' }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts');
    const toggle = await vi.waitFor(() => getByRole('button', { name: /^Switch email account/ }));
    expect(toggle).toHaveTextContent('account1@s1.test');
    await fireEvent.click(toggle);
    expect(ui.menu).toBe('masw');
    const menu = await vi.waitFor(() => getByRole('menu', { name: 'Switch email account' }));
    await fireEvent.click(within(menu).getByRole('menuitemradio', { name: /alex@s2\.test/ }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts/a2/vacation');
    expect(ui.menu).toBeNull();
    expect(queryByRole('menu')).toBeNull();
  });

  it('shows start with the subpages on mobile and leads back via “Back”', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockShell();
    ui.panelList = '/account/mail-accounts/a1/overview';
    const { findByRole, getByRole, queryByText, findByText, goto } = renderAt('/account/mail-accounts/a1/overview');
    await findByRole('button', { name: 'Switch email account' });
    expect(queryByText('Page content')).toBeNull();
    expect(getByRole('button', { name: 'Email accounts' })).toBeInTheDocument();
    // Account selection in the sheet: another account keeps start.
    await fireEvent.click(getByRole('button', { name: 'Switch email account' }));
    const sheet = await findByRole('dialog', { name: 'Switch account' });
    await fireEvent.click(within(sheet).getByRole('radio', { name: /alex@s2\.test/ }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts/a2/overview');
    expect(ui.panelList).toBe('/account/mail-accounts/a2/overview');
    // Start stays until the navigation is done (no page of the old account).
    expect(queryByText('Page content')).toBeNull();
    // An entry opens the subpage, "Back" (with the address) leads to start, from there to the list.
    ui.panelList = '/account/mail-accounts/a1/overview';
    await fireEvent.click(await findByRole('button', { name: 'Overview' }));
    expect(ui.panelList).toBeNull();
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts/a1/overview', { replace: true });
    await findByText('Page content');
    await fireEvent.click(getByRole('button', { name: 'account1@s1.test' }));
    expect(ui.panelList).toBe('/account/mail-accounts/a1/overview');
    await fireEvent.click(await findByRole('button', { name: 'Email accounts' }));
    expect(goto).toHaveBeenLastCalledWith('/account/mail-accounts');
  });

  it('leads an unknown account to the list, also from start', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockShell();
    ui.panelList = '/account/mail-accounts/missing/overview';
    const { goto } = renderAt('/account/mail-accounts/missing/overview');
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/account/mail-accounts', { replace: true }));
    expect(ui.panelList).toBeNull();
  });
});

describe('Mailboxes in the shell', () => {
  // Other tests collapse the sidebar via "["; `ui` is a singleton.
  beforeEach(() => {
    ui.collapsed = false;
  });

  const JMAP = 'https://s1.test/jmap/';
  const SESSION = {
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxSizeUpload: 1000,
        maxConcurrentUpload: 2,
        maxSizeRequest: 100_000,
        maxConcurrentRequests: 4,
        maxCallsInRequest: 8,
        maxObjectsInGet: 100,
        maxObjectsInSet: 100,
        collationAlgorithms: [],
      },
      'urn:ietf:params:jmap:mail': {},
    },
    accounts: { j1: { name: 'account1@s1.test', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'j1' },
    username: 'account1@s1.test',
    apiUrl: JMAP,
    downloadUrl: 'https://s1.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    uploadUrl: 'https://s1.test/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://s1.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    state: 's1',
  };
  const box = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {},
    isSubscribed: true,
    ...extra,
  });
  const MAILBOXES = [
    box('in', 'Inbox', { role: 'inbox', unreadThreads: 4, totalThreads: 15 }),
    box('se', 'Sent Items', { role: 'sent', totalThreads: 9 }),
    box('ku', 'Customers', { sortOrder: 1 }),
    box('mu', 'Miller Ltd', { parentId: 'ku', unreadThreads: 1, totalThreads: 3 }),
    box('tg', 'Tags'),
    box('w', 'Important', { parentId: 'tg', unreadThreads: 2, totalThreads: 5 }),
    box('re', 'Invoices', { parentId: 'w', unreadThreads: 1, totalThreads: 1 }),
  ];
  const tag = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    parent_id: null,
    color: null,
    position: 0,
    links: [],
    created_at: '2026-10-28T10:00:00Z',
    ...extra,
  });
  const TAGS = [
    tag('t1', 'Important', { color: 4, links: [{ mail_account_id: 'a1', mailbox_id: 'w' }] }),
    tag('t2', 'Invoices', { parent_id: 't1', links: [{ mail_account_id: 'a1', mailbox_id: 're' }] }),
    tag('t3', 'Private', { color: 2, position: 1 }),
  ];

  function mockMail(second = { ...ACCOUNT, id: 'a2', email: 'account2@s1.test' }) {
    return mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: SETTINGS }],
      'GET mail-accounts': [
        {
          body: {
            accounts: [
              { ...ACCOUNT, state: 'ok' },
              { ...second, state: 'ok' },
            ],
          },
        },
      ],
      'GET tags': [{ body: { tags: TAGS } }],
      'GET mail-accounts/a1/token': [
        { body: { accessToken: 't1', expiresAt: '2099-01-01T00:00:00Z', session: SESSION } },
      ],
      [`POST ${JMAP}`]: [
        (call) => {
          const [, args, id] = (call.body as { methodCalls: [[string, unknown, string]] }).methodCalls[0];
          expect(args).toEqual({ accountId: 'j1', ids: null });
          return {
            body: {
              methodResponses: [['Mailbox/get', { accountId: 'j1', state: 'b1', list: MAILBOXES, notFound: [] }, id]],
              sessionState: 's1',
            },
          };
        },
      ],
    });
  }

  it('shows the mailboxes of the address account with counters and the active entry', async () => {
    const { calls } = mockMail();
    const { findByRole, container } = renderAt('/mailbox/a1/sent');
    await findByRole('button', { name: /Inbox/ });
    // Live sync for all usable accounts, not only the sidebar's.
    expect(liveRetain).toHaveBeenLastCalledWith(['a1', 'a2']);
    expect(scheduledRetain).toHaveBeenLastCalledWith(['a1', 'a2']);
    await vi.waitFor(() =>
      expect(container.querySelector('.count')?.getAttribute('aria-label')).toBe('4 unread of 15'),
    );
    const rows = [...container.querySelectorAll('.panel.rows .row')];
    expect(rows.map((r) => r.querySelector('.label')?.textContent)).toEqual([
      'Inbox',
      'Sent',
      'Drafts',
      'Scheduled',
      'Trash',
      'Spam',
    ]);
    expect(rows[1]?.classList.contains('on')).toBe(true);
    expect(rows[1]?.querySelector('.count')?.getAttribute('aria-label')).toBe('0 unread of 9');
    expect(rows[2]?.querySelector('.count')).toBeNull();
    expect(calls.filter((c) => c.path === JMAP)).toHaveLength(1);
  });

  it('shows the tree without roles and “Tags” in the “Folders” tab, expands and opens folders', async () => {
    mockMail();
    const { findByRole, findByText, queryByText, getByRole, goto, container } = renderAt('/mailbox/a1/f/mu');
    await fireEvent.click(await findByRole('tab', { name: /Folders/ }));
    expect(await findByText('Customers')).toBeInTheDocument();
    const tree = container.querySelector('.tree')?.textContent ?? '';
    for (const hidden of ['Tags', 'Important', 'Inbox', 'Sent Items']) expect(tree).not.toContain(hidden);
    // The active folder lies in the collapsed "Customers".
    expect(queryByText('Miller Ltd')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Show subfolders' }));
    expect(await findByText('Miller Ltd')).toBeInTheDocument();
    await fireEvent.click(await findByText('Customers'));
    expect(goto).toHaveBeenCalledWith('/mailbox/a1/f/ku');
  });

  it('shows the tag list with colours and counters via the links in the “Tags” tab, expands and opens tags', async () => {
    const { calls } = mockMail();
    const { findByRole, findByText, queryByText, getByRole, goto, container } = renderAt('/mailbox/a1/t/t2');
    const tab = await findByRole('tab', { name: /Tags/ });
    // The active tag lies in the collapsed "Important": dot on the tab.
    await vi.waitFor(() => expect(tab.querySelector('.dot')?.getAttribute('style')).toContain('opacity: 1'));
    await fireEvent.click(tab);
    expect(await findByText('Private')).toBeInTheDocument();
    expect(queryByText('Invoices')).toBeNull();
    // Counter of the tag with its subtag.
    await vi.waitFor(() =>
      expect(container.querySelector('.tags .count')?.getAttribute('aria-label')).toBe('3 unread of 6'),
    );
    await fireEvent.click(getByRole('button', { name: 'Show subtags' }));
    expect(await findByRole('button', { name: /Invoices/, pressed: true })).toBeInTheDocument();
    await fireEvent.click(await findByText('Private'));
    expect(goto).toHaveBeenCalledWith('/mailbox/a1/t/t3');
    expect(calls.filter((c) => c.path === 'tags')).toHaveLength(1);
  });

  it('opens mailboxes by click, with 1–6 and from the palette (“Navigation” group per account)', async () => {
    mockMail();
    const { findByRole, getByRole, findByText, goto } = renderAt('/mailbox/a1/inbox');
    // The open mailbox again: no further history entry.
    await fireEvent.click(await findByRole('button', { name: /Inbox/ }));
    await fireEvent.keyDown(window, { key: '1' });
    expect(goto).not.toHaveBeenCalled();
    await fireEvent.click(await findByRole('button', { name: /Drafts/ }));
    expect(goto).toHaveBeenCalledWith('/mailbox/a1/drafts');
    await fireEvent.keyDown(window, { key: '6' });
    expect(goto).toHaveBeenCalledWith('/mailbox/a1/spam');
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(await findByText('Navigation')).toBeInTheDocument();
    await fireEvent.click(await findByText('Trash · account2@s1.test'));
    expect(goto).toHaveBeenCalledWith('/mailbox/a2/trash');
  });

  /** Two signed-in accounts with their own JMAP server; settings optionally with default "All accounts". */
  function mockBoth(settings: Record<string, unknown> = {}) {
    const JMAP2 = 'https://s2.test/jmap/';
    // All addresses of the session on the account's server.
    const SESSION2 = {
      ...(JSON.parse(JSON.stringify(SESSION).replaceAll('s1.test', 's2.test')) as typeof SESSION),
      accounts: { j2: { ...SESSION.accounts.j1, name: 'account2@s2.test' } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'j2' },
    };
    const BOXES2 = [
      box('in2', 'Inbox', { role: 'inbox', unreadThreads: 2, totalThreads: 5 }),
      box('dr2', 'Drafts', { role: 'drafts', totalThreads: 1 }),
      box('pr', 'Projects'),
      box('tg2', 'Tags'),
      box('w2', 'Important', { parentId: 'tg2', unreadThreads: 1, totalThreads: 2 }),
    ];
    // "Important" is linked in both accounts.
    const tags2 = TAGS.map((t) =>
      t.id === 't1' ? { ...t, links: [...t.links, { mail_account_id: 'a2', mailbox_id: 'w2' }] } : t,
    );
    const reply = (accountId: string, list: unknown[]) => (call: { body: unknown }) => {
      const [, , id] = (call.body as { methodCalls: [[string, unknown, string]] }).methodCalls[0];
      return {
        body: {
          methodResponses: [['Mailbox/get', { accountId, state: 'b1', list, notFound: [] }, id]],
          sessionState: 's1',
        },
      };
    };
    return mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ body: me('user') }],
      'GET settings': [{ body: { ...SETTINGS, settings: { ...SETTINGS.settings, ...settings } } }],
      'GET mail-accounts': [
        {
          body: {
            accounts: [
              { ...ACCOUNT, state: 'ok' },
              { ...ACCOUNT, id: 'a2', email: 'account2@s2.test', url: 'https://s2.test', state: 'ok', color: 1 },
            ],
          },
        },
      ],
      'GET mail-accounts/a1/token': [
        { body: { accessToken: 't1', expiresAt: '2099-01-01T00:00:00Z', session: SESSION } },
      ],
      'GET mail-accounts/a2/token': [
        { body: { accessToken: 't2', expiresAt: '2099-01-01T00:00:00Z', session: SESSION2 } },
      ],
      'GET tags': [{ body: { tags: tags2 } }],
      [`POST ${JMAP}`]: [reply('j1', MAILBOXES)],
      [`POST ${JMAP2}`]: [reply('j2', BOXES2)],
    });
  }

  it('shows “All accounts” with the role totals and opens mailboxes with 1–6', async () => {
    const { calls } = mockBoth();
    const { findByRole, container, goto } = renderAt('/mailbox/all/sent');
    expect(await findByRole('button', { name: /All accounts/ })).toHaveTextContent('2 mailboxes');
    const rows = () => [...container.querySelectorAll('.panel.rows .row')];
    await vi.waitFor(() =>
      expect(rows()[0]?.querySelector('.count')?.getAttribute('aria-label')).toBe('6 unread of 20'),
    );
    expect(rows()[1]?.classList.contains('on')).toBe(true);
    expect(rows()[1]?.querySelector('.count')?.getAttribute('aria-label')).toBe('0 unread of 9');
    expect(rows()[2]?.querySelector('.count')?.getAttribute('aria-label')).toBe('0 unread of 1');
    // Exactly one `Mailbox/get` per account.
    expect(calls.filter((c) => c.path.endsWith('/jmap/'))).toHaveLength(2);
    await fireEvent.keyDown(window, { key: '3' });
    expect(goto).toHaveBeenCalledWith('/mailbox/all/drafts');
    await fireEvent.click(rows()[4] as Element);
    expect(goto).toHaveBeenCalledWith('/mailbox/all/trash');
  });

  it('shows the dot on the “Tags” tab also for a tag the list does not know', async () => {
    mockMail();
    const { findByRole, findByText } = renderAt('/mailbox/a1/t/new');
    const tab = await findByRole('tab', { name: /Tags/ });
    await fireEvent.click(await findByRole('tab', { name: /Folders/ }));
    expect(await findByText('Customers')).toBeInTheDocument();
    expect(tab.querySelector('.dot')?.getAttribute('style')).toContain('opacity: 1');
  });

  it('counts tags in “All accounts” via the links of all accounts and opens them there', async () => {
    mockBoth();
    const { findByRole, findByText, goto, container } = renderAt('/mailbox/all/inbox');
    await fireEvent.click(await findByRole('tab', { name: /Tags/ }));
    await vi.waitFor(() =>
      expect(container.querySelector('.tags .count')?.getAttribute('aria-label')).toBe('4 unread of 8'),
    );
    await fireEvent.click(await findByText('Important'));
    expect(goto).toHaveBeenCalledWith('/mailbox/all/t/t1');
  });

  it('shows the tree with header rows per account in “All accounts” and opens folders with their account', async () => {
    mockBoth();
    const { findByRole, findByText, queryByText, getByRole, getAllByText, goto } = renderAt('/mailbox/all/inbox');
    await fireEvent.click(await findByRole('tab', { name: /Folders/ }));
    // Accounts are collapsed at the start (`fAcctO`).
    const head = await findByRole('button', { name: /account2@s2\.test/, expanded: false });
    expect(getByRole('button', { name: /account1@s1\.test/, expanded: false })).toBeInTheDocument();
    expect(queryByText('Projects')).toBeNull();
    await fireEvent.click(head);
    await fireEvent.click(await findByText('Projects'));
    expect(goto).toHaveBeenCalledWith('/mailbox/all/f/a2/pr');
    // Instead of the general "New folder" every expanded account has its row in the tree (`addFShow: !allMode`).
    expect(getAllByText('New folder')).toHaveLength(1);
  });

  it('switches account and “All accounts” with the same mailbox via the account switcher on desktop', async () => {
    mockBoth();
    const { findByRole, getByRole, queryByRole, goto } = renderAt('/mailbox/a1/sent');
    const button = await findByRole('button', { name: /account1@s1\.test/, expanded: false });
    await fireEvent.click(button);
    const menu = getByRole('menu', { name: 'Switch email account' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(getByRole('menuitemradio', { name: /account1@s1\.test/ })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(getByRole('menuitemradio', { name: /account2@s2\.test/ }));
    expect(goto).toHaveBeenCalledWith('/mailbox/a2/sent');
    expect(queryByRole('menu')).toBeNull();
    await fireEvent.click(button);
    await fireEvent.click(getByRole('menuitemradio', { name: /All accounts/ }));
    expect(goto).toHaveBeenCalledWith('/mailbox/all/sent');
    // The already selected view only closes the popup.
    await fireEvent.click(button);
    await fireEvent.click(getByRole('menuitemradio', { name: /account1@s1\.test/ }));
    expect(queryByRole('menu')).toBeNull();
    expect(goto).toHaveBeenCalledTimes(2);
    // A click beside it closes, a click in the popup does not.
    await fireEvent.click(button);
    await fireEvent.mouseDown(getByRole('menu'));
    expect(getByRole('menu')).toBeInTheDocument();
    await fireEvent.mouseDown(document.body);
    expect(queryByRole('menu')).toBeNull();
    expect(menu).not.toBeInTheDocument();
  });

  it('opens the “Mailboxes” sheet with “Inbox” on mobile and switches the account in it', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockBoth();
    const { findByRole, getByRole, queryByRole, goto } = renderAt('/mailbox/a1/sent');
    const tab = await findByRole('button', { name: 'Inbox' });
    await fireEvent.click(tab);
    const sheet = getByRole('dialog', { name: 'Mailboxes' });
    expect(getByRole('button', { name: 'Sent' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: /Switch account/ }));
    expect(getByRole('dialog', { name: 'Switch account' })).toBeInTheDocument();
    // Escape only closes "Switch account".
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('dialog', { name: 'Switch account' })).toBeNull();
    expect(sheet).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: /Switch account/ }));
    await fireEvent.click(getByRole('radio', { name: /All accounts/ }));
    // The choice leads to the all-accounts view and returns to the open sheet.
    expect(goto).toHaveBeenCalledWith('/mailbox/all/sent');
    expect(queryByRole('dialog', { name: 'Switch account' })).toBeNull();
    expect(getByRole('dialog', { name: 'Mailboxes' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Spam' }));
    expect(goto).toHaveBeenCalledWith('/mailbox/a1/spam');
    expect(queryByRole('dialog')).toBeNull();
    vi.stubGlobal('innerWidth', 1024);
    window.dispatchEvent(new Event('resize'));
  });

  it('opens the view inbox with “Inbox” outside the mailboxes on mobile', async () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    mockBoth({ defaultAccount: 'all' });
    const { findByRole, goto } = renderAt('/start');
    await fireEvent.click(await findByRole('button', { name: 'Inbox' }));
    expect(goto).toHaveBeenCalledWith('/mailbox/all/inbox');
    vi.stubGlobal('innerWidth', 1024);
    window.dispatchEvent(new Event('resize'));
  });

  it('shows the default “All accounts” without a mailbox in the address', async () => {
    mockBoth({ defaultAccount: 'all' });
    const { findByRole } = renderAt('/start');
    expect(await findByRole('button', { name: /All accounts/ })).toBeInTheDocument();
  });

  describe('Tag sync', () => {
    type Box = ReturnType<typeof box>;

    /**
     * JMAP server of account a1 with the mailboxes as state: `Mailbox/get`
     * (all or by `#ids`), `Mailbox/set` (only `update`) and `Mailbox/changes`
     * with a new state per `Mailbox/set`.
     */
    function jmapServer(initial: readonly Box[]) {
      let boxes = [...initial];
      /** `log[i]`: changed from state `b${i + 1}` to `b${i + 2}`. */
      const log: string[][] = [];
      const methods: string[] = [];
      const state = () => `b${log.length + 1}`;
      const reply = (call: { body: unknown }) => {
        const { methodCalls } = call.body as { methodCalls: [string, Record<string, unknown>, string][] };
        let changed: string[] = [];
        const accountId = 'j1';
        const methodResponses = methodCalls.map(([name, args, id]) => {
          methods.push(name);
          if (name === 'Mailbox/changes') {
            changed = [...new Set(log.slice(Number(String(args.sinceState).slice(1)) - 1).flat())];
            const res = { accountId, oldState: args.sinceState, newState: state(), hasMoreChanges: false };
            return [name, { ...res, created: [], updated: changed, destroyed: [], updatedProperties: null }, id];
          }
          if (name === 'Mailbox/get') {
            const ref = args['#ids'] as { path: string } | undefined;
            const ids = ref ? (ref.path === '/updated' ? changed : []) : null;
            const list = ids ? boxes.filter((b) => ids.includes(b.id)) : boxes;
            return [name, { accountId, state: state(), list, notFound: [] }, id];
          }
          if (name === 'Mailbox/set' && args.create) {
            const oldState = state();
            const create = args.create as Record<string, Partial<Box>>;
            const created = Object.fromEntries(
              Object.entries(create).map(([key, props], i) => {
                const fresh = box(`new${i}`, String(props.name), { parentId: props.parentId ?? null });
                boxes = [...boxes, fresh];
                return [key, { id: fresh.id }];
              }),
            );
            log.push(Object.values(created).map((c) => c.id));
            return [name, { accountId, oldState, newState: state(), created, notCreated: null }, id];
          }
          if (name === 'Mailbox/set') {
            const update = (args.update ?? {}) as Record<string, Partial<Box>>;
            const oldState = state();
            boxes = boxes.map((b) => ({ ...b, ...update[b.id] }));
            log.push(Object.keys(update));
            const updated = Object.fromEntries(Object.keys(update).map((k) => [k, null]));
            return [name, { accountId, oldState, newState: state(), updated, notUpdated: null }, id];
          }
          throw new Error(`unexpected call ${name}`);
        });
        return { body: { methodResponses, sessionState: 's1' } };
      };
      return { reply, methods };
    }

    /** One account (a1) with mailboxes; `GET tags` answers in turn with `lists` (first load, after every action). */
    function mockFix(lists: unknown[][], boxes: readonly Box[] = MAILBOXES, extra: Parameters<typeof mockApi>[0] = {}) {
      const server = jmapServer(boxes);
      const api = mockApi({
        'GET public/config': [{ body: CONFIG }],
        'GET auth/me': [{ body: me('user') }],
        'GET settings': [{ body: SETTINGS }],
        'GET mail-accounts': [{ body: { accounts: [{ ...ACCOUNT, state: 'ok' }] } }],
        'GET tags': lists.map((list) => ({ body: { tags: list } })),
        'GET mail-accounts/a1/token': [
          { body: { accessToken: 't1', expiresAt: '2099-01-01T00:00:00Z', session: SESSION } },
        ],
        [`POST ${JMAP}`]: Array.from({ length: 8 }, () => server.reply),
        ...extra,
      });
      return { ...api, server };
    }

    const [IMPORTANT, INVOICES] = TAGS as [ReturnType<typeof tag>, ReturnType<typeof tag>];
    /** Private and Travel are linked to mailboxes that no longer exist (case `missing`). */
    const privateTag = (links: unknown[] = [{ mail_account_id: 'a1', mailbox_id: 'gone' }]) =>
      tag('t3', 'Private', { color: 2, position: 1, links });
    const travel = (links: unknown[] = [{ mail_account_id: 'a1', mailbox_id: 'gone2' }]) =>
      tag('t4', 'Travel', { color: 3, position: 2, links });
    /** "Tags/Old" without a tag (case `unlinked`). */
    const OLD = box('old', 'Old', { parentId: 'tg', sortOrder: 3 });

    async function openTags(findByRole: (role: string, options: object) => Promise<HTMLElement>) {
      await fireEvent.click(await findByRole('tab', { name: /Tags/ }));
    }

    it('shows the notice row and the marker on the row for a mismatch', async () => {
      mockFix([[IMPORTANT, INVOICES, privateTag()]]);
      const { findByRole, findByText, container } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      const fix = await findByRole('button', { name: 'Fix tags, 1 mismatch' });
      expect(fix).toHaveAttribute('aria-haspopup', 'dialog');
      const row = (await findByText('Private')).closest('.item')!;
      expect(row.querySelector('[role="img"]')).toHaveAttribute(
        'aria-label',
        'Doesn’t match the mailbox in account1@s1.test',
      );
      expect(container.querySelectorAll('.tags .warn')).toHaveLength(1);
    });

    it('shows neither notice row nor marker without a mismatch', async () => {
      mockFix([TAGS]);
      const { findByRole, queryByRole, container } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      // Only with loaded mailboxes are there counters – and mismatches.
      await vi.waitFor(() =>
        expect(container.querySelector('.tags .count')?.getAttribute('aria-label')).toBe('3 unread of 6'),
      );
      expect(queryByRole('button', { name: /^Fix tags/ })).toBeNull();
      expect(container.querySelector('.tags .warn')).toBeNull();
    });

    it('opens the dialog via the notice row; Escape and “Close” close it', async () => {
      mockFix([[IMPORTANT, INVOICES, privateTag()]]);
      const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      const fix = await findByRole('button', { name: 'Fix tags, 1 mismatch' });
      // A click sets no focus in jsdom.
      fix.focus();
      await fireEvent.click(fix);
      const dialog = getByRole('dialog', { name: 'Fix tags' });
      expect(dialog).toHaveFocus();
      expect(dialog).toHaveTextContent('account1@s1.test');
      expect(within(dialog).getByText(/^The mailbox is missing/)).toBeInTheDocument();
      await fireEvent.keyDown(window, { key: 'Escape' });
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      expect(fix).toHaveFocus();
      await fireEvent.click(fix);
      await fireEvent.click(within(getByRole('dialog', { name: 'Fix tags' })).getByRole('button', { name: 'Close' }));
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
    });

    it('removes links, reloads the tags and closes after the last one', async () => {
      const { calls, server } = mockFix(
        [
          [IMPORTANT, INVOICES, privateTag(), travel()],
          [IMPORTANT, INVOICES, privateTag([]), travel()],
          [IMPORTANT, INVOICES, privateTag([]), travel([])],
        ],
        MAILBOXES,
        {
          'PUT tags/t3/links': [{ body: privateTag([]) }],
          'PUT tags/t4/links': [{ body: travel([]) }],
        },
      );
      const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      await fireEvent.click(await findByRole('button', { name: 'Fix tags, 2 mismatches' }));
      const dialog = getByRole('dialog', { name: 'Fix tags' });
      const itemOf = (name: string) => within(dialog).getByText(name).closest('.item') as HTMLElement;

      await fireEvent.click(within(itemOf('Private')).getByRole('button', { name: 'Unlink' }));
      await vi.waitFor(() => expect(ui.toast?.text).toBe('Unlinked'));
      expect(ui.toast).toMatchObject({ error: false, undo: false });
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: 'tags/t3/links', body: { links: [] } });
      expect(calls.filter((c) => c.path === 'tags' && c.method === 'GET')).toHaveLength(2);
      // Only the links changed, no mailbox: no sync of the mailboxes.
      expect(server.methods).not.toContain('Mailbox/changes');
      // A mismatch remains: the dialog stays open.
      expect(getByRole('dialog', { name: 'Fix tags' })).toBe(dialog);
      expect(within(dialog).queryByText('Private')).toBeNull();
      expect(getByRole('button', { name: 'Fix tags, 1 mismatch' })).toBeInTheDocument();

      await fireEvent.click(within(itemOf('Travel')).getByRole('button', { name: 'Unlink' }));
      await vi.waitFor(() => expect(ui.toast?.text).toBe('Tags fixed'));
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      expect(queryByRole('button', { name: /^Fix tags/ })).toBeNull();
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual(['tags/t3/links', 'tags/t4/links']);
    });

    it('moves a mailbox without a tag via Mailbox/set and syncs the mailboxes', async () => {
      const { calls, server } = mockFix([TAGS, TAGS], [...MAILBOXES, OLD]);
      const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      await fireEvent.click(await findByRole('button', { name: 'Fix tags, 1 mismatch' }));
      const dialog = getByRole('dialog', { name: 'Fix tags' });
      expect(within(dialog).getByText('Tags/Old')).toBeInTheDocument();
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move to folders' }));
      await vi.waitFor(() => expect(ui.toast?.text).toBe('Tags fixed'));
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      expect(server.methods).toEqual(['Mailbox/get', 'Mailbox/set', 'Mailbox/changes', 'Mailbox/get', 'Mailbox/get']);
      const jmapCalls = calls.flatMap((c) => (c.body as { methodCalls?: [string, unknown][] })?.methodCalls ?? []);
      expect(jmapCalls.find(([name]) => name === 'Mailbox/set')?.[1]).toMatchObject({
        accountId: 'j1',
        update: { old: { parentId: null } },
      });
      expect(mailboxes.list('a1').find((b) => b.id === 'old')?.parentId).toBeNull();
    });

    it('reports a taken folder name with an error toast and leaves the dialog open', async () => {
      const { server } = mockFix([TAGS, TAGS], [...MAILBOXES, OLD, box('old0', 'Old', { sortOrder: 4 })]);
      const { findByRole, getByRole } = renderAt('/mailbox/a1/inbox');
      await openTags(findByRole);
      await fireEvent.click(await findByRole('button', { name: 'Fix tags, 1 mismatch' }));
      const dialog = getByRole('dialog', { name: 'Fix tags' });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move to folders' }));
      expect(await findByRole('alert')).toHaveTextContent('A folder named “Old” already exists there.');
      expect(ui.toast).toMatchObject({ error: true, undo: false });
      expect(server.methods).not.toContain('Mailbox/set');
      expect(getByRole('dialog', { name: 'Fix tags' })).toBe(dialog);
      expect(within(dialog).getByRole('button', { name: 'Move to folders' })).toHaveAttribute('aria-disabled', 'false');
    });

    it('opens a second sheet in the “Mailboxes” sheet on mobile; Escape only closes that one', async () => {
      vi.stubGlobal('innerWidth', 400);
      window.dispatchEvent(new Event('resize'));
      mockFix([[IMPORTANT, INVOICES, privateTag()]]);
      const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
      await fireEvent.click(await findByRole('button', { name: 'Inbox' }));
      const sheet = getByRole('dialog', { name: 'Mailboxes' });
      await fireEvent.click(within(sheet).getByRole('tab', { name: /Tags/ }));
      await fireEvent.click(await within(sheet).findByRole('button', { name: 'Fix tags, 1 mismatch' }));
      const top = getByRole('dialog', { name: 'Fix tags' });
      expect(within(top).getByText('Unlink')).toBeInTheDocument();
      expect(sheet).toHaveClass('behind');
      await fireEvent.keyDown(window, { key: 'Escape' });
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      expect(getByRole('dialog', { name: 'Mailboxes' })).toBe(sheet);
      expect(sheet).not.toHaveClass('behind');
      // "Close" in the header of the second sheet.
      await fireEvent.click(within(sheet).getByRole('button', { name: 'Fix tags, 1 mismatch' }));
      await fireEvent.click(within(getByRole('dialog', { name: 'Fix tags' })).getByRole('button', { name: 'Close' }));
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      expect(sheet).toBeInTheDocument();
      // If "Mailboxes" closes with the second sheet open, it does not reopen by itself next time.
      await fireEvent.click(within(sheet).getByRole('button', { name: 'Fix tags, 1 mismatch' }));
      ui.closeMenu();
      await tick();
      ui.menu = 'folders';
      await tick();
      expect(getByRole('dialog', { name: 'Mailboxes' })).toBeInTheDocument();
      expect(queryByRole('dialog', { name: 'Fix tags' })).toBeNull();
      vi.stubGlobal('innerWidth', 1024);
      window.dispatchEvent(new Event('resize'));
    });

    describe('Create folder', () => {
      it('creates a folder via “New folder” in the sidebar and opens it', async () => {
        const { calls, server } = mockFix([TAGS]);
        const { findByRole, getByRole, queryByRole, goto } = renderAt('/mailbox/a1/inbox');
        await fireEvent.click(await findByRole('tab', { name: /Folders/ }));
        await fireEvent.click(await findByRole('button', { name: 'New folder' }));
        const dialog = getByRole('dialog', { name: 'New folder' });
        expect(dialog).toHaveTextContent('in account1@s1.test');
        const field = within(dialog).getByRole('textbox', { name: 'Name' });
        await vi.waitFor(() => expect(field).toHaveFocus());
        // While the dialog is open, the keyboard shortcuts have no effect.
        await fireEvent.keyDown(window, { key: '?' });
        expect(queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
        await fireEvent.input(field, { target: { value: 'Projects' } });
        await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
        await vi.waitFor(() => expect(ui.toast?.text).toBe('Folder “Projects” created'));
        expect(queryByRole('dialog', { name: 'New folder' })).toBeNull();
        const jmapCalls = calls.flatMap((c) => (c.body as { methodCalls?: [string, unknown][] })?.methodCalls ?? []);
        expect(jmapCalls.find(([name]) => name === 'Mailbox/set')?.[1]).toEqual({
          accountId: 'j1',
          create: { folder: { name: 'Projects', parentId: null, isSubscribed: true } },
        });
        expect(server.methods).toContain('Mailbox/changes');
        expect(mailboxes.tree('a1').map((f) => f.name)).toContain('Projects');
        expect(goto).toHaveBeenLastCalledWith('/mailbox/a1/f/new0');
      });

      it('opens “New folder” from the palette in the view account and closes with Escape', async () => {
        mockFix([TAGS]);
        const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
        await findByRole('tab', { name: /Folders/ });
        ui.openPalette('New folder');
        const palette = await vi.waitFor(() => getByRole('dialog', { name: 'Command palette' }));
        await fireEvent.click(within(palette).getByRole('button', { name: /^New folder/ }));
        const dialog = await findByRole('dialog', { name: 'New folder' });
        expect(dialog).toHaveTextContent('Top level');
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(queryByRole('dialog', { name: 'New folder' })).toBeNull();
      });

      it('closes only the dialog with Escape on mobile, “Mailboxes” below stays', async () => {
        vi.stubGlobal('innerWidth', 400);
        window.dispatchEvent(new Event('resize'));
        mockFix([TAGS]);
        const { findByRole, getByRole, queryByRole } = renderAt('/mailbox/a1/inbox');
        await vi.waitFor(() => expect(mailboxes.of('a1')?.status).toBe('ready'));
        ui.menu = 'folders';
        const sheet = await findByRole('dialog', { name: 'Mailboxes' });
        await fireEvent.click(within(sheet).getByRole('tab', { name: /Folders/ }));
        await fireEvent.click(within(sheet).getByRole('button', { name: 'New folder' }));
        expect(getByRole('dialog', { name: 'New folder' })).toBeInTheDocument();
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(queryByRole('dialog', { name: 'New folder' })).toBeNull();
        expect(getByRole('dialog', { name: 'Mailboxes' })).toBeInTheDocument();
        vi.stubGlobal('innerWidth', 1024);
        window.dispatchEvent(new Event('resize'));
      });
    });
  });
});
