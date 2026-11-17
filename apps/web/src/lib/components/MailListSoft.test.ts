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
import MailListSoft from './MailListSoft.svelte';

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

function setup(props: { pf?: ListValues; isMobile?: boolean; rot?: number; hasMore?: boolean } = {}) {
  const fns = {
    onSegment: vi.fn(),
    onOpen: vi.fn(),
    onRefresh: vi.fn(),
    onMore: vi.fn(),
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
  const view = render(MailListSoft, {
    pf: values(),
    isMobile: false,
    rot: 0,
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
// 600 px high, heads and rows have a fixed height.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.matches('.scroll, main.mobile') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.matches('.vitem')) return 0;
    return this.querySelector('.ghead') ? 57 : 71;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('[data-sw]') ? 300 : 0;
  });
});

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('message list (soft)', () => {
  it('shows head, segments with counters and refresh', async () => {
    const { view, onSegment, onRefresh } = setup();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    expect(view.getByText('1 unread · 3 messages')).toBeInTheDocument();
    const seg = view.getByRole('radiogroup', { name: 'Filter messages' });
    const radios = within(seg).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['All', 'Unread1', 'Flagged1']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveClass('on');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(radios[1]!);
    expect(onSegment).toHaveBeenCalledWith('unread');
    expect(view.queryByText('Empty Trash')).toBeNull();
    expect(view.queryByRole('button', { name: 'Edit folder' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Edit tag' })).toBeNull();
    const refresh = view.getByRole('button', { name: 'Refresh' });
    expect(refresh.querySelector<HTMLElement>('.ri')!.style.transform).toBe('rotate(0deg)');
    await fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('turns the icon two more revolutions per refresh instead of spinning', async () => {
    const { view } = setup({ rot: 720 });
    const icon = () => view.getByRole('button', { name: 'Refresh' }).querySelector<HTMLElement>('.ri')!;
    expect(icon().style.transform).toBe('rotate(720deg)');
    expect(icon()).not.toHaveClass('spin');
    await view.rerender({ rot: 1440 });
    expect(icon().style.transform).toBe('rotate(1440deg)');
  });

  it('shows groups with counter and the rows with all details', () => {
    const { view, rows } = setup();
    const heads = view.getAllByRole('heading', { level: 2 });
    expect(heads.map((h) => h.textContent)).toEqual(['Today', 'Yesterday']);
    expect(heads.map((h) => h.nextElementSibling?.textContent)).toEqual(['2', '1']);
    // Only the first head keeps the full space above it; further heads follow the previous group's end.
    expect(heads.map((h) => h.parentElement?.classList.contains('first'))).toEqual([true, false]);
    const [first, second, third] = rows();

    const r1 = within(first!);
    expect(r1.getByText('Anna Baker')).toHaveStyle({ fontWeight: '800' });
    expect(r1.getByText('AB')).toBeInTheDocument();
    expect(r1.getByText('3')).toHaveClass('n');
    expect(r1.getByText('Approve start page by Friday?')).toBeInTheDocument();
    expect(r1.getByText('– Hi Jane, the drafts for the start page')).toHaveClass('prev');
    expect(r1.getByText('20:55')).toHaveStyle({ fontWeight: '800' });
    expect(r1.getByText('Important')).toHaveClass('tag');
    expect(first!.querySelector('.meta .tabler-icon-paperclip')).not.toBeNull();
    expect(first!.querySelector('.meta .tabler-icon-star-filled')).not.toBeNull();
    const ck = r1.getByRole('checkbox', { name: 'Select: Approve start page by Friday?' });
    expect(ck).toHaveAttribute('aria-checked', 'false');
    expect(r1.getByRole('button', { name: 'Remove flag' })).toHaveAttribute('aria-pressed', 'true');
    expect(r1.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    expect(r1.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(r1.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(first!.querySelector('.acct')).toBeNull();
    expect(first!.querySelector('.chip')).toBeNull();

    const r2 = within(second!);
    expect(r2.getByText('Ben Carter')).toHaveStyle({ fontWeight: '600' });
    expect(r2.getByText('09:55')).toBeInTheDocument();
    expect(second!.querySelector('.n')).toBeNull();
    expect(second!.querySelector('.tag')).toBeNull();
    expect(second!.querySelector('.meta .tabler-icon-paperclip')).toBeNull();
    expect(second!.querySelector('.meta .tabler-icon-star-filled')).toBeNull();
    expect(r2.getByRole('button', { name: 'Flag' })).toHaveAttribute('aria-pressed', 'false');
    expect(r2.getByRole('button', { name: 'Mark as unread' })).toBeInTheDocument();

    // Without a sender "Unknown" and an icon instead of initials, without a subject "(No subject)".
    const r3 = within(third!);
    expect(third!.querySelector('.av-l .tabler-icon-user-question')).not.toBeNull();
    expect(third!.querySelector('.who')).toHaveTextContent('Unknown');
    expect(r3.getByText('(No subject)')).toBeInTheDocument();
    expect(r3.getByText('Yesterday')).toBeInTheDocument();
    expect(r3.getByRole('checkbox', { name: 'Select: Message' })).toBeInTheDocument();
  });

  it('names the full time and the number of messages in the tooltip', async () => {
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
  });

  it('opens a row via its button with the text, not via checkbox and quick actions', async () => {
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
    for (const el of [within(first).getByRole('checkbox'), first.querySelector('.qa')!])
      expect(open.contains(el)).toBe(false);

    await fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i1', threadId: 't-i1' }));
    onOpen.mockClear();
    // A click on the text reaches the button.
    await fireEvent.click(within(rows()[1]!).getByText('Minutes from Monday'));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i2' }));
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

  it('shows the checkbox without selection only on hover, with selection in all rows', async () => {
    const { view, rows, onSel, onOpen } = setup();
    for (const r of rows()) expect(within(r).getByRole('checkbox')).not.toHaveClass('show');
    await view.rerender({ pf: values({ selected: new Set(['a1/t-i1']) }) });
    const [first, second] = rows();
    const ck1 = within(first!).getByRole('checkbox', { name: 'Deselect: Approve start page by Friday?' });
    expect(ck1).toHaveAttribute('aria-checked', 'true');
    expect(ck1).toHaveClass('show', 'on');
    expect(first!.style.getPropertyValue('--a-bg')).toBe('var(--accsoft)');
    const ck2 = within(second!).getByRole('checkbox', { name: 'Select: Minutes from Monday' });
    expect(ck2).toHaveAttribute('aria-checked', 'false');
    expect(ck2).toHaveClass('show');
    expect(ck2).not.toHaveClass('on');
    await fireEvent.click(ck2);
    expect(onSel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'a1/i2' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the selection bar above the list when something is selected and keeps the segments', async () => {
    const { view, onSelAll, onClearSel, onBulk } = setup();
    expect(view.queryByRole('toolbar')).toBeNull();
    await view.rerender({ pf: values({ selected: new Set(['a1/t-i1', 'a1/t-i2']) }) });
    expect(view.getByRole('radiogroup', { name: 'Filter messages' })).toBeInTheDocument();
    const toolbar = view.getByRole('toolbar', { name: 'Selection actions' });
    expect(toolbar.parentElement).toHaveClass('sel');
    const bar = within(toolbar);
    expect(bar.getByText('2 selected')).toBeInTheDocument();
    const all = bar.getByRole('checkbox', { name: 'Select all' });
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    expect(all.querySelector('.tabler-icon-minus')).not.toBeNull();
    await fireEvent.click(all);
    expect(onSelAll).toHaveBeenCalledOnce();
    // One unread, not all flagged: read, flag, delete.
    for (const name of ['Read', 'Flag', 'Delete']) await fireEvent.click(bar.getByRole('button', { name }));
    expect(onBulk.mock.calls).toEqual([['read'], ['flag'], ['trash']]);
    await fireEvent.click(bar.getByRole('button', { name: 'Clear selection' }));
    expect(onClearSel).toHaveBeenCalledOnce();
  });

  it('names the actions of the selection bar in the tooltip', async () => {
    vi.useFakeTimers();
    const { view } = setup({ pf: values({ selected: new Set(['a1/t-i1']) }) });
    const bar = within(view.getByRole('toolbar'));
    expect(bar.getByText('1 selected')).toBeInTheDocument();
    await fireEvent.pointerEnter(bar.getByRole('button', { name: 'Read' }), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Mark as read');
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

  it('shows the focused row with a ring and scrolls it into view, without animation on mount', async () => {
    const reveal = vi.spyOn(VirtualList.prototype, 'reveal').mockImplementation(() => {});
    const { view, rows } = setup({ pf: values({ focus: 'a1/t-i3' }) });
    await tick();
    expect(rows()[2]!.style.getPropertyValue('--a-sh')).toBe('0 0 0 2px var(--acc)');
    expect(rows()[0]!.style.getPropertyValue('--a-sh')).toBe('var(--sh1)');
    // Entries: head "Today", i1, i2, head "Yesterday", i3.
    expect(reveal.mock.calls.map(revealed)).toEqual([[4, { smooth: false }]]);
    await view.rerender({ pf: values({ focus: 'a1/t-i1' }) });
    expect(reveal.mock.calls.map(revealed)).toEqual([
      [4, { smooth: false }],
      [1, { smooth: true }],
    ]);
    expect(rows()[0]!.style.getPropertyValue('--a-sh')).toBe('0 0 0 2px var(--acc)');
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
    expect(rows()[0]!.querySelector('.tabler-icon-trash-x')).not.toBeNull();
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

  it('shows the empty state and "Show all" in an empty segment', async () => {
    const pf = values({
      segment: 'flagged',
      threads: [],
      counts: { all: 3, unread: 1, flagged: 0 },
      total: 0,
    });
    const { view, rows, onSegment } = setup({ pf });
    expect(rows()).toEqual([]);
    expect(view.getByText('Nothing flagged')).toBeInTheDocument();
    expect(view.getByText('Flag messages with the star to find them here.')).toBeInTheDocument();
    expect(view.getByRole('radio', { name: 'Flagged' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Show all' }));
    expect(onSegment).toHaveBeenCalledWith('all');
  });

  it('shows an empty mailbox without segments and without "Show all"', () => {
    const pf = values({ threads: [], counts: { all: 0, unread: 0, flagged: 0 }, total: 0 });
    const { view } = setup({ pf });
    expect(view.getByText('All done')).toBeInTheDocument();
    expect(view.getByText('Your inbox is empty.')).toBeInTheDocument();
    expect(view.queryByRole('radiogroup')).toBeNull();
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
    const threads = Array.from({ length: 60 }, (_, i) => thread({ id: `n${i}`, receivedAt: NOW - i * 60_000 }));
    const { rows, onMore } = setup({ pf: values({ threads }), hasMore: true });
    await tick();
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(30);
    expect(onMore).not.toHaveBeenCalled();
  });

  it('shows area instead of summary, rows without quick actions and no tooltips on mobile', async () => {
    vi.useFakeTimers();
    const { view, rows, onOpen, onSegment, onRefresh } = setup({ isMobile: true });
    expect(view.container.querySelector('main')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    expect(view.getByText('3 messages')).toBeInTheDocument();
    expect(view.queryByText('1 unread · 3 messages')).toBeNull();
    await fireEvent.click(view.getByRole('radio', { name: /^Flagged/ }));
    expect(onSegment).toHaveBeenCalledWith('flagged');
    await fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();

    const first = rows()[0]!;
    const r1 = within(first);
    expect(r1.getByText('Anna Baker')).toBeInTheDocument();
    expect(r1.getByText('20:55')).toBeInTheDocument();
    expect(r1.getByText('Approve start page by Friday?')).toBeInTheDocument();
    expect(r1.getByText('Hi Jane, the drafts for the start page')).toHaveClass('prev-m');
    expect(r1.getByText('Important')).toHaveClass('tag');
    expect(first.querySelector('.tabler-icon-paperclip')).not.toBeNull();
    expect(first.querySelector('.tabler-icon-star-filled')).not.toBeNull();
    expect(first.querySelector('.n')).toBeNull();
    expect(r1.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(r1.getByRole('checkbox', { name: 'Select: Approve start page by Friday?' })).toBeInTheDocument();
    await fireEvent.pointerEnter(r1.getByText('20:55'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip).toBeNull();
    expect(first).not.toHaveAttribute('role');
    expect(openOf(first).querySelector('div')).toBeNull();
    expect(openOf(first).contains(r1.getByRole('checkbox'))).toBe(false);
    await fireEvent.click(openOf(first));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'a1/i1' }));
  });

  it('shows the selection bar with icon buttons instead of the segments on mobile', async () => {
    const { view, onClearSel, onBulk } = setup({
      isMobile: true,
      pf: values({ selected: new Set(['a1/t-i1', 'a1/t-i2']) }),
    });
    expect(view.queryByRole('radiogroup')).toBeNull();
    const toolbar = view.getByRole('toolbar', { name: 'Selection actions' });
    expect(toolbar.parentElement).toHaveClass('m-head');
    const bar = within(toolbar);
    expect(bar.getByText('2 selected')).toBeInTheDocument();
    expect(bar.queryByRole('checkbox')).toBeNull();
    const buttons = bar.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Clear selection',
      'Mark as read',
      'Flag',
      'Delete',
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual(['', '', '', '']);
    for (const b of buttons.slice(1)) await fireEvent.click(b);
    expect(onBulk.mock.calls).toEqual([['read'], ['flag'], ['trash']]);
    await fireEvent.click(buttons[0]!);
    expect(onClearSel).toHaveBeenCalledOnce();
  });

  it('puts every row in a wrapper, without a swipe action without an area', () => {
    const { view } = setup();
    const shells = [...view.container.querySelectorAll<HTMLElement>('[data-sw]')];
    expect(shells.map((el) => el.dataset.sw)).toEqual(['a1/t-i1', 'a1/t-i2', 'a1/t-i3']);
    for (const el of shells) {
      expect(el.parentElement).toHaveClass('band');
      expect(el).not.toHaveClass('on');
      expect(el.querySelector('[data-sw-bg]')).toBeNull();
      expect(el.querySelector(':scope > [data-sw-row]')).toHaveClass('row');
    }
  });

  it('shows the area with the actions of both directions behind rows with a swipe action', () => {
    const { view } = setup({ isMobile: true, pf: values({ swipe: { left: 'del', right: 'star' } }) });
    const shells = [...view.container.querySelectorAll<HTMLElement>('[data-sw]')];
    expect(shells).toHaveLength(3);
    for (const el of shells) expect(el).toHaveClass('on');
    const bgs = shells.map((el) => el.querySelector<HTMLElement>(':scope > [data-sw-bg]')!);
    expect(bgs[0]!.children[0]).toHaveTextContent('Unflag');
    expect(bgs[0]!.children[1]).toHaveTextContent('Delete');
    expect(bgs[1]!.children[0]).toHaveTextContent('Flag');
  });

  it('swipes in a direction without an action only as a rubber band', () => {
    const { rows, onSwipe } = setup({
      pf: values({ kind: { role: 'trash' }, title: 'Trash', swipe: { left: 'del', right: 'read' } }),
    });
    const bg = rows()[0]!.closest('[data-sw]')!.querySelector<HTMLElement>('[data-sw-bg]')!;
    expect(bg.children[0]).toBeEmptyDOMElement();
    expect(bg.children[1]).toHaveTextContent('Delete permanently');
    swipe(rows()[0]!, 120);
    expect(onSwipe).not.toHaveBeenCalled();
    swipe(rows()[0]!, -120, () => expect(rows()[0]!.style.transform).toBe('translateX(-120px)'));
    expect(onSwipe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'a1/i1' }),
      swipeAction('del', { unread: true, star: true }, { role: 'trash' }),
    );
  });

  // Star and read run immediately on release, without sliding out.
  it('triggers the action of the direction for the row with a swipe gesture', () => {
    const { rows, onSwipe, onOpen } = setup({
      isMobile: true,
      pf: values({ swipe: { left: 'read', right: 'star' } }),
    });
    const bg = rows()[1]!.closest('[data-sw]')!.querySelector<HTMLElement>('[data-sw-bg]')!;
    // The gesture starts on the row's button and moves the row.
    swipe(openOf(rows()[1]!), 120, () => {
      expect(rows()[1]!.style.transform).toBe('translateX(120px)');
      expect(bg.style.opacity).toBe('1');
    });
    expect(onSwipe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'a1/i2' }),
      swipeAction('star', { unread: false, star: false }, { role: 'inbox' }),
    );
    swipe(rows()[0]!, -120);
    expect(onSwipe).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'a1/i1' }),
      swipeAction('read', { unread: true, star: true }, { role: 'inbox' }),
    );
    // Below the threshold (30 % of 300 px) and too short for a fling (48 px): the row springs back.
    swipe(rows()[2]!, 40);
    expect(onSwipe).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not swipe without a swipe action', () => {
    const { rows, onSwipe } = setup({ isMobile: true });
    swipe(rows()[0]!, 150);
    expect(rows()[0]!.style.transform).toBe('');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('shows the empty state with a scaled-down artwork on mobile', async () => {
    const pf = values({ segment: 'unread', threads: [], counts: { all: 3, unread: 0, flagged: 1 }, total: 0 });
    const { view, onSegment } = setup({ pf, isMobile: true });
    expect(view.container.querySelector('.art-frame .art')).not.toBeNull();
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
