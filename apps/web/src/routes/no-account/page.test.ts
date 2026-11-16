import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '#lib/state/session.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  session.config = null;
  window.dispatchEvent(new Event('resize'));
});

describe('No account page', () => {
  it('explains what you need and leads to “Add email account”', async () => {
    const view = render(Page);
    expect(view.getByRole('heading', { name: 'Connect your first email account' })).toBeInTheDocument();
    expect(
      view.getByText(
        'Roedy Mail accesses your mailbox via JMAP. Once an account is connected, your inbox, folders, and tags will appear here.',
      ),
    ).toBeInTheDocument();
    expect(view.getByText('What you’ll need')).toBeInTheDocument();
    expect(view.getByText('Your email address')).toBeInTheDocument();
    expect(view.getByText('Password or app password')).toBeInTheDocument();
    expect(view.getByText('Suggested based on your email address')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Add email account' }));
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/new');
  });

  it('shows a card of its own with shorter text on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = render(Page);
    expect(view.container.querySelector('.no-account')).toHaveClass('mobile');
    expect(view.getByText(/Your inbox, folders, and tags will then appear here\./)).toBeInTheDocument();
    expect(view.queryByText('Suggested based on your email address')).toBeNull();
  });
});
