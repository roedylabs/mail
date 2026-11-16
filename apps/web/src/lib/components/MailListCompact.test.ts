import { fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import {
  listNotice,
  listValues,
  type ListInput,
  type ListThread,
  type ListValues,
  type NoticeInput,
} from '#lib/mail-list.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { swipeAction } from '#lib/swipe.ts';
import { swipe } from '#lib/test/pointer.ts';
import { VirtualList } from '#lib/virtual.svelte.ts';
import MailListCompact from './MailListCompact.svelte';

/** Wednesday, 28 October 2026, 20:55 in Berlin. */
const NOW = Date.UTC(2026, 9, 28, 19, 55);
const HOUR = 3_600_000;

/** Call of `VirtualList.reveal` with the index the function determines when scrolling. */
const revealed = ([target, opts]: Parameters<VirtualList['reveal']>) => [
  typeof target === 'function' ? target() : target,
  opts,
];

function thread(p: Partial<ListThread> & { id: string }): ListThread {
  return {
    key: `a1/${p.id}`,
    account: 'a1',
    threadId: `t-${p.id}`,
    receivedAt: NOW - HOUR,
    from: [{ name: 'Ben Carter', email: 'ben@example.com' }],
    to: [{ name: 'Jane Doe', email: 'jane@s1.test' }],
    subject: 'Minutes from Monday',
    preview: 'Minutes attached.',
    hasAttachment: false,
    unread: false,
    flagged: false,
    count: 1,
    mailboxIds: ['inbox'],
    members: [],
    seq: 0,
    ...p,
  };
}

const THREADS: ListThread[] = [
  thread({
    id: 'i1',
    receivedAt: NOW,
    from: [{ name: 'Anna Baker', email: 'anna@example.com' }],
    subject: 'Approve start page by Friday?',
    preview: 'Hi Jane, the drafts for the start page',
    hasAttachment: true,
    unread: true,
    flagged: true,
    count: 3,
    mailboxIds: ['inbox', 'important'],
  }),
  thread({ id: 'i2', receivedAt: NOW - 11 * HOUR }),
  thread({ id: 'i3', receivedAt: NOW - 24 * HOUR, from: [], subject: '' }),
];

function values(patch: Partial<ListInput> = {}): ListValues {
  const threads = patch.threads ?? THREADS;
  return listValues({
    kind: { role: 'inbox' },
    title: 'Inbox',
    segment: 'all',
    threads,
    counts: { all: threads.length, unread: threads.filter((t) => t.unread).length, flagged: 1 },
    total: threads.length,
    multi: false,
    accountOf: (id) => (id === 'a1' ? { email: 'account1@s1.test', color: 0 } : { email: 'alex@s2.test', color: 1 }),
    tagOf: (_, box) => (box === 'important' ? { name: 'Important', color: 3 } : undefined),
    time: { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' },
    ...patch,
  });
}

function setup(
  props: {
    pf?: ListValues;
    isMobile?: boolean;
    busy?: boolean;
    hasMore?: boolean;
    focusSort?: 'date' | 'from' | null;
  } = {},
) {
  const fns = {
    onSegment: vi.fn(),
    onOpen: vi.fn(),
    onRefresh: vi.fn(),
    onMore: vi.fn(),
    onSort: vi.fn(),
    onStar: vi.fn(),
    onRead: vi.fn(),
    onRestore: vi.fn(),
    onDel: vi.fn(),
    onClear: vi.fn(),
    onFolderEdit: vi.fn(),
    onFolderDelete: vi.fn(),
    onSel: vi.fn(),
    onSelAll: vi.fn(),
    onClearSel: vi.fn(),
    onBulk: vi.fn(),
    onSwipe: vi.fn(),
    onGoAccount: vi.fn(),
  };
  const view = render(MailListCompact, {
    pf: values(),
    isMobile: false,
    busy: false,
    hasMore: false,
    ...fns,
    ...props,
  });
  const rows = () => [...view.container.querySelectorAll<HTMLElement>('.row')];
  return { view, rows, ...fns };
}

/** Button "Open" of a row with its text. */
const openOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(':scope > button.open')!;

type NoticeAccount = NoticeInput['accounts'][number];

const STALE: Partial<NoticeAccount> = { state: 'needs_reauth' };
const BLOCKED: Partial<NoticeAccount> = { blocked: true };

/** View with a single account, completed as on the page (`listNotice`). */
function notice(threads: ListThread[], account: Partial<NoticeAccount>, input: Partial<NoticeInput> = {}): ListValues {
  return listNotice(values({ threads, total: threads.length }), threads.length, {
    accounts: [{ email: 'account1@s1.test', host: 'mail.s1.test', state: 'ok', blocked: false, ...account }],
    offline: false,
    unsaved: false,
    truncated: false,
    ...input,
  });
}

const isBefore = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// jsdom measures nothing: without a height of the scroll area the virtual list shows
// no entry, without a height of the entries all of them. Here the scroll area is
// 600 px high, rows have a fixed height (`--rowh`).
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.matches('.scroll, main.mobile') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('.vitem') ? 46 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('[data-sw]') ? 300 : 0;
  });
});

