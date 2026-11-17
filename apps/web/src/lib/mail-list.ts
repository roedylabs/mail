/**
 * Values of the message list: rows, date groups in the time zone of the
 * settings (`tz`), segments, sorting of the "Compact" layout, header and
 * empty state, row actions, selection with the selection bar, row focus and
 * swipe gestures (`#lib/swipe.ts`). The conversations come from `threads`.
 */
import type { EmailAddress } from '@roedy/jmap';
import { AV, MA_COLORS } from '@roedy/tokens';
import { formatShortDate } from '#lib/date.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import type { RoleId } from '#lib/routes.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import { swipeAction, type SwipeAction } from '#lib/swipe.ts';
import { intlLocale } from '#lib/locale.ts';

/** Segment of the list; there is no "With attachment" segment. */
export type Segment = 'all' | 'unread' | 'flagged';

/** Sorting of the "Compact" layout: column and direction (1 = arrow down for "From"). */
export interface ListSort {
  key: 'date' | 'from';
  dir: 1 | -1;
}

/** Default: by date, newest first. */
export const DEFAULT_SORT: ListSort = { key: 'date', dir: -1 };

/** Query order: date or name of the first sender or recipient (RFC 8621, 4.4.2). */
export interface ListOrder {
  by: 'date' | 'from' | 'to';
  ascending: boolean;
}

/** Conversation of the list as `threads` returns it. */
export interface ListThread {
  /** Unique across accounts: `<account>/<email-id>`. */
  key: string;
  account: string;
  /** Email representing the conversation in the list (`collapseThreads`). */
  id: string;
  threadId: string;
  receivedAt: number;
  from: EmailAddress[];
  to: EmailAddress[];
  subject: string;
  preview: string;
  hasAttachment: boolean;
  unread: boolean;
  flagged: boolean;
  /** Messages of the conversation. */
  count: number;
  /** Mailboxes of all messages of the conversation (for the tags). */
  mailboxIds: string[];
  /** Emails of the conversation for the actions; without a thread only the representing one. */
  members: ListEmail[];
  /** Stamp of the load run (`stamp()` in `edits`): which own changes are still on top. */
  seq: number;
}

/** Email of a conversation as the list knows it. */
export interface ListEmail {
  id: string;
  mailboxIds: string[];
  keywords: Record<string, true>;
  /** Sender address in lower case. */
  from: string;
}

/** What the list shows: mailbox via the role, folder or tag. */
export type ListKind = { role: RoleId } | { folder: true } | { tag: true };

/** Time and calendar of the settings (time zone, time format, week start, date format). */
export interface TimeContext {
  now: number;
  tz: string;
  timeFmt: '24h' | '12h';
  weekStart: 'monday' | 'sunday';
  /** Short date for earlier years. */
  dateFmt: string;
}

const DAY = 86_400_000;

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * Formatters per time zone and options, cached (several calls per row); an
 * unknown zone (RangeError) counts as the browser's.
 */
export function dtf(tz: string, options: Intl.DateTimeFormatOptions, locale = intlLocale()): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz || undefined });
    } catch {
      f = new Intl.DateTimeFormat(locale, options);
    }
    formats.set(key, f);
  }
  return f;
}

/** Calendar day in `tz` as a running number (days since 1970). */
export function dayNumber(t: number, tz: string): number {
  const parts = dtf(tz, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(t);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(n('year'), n('month') - 1, n('day')) / DAY);
}

/** Time per `timeFmt` like `timeText()` from `#lib/errors.ts` ("20:55" or "8:55 PM"). */
export function clock(t: number, c: Pick<TimeContext, 'tz' | 'timeFmt'>): string {
  const h12 = c.timeFmt === '12h';
  return dtf(
    c.tz,
    { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 },
    h12 ? 'en-US' : intlLocale(),
  ).format(t);
}

const weekday = (t: number, tz: string, style: 'long' | 'short') => dtf(tz, { weekday: style }).format(t);

