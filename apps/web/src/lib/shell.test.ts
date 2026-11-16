import { describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import {
  folderRows,
  type FolderHeadRow,
  type FolderItemRow,
  type FolderRow,
  type FolderTreeAccount,
  type FolderTreeInput,
  type FolderTreeTexts,
} from '#lib/shell.ts';
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

// Customers › (Alpha › Old), Beta; Projects; Archive (folder names of the fixture)
const TREE = [
  node('k', 'Customers', 2, 5, [node('a', 'Alpha', 1, 3, [node('x', 'Old', 0, 0)]), node('b', 'Beta', 0, 2)]),
  node('p', 'Projects', 0, 0),
  node('r', 'Archive', 0, 4),
];

function account(id: string, email: string, tree: FolderNode[] = TREE): FolderTreeAccount {
  return { id, email, letter: email[0]!.toUpperCase(), bg: '#94c48d', ink: '#13300f', tree };
}

function input(patch: Partial<FolderTreeInput> & { open?: string[]; openAccounts?: string[] } = {}): FolderTreeInput {
  const { open = [], openAccounts = [], ...rest } = patch;
  return {
    accounts: [account('m1', 'account1@s1.test')],
    allMode: false,
    full: true,
    mob: false,
    active: null,
    isOpen: (a, id) => open.includes(`${a}/${id}`),
    toggle: vi.fn(),
    isAccountOpen: (a) => openAccounts.includes(a),
    toggleAccount: vi.fn(),
    select: vi.fn(),
    ...rest,
  };
}

const items = (rows: FolderRow[]): FolderItemRow[] => rows.filter((r): r is FolderItemRow => r.row);
const labels = (rows: FolderRow[]): string[] => items(rows).map((r) => r.label);
const byLabel = (rows: FolderRow[], label: string): FolderItemRow => items(rows).find((r) => r.label === label)!;

describe('folderRows', () => {
  it('shows only the top level with counters when collapsed', () => {
    const v = folderRows(input(), TEXTS);
    expect(v).toMatchObject({ fNone: false, ftLblOp: 1 });
    expect(labels(v.fRows)).toEqual(['Customers', 'Projects', 'Archive']);
    expect(byLabel(v.fRows, 'Customers')).toMatchObject({
      key: 'm1/k',
      sub: false,
      kids: true,
      icon: 'ti-folder',
      bIcon: 'ti-plus',
      tileExp: false,
      tileLabel: 'Show subfolders',
      tileTip: 'Show subfolders',
      tip: undefined,
      hasCnt: true,
      cntU: '2',
      cntN: '5',
      cntLabel: '2 unread of 5',
      bl: '0px',
      pl: '7px',
      gap: '13px',
      tw: '34px',
      isz: '19px',
      fs: '15px',
      rr: '17px',
      h: 'var(--rowh, 46px)',
      lines: [],
      cont: false,
      dot: false,
    });
    expect(byLabel(v.fRows, 'Projects')).toMatchObject({
      kids: false,
      hasCnt: false,
      tileExp: undefined,
      tileLabel: 'Projects',
      tileTip: undefined,
    });
  });

  it('indents subfolders and draws the lines', () => {
    const v = folderRows(input({ open: ['m1/k', 'm1/a'] }), TEXTS);
    expect(labels(v.fRows)).toEqual(['Customers', 'Alpha', 'Old', 'Beta', 'Projects', 'Archive']);
    expect(byLabel(v.fRows, 'Customers')).toMatchObject({
      icon: 'ti-folder-open',
      bIcon: 'ti-minus',
      tileExp: true,
      tileLabel: 'Hide subfolders',
    });
    expect(byLabel(v.fRows, 'Alpha')).toMatchObject({
      sub: true,
      first: true,
      cont: true,
      bl: '35px',
      ex: '24px',
      pl: '0px',
      gap: '9px',
      tw: '24px',
      isz: '15px',
      fs: '14px',
      rr: '13px',
      h: 'calc(var(--rowh, 46px) - 8px)',
      lines: [],
    });
    expect(byLabel(v.fRows, 'Old')).toMatchObject({
      first: true,
      cont: false,
      bl: '58px',
      ex: '47px',
      lines: [{ x: '24px' }],
    });
    expect(byLabel(v.fRows, 'Beta')).toMatchObject({ first: false, cont: false, ex: '24px', lines: [] });
  });

  it('marks the active folder and collapsed ancestors', () => {
    const closed = folderRows(input({ active: { account: 'm1', folder: 'x' } }), TEXTS);
    expect(byLabel(closed.fRows, 'Customers')).toMatchObject({ sel: false, inside: true, fw: 800 });
    expect(byLabel(closed.fRows, 'Projects')).toMatchObject({ inside: false, fw: 600 });

    const half = folderRows(input({ active: { account: 'm1', folder: 'x' }, open: ['m1/k'] }), TEXTS);
    expect(byLabel(half.fRows, 'Customers')).toMatchObject({ inside: false, fw: 600, icon: 'ti-folder-open' });
    expect(byLabel(half.fRows, 'Alpha')).toMatchObject({ inside: true, fw: 800 });

    // When collapsed, subfolders are not visible: the expanded ancestor counts as closed.
    const narrow = folderRows(input({ active: { account: 'm1', folder: 'x' }, open: ['m1/k'], full: false }), TEXTS);
    expect(byLabel(narrow.fRows, 'Customers')).toMatchObject({ inside: true, fw: 800, icon: 'ti-folder' });
    expect([closed.inFolder, narrow.inFolder]).toEqual([true, true]);
    expect(folderRows(input({ active: { account: 'm1', folder: 'missing' } }), TEXTS).inFolder).toBe(false);

    const sel = folderRows(input({ active: { account: 'm1', folder: 'b' }, open: ['m1/k'] }), TEXTS);
    expect(byLabel(sel.fRows, 'Beta')).toMatchObject({
      sel: true,
      inside: false,
      fw: 800,
      bg: 'var(--surface)',
      sh: 'var(--sh1)',
      hoverBg: 'var(--surface)',
    });
    expect(byLabel(sel.fRows, 'Customers')).toMatchObject({
      sel: false,
      inside: false,
      bg: 'transparent',
      hoverBg: 'var(--hov)',
    });

    const mob = folderRows(input({ active: { account: 'm1', folder: 'r' }, mob: true }), TEXTS);
    expect(byLabel(mob.fRows, 'Archive')).toMatchObject({
      bg: 'var(--accsoft)',
      sh: 'none',
      h: 'calc(var(--rowh, 46px) + 6px)',
    });
    expect(byLabel(mob.fRows, 'Archive')).toMatchObject({ fs: '15.5px', rr: '18px' });

    // Another account with the same folder id is not active.
    const other = folderRows(input({ active: { account: 'm2', folder: 'k' } }), TEXTS);
    expect(items(other.fRows).some((r) => r.sel || r.inside)).toBe(false);
  });

  it('shows only the top level with tooltips and dot when collapsed', () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const v = folderRows(input({ full: false, open: ['m1/k'], select, toggle }), TEXTS);
    expect(v.ftLblOp).toBe(0);
    expect(labels(v.fRows)).toEqual(['Customers', 'Projects', 'Archive']);
    const kunden = byLabel(v.fRows, 'Customers');
    expect(kunden).toMatchObject({
      tip: 'Customers',
      tileTip: 'Customers',
      tileLabel: 'Customers',
      tileExp: undefined,
      dot: true,
    });
    expect(byLabel(v.fRows, 'Archive').dot).toBe(false);
    kunden.tileClick();
    expect(select).toHaveBeenCalledWith('m1', 'k');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('expands via the tile and selects via the row', () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const v = folderRows(input({ select, toggle }), TEXTS);
    byLabel(v.fRows, 'Customers').tileClick();
    expect(toggle).toHaveBeenCalledWith('m1', 'k');
    byLabel(v.fRows, 'Customers').onClick();
    byLabel(v.fRows, 'Projects').tileClick();
    expect(select.mock.calls).toEqual([
      ['m1', 'k'],
      ['m1', 'p'],
    ]);
  });

  it('shows headers and "New folder" per account in "All accounts"', () => {
    const toggleAccount = vi.fn();
    const addFolder = vi.fn();
    const v = folderRows(
      input({
        allMode: true,
        accounts: [account('m1', 'account1@s1.test', [node('p', 'Projects', 0, 0)]), account('m2', 'second@s2.test')],
        openAccounts: ['m1'],
        toggleAccount,
        addFolder,
      }),
      TEXTS,
    );
    expect(v.fRows.map((r) => r.key)).toEqual(['head:m1', 'm1/p', 'add:m1', 'head:m2']);
    const [h1, , add, h2] = v.fRows as [FolderHeadRow, FolderItemRow, FolderRow, FolderHeadRow];
    expect(h1).toMatchObject({
      letter: 'A',
      email: 'account1@s1.test',
      mt: '0px',
      chevT: 'none',
      expanded: true,
      tip: undefined,
    });
    expect(h2).toMatchObject({ letter: 'S', mt: '10px', chevT: 'rotate(-90deg)', expanded: false });
    expect(add).toMatchObject({ add: true, h: 'var(--rowh, 46px)', rr: '17px', fs: '14.5px', tip: undefined });
    h2.toggle();
    expect(toggleAccount).toHaveBeenCalledWith('m2');
    if (add.add) add.onClick();
    expect(addFolder).toHaveBeenCalledWith('m1');

    const narrow = folderRows(input({ allMode: true, full: false, openAccounts: ['m1'] }), TEXTS);
    expect(narrow.fRows[0]).toMatchObject({ head: true, tip: 'account1@s1.test' });
    expect(narrow.fRows.at(-1)).toMatchObject({ add: true, tip: 'New folder in account1@s1.test' });
    // Without `addFolder` the click has no effect.
    const last = narrow.fRows.at(-1)!;
    expect(() => last.add && last.onClick()).not.toThrow();
  });

  it('reports an empty tree', () => {
    expect(folderRows(input({ accounts: [account('m1', 'account1@s1.test', [])] }), TEXTS).fNone).toBe(true);
    expect(folderRows(input({ accounts: [] }), TEXTS)).toEqual({ fRows: [], fNone: true, ftLblOp: 1, inFolder: false });
    expect(folderRows(input({ allMode: true, accounts: [account('m1', 'account1@s1.test', [])] }), TEXTS).fNone).toBe(
      false,
    );
  });
});
