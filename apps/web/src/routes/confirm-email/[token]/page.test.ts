import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/confirm-email/tok'), params: { token: 'tok' } },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: {
    name: null,
    website: null,
    help: null,
    email: null,
    imprint: 'https://example.com/imprint',
    privacy: null,
    terms: null,
    source: null,
  },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};

beforeEach(() => {
  session.config = CONFIG;
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
});

describe('Confirm email address page', () => {
  it('shows only the skeleton of the card until the check answers', async () => {
    let answer: (value: { body: unknown }) => void = () => {};
    mockApi({ 'POST auth/email/check': [() => new Promise((resolve) => (answer = resolve))] });
    const view = render(Page);
    const busy = view.getByRole('status', { name: 'Checking …' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.closest('.card')).not.toBeNull();
    expect(view.queryByRole('heading', { level: 1 })).toBeNull();
    answer({ body: { state: 'valid', email: 'new@example.com', own_session: false } });
    expect(await view.findByRole('heading', { name: 'Confirm new email address' })).toBeInTheDocument();
    expect(view.queryByRole('status', { name: 'Checking …' })).toBeNull();
  });

  it('confirms only via the button and leads guests to the login', async () => {
    const { calls } = mockApi({
      'POST auth/email/check': [{ body: { state: 'valid', email: 'new@example.com', own_session: false } }],
      'POST auth/email/confirm': [{ body: { state: 'confirmed', email: 'new@example.com', own_session: false } }],
    });
    const view = render(Page);
    expect(await view.findByRole('heading', { name: 'Confirm new email address' })).toBeInTheDocument();
    expect(view.getByText('new@example.com')).toBeInTheDocument();
    expect(
      view.getByText(
        'Once confirmed, your Roedy Mail account will use this address. Until then, your current address remains valid.',
      ),
    ).toBeInTheDocument();
    expect(calls.map((c) => [c.path, c.body])).toEqual([['auth/email/check', { token: 'tok' }]]);
    await fireEvent.click(view.getByRole('button', { name: 'Confirm email address' }));
    expect(await view.findByRole('heading', { name: 'Email address confirmed' })).toBeInTheDocument();
    expect(view.getByRole('status')).toHaveTextContent('Your Roedy Mail account now uses this address.');
    await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    expect(nav.goto).toHaveBeenCalledWith('/login');
    expect(view.getByRole('link', { name: 'Legal notice' })).toHaveAttribute('href', 'https://example.com/imprint');
  });

  it('shows “Link expired or invalid” when signed in with the way to the profile', async () => {
    session.user = {
      id: 'u0',
      username: 'alex',
      email: 'alex@example.com',
      display_name: 'Alex',
      role: 'user',
      mfa_enabled: false,
      sole_admin: false,
      password_changed_at: '2026-10-01T10:00:00Z',
      email_change: null,
    };
    mockApi({ 'POST auth/email/check': [{ body: { state: 'invalid', own_session: true } }] });
    const view = render(Page);
    expect(await view.findByRole('heading', { name: 'Link expired or invalid' })).toBeInTheDocument();
    expect(view.getByText('You can request a new link under Account › Profile.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Go to profile' }));
    expect(nav.goto).toHaveBeenCalledWith('/account/profile');
  });

  it('shows “Already confirmed” with the address', async () => {
    mockApi({
      'POST auth/email/check': [{ body: { state: 'already_confirmed', email: 'new@example.com', own_session: false } }],
    });
    const view = render(Page);
    expect(await view.findByRole('heading', { name: 'Already confirmed' })).toBeInTheDocument();
    expect(view.getByRole('status')).toHaveTextContent(
      'The email address new@example.com has already been confirmed. There’s nothing else you need to do.',
    );
  });

  it('switches the theme in the browser and shows the error page on an error', async () => {
    mockApi({
      'POST auth/email/check': [{ body: { state: 'invalid', own_session: false } }, { status: 500, body: {} }],
    });
    const view = render(Page);
    await view.findByRole('heading', { name: 'Link expired or invalid' });
    const dark = ui.dark;
    await fireEvent.click(view.getByRole('button', { name: dark ? 'Light theme' : 'Dark theme' }));
    expect(ui.dark).toBe(!dark);
    view.unmount();
    const again = render(Page);
    expect(await again.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('locks “Try again” after 429: faded, focusable and without the hover lift', async () => {
    mockApi({
      'POST auth/email/check': [{ status: 429, body: { error: 'rate_limited', retry_after: 300 } }],
    });
    const view = render(Page);
    const button = await view.findByRole('button', { name: 'Try again in 5:00' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveClass('retry', 'locked');
  });
});