/** Heading of a day: today, yesterday, otherwise weekday and date ("Thursday 5 November"). */
export function dayLabel(t: number, c: Pick<TimeContext, 'now' | 'tz'>): string {
  const k = dayNumber(t, c.tz) - dayNumber(c.now, c.tz);
  if (k === 0) return m.list_today();
  if (k === -1) return m.list_yesterday();
  return dtf(c.tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(t);
}

/** Time in the row: time of day, yesterday, weekday, date. */
export function shortTime(t: number, c: TimeContext): string {
  return rowTime(t, c, ' ');
}

/**
 * Time in a search result: like [`shortTime`], but 2 to 6 days ahead with a
 * comma between weekday and time ("Thu, 08:00").
 */
export function searchTime(t: number, c: TimeContext): string {
  return rowTime(t, c, ', ');
}

/** `sep` stands between weekday and time 2 to 6 days ahead. */
function rowTime(t: number, c: TimeContext, sep: string): string {
  const k = dayNumber(t, c.tz) - dayNumber(c.now, c.tz);
  if (k === 0) return clock(t, c);
  if (k === -1) return m.list_yesterday();
  if (k === 1) return m.list_tomorrow_at({ time: clock(t, c) });
  if (k > 1 && k < 7) return `${weekday(t, c.tz, 'short')}${sep}${clock(t, c)}`;
  if (k > -7 && k < 0) return weekday(t, c.tz, 'long');
  const sameYear = dtf(c.tz, { year: 'numeric' }).format(t) === dtf(c.tz, { year: 'numeric' }).format(c.now);
  return sameYear ? dtf(c.tz, { day: 'numeric', month: 'short' }).format(t) : formatShortDate(t, c.dateFmt, c.tz);
}

/** Time in the tooltip: "Wednesday, 28 October 2026, 20:55". */
export function fullTime(t: number, c: TimeContext): string {
  const date = dtf(c.tz, { day: 'numeric', month: 'long', year: 'numeric' }).format(t);
  return `${weekday(t, c.tz, 'long')}, ${date}, ${clock(t, c)}`;
}

/** Time of a message in the reading view: "Today, 08:56", "Tue 27 Oct, 08:56", "27 Oct 2025, 08:56". */
export function readTime(t: number, c: TimeContext): string {
  const k = dayNumber(t, c.tz) - dayNumber(c.now, c.tz);
  const time = clock(t, c);
  if (k === 0) return m.read_today_at({ time });
  if (k === -1) return m.read_yesterday_at({ time });
  if (k === 1) return m.list_tomorrow_at({ time });
  const sameYear = dtf(c.tz, { year: 'numeric' }).format(t) === dtf(c.tz, { year: 'numeric' }).format(c.now);
  const date = dtf(
    c.tz,
    sameYear
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
  ).format(t);
  return `${date}, ${time}`;
}

export type Bucket = 'today' | 'yesterday' | 'tomorrow' | 'later' | 'week' | 'lastWeek' | 'older';

/** Date group; the week starts per `weekStart`. */
export function bucketOf(t: number, c: TimeContext): Bucket {
  const today = dayNumber(c.now, c.tz);
  const day = dayNumber(t, c.tz);
  const k = day - today;
  if (k === 0) return 'today';
  if (k === -1) return 'yesterday';
  if (k === 1) return 'tomorrow';
  if (k > 1) return 'later';
  // Day 0 (1 Jan 1970) was a Thursday: (n + 4) % 7 is the weekday with 0 = Sunday.
  const weekStart = today - ((((today + 4) % 7) + (c.weekStart === 'sunday' ? 0 : 6)) % 7);
  if (day >= weekStart) return 'week';
  return day >= weekStart - 7 ? 'lastWeek' : 'older';
}

/** Times of a row: column, tooltip and date group. */
export interface RowTimes {
  short: string;
  full: string;
  bucket: Bucket;
}

/** Key per time context: settings and today's day (the minute does not count); the language is added per call. */
const timeKeys = new WeakMap<TimeContext, string>();
let rowTimesKey = '';
let rowTimesCache = new Map<number, RowTimes>();
/** Upper limit of the cache (timestamps); above it, it starts over. */
export const ROW_TIMES_MAX = 20_000;

/**
 * [`shortTime`], [`fullTime`] and [`bucketOf`] for a row, cached per
 * timestamp: the list recomputes all rows on every new page and every sync, and the date formats cost almost 90 ms per
 * page with 5,000 conversations. The values depend only on the timestamp,
 * the settings, the language and today's day; the page clock (a new context
 * every minute) therefore only clears the cache on the next day.
 */
export function rowTimes(t: number, c: TimeContext): RowTimes {
  let ctx = timeKeys.get(c);
  if (ctx === undefined) {
    ctx = `${c.tz}|${c.timeFmt}|${c.weekStart}|${c.dateFmt}|${dayNumber(c.now, c.tz)}`;
    timeKeys.set(c, ctx);
  }
  const key = `${intlLocale()}|${ctx}`;
  if (key !== rowTimesKey || rowTimesCache.size >= ROW_TIMES_MAX) {
    rowTimesKey = key;
    rowTimesCache = new Map();
  }
  let times = rowTimesCache.get(t);
  if (!times) {
    times = { short: shortTime(t, c), full: fullTime(t, c), bucket: bucketOf(t, c) };
    rowTimesCache.set(t, times);
  }
  return times;
}

export function bucketLabel(b: Bucket): string {
  return {
    today: m.list_today,
    yesterday: m.list_yesterday,
    tomorrow: m.list_tomorrow,
    later: m.list_later,
    week: m.list_this_week,
    lastWeek: m.list_last_week,
    older: m.list_older,
  }[b]();
}

/** Company suffixes and name particles that do not count towards the initials. */
const SKIP = /^(GmbH|AG|KG|Inc|Ltd|LLC|The|the|of|and)$/;

/** Initials of the name, empty without a word starting with a letter. */
export function initials(name: string): string {
  const words = name
    .replace(/[[\]()]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w) && !SKIP.test(w));
  return words.length ? (words[0]!.charAt(0) + (words[1]?.charAt(0) ?? '')).toUpperCase() : '';
}

