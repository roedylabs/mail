import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NavMenu from './NavMenu.svelte';
import { hideTooltip, TIP_LONG_PRESS } from '#lib/actions/tooltip.ts';
import { navItem } from '#lib/shell.ts';
import { ui } from '#lib/state/ui.svelte.ts';

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
});

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

  it('shows the tooltip "Close" on the close button after a long press', async () => {
    const { getByRole } = render(NavMenu, { mNavTitle: 'More', mExtraRows: [], closeSheet: () => {} });
    const close = getByRole('button', { name: 'Close' });
    vi.useFakeTimers();
    await fireEvent.pointerDown(close, { pointerType: 'touch', clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(TIP_LONG_PRESS);
    expect(ui.tip).toMatchObject({ text: 'Close' });
  });
});
