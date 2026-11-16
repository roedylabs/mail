import { fireEvent, render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Layout from './+layout.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/login'), params: {} },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));

const empty = createRawSnippet(() => ({ render: () => '<span></span>' }));

function renderAt(path: string, params: Record<string, string> = {}) {
  nav.page.url = new URL(`http://localhost${path}`);
  nav.page.params = params;
  return render(Layout, { children: empty, data: {}, params } as never);
}

afterEach(() => {
  nav.goto.mockClear();
  session.user = null;
  ui.reset();
});

describe('Login routes', () => {
  it('selects the step by the address', () => {
    expect(renderAt('/login').getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(renderAt('/password/forgot').getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
    const token = 'd'.repeat(64);
    expect(
      renderAt(`/password/reset/${token}`, { token }).getByRole('heading', { name: 'Set a new password' }),
    ).toBeInTheDocument();
  });

  it('follows step changes with the address', async () => {
    const view = renderAt('/login');
    await fireEvent.click(view.getByRole('link', { name: 'Forgot password?' }));
    // Without resetting the focus (`reset: false`), otherwise it would go to <body>.
    expect(nav.goto).toHaveBeenCalledWith('/password/forgot', { reset: false });
  });

  it('leads from /password/forgot to the start page when logged in', async () => {
    session.user = {
      id: '01J',
      username: 'alex',
      email: 'alex@example.net',
      display_name: 'Alex Example',
      role: 'user',
      mfa_enabled: false,
      sole_admin: false,
      password_changed_at: '2026-10-25T10:00:00Z',
      email_change: null,
    };
    const view = renderAt('/password/forgot');
    await fireEvent.click(view.getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(nav.goto).toHaveBeenCalledWith('/start');
  });
});