/** Avatar colour from the name. */
export function avatarOf(name: string): readonly [string, string] {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV[h % AV.length]!;
}

/** Name, otherwise address; empty without both. */
export const nameOf = (a: EmailAddress | undefined): string => a?.name?.trim() || a?.email || '';

/** Background and text colour of a tag (index in `MA_COLORS`). */
export function tagColors(color: number): { bg: string; ink: string } {
  const [, bg, ink] = MA_COLORS[color % MA_COLORS.length]!;
  return { bg, ink };
}

/**
 * Name, otherwise address of a sender; without both "Unknown", as in the
 * list, reading view and search. Display only: sorting uses the header.
 */
export const senderText = (a: EmailAddress | undefined): string => nameOf(a) || m.list_no_sender();

/** "1 message" or "‹n› messages". */
export function messagesText(n: number): string {
  return n === 1 ? m.list_messages_one() : m.list_messages({ n });
}

/** Tag on a row: name and index in `MA_COLORS`. */
export interface RowTag {
  name: string;
  color: number;
  /** Position in the tag list; tags without one stay in the order of the mailboxes. */
  rank?: number;
}

/** Tags in the order of the tag list (row and reading view; the emails know no order of setting). */
export const byTagRank = (a: RowTag, b: RowTag): number => (a.rank ?? 0) - (b.rank ?? 0);

/** Conversation across accounts (selection and focus); stays when a new message represents it. */
export const threadRef = (t: { account: string; threadId: string }): string => `${t.account}/${t.threadId}`;

/**
 * The email of the row lies in "Drafts" (`drafts`, the account's mailbox):
 * opening the row opens compose with it, in every view (`pfOpen`).
 */
export function draftOf(t: Pick<ListThread, 'id' | 'members'>, drafts: string | null): boolean {
  return !!drafts && !!t.members.find((e) => e.id === t.id)?.mailboxIds.includes(drafts);
}

/** Row of the list. */
export interface ListRow {
  key: string;
  /** `threadRef()` of the conversation. */
  ref: string;
  account: string;
  id: string;
  threadId: string;
  who: string;
  letter: string;
  noLetter: boolean;
  avBg: string;
  avInk: string;
  subj: string;
  prev: string;
  time: string;
  timeFull: string;
  unread: boolean;
  star: boolean;
  starIcon: 'ti-star-filled' | 'ti-star';
  starTip: string;
  hasAtt: boolean;
  n: string;
  hasN: boolean;
  nLabel: string;
  tags: { label: string; bg: string; ink: string; chip: string }[];
  hasTags: boolean;
  hasChip: boolean;
  chip: string;
  chipIcon: 'ti-pencil' | 'ti-clock';
  multi: boolean;
  acctBg: string;
  acctMail: string;
  /** Selected. */
  checked: boolean;
  /** Checkbox instead of avatar or visible without hover: selected or selection active. */
  showCk: boolean;
  /** Last opened or chosen with ↑/↓. */
  focused: boolean;
  /** "Select: ‹subject›" or "Clear selection: ‹subject›". */
  ckLabel: string;
  /**
   * Button in place of read/unread (not in the trash): if the email is in
   * Scheduled (`sched`), "Cancel send" (`ti-clock-x`), otherwise read or
   * unread.
   */
  readIcon: 'ti-mail-opened' | 'ti-mail' | 'ti-clock-x';
  readTip: string;
  delIcon: 'ti-trash-x' | 'ti-trash';
  delTip: string;
  isTrash: boolean;
  /**
   * The row's email is in Scheduled: always in the Scheduled view, in tag
   * views per its mailboxes (`outboxOf`). Then the read button cancels the
   * sending instead of marking it read.
   */
  sched: boolean;
  fw: number;
  sfw: number;
  tfw: number;
  tC: string;
  aBg: string;
  aSh: string;
  aHov: string;
  ringC: string;
  /** Background of the row in "Compact". */
  bBg: string;
  bHov: string;
  /** Swipe left or right; `null` without swipe gestures or without an action at this position. */
  swL: SwipeAction | null;
  swR: SwipeAction | null;
}

export interface ListGroup {
  key: Bucket;
  label: string;
  n: string;
  rows: ListRow[];
}

