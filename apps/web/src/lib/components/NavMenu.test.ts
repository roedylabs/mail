import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NavMenu from './NavMenu.svelte';
import { navItem } from '#lib/shell.ts';

describe('navigation "More"', () => {
  it('shows title, entries and close', async () => {
    const settings = vi.fn();
    const closeSheet = vi.fn();
    const { getByText, getByRole } = render(NavMenu, {
      mNavTitle: 'More',
      mExtraRows: [
        navItem('Settings', 'ti-settings', false, settings),
        navItem('Apps', 'ti-grid-dots', false, () => {}),
      ],
      closeSheet,
    });
    expect(getByText('More')).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Settings' }));
    expect(settings).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(closeSheet).toHaveBeenCalled();
  });
});
