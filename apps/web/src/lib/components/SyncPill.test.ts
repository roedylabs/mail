import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import SyncPill from './SyncPill.svelte';

describe('sync pill', () => {
  it('shows text and accounts on desktop', () => {
    const { getByRole } = render(SyncPill, {
      isMobile: false,
      syncText: 'Syncing accounts …',
      syncSub: '2 accounts',
    });
    expect(getByRole('status')).toHaveClass('desk');
    expect(getByRole('status')).toHaveTextContent('Syncing accounts …2 accounts');
  });

  it('shows only the text on mobile', () => {
    const { getByRole } = render(SyncPill, {
      isMobile: true,
      syncText: 'Syncing accounts …',
      syncSub: '2 accounts',
    });
    expect(getByRole('status')).toHaveClass('mobile');
    expect(getByRole('status')).not.toHaveTextContent('2 accounts');
  });
});