export interface SegmentButton {
  id: Segment;
  label: string;
  n: string;
  hasN: boolean;
  on: boolean;
}

/** Column header for sorting. */
export interface SortButton {
  key: ListSort['key'];
  label: string;
  aria: string;
  /** List is sorted by this column: colour and arrow. */
  on: boolean;
  /** Arrow up: against the column's default. */
  up: boolean;
}

/** Action of the selection bar; `cancel` cancels the sending in Scheduled. */
export type BulkAction = 'read' | 'unread' | 'cancel' | 'flag' | 'unflag' | 'trash' | 'restore' | 'purge';

/** Button of the selection bar. */
export interface BulkButton {
  id: BulkAction;
  icon: IconName;
  label: string;
  tip: string;
}

/** "Select all" checkbox. */
export interface CheckAll {
  /** `aria-checked`: all, none or some of the loaded ones. */
  checked: 'true' | 'false' | 'mixed';
  icon: 'ti-check' | 'ti-minus';
  label: string;
  /** Something selected: filled checkbox. */
  on: boolean;
  /** All loaded ones selected: a click clears the selection, otherwise it selects all. */
  all: boolean;
}

/** Counts of the view: conversations per segment, `null` while unknown. */
export type SegmentCounts = Record<Segment, number | null>;

export interface ListInput {
  kind: ListKind;
  title: string;
  segment: Segment;
  threads: readonly ListThread[];
  counts: SegmentCounts;
  /** Matches of the segment (server), also beyond the loaded ones. */
  total: number;
  /** "All accounts": rows with a dot in the account's colour. */
  multi: boolean;
  /** Email address and colour (index in `MA_COLORS`) per account. */
  accountOf: (account: string) => { email: string; color: number } | undefined;
  /** Tag of a mailbox in the account, otherwise `undefined`. */
  tagOf: (account: string, mailbox: string) => RowTag | undefined;
  time: TimeContext;
  /** "Compact" layout: rows without date groups (`groups` stays empty). */
  compact?: boolean | undefined;
  /** Sorting of the "Compact" layout for the column headers; `DEFAULT_SORT` if not given. */
  sort?: ListSort | undefined;
  /** Selected conversations (`threadRef()`); only those of the list count. */
  selected?: ReadonlySet<string> | undefined;
  /** Last opened or chosen with ↑/↓ conversation (`threadRef()`). */
  focus?: string | null | undefined;
  /**
   * Send time of a scheduled email (`sendAt` of its submission) while it is
   * in "Scheduled" (`mailboxIds`); row, tooltip and group show it instead of
   * `receivedAt`.
   */
  sendAt?: ((account: string, email: string, mailboxIds: readonly string[]) => number | undefined) | undefined;
  /**
   * Sent, drafts or scheduled among the mailboxes of a conversation; counts
   * only in tag views, where the view does not name the folder: swipe
   * gestures omit the same actions there, and an email from Scheduled gets
   * "Cancel send" (`sched`).
   */
  outboxOf?: ((account: string, mailboxIds: readonly string[]) => 'sent' | 'drafts' | 'scheduled' | null) | undefined;
  /** Swipe gestures (mobile and tablet) with the settings for left and right; none if not given. */
  swipe?: { left: string; right: string } | null | undefined;
}

export interface ListValues {
  title: string;
  sub: string;
  range: string;
  seg: SegmentButton[];
  hasSeg: boolean;
  /** Column header (Compact): as soon as the view has messages. */
  hasHead: boolean;
  sortFrom: SortButton;
  sortDate: SortButton;
  /** Rows in the order of the list (Compact). */
  rows: ListRow[];
  /** Rows in date groups (Soft; empty in Compact). */
  groups: ListGroup[];
  empty: boolean;
  eIcon: IconName;
  eTitle: string;
  eText: string;
  eHasAct: boolean;
  /** "Sign in again" button in the empty state. */
  eHasRe: boolean;
  /** "Go to connection" button in the empty state, server locked. */
  eHasCon: boolean;
  /** Notice above a saved list. */
  note: { on: boolean; text: string; isRe: boolean; isCon: boolean };
  /** Below the list: older ones are not saved offline. */
  footOn: boolean;
  hasClear: boolean;
  isFolder: boolean;
  isTag: boolean;
  /** Selection active: selection bar instead of segments. */
  selOn: boolean;
  /** "‹n› selected". */
  selText: string;
  chkAll: CheckAll;
  /** Buttons of the selection bar. */
  bulk: BulkButton[];
  /** `threadRef()` of the focused row while it is in the list (for revealing it). */
  focus: string | null;
}

/** Mailboxes without "Unread". */
const OUTBOX: ReadonlySet<RoleId> = new Set(['sent', 'drafts', 'scheduled']);

export function isOutbox(kind: ListKind): boolean {
  return 'role' in kind && OUTBOX.has(kind.role);
}

