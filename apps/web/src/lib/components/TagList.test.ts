import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TagList from './TagList.svelte';
import { m } from '#lib/paraglide/messages.js';
import { tagRows, type TagListInput, type TagListTexts, type TagRow } from '#lib/shell.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';

const TEXTS: TagListTexts = {
  expand: m.tags_expand(),
  collapse: m.tags_collapse(),
  count: (unread, total) => m.mailbox_count({ unread, total }),
  warnOne: (email) => m.tags_warn_one({ email }),
  warnMany: (count) => m.tags_warn({ count }),
  fix: m.tagfix_title(),
  fixAria: (count) => (count === 1 ? m.tagfix_aria_one() : m.tagfix_aria({ count })),
};

const node = (
  id: string,
  name: string,
  color: number,
  unread: number,
  total: number,
  children: TagNode[] = [],
): TagNode => ({ id, name, color, unread, total, children });

// Important › (Customers › Alpha, Beta); Personal; Travel
const TREE = [
  node('w', 'Important', 0, 1, 2, [
    node('k', 'Customers', 0, 1, 2, [node('a', 'Alpha', 3, 0, 0)]),
    node('b', 'Beta', 0, 0, 0),
  ]),
  node('p', 'Personal', 4, 0, 3),
  node('r', 'Travel', 99, 0, 0),
];

function input(patch: Partial<TagListInput> & { open?: string[] } = {}): TagListInput {
  const { open = [], ...rest } = patch;
  return {
    tree: TREE,
    full: true,
    mob: false,
    active: null,
    isOpen: (id) => open.includes(id),
    toggle: vi.fn(),
    select: vi.fn(),
    warnings: {},
    fixes: 0,
    openFix: vi.fn(),
    ...rest,
  };
}

// Sample state for the tag reconciliation (account account1@s1.test):
// Personal missing, Follow-up outside, Awaiting reply renamed, "Tags/Old"
// without a tag – four mismatches.
const SAMPLE_TREE = [
  node('wi', 'Important', 0, 2, 5),
  node('pr', 'Personal', 4, 0, 3),
  node('na', 'Follow-up', 2, 1, 1),
  node('wa', 'Awaiting reply', 5, 0, 0),
  node('fi', 'Finance', 1, 0, 2, [node('st', 'Tax', 1, 0, 2, [node('25', '2025', 1, 0, 2)])]),
];
const VPS1 = 'account1@s1.test';
const VPS2 = 'account1@s2.test';
const WARNINGS = { pr: [VPS1], na: [VPS1], wa: [VPS1] };

function sampleInput(patch: Partial<TagListInput> & { open?: string[] } = {}): TagListInput {
  return input({ tree: SAMPLE_TREE, warnings: WARNINGS, fixes: 4, ...patch });
}

const labels = (rows: TagRow[]): string[] => rows.map((r) => r.label);
const byLabel = (rows: TagRow[], label: string): TagRow => rows.find((r) => r.label === label)!;