const SWIPE = { left: 'del', right: 'star' };
const inbox = { role: 'inbox' } as const;

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('message list (compact)', () => {
  it('shows head, segments with counters and refresh', async () => {
    const { view, onSegment, onRefresh } = setup();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    expect(view.getByText('1 unread · 3 messages')).toBeInTheDocument();
    const seg = view.getByRole('radiogroup', { name: 'Filter messages' });
    const radios = within(seg).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['All', 'Unread1', 'Flagged1']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveClass('on');
    await fireEvent.click(radios[2]!);
    expect(onSegment).toHaveBeenCalledWith('flagged');
    expect(view.queryByText('Empty Trash')).toBeNull();
    expect(view.queryByRole('button', { name: 'Edit folder' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Edit tag' })).toBeNull();
    const refresh = view.getByRole('button', { name: 'Refresh' });
    expect(refresh.querySelector('.ri')).not.toHaveClass('spin');
    await fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('spins the icon while refreshing', async () => {
    const { view } = setup({ busy: true });
    expect(view.getByRole('button', { name: 'Refresh' }).querySelector('.ri')).toHaveClass('spin');
    await view.rerender({ busy: false });
    expect(view.getByRole('button', { name: 'Refresh' }).querySelector('.ri')).not.toHaveClass('spin');
  });

  it('shows the column header with sorting by date', async () => {
    const { view, onSort, onSelAll } = setup();
    expect(view.queryByRole('toolbar')).toBeNull();
    const cols = within(view.container.querySelector<HTMLElement>('.cols')!);
    const all = cols.getByRole('checkbox', { name: 'Select all' });
    expect(all).toHaveAttribute('aria-checked', 'false');
    expect(all.querySelector('.ck-box')).not.toHaveClass('on');
    await fireEvent.click(all);
    expect(onSelAll).toHaveBeenCalledOnce();
    expect(cols.getByText('Subject')).toBeInTheDocument();
    const from = cols.getByRole('button', { name: 'Sort by Sender' });
    const date = cols.getByRole('button', { name: 'Sort by Date' });
    expect(from).toHaveTextContent('Sender');
    expect(date).toHaveTextContent('Date');
    expect(from).not.toHaveClass('on');
    expect(date).toHaveClass('on');
    expect(date.querySelector('.arr')).not.toHaveClass('up');
    await fireEvent.click(from);
    expect(onSort).toHaveBeenCalledWith('from');
    await fireEvent.click(date);
    expect(onSort).toHaveBeenLastCalledWith('date');
  });

  it('rotates the arrow of the active column against its default', async () => {
    const { view } = setup({ pf: values({ sort: { key: 'from', dir: 1 } }) });
    const from = view.getByRole('button', { name: 'Sort by Sender' });
    const date = view.getByRole('button', { name: 'Sort by Date' });
    expect(from).toHaveClass('on');
    expect(from).toHaveAttribute('aria-pressed', 'true');
    expect(from.querySelector('.arr')).not.toHaveClass('up');
    expect(date).not.toHaveClass('on');
    expect(date).toHaveAttribute('aria-pressed', 'false');
    await view.rerender({ pf: values({ sort: { key: 'from', dir: -1 } }) });
    expect(view.getByRole('button', { name: 'Sort by Sender' }).querySelector('.arr')).toHaveClass('up');
    await view.rerender({ pf: values({ sort: { key: 'date', dir: 1 } }) });
    expect(view.getByRole('button', { name: 'Sort by Date' }).querySelector('.arr')).toHaveClass('up');
  });

  it('returns focus to the column header after sorting', () => {
    const { view } = setup({ pf: values({ sort: { key: 'from', dir: 1 } }), focusSort: 'from' });
    expect(view.getByRole('button', { name: 'Sort by Sender' })).toHaveFocus();
    view.unmount();
    setup();
    expect(document.body).toHaveFocus();
  });

  it('names recipients and sending in Sent and Scheduled', () => {
    const { view } = setup({ pf: values({ kind: { role: 'scheduled' }, title: 'Scheduled' }) });
    expect(view.getByRole('button', { name: 'Sort by Recipient' })).toHaveTextContent('Recipient');
    expect(view.getByRole('button', { name: 'Sort by Send time' })).toHaveTextContent('Send time');
  });

  it('shows the rows without date groups with all details', () => {
    const { view, rows } = setup();
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
    const [first, second, third] = rows();
    expect(rows()).toHaveLength(3);

    const r1 = within(first!);
    expect(first).toHaveClass('unread');
    expect(r1.getByText('Anna Baker').parentElement).toHaveStyle({ fontWeight: '800' });
    expect(r1.getByText('3')).toHaveClass('n');
    expect(r1.getByText('Approve start page by Friday?')).toHaveStyle({ fontWeight: '750' });
    expect(r1.getByText('– Hi Jane, the drafts for the start page')).toHaveClass('prev');
    expect(r1.getByText('20:55')).toHaveStyle({ fontWeight: '800' });
    expect(r1.getByText('Important')).toHaveClass('tag');
    expect(first!.querySelector('.att .tabler-icon-paperclip')).not.toBeNull();
    const ck = r1.getByRole('checkbox', { name: 'Select: Approve start page by Friday?' });
    expect(ck).toHaveAttribute('aria-checked', 'false');
    const star = r1.getByRole('button', { name: 'Remove flag' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(star).toHaveClass('on');
    expect(star.querySelector('.tabler-icon-star-filled')).not.toBeNull();
    expect(r1.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    expect(r1.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(r1.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(first!.querySelector('.acct')).toBeNull();
    expect(first!.querySelector('.chip')).toBeNull();

    const r2 = within(second!);
    expect(second).not.toHaveClass('unread');
    expect(r2.getByText('Ben Carter').parentElement).toHaveStyle({ fontWeight: '600' });
    expect(r2.getByText('09:55')).toBeInTheDocument();
    expect(second!.querySelector('.n')).toBeNull();
    expect(second!.querySelector('.tag')).toBeNull();
    expect(second!.querySelector('.att .tabler-icon-paperclip')).toBeNull();
    const star2 = r2.getByRole('button', { name: 'Flag' });
    expect(star2).toHaveAttribute('aria-pressed', 'false');
    expect(star2).not.toHaveClass('on');
    expect(r2.getByRole('button', { name: 'Mark as unread' })).toBeInTheDocument();

    // Without a sender "Unknown", without a subject "(No subject)", checkbox with "Message".
    const r3 = within(third!);
    expect(third!.querySelector('.who')).toHaveTextContent('Unknown');
    expect(r3.getByText('(No subject)')).toBeInTheDocument();
    expect(r3.getByText('Yesterday')).toBeInTheDocument();
    expect(r3.getByRole('checkbox', { name: 'Select: Message' })).toBeInTheDocument();
  });

  it('colors tags with the tag color', () => {
    const { rows } = setup();
    const row = values().rows[0]!;
    const tag = rows()[0]!.querySelector<HTMLElement>('.tag')!;
    expect(tag.style.getPropertyValue('--t-bg')).toBe(row.tags[0]!.bg);
    expect(tag.querySelector('.tag-i')).toHaveStyle({ color: row.tags[0]!.ink });
  });

  it('names full time, number of messages and actions in the tooltip', async () => {
    vi.useFakeTimers();
    const { rows } = setup();
    const r1 = within(rows()[0]!);
    await fireEvent.pointerEnter(r1.getByText('20:55'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Wednesday, 28 October 2026, 20:55');
    await fireEvent.pointerLeave(r1.getByText('20:55'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
    await fireEvent.pointerEnter(r1.getByText('3'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('3 messages');
    await fireEvent.pointerLeave(r1.getByText('3'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
    await fireEvent.pointerEnter(r1.getByRole('button', { name: 'Remove flag' }), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Remove flag');
  });

  it('opens a row via its button with the text, not via checkbox, star and quick actions', async () => {
    const { rows, onOpen, onStar, onRead, onDel, onSel } = setup();
    const first = rows()[0]!;
    // The row is not a control (axe `nested-interactive`), opening is a real button without `<div>`.
    expect(first).not.toHaveAttribute('role');
    expect(first).not.toHaveAttribute('tabindex');
    const open = within(first).getByRole('button', { name: /^Anna Baker.*Approve start page by Friday\?.*20:55$/ });
    expect(open).toBe(openOf(first));
    expect(open).toHaveAttribute('type', 'button');
    expect(open).not.toHaveAttribute('aria-label');
    expect(open.querySelector('div, button, a, input, [tabindex]')).toBeNull();
    for (const el of [
      within(first).getByRole('checkbox'),
      within(first).getByRole('button', { name: 'Remove flag' }),
      first.querySelector('.qa')!,
    ])
      expect(open.contains(el)).toBe(false);

    await fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1', threadId: 't-i1' }));
    onOpen.mockClear();
    // A click on text and time reaches the button.
    await fireEvent.click(within(rows()[1]!).getByText('Minutes from Monday'));
    await fireEvent.click(within(rows()[1]!).getByText('09:55'));
    expect(onOpen.mock.calls).toEqual([
      [expect.objectContaining({ key: 'a1/i2' })],
      [expect.objectContaining({ key: 'a1/i2' })],
    ]);
    onOpen.mockClear();
    // Keyboard: the button is focusable, the browser triggers Enter and Space as a click – without its own
    // key handling, which would open a second time (jsdom does not trigger the click).
    openOf(rows()[1]!).focus();
    expect(document.activeElement).toBe(openOf(rows()[1]!));
    await fireEvent.keyDown(openOf(rows()[1]!), { key: 'Enter' });
    await fireEvent.keyDown(openOf(rows()[1]!), { key: ' ' });
    expect(onOpen).not.toHaveBeenCalled();
    const r1 = within(first);
    for (const name of ['Remove flag', 'Mark as read', 'Delete']) {
      const button = r1.getByRole('button', { name });
      await fireEvent.click(button);
      await fireEvent.keyDown(button, { key: 'Enter' });
    }
    await fireEvent.click(r1.getByRole('checkbox'));
    expect(onOpen).not.toHaveBeenCalled();
    // Once per click, with the row; Enter triggers the button's click in the browser, not in jsdom.
    for (const fn of [onStar, onRead, onDel, onSel])
      expect(fn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1' }));
  });

  it('fills the checkbox of selected rows and highlights them', async () => {
    const { view, rows, onSel, onOpen } = setup();
    expect(rows()[0]!.style.getPropertyValue('--b-bg')).toBe('transparent');
    expect(rows()[0]!.style.getPropertyValue('--b-hov')).toBe('var(--hov)');
    await view.rerender({ pf: values({ selected: new Set(['a1/t-i1']) }) });
    const [first, second] = rows();
    const ck1 = within(first!).getByRole('checkbox', { name: 'Deselect: Approve start page by Friday?' });
    expect(ck1).toHaveAttribute('aria-checked', 'true');
    expect(ck1.querySelector('.ck-box')).toHaveClass('on');
    expect(first!.style.getPropertyValue('--b-bg')).toBe('var(--accsoft)');
    expect(first!.style.getPropertyValue('--b-hov')).toBe('var(--accsoft)');
    const ck2 = within(second!).getByRole('checkbox', { name: 'Select: Minutes from Monday' });
    expect(ck2).toHaveAttribute('aria-checked', 'false');
    expect(ck2.querySelector('.ck-box')).not.toHaveClass('on');
    await fireEvent.click(ck2);
    expect(onSel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i2' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the selection bar instead of the column header when something is selected', async () => {
    vi.useFakeTimers();
    const { view, onSelAll, onClearSel, onBulk } = setup({
      pf: values({ selected: new Set(['a1/t-i1', 'a1/t-i2']) }),
    });
    expect(view.container.querySelector('.cols')).toBeNull();
    expect(view.getByRole('radiogroup', { name: 'Filter messages' })).toBeInTheDocument();
    const bar = within(view.getByRole('toolbar', { name: 'Selection actions' }));
    expect(bar.getByText('2 selected')).toBeInTheDocument();
    const all = bar.getByRole('checkbox', { name: 'Select all' });
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    expect(all.querySelector('.bar-box .tabler-icon-minus')).not.toBeNull();
    await fireEvent.click(all);
    expect(onSelAll).toHaveBeenCalledOnce();
    // One unread, not all flagged: read, flag, delete.
    expect(bar.getAllByRole('button').map((b) => b.textContent)).toEqual(['Read', 'Flag', 'Delete', '']);
    for (const name of ['Read', 'Flag', 'Delete']) await fireEvent.click(bar.getByRole('button', { name }));
    expect(onBulk.mock.calls).toEqual([['read'], ['flag'], ['trash']]);
    await fireEvent.pointerEnter(bar.getByRole('button', { name: 'Read' }), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Mark as read');
    await fireEvent.click(bar.getByRole('button', { name: 'Clear selection' }));
    expect(onClearSel).toHaveBeenCalledOnce();
  });

  it('clears the selection via the checkbox with all selected and offers other buttons in the trash', async () => {
    const selected = new Set(THREADS.map((t) => `a1/${t.threadId}`));
    const { view, onSelAll, onBulk } = setup({ pf: values({ selected }) });
    const bar = within(view.getByRole('toolbar'));
    expect(bar.getByText('3 selected')).toBeInTheDocument();
    const all = bar.getByRole('checkbox', { name: 'Clear selection' });
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(all.querySelector('.tabler-icon-check')).not.toBeNull();
    await fireEvent.click(all);
    expect(onSelAll).toHaveBeenCalledOnce();
    await view.rerender({ pf: values({ kind: { role: 'trash' }, title: 'Trash', selected }) });
    const trash = within(view.getByRole('toolbar'));
    expect(trash.getAllByRole('button').map((b) => b.textContent)).toEqual(['Restore', 'Delete permanently', '']);
    await fireEvent.click(trash.getByRole('button', { name: 'Restore' }));
    await fireEvent.click(trash.getByRole('button', { name: 'Delete permanently' }));
    expect(onBulk.mock.calls).toEqual([['restore'], ['purge']]);
  });

  it('highlights the focused row and scrolls it into view, without animation on mount', async () => {
    const reveal = vi.spyOn(VirtualList.prototype, 'reveal').mockImplementation(() => {});
    const { view, rows } = setup({ pf: values({ focus: 'a1/t-i3' }) });
    await tick();
    expect(rows()[2]!.style.getPropertyValue('--b-bg')).toBe('var(--surface2)');
    expect(rows()[0]!.style.getPropertyValue('--b-bg')).toBe('transparent');
    expect(reveal.mock.calls.map(revealed)).toEqual([[2, { smooth: false }]]);
    await view.rerender({ pf: values({ focus: 'a1/t-i1' }) });
    expect(reveal.mock.calls.map(revealed)).toEqual([
      [2, { smooth: false }],
      [0, { smooth: true }],
    ]);
    expect(rows()[0]!.style.getPropertyValue('--b-bg')).toBe('var(--surface2)');
    // New values with the same row do not scroll again.
    await view.rerender({ pf: values({ focus: 'a1/t-i1', selected: new Set(['a1/t-i2']) }) });
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('shows "Restore", "Delete permanently" and "Empty Trash" in the trash', async () => {
    const { view, rows, onOpen, onRestore, onDel, onClear } = setup({
      pf: values({ kind: { role: 'trash' }, title: 'Trash' }),
    });
    const r1 = within(rows()[0]!);
    expect(r1.queryByRole('button', { name: 'Mark as read' })).toBeNull();
    await fireEvent.click(r1.getByRole('button', { name: 'Restore' }));
    await fireEvent.click(r1.getByRole('button', { name: 'Delete permanently' }));
    expect(rows()[0]!.querySelector('.qa .tabler-icon-trash-x')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Empty Trash' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1' }));
    expect(onDel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('offers "Cancel send" instead of read, and delete, in Scheduled', async () => {
    const planned = { kind: { role: 'scheduled' }, title: 'Scheduled' } as const;
    const { view, rows, onOpen, onRead, onDel, onBulk } = setup({ pf: values(planned) });
    const r1 = within(rows()[0]!);
    expect(r1.getByRole('button', { name: 'Remove flag' })).toBeInTheDocument();
    for (const name of ['Mark as read', 'Mark as unread', 'Restore'])
      expect(r1.queryByRole('button', { name })).toBeNull();
    const cancel = r1.getByRole('button', { name: 'Cancel send' });
    expect(cancel.querySelector('.tabler-icon-clock-x')).not.toBeNull();
    await fireEvent.click(cancel);
    await fireEvent.click(r1.getByRole('button', { name: 'Delete' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1', sched: true }));
    expect(onDel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1' }));
    // Selection bar: cancel sending, flag, delete.
    await view.rerender({ pf: values({ ...planned, selected: new Set(['a1/t-i1', 'a1/t-i2']) }) });
    const bar = within(view.getByRole('toolbar', { name: 'Selection actions' }));
    expect(bar.getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel send', 'Flag', 'Delete', '']);
    for (const name of ['Cancel send', 'Flag', 'Delete']) await fireEvent.click(bar.getByRole('button', { name }));
    expect(onBulk.mock.calls).toEqual([['cancel'], ['flag'], ['trash']]);
  });

  it('shows drafts with chip and recipients', () => {
    const { rows } = setup({ pf: values({ kind: { role: 'drafts' }, title: 'Drafts' }) });
    const r1 = within(rows()[0]!);
    expect(r1.getByText('To: Jane Doe')).toBeInTheDocument();
    expect(r1.getByText('Draft')).toHaveClass('chip');
  });

  it('offers edit and delete in folders and tags', async () => {
    const { view, onFolderEdit, onFolderDelete } = setup({ pf: values({ kind: { folder: true }, title: 'Projects' }) });
    await fireEvent.click(view.getByRole('button', { name: 'Edit folder' }));
    expect(onFolderEdit).toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Delete folder' }));
    expect(onFolderDelete).toHaveBeenCalled();
    await view.rerender({ pf: values({ kind: { tag: true }, title: 'Important' }) });
    expect(view.queryByRole('button', { name: 'Edit folder' })).toBeNull();
    expect(view.getByRole('button', { name: 'Edit tag' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Delete tag' })).toBeInTheDocument();
  });

  it('shows the account dot with a tooltip in "All accounts"', async () => {
    vi.useFakeTimers();
    const threads = [thread({ id: 'x1', account: 'a2', key: 'a2/x1' })];
    const { rows } = setup({ pf: values({ threads, multi: true }) });
    const dot = rows()[0]!.querySelector<HTMLElement>('.acct')!;
    expect(dot).toHaveStyle({ backgroundColor: '#94c48d' });
    await fireEvent.pointerEnter(dot, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('alex@s2.test');
  });

  it('shows the empty state with icon and "Show all" in an empty segment', async () => {
    const pf = values({
      segment: 'flagged',
      threads: [],
      counts: { all: 3, unread: 1, flagged: 0 },
      total: 0,
    });
    const { view, rows, onSegment } = setup({ pf });
    expect(rows()).toEqual([]);
    expect(view.container.querySelector('.cols')).not.toBeNull();
    expect(view.container.querySelector('.e-icon .tabler-icon-star')).not.toBeNull();
    expect(view.getByText('Nothing flagged')).toBeInTheDocument();
    expect(view.getByText('Flag messages with the star to find them here.')).toBeInTheDocument();
    expect(view.getByRole('radio', { name: 'Flagged' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Show all' }));
    expect(onSegment).toHaveBeenCalledWith('all');
  });

  it('shows an empty mailbox without segments, column header and "Show all"', () => {
    const pf = values({ threads: [], counts: { all: 0, unread: 0, flagged: 0 }, total: 0 });
    const { view } = setup({ pf });
    expect(view.container.querySelector('.e-icon .tabler-icon-inbox')).not.toBeNull();
    expect(view.getByText('All done')).toBeInTheDocument();
    expect(view.getByText('Your inbox is empty.')).toBeInTheDocument();
    expect(view.queryByRole('radiogroup')).toBeNull();
    expect(view.container.querySelector('.cols')).toBeNull();
    expect(view.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('loads more pages when the end of the list is in the DOM', async () => {
    const { view, onMore } = setup({ hasMore: false });
    await tick();
    expect(onMore).not.toHaveBeenCalled();
    await view.rerender({ hasMore: true });
    expect(onMore).toHaveBeenCalled();
  });

  it('renders long lists only partly and then does not load more', async () => {
    const threads = Array.from({ length: 80 }, (_, i) => thread({ id: `n${i}`, receivedAt: NOW - i * 60_000 }));
    const { rows, onMore } = setup({ pf: values({ threads }), hasMore: true });
    await tick();
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(40);
    expect(onMore).not.toHaveBeenCalled();
  });

  it('shows area instead of summary, rows without column header, quick actions and tooltips on mobile', async () => {
    vi.useFakeTimers();
    const { view, rows, onOpen, onSegment, onRefresh } = setup({ isMobile: true });
    expect(view.container.querySelector('main')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    expect(view.getByText('3 messages')).toBeInTheDocument();
    expect(view.queryByText('1 unread · 3 messages')).toBeNull();
    expect(view.container.querySelector('.cols')).toBeNull();
    await fireEvent.click(view.getByRole('radio', { name: /^Flagged/ }));
    expect(onSegment).toHaveBeenCalledWith('flagged');
    await fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();

    const first = rows()[0]!;
    const r1 = within(first);
    expect(first).toHaveClass('unread');
    expect(r1.getByText('Anna Baker')).toHaveStyle({ fontWeight: '800' });
    expect(r1.getByText('20:55')).toBeInTheDocument();
    expect(r1.getByText('Approve start page by Friday?')).toBeInTheDocument();
    expect(r1.getByText('– Hi Jane, the drafts for the start page')).toHaveClass('prev');
    expect(first.querySelector('.tabler-icon-paperclip')).not.toBeNull();
    expect(first.querySelector('.star .tabler-icon-star-filled')).not.toBeNull();
    expect(first.querySelector('.tag')).toBeNull();
    expect(first.querySelector('.n')).toBeNull();
    expect(r1.queryByRole('checkbox')).toBeNull();
    expect(r1.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(rows()[1]!.querySelector('.star')).toBeNull();
    await fireEvent.pointerEnter(r1.getByText('20:55'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip).toBeNull();
    expect(first).not.toHaveAttribute('role');
    expect(first).not.toHaveAttribute('tabindex');
    expect(openOf(first)).toHaveAccessibleName(/^Anna Baker.*20:55.*Approve start page by Friday\?/);
    expect(openOf(first).querySelector('div')).toBeNull();
    await fireEvent.click(openOf(first));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'a1/i1' }));
  });

  it('highlights selected and focused rows on mobile without checkbox and selection bar', () => {
    // jsdom cannot scroll.
    vi.spyOn(VirtualList.prototype, 'reveal').mockImplementation(() => {});
    const { view, rows } = setup({
      isMobile: true,
      pf: values({ selected: new Set(['a1/t-i1']), focus: 'a1/t-i2' }),
    });
    expect(view.queryByRole('toolbar')).toBeNull();
    expect(view.queryByRole('checkbox')).toBeNull();
    expect(view.getByRole('radiogroup', { name: 'Filter messages' })).toBeInTheDocument();
    expect(rows().map((r) => r.style.getPropertyValue('--b-bg'))).toEqual([
      'var(--accsoft)',
      'var(--surface2)',
      'transparent',
    ]);
  });

  it('puts every row in a wrapper, without a swipe action without an area', () => {
    const { view } = setup();
    const shells = [...view.container.querySelectorAll<HTMLElement>('[data-sw]')];
    expect(shells.map((el) => el.dataset.sw)).toEqual(['a1/t-i1', 'a1/t-i2', 'a1/t-i3']);
    for (const el of shells) {
      expect(el.parentElement).toHaveClass('vitem');
      expect(el).not.toHaveClass('on');
      expect(el.querySelector('[data-sw-bg]')).toBeNull();
      expect(el.querySelector(':scope > [data-sw-row]')).toHaveClass('row');
    }
  });

  it('shows the area with the actions of both directions behind rows with a swipe action', () => {
    const { view } = setup({ pf: values({ swipe: SWIPE }) });
    const shells = [...view.container.querySelectorAll<HTMLElement>('[data-sw]')];
    expect(shells).toHaveLength(3);
    for (const el of shells) expect(el).toHaveClass('on');
    const bgs = shells.map((el) => el.querySelector<HTMLElement>(':scope > [data-sw-bg]')!);
    expect(bgs[0]!.children[0]).toHaveTextContent(swipeAction('star', { unread: true, star: true }, inbox)!.label);
    expect(bgs[0]!.children[1]).toHaveTextContent(swipeAction('del', { unread: true, star: true }, inbox)!.label);
    expect(bgs[1]!.children[0]).toHaveTextContent(swipeAction('star', { unread: false, star: false }, inbox)!.label);
  });

  it('leaves one side of the area empty when the direction has no action', () => {
    const { view } = setup({
      isMobile: true,
      // In Scheduled there is no "Read"; delete, however, exists.
      pf: values({ kind: { role: 'scheduled' }, title: 'Scheduled', swipe: { left: 'read', right: 'star' } }),
    });
    const bg = view.container.querySelector<HTMLElement>('[data-sw] > [data-sw-bg]')!;
    const [right, left] = [...bg.children] as HTMLElement[];
    expect(right).toHaveTextContent('Unflag');
    expect(left).toBeEmptyDOMElement();
  });

  // Star runs immediately on release, without sliding out.
  it('triggers the action of the direction for the row with a swipe gesture, on desktop and mobile', async () => {
    const { view, rows, onSwipe, onOpen } = setup({ pf: values({ swipe: SWIPE }) });
    const bgOf = (row: HTMLElement) => row.closest('[data-sw]')!.querySelector<HTMLElement>('[data-sw-bg]')!;
    // The gesture starts on the row's button and moves the row.
    swipe(openOf(rows()[1]!), 120, () => {
      expect(rows()[1]!.style.transform).toBe('translateX(120px)');
      expect(bgOf(rows()[1]!).style.opacity).toBe('1');
    });
    expect(onSwipe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'a1/i2' }),
      swipeAction('star', { unread: false, star: false }, inbox),
    );
    await view.rerender({ isMobile: true });
    swipe(rows()[2]!, 120, () => expect(rows()[2]!.style.transform).toBe('translateX(120px)'));
    expect(onSwipe).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'a1/i3' }),
      expect.objectContaining({ key: 'star' }),
    );
    // Below the threshold (30 % of 300 px) and too short for a fling (48 px): the row springs back.
    swipe(rows()[0]!, 40);
    expect(onSwipe).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('lets the row slide out first on delete', () => {
    const { rows, onSwipe } = setup({ isMobile: true, pf: values({ swipe: SWIPE }) });
    vi.useFakeTimers();
    const row = rows()[0]!;
    swipe(row, -150);
    expect(row.style.transform).toBe('translateX(-324px)');
    expect(onSwipe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(210);
    expect(onSwipe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'a1/i1' }),
      swipeAction('del', { unread: true, star: true }, inbox),
    );
  });

  it('does not swipe without a swipe action', () => {
    const { rows, onSwipe } = setup({ isMobile: true });
    swipe(rows()[0]!, 150);
    expect(rows()[0]!.style.transform).toBe('');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('shows the empty state with icon on mobile', async () => {
    const pf = values({ segment: 'unread', threads: [], counts: { all: 3, unread: 0, flagged: 1 }, total: 0 });
    const { view, onSegment } = setup({ pf, isMobile: true });
    expect(view.container.querySelector('.e-icon .tabler-icon-mail-opened')).not.toBeNull();
    expect(view.getByText('All caught up')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Show all' }));
    expect(onSegment).toHaveBeenCalledWith('all');
  });

  describe.each([
    ['on desktop', false],
    ['on mobile', true],
  ])('without access or connection %s', (_, isMobile) => {
    it('shows neither hint nor row below the list without a restriction', () => {
      const { view } = setup({ pf: notice(THREADS, {}), isMobile });
      expect(view.container.querySelector('.note')).toBeNull();
      expect(view.container.querySelector('.foot')).toBeNull();
    });

    it('shows the hint with "Sign in again" above the list', async () => {
      const { view, onGoAccount } = setup({ pf: notice(THREADS, STALE), isMobile });
      const note = view.container.querySelector<HTMLElement>('.note')!;
      expect(note).toHaveAttribute('role', 'status');
      expect(note).toHaveTextContent('Sign-in to mail.s1.test required. You’re seeing the last synced data.');
      expect(note.querySelector('.tabler-icon-plug-connected-x')).not.toBeNull();
      expect(isBefore(note, view.container.querySelector('.vlist')!)).toBe(true);
      if (!isMobile) expect(isBefore(note, view.container.querySelector('.cols')!)).toBe(true);
      expect(within(note).queryByRole('button', { name: 'Go to connection' })).toBeNull();
      const button = within(note).getByRole('button', { name: 'Sign in again' });
      expect(button.querySelector('.tabler-icon-login-2')).not.toBeNull();
      await fireEvent.click(button);
      expect(onGoAccount).toHaveBeenCalledOnce();
    });

    it('shows the hint with "Go to connection" above the list', async () => {
      const { view, onGoAccount } = setup({ pf: notice(THREADS, BLOCKED), isMobile });
      const note = view.container.querySelector<HTMLElement>('.note')!;
      expect(note).toHaveTextContent(
        'mail.s1.test is no longer an approved server. You’re seeing the last synced data.',
      );
      expect(within(note).queryByRole('button', { name: 'Sign in again' })).toBeNull();
      const button = within(note).getByRole('button', { name: 'Go to connection' });
      expect(button.querySelector('.tabler-icon-arrow-right')).not.toBeNull();
      await fireEvent.click(button);
      expect(onGoAccount).toHaveBeenCalledOnce();
    });

    it('offers "Sign in again" in the empty state', async () => {
      const { view, onGoAccount } = setup({ pf: notice([], STALE), isMobile });
      const empty = view.container.querySelector<HTMLElement>('.empty')!;
      expect(view.container.querySelector('.note')).toBeNull();
      expect(empty.querySelector('.e-icon .tabler-icon-plug-connected-x')).not.toBeNull();
      expect(empty).toHaveTextContent('Sign-in required');
      expect(empty).toHaveTextContent('You need to sign in to account1@s1.test again.');
      expect(within(empty).queryByRole('button', { name: 'Go to connection' })).toBeNull();
      expect(within(empty).queryByRole('button', { name: 'Show all' })).toBeNull();
      const button = within(empty).getByRole('button', { name: 'Sign in again' });
      expect(button.querySelector('.tabler-icon-login-2')).not.toBeNull();
      await fireEvent.click(button);
      expect(onGoAccount).toHaveBeenCalledOnce();
    });

    it('offers "Go to connection" in the empty state', async () => {
      const { view, onGoAccount } = setup({ pf: notice([], BLOCKED), isMobile });
      const empty = view.container.querySelector<HTMLElement>('.empty')!;
      expect(empty).toHaveTextContent('Server blocked');
      expect(empty).toHaveTextContent('mail.s1.test is no longer an approved server.');
      expect(within(empty).queryByRole('button', { name: 'Sign in again' })).toBeNull();
      const button = within(empty).getByRole('button', { name: 'Go to connection' });
      expect(button.querySelector('.tabler-icon-arrow-right')).not.toBeNull();
      await fireEvent.click(button);
      expect(onGoAccount).toHaveBeenCalledOnce();
    });

    it('says below the list that older messages are not stored offline', () => {
      const { view } = setup({ pf: notice(THREADS, {}, { offline: true, truncated: true }), isMobile });
      const foot = view.container.querySelector<HTMLElement>('.foot')!;
      expect(foot).toHaveAttribute('role', 'status');
      expect(foot).toHaveTextContent('Older messages aren’t saved for offline use.');
      expect(foot.querySelector('.tabler-icon-cloud-off')).not.toBeNull();
      expect(isBefore(view.container.querySelector('.vlist')!, foot)).toBe(true);
    });

    it('does not show the row below the list when nothing is cut off', () => {
      const { view } = setup({ pf: notice(THREADS, {}, { offline: true }), isMobile });
      expect(view.container.querySelector('.foot')).toBeNull();
    });
  });
});