/** Segments of the view. */
export function segmentsOf(kind: ListKind): Segment[] {
  return isOutbox(kind) ? ['all', 'flagged'] : ['all', 'unread', 'flagged'];
}

const isScheduled = (kind: ListKind) => 'role' in kind && kind.role === 'scheduled';

/**
 * Query order. "Soft" sorts by date, scheduled messages ascending, all
 * others descending. "Compact" per `sort`: by sender or, in sent, drafts
 * and scheduled, by recipient (`dir` 1 = A–Z), or by date (`dir` -1 =
 * default: newest first, in Scheduled the next one first; `dir` 1 also
 * reverses the list in Scheduled).
 */
export function listOrder(kind: ListKind, compact: boolean, sort: ListSort = DEFAULT_SORT): ListOrder {
  if (compact && sort.key === 'from') return { by: isOutbox(kind) ? 'to' : 'from', ascending: sort.dir > 0 };
  const scheduled = isScheduled(kind);
  return { by: 'date', ascending: compact && sort.dir > 0 ? !scheduled : scheduled };
}

/** Click on a column header: the same column reverses the direction, another starts with its default. */
export function nextSort(sort: ListSort, key: ListSort['key']): ListSort {
  return sort.key === key ? { key, dir: sort.dir > 0 ? -1 : 1 } : { key, dir: key === 'from' ? 1 : -1 };
}

function emptyText(kind: ListKind, segment: Segment, total: number): [IconName, string, string] {
  if (total > 0 && segment === 'unread')
    return ['ti-mail-opened', m.list_empty_unread_title(), m.list_empty_unread_text()];
  if (total > 0 && segment === 'flagged') return ['ti-star', m.list_empty_flagged_title(), m.list_empty_flagged_text()];
  if ('tag' in kind) return ['ti-tag', m.list_empty_tag_title(), m.list_empty_tag_text()];
  if ('folder' in kind) return ['ti-folder', m.list_empty_folder_title(), m.list_empty_folder_text()];
  const texts: Record<RoleId, () => [IconName, string, string]> = {
    inbox: () => ['ti-inbox', m.list_empty_inbox_title(), m.list_empty_inbox_text()],
    sent: () => ['ti-send', m.list_empty_sent_title(), m.list_empty_sent_text()],
    drafts: () => ['ti-file-pencil', m.list_empty_drafts_title(), m.list_empty_drafts_text()],
    scheduled: () => ['ti-clock', m.list_empty_scheduled_title(), m.list_empty_scheduled_text()],
    trash: () => ['ti-trash', m.list_empty_trash_title(), m.list_empty_trash_text()],
    spam: () => ['ti-shield-check', m.list_empty_spam_title(), m.list_empty_spam_text()],
  };
  return texts[kind.role]();
}

function sortButton(key: ListSort['key'], label: string, sort: ListSort): SortButton {
  const on = sort.key === key;
  return { key, label, aria: m.list_sort({ label }), on, up: on && (key === 'from' ? sort.dir < 0 : sort.dir > 0) };
}

function segmentLabel(s: Segment): string {
  return { all: m.list_seg_all, unread: m.list_seg_unread, flagged: m.list_seg_flagged }[s]();
}

/**
 * Row of a conversation from its representing email in the chosen sorting;
 * without a sender "Unknown" (`senderText()`), without a recipient "No
 * recipient".
 */
/** Time of the row: for a scheduled email the send time, otherwise `receivedAt`. */
const shownAt = (t: ListThread, input: Pick<ListInput, 'sendAt'>) =>
  input.sendAt?.(t.account, t.id, t.mailboxIds) ?? t.receivedAt;

/**
 * Conversations in "Scheduled" by send time (`sendAt`), as `order` requires:
 * the server only sorts by `receivedAt`, the saving of the draft. Otherwise
 * unchanged.
 */
export function bySendAt<T extends ListThread>(
  threads: readonly T[],
  kind: ListKind,
  order: ListOrder,
  sendAt: NonNullable<ListInput['sendAt']>,
): readonly T[] {
  if (!isScheduled(kind) || order.by !== 'date') return threads;
  const sign = order.ascending ? 1 : -1;
  return [...threads].sort((a, b) => sign * (shownAt(a, { sendAt }) - shownAt(b, { sendAt })));
}

