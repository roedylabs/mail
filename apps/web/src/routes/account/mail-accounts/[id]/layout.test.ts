import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import Layout from './+layout.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/account/mail-accounts/a1/overview'), params: {} },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));

const child = createRawSnippet(() => ({ render: () => '<span>Content</span>' }));

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

function renderAt(path: string) {
  nav.page.url = new URL(`http://localhost${path}`);
  return render(Layout, { children: child } as never);
}

afterEach(() => {
  nav.goto.mockClear();
  accounts.reset();
  vi.unstubAllGlobals();
  window.dispatchEvent(new Event('resize'));
});

describe('Header of the pages of a mail account', () => {
  it('shows address, title and description of the subpage above the content on desktop', () => {
    accounts.list = [account()];
    const view = renderAt('/account/mail-accounts/a1/vacation');
    expect(view.getByText('account1@s1.test')).toHaveClass('addr');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Vacation reply');
    expect(view.getByText('Automatic reply while you’re away.')).toBeInTheDocument();
    expect(view.getByText('Content')).toBeInTheDocument();
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('shows only title and description on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    accounts.list = [account()];
    const view = renderAt('/account/mail-accounts/a1/connection');
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(view.getByText('Server, sign-in, and account removal.')).toHaveClass('m-lead');
    expect(view.queryByText('account1@s1.test')).toBeNull();
  });
});
