import { MA_COLORS, MODES } from '@roedy/tokens';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { renderMail } from '#lib/mail/render.ts';
import { readValues, type ReadInput, type ReadValues } from '#lib/message-view.ts';
import { replyValues, type ReplyActions, type ReplyState, type ReplyValues } from '#lib/reply.ts';
import { m } from '#lib/paraglide/messages.js';
import { M_TAB_PAD_B } from '#lib/shell.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';
import type { MessageEmail, MessagePart } from '#lib/state/message.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MessageView from './MessageView.svelte';

/** Wednesday, 28 October 2026, 20:55 in Berlin. */
const NOW = Date.parse('2026-10-28T19:55:00Z');
const HOUR = 3_600_000;
const ME = 'account1@s1.test';
const ROLES = { sent: 'sent', drafts: 'drafts', scheduled: 'sched', trash: 'trash', spam: 'spam' };

const textPart = (value: string) => ({
  textBody: [
    { partId: '1', blobId: 'b', size: 1, name: null, type: 'text/plain', charset: null, disposition: null, cid: null },
  ],
  bodyValues: { '1': { value, isEncodingProblem: false, isTruncated: false } },
});

const PDF: MessagePart = {
  partId: '2',
  blobId: 'b2',
  size: 123_904,
  name: 'Start_page_draft_v1.pdf',
  type: 'application/pdf',
  charset: null,
  disposition: 'attachment',
  cid: null,
};

function email(id: string, patch: Partial<MessageEmail> = {}): MessageEmail {
  return {
    id,
    blobId: `blob-${id}`,
    threadId: 't1',
    mailboxIds: ['in'],
    keywords: {},
    receivedAt: NOW - 2 * HOUR,
    from: [{ name: 'Anna Baker', email: 'anna.baker@example.com' }],
    to: [{ name: null, email: ME }],
    cc: [],
    replyTo: [],
    messageId: [],
    inReplyTo: [],
    references: [],
    subject: 'Approve start page by Friday?',
    preview: 'Preview',
    hasAttachment: false,
    htmlBody: [],
    attachments: [],
    ...textPart(`Text ${id}`),
    ...patch,
  };
}

/** Conversation: Anna asks, I reply, Anna sends the draft with an attachment. */
const THREAD: MessageEmail[] = [
  email('e1', {
    receivedAt: NOW - 30 * HOUR,
    mailboxIds: ['in', 'important'],
    ...textPart('Hi Jane,\n\nthe drafts are now in the project folder.\n\nBest regards\nAnna'),
  }),
  email('e2', {
    receivedAt: NOW - 20 * HOUR,
    mailboxIds: ['sent'],
    from: [{ name: 'Jane Doe', email: ME }],
    to: [{ name: 'Anna Baker', email: 'anna.baker@example.com' }],
    ...textPart('Thanks, I will take a look.'),
  }),
  email('e3', {
    receivedAt: NOW - HOUR,
    cc: [{ name: 'Ben Carter', email: 'ben@example.com' }],
    attachments: [PDF],
    ...textPart('Hi Jane,\n\nattached is the draft.\n\nBest regards\nAnna'),
  }),
];

const tagNode = (id: string, name: string, color: number, children: TagNode[] = []): TagNode => ({
  id,
  name,
  color,
  children,
  unread: 0,
  total: 0,
});

const folder = (id: string, name: string, children: FolderNode[] = []): FolderNode => ({
  id,
  name,
  children,
  unread: 0,
  total: 0,
});

/** Tag list: Important (on e1), Projects with New. */
const TAG_TREE = [tagNode('w', 'Important', 3), tagNode('p', 'Projects', 1, [tagNode('n', 'New', 1)])];

/** Targets: Inbox (where the conversation is), Archive with 2025, Projects. */
const MOVE = {
  inbox: 'in',
  folders: [folder('a', 'Archive', [folder('a1', '2025')]), folder('pr', 'Projects')],
  on: (box: string) => box === 'in',
};