export function rowOf(
  t: ListThread,
  input: Pick<ListInput, 'kind' | 'multi' | 'accountOf' | 'tagOf' | 'time' | 'swipe' | 'outboxOf' | 'sendAt'>,
): ListRow {
  const { kind } = input;
  const times = rowTimes(shownAt(t, input), input.time);
  const ref = threadRef(t);
  const role = 'role' in kind ? kind.role : null;
  const outbox = isOutbox(kind);
  const isTrash = role === 'trash';
  const person = nameOf(outbox ? t.to[0] : t.from[0]);
  const who = outbox ? (person ? m.list_to({ name: person }) : m.list_no_recipient()) : senderText(t.from[0]);
  const letter = initials(person);
  const [avBg, avInk] = person ? avatarOf(person) : ['var(--sunken)', 'var(--mfg)'];
  const u = t.unread;
  const account = input.accountOf(t.account);
  const tags = t.mailboxIds
    .map((b) => input.tagOf(t.account, b))
    .filter((x): x is RowTag => !!x)
    .sort(byTagRank)
    .slice(0, 2)
    .map((x) => ({ label: x.name, ...tagColors(x.color), chip: u ? 'var(--surface2)' : 'var(--surface)' }));
  const subject = t.subject.trim();
  const sw = input.swipe;
  const own = 'role' in kind ? null : (input.outboxOf?.(t.account, t.mailboxIds) ?? null);
  const where: ListKind = own ? { role: own } : kind;
  const sched = (own ?? role) === 'scheduled';
  const swipeOf = (key: string) => (sw ? swipeAction(key, { unread: u, star: t.flagged }, where) : null);
  return {
    key: t.key,
    ref,
    account: t.account,
    id: t.id,
    threadId: t.threadId,
    who,
    letter,
    noLetter: !letter,
    avBg,
    avInk,
    subj: subject || m.list_no_subject(),
    prev: t.preview,
    time: times.short,
    timeFull: (role === 'scheduled' ? m.list_sends_at() : '') + times.full,
    unread: u,
    star: t.flagged,
    starIcon: t.flagged ? 'ti-star-filled' : 'ti-star',
    starTip: t.flagged ? m.list_unstar() : m.list_star(),
    hasAtt: t.hasAttachment,
    n: String(t.count),
    hasN: t.count > 1,
    nLabel: messagesText(t.count),
    tags,
    hasTags: tags.length > 0,
    hasChip: role === 'drafts' || role === 'scheduled',
    chip: role === 'drafts' ? m.list_chip_draft() : m.list_chip_scheduled(),
    chipIcon: role === 'drafts' ? 'ti-pencil' : 'ti-clock',
    multi: input.multi,
    acctBg: MA_COLORS[account?.color ?? 0]?.[1] ?? MA_COLORS[0][1],
    acctMail: account?.email ?? '',
    checked: false,
    showCk: false,
    focused: false,
    ckLabel: m.list_select({ subject: subject || m.list_message() }),
    readIcon: sched ? 'ti-clock-x' : u ? 'ti-mail-opened' : 'ti-mail',
    readTip: sched ? m.plan_cancel() : u ? m.list_mark_read() : m.list_mark_unread(),
    delIcon: isTrash ? 'ti-trash-x' : 'ti-trash',
    delTip: isTrash ? m.list_purge() : m.list_delete(),
    isTrash,
    sched,
    fw: u ? 800 : 600,
    sfw: u ? 750 : 500,
    tfw: u ? 800 : 600,
    tC: u ? 'var(--fg)' : 'var(--mfg)',
    ...rowLook(u, false, false),
    swL: swipeOf(sw?.left ?? ''),
    swR: swipeOf(sw?.right ?? ''),
  };
}

/** Colours of the row by read state, selection and focus. */
function rowLook(u: boolean, sl: boolean, foc: boolean) {
  return {
    aBg: sl ? 'var(--accsoft)' : u ? 'var(--surface)' : 'transparent',
    aSh: foc ? '0 0 0 2px var(--acc)' : u && !sl ? 'var(--sh1)' : 'none',
    aHov: sl ? 'var(--accsoft)' : 'var(--surface)',
    ringC: sl ? 'var(--accsoft)' : u ? 'var(--surface)' : 'var(--surface2)',
    bBg: sl ? 'var(--accsoft)' : foc ? 'var(--surface2)' : 'transparent',
    bHov: sl ? 'var(--accsoft)' : 'var(--hov)',
  };
}

/**
 * Buttons of the selection bar: in the trash restore and delete
 * permanently, otherwise read or unread (read as soon as one is unread) –
 * in Scheduled "Cancel send" instead –, flag or unflag (unflag when all are
 * flagged) and delete (in Scheduled with cancelling the sending).
 */
