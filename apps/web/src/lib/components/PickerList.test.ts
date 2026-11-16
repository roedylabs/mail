import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PickerList from './PickerList.svelte';

describe('picker list', () => {
  it('shows title and options and selects', async () => {
    const choose = vi.fn();
    const closeSheet = vi.fn();
    const view = render(PickerList, {
      pick: {
        title: 'Role for 2 people',
        opts: [
          {
            label: 'Administrator',
            sub: 'Manages users and settings',
            hasSub: true,
            on: false,
            fw: 600,
            onClick: choose,
          },
          { label: 'User', sub: '', hasSub: false, on: true, fw: 800, onClick: () => {} },
        ],
      },
      closeSheet,
    });
    const list = view.getByRole('listbox', { name: 'Role for 2 people' });
    expect(list).toBeInTheDocument();
    expect(view.getByRole('option', { name: /^User/ })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByText('Manages users and settings')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('option', { name: /Administrator/ }));
    expect(choose).toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(closeSheet).toHaveBeenCalled();
  });
});
