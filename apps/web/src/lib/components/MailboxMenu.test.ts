import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import MailboxMenu from './MailboxMenu.svelte';
import { navItem, type MailboxMenuValues } from '#lib/shell.ts';

function values(patch: Partial<MailboxMenuValues> = {}): MailboxMenuValues {
  return {
    mFolderRows: [navItem('Inbox', 'ti-inbox', true, () => {}), navItem('Sent', 'ti-send', false, () => {})],
    sbTab: 'mail',
    inFolder: false,
    inTag: false,
    acctSw: {
      email: 'account1@s1.test',
      isAll: false,
      letter: 'A',
      open: false,
      sub: 'account1@s1.test',
      tip: undefined,
      title: 'account1',
      warn: false,
      tileBg: '#94c48d',
      tileInk: '#13300f',
    },
    allT2: [],
    addFShow: true,
    addTShow: true,
    onTab: () => {},
    toggleMSw: () => {},
    closeSheet: () => {},
    ...patch,
  };
}

const tree = createRawSnippet(() => ({ render: () => '<div data-testid="tree">Ordnerbaum</div>' }));

describe('mailboxes (mobile)', () => {
  it('shows title, tabs and the mailboxes of the account', async () => {
    const closeSheet = vi.fn();
    const open = vi.fn();
    const v = values({ closeSheet });
    v.mFolderRows[1]!.onClick = open;
    const { getByRole, getByText, getAllByRole } = render(MailboxMenu, v);
    expect(getByText('Mailboxes', { selector: '.title' })).toBeInTheDocument();
    const tabs = getByRole('tablist', { name: 'View' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.getAttribute('aria-label')),
    ).toEqual(['Mailboxes', 'Folders', 'Tags']);
    expect(within(tabs).getByRole('tab', { name: 'Mailboxes' })).toHaveAttribute('aria-selected', 'true');
    // On mobile the active tab is 2.4 times as wide.
    expect(tabs).toHaveStyle({ gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,1fr) minmax(0,1fr)' });

    const panels = getAllByRole('tabpanel', { hidden: true });
    expect(panels.map((p) => p.getAttribute('aria-hidden'))).toEqual(['false', 'true', 'true']);
    // Hidden panels rest faded out and at 96 %; the tab swipe overrides both while dragging.
    expect(panels[1]?.getAttribute('style')).toContain('opacity: var(--gp1o, 0)');
    expect(panels[1]?.getAttribute('style')).toContain('transform: var(--gp1t, scale(.96))');
    const inbox = getByRole('button', { name: 'Inbox' });
    expect(inbox).toHaveClass('on');
    expect(inbox).toHaveStyle({ fontWeight: '800' });
    expect(getByRole('button', { name: 'Sent' })).not.toHaveClass('on');
    await fireEvent.click(getByRole('button', { name: 'Sent' }));
    expect(open).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(closeSheet).toHaveBeenCalled();
  });

  it('switches the tab via onTab and shows the folder tree and "New folder"', async () => {
    const onTab = vi.fn();
    const addF = vi.fn();
    const addT = vi.fn();
    const { getByRole, getByTestId, getAllByRole, rerender } = render(MailboxMenu, {
      ...values({ onTab, addF, addT, inTag: true }),
      folders: tree,
    });
    await fireEvent.click(getByRole('tab', { name: 'Folders' }));
    expect(onTab).toHaveBeenCalledWith('folders');
    // Dot on the "Tags" tab while a tag is active and the tab is not selected.
    expect(getByRole('tab', { name: 'Tags' }).querySelector('.dot')).toHaveStyle({ opacity: '1' });
    expect(getByRole('tab', { name: 'Folders' }).querySelector('.dot')).toHaveStyle({ opacity: '0' });

    await rerender({ sbTab: 'folders' });
    expect(getByRole('tab', { name: 'Folders' })).toHaveAttribute('aria-selected', 'true');
    const panels = getAllByRole('tabpanel', { hidden: true });
    expect(panels.map((p) => p.getAttribute('aria-hidden'))).toEqual(['true', 'false', 'true']);
    expect(within(panels[1]!).getByTestId('tree')).toBe(getByTestId('tree'));
    await fireEvent.click(within(panels[1]!).getByRole('button', { name: 'New folder' }));
    expect(addF).toHaveBeenCalled();
    await rerender({ sbTab: 'tags' });
    await fireEvent.click(within(panels[2]!).getByRole('button', { name: 'New tag' }));
    expect(addT).toHaveBeenCalled();
  });

  it('shows "New folder" only with addFShow', () => {
    const { queryByRole } = render(MailboxMenu, values({ addFShow: false, sbTab: 'folders' }));
    expect(queryByRole('button', { name: 'New folder' })).toBeNull();
  });

  it('shows "New tag" only with addTShow', () => {
    const { queryByRole } = render(MailboxMenu, values({ addTShow: false, sbTab: 'tags' }));
    expect(queryByRole('button', { name: 'New tag' })).toBeNull();
  });

  it('opens "Switch account" via the account switch', async () => {
    const toggleMSw = vi.fn();
    const { getByRole } = render(MailboxMenu, values({ toggleMSw }));
    const sw = getByRole('button', { name: /account1@s1\.test/ });
    expect(sw).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(sw).getByText('Switch account')).toBeInTheDocument();
    expect(within(sw).getByText('A')).toBeInTheDocument();
    expect(sw.querySelector('.warn')).toBeNull();
    await fireEvent.click(sw);
    expect(toggleMSw).toHaveBeenCalled();
  });

  it('shows "All accounts" with tiles and the warning on the account', () => {
    const { getByRole } = render(
      MailboxMenu,
      values({
        acctSw: { ...values().acctSw, email: 'All accounts', isAll: true, letter: '', warn: true },
        allT2: [
          { letter: 'A', bg: '#94c48d', ink: '#13300f' },
          { letter: 'M', bg: '#e7b07a', ink: '#3d2208' },
        ],
      }),
    );
    const sw = getByRole('button', { name: /All accounts/ });
    expect(sw.querySelectorAll('.mini')).toHaveLength(2);
    expect(sw.querySelector('.warn')).not.toBeNull();
  });
});
