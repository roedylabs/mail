import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FolderTree from './FolderTree.svelte';
import { m } from '#lib/paraglide/messages.js';
import { folderRows, type FolderTreeInput, type FolderTreeTexts } from '#lib/shell.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';

const TEXTS: FolderTreeTexts = {
  expand: m.folders_expand(),
  collapse: m.folders_collapse(),
  newIn: (email) => m.folders_new_in({ email }),
  count: (unread, total) => m.mailbox_count({ unread, total }),
};

const node = (id: string, name: string, unread: number, total: number, children: FolderNode[] = []): FolderNode => ({
  id,
  name,
  unread,
  total,
  children,
});

const TREE = [node('k', 'Customers', 2, 5, [node('a', 'Alpha', 0, 3)]), node('p', 'Projects', 0, 0)];

function input(patch: Partial<FolderTreeInput> = {}): FolderTreeInput {
  return {
    accounts: [{ id: 'm1', email: 'account1@s1.test', letter: 'A', bg: '#94c48d', ink: '#13300f', tree: TREE }],
    allMode: false,
    full: true,
    mob: false,
    active: null,
    isOpen: () => false,
    toggle: vi.fn(),
    isAccountOpen: () => true,
    toggleAccount: vi.fn(),
    select: vi.fn(),
    ...patch,
  };
}

describe('folder tree', () => {
  it('shows folders with counters and selects via the row', async () => {
    const select = vi.fn();
    const { getByText, getByLabelText, queryByText, container } = render(
      FolderTree,
      folderRows(input({ select, active: { account: 'm1', folder: 'p' } }), TEXTS),
    );
    expect(getByText('Customers')).toBeInTheDocument();
    expect(queryByText('Alpha')).toBeNull();
    expect(getByLabelText('2 unread of 5')).toBeInTheDocument();
    expect(container.querySelector('.tree')).toHaveInlineStyle({ '--lbl-op': '1', '--sb-bg': 'var(--cnv)' });
    expect(getByText('Projects').closest('.item')).toHaveClass('sel');
    await fireEvent.click(getByText('Customers'));
    expect(select).toHaveBeenCalledWith('m1', 'k');
  });

  it('expands subfolders via the tile', async () => {
    const toggle = vi.fn();
    const { getByRole, getByText } = render(FolderTree, folderRows(input({ toggle, isOpen: () => true }), TEXTS));
    const tile = getByRole('button', { name: 'Hide subfolders' });
    expect(tile).toHaveAttribute('aria-expanded', 'true');
    expect(getByText('Alpha').closest('.item')).toHaveClass('sub');
    await fireEvent.click(tile);
    expect(toggle).toHaveBeenCalledWith('m1', 'k');
  });

  it('selects via the tile when collapsed too', async () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const { getByRole, container } = render(FolderTree, {
      ...folderRows(input({ full: false, select, toggle }), TEXTS),
      sbBg: 'var(--pop)',
    });
    expect(container.querySelector('.tree')).toHaveInlineStyle({ '--lbl-op': '0', '--sb-bg': 'var(--pop)' });
    const tile = getByRole('button', { name: 'Customers' });
    expect(tile).not.toHaveAttribute('aria-expanded');
    expect(tile.querySelector('.dot')).toHaveClass('on');
    await fireEvent.click(tile);
    expect(select).toHaveBeenCalledWith('m1', 'k');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows header row and "New folder" in "All accounts"', async () => {
    const toggleAccount = vi.fn();
    const addFolder = vi.fn();
    const { getByText } = render(FolderTree, folderRows(input({ allMode: true, toggleAccount, addFolder }), TEXTS));
    const head = getByText('account1@s1.test').closest('button')!;
    expect(head).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.click(head);
    expect(toggleAccount).toHaveBeenCalledWith('m1');
    await fireEvent.click(getByText('New folder'));
    expect(addFolder).toHaveBeenCalledWith('m1');
  });

  it('shows the empty state', () => {
    const { getByText } = render(FolderTree, folderRows(input({ accounts: [] }), TEXTS));
    expect(getByText('No folders yet')).toBeInTheDocument();
  });
});
