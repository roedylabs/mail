import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TagFixDialog from './TagFixDialog.svelte';
import { m } from '#lib/paraglide/messages.js';
import { problemKey, type Tag, type TagFix, type TagProblem } from '#lib/state/tags.svelte.ts';
import {
  tagFixValues,
  type TagFixAccount,
  type TagFixInput,
  type TagFixItem,
  type TagFixValues,
} from '#lib/tag-fix.ts';

const tag = (id: string, name: string, color: number | null): Tag => ({
  id,
  name,
  parent_id: null,
  color,
  position: 0,
  links: [],
  created_at: '2026-10-01T00:00:00Z',
});

const TAGS = [
  tag('pr', 'Personal', 4),
  tag('na', 'Follow-up', 2),
  tag('wa', 'Awaiting reply', 5),
  tag('old', 'Old', 1),
];

const VPS1: TagFixAccount = { id: 'm1', email: 'account1@s1.test', letter: 'A', bg: '#94c48d', ink: '#13300f' };
const VPS2: TagFixAccount = { id: 'm2', email: 'account1@s2.test', letter: 'A', bg: '#b0a2f2', ink: '#21134d' };

// Sample cases of account account1@s1.test: tp1 … tp4.
const TP1: TagProblem = { kind: 'missing', account: 'm1', tag: 'pr', mailbox: 'b1' };
const TP2: TagProblem = { kind: 'outside', account: 'm1', tag: 'na', mailbox: 'b2', path: 'Archive/Follow-up' };
const TP3: TagProblem = { kind: 'renamed', account: 'm1', tag: 'wa', mailbox: 'b3', name: 'Waiting', path: null };
const TP4: TagProblem = {
  kind: 'unlinked',
  account: 'm1',
  mailbox: 'b4',
  name: 'Old',
  path: 'Tags/Old',
  kids: 1,
  parent: null,
  link: null,
};
const PROBLEMS = [TP1, TP2, TP3, TP4];

function values(patch: Partial<TagFixInput> = {}): TagFixValues {
  return tagFixValues({
    problems: PROBLEMS,
    tags: TAGS,
    accounts: [VPS1],
    allMode: false,
    busy: () => undefined,
    run: vi.fn(),
    ...patch,
  });
}

const items = (v: TagFixValues): TagFixItem[] => v.groups.flatMap((g) => g.items);
const itemOf = (v: TagFixValues, p: TagProblem): TagFixItem => items(v).find((it) => it.key === problemKey(p))!;
const one = (p: TagProblem): TagFixItem => itemOf(values({ problems: [p] }), p);

