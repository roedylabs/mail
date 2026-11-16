import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MfaOverview } from '#lib/security.svelte.ts';
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
  role: 'user',
  mfa_enabled: true,
  sole_admin: false,
  password_changed_at: '2026-10-20T12:00:00Z',
  email_change: null,
};
const MFA: MfaOverview = {
  devices: [{ id: 't1', name: 'iPhone', created_at: '2026-10-01T09:00:00Z', last_used_at: null }],
  recovery: { total: 10, unused: 10, created_at: '2026-10-01T09:00:00Z' },
};
const SESSIONS = [
  {
    id: 's0',
    current: true,
    device: 'Firefox on Linux',
    device_type: 'desktop',
    place: 'London, United Kingdom',
    ip: '203.0.113.0',
    created_at: '2026-10-26T08:00:00Z',
    last_seen_at: '2026-10-26T12:00:00Z',
  },
  {
    id: 's1',
    current: false,
    device: 'Safari on iPhone',
    device_type: 'mobile',
    place: null,
    ip: '2001:db8::',
    created_at: '2026-10-25T08:00:00Z',
    last_seen_at: '2026-10-26T10:00:00Z',
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
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

function renderPage(routes: Parameters<typeof mockApi>[0] = {}, mfa = MFA) {
  const api = mockApi({
    'GET auth/totp/devices': [{ body: mfa }, { body: mfa }],
    'GET auth/sessions': [{ body: { sessions: SESSIONS } }, { body: { sessions: SESSIONS } }],
    ...routes,
  });
  return { ...render(Page), ...api };
}

describe('Security page', () => {
  it('shows password, multi-factor, codes and devices', async () => {
    const view = renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Security');
    expect(await view.findByText('Last changed 6 days ago')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Multi-factor' })).toBeInTheDocument();
    expect(view.getByLabelText('Verification code')).toBeInTheDocument();
    expect(view.getByText('You’ll then be signed out on all other devices.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Change password' })).toHaveAttribute('aria-disabled', 'true');
    expect(view.getByText('Added on 01.10.2026')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Remove iPhone' })).toBeInTheDocument();
    expect(view.getByText('10 of 10 unused')).toBeInTheDocument();
    expect(view.getByText('London, United Kingdom · Active now')).toBeInTheDocument();
    expect(view.getByText('IP 2001:db8:: · Last active 2 hours ago')).toBeInTheDocument();
    expect(view.getByText('This device')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign out all other devices' })).toBeInTheDocument();
    // App passwords and API keys are not offered.
    expect(view.queryByText('API keys')).toBeNull();
  });

  it('adds an app with a QR code and then shows the codes', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `ABCD-EF${String(i + 2)}A`);
    const view = renderPage(
      {
        'POST auth/totp/devices/enroll': [
          {
            body: {
              id: 't1',
              secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
              uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
            },
          },
        ],
        'POST auth/totp/devices/confirm': [{ body: { ...MFA, recovery_codes: codes } }],
      },
      { devices: [], recovery: null },
    );
    expect(await view.findByText('No authenticator app set up yet')).toBeInTheDocument();
    expect(view.getByText('Generated once you add your first authenticator app.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Add authenticator app' }));
    expect(await view.findByRole('img', { name: 'QR code for the authenticator app' })).toBeInTheDocument();
    expect(view.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await fireEvent.input(view.getByPlaceholderText('e.g. iPhone'), { target: { value: 'iPhone' } });
    await fireEvent.input(view.getAllByLabelText('Current password')[1] as HTMLElement, {
      target: { value: 'Secret-123' },
    });
    await fireEvent.input(view.getAllByLabelText('Verification code')[0] as HTMLElement, {
      target: { value: '123456' },
    });
    await fireEvent.click(view.getByRole('button', { name: 'Add' }));
    const list = await view.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(ui.toast?.text).toBe('Multi-factor authentication turned on');
    await fireEvent.click(view.getByRole('button', { name: 'Done' }));
    expect(view.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });

  it('offers "Start over" when the setup was replaced in another window', async () => {
    const enroll = (id: string, secret: string) => ({ body: { id, secret, uri: `otpauth://totp/x?secret=${secret}` } });
    const view = renderPage(
      {
        'POST auth/totp/devices/enroll': [
          enroll('t1', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'),
          enroll('t2', 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU'),
        ],
        'POST auth/totp/devices/confirm': [
          { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
          { status: 404, body: { error: 'not_found' } },
        ],
      },
      { devices: [], recovery: null },
    );
    await view.findByText('Safari on iPhone');
    await fireEvent.click(view.getByRole('button', { name: 'Add authenticator app' }));
    expect(await view.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await fireEvent.input(view.getByPlaceholderText('e.g. iPhone'), { target: { value: 'Lap\u200Btop' } });
    await fireEvent.input(view.getAllByLabelText('Current password')[1] as HTMLElement, {
      target: { value: 'Secret-123' },
    });
    await fireEvent.input(view.getAllByLabelText('Verification code')[0] as HTMLElement, {
      target: { value: '123456' },
    });
    await fireEvent.click(view.getByRole('button', { name: 'Add' }));
    expect(await view.findByText('The name contains invalid characters.')).toBeInTheDocument();
    await fireEvent.input(view.getByPlaceholderText('e.g. iPhone'), { target: { value: 'Laptop' } });
    expect(view.queryByText('The name contains invalid characters.')).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Add' }));
    expect(await view.findByText('Setup was restarted in another window. Start it again here.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Start over' }));
    expect(await view.findByText('KRSX G5CT MVRX EZLU KRSX G5CT MVRX EZLU')).toBeInTheDocument();
    expect(view.getByPlaceholderText('e.g. iPhone')).toHaveValue('Laptop');
    expect(view.queryByRole('button', { name: 'Start over' })).toBeNull();
  });

  it('signs out a device with undo', async () => {
    const view = renderPage({ 'DELETE auth/sessions/s1': [{ status: 204 }] });
    await view.findByText('Safari on iPhone');
    await fireEvent.click(view.getByRole('button', { name: 'Sign out' }));
    expect(view.queryByText('Safari on iPhone')).toBeNull();
    expect(ui.toast).toMatchObject({ text: 'Device signed out', undo: true });
    ui.toasts.undo();
    expect(await view.findByText('Safari on iPhone')).toBeInTheDocument();
  });

  it('shows sign-out as an icon and "Sign out all others" on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    await view.findByText('Safari on iPhone');
    expect(view.getByText('Where you’re currently signed in.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign out all others' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Generate new codes' }));
    expect(view.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });

  it('shows the error page when loading fails', async () => {
    mockApi({
      'GET auth/totp/devices': [{ status: 500, body: {} }],
      'GET auth/sessions': [{ body: { sessions: SESSIONS } }],
    });
    const view = render(Page);
    expect(await view.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
