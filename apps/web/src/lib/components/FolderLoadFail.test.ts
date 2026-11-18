import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FolderLoadFail from './FolderLoadFail.svelte';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { ui } from '#lib/state/ui.svelte.ts';

async function tipOf(el: Element): Promise<string | undefined> {
  vi.useFakeTimers();
  await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_DELAY);
  const text = ui.tip?.text;
  await fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  vi.useRealTimers();
  return text;
}

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
});

describe('failed first load of the folder tree', () => {
  it('shows one row button in an alert that tries again', async () => {
    const onRetry = vi.fn();
    const { getByRole } = render(FolderLoadFail, { lblOp: 1, onRetry });
    const alert = getByRole('alert');
    const button = getByRole('button', { name: 'Couldn’t load folders Try again' });
    expect(alert).toContainElement(button);
    expect(button.querySelector('.tile .tabler-icon-cloud-off')).not.toBeNull();
    expect(button.querySelector('.retry .tabler-icon-refresh')).not.toBeNull();
    expect(button).not.toHaveClass('collapsed');
    expect(await tipOf(button)).toBeUndefined();
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows only the tile with a tooltip in the collapsed sidebar', async () => {
    const { getByRole } = render(FolderLoadFail, { lblOp: 0, onRetry: () => {} });
    const button = getByRole('button');
    expect(button).toHaveClass('collapsed');
    expect((button.querySelector('.body') as HTMLElement).style.opacity).toBe('0');
    expect(await tipOf(button)).toBe('Couldn’t load folders. Try again');
  });
});