describe('tagFixValues', () => {
  it('shows the cases of one account without a header row', () => {
    const v = values();
    expect(v.sub).toBe('account1@s1.test');
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]).toMatchObject({ head: false, mt: '0px' });
    expect(items(v).map((it) => it.chip)).toEqual(['Personal', 'Follow-up', 'Awaiting reply', 'Tags/Old']);
  });

  it('case missing: only "Unlink"', () => {
    const it = itemOf(values(), TP1);
    expect(it).toMatchObject({
      isTag: true,
      dot: '#f097ad',
      chip: 'Personal',
      text: m.tagfix_missing(),
      note: '',
      s: null,
      busy: false,
      p: { label: m.tagfix_unlink(), spin: false, desc: undefined },
    });
  });

  it('case outside: note at the secondary action', () => {
    const it = itemOf(values(), TP2);
    expect(it).toMatchObject({
      text: m.tagfix_outside({ path: 'Archive/Follow-up' }),
      note: m.tagfix_note_keep(),
      p: { label: m.tagfix_back(), desc: undefined },
      s: { label: m.tagfix_unlink(), desc: it.noteId },
    });
    expect(it.noteId).toBe(`ts-n-${problemKey(TP2)}`);
  });

  it('case renamed: only name, only location, both', () => {
    expect(itemOf(values(), TP3)).toMatchObject({
      text: m.tagfix_renamed_name({ name: 'Waiting' }),
      p: { label: m.tagfix_align() },
      s: { label: m.tagfix_take() },
      note: m.tagfix_note_take({ name: 'Waiting' }),
    });
    expect(one({ ...TP3, name: null, path: 'Tags/Finance/Awaiting reply' })).toMatchObject({
      text: m.tagfix_renamed_path({ path: 'Tags/Finance/Awaiting reply' }),
      s: null,
      note: '',
    });
    expect(one({ ...TP3, path: 'Tags/Finance/Waiting' })).toMatchObject({
      text: m.tagfix_renamed_both({ name: 'Waiting', path: 'Tags/Finance/Waiting' }),
      s: null,
    });
  });

  it('case unlinked: folder chip, note at the primary action', () => {
    const it = itemOf(values(), TP4);
    expect(it).toMatchObject({
      isTag: false,
      dot: '',
      chip: 'Tags/Old',
      text: m.tagfix_unlinked(),
      note: m.tagfix_note_kids_one(),
      p: { label: m.tagfix_adopt(), desc: it.noteId },
      s: { label: m.tagfix_to_folder(), desc: undefined },
    });
    expect(one({ ...TP4, link: 'old' }).p.label).toBe(m.tagfix_link({ name: 'Old' }));
    expect(one({ ...TP4, kids: 3 }).note).toBe(m.tagfix_note_kids({ count: 3 }));
    expect(one({ ...TP4, kids: 0 })).toMatchObject({ note: '', p: { desc: undefined } });
  });

  it('groups with header rows in "All accounts"', () => {
    const tp5: TagProblem = { ...TP1, account: 'm2' };
    const v = values({ problems: [...PROBLEMS, tp5], accounts: [VPS1, VPS2], allMode: true });
    expect(v.sub).toBe(m.switcher_all());
    expect(v.groups.map((g) => ({ head: g.head, email: g.email, mt: g.mt, n: g.items.length }))).toEqual([
      { head: true, email: 'account1@s1.test', mt: '0px', n: 4 },
      { head: true, email: 'account1@s2.test', mt: '10px', n: 1 },
    ]);
    expect(v.groups[1]).toMatchObject({ letter: 'A', aBg: '#b0a2f2', aInk: '#21134d' });
  });

  it('shows the loading state of the running action', () => {
    const v = values({ busy: (key) => (key === problemKey(TP2) ? 'back' : undefined) });
    expect(itemOf(v, TP2)).toMatchObject({ busy: true, p: { spin: true }, s: { spin: false } });
    expect(itemOf(v, TP1).busy).toBe(false);
  });

  it('calls the action with case and kind', () => {
    const run = vi.fn<(p: TagProblem, a: TagFix) => void>();
    const v = values({ run });
    itemOf(v, TP2).s!.run();
    itemOf(v, TP4).p.run();
    expect(run.mock.calls).toEqual([
      [TP2, 'unlink'],
      [TP4, 'adopt'],
    ]);
  });
});