export function bulkButtons(kind: ListKind, picked: readonly ListThread[]): BulkButton[] {
  const role = 'role' in kind ? kind.role : null;
  if (role === 'trash')
    return [
      { id: 'restore', icon: 'ti-arrow-back-up', label: m.list_restore(), tip: m.list_restore() },
      { id: 'purge', icon: 'ti-trash-x', label: m.list_purge(), tip: m.list_purge() },
    ];
  const anyU = picked.some((t) => t.unread);
  const allSt = picked.length > 0 && picked.every((t) => t.flagged);
  const star: BulkButton = allSt
    ? { id: 'unflag', icon: 'ti-star-off', label: m.list_bulk_unstar(), tip: m.list_bulk_unstar() }
    : { id: 'flag', icon: 'ti-star', label: m.list_star(), tip: m.list_star() };
  return [
    role === 'scheduled'
      ? { id: 'cancel', icon: 'ti-clock-x', label: m.plan_cancel(), tip: m.plan_cancel() }
      : anyU
        ? { id: 'read', icon: 'ti-mail-opened', label: m.list_bulk_read(), tip: m.list_mark_read() }
        : { id: 'unread', icon: 'ti-mail', label: m.list_bulk_unread(), tip: m.list_mark_unread() },
    star,
    { id: 'trash', icon: 'ti-trash', label: m.list_delete(), tip: m.list_delete() },
  ];
}

/** Click on a quick action of the row: calls `fn` with the row and does not open it (no passing on to the row). */
export function rowAction(fn: (row: ListRow) => void, row: ListRow): (e: Event) => void {
  return (e) => {
    e.stopPropagation();
    fn(row);
  };
}

/** Header, segments, groups, empty state and selection of the list. */
export function listValues(input: ListInput): ListValues {
  return selectionValues(baseValues(input), input);
}

/**
 * Values of the list without selection and focus: the page keeps them
 * separate so that a checkbox or ↑/↓ does not recompute all rows (see `selectionValues()`).
 */
export function baseValues(input: Omit<ListInput, 'selected' | 'focus'>): ListValues {
  const { kind, segment, counts } = input;
  const role = 'role' in kind ? kind.role : null;
  const outbox = isOutbox(kind);
  const keys = segmentsOf(kind);
  const tot = counts.all ?? 0;
  const nU = counts.unread ?? 0;
  const sub =
    role === 'drafts'
      ? tot === 1
        ? m.list_drafts_one()
        : m.list_drafts({ n: tot })
      : role === 'scheduled'
        ? m.list_scheduled({ n: tot })
        : outbox || !nU
          ? messagesText(tot)
          : m.list_unread_of({ n: nU, messages: messagesText(tot) });
  const rows = input.threads.map((t) => rowOf(t, input));
  const groups: ListGroup[] = [];
  if (!input.compact)
    input.threads.forEach((t, i) => {
      const b = rowTimes(shownAt(t, input), input.time).bucket;
      let g = groups.at(-1);
      if (!g || g.key !== b) groups.push((g = { key: b, label: bucketLabel(b), n: '', rows: [] }));
      g.rows.push(rows[i]!);
    });
  for (const g of groups) g.n = String(g.rows.length);
  const [eIcon, eTitle, eText] = emptyText(kind, segment, tot);
  const sort = input.sort ?? DEFAULT_SORT;
  return {
    title: input.title,
    sub,
    range: tot ? (input.total === tot ? messagesText(tot) : m.list_range({ n: input.total, total: tot })) : '',
    seg: keys.map((id) => {
      const n = counts[id] ?? 0;
      return { id, label: segmentLabel(id), n: String(n), hasN: id !== 'all' && n > 0, on: id === segment };
    }),
    hasSeg: keys.length > 1 && tot > 0,
    hasHead: tot > 0,
    sortFrom: sortButton('from', outbox ? m.list_sort_to() : m.list_sort_from(), sort),
    sortDate: sortButton('date', role === 'scheduled' ? m.list_sort_send() : m.list_sort_date(), sort),
    rows,
    groups,
    empty: input.threads.length === 0,
    eIcon,
    eTitle,
    eText,
    eHasAct: tot > 0 && segment !== 'all',
    eHasRe: false,
    eHasCon: false,
    note: NO_NOTE,
    footOn: false,
    hasClear: role === 'trash' && tot > 0,
    isFolder: 'folder' in kind,
    isTag: 'tag' in kind,
    ...selectionOf(kind, [], 0),
    focus: null,
  };
}

const NO_NOTE: ListValues['note'] = { on: false, text: '', isRe: false, isCon: false };

/** What `listNotice()` must know about the view. */
export interface NoticeInput {
  /** Accounts of the view. */
  accounts: readonly Pick<MailAccount, 'email' | 'host' | 'state' | 'blocked'>[];
  offline: boolean;
  /** List unknown: without a connection and nothing saved. */
  unsaved: boolean;
  /** There would be more pages than the saved list holds. */
  truncated: boolean;
}

/**
 * States without connection and without access: if all accounts of the view
 * are without access, without a saved list the "Sign-in required" empty
 * state shows, with a list a notice above it. If only some are affected, the
 * list stays and the notice bar names the account.
 */