function values(patch: Partial<ReadInput> = {}): ReadValues {
  return readValues({
    emails: THREAD,
    repId: null,
    kind: { role: 'inbox' },
    title: 'Inbox',
    account: { email: ME, color: 2, state: 'ok' },
    roles: ROLES,
    multi: false,
    tagOf: (box) => (box === 'important' ? { id: 'w', name: 'Important', color: 3 } : undefined),
    menu: null,
    tagTree: TAG_TREE,
    tagPending: new Set(),
    move: MOVE,
    time: { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' },
    folds: {},
    dark: false,
    inverted: false,
    isMobile: false,
    ext: { extMode: 'ask', extAllow: [] },
    once: new Set(),
    render: renderMail,
    images: {},
    loadingFull: new Set(),
    offline: false,
    nav: { index: 1, total: 16, hasPrev: true, hasNext: true },
    ...patch,
  });
}

/** Values of the reply bar for `rd`; with `state` open (kind, text, address). */
function reply(rd: ReadValues, state: Partial<ReplyState> | null = null, off = false): ReplyValues {
  const open = state ? { mode: 'reply' as const, text: '', to: '', ...state } : null;
  return replyValues(rd.reply, open, 'Ctrl', off);
}

const OFF_REPLY = m.offline_reply();

function setup(
  props: {
    rd?: ReadValues;
    rp?: ReplyValues;
    isMobile?: boolean;
    moreOpen?: boolean;
    conversationKey?: string;
    enter?: boolean;
    replyFocus?: number;
  } = {},
) {
  const fns = {
    onClose: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToggle: vi.fn(),
    onDownload: vi.fn(),
    onTheme: vi.fn(),
    onSource: vi.fn(),
    onMore: vi.fn(),
    onStar: vi.fn(),
    onUnread: vi.fn(),
    onCancel: vi.fn(),
    onSendNow: vi.fn(),
    onRestore: vi.fn(),
    onSpam: vi.fn(),
    onDel: vi.fn(),
    onTagMenu: vi.fn(),
    onMoveMenu: vi.fn(),
    onTagPick: vi.fn(),
    onMovePick: vi.fn(),
    onExtOnce: vi.fn(),
    onExtAlways: vi.fn(),
    onFull: vi.fn(),
    onMissRetry: vi.fn(),
  };
  const replyActions = {
    open: vi.fn<ReplyActions['open']>(),
    mode: vi.fn<ReplyActions['mode']>(),
    text: vi.fn<ReplyActions['text']>(),
    to: vi.fn<ReplyActions['to']>(),
    send: vi.fn<ReplyActions['send']>(),
    cancel: vi.fn<ReplyActions['cancel']>(),
    expand: vi.fn<ReplyActions['expand']>(),
    files: vi.fn<ReplyActions['files']>(),
  } satisfies ReplyActions;
  const rd = props.rd ?? values();
  const view = render(MessageView, {
    isMobile: false,
    ...fns,
    replyActions,
    ...props,
    rd,
    rp: props.rp ?? reply(rd),
  });
  const calls = () => Object.values(fns).reduce((n, f) => n + f.mock.calls.length, 0);
  const replyCalls = () => Object.values(replyActions).reduce((n, f) => n + f.mock.calls.length, 0);
  return { view, calls, replyActions, replyCalls, ...fns };
}

/**
 * Expand and collapse as in the route: `onToggle` changes `folds` and passes
 * new values in. Via keyboard focus stays on the same email (the element
 * is replaced), via mouse nothing changes about focus.
 */
async function expectFocusKept(isMobile: boolean) {
  let folds: Record<string, boolean> = {};
  const { view, onToggle } = setup({ isMobile });
  onToggle.mockImplementation((key: string) => {
    const open = values({ folds }).msgs.find((x) => x.key === key)!.open;
    folds = { ...folds, [key]: !open };
    void view.rerender({ rd: values({ folds }) });
  });
  const folded = (key: string, expanded: boolean) =>
    view.getAllByRole('button', { expanded }).find((b) => b.dataset.fold === key)!;

  // Keyboard: the collapsed button has focus, Enter or Space click it.
  folded('e1', false).focus();
  await fireEvent.click(folded('e1', false));
  await waitFor(() => expect(document.activeElement).toBe(folded('e1', true)));
  expect(document.activeElement).toHaveAttribute('role', 'button');
  await fireEvent.keyDown(folded('e1', true), { key: 'Enter' });
  await waitFor(() => expect(document.activeElement).toBe(folded('e1', false)));
  expect(document.activeElement!.tagName).toBe('BUTTON');

  // Mouse: without focus before, the new element gets none either.
  (document.activeElement as HTMLElement).blur();
  await fireEvent.click(folded('e2', false));
  await waitFor(() => expect(folded('e2', true)).toBeInTheDocument());
  expect(document.activeElement).toBe(document.body);
  expect(onToggle.mock.calls).toEqual([['e1'], ['e1'], ['e2']]);
}

/** Hidden file input for "Add attachment". */
const fileInput = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[type="file"]')!;

async function tipOf(el: Element): Promise<string | undefined> {
  await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_DELAY);
  const text = ui.tip?.text;
  await fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  return text;
}

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reading view', () => {
  it('shows the toolbar with back, actions, theme and position', async () => {
    vi.useFakeTimers();
    const { view, onClose, onPrev, onNext, onTheme, onSource, onStar, onUnread, onSpam, onDel } = setup();
    const bar = within(view.getByRole('toolbar', { name: 'Message' }));
    const back = bar.getByRole('button', { name: 'Inbox' });
    expect(await tipOf(back)).toBe('Back (Esc)');
    const star = bar.getByRole('button', { name: 'Flag' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    expect(star.querySelector('.tabler-icon-star')).not.toBeNull();
    const tag = bar.getByRole('button', { name: 'Add tag' });
    expect(tag).toHaveAttribute('aria-haspopup', 'menu');
    expect(tag).toHaveAttribute('aria-expanded', 'false');
    expect(bar.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-expanded', 'false');
    expect(bar.getByRole('button', { name: 'Mark as unread' })).toBeInTheDocument();
    expect(bar.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(bar.getByRole('button', { name: 'Report spam' }).querySelector('.tabler-icon-alert-octagon')).not.toBeNull();
    expect(bar.getByRole('button', { name: 'Delete' }).querySelector('.tabler-icon-trash')).not.toBeNull();
    const theme = bar.getByRole('button', { name: 'Email in dark mode' });
    expect(theme).toHaveAttribute('aria-pressed', 'false');
    expect(theme.querySelector('.tabler-icon-moon')).not.toBeNull();
    expect(bar.getByText('2 of 16')).toHaveClass('pos');
    const prev = bar.getByRole('button', { name: 'Previous message' });
    const next = bar.getByRole('button', { name: 'Next message' });
    expect(prev).toHaveStyle({ opacity: '1', cursor: 'pointer' });
    expect(await tipOf(prev)).toBe('Previous (K)');
    expect(await tipOf(next)).toBe('Next (J)');
    expect(await tipOf(tag)).toBe('Add tag');

    expect(view.queryByRole('menu')).toBeNull();
    for (const name of ['Flag', 'Mark as unread', 'Report spam', 'Delete'])
      await fireEvent.click(bar.getByRole('button', { name }));
    expect([onStar, onUnread, onSpam, onDel].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);

    const source = bar.getByRole('button', { name: 'View source' });
    expect(source).toHaveAttribute('aria-haspopup', 'dialog');
    expect(await tipOf(source)).toBe('View source');
    await fireEvent.click(source);
    expect(onSource).toHaveBeenCalledOnce();

    await fireEvent.click(back);
    expect(onClose).toHaveBeenCalledOnce();
    await fireEvent.click(prev);
    expect(onPrev).toHaveBeenCalledOnce();
    await fireEvent.click(next);
    expect(onNext).toHaveBeenCalledOnce();
    await fireEvent.click(theme);
    expect(onTheme).toHaveBeenCalledOnce();
  });

  it('opens and closes the popovers "Add tag" and "Move to" via their buttons', async () => {
    const { view, calls, onTagMenu, onMoveMenu } = setup();
    const bar = within(view.getByRole('toolbar'));
    const tag = bar.getByRole('button', { name: 'Add tag' });
    const move = bar.getByRole('button', { name: 'Move' });
    // A click outside closes via the layout: button and popover sit in one `data-pop`.
    expect(tag.parentElement).toHaveAttribute('data-pop', '1');
    expect(move.parentElement).toHaveAttribute('data-pop', '1');
    await fireEvent.click(tag);
    await fireEvent.click(move);
    expect(onTagMenu).toHaveBeenCalledOnce();
    expect(onMoveMenu).toHaveBeenCalledOnce();
    expect(calls()).toBe(2);
  });

  it('shows the tag list with check marks in the popover "Add tag"; a click sets or removes, it stays open', async () => {
    const { view, onTagPick, onMovePick } = setup({ rd: values({ menu: 'tag', tagPending: new Set(['n']) }) });
    const tag = view.getByRole('button', { name: 'Add tag' });
    expect(tag).toHaveAttribute('aria-expanded', 'true');
    expect(tag.getAttribute('style')).toContain('--m-bg: var(--accsoft)');
    expect(view.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-expanded', 'false');
    const menu = view.getByRole('menu', { name: 'Add tag' });
    // Surface of the popover with the title, below it the menu with only the entries
    const pop = menu.parentElement!;
    expect(pop).toHaveClass('pop');
    expect(pop.parentElement).toBe(tag.parentElement);
    expect(menu.previousElementSibling).toHaveTextContent('Tags');
    expect(menu.previousElementSibling).toHaveClass('pop-t');
    expect(menu.querySelector('.pop-t')).toBeNull();
    expect(view.getAllByRole('menu')).toHaveLength(1);

    const opts = within(menu).getAllByRole('menuitemcheckbox');
    expect(opts.map((o) => [o.textContent, o.getAttribute('aria-checked'), o.style.paddingLeft])).toEqual([
      ['Important', 'true', '12px'],
      ['Projects', 'false', '12px'],
      ['New', 'true', '28px'],
    ]);
    const [important, projects] = opts;
    expect(important!.querySelector('.tag-i')).toHaveStyle({ color: MA_COLORS[3][1] });
    expect(important!.querySelector('.tag-i .tabler-icon-tag')).not.toBeNull();
    expect(important!.querySelector('.tag-ck')!.getAttribute('style')).toContain('background: var(--ink)');
    expect(important!.querySelector('.tag-ck-i')).toHaveStyle({ opacity: '1' });
    expect(important!.querySelector('.tabler-icon-check')).not.toBeNull();
    expect(projects!.querySelector('.tag-ck')!.getAttribute('style')).toContain(
      'box-shadow: inset 0 0 0 2px var(--bdhi)',
    );
    expect(projects!.querySelector('.tag-ck-i')).toHaveStyle({ opacity: '0' });

    await fireEvent.click(projects!);
    await fireEvent.click(important!);
    expect(onTagPick.mock.calls).toEqual([['p'], ['w']]);
    expect(onMovePick).not.toHaveBeenCalled();
    expect(view.getByRole('menu', { name: 'Add tag' })).toBeInTheDocument();
  });

  it('shows Inbox and folders in the popover "Move to"; where the conversation is, disabled', async () => {
    const { view, onMovePick, onTagPick } = setup({ rd: values({ menu: 'move' }) });
    const move = view.getByRole('button', { name: 'Move' });
    expect(move).toHaveAttribute('aria-expanded', 'true');
    expect(move.getAttribute('style')).toContain('--m-c: var(--deep)');
    const menu = view.getByRole('menu', { name: 'Move to' });
    expect(menu.parentElement).toHaveClass('pop');
    expect(menu.parentElement!.parentElement).toBe(move.parentElement);
    expect(menu.previousElementSibling).toHaveTextContent('Move to');
    expect(menu.previousElementSibling).toHaveClass('pop-t');
    expect(menu.querySelector('.pop-t')).toBeNull();
    expect(view.queryByRole('menu', { name: 'Add tag' })).toBeNull();

    const opts = within(menu).getAllByRole('menuitem');
    expect(opts.map((o) => [o.textContent, o.getAttribute('aria-disabled'), o.style.paddingLeft])).toEqual([
      ['Inbox', 'true', '12px'],
      ['Archive', 'false', '12px'],
      ['2025', 'false', '28px'],
      ['Projects', 'false', '12px'],
    ]);
    const [inbox, archive] = opts;
    expect(inbox!.querySelector('.tabler-icon-inbox')).not.toBeNull();
    expect(inbox!.style.cursor).toBe('default');
    expect(inbox!.getAttribute('style')).toContain('color: var(--mfg)');
    expect(inbox!.querySelector('.mv-ck')).toHaveStyle({ opacity: '1' });
    expect(archive!.querySelector('.tabler-icon-folder')).not.toBeNull();
    expect(archive!.style.cursor).toBe('pointer');
    expect(archive!.getAttribute('style')).toContain('color: var(--fg)');
    expect(archive!.querySelector('.mv-ck')).toHaveStyle({ opacity: '0' });
    // Divider only before the first top-level folder
    const seps = menu.querySelectorAll('[role="separator"]');
    expect(seps).toHaveLength(1);
    expect(seps[0]!.nextElementSibling).toBe(archive);

    // The component reports the disabled target too; the route skips it.
    await fireEvent.click(inbox!);
    await fireEvent.click(archive!);
    expect(onMovePick.mock.calls).toEqual([
      [expect.objectContaining({ id: 'in', dis: 'true' })],
      [expect.objectContaining({ id: 'a', label: 'Archive', dis: 'false' })],
    ]);
    expect(onTagPick).not.toHaveBeenCalled();
  });

  it('moves focus into the popover on open, moves with arrow keys and returns it on close', async () => {
    const { view } = setup();
    const tag = view.getByRole('button', { name: 'Add tag' });
    tag.focus();
    await view.rerender({ rd: values({ menu: 'tag' }) });
    const menu = view.getByRole('menu', { name: 'Add tag' });
    const focused = () => document.activeElement?.textContent;
    expect(focused()).toBe('Important');
    const keys = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    const seen: (string | undefined)[] = [];
    for (const key of keys) {
      await fireEvent.keyDown(document.activeElement!, { key });
      seen.push(focused());
    }
    expect(seen).toEqual(['Projects', 'New', 'Important', 'New', 'Important', 'New']);
    // Other keys stay untouched (Enter, Escape are handled by the button or layout).
    expect(await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })).toBe(true);
    expect(menu).toContainElement(document.activeElement as HTMLElement);

    // Close (Escape, click outside via the layout): focus goes back to the button.
    await view.rerender({ rd: values() });
    expect(view.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tag));
  });

  it('focuses the first non-disabled target in the popover "Move to"', async () => {
    const { view } = setup();
    const move = view.getByRole('button', { name: 'Move' });
    await view.rerender({ rd: values({ menu: 'move' }) });
    expect(document.activeElement).toHaveTextContent('Archive');
    // ↑ from the first target leads to the last; disabled targets are reachable.
    await fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveTextContent('Projects');
    await fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toHaveTextContent('Inbox');
    await view.rerender({ rd: values() });
    await waitFor(() => expect(document.activeElement).toBe(move));
  });

  it('leaves focus where it is if it is no longer in the popover on close', async () => {
    const { view } = setup({ rd: values({ menu: 'tag' }) });
    expect(document.activeElement).toHaveTextContent('Important');
    const star = view.getByRole('button', { name: 'Flag' });
    star.focus();
    await view.rerender({ rd: values() });
    expect(document.activeElement).toBe(star);
    // If something else takes focus only after closing (command palette after a letter), it stays there.
    await view.rerender({ rd: values({ menu: 'tag' }) });
    const input = document.body.appendChild(document.createElement('input'));
    await view.rerender({ rd: values() });
    input.focus();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('shows no position and dims previous/next without room in the list', () => {
    const { view } = setup({ rd: values({ nav: null }) });
    expect(view.container.querySelector('.pos')).toBeNull();
    expect(view.getByRole('button', { name: 'Previous message' })).toHaveStyle({
      opacity: '0.35',
      cursor: 'default',
    });
    expect(view.getByRole('button', { name: 'Next message' })).toHaveStyle({ opacity: '0.35', cursor: 'default' });
  });

  it('shows subject, number of messages and tags', () => {
    const { view } = setup();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Approve start page by Friday?');
    const chips = view.container.querySelector('.chips')!;
    expect(within(chips as HTMLElement).getByText('3 messages')).toHaveClass('chip');
    const tag = within(chips as HTMLElement).getByText('Important');
    expect(tag).toHaveClass('tag');
    expect(tag.querySelector('.chip-i')).toHaveStyle({ color: MA_COLORS[3][1] });
    expect(chips.querySelector('.accent')).toBeNull();
    expect(chips.querySelector('.acct')).toBeNull();
  });

  it('shows the account with its color in "All accounts"', () => {
    const { view } = setup({ rd: values({ multi: true }) });
    const acct = view.getByText(ME);
    expect(acct).toHaveClass('acct');
    expect(acct.querySelector('.acct-dot')).toHaveStyle({ backgroundColor: MA_COLORS[2][1] });
  });

  it('collapses older emails and expands the last one', async () => {
    vi.useFakeTimers();
    const rd = values();
    const { view, onToggle } = setup({ rd });
    const closed = view.getAllByRole('button', { expanded: false }).filter((b) => b.classList.contains('closed'));
    expect(closed).toHaveLength(2);
    const [c1, c2] = closed;
    expect(within(c1!).getByText('Anna Baker')).toHaveClass('c-who');
    expect(within(c1!).getByText('the drafts are now in the project folder.')).toHaveClass('c-snip');
    expect(c1!.querySelector('.av-c')).toHaveTextContent('AB');
    expect(c1!.querySelector('.tabler-icon-paperclip')).toBeNull();
    expect(await tipOf(within(c1!).getByText(rd.msgs[0]!.time))).toBe(rd.msgs[0]!.timeFull);
    // Own email: own name and avatar in the accent color
    expect(within(c2!).getByText('Jane Doe')).toBeInTheDocument();
    expect(c2!.querySelector('.av-c')!.getAttribute('style')).toContain('background: var(--acc)');

    await fireEvent.click(c1!);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('e1');

    // The last email is open and cannot be collapsed.
    const open = view.container.querySelectorAll('section.open');
    expect(open).toHaveLength(1);
    const head = open[0]!.querySelector('.o-head')!;
    expect(head).not.toHaveAttribute('role');
    expect(head).toHaveStyle({ cursor: 'default' });
    expect(open[0]).toHaveStyle({ padding: '22px 0px 0px', boxShadow: 'none' });
  });

  it('shows an expanded email with sender, recipients, Cc, time and text', async () => {
    vi.useFakeTimers();
    const rd = values();
    const { view } = setup({ rd });
    const open = within(view.container.querySelector<HTMLElement>('section.open')!);
    expect(open.getByText('Anna Baker')).toHaveClass('o-name');
    expect(open.getByText('anna.baker@example.com')).toHaveClass('o-mail');
    expect(open.getByText('AB')).toHaveClass('av-o');
    const to = open.getByText('To: me');
    expect(await tipOf(to)).toBe(ME);
    expect(open.getByText('Cc: Ben Carter')).toBeInTheDocument();
    expect(await tipOf(open.getByText(rd.msgs[2]!.time))).toBe(rd.msgs[2]!.timeFull);
    const paras = [...view.container.querySelectorAll('section.open .text p')].map((p) => p.textContent);
    expect(paras).toEqual(['Hi Jane,', 'attached is the draft.', 'Best regards\nAnna']);
  });

  it('keeps focus on the same email when expanding and collapsing via keyboard', async () => {
    await expectFocusKept(false);
  });

  it('collapses an older expanded email again via click, Enter and Space', async () => {
    const { view, onToggle } = setup({ rd: values({ folds: { e1: true } }) });
    const open = view.container.querySelectorAll('section.open');
    expect(open).toHaveLength(2);
    expect(open[0]).toHaveInlineStyle({ padding: '20px 22px 22px', boxShadow: 'inset 0 0 0 1.5px var(--bd)' });
    const head = view.getByRole('button', { expanded: true });
    expect(head).toHaveAttribute('tabindex', '0');
    expect(head).toHaveStyle({ cursor: 'pointer' });
    await fireEvent.click(head);
    await fireEvent.keyDown(head, { key: 'Enter' });
    await fireEvent.keyDown(head, { key: ' ' });
    await fireEvent.keyDown(head, { key: 'a' });
    expect(onToggle.mock.calls).toEqual([['e1'], ['e1'], ['e1']]);
    // No Cc row without Cc
    expect(within(open[0] as HTMLElement).queryByText(/^Cc:/)).toBeNull();
  });

  it('downloads attachments on click', async () => {
    vi.useFakeTimers();
    const rd = values();
    const { view, onDownload } = setup({ rd });
    expect(view.getByText('1 attachment')).toHaveClass('att-n');
    const att = view.getByRole('button', { name: /Start_page_draft_v1\.pdf/ });
    expect(within(att).getByText('PDF · 121 KB')).toBeInTheDocument();
    expect(att.querySelector('.att-i .tabler-icon-file-type-pdf')).not.toBeNull();
    expect(att.querySelector('.att-dl .tabler-icon-download')).not.toBeNull();
    expect(await tipOf(att)).toBe('Download');
    await fireEvent.click(att);
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: PDF.name, part: PDF }));
  });

  it('opens the reply bar with reply, reply all and forward', async () => {
    vi.useFakeTimers();
    const { view, calls, replyActions } = setup();
    expect(view.queryByRole('radiogroup')).toBeNull();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    const reply = view.getByRole('button', { name: 'Reply' });
    expect(reply).toHaveClass('primary');
    expect(await tipOf(reply)).toBe('Reply (R)');
    const fwd = view.getByRole('button', { name: 'Forward' });
    expect(await tipOf(fwd)).toBe('Forward (F)');
    await fireEvent.click(reply);
    await fireEvent.click(view.getByRole('button', { name: 'Reply all' }));
    await fireEvent.click(fwd);
    expect(replyActions.open.mock.calls).toEqual([['reply'], ['all'], ['fwd']]);
    expect(calls()).toBe(0);
  });

  it('animates in only when it appears with `enter`, on desktop and mobile', async () => {
    for (const isMobile of [false, true]) {
      const sel = isMobile ? '.m-rd' : '.rd';
      const first = setup({ isMobile, rd: values({ isMobile }), enter: true });
      const root = first.view.container.querySelector(sel)!;
      expect(root).toHaveClass('enter');
      // The route clears `enter` once the view is shown; the running animation is not cut off.
      await first.view.rerender({ enter: false });
      expect(root).toHaveClass('enter');
      first.view.unmount();
      // Mounted again while paging (the next conversation had to load): no animation.
      const again = setup({ isMobile, rd: values({ isMobile }), enter: false });
      expect(again.view.container.querySelector(sel)).not.toHaveClass('enter');
      again.view.unmount();
    }
  });

  it('swaps another conversation in place: toolbar and focus stay, the message starts at the top', async () => {
    for (const isMobile of [false, true]) {
      const { view } = setup({ isMobile, rd: values({ isMobile }), conversationKey: 'a', enter: true });
      const root = view.container.querySelector(isMobile ? '.m-rd' : '.rd')!;
      const scroller = view.container.querySelector<HTMLElement>(isMobile ? '.m-card' : '.scroll')!;
      let top = 240;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => (top = v),
      });
      const next = view.getByRole('button', { name: 'Next message' });
      next.focus();
      // New values of the same conversation keep the position.
      await view.rerender({ rd: values({ isMobile, folds: { e1: true } }) });
      expect(top).toBe(240);
      await view.rerender({ conversationKey: 'b', enter: false, rd: values({ isMobile, emails: [THREAD[0]!] }) });
      expect(top).toBe(0);
      expect(view.container.querySelector(isMobile ? '.m-rd' : '.rd')).toBe(root);
      expect(root).toHaveClass('enter');
      expect(document.activeElement).toBe(next);
      view.unmount();
    }
  });

  describe('open reply bar', () => {
    it('focuses the text with each "Reply" and "Reply all", also when already open; not for forward', async () => {
      const rd = values();
      const { view } = setup({ rd, rp: reply(rd, { mode: 'fwd' }), replyFocus: 4 });
      // Forward: the address field has focus, not the text.
      expect(document.activeElement).toBe(view.getByPlaceholderText('To: email address'));
      await view.rerender({ rp: reply(rd, { mode: 'reply' }), replyFocus: 5 });
      const text = view.getByPlaceholderText('Reply to Anna …');
      expect(document.activeElement).toBe(text);
      text.blur();
      await view.rerender({ rp: reply(rd, { mode: 'reply', text: 'Hi' }) });
      expect(document.activeElement).toBe(document.body);
      await view.rerender({ rp: reply(rd, { mode: 'reply', text: 'Hi' }), replyFocus: 6 });
      expect(document.activeElement).toBe(text);
      text.blur();
      await view.rerender({ rp: reply(rd, { mode: 'all', text: 'Hi' }), replyFocus: 7 });
      expect(document.activeElement).toBe(text);
    });

    it('shows toggle, recipients, text, send disabled and the hint', async () => {
      vi.useFakeTimers();
      const rd = values();
      const { view, calls, replyCalls } = setup({ rd, rp: reply(rd, {}) });
      expect(view.queryByRole('button', { name: 'Reply' })).toBeNull();
      const box = view.container.querySelector<HTMLElement>('.reply .rp')!;
      const group = within(box).getByRole('radiogroup', { name: 'Reply type' });
      const radios = within(group).getAllByRole('radio');
      expect(radios.map((r) => r.textContent)).toEqual(['Reply', 'Reply all', 'Forward']);
      expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      expect(radios.map((r) => r.querySelector('svg')?.getAttribute('class'))).toEqual([
        expect.stringContaining('tabler-icon-arrow-back-up'),
        expect.stringContaining('tabler-icon-arrow-back-up-double'),
        expect.stringContaining('tabler-icon-arrow-forward-up'),
      ]);
      expect(radios[0]!.style.getPropertyValue('--rp-bg')).toBe('var(--surface)');
      expect(radios[1]!.style.getPropertyValue('--rp-c')).toBe('var(--mfg)');
      expect(within(box).getByText('To: Anna Baker')).toHaveClass('rp-label');
      expect(within(box).queryByPlaceholderText('To: email address')).toBeNull();
      const text = within(box).getByPlaceholderText('Reply to Anna …');
      expect(text.tagName).toBe('TEXTAREA');
      expect(text).toHaveAttribute('rows', '6');
      expect(text).toHaveValue('');
      expect(document.activeElement).toBe(text);
      const send = within(box).getByRole('button', { name: 'Send' });
      expect(send).toHaveAttribute('aria-disabled', 'true');
      expect(send).toHaveStyle({ cursor: 'default' });
      expect(send.style.background).toBe('var(--sunken)');
      expect(send.querySelector('svg')).toHaveClass('tabler-icon-send');
      expect(within(box).getByText('Ctrl + Enter to send')).toHaveClass('rp-hint');
      const attach = within(box).getByRole('button', { name: 'Add attachment' });
      expect(attach.querySelector('svg')).toHaveClass('tabler-icon-paperclip');
      expect(await tipOf(attach)).toBe('Add attachment');
      const expand = within(box).getByRole('button', { name: 'Open in editor' });
      expect(expand.querySelector('svg')).toHaveClass('tabler-icon-arrows-diagonal');
      expect(await tipOf(expand)).toBe('Open in editor (Cc, Bcc, attachments)');
      expect(replyCalls() + calls()).toBe(0);
    });

    it('switches the kind, takes text and calls send, discard and open in editor', async () => {
      const rd = values();
      const { view, replyActions } = setup({ rd, rp: reply(rd, { mode: 'all', text: 'Thanks!' }) });
      const radios = view.getAllByRole('radio');
      expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
      expect(view.getByText('To: Anna Baker, Ben Carter')).toHaveClass('rp-label');
      await fireEvent.click(radios[0]!);
      await fireEvent.click(radios[2]!);
      expect(replyActions.mode.mock.calls).toEqual([['reply'], ['fwd']]);

      const text = view.getByPlaceholderText('Reply to Anna …');
      expect(text).toHaveValue('Thanks!');
      await fireEvent.input(text, { target: { value: 'Thanks, looks good.' } });
      expect(replyActions.text).toHaveBeenCalledExactlyOnceWith('Thanks, looks good.');

      const send = view.getByRole('button', { name: 'Send' });
      expect(send).toHaveAttribute('aria-disabled', 'false');
      expect(send).toHaveStyle({ cursor: 'pointer' });
      expect(send.style.background).toBe('var(--ink)');
      await fireEvent.click(send);
      expect(replyActions.send).toHaveBeenCalledExactlyOnceWith();
      await fireEvent.click(view.getByRole('button', { name: 'Discard' }));
      expect(replyActions.cancel).toHaveBeenCalledExactlyOnceWith();
      await fireEvent.click(view.getByRole('button', { name: 'Open in editor' }));
      expect(replyActions.expand).toHaveBeenCalledExactlyOnceWith();
      expect(replyActions.open).not.toHaveBeenCalled();
    });

    it('sends with Ctrl + Enter and ⌘ + Enter, not with Enter alone', async () => {
      const rd = values();
      const { view, replyActions } = setup({ rd, rp: reply(rd, { text: 'Thanks!' }) });
      const text = view.getByPlaceholderText('Reply to Anna …');
      expect(await fireEvent.keyDown(text, { key: 'Enter' })).toBe(true);
      expect(await fireEvent.keyDown(text, { key: 'a', ctrlKey: true })).toBe(true);
      expect(replyActions.send).not.toHaveBeenCalled();
      expect(await fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true })).toBe(false);
      expect(await fireEvent.keyDown(text, { key: 'Enter', metaKey: true })).toBe(false);
      expect(replyActions.send).toHaveBeenCalledTimes(2);
    });

    it('disables send without a connection with a tooltip; click and Ctrl + Enter go to the route', async () => {
      vi.useFakeTimers();
      const rd = values();
      const { view, replyActions } = setup({ rd, rp: reply(rd, { text: 'Thanks!' }, true) });
      const send = view.getByRole('button', { name: 'Send' });
      expect(send).toHaveAttribute('aria-disabled', 'true');
      expect(send).toHaveStyle({ cursor: 'default', opacity: '0.5' });
      expect(send.style.background).toBe('var(--ink)');
      expect(await tipOf(send)).toBe(OFF_REPLY);
      await fireEvent.click(send);
      const text = view.getByPlaceholderText('Reply to Anna …');
      expect(await fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true })).toBe(false);
      expect(replyActions.send).toHaveBeenCalledTimes(2);
      expect(text).toHaveValue('Thanks!');
    });

    it('keeps send muted instead of half transparent without a connection and without text', async () => {
      vi.useFakeTimers();
      const rd = values();
      const { view } = setup({ rd, rp: reply(rd, {}, true) });
      const send = view.getByRole('button', { name: 'Send' });
      expect(send).toHaveAttribute('aria-disabled', 'true');
      expect(send.style.opacity).toBe('1');
      expect(send.style.background).toBe('var(--sunken)');
      expect(await tipOf(send)).toBe(OFF_REPLY);
    });

    it('shows the address field with focus instead of the recipients when forwarding', async () => {
      const rd = values();
      const { view, replyActions } = setup({ rd, rp: reply(rd, { mode: 'fwd', to: 'ben@example.com' }) });
      expect(view.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
      expect(view.queryByText(/^To: Anna/)).toBeNull();
      const to = view.getByPlaceholderText('To: email address');
      expect(to).toHaveAttribute('type', 'email');
      expect(to).toHaveClass('rp-in');
      expect(to).toHaveValue('ben@example.com');
      expect(document.activeElement).toBe(to);
      expect(view.getByPlaceholderText('Add a message (optional)').tagName).toBe('TEXTAREA');
      expect(view.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'false');
      await fireEvent.input(to, { target: { value: 'jonas@example.com' } });
      expect(replyActions.to).toHaveBeenCalledExactlyOnceWith('jonas@example.com');
    });

    it('opens the file picker with "Add attachment" and passes on chosen files', async () => {
      const rd = values();
      const { view, replyActions } = setup({ rd, rp: reply(rd, {}) });
      const input = fileInput(view.container);
      expect(input).toHaveClass('file-in');
      expect(input).toHaveAttribute('multiple');
      expect(input).toHaveAttribute('tabindex', '-1');
      expect(input).toHaveAttribute('aria-hidden', 'true');
      const pick = vi.spyOn(input, 'click');
      await fireEvent.click(view.getByRole('button', { name: 'Add attachment' }));
      expect(pick).toHaveBeenCalledOnce();
      expect(replyActions.files).not.toHaveBeenCalled();

      // Empty afterwards, so that the same file can be chosen again; nothing without files.
      const setValue = vi.fn();
      Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: setValue });
      const files = [new File(['%PDF'], 'Angebot.pdf', { type: 'application/pdf' })];
      await fireEvent.change(input, { target: { files } });
      expect(replyActions.files).toHaveBeenCalledExactlyOnceWith(files);
      await fireEvent.change(input, { target: { files: [] } });
      expect(replyActions.files).toHaveBeenCalledOnce();
      expect(setValue.mock.calls).toEqual([[''], ['']]);
    });
  });

  it('shows no "Reply all" without further recipients', () => {
    const { view } = setup({ rd: values({ emails: [email('x1')] }) });
    expect(view.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Reply all' })).toBeNull();
    // A single email: open, without a count chip
    expect(view.container.querySelectorAll('section.open')).toHaveLength(1);
    expect(view.queryByText(/messages$/)).toBeNull();
  });

  it('shows drafts with a chip, without reply and move', () => {
    const rd = values({
      kind: { role: 'drafts' },
      title: 'Drafts',
      emails: [email('d1', { mailboxIds: ['drafts'] })],
    });
    const { view } = setup({ rd });
    const chip = view.container.querySelector('.chip.accent')!;
    expect(chip).toHaveTextContent(rd.chipText);
    expect(rd.chipText).toMatch(/^Last edited: /);
    expect(chip.querySelector('.tabler-icon-pencil')).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(view.getByRole('button', { name: 'Add tag' })).toBeInTheDocument();
  });

  it('shows scheduled messages with a clock in the chip', () => {
    const rd = values({
      kind: { role: 'scheduled' },
      title: 'Scheduled',
      emails: [email('s1', { mailboxIds: ['sched'] })],
    });
    const { view } = setup({ rd });
    const chip = view.container.querySelector('.chip.accent')!;
    expect(chip).toHaveTextContent(/^Scheduled: /);
    expect(chip.querySelector('.tabler-icon-clock')).not.toBeNull();
  });

  it('shows restore and delete permanently without tag, spam and reply in the trash', async () => {
    const rd = values({
      kind: { role: 'trash' },
      title: 'Trash',
      emails: [email('t1', { mailboxIds: ['trash'] })],
    });
    const { view, onRestore, onDel } = setup({ rd });
    const bar = within(view.getByRole('toolbar'));
    expect(bar.getByRole('button', { name: 'Trash' })).toBeInTheDocument();
    expect(bar.queryByRole('button', { name: 'Mark as unread' })).toBeNull();
    expect(bar.queryByRole('button', { name: 'Add tag' })).toBeNull();
    expect(bar.queryByRole('button', { name: 'Report spam' })).toBeNull();
    await fireEvent.click(bar.getByRole('button', { name: 'Restore' }));
    const del = bar.getByRole('button', { name: 'Delete permanently' });
    expect(del.querySelector('.tabler-icon-trash-x')).not.toBeNull();
    await fireEvent.click(del);
    expect(view.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect([onRestore, onDel].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it('offers "Send now" and "Cancel send" instead of "Mark as unread" in Scheduled', async () => {
    const rd = values({
      kind: { role: 'scheduled' },
      title: 'Scheduled',
      emails: [email('g1', { mailboxIds: ['sched'] })],
    });
    const { view, onSendNow, onCancel, onDel, onUnread } = setup({ rd });
    const bar = within(view.getByRole('toolbar'));
    expect(bar.getByRole('button', { name: 'Flag' })).toBeInTheDocument();
    for (const name of ['Mark as unread', 'Move', 'Report spam'])
      expect(bar.queryByRole('button', { name })).toBeNull();
    const now = bar.getByRole('button', { name: 'Send now' });
    const cancel = bar.getByRole('button', { name: 'Cancel send' });
    expect(now.querySelector('.tabler-icon-send')).not.toBeNull();
    expect(cancel.querySelector('.tabler-icon-clock-x')).not.toBeNull();
    // In place of "Mark as unread": directly before delete (without spam and restore).
    expect(now.nextElementSibling).toBe(cancel);
    expect(cancel.nextElementSibling).toBe(bar.getByRole('button', { name: 'Delete' }));
    await fireEvent.click(now);
    await fireEvent.click(cancel);
    await fireEvent.click(bar.getByRole('button', { name: 'Delete' }));
    expect([onSendNow, onCancel, onDel, onUnread].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 0]);
  });

  it('shows "Cancel send" as a pill and delete in the bottom bar in Scheduled on mobile', async () => {
    const rd = values({
      kind: { role: 'scheduled' },
      title: 'Scheduled',
      emails: [email('g1', { mailboxIds: ['sched'] })],
      isMobile: true,
    });
    const { view, onCancel, onDel } = setup({ rd, isMobile: true });
    const bottom = view.container.querySelector<HTMLElement>('.m-reply')!;
    const pill = bottom.querySelector<HTMLButtonElement>('.m-r-pill')!;
    expect(pill.textContent).toBe('Cancel send');
    expect(pill.querySelector('.tabler-icon-clock-x')).not.toBeNull();
    expect(bottom.querySelector('.grow')).toBeNull();
    const buttons = within(bottom).getAllByRole('button');
    expect(buttons.map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Cancel send', 'Delete']);
    expect(within(bottom).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(within(bottom).queryByRole('button', { name: 'Mark as unread' })).toBeNull();
    await fireEvent.click(pill);
    await fireEvent.click(within(bottom).getByRole('button', { name: 'Delete' }));
    expect([onCancel, onDel].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    // The round button (`schedIcon`, with reply bar) does not exist in the app: a scheduled
    // email has no reply bar even in a tag view.
    await view.rerender({ rd: { ...rd, schedPill: false, schedIcon: true } });
    expect(bottom.querySelector('.m-r-pill')).toBeNull();
    const icon = within(bottom).getByRole('button', { name: 'Cancel send' });
    expect(icon).toHaveClass('m-r-ib');
    await fireEvent.click(icon);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('offers "No spam" in spam', () => {
    const rd = values({ kind: { role: 'spam' }, title: 'Spam', emails: [email('p1', { mailboxIds: ['spam'] })] });
    const { view } = setup({ rd });
    const spam = view.getByRole('button', { name: 'Not spam' });
    expect(spam.querySelector('.tabler-icon-shield-check')).not.toBeNull();
  });

  it('colors the message area with its theme', async () => {
    const { view } = setup();
    const scroll = view.container.querySelector<HTMLElement>('.scroll')!;
    expect(scroll).toHaveClass('no-scrollbar');
    expect(scroll.style.getPropertyValue('--surface')).toBe(MODES.light['--surface']);
    expect(scroll.style.getPropertyValue('--fg')).toBe(MODES.light['--fg']);
    expect(scroll.style.getPropertyValue('--bd')).toBe(MODES.light['--bd']);
    expect(scroll.getAttribute('style')).toContain('color-scheme: light');
    expect(scroll).toHaveStyle({ margin: '0px', borderRadius: '0' });
    // The toolbar keeps the app's colors.
    expect(view.getByRole('toolbar').closest<HTMLElement>('.bar-wrap')!.getAttribute('style')).toBeNull();

    await view.rerender({ rd: values({ inverted: true }) });
    expect(scroll.style.getPropertyValue('--surface')).toBe(MODES.dark['--surface']);
    expect(scroll.style.getPropertyValue('--deep')).toBe(values({ inverted: true }).tv.deep);
    expect(scroll.getAttribute('style')).toContain('color-scheme: dark');
    expect(scroll).toHaveStyle({ margin: '0px 10px 10px', borderRadius: '24px' });
    const theme = view.getByRole('button', { name: 'Email in light mode' });
    expect(theme).toHaveAttribute('aria-pressed', 'true');
    expect(theme.style.getPropertyValue('--m-bg')).toBe('var(--accsoft)');
    expect(theme.style.getPropertyValue('--m-c')).toBe('var(--deep)');
    expect(theme.querySelector('.tabler-icon-sun')).not.toBeNull();
  });

  it('shows flagged conversations with a filled star', () => {
    const rd = values({ emails: [email('f1', { keywords: { $flagged: true } })] });
    const { view } = setup({ rd });
    const star = view.getByRole('button', { name: 'Remove flag' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(star).toHaveStyle({ color: '#e3a93a' });
    expect(star.querySelector('.tabler-icon-star-filled')).not.toBeNull();
  });

  describe('HTML', () => {
    const htmlMail = (value: string) =>
      email('h1', {
        htmlBody: [
          {
            partId: '2',
            blobId: 'b2',
            size: 1,
            name: null,
            type: 'text/html',
            charset: null,
            disposition: null,
            cid: null,
          },
        ],
        bodyValues: { '2': { value, isEncodingProblem: false, isTruncated: false } },
      });
    const IMG = '<p>Hello</p><img src="https://cdn.example.com/a.png" width="600" height="200">';

    it('shows HTML in the sandbox iframe without scripts, instead of the paragraphs', () => {
      const { view } = setup({ rd: values({ emails: [htmlMail('<p>Hello</p>')] }) });
      const frame = view.container.querySelector('iframe')!;
      expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      expect(frame).toHaveAttribute('title', 'Approve start page by Friday?');
      expect(frame.getAttribute('src')).toMatch(/^blob:/);
      expect(frame.style.colorScheme).toBe('light');
      expect(view.container.querySelector('.text')).toBeNull();
      expect(view.queryByRole('status')).toBeNull();
    });

    it('reloads the iframe only for a different document, not for every new `rd`', async () => {
      const emails = [htmlMail('<p>Hello</p>')];
      const { view } = setup({ rd: values({ emails }) });
      const frame = view.container.querySelector('iframe')!;
      const first = frame.getAttribute('src');
      // New values with the same document (minute tick of the reading view).
      await view.rerender({
        rd: values({
          emails,
          time: { now: NOW + 60_000, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' },
        }),
      });
      expect(frame.getAttribute('src')).toBe(first);
      await view.rerender({ rd: values({ emails, dark: true }) });
      expect(frame.getAttribute('src')).not.toBe(first);
    });

    it('shows no document without a loaded renderer, the iframe once it is there', async () => {
      const emails = [htmlMail('<p>Hello</p>')];
      const { view } = setup({ rd: values({ emails, render: null }) });
      expect(view.container.querySelector('iframe')).toBeNull();
      expect(view.container.querySelector('.text')).toBeNull();
      await view.rerender({ rd: values({ emails }) });
      expect(view.container.querySelector('iframe')?.getAttribute('src')).toMatch(/^blob:/);
    });

    it('shows the banner with "Load once" and "Always load from this sender"', async () => {
      const { view, onExtOnce, onExtAlways } = setup({ rd: values({ emails: [htmlMail(IMG)] }) });
      const bar = view.getByRole('status');
      expect(bar).toHaveTextContent(
        'External content blocked. 1 image and tracking pixels from external servers weren’t loaded.',
      );
      expect(bar.querySelector('.tabler-icon-photo-off')).not.toBeNull();
      await fireEvent.click(within(bar).getByRole('button', { name: 'Load once' }));
      expect(onExtOnce).toHaveBeenCalledWith('h1');
      await fireEvent.click(within(bar).getByRole('button', { name: 'Always load from this sender' }));
      expect(onExtAlways).toHaveBeenCalledWith('anna.baker@example.com');
    });

    it('offers only "Load once" with "Never load"', () => {
      const rd = values({ emails: [htmlMail(IMG)], ext: { extMode: 'never', extAllow: [] } });
      const bar = setup({ rd }).view.getByRole('status');
      expect(bar).toHaveTextContent('External content turned off.');
      expect(within(bar).queryByRole('button', { name: 'Always load from this sender' })).toBeNull();
    });
  });

  describe('offline', () => {
    const missing = email('e1', { textBody: [], bodyValues: {}, miss: true, attachments: [PDF] });
    const TITLE = 'This message isn’t saved for offline use';

    it('shows the card before the attachments without text, "Try again" calls the route', async () => {
      const { view, calls, onMissRetry } = setup({ rd: values({ emails: [missing] }) });
      const card = view.getByRole('status');
      expect(card).toHaveClass('miss');
      expect(card).toHaveTextContent(`${TITLE} It will load as soon as you’re back online. Try again`);
      expect(card.querySelector('.miss-i .tabler-icon-cloud-off')).not.toBeNull();
      expect(view.container.querySelector('.text, .html')).toBeNull();
      const atts = view.container.querySelector('.atts')!;
      expect(card.compareDocumentPosition(atts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const retry = within(card).getByRole('button', { name: 'Try again' });
      expect(retry.querySelector('.tabler-icon-refresh')).not.toBeNull();
      await fireEvent.click(retry);
      expect(onMissRetry).toHaveBeenCalledOnce();
      expect(calls()).toBe(1);
    });

    it('names the account with "Sign-in required"', () => {
      const account = { email: ME, color: 2, state: 'needs_reauth' } as const;
      const { view } = setup({ rd: values({ emails: [missing], account }) });
      expect(view.getByText(`It will load as soon as you sign in to ${ME} again.`)).toHaveClass('miss-text');
    });

    it('shows the preview instead of the card when collapsed', () => {
      const first = email('e1', { textBody: [], bodyValues: {}, miss: true, preview: 'From the list' });
      const { view } = setup({ rd: values({ emails: [first, email('e2')], repId: 'e2' }) });
      expect(view.getByText('From the list')).toHaveClass('c-snip');
      expect(view.queryByRole('status')).toBeNull();
    });

    it('dims attachments, the click still goes to the route', async () => {
      vi.useFakeTimers();
      const { view, onDownload } = setup({ rd: values({ offline: true }) });
      const att = view.getByRole('button', { name: /Start_page_draft_v1\.pdf/ });
      expect(att).toHaveAttribute('aria-disabled', 'true');
      expect(att).toHaveStyle({ opacity: '0.5', cursor: 'default' });
      expect(att.querySelector('.att-i .tabler-icon-file-type-pdf')).not.toBeNull();
      expect(att.querySelector('.att-dl .tabler-icon-cloud-off')).not.toBeNull();
      expect(att.querySelector('.tabler-icon-download')).toBeNull();
      expect(await tipOf(att)).toBe('Not saved offline');
      await fireEvent.click(att);
      expect(onDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: PDF.name, part: PDF }));
    });

    it('leaves attachments unchanged with a connection', () => {
      const { view } = setup();
      const att = view.getByRole('button', { name: /Start_page_draft_v1\.pdf/ });
      expect(att).toHaveAttribute('aria-disabled', 'false');
      expect(att).toHaveStyle({ opacity: '1', cursor: 'pointer' });
    });

    it('shows the card and dimmed attachments on mobile', async () => {
      const { view, onMissRetry, onDownload } = setup({
        isMobile: true,
        rd: values({ emails: [missing], offline: true }),
      });
      const card = view.getByRole('status');
      expect(within(card).getByText(TITLE)).toHaveClass('miss-title');
      await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
      expect(onMissRetry).toHaveBeenCalledOnce();

      const att = view.getByRole('button', { name: /Start_page_draft_v1\.pdf/ });
      expect(att).toHaveClass('m-att');
      expect(att).toHaveAttribute('aria-disabled', 'true');
      expect(att).toHaveStyle({ opacity: '0.5' });
      expect(att.querySelector('.m-att-dl .tabler-icon-cloud-off')).not.toBeNull();
      await fireEvent.click(att);
      expect(onDownload).toHaveBeenCalledOnce();
    });
  });

  describe('truncated parts', () => {
    const part = (partId: string, type: string, size: number) => ({
      partId,
      blobId: `b${partId}`,
      size,
      name: null,
      type,
      charset: null,
      disposition: null,
      cid: null,
    });
    const cut = (value: string) => ({ value, isEncodingProblem: false, isTruncated: true });
    const longText = email('t1', {
      textBody: [part('1', 'text/plain', 2_411_724)],
      bodyValues: { '1': cut('Log of the last 24 hours:\n\n02:00:01 smartd') },
      attachments: [PDF],
    });
    const longHtml = email('t1', {
      htmlBody: [part('2', 'text/html', 4_718_592)],
      bodyValues: { '2': cut('<p>Hello</p><img src="https://cdn.example.com/a.png"><p>Typo') },
    });
    const TEXT = 'This message is very large (2.3 MB), so only part of it is shown.';

    it('shows the hint with "Load full message" below the text and before the attachments', async () => {
      const { view, onFull } = setup({ rd: values({ emails: [longText] }) });
      const note = view.getByRole('status');
      expect(note).toHaveTextContent(`${TEXT} Load full message`);
      expect(note.querySelector('.tabler-icon-cut')).not.toBeNull();
      expect(note.closest('.text')).not.toBeNull();
      const atts = view.container.querySelector('.atts')!;
      expect(note.compareDocumentPosition(atts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const button = within(note).getByRole('button', { name: 'Load full message' });
      expect(button).toHaveAttribute('aria-busy', 'false');
      await fireEvent.click(button);
      expect(onFull).toHaveBeenCalledWith('t1');
    });

    it('shows spinner and "Loading …" while loading', () => {
      const rd = values({ emails: [longText], loadingFull: new Set(['t1']) });
      const button = within(setup({ rd }).view.getByRole('status')).getByRole('button');
      expect(button).toHaveTextContent('Loading …');
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button.querySelector('.tabler-icon-loader-2')).not.toBeNull();
    });

    it('sits below the HTML, the banner of the external content above it', () => {
      const { view } = setup({ rd: values({ emails: [longHtml] }) });
      const [bar, note] = view.getAllByRole('status');
      expect(bar).toHaveTextContent('External content blocked.');
      expect(note).toHaveTextContent('This message is very large (4.5 MB), so only part of it is shown.');
      const frame = view.container.querySelector('iframe')!;
      expect(frame.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the hint for HTML until the iframe shows the whole document', async () => {
      vi.useFakeTimers();
      try {
        const { view } = setup({ rd: values({ emails: [longHtml], loadingFull: new Set(['t1']) }) });
        const full = email('t1', {
          htmlBody: longHtml.htmlBody,
          bodyValues: { '2': { value: '<p>Hello</p><p>Typography</p>', isEncodingProblem: false, isTruncated: false } },
        });
        await view.rerender({ rd: values({ emails: [full] }) });
        // Still the old iframe: hint while loading, otherwise the view would jump at the end of the page.
        expect(view.getByText('Loading …')).toBeInTheDocument();
        // jsdom measures no height: `onfit` comes after the timeout.
        await vi.advanceTimersByTimeAsync(3000);
        expect(view.queryByText('Loading …')).toBeNull();
        expect(view.container.querySelector('.trunc')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not hold when the document stays the same, and not beyond collapsing', async () => {
      const same = email('t1', {
        htmlBody: longHtml.htmlBody,
        bodyValues: { '2': { ...longHtml.bodyValues['2']!, isTruncated: false } },
      });
      const one = setup({ rd: values({ emails: [longHtml], loadingFull: new Set(['t1']) }) });
      await one.view.rerender({ rd: values({ emails: [same] }) });
      expect(one.view.container.querySelector('.trunc')).toBeNull();
      one.view.unmount();

      // Older email expanded, collapsed after loading and expanded again: no stale loading state.
      const older = { ...longHtml, receivedAt: NOW - 5 * HOUR };
      const later = email('t2');
      const full = email('t1', {
        receivedAt: NOW - 5 * HOUR,
        htmlBody: longHtml.htmlBody,
        bodyValues: { '2': { value: '<p>Ganz</p>', isEncodingProblem: false, isTruncated: false } },
      });
      const two = setup({ rd: values({ emails: [older, later], folds: { t1: true }, loadingFull: new Set(['t1']) }) });
      await two.view.rerender({ rd: values({ emails: [full, later], folds: { t1: true } }) });
      expect(two.view.getByText('Loading …')).toBeInTheDocument();
      await two.view.rerender({ rd: values({ emails: [full, later], folds: { t1: false } }) });
      await two.view.rerender({ rd: values({ emails: [full, later], folds: { t1: true } }) });
      expect(two.view.container.querySelector('.trunc')).toBeNull();
    });

    it('lets the hint disappear immediately for text', async () => {
      const { view } = setup({ rd: values({ emails: [longText], loadingFull: new Set(['t1']) }) });
      await view.rerender({ rd: values({ emails: [email('t1', { attachments: [PDF] })] }) });
      expect(view.container.querySelector('.trunc')).toBeNull();
    });

    it('takes the app colors, also with an inverted message theme', () => {
      const rd = values({ emails: [longText], inverted: true });
      const note = setup({ rd }).view.getByRole('status');
      expect(rd.tv.surface).not.toBe(rd.ui.surface);
      expect(note.style.getPropertyValue('--surface')).toBe(rd.ui.surface);
      expect(note.style.getPropertyValue('--fg')).toBe(rd.ui.fg);
    });

    it('shows the hint on mobile too', async () => {
      const { view, onFull } = setup({ rd: values({ emails: [longText], isMobile: true }), isMobile: true });
      const note = view.getByRole('status');
      expect(note).toHaveTextContent(TEXT);
      await fireEvent.click(within(note).getByRole('button', { name: 'Load full message' }));
      expect(onFull).toHaveBeenCalledWith('t1');
    });
  });

  describe('mobile', () => {
    it('brings its own head with back, previous/next, star and more', async () => {
      vi.useFakeTimers();
      const { view, calls, onClose, onPrev, onNext, onMore } = setup({ isMobile: true, rd: values({ nav: null }) });
      expect(view.queryByRole('toolbar')).toBeNull();
      // The name contains the visible folder (WCAG 2.5.3).
      const back = view.getByRole('button', { name: /^Back\s*Inbox$/ });
      expect(back).toHaveTextContent('Inbox');
      expect(back.querySelector('.tabler-icon-chevron-left')).not.toBeNull();
      const prev = view.getByRole('button', { name: 'Previous message' });
      expect(prev).toHaveStyle({ opacity: '0.35' });
      expect(prev.querySelector('.tabler-icon-chevron-up')).not.toBeNull();
      const next = view.getByRole('button', { name: 'Next message' });
      expect(next.querySelector('.tabler-icon-chevron-down')).not.toBeNull();
      const more = view.getByRole('button', { name: 'More actions' });
      expect(more).toHaveAttribute('aria-haspopup', 'menu');
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(await tipOf(back)).toBeUndefined();

      await fireEvent.click(view.getByRole('button', { name: 'Flag' }));
      expect(calls()).toBe(1);
      await fireEvent.click(back);
      await fireEvent.click(prev);
      await fireEvent.click(next);
      await fireEvent.click(more);
      expect([onClose, onPrev, onNext, onMore].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it('reports the open sheet "More actions" on the button', () => {
      const { view } = setup({ isMobile: true, moreOpen: true });
      expect(view.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'true');
    });

    it('shows the message as a card with theme, without account chip and tooltips', async () => {
      vi.useFakeTimers();
      const rd = values({ multi: true, dark: true });
      const { view, onToggle, onDownload } = setup({ isMobile: true, rd });
      const card = view.container.querySelector<HTMLElement>('main.m-card')!;
      expect(card).toHaveClass('no-scrollbar');
      expect(card.style.getPropertyValue('--surface')).toBe(MODES.dark['--surface']);
      expect(card.getAttribute('style')).toContain('color-scheme: dark');
      expect(within(card).getByRole('heading', { level: 1 })).toHaveTextContent('Approve start page by Friday?');
      expect(within(card).getByText('3 messages')).toBeInTheDocument();
      expect(within(card).getByText('Important')).toBeInTheDocument();
      expect(within(card).queryByText(ME)).toBeNull();

      const closed = [...card.querySelectorAll<HTMLElement>('button.m-closed')];
      expect(closed).toHaveLength(2);
      expect(within(closed[0]!).getByText('Anna Baker')).toHaveClass('m-c-name');
      expect(within(closed[0]!).getByText(rd.msgs[0]!.time)).toHaveClass('m-time');
      expect(within(closed[0]!).getByText('the drafts are now in the project folder.')).toHaveClass('m-snip');
      await fireEvent.click(closed[1]!);
      expect(onToggle).toHaveBeenCalledExactlyOnceWith('e2');

      const open = within(card.querySelector<HTMLElement>('section.m-open')!);
      expect(open.getByText('Anna Baker')).toHaveClass('m-o-name');
      expect(open.getByText('To: me')).toHaveClass('m-o-to');
      expect(open.queryByText('Cc: Ben Carter')).toBeNull();
      expect(open.queryByText('1 attachment')).toBeNull();
      expect(await tipOf(open.getByText('To: me'))).toBeUndefined();
      const att = open.getByRole('button', { name: /Start_page_draft_v1\.pdf/ });
      expect(within(att).getByText('PDF · 121 KB')).toBeInTheDocument();
      expect(await tipOf(att)).toBeUndefined();
      await fireEvent.click(att);
      expect(onDownload).toHaveBeenCalledExactlyOnceWith(rd.msgs[2]!.atts[0]);
    });

    it('keeps focus on the same email when expanding and collapsing via keyboard', async () => {
      await expectFocusKept(true);
    });

    it('collapses an expanded older email via keyboard', async () => {
      const { view, onToggle } = setup({ isMobile: true, rd: values({ folds: { e1: true } }) });
      const head = view.getByRole('button', { expanded: true });
      expect(head).toHaveClass('m-o-head');
      await fireEvent.keyDown(head, { key: 'Enter' });
      await fireEvent.click(head);
      expect(onToggle.mock.calls).toEqual([['e1'], ['e1']]);
    });

    it('shows the reply bar at the bottom with reply, reply all, forward, unread and delete', async () => {
      const { view, calls, onUnread, onDel, replyActions } = setup({ isMobile: true });
      const bar = view.container.querySelector<HTMLElement>('.m-reply')!;
      expect(bar).toHaveStyle({ padding: `10px 12px ${M_TAB_PAD_B}` });
      const names = within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent);
      expect(names).toEqual(['Reply', 'Reply all', 'Forward', 'Mark as unread', 'Delete']);
      for (const b of within(bar).getAllByRole('button')) await fireEvent.click(b);
      expect(replyActions.open.mock.calls).toEqual([['reply'], ['all'], ['fwd']]);
      expect(calls()).toBe(2);
      expect([onUnread, onDel].map((f) => f.mock.calls.length)).toEqual([1, 1]);
      expect(bar.querySelector('.grow')).toBeNull();
      expect(view.queryByRole('radiogroup')).toBeNull();
    });

    it('replaces the bottom bar with the reply bar when open', async () => {
      vi.useFakeTimers();
      const rd = values({ isMobile: true });
      const { view, calls, replyActions } = setup({ isMobile: true, rd, rp: reply(rd, { text: 'Thanks!' }) });
      expect(view.container.querySelector('.m-reply')).toBeNull();
      expect(view.queryByRole('button', { name: 'Delete' })).toBeNull();
      const wrap = view.container.querySelector<HTMLElement>('.m-rp-wrap')!;
      expect(wrap).toHaveStyle({ padding: `10px 12px ${M_TAB_PAD_B}` });
      expect(view.container.querySelector('main.m-card')!.contains(wrap)).toBe(false);
      const box = within(wrap);
      const radios = within(box.getByRole('radiogroup', { name: 'Reply type' })).getAllByRole('radio');
      expect(radios.map((r) => r.textContent)).toEqual(['Reply', 'All', 'Forward']);
      expect(radios.every((r) => !r.querySelector('svg'))).toBe(true);
      expect(radios[0]).toHaveClass('m-rp-mode');
      expect(radios[0]).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(radios[1]!);
      expect(replyActions.mode).toHaveBeenCalledExactlyOnceWith('all');
      expect(box.getByText('To: Anna Baker')).toHaveClass('m-rp-label');
      expect(box.queryByPlaceholderText('To: email address')).toBeNull();

      const text = box.getByPlaceholderText('Reply to Anna …');
      expect(text).toHaveAttribute('rows', '4');
      expect(text).toHaveValue('Thanks!');
      expect(document.activeElement).toBe(text);
      await fireEvent.input(text, { target: { value: 'Thanks, looks good.' } });
      expect(replyActions.text).toHaveBeenCalledExactlyOnceWith('Thanks, looks good.');
      // No keyboard shortcut on mobile.
      expect(await fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true })).toBe(true);
      expect(replyActions.send).not.toHaveBeenCalled();
      expect(box.queryByText('Ctrl + Enter to send')).toBeNull();

      const buttons = box.getAllByRole('button');
      expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
        'Discard',
        'Add attachment',
        'Open in editor',
        'Send',
      ]);
      expect(await tipOf(buttons[2]!)).toBe('Open in editor (Cc, Bcc, attachments)');
      const send = buttons[3]!;
      expect(send).toHaveClass('m-rp-send');
      expect(send).toHaveAttribute('aria-disabled', 'false');
      const pick = vi.spyOn(fileInput(view.container), 'click');
      for (const b of buttons) await fireEvent.click(b);
      expect(pick).toHaveBeenCalledOnce();
      expect([replyActions.cancel, replyActions.expand, replyActions.send].map((f) => f.mock.calls)).toEqual([
        [[]],
        [[]],
        [[]],
      ]);
      expect(calls()).toBe(0);
    });

    it('disables send without a connection, but without a tooltip', async () => {
      vi.useFakeTimers();
      const rd = values({ isMobile: true });
      const { view, replyActions } = setup({ isMobile: true, rd, rp: reply(rd, { text: 'Thanks!' }, true) });
      const send = view.getByRole('button', { name: 'Send' });
      expect(send).toHaveClass('m-rp-send');
      expect(send).toHaveAttribute('aria-disabled', 'true');
      expect(send).toHaveStyle({ opacity: '0.5' });
      expect(await tipOf(send)).toBeUndefined();
      await fireEvent.click(send);
      expect(replyActions.send).toHaveBeenCalledOnce();
    });

    it('shows the address field with focus when forwarding', async () => {
      const rd = values({ isMobile: true });
      const { view, replyActions } = setup({ isMobile: true, rd, rp: reply(rd, { mode: 'fwd' }) });
      const to = view.getByPlaceholderText('To: email address');
      expect(to).toHaveClass('m-rp-in');
      expect(to).toHaveAttribute('type', 'email');
      expect(document.activeElement).toBe(to);
      expect(view.queryByText(/^To: Anna/)).toBeNull();
      expect(view.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
      await fireEvent.input(to, { target: { value: 'ben@example.com' } });
      expect(replyActions.to).toHaveBeenCalledExactlyOnceWith('ben@example.com');
    });

    it('shows only restore and delete permanently in the trash', () => {
      const rd = values({
        kind: { role: 'trash' },
        title: 'Trash',
        emails: [email('t1', { mailboxIds: ['trash'] })],
      });
      const { view } = setup({ isMobile: true, rd });
      const bar = view.container.querySelector<HTMLElement>('.m-reply')!;
      const names = within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
      expect(names).toEqual(['Restore', 'Delete permanently']);
      expect(bar.querySelector('.grow')).not.toBeNull();
      expect(bar.querySelector('.del .tabler-icon-trash-x')).not.toBeNull();
    });
  });
});
