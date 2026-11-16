import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TabBar from './TabBar.svelte';
import { navItem } from '#lib/shell.ts';

describe('tab bar', () => {
  it('gives the active item a heavier font weight', () => {
    expect(navItem('Inbox', 'ti-inbox', true, () => {}).fw).toBe(800);
    expect(navItem('Compose', 'ti-pencil-plus', false, () => {}).fw).toBe(600);
  });

  it('shows four tabs and marks the active one', async () => {
    const more = vi.fn();
    const { getAllByRole, getByRole } = render(TabBar, {
      mTabsL: [navItem('Inbox', 'ti-inbox', true, () => {}), navItem('Search', 'ti-search', false, () => {})],
      mTabsR: [navItem('Compose', 'ti-pencil-plus', false, () => {}), navItem('More', 'ti-dots', false, more)],
    });
    expect(getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Inbox', 'Search', 'Compose', 'More']);
    expect(getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    await fireEvent.click(getByRole('button', { name: 'More' }));
    expect(more).toHaveBeenCalled();
  });
});
