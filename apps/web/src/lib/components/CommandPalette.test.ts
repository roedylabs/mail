import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette.svelte';
import { paletteRows, type Command } from '#lib/shell.ts';

const run = vi.fn();
const COMMANDS: Command[] = [
  { g: 'Actions', label: 'New email', icon: 'ti-pencil-plus', k: 'C', run },
  { g: 'Settings', label: 'Open settings', icon: 'ti-settings', k: ',', run },
  { g: 'Settings', label: 'Switch to light theme', icon: 'ti-sun', run },
  { g: 'Help', label: 'Show keyboard shortcuts', icon: 'ti-keyboard', k: '?', run },
];

const ctx = (close = vi.fn(), select = vi.fn()) => ({
  search: (q: string): Command => ({ g: 'Search', label: `Search Roedy Mail for "${q}"`, icon: 'ti-search', run }),
  close,
  select,
});

describe('command palette', () => {
  it('groups, filters and puts the search first', () => {
    const rows = paletteRows(COMMANDS, '', 0, ctx());
    expect(rows.map((r) => r.hasHdr)).toEqual([true, true, false, true]);
    expect(rows[0]).toMatchObject({ sel: true, hasKey: true, k: 'C' });
    const found = paletteRows(COMMANDS, ' sett ', 5, ctx());
    expect(found.map((r) => r.label)).toEqual(['Search Roedy Mail for "sett"', 'Open settings']);
    // Selection stays in the list.
    expect(found[1]?.sel).toBe(true);
  });

  it('closes before running and selects on hover', () => {
    const close = vi.fn();
    const select = vi.fn();
    const rows = paletteRows(COMMANDS, '', 0, ctx(close, select));
    rows[1]?.run();
    expect(close).toHaveBeenCalledBefore(run);
    rows[2]?.hover();
    expect(select).toHaveBeenCalledWith(2);
    rows[0]?.hover();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('shows the search field with focus, rows and the empty state', async () => {
    const onPalQ = vi.fn();
    const rows = paletteRows(COMMANDS, '', 0, ctx());
    const view = render(CommandPalette, {
      palQ: '',
      palRows: rows,
      palEmpty: false,
      onPalQ,
      onPalKey: () => {},
      onPalOverlay: () => {},
    });
    const input = view.getByPlaceholderText('What would you like to do?');
    expect(input).toHaveFocus();
    expect(view.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(view.getAllByText('Settings')).toHaveLength(1);
    await fireEvent.input(input, { target: { value: 'x' } });
    expect(onPalQ).toHaveBeenCalled();
    await view.rerender({
      palQ: 'xyz',
      palRows: [],
      palEmpty: true,
      onPalQ,
      onPalKey: () => {},
      onPalOverlay: () => {},
    });
    expect(view.getByText('No commands found')).toBeInTheDocument();
  });
});