describe('tagRows', () => {
  it('shows only the top level with colors and counters when collapsed', () => {
    const v = tagRows(input(), TEXTS);
    expect(v).toMatchObject({ tNone: false, ftLblOp: 1 });
    expect(labels(v.tagRows)).toEqual(['Important', 'Personal', 'Travel']);
    expect(byLabel(v.tagRows, 'Important')).toMatchObject({
      key: 'w',
      sub: false,
      kids: true,
      c: '#f5a06e',
      ink: '#3a1b06',
      bIcon: 'ti-plus',
      tileExp: false,
      tileLabel: 'Show subtags',
      tileTip: 'Show subtags',
      tip: undefined,
      pressed: false,
      hasCnt: true,
      cntU: '1',
      cntN: '2',
      cntLabel: '1 unread of 2',
      bl: '0px',
      pl: '7px',
      gap: '13px',
      tw: '34px',
      isz: '18px',
      fs: '15px',
      rr: '17px',
      h: 'var(--rowh, 46px)',
      lines: [],
      cont: false,
    });
    expect(byLabel(v.tagRows, 'Personal')).toMatchObject({
      kids: false,
      c: '#f097ad',
      ink: '#4a0f20',
      hasCnt: true,
      cntU: '0',
      cntLabel: '0 unread of 3',
      tileExp: undefined,
      tileLabel: 'Personal',
      tileTip: undefined,
    });
    // Unknown color: the first one from `MA_COLORS`.
    expect(byLabel(v.tagRows, 'Travel')).toMatchObject({ c: '#f5a06e', ink: '#3a1b06', hasCnt: false });
  });

  it('indents subtags and draws the lines', () => {
    const v = tagRows(input({ open: ['w', 'k'] }), TEXTS);
    expect(labels(v.tagRows)).toEqual(['Important', 'Customers', 'Alpha', 'Beta', 'Personal', 'Travel']);
    expect(byLabel(v.tagRows, 'Important')).toMatchObject({
      bIcon: 'ti-minus',
      tileExp: true,
      tileLabel: 'Hide subtags',
      tileTip: 'Hide subtags',
    });
    expect(byLabel(v.tagRows, 'Customers')).toMatchObject({
      key: 'k',
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
    expect(byLabel(v.tagRows, 'Alpha')).toMatchObject({
      first: true,
      cont: false,
      bl: '58px',
      ex: '47px',
      lines: [{ x: '24px' }],
      c: '#82bbec',
      ink: '#0b2a47',
    });
    expect(byLabel(v.tagRows, 'Beta')).toMatchObject({ first: false, cont: false, ex: '24px', lines: [] });
  });

  it('marks the active tag and collapsed ancestors', () => {
    const closed = tagRows(input({ active: 'a' }), TEXTS);
    expect(byLabel(closed.tagRows, 'Important')).toMatchObject({ sel: false, inside: true, pressed: false, fw: 800 });
    expect(byLabel(closed.tagRows, 'Personal')).toMatchObject({ inside: false, fw: 600 });

    const half = tagRows(input({ active: 'a', open: ['w'] }), TEXTS);
    expect(byLabel(half.tagRows, 'Important')).toMatchObject({ inside: false, fw: 600 });
    expect(byLabel(half.tagRows, 'Customers')).toMatchObject({ inside: true, fw: 800 });

    // When collapsed, subtags are not visible: the expanded ancestor counts as closed.
    const narrow = tagRows(input({ active: 'a', open: ['w'], full: false }), TEXTS);
    expect(byLabel(narrow.tagRows, 'Important')).toMatchObject({ inside: true, fw: 800 });

    const sel = tagRows(input({ active: 'b', open: ['w'] }), TEXTS);
    expect(byLabel(sel.tagRows, 'Beta')).toMatchObject({
      sel: true,
      inside: false,
      pressed: true,
      fw: 800,
      bg: 'var(--surface)',
      sh: 'var(--sh1)',
      hoverBg: 'var(--surface)',
    });
    expect(byLabel(sel.tagRows, 'Important')).toMatchObject({
      sel: false,
      inside: false,
      pressed: false,
      bg: 'transparent',
      hoverBg: 'var(--hov)',
    });

    const mob = tagRows(input({ active: 'p', mob: true }), TEXTS);
    expect(byLabel(mob.tagRows, 'Personal')).toMatchObject({
      bg: 'var(--accsoft)',
      sh: 'none',
      h: 'calc(var(--rowh, 46px) + 6px)',
      fs: '15.5px',
      rr: '18px',
    });
  });

  it('shows only the top level with tooltips when collapsed', () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const v = tagRows(input({ full: false, open: ['w'], select, toggle }), TEXTS);
    expect(v.ftLblOp).toBe(0);
    expect(labels(v.tagRows)).toEqual(['Important', 'Personal', 'Travel']);
    const important = byLabel(v.tagRows, 'Important');
    expect(important).toMatchObject({
      tip: 'Important',
      tileTip: 'Important',
      tileLabel: 'Important',
      tileExp: undefined,
    });
    important.tileClick();
    expect(select).toHaveBeenCalledWith('w');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('expands via the tile and selects via the row', () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const v = tagRows(input({ select, toggle }), TEXTS);
    byLabel(v.tagRows, 'Important').tileClick();
    expect(toggle).toHaveBeenCalledWith('w');
    byLabel(v.tagRows, 'Important').onClick();
    byLabel(v.tagRows, 'Personal').tileClick();
    expect(select.mock.calls).toEqual([['w'], ['p']]);
  });

  it('reports an empty list', () => {
    expect(tagRows(input({ tree: [] }), TEXTS)).toMatchObject({
      tagRows: [],
      tNone: true,
      ftLblOp: 1,
      tsShow: false,
    });
  });

  it('marks tags with a mismatch and shows the hint row', () => {
    const openFix = vi.fn();
    const v = tagRows(sampleInput({ openFix }), TEXTS);
    expect(v.tsShow).toBe(true);
    expect(v.tsRow).toMatchObject({
      n: '4',
      aria: 'Fix tags, 4 mismatches',
      tip: undefined,
      h: 'var(--rowh, 46px)',
      rr: '17px',
      fs: '14.5px',
    });
    expect(byLabel(v.tagRows, 'Personal')).toMatchObject({
      warn: true,
      warnTip: m.tags_warn_one({ email: VPS1 }),
    });
    expect(byLabel(v.tagRows, 'Follow-up').warn).toBe(true);
    expect(byLabel(v.tagRows, 'Awaiting reply').warn).toBe(true);
    expect(byLabel(v.tagRows, 'Important')).toMatchObject({ warn: false, warnTip: undefined });
    v.tsRow.open();
    expect(openFix).toHaveBeenCalled();
  });

  it('counts one case in the singular', () => {
    const v = tagRows(sampleInput({ warnings: { pr: [VPS1] }, fixes: 1 }), TEXTS);
    expect(v.tsRow).toMatchObject({ n: '1', aria: 'Fix tags, 1 mismatch' });
  });

  it('names the number of accounts in "All accounts"', () => {
    const v = tagRows(sampleInput({ warnings: { ...WARNINGS, pr: [VPS1, VPS2] }, fixes: 5 }), TEXTS);
    expect(v).toMatchObject({ tsShow: true, tsRow: { aria: m.tagfix_aria({ count: 5 }) } });
    expect(byLabel(v.tagRows, 'Personal').warnTip).toBe(m.tags_warn({ count: 2 }));
    expect(byLabel(v.tagRows, 'Follow-up').warnTip).toBe(m.tags_warn_one({ email: VPS1 }));
  });

  it('shows no hint row without a mismatch (sign-in required)', () => {
    expect(tagRows(sampleInput({ warnings: {}, fixes: 0 }), TEXTS).tsShow).toBe(false);
  });

  it('shows no mark when collapsed, the hint row with a tooltip', () => {
    const v = tagRows(sampleInput({ full: false }), TEXTS);
    expect(v.tsShow).toBe(true);
    expect(v.tsRow).toMatchObject({ tip: 'Fix tags', aria: 'Fix tags, 4 mismatches' });
    expect(byLabel(v.tagRows, 'Personal')).toMatchObject({ warn: false, warnTip: undefined });
  });

  it('takes over the row dimensions on mobile', () => {
    expect(tagRows(sampleInput({ mob: true }), TEXTS).tsRow).toMatchObject({
      h: 'calc(var(--rowh, 46px) + 6px)',
      rr: '18px',
      fs: '15px',
    });
  });

  it('highlights the ancestor of an active subtag when collapsed', () => {
    const narrow = tagRows(sampleInput({ full: false, active: '25', open: ['fi'] }), TEXTS);
    expect(byLabel(narrow.tagRows, 'Finance')).toMatchObject({
      fw: 800,
      inside: true,
      c: '#94c48d',
      bIcon: 'ti-minus',
      warn: false,
    });

    const wide = tagRows(sampleInput({ active: '25', open: ['fi', 'st'] }), TEXTS);
    expect(byLabel(wide.tagRows, 'Finance')).toMatchObject({ fw: 600, inside: false });
    expect(byLabel(wide.tagRows, '2025').pressed).toBe(true);
  });
});

describe('tag list', () => {
  it('shows tags with color and counters and selects via the row', async () => {
    const select = vi.fn();
    const { getByText, getByLabelText, getByRole, container } = render(
      TagList,
      tagRows(input({ select, active: 'p' }), TEXTS),
    );
    expect(getByText('Important')).toBeInTheDocument();
    expect(getByLabelText('1 unread of 2')).toBeInTheDocument();
    expect(container.querySelector('.tags')).toHaveInlineStyle({ '--lbl-op': '1', '--sb-bg': 'var(--cnv)' });
    const personal = getByText('Personal').closest('.item');
    expect(personal).toHaveClass('sel');
    expect(personal).toHaveStyle({ '--tag-c': '#f097ad', '--tag-ink': '#4a0f20' });
    expect(getByRole('button', { pressed: true })).toHaveTextContent('Personal');
    expect(getByText('Important').closest('button')).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(getByText('Important'));
    expect(select).toHaveBeenCalledWith('w');
  });

  it('expands subtags via the tile and draws the lines', async () => {
    const toggle = vi.fn();
    const { getAllByRole, getByText } = render(TagList, tagRows(input({ toggle, open: ['w', 'k'] }), TEXTS));
    const tiles = getAllByRole('button', { name: 'Hide subtags' });
    expect(tiles).toHaveLength(2);
    const tile = tiles[0]!;
    expect(tile).toHaveAttribute('aria-expanded', 'true');
    expect(tile.querySelector('.badge')).not.toBeNull();
    const customers = getByText('Customers').closest('.item')!;
    expect(customers).toHaveClass('sub', 'first');
    expect(customers.querySelector('.line.cont')).toHaveStyle({ left: '24px' });
    expect(customers.querySelector('.elbow')).toHaveStyle({ left: '24px' });
    const alpha = getByText('Alpha').closest('.item')!;
    expect(alpha.querySelector('.line:not(.cont)')).toHaveStyle({ left: '24px' });
    expect(alpha.querySelector('.elbow')).toHaveStyle({ left: '47px' });
    expect(getByText('Important').closest('.item')!.querySelector('.elbow')).toBeNull();
    await fireEvent.click(tile);
    expect(toggle).toHaveBeenCalledWith('w');
  });

  it('selects via the tile when collapsed too', async () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const { getAllByRole, container } = render(TagList, {
      ...tagRows(input({ full: false, select, toggle }), TEXTS),
      sbBg: 'var(--pop)',
    });
    expect(container.querySelector('.tags')).toHaveInlineStyle({ '--lbl-op': '0', '--sb-bg': 'var(--pop)' });
    const tile = getAllByRole('button', { name: 'Important' }).find((b) => b.classList.contains('tile'))!;
    expect(tile).not.toHaveAttribute('aria-expanded');
    await fireEvent.click(tile);
    expect(select).toHaveBeenCalledWith('w');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows "No tags yet"', () => {
    const { getByText, queryByRole } = render(TagList, tagRows(input({ tree: [] }), TEXTS));
    expect(getByText('No tags yet')).toBeInTheDocument();
    expect(queryByRole('button', { name: /^Fix tags/ })).toBeNull();
  });

  it('marks tags with a mismatch before the counter', () => {
    const { getByText, getAllByRole } = render(TagList, tagRows(sampleInput(), TEXTS));
    expect(getAllByRole('img', { name: /^Doesn’t match/ })).toHaveLength(3);
    const personal = getByText('Personal').closest('.item')!.querySelector('[role="img"]')!;
    expect(personal).toHaveAttribute('aria-label', m.tags_warn_one({ email: 'account1@s1.test' }));
    // With a counter without a right gap (`warnMr` 0), otherwise 10px like the counter.
    expect(personal).toHaveClass('warn', 'cnt');
    expect(personal.nextElementSibling).toHaveClass('count');
    const awaiting = getByText('Awaiting reply').closest('.item')!.querySelector('.warn');
    expect(awaiting).not.toHaveClass('cnt');
    expect(getByText('Important').closest('.item')!.querySelector('.warn')).toBeNull();
  });

  it('opens the reconciliation via the hint row', async () => {
    const openFix = vi.fn();
    const { getByRole } = render(TagList, tagRows(sampleInput({ openFix }), TEXTS));
    const fix = getByRole('button', { name: 'Fix tags, 4 mismatches' });
    expect(fix).toHaveAttribute('aria-haspopup', 'dialog');
    expect(fix).toHaveTextContent('Fix tags 4');
    expect(fix.querySelector('.fix-n')).toHaveAttribute('aria-hidden', 'true');
    expect(fix).toHaveInlineStyle({ height: 'var(--rowh, 46px)', 'border-radius': '17px', 'font-size': '14.5px' });
    await fireEvent.click(fix);
    expect(openFix).toHaveBeenCalledOnce();
  });

  it('shows the hint row without tags too', () => {
    const { getByText, getByRole } = render(TagList, tagRows(input({ tree: [], fixes: 1, warnings: {} }), TEXTS));
    expect(getByText('No tags yet')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Fix tags, 1 mismatch' })).toBeInTheDocument();
  });

  it('shows no mark when collapsed, but the hint row', () => {
    const { queryAllByRole, getByRole, container } = render(TagList, tagRows(sampleInput({ full: false }), TEXTS));
    expect(queryAllByRole('img', { name: /^Doesn’t match/ })).toHaveLength(0);
    expect(container.querySelector('.tags')).toHaveStyle({ '--lbl-op': '0' });
    expect(getByRole('button', { name: 'Fix tags, 4 mismatches' })).toBeInTheDocument();
  });

  it('highlights the ancestor of an active subtag when collapsed', () => {
    const { getByText } = render(TagList, tagRows(sampleInput({ full: false, active: '25', open: ['fi'] }), TEXTS));
    const finance = getByText('Finance').closest('.item')!;
    expect(finance).toHaveClass('inside');
    expect(finance).toHaveStyle({ '--tag-c': '#94c48d' });
    expect(getByText('Finance').closest('button')).toHaveStyle({ 'font-weight': '800' });
  });
});
