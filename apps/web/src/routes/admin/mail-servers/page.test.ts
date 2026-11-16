import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import type { AdminServer } from '#lib/servers.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const NOW = Date.parse('2026-10-26T12:00:00Z');
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
  password_changed_at: '2026-10-20T10:00:00Z',
  email_change: null,
  system_mail_configured: true,
};
const base = { client_id: null, has_secret: false, reach: 'unk', cors: 'unk', oauth: 'unk', tested_at: null } as const;
const SERVERS: AdminServer[] = [
  {
    ...base,
    id: 's1',
    label: 'VPS 1',
    url: 'https://mail.s1.test',
    host: 'mail.s1.test',
    domains: ['s1.test'],
    client_id: 'roedy-abc123',
    reach: 'ok',
    cors: 'ok',
    oauth: 'ok',
    tested_at: new Date(NOW - 25 * 60_000).toISOString(),
  },
  { ...base, id: 'sdev', label: 'Development', url: 'http://localhost:8080', host: 'localhost:8080', domains: [] },
];
const LIST = { servers: SERVERS, redirect_uri: 'https://app.example.com/oauth/callback', system_mail_server: 's1' };
const POLICY = { allow_custom_servers: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

function renderPage(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET admin/servers': [{ body: LIST }, { body: LIST }],
    'GET admin/servers/policy': [{ body: POLICY }, { body: POLICY }],
    ...routes,
  });
  return { ...render(Page), ...api };
}

describe('Mail servers page', () => {
  it('shows heading, tabs, servers with badges and the policy', async () => {
    const view = renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Mail servers');
    expect(view.getByText('Allowed JMAP servers and OAuth clients')).toBeInTheDocument();
    expect(await view.findByText('VPS 1')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Policy' })).toBeInTheDocument();
    expect(view.getByText('2 servers')).toBeInTheDocument();
    expect(view.getByText('System emails')).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Unencrypted. Only for development on this machine.' })).toBeInTheDocument();
    expect(view.getByRole('img', { name: 'Reachable: OK' })).toBeInTheDocument();
    expect(view.getAllByRole('img', { name: 'Reachable: unknown' })).toHaveLength(1);
    expect(view.getByText('https://mail.s1.test · No linked accounts')).toBeInTheDocument();
    expect(view.getByText('None. Users choose the server themselves.')).toBeInTheDocument();
    expect(view.getByText('Last tested 25 min ago')).toBeInTheDocument();
    expect(view.getByRole('switch', { name: 'Users can enter their own server URLs' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(view.getByText('https://app.example.com/oauth/callback')).toBeInTheDocument();
  });

  it('tests the connection and expands the diagnosis', async () => {
    const view = renderPage({
      'POST admin/servers/sdev/test': [
        {
          body: {
            server: { ...SERVERS[1], reach: 'err', tested_at: new Date(NOW).toISOString() },
            reasons: { reach: 'unreachable' },
          },
        },
      ],
    });
    await view.findByText('Development');
    const buttons = view.getAllByRole('button', { name: 'Test connection' });
    await fireEvent.click(buttons[1] as HTMLElement);
    const region = await view.findByRole('region', { name: 'Diagnostics for Development' });
    await vi.waitFor(() => expect(within(region).getByText('JMAP session')).toBeInTheDocument());
    expect(within(region).getAllByText('Not checked because the server isn’t reachable.')).toHaveLength(2);
    expect(ui.toast?.text).toBe('Development: test finished with warnings');
    await fireEvent.click(view.getByRole('button', { name: 'Hide diagnostics' }));
    expect(view.queryByRole('region')).toBeNull();
  });

  it('asks before removing and toggles the policy', async () => {
    const view = renderPage({
      'DELETE admin/servers/sdev': [{ status: 204 }],
      'PUT admin/servers/policy': [{ body: { allow_custom_servers: true } }],
    });
    await view.findByText('Development');
    await fireEvent.click(view.getByRole('button', { name: 'Remove Development' }));
    expect(ui.confirm?.title).toBe(m.server_remove_title({ label: 'Development' }));
    ui.confirmOk();
    await vi.waitFor(() => expect(view.queryByText('Development')).toBeNull());
    await fireEvent.click(view.getByRole('switch'));
    expect(view.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(ui.toast?.text).toBe('Custom server URLs allowed');
  });

  it('passes the dialog values to the layout and opens it from the palette', async () => {
    ui.serverAdd = true;
    const view = renderPage();
    await view.findByText('VPS 1');
    expect(ui.serverAdd).toBe(false);
    expect(ui.pageDialog?.()?.title).toBe('Add server');
    ui.pageDialog?.()?.close();
    expect(ui.pageDialog?.()).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Edit VPS 1' }));
    expect(ui.pageDialog?.()?.title).toBe('Edit server');
    // Already open: the palette opens the dialog anyway.
    ui.pageDialog?.()?.close();
    ui.serverAdd = true;
    await vi.waitFor(() => expect(ui.pageDialog?.()?.title).toBe('Add server'));
    view.unmount();
    expect(ui.pageDialog).toBeNull();
  });

  it('shows "No mail server yet" without servers', async () => {
    const empty = { body: { ...LIST, servers: [], system_mail_server: null } };
    const view = renderPage({ 'GET admin/servers': [empty] });
    expect(await view.findByText('No mail server yet')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Add your first server' }));
    expect(ui.pageDialog?.()?.title).toBe('Add server');
  });

  it('shows host, "Unencrypted" notice and actions below the row on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    await view.findByText('VPS 1');
    expect(view.getByText('mail.s1.test · No linked accounts')).toBeInTheDocument();
    expect(view.getByText('Unencrypted. Only for development on this machine.')).toBeInTheDocument();
    expect(view.getByText('Users can only connect their accounts to these servers.')).toBeInTheDocument();
    expect(view.getByText('Allow custom server URLs')).toBeInTheDocument();
    expect(view.queryByText('2 servers')).toBeNull();
    expect(view.getAllByRole('button', { name: 'Add server' })).toHaveLength(1);
  });

  it('shows the error page when the list does not load, and reloads', async () => {
    const view = renderPage({
      'GET admin/servers': [{ status: 500, body: { error: 'internal' } }, { body: LIST }],
    });
    expect(await view.findByText('Something went wrong')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('VPS 1')).toBeInTheDocument();
  });
});
