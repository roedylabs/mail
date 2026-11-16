import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import ShortcutsDialog from './ShortcutsDialog.svelte';
import { shortcutsFor } from '#lib/keys.ts';

describe('keyboard shortcuts', () => {
  it('lists the shortcuts and closes', async () => {
    const closeHelp = vi.fn();
    const { getByRole, getByText, queryByText } = render(ShortcutsDialog, {
      shortcuts: shortcutsFor(false),
      closeHelp,
      onHelpOverlay: () => {},
    });
    expect(getByRole('dialog', { name: m.shortcuts_title() })).toHaveFocus();
    // jsdom reports no Apple system: Ctrl instead of ⌘.
    expect(getByText(m.shortcuts_palette()).nextElementSibling).toHaveTextContent('CtrlK');
    expect(queryByText(m.shortcuts_mailservers())).toBeNull();
    // The list scrolls and is therefore reachable via keyboard.
    const list = getByRole('region', { name: m.shortcuts_title() });
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list).toContainElement(getByText(m.shortcuts_palette()));
    await fireEvent.click(getByRole('button', { name: m.shell_close() }));
    expect(closeHelp).toHaveBeenCalled();
  });
});