describe('fix tags dialog', () => {
  it('shows the dialog with all cases on desktop', async () => {
    const close = vi.fn();
    const overlay = vi.fn();
    const { getByRole, getByText, getAllByRole, container } = render(TagFixDialog, {
      ...values(),
      isMobile: false,
      close,
      overlay,
    });
    const dialog = getByRole('dialog', { name: m.tagfix_title() });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(getByText('account1@s1.test')).toBeInTheDocument();
    expect(getByText(m.tagfix_intro())).toBeInTheDocument();
    expect(container.querySelector('.g-head')).toBeNull();
    expect(container.querySelectorAll('.item')).toHaveLength(4);
    expect(getAllByRole('button', { name: m.tagfix_unlink() })).toHaveLength(2);
    // Color dot in the tag's color (#f097ad, rose).
    expect(getByText('Personal').previousElementSibling).toHaveAttribute('style', 'background: rgb(240, 151, 173);');
    // Folder chip without a color dot.
    const old = getByText('Tags/Old').closest('.chip')!;
    expect(old.querySelector('.dot')).toBeNull();
    expect(old.querySelector('.folder svg')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
    await fireEvent.mouseDown(container.querySelector('.scrim')!);
    expect(overlay).toHaveBeenCalledOnce();
  });

  it('connects the note with its action', () => {
    const { getByRole, getByText } = render(TagFixDialog, { ...values(), isMobile: false, close: vi.fn() });
    const keep = getByText(m.tagfix_note_keep());
    expect(keep.id).toBe(`ts-n-${problemKey(TP2)}`);
    expect(getByRole('button', { name: m.tagfix_back() })).not.toHaveAttribute('aria-describedby');
    const unlink = getByRole('button', {
      name: m.tagfix_unlink(),
      description: m.tagfix_note_keep(),
    });
    expect(unlink).toHaveAttribute('aria-describedby', keep.id);
    expect(
      getByRole('button', { name: m.tagfix_take(), description: m.tagfix_note_take({ name: 'Waiting' }) }),
    ).toBeInTheDocument();
    expect(
      getByRole('button', {
        name: m.tagfix_adopt(),
        description: m.tagfix_note_kids_one(),
      }),
    ).toBeInTheDocument();
    expect(getByRole('button', { name: m.tagfix_to_folder() })).not.toHaveAttribute('aria-describedby');
  });

  it('calls the actions of the buttons', async () => {
    const run = vi.fn();
    const { getByRole } = render(TagFixDialog, { ...values({ run }), isMobile: false, close: vi.fn() });
    await fireEvent.click(getByRole('button', { name: m.tagfix_back() }));
    await fireEvent.click(getByRole('button', { name: m.tagfix_take() }));
    expect(run.mock.calls).toEqual([
      [TP2, 'back'],
      [TP3, 'take'],
    ]);
  });

  it('disables the entry while an action runs', () => {
    const { getByRole, getByText } = render(TagFixDialog, {
      ...values({ busy: (key) => (key === problemKey(TP2) ? 'back' : undefined) }),
      isMobile: false,
      close: vi.fn(),
    });
    const item = getByText('Follow-up').closest('.item')!;
    expect(item).toHaveAttribute('aria-busy', 'true');
    expect(item.querySelector('.acts')).toHaveClass('busy');
    const back = getByRole('button', { name: m.tagfix_back() });
    expect(back).toHaveAttribute('aria-busy', 'true');
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(back).toHaveClass('spinning');
    expect(back.querySelector('.spin svg')).not.toBeNull();
    const unlink = item.querySelector<HTMLElement>('.act.s')!;
    expect(unlink).toHaveAttribute('aria-busy', 'false');
    expect(unlink).toHaveAttribute('aria-disabled', 'true');
    expect(unlink.querySelector('.spin')).toBeNull();
    // Other entries stay operable.
    const personal = getByText('Personal').closest('.item')!;
    expect(personal).toHaveAttribute('aria-busy', 'false');
    expect(personal.querySelector('.act')).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows one header row per account in "All accounts"', () => {
    const tp5: TagProblem = { ...TP1, account: 'm2' };
    const { getByText, container } = render(TagFixDialog, {
      ...values({ problems: [...PROBLEMS, tp5], accounts: [VPS1, VPS2], allMode: true }),
      isMobile: false,
      close: vi.fn(),
    });
    expect(getByText(m.switcher_all())).toHaveClass('sub');
    const heads = container.querySelectorAll<HTMLElement>('.g-head');
    expect([...heads].map((h) => h.textContent)).toEqual(['A account1@s1.test', 'A account1@s2.test']);
    expect(heads[1]).toHaveStyle({ 'margin-top': '10px' });
    expect(heads[1]!.querySelector('.g-tile')).toHaveAttribute(
      'style',
      'background: rgb(176, 162, 242); color: rgb(33, 19, 77);',
    );
  });

  it('shows only the content for the sheet on mobile', async () => {
    const close = vi.fn();
    const { queryByRole, getByRole, getByText, container } = render(TagFixDialog, {
      ...values(),
      isMobile: true,
      close,
    });
    expect(queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.scrim')).toBeNull();
    expect(getByText(m.tagfix_title())).toHaveClass('title');
    expect(container.querySelector('.body')).toHaveClass('m');
    expect(getByText(m.tagfix_note_kids_one())).toHaveClass('note');
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
  });
});