export function listNotice(values: ListValues, tot: number, input: NoticeInput): ListValues {
  const { accounts, offline, unsaved, truncated } = input;
  const gone = accounts.filter((a) => a.state === 'needs_reauth' || a.blocked);
  const allGone = accounts.length > 0 && gone.length === accounts.length;
  const first = accounts[0];
  const solo = accounts.length === 1;
  const blocked = solo && !!first?.blocked;
  const footOn = offline && truncated && values.rows.length > 0;
  if (tot > 0) {
    if (!allGone || !first) return footOn ? { ...values, footOn } : values;
    const text = blocked
      ? m.list_stale_note_blocked({ host: first.host })
      : solo
        ? m.list_stale_note({ host: first.host })
        : m.list_stale_note_many({ n: accounts.length });
    return { ...values, footOn, note: { on: true, text, isRe: !blocked, isCon: blocked } };
  }
  if (allGone && first) {
    const eTitle = blocked ? m.list_stale_blocked_title() : m.list_stale_title();
    const eText = blocked
      ? m.mail_account_check_blocked({ host: first.host })
      : solo
        ? m.list_stale_one({ email: first.email })
        : m.list_stale_many({ n: accounts.length });
    return {
      ...values,
      sub: eTitle,
      empty: true,
      eIcon: 'ti-plug-connected-x',
      eTitle,
      eText,
      eHasAct: false,
      eHasRe: !blocked,
      eHasCon: blocked,
    };
  }
  if (unsaved)
    return {
      ...values,
      sub: m.list_off_folder_sub(),
      empty: true,
      eIcon: 'ti-cloud-off',
      eTitle: m.list_off_folder_title(),
      eText: m.list_off_folder_text(),
      eHasAct: false,
    };
  return values;
}

/** Selection bar and "Select all" for `picked` of `total` conversations. */
function selectionOf(
  kind: ListKind,
  picked: readonly ListThread[],
  total: number,
): Pick<ListValues, 'selOn' | 'selText' | 'chkAll' | 'bulk'> {
  const nSel = picked.length;
  const allOn = nSel > 0 && nSel === total;
  return {
    selOn: nSel > 0,
    selText: nSel === 1 ? m.list_selected_one() : m.list_selected({ n: nSel }),
    chkAll: {
      checked: allOn ? 'true' : nSel ? 'mixed' : 'false',
      icon: allOn ? 'ti-check' : 'ti-minus',
      label: allOn ? m.list_clear_selection() : m.list_select_all(),
      on: nSel > 0,
      all: allOn,
    },
    bulk: bulkButtons(kind, picked),
  };
}

/**
 * Selection and focus on top of the values from `baseValues()`:
 * only the affected rows and their groups are created anew, the rest stay
 * the same objects. `input.threads` belong to `base.rows` (same order).
 */
export function selectionValues(
  base: ListValues,
  input: Pick<ListInput, 'kind' | 'threads' | 'selected' | 'focus'>,
): ListValues {
  const selected = input.selected ?? new Set<string>();
  const focus = input.focus ?? null;
  const picked = input.threads.filter((t) => selected.has(threadRef(t)));
  const active = picked.length > 0;
  if (!active && !focus) return base;
  const changed = new Map<ListRow, ListRow>();
  const rows = base.rows.map((r, i) => {
    const sl = selected.has(r.ref);
    const foc = focus === r.ref;
    if (!sl && !foc && !active) return r;
    const subject = input.threads[i]?.subject.trim() || m.list_message();
    const next: ListRow = {
      ...r,
      checked: sl,
      showCk: sl || active,
      focused: foc,
      ckLabel: (sl ? m.list_unselect : m.list_select)({ subject }),
      ...rowLook(r.unread, sl, foc),
    };
    changed.set(r, next);
    return next;
  });
  const groups = changed.size
    ? base.groups.map((g) =>
        g.rows.some((r) => changed.has(r)) ? { ...g, rows: g.rows.map((r) => changed.get(r) ?? r) } : g,
      )
    : base.groups;
  return {
    ...base,
    rows,
    groups,
    ...selectionOf(input.kind, picked, input.threads.length),
    focus: rows.find((r) => r.focused)?.ref ?? null,
  };
}

/** Entry of the virtual list: header of a group or row with its position in the group. */
export type ListItem =
  | { type: 'head'; key: string; group: ListGroup; first: boolean }
  | { type: 'row'; key: string; row: ListRow; first: boolean; last: boolean };

/** Groups as a flat list for virtualization (header, then the rows). */
export function flatItems(groups: readonly ListGroup[]): ListItem[] {
  return groups.flatMap((group, gi): ListItem[] => [
    { type: 'head', key: `h:${group.key}`, group, first: gi === 0 },
    ...group.rows.map((row, i): ListItem => ({
      type: 'row',
      key: row.key,
      row,
      first: i === 0,
      last: i === group.rows.length - 1,
    })),
  ]);
}
