import { fireEvent, render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import FirstLoad from './FirstLoad.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>Content</p>' }));

function show(status: 'loading' | 'ready' | 'failed', slow = false, onRetry = () => {}) {
  return render(FirstLoad, {
    status,
    slow,
    title: 'Couldn’t load users',
    text: 'No connection. Please try again.',
    onRetry,
    isMobile: false,
    children,
  });
}

describe('first load of a settings page', () => {
  it('shows nothing below the head until the skeleton delay has passed', () => {
    const { container } = show('loading');
    expect(container.textContent?.trim()).toBe('');
  });

  it('shows the list skeleton with "Loading data …" while the request is slow', () => {
    const { getByRole, getByText, queryByText } = show('loading', true);
    expect(getByRole('status')).toHaveAttribute('aria-label', 'Loading data from the server');
    expect(getByText('Loading data …')).toBeInTheDocument();
    expect(queryByText('Content')).not.toBeInTheDocument();
  });

  it('shows the card with the reason and "Try again" instead of the content if the first load fails', async () => {
    const onRetry = vi.fn();
    const { getByRole, getByText, queryByText } = show('failed', false, onRetry);
    const card = getByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load users');
    expect(card).toHaveTextContent('No connection. Please try again.');
    expect(queryByText('Content')).not.toBeInTheDocument();
    await fireEvent.click(getByText('Try again'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows the content once loaded', () => {
    const { getByText, queryByRole } = show('ready', true);
    expect(getByText('Content')).toBeInTheDocument();
    expect(queryByRole('status')).not.toBeInTheDocument();
    expect(queryByRole('alert')).not.toBeInTheDocument();
  });
});
