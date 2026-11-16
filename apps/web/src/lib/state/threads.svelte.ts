/**
 * State module `threads`: the conversations of a
 * list from `Email/query` with `collapseThreads`, page by page (`PAGE_SIZE`),
 * sorted by date or (compact) by sender or recipient, in "all
 * accounts" queried per account and merged in the order of the list.
 * One page is one request: query, the representative emails, their
 * threads and their emails (state of the conversation) via back-references,
 * on the first page also the counters of the segments. "Refresh" syncs
 * with `Email/queryChanges`; the live sync (`live`) reports
 * changed threads, which the next sync refetches in the same request.
 * Own changes that the server does not show yet (`edits`)
 * lie over the loaded conversations: whatever leaves the view drops
 * out, counters and flags follow; whatever comes in through them (a
 * moved email, a waiting draft) is already there until the
 * confirmation. Known lists come from storage first,
 * `Email/changes` and `Email/queryChanges` follow.
 */
import {
  applyQueryChanges,
  changes,
  type AddedItem,
  type Batch,
  type BatchResponse,
  type Call,
  type Email,
  type EmailAddress,
  type EmailComparator,
  type EmailFilter,
  type Filter,
  type Id,
  type JmapClient,
  type ResultReference,
} from '@roedy/jmap';
import { isOffline } from '#lib/errors.ts';
import { applyEdit, inSource, type EmailEdit } from '#lib/mail-actions.ts';
import { inMailboxes } from '#lib/mail-blocks.ts';
import type { ListEmail, ListOrder, ListThread, Segment, SegmentCounts } from '#lib/mail-list.ts';
import type { QueuedDraft } from '#lib/mail-queue.ts';
import { MAX_LIST_THREADS, type MailStore, type SavedList } from '#lib/mail-store.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { LOCAL_DRAFT } from '#lib/state/edit-queue.svelte.ts';
import { edits, stamp } from '#lib/state/edits.svelte.ts';
import type { EmailChange, EmailChanges } from '#lib/state/live.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/** Conversations per page and account. */
export const PAGE_SIZE = 50;

/** Lists in memory (most recently opened); older ones reload on the next opening. */
const CACHE_SIZE = 8;

const SEGMENTS: readonly Segment[] = ['all', 'unread', 'flagged'];

/** Mailboxes of an account a list reads from. */
export interface ThreadSource {
  account: string;
  /** In one of these mailboxes (`inMailbox`, several via `OR`): mailbox, folder or tag with subtags. */
  boxes: Id[];
  /** In none of these mailboxes: trash and spam for tags. */
  exclude: Id[];
  /** No access to the account (sign-in required, blocked): only storage, never the network. */
  frozen?: boolean;
}

/** Filter of an account's list in the segment. */
export function sourceFilter(source: ThreadSource, segment: Segment): Filter<EmailFilter> {
  const conditions: Filter<EmailFilter>[] = [inMailboxes(source.boxes)];
  if (source.exclude.length)
    conditions.push({ operator: 'NOT', conditions: source.exclude.map((inMailbox) => ({ inMailbox })) });
  if (segment === 'unread') conditions.push({ notKeyword: '$seen' });
  if (segment === 'flagged') conditions.push({ hasKeyword: '$flagged' });
  return conditions.length === 1 ? conditions[0]! : { operator: 'AND', conditions };
}

const LIST_PROPS = [
  'id',
  'threadId',
  'mailboxIds',
  'keywords',
  'receivedAt',
  'from',
  'to',
  'subject',
  'preview',
  'hasAttachment',
] satisfies (keyof Email)[];

const MEMBER_PROPS = ['id', 'mailboxIds', 'keywords', 'from'] satisfies (keyof Email)[];

type Member = Pick<Email, 'id' | 'mailboxIds' | 'keywords'> & Partial<Pick<Email, 'from'>>;
type Rep = Pick<Email, (typeof LIST_PROPS)[number]>;

/** Request of a page. */
export interface PageRequest {
  source: ThreadSource;
  segment: Segment;
  order: ListOrder;
  position: number;
  /** Further page: after this representative email (`anchor`, `anchorOffset` 1), otherwise from `position`. */
  anchor?: Id | undefined;
  limit: number;
  /** Also query the counters of these segments (first page, reload); the own segment is counted by the query itself. */
  counts: readonly Segment[];
}

export interface PageResult {
  ids: Id[];
  threads: ListThread[];
  /** `null` if the server cannot do `calculateTotal`. */
  total: number | null;
  queryState: string;
  /** State of the emails of this response. */
  emailState: string;
  counts: Partial<SegmentCounts>;
}

export interface ChangesRequest {
  source: ThreadSource;
  segment: Segment;
  order: ListOrder;
  sinceQueryState: string;
  /** Last loaded conversation: changes behind it do not matter (RFC 8620, 5.6). */
  upToId: Id | null;
  /** Loaded representative emails whose conversation has changed (read, flagged, new reply): refetch. */
  reload: readonly Id[];
}

export type ChangesResult =
  | { reset: true }
  | {
      reset: false;
      removed: Id[];
      added: AddedItem[];
      /** Conversations for `added`. */
      threads: ListThread[];
      /** Conversations for `reload`, as far as the emails still exist. */
      reloaded: ListThread[];
      total: number | null;
      queryState: string;
      counts: Partial<SegmentCounts>;
    };

/** Access to the mail servers; replaceable in tests. */
export interface ThreadApi {
  page(request: PageRequest): Promise<PageResult>;
  changes(request: ChangesRequest & { counts: readonly Segment[] }): Promise<ChangesResult>;
  /** Changes since `since`, with the threads of new and changed emails (after a start from storage). */
  emailChanges(account: string, since: string): Promise<EmailChanges>;
}

/* eslint-disable svelte/prefer-svelte-reactivity -- local helper values of pure functions, not state */

const listEmail = (e: Member): ListEmail => ({
  id: e.id,
  mailboxIds: Object.keys(e.mailboxIds),
  keywords: e.keywords,
  from: (e.from?.[0]?.email ?? '').toLowerCase(),
});

/**
 * Unread, flagged and mailboxes from the emails of the conversation:
 * unread or flagged if one of its emails in the list's mailboxes
 * is (like `unreadThreads`, RFC 8621, 2); if none lies there (e.g. without
 * the emails of the thread), the representative one counts alone.
 */
function summarize<T extends Pick<ListThread, 'id'>>(
  base: T,
  members: ListEmail[],
  source: ThreadSource,
): T & Pick<ListThread, 'unread' | 'flagged' | 'mailboxIds' | 'members'> {
  const inList = members.filter((e) => inSource(e.mailboxIds, source));
  const scope = inList.length ? inList : members.filter((e) => e.id === base.id);
  return {
    ...base,
    unread: scope.some((e) => !e.keywords['$seen']),
    flagged: scope.some((e) => !!e.keywords['$flagged']),
    mailboxIds: [...new Set(members.flatMap((e) => e.mailboxIds))],
    members,
  };
}

/**
 * Conversation from the representative email and the emails of its thread;
 * without the emails of the thread (query failed) only with the representative one.
 */
export function threadOf(
  account: string,
  rep: Rep,
  emailIds: Id[] | null,
  members: Map<Id, Member> | null,
  source: ThreadSource,
): ListThread {
  const all = emailIds && members ? emailIds.map((id) => members.get(id)).filter((e): e is Member => !!e) : [];
  const list = all.some((e) => e.id === rep.id) ? all : [rep, ...all];
  return summarize(
    {
      key: `${account}/${rep.id}`,
      account,
      id: rep.id,
      threadId: rep.threadId,
      receivedAt: Date.parse(rep.receivedAt),
      from: rep.from ?? [],
      to: rep.to ?? [],
      subject: rep.subject ?? '',
      preview: rep.preview ?? '',
      hasAttachment: rep.hasAttachment,
      count: emailIds?.length ?? 1,
      seq: 0,
    },
    list.map(listEmail),
    source,
  );
}

/**
 * Conversation with the own changes (`edit` per email): `null` if
 * none of its emails is in the view any more; unchanged the same one if
 * no change hits it.
 */
export function editedThread(
  t: ListThread,
  source: ThreadSource,
  edit: (id: Id) => EmailEdit | undefined,
): ListThread | null {
  let touched = false;
  const members: ListEmail[] = [];
  for (const e of t.members) {
    const change = edit(e.id);
    if (!change) {
      members.push(e);
      continue;
    }
    touched = true;
    const next = applyEdit(e, change);
    if (next) members.push(next);
  }
  if (!touched) return t;
  if (!members.some((e) => inSource(e.mailboxIds, source))) return null;
  return summarize({ ...t, count: t.count - (t.members.length - members.length) }, members, source);
}

/**
 * Part of an account with the own changes: conversations that leave the
 * view drop out of list, count and counters; read and
 * flagged change the counters of the segments. In the segment "Unread" or
 * "Flagged" a conversation stays until the next sync.
 * Counters and count came with their own stamps (`countSeq`, `totalSeq`): what
 * was confirmed before them they already know, even if the conversation
 * is older – that does not count again.
 */
export function editedPart(p: Part, edit: (id: Id, seq: number, until?: number) => EmailEdit | undefined): Part {
  let changed = false;
  const items = new Map<Id, ListThread>();
  const counts = { ...p.counts };
  let total = p.total;
  const shift = (s: Segment, was: boolean, now: boolean) => {
    const n = counts[s];
    if (was !== now && typeof n === 'number') counts[s] = Math.max(0, n + (now ? 1 : -1));
  };
  /** State that a value with the stamp `until` knows: with what was confirmed between loading and it. */
  const known = (t: ListThread, until: number) =>
    until > t.seq ? editedThread(t, p.source, (e) => edit(e, t.seq, until)) : t;
  for (const [id, t] of p.items) {
    const next = editedThread(t, p.source, (e) => edit(e, t.seq));
    if (next === t) {
      items.set(id, t);
      continue;
    }
    changed = true;
    if (next) items.set(id, next);
    const c = known(t, p.countSeq);
    shift('all', !!c, !!next);
    shift('unread', !!c?.unread, !!next?.unread);
    shift('flagged', !!c?.flagged, !!next?.flagged);
    if (!!known(t, p.totalSeq) !== !!next) total = Math.max(0, total + (next ? 1 : -1));
  }
  if (!changed) return p;
  // Ids without a loaded conversation (already gone on loading) stay as before.
  return { ...p, ids: p.ids.filter((id) => items.has(id) || !p.items.has(id)), items, total, counts };
}

/** Length of the preview of a waiting draft, as the server returns it (RFC 8621, 4.1.4: at most 256). */
const PREVIEW_LENGTH = 256;

/**
 * Row of a waiting draft in the `drafts` mailbox
 * of its account: it opens compose with the own key
 * (`/compose/<account>%2F~<key>`) and shows the state of the version.
 */
export function draftRow(d: QueuedDraft, drafts: Id): ListThread {
  const id = `${LOCAL_DRAFT}${d.key}`;
  const mailboxIds = [...new Set([drafts, ...d.email.mailboxIds])];
  const keywords: Record<string, true> = { ...d.email.keywords, $draft: true, $seen: true };
  return {
    key: `${d.account}/${id}`,
    account: d.account,
    id,
    threadId: id,
    receivedAt: d.at,
    from: [d.email.from],
    to: d.email.to,
    subject: d.email.subject,
    preview: d.email.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH),
    hasAttachment: d.email.attachments.length > 0,
    unread: false,
    flagged: !!keywords['$flagged'],
    count: 1,
    mailboxIds,
    members: [{ id, mailboxIds, keywords, from: d.email.from.email.toLowerCase() }],
    seq: 0,
  };
}

/** What own changes add to a part. */
export interface Added {
  /** Conversations that own changes put into a mailbox (`edits.carried()`), state before the changes. */
  rows: readonly ListThread[];
  /** Rows of waiting drafts of the account (`draftRow()`), only for "Drafts". */
  drafts: readonly ListThread[];
  /** Drafts that a waiting version replaces (`QueuedDraft.replace`, `moved`), as `<account>/<id>`. */
  replaced: ReadonlySet<string>;
}

/**
 * Conversations that own changes bring into the part: from `rows` those
 * whose emails only come into the view through them and which the server's
 * state (`raw`) does not already contain, plus the matching waiting
 * drafts; both in the list's segment. `hide`: rows whose drafts in
 * the view and in the segment are all replaced by waiting versions; `swap`: rows
 * whose representative draft one replaces, with the most recent remaining one.
 */
export function addedRows(
  raw: Part,
  added: Added,
  edit: (id: Id, seq: number) => EmailEdit | undefined,
  segment: Segment,
): RowChanges {
  if (!raw.loaded || (!added.rows.length && !added.drafts.length && !added.replaced.size))
    return { rows: [], hide: [], swap: [], stays: new Map() };
  const fits = (t: Pick<ListThread, 'unread' | 'flagged'>) =>
    segment === 'unread' ? t.unread : segment === 'flagged' ? t.flagged : true;
  const known = new Set([...raw.items.values()].map((t) => t.threadId));
  const rows: ListThread[] = [];
  for (const r of added.rows) {
    // If the conversation was already in the view, the changes lie over the server's row.
    if (known.has(r.threadId) || r.members.some((e) => inSource(e.mailboxIds, raw.source))) continue;
    // Unchanged it would not be in the view; changed and not `null`, it is now in it.
    const next = editedThread(r, raw.source, (id) => edit(id, r.seq));
    if (next && next !== r && fits(next)) rows.push(next);
  }
  for (const d of added.drafts) if (inSource(d.mailboxIds, raw.source) && fits(d)) rows.push(d);
  const { account } = raw.source;
  const replaced = (id: Id) => added.replaced.has(`${account}/${id}`);
  const inSegment = (s: Segment, e: ListEmail) =>
    s === 'unread' ? !e.keywords['$seen'] : s === 'flagged' ? !!e.keywords['$flagged'] : true;
  const hide: Id[] = [];
  const swap: Swap[] = [];
  const stays = new Map<Id, ReadonlySet<Segment>>();
  for (const t of raw.items.values()) {
    if (!replaced(t.id)) continue;
    // Remaining drafts of the conversation in the view, as they stand after the own changes
    // (deleted or moved ones do not count).
    const left = t.members.flatMap((e) => {
      const change = edit(e.id, t.seq);
      const now = change ? applyEdit(e, change) : e;
      return now && inSource(now.mailboxIds, raw.source) && !replaced(now.id) ? [now] : [];
    });
    // If the version does not replace all in the segment, the row stays for the most recent remaining one.
    const rest = left.filter((e) => inSegment(segment, e));
    if (rest.length) {
      // Read and flagged apply to the remaining drafts, without the replaced one (like `summarize`).
      swap.push({
        from: t.id,
        to: rest.at(-1)!.id,
        unread: left.some((e) => !e.keywords['$seen']),
        flagged: left.some((e) => !!e.keywords['$flagged']),
      });
      continue;
    }
    hide.push(t.id);
    // In the other segments the conversation stays as long as a remaining draft fits there.
    const still = new Set(SEGMENTS.filter((s) => left.some((e) => inSegment(s, e))));
    if (still.size) stays.set(t.id, still);
  }
  return { rows, hide, swap, stays };
}

/** New representative email of a row whose representative draft a waiting version replaces. */
export interface Swap {
  from: Id;
  to: Id;
  unread: boolean;
  flagged: boolean;
}

/** What `withRows()` changes in a part (`addedRows()`). */
export interface RowChanges {
  rows: readonly ListThread[];
  hide: readonly Id[];
  /** Representative email → new representative one of the same conversation, with its state. */
  swap: readonly Swap[];
  /** Segments in which a conversation from `hide` stays: their counters stay. */
  stays: ReadonlyMap<Id, ReadonlySet<Segment>>;
}

/**
 * Part with inserted rows (`addedRows()`) at their place in the
 * list's order; count and counters follow. A row from `swap`
 * stays at its place and opens the new representative email; preview and
 * attachment the list knows only from the old one and leaves them empty until the sync
 * (conversation, date and sender stay). Behind the last
 * loaded conversation of a part with further pages a row is missing
 * until it belongs there: the server's next page does not know it.
 * `bounded: false` skips this limit when the rows have already passed it
 * (part with own changes after the part of the order).
 */
export function withRows(p: Part, { rows, hide, swap, stays }: RowChanges, order: ListOrder, bounded = true): Part {
  if (!rows.length && !hide.length && !swap.length) return p;
  const cmp = compareThreads(order);
  const items = new Map(p.items);
  const counts = { ...p.counts };
  let total = p.total;
  const count = (t: ListThread, by: 1 | -1, keep?: ReadonlySet<Segment>) => {
    total = Math.max(0, total + by);
    for (const s of SEGMENTS) {
      const n = counts[s];
      if (typeof n === 'number' && !keep?.has(s) && (s === 'all' || (s === 'unread' ? t.unread : t.flagged)))
        counts[s] = Math.max(0, n + by);
    }
  };
  for (const id of hide) {
    const t = items.get(id);
    if (!t) continue;
    items.delete(id);
    count(t, -1, stays.get(id));
  }
  let ids = p.ids.filter((id) => !hide.includes(id));
  for (const { from, to, unread, flagged } of swap) {
    const t = items.get(from);
    if (!t || items.has(to)) continue;
    items.delete(from);
    items.set(to, { ...t, id: to, key: `${t.account}/${to}`, preview: '', hasAttachment: false, unread, flagged });
    ids = ids.map((id) => (id === from ? to : id));
    // If read or flagged drops out with the replaced draft, the counters of the segments follow.
    for (const [s, was, now] of [
      ['unread', t.unread, unread],
      ['flagged', t.flagged, flagged],
    ] as const) {
      const n = counts[s];
      if (typeof n === 'number' && was !== now) counts[s] = Math.max(0, n + (now ? 1 : -1));
    }
  }
  const loaded = ids.filter((id) => items.has(id));
  const last = loaded.length ? items.get(loaded.at(-1)!)! : null;
  for (const t of [...rows].sort(cmp)) {
    // No server page knows waiting drafts: they also stand behind the limit, otherwise nobody would find them.
    const local = t.id.startsWith(LOCAL_DRAFT);
    if (items.has(t.id) || (bounded && !local && !p.done && (!last || cmp(t, last) > 0))) continue;
    const at = ids.findIndex((id) => {
      const o = items.get(id);
      return !!o && cmp(t, o) < 0;
    });
    ids = at < 0 ? [...ids, t.id] : [...ids.slice(0, at), t.id, ...ids.slice(at)];
    items.set(t.id, t);
    count(t, 1);
  }
  return { ...p, ids, items, total, counts };
}

/** Emails for `ids` with their threads and their emails, in the same request. */
function addDetails(b: Batch, accountId: Id, ids: ResultReference | readonly Id[]) {
  const reps =
    'path' in ids
      ? b.call('Email/get', { accountId, '#ids': ids, properties: LIST_PROPS })
      : b.call('Email/get', { accountId, ids: [...ids], properties: LIST_PROPS });
  const threads = b.call('Thread/get', { accountId, '#ids': reps.ref('/list/*/threadId') });
  const members = b.call('Email/get', { accountId, '#ids': threads.ref('/list/*/emailIds'), properties: MEMBER_PROPS });
  return { reps, threads, members };
}

function readDetails(
  res: BatchResponse,
  calls: ReturnType<typeof addDetails>,
  account: string,
  source: ThreadSource,
): ListThread[] {
  const reps = res.get(calls.reps).list as Rep[];
  const threads = new Map(res.get(calls.threads).list.map((t) => [t.id, t.emailIds]));
  // Too many emails for one `Email/get` (`requestTooLarge`): then the representative one counts alone.
  const got = res.result(calls.members);
  const members = got.ok ? new Map((got.value.list as Member[]).map((e) => [e.id, e])) : null;
  return reps.map((rep) => threadOf(account, rep, threads.get(rep.threadId) ?? null, members, source));
}

/** Counters of the other segments (`limit` 1: only `total` counts). */
function addCounts(
  b: Batch,
  accountId: Id,
  source: ThreadSource,
  segments: readonly Segment[],
  skip: Segment,
): Map<Segment, Call<'Email/query'>> {
  return new Map(
    segments
      .filter((s) => s !== skip)
      .map((s) => [
        s,
        b.call('Email/query', {
          accountId,
          filter: sourceFilter(source, s),
          collapseThreads: true,
          limit: 1,
          calculateTotal: true,
        }),
      ]),
  );
}

function readCounts(res: BatchResponse, calls: Map<Segment, Call<'Email/query'>>): Partial<SegmentCounts> {
  return Object.fromEntries([...calls].map(([s, call]) => [s, res.get(call).total ?? null]));
}

/* eslint-enable svelte/prefer-svelte-reactivity */

/** Sorting of the query; by name, on ties the newest first. */
export function sortOf(order: ListOrder): EmailComparator[] {
  const date: EmailComparator = { property: 'receivedAt', isAscending: order.by === 'date' && order.ascending };
  return order.by === 'date' ? [date] : [{ property: order.by, isAscending: order.ascending }, date];
}

/** `ThreadApi` via the JMAP client per mail account. */
export function jmapThreadApi(clientOf: (account: string) => Promise<JmapClient>): ThreadApi {
  return {
    async page(request) {
      const { source, segment, order, position, anchor, limit, counts } = request;
      const client = await clientOf(source.account);
      const accountId = await client.accountId();
      const b = client.batch();
      const query = b.call('Email/query', {
        accountId,
        filter: sourceFilter(source, segment),
        sort: sortOf(order),
        collapseThreads: true,
        ...(anchor ? { anchor, anchorOffset: 1 } : { position }),
        limit,
        calculateTotal: true,
      });
      const details = addDetails(b, accountId, query.ref('/ids'));
      const countCalls = counts.length ? addCounts(b, accountId, source, counts, segment) : null;
      const res = await b.send();
      const found = res.result(query);
      // The last loaded email no longer represents its conversation (new reply, moved): from `position`.
      if (!found.ok && anchor && found.error.type === 'anchorNotFound')
        return this.page({ ...request, anchor: undefined });
      const q = res.get(query);
      return {
        ids: q.ids,
        threads: readDetails(res, details, source.account, source),
        total: q.total ?? null,
        queryState: q.queryState,
        emailState: res.get(details.reps).state,
        counts: { ...(countCalls ? readCounts(res, countCalls) : {}), [segment]: q.total ?? null },
      };
    },

    async changes({ source, segment, order, sinceQueryState, upToId, reload, counts }) {
      const client = await clientOf(source.account);
      const accountId = await client.accountId();
      const b = client.batch();
      const query = b.call('Email/queryChanges', {
        accountId,
        filter: sourceFilter(source, segment),
        sort: sortOf(order),
        collapseThreads: true,
        sinceQueryState,
        upToId,
        calculateTotal: true,
      });
      const details = addDetails(b, accountId, query.ref('/added/*/id'));
      const again = reload.length ? addDetails(b, accountId, reload) : null;
      const countCalls = addCounts(b, accountId, source, counts, segment);
      const res = await b.send();
      const c = res.result(query);
      if (!c.ok) {
        if (c.error.type === 'cannotCalculateChanges' || c.error.type === 'tooManyChanges') return { reset: true };
        throw c.error;
      }
      return {
        reset: false,
        removed: c.value.removed,
        added: c.value.added,
        threads: readDetails(res, details, source.account, source),
        reloaded: again ? readDetails(res, again, source.account, source) : [],
        total: c.value.total ?? null,
        queryState: c.value.newQueryState,
        counts: { ...readCounts(res, countCalls), [segment]: c.value.total ?? null },
      };
    },

    async emailChanges(account, since) {
      return emailChangesOf(await clientOf(account), since);
    },
  };
}

/** `Email/changes` with the threads of new and changed emails: for live sync and sync after storage. */
export async function emailChangesOf(client: JmapClient, since: string, signal?: AbortSignal): Promise<EmailChanges> {
  const accountId = await client.accountId(undefined, signal);
  const res = await changes(client, 'Email', {
    accountId,
    sinceState: since,
    fetch: true,
    properties: ['threadId'],
    ...(signal ? { signal } : {}),
  });
  if (res.reset) return res;
  return {
    reset: false,
    state: res.newState,
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- result, not state
    threads: new Set([...res.objects.values()].map((e) => e.threadId)),
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- result, not state
    destroyed: new Set(res.destroyed),
  };
}

/** State of an account in a list. */
export interface Part {
  source: ThreadSource;
  /** Representative emails in the server's order. */
  ids: Id[];
  items: ReadonlyMap<Id, ListThread>;
  total: number;
  counts: Partial<SegmentCounts>;
  /** Stamps of the load runs that brought `counts` or `total` (`edits`). */
  countSeq: number;
  totalSeq: number;
  /** `null`: unknown or changed between two pages – "Refresh" then reloads. */
  queryState: string | null;
  /** Up to here the part knows all changes to emails; `null`: unknown. */
  emailState: string | null;
  /** First page there. */
  loaded: boolean;
  /** No further pages. */
  done: boolean;
  error: unknown;
}

const emptyPart = (source: ThreadSource): Part => ({
  source,
  ids: [],
  items: new Map(),
  total: 0,
  counts: {},
  countSeq: 0,
  totalSeq: 0,
  queryState: null,
  emailState: null,
  loaded: false,
  done: false,
  error: null,
});

const collator = new Intl.Collator('de');

/** Name of the first address, otherwise the address, untruncated as with the server (RFC 8621, 4.4.2). */
const sortName = (a: EmailAddress | undefined): string => a?.name || a?.email || '';

/**
 * Order of two conversations like the query (`sortOf`). The
 * server's collation may differ for names; `mergeParts` therefore
 * keeps the order per account and only mixes between the accounts.
 */
export function compareThreads(order: ListOrder): (a: ListThread, b: ListThread) => number {
  const sign = order.ascending ? 1 : -1;
  const name = (t: ListThread) => sortName(order.by === 'to' ? t.to[0] : t.from[0]);
  return (a, b) =>
    (order.by === 'date'
      ? sign * (a.receivedAt - b.receivedAt)
      : sign * collator.compare(name(a), name(b)) || b.receivedAt - a.receivedAt) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const listOf = (p: Part): ListThread[] => p.ids.map((id) => p.items.get(id)).filter((t): t is ListThread => !!t);

/** Accounts whose next page is still missing (without an error). */
const open = (p: Part) => p.loaded && !p.done && !p.error && p.ids.length > 0;

/** Merging without waiting drafts: per account as from the server, stop at the limit of an account with further pages. */
function mergeLists(
  parts: readonly Part[],
  lists: readonly ListThread[][],
  cmp: (a: ListThread, b: ListThread) => number,
): { threads: ListThread[]; next: number } {
  const at = lists.map(() => 0);
  const threads: ListThread[] = [];
  for (;;) {
    let best = -1;
    for (const [i, list] of lists.entries()) {
      if (at[i]! < list.length) {
        if (best < 0 || cmp(list[at[i]!]!, lists[best]![at[best]!]!) < 0) best = i;
      } else if (list.length && open(parts[i]!)) return { threads, next: i };
    }
    // Everything merged; an open account without a loaded conversation (emails gone meanwhile) keeps loading.
    if (best < 0) return { threads, next: parts.findIndex(open) };
    threads.push(lists[best]![at[best]!++]!);
  }
}

/**
 * Conversations of all accounts in the order of the list: per account as from the
 * server, between the accounts by `compareThreads`. If an account has further
 * pages, the list ends at its last loaded conversation: what would come
 * afterwards could still stand before the others. Waiting drafts are
 * known to no server page: they set no limit and stand at their place,
 * behind the limit at the end. `next` is the account whose next page
 * extends the list (-1: none).
 */
export function mergeParts(parts: readonly Part[], order: ListOrder): { threads: ListThread[]; next: number } {
  const cmp = compareThreads(order);
  const local = (t: ListThread) => t.id.startsWith(LOCAL_DRAFT);
  const lists = parts.map(listOf);
  const merged = mergeLists(
    parts,
    lists.map((l) => l.filter((t) => !local(t))),
    cmp,
  );
  const drafts = lists.flatMap((l) => l.filter(local)).sort(cmp);
  if (!drafts.length) return merged;
  const threads: ListThread[] = [];
  let k = 0;
  for (const t of merged.threads) {
    while (k < drafts.length && cmp(drafts[k]!, t) < 0) threads.push(drafts[k++]!);
    threads.push(t);
  }
  return { threads: [...threads, ...drafts.slice(k)], next: merged.next };
}

const sum = (parts: readonly Part[], pick: (p: Part) => number | null | undefined): number | null =>
  parts.reduce<number | null>((n, p) => {
    const v = pick(p);
    return v === null || v === undefined ? n : (n ?? 0) + v;
  }, null);

/** Key of a part in storage: same mailboxes, same segment, same record. */
export const listKey = (source: ThreadSource, segment: Segment): string =>
  JSON.stringify([source.account, source.boxes, source.exclude, segment]);

/** Record of a part, truncated to `MAX_LIST_THREADS`. */
export function savedOf(p: Part, segment: Segment): SavedList {
  const ids = p.ids.slice(0, MAX_LIST_THREADS);
  return {
    key: listKey(p.source, segment),
    account: p.source.account,
    ids,
    threads: ids.flatMap((id) => p.items.get(id) ?? []),
    total: p.total,
    counts: p.counts,
    queryState: p.queryState,
    emailState: p.emailState,
    done: p.done && ids.length === p.ids.length,
  };
}

/**
 * Part from a record. If it belongs to another segment (`all`) or
 * the list shows a different sorting, the display arises here; the
 * states then do not fit and are missing, the sync reloads the first page.
 */
export function restoredPart(
  saved: SavedList,
  view: { segment: Segment; order: ListOrder; sorted: boolean; exact: boolean },
  seq: number,
): Partial<Part> {
  const stamped = saved.threads.map((t) => ({ ...t, seq }));
  const plain = view.exact && !view.sorted;
  const shown = view.exact
    ? stamped
    : stamped.filter((t) => (view.segment === 'unread' ? t.unread : view.segment === 'flagged' ? t.flagged : true));
  const list = view.sorted ? [...shown].sort(compareThreads(view.order)) : shown;
  return {
    ids: plain ? saved.ids : list.map((t) => t.id),
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- data, not state
    items: new Map(list.map((t) => [t.id, t])),
    total: view.exact ? saved.total : (saved.counts[view.segment] ?? list.length),
    counts: saved.counts,
    countSeq: seq,
    totalSeq: seq,
    queryState: plain ? saved.queryState : null,
    emailState: plain ? saved.emailState : null,
    loaded: true,
    done: saved.done,
    error: null,
  };
}

/** Access to storage; `null` without sign-in or in tests. */
type StoreOf = () => Pick<MailStore, 'list' | 'saveList' | 'dropEmails'> | null;

/** Mailbox "Drafts" of an account, if known. */
type DraftsOf = (account: string) => Id | null;

export interface ListOptions {
  store?: StoreOf;
  /** Sorted differently from the default: reads derived and does not write. */
  sorted?: boolean;
  /** For the rows of waiting drafts (`draftRow()`); without it the list shows none. */
  draftsOf?: DraftsOf;
}

/** List of a view in a segment; tasks run one after another. */
export class ThreadList {
  readonly sources: readonly ThreadSource[];
  readonly segment: Segment;
  readonly order: ListOrder;
  /** Segments of the view whose counters the list queries. */
  readonly segments: readonly Segment[];
  /** First page of all accounts; fails only if no account answers. */
  readonly ready: Promise<void>;

  #parts = $state.raw<Part[]>([]);
  readonly #api: ThreadApi;
  readonly #store: StoreOf;
  readonly #sorted: boolean;
  readonly #draftsOf: DraftsOf;
  #queue: Promise<unknown> = Promise.resolve();
  #more: Promise<void> | null = null;
  #disposed = false;
  /** Threads reported by the live sync per account until the next sync; `all` after `cannotCalculateChanges`. */
  // Not reactive: only for the next sync.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #touched = new Map<string, Set<Id> | 'all'>();
  /** State of the emails per account up to which `#touched` contains everything: the next successful sync takes it over. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #seen = new Map<string, string>();
  /** Accounts from storage whose `Email/changes` is still pending. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #behind = new Set<string>();
  /** Parts and conversations with the own changes, per state of parts, `edits` and drafts (not reactive). */
  #view: { key: readonly unknown[]; edited: { parts: Part[]; threads: ListThread[] } } | null = null;

  // Getter instead of `$derived`: the page creates lists in an effect, and derived values would otherwise belong
  // to this effect – reopened from the cache, they would stay stuck (`derived_inert`).

  /** Conversations in the order of the list. */
  get threads(): ListThread[] {
    return this.#edited().threads;
  }

  /** Subject of the conversation with this email, even if an own change is just taking it out of the display. */
  subjectOf(account: string, id: Id): string | null {
    return this.rowOf(account, id)?.subject ?? null;
  }

  /** Conversation with this email in the server's state, without own changes. */
  rowOf(account: string, id: Id): ListThread | null {
    for (const part of this.#parts) {
      if (part.source.account !== account) continue;
      for (const thread of part.items.values()) if (thread.members.some((e) => e.id === id)) return thread;
    }
    return null;
  }

  /** Conversations with these emails in the server's state (`edits.carried()`); per conversation the most recent in `into`. */
  rowsOf(account: string, ids: ReadonlySet<Id>, into: Map<Id, ListThread>): void {
    for (const part of this.#parts) {
      if (part.source.account !== account) continue;
      for (const thread of part.items.values()) {
        const known = into.get(thread.threadId);
        if (known && known.seq >= thread.seq) continue;
        if (thread.members.some((e) => ids.has(e.id))) into.set(thread.threadId, thread);
      }
    }
  }

  /** Hits in the segment across all accounts. */
  get total(): number {
    return sum(this.#edited().parts, (p) => (p.loaded ? p.total : null)) ?? 0;
  }

  get counts(): SegmentCounts {
    const { parts } = this.#edited();
    return {
      all: sum(parts, (p) => p.counts.all),
      unread: sum(parts, (p) => p.counts.unread),
      flagged: sum(parts, (p) => p.counts.flagged),
    };
  }

  get hasMore(): boolean {
    return this.#parts.some(open);
  }

  /** Accounts whose last request failed. */
  get failed(): string[] {
    return this.#parts.filter((p) => p.error).map((p) => p.source.account);
  }

  /** Error of the first failed account. */
  get failure(): unknown {
    return this.#parts.find((p) => p.error)?.error ?? null;
  }

  /** Not everything is loaded: an account would have further pages that are missing offline (`pf.foot`). */
  get truncated(): boolean {
    return this.#parts.some((p) => p.loaded && !p.done && !p.source.frozen && p.ids.length > 0);
  }

  /** `loading` until the first response of all accounts, `error` if none answered. */
  get status(): 'loading' | 'ready' | 'error' {
    if (this.#parts.some((p) => !p.loaded && !p.error)) return 'loading';
    return this.#parts.length && this.#parts.every((p) => !p.loaded) ? 'error' : 'ready';
  }

  constructor(
    api: ThreadApi,
    sources: readonly ThreadSource[],
    segment: Segment,
    order: ListOrder,
    segments: readonly Segment[] = SEGMENTS,
    { store = () => null, sorted = false, draftsOf = () => null }: ListOptions = {},
  ) {
    this.#api = api;
    this.#store = store;
    this.#sorted = sorted;
    this.#draftsOf = draftsOf;
    this.sources = sources;
    this.segment = segment;
    this.order = order;
    this.segments = segments;
    this.#parts = sources.map(emptyPart);
    this.ready = this.#enqueue(async () => {
      await Promise.all(this.#parts.map((_, i) => this.#start(i)));
      const failed = this.#parts.find((p) => !p.loaded);
      if (!this.#disposed && failed && this.#parts.every((p) => !p.loaded)) throw failed.error as Error;
    });
    // Parts from storage catch up as soon as they stand; the list does not wait for it.
    void this.#enqueue(() =>
      Promise.all(this.#parts.map(async (p, i) => (this.#behind.has(p.source.account) ? await this.#sync(i) : 0))),
    );
  }

  /** Loads the next page of the account at whose last conversation the list ends. */
  loadMore(): Promise<void> {
    if (this.#more) return this.#more;
    const run: Promise<void> = this.#enqueue(async () => {
      // The account at which the list ends – by the server's order, not by `compareThreads`.
      const i = mergeParts(this.#parts, this.order).next;
      const p = this.#parts[i];
      if (!p) return;
      try {
        const seq = stamp();
        const res = await this.#api.page({
          ...this.#request(p),
          position: p.ids.length,
          anchor: p.ids.at(-1),
          limit: PAGE_SIZE,
          counts: [],
        });
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
        const known = new Set(p.ids);
        const ids = [...p.ids, ...res.ids.filter((id) => !known.has(id))];
        // Free before changing: the list asks right afterwards whether it should keep loading.
        if (this.#more === run) this.#more = null;
        this.#update(i, {
          ids,
          // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
          items: new Map([...p.items, ...res.threads.map((t) => [t.id, { ...t, seq }] as const)]),
          total: res.total ?? ids.length,
          totalSeq: seq,
          // If the list changed between the pages, the loaded ones no longer fit one state.
          queryState: res.queryState === p.queryState ? p.queryState : null,
          done: res.ids.length < PAGE_SIZE || (res.total !== null && ids.length >= res.total),
        });
        this.#save(i);
      } catch (error) {
        this.#update(i, { error });
        throw error;
      }
    });
    this.#more = run;
    const free = () => {
      if (this.#more === run) this.#more = null;
    };
    run.then(free, free);
    return run;
  }

  /** Remembers changes of the live sync for the next sync (`refresh()`). */
  touch(change: EmailChange): void {
    for (const p of this.#parts) if (p.source.account === change.account) this.#note(p, change);
  }

  #note(p: Part, change: Pick<EmailChange, 'reset' | 'threads' | 'state'>): void {
    const { account } = p.source;
    // Without a loaded page (still loading, error) reload the first page: a running request may not know the change.
    if (change.reset || !p.loaded) {
      this.#remember(account, 'all');
      return;
    }
    if (change.state !== undefined) this.#seen.set(account, change.state);
    // Only threads the list shows; the sync queries others via `queryChanges`.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const loaded = new Set([...p.items.values()].map((t) => t.threadId));
    const hit = [...change.threads].filter((t) => loaded.has(t));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    if (hit.length) this.#remember(account, new Set(hit));
  }

  #remember(account: string, threads: ReadonlySet<Id> | 'all'): void {
    const known = this.#touched.get(account);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive, only for the next sync
    this.#touched.set(account, threads === 'all' || known === 'all' ? 'all' : new Set([...(known ?? []), ...threads]));
  }

  /**
   * Syncs with `Email/queryChanges` (up to the last loaded
   * conversation) and refetches in the same request the loaded conversations
   * that the live sync reported as changed; without a state or on
   * `cannotCalculateChanges` it reloads the first page. With `account` only
   * this account. Accounts with an error try again.
   */
  refresh(account?: string): Promise<{ added: number; failed: number }> {
    return this.#enqueue(async () => {
      const added = await Promise.all(
        this.#parts.map(async (p, i) =>
          account === undefined || p.source.account === account ? await this.#sync(i) : 0,
        ),
      );
      return { added: added.reduce((a, b) => a + b, 0), failed: this.#parts.filter((p) => p.error).length };
    });
  }

  /** Sync of a part; errors stay with the account. Returns the newly added ones. */
  async #sync(i: number): Promise<number> {
    const { source } = this.#parts[i]!;
    const { account } = source;
    if (source.frozen) return 0;
    if (this.#behind.has(account)) {
      try {
        await this.#catchUp(i);
      } catch (error) {
        if (isOffline(error)) {
          this.#update(i, { error });
          return 0;
        }
        // The server rejects the stored state: retrying would not help, the first page applies anew.
        this.#behind.delete(account);
        this.#remember(account, 'all');
      }
    }
    const p = this.#parts[i]!;
    const touched = this.#touched.get(account);
    this.#touched.delete(account);
    // Read before the request: whatever is reported afterwards belongs to the next sync.
    const seen = this.#seen.get(account);
    const reload =
      touched && touched !== 'all' ? p.ids.filter((id) => touched.has(p.items.get(id)?.threadId ?? '')) : [];
    try {
      const seq = stamp();
      // Refetching more than one page would be too large for one `Email/get` (`maxObjectsInGet`): reload the first page.
      const res =
        p.queryState && touched !== 'all' && reload.length <= PAGE_SIZE
          ? await this.#api.changes({
              ...this.#request(p),
              sinceQueryState: p.queryState,
              upToId: p.ids.at(-1) ?? null,
              reload,
              counts: this.segments,
            })
          : ({ reset: true } as const);
      // Only the first page: all loaded ones in one request would be too large for long lists.
      if (res.reset) return await this.#first(i, true);
      const ids = applyQueryChanges(p.ids, res);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
      const keep = new Set(ids);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
      const items = new Map([...p.items].filter(([id]) => keep.has(id)));
      for (const t of [...res.reloaded, ...res.threads]) if (keep.has(t.id)) items.set(t.id, { ...t, seq });
      this.#update(i, {
        ids,
        items,
        total: res.total ?? Math.max(ids.length, p.total),
        counts: res.counts,
        countSeq: seq,
        totalSeq: seq,
        queryState: res.queryState,
        emailState: seen ?? p.emailState,
        loaded: true,
        done: res.total === null ? p.done : ids.length >= res.total,
        error: null,
      });
      this.#save(i);
      return res.added.filter((a) => !p.items.has(a.id) && keep.has(a.id)).length;
    } catch (error) {
      // Reported threads still apply until a sync succeeds.
      if (touched) this.#remember(account, touched);
      this.#update(i, { error });
      return 0;
    }
  }

  /**
   * Started from storage: what happened since the record is reported by
   * `Email/changes`, as the live sync does otherwise. `Email/queryChanges` alone does not show
   * read and flagged.
   */
  async #catchUp(i: number): Promise<void> {
    const p = this.#parts[i]!;
    const { account } = p.source;
    const res = p.emailState ? await this.#api.emailChanges(account, p.emailState) : ({ reset: true } as const);
    this.#behind.delete(account);
    // The live sync starts at the current state: what disappeared while the app was closed is only reported by this response.
    if (!res.reset && res.destroyed.size) this.#store()?.dropEmails(account, res.destroyed);
    this.#note(p, res.reset ? { reset: true, threads: new Set() } : { ...res, reset: false }); // eslint-disable-line svelte/prefer-svelte-reactivity -- report, not state
  }

  /** No longer needed: later responses expire. */
  dispose(): void {
    this.#disposed = true;
  }

  /** First state of a part: from storage, otherwise the first page; an account without access stays empty. */
  async #start(i: number): Promise<void> {
    const { source } = this.#parts[i]!;
    const restored = await this.#restore(i);
    if (restored && !source.frozen) this.#behind.add(source.account);
    else if (source.frozen) this.#update(i, { loaded: true, done: true });
    else await this.#first(i);
  }

  /** Restores the part from storage if there is a matching record. */
  async #restore(i: number): Promise<boolean> {
    const store = this.#store();
    if (!store) return false;
    const { source } = this.#parts[i]!;
    const own = await store.list(listKey(source, this.segment));
    const saved = own ?? (this.segment === 'all' ? null : await store.list(listKey(source, 'all')));
    if (!saved || this.#disposed) return false;
    const { segment, order } = this;
    this.#update(i, restoredPart(saved, { segment, order, sorted: this.#sorted, exact: !!own }, stamp()));
    return true;
  }

  /** Writes the server's state; own changes (`edits`) do not belong to it. */
  #save(i: number): void {
    const p = this.#parts[i]!;
    if (this.#disposed || this.#sorted || p.source.frozen) return;
    this.#store()?.saveList(savedOf(p, this.segment));
  }

  /** Newly added ones on reload; first page: the error stays with the account. */
  async #first(i: number, rethrow = false): Promise<number> {
    const limit = PAGE_SIZE;
    const p = this.#parts[i]!;
    try {
      const seq = stamp();
      const res = await this.#api.page({ ...this.#request(p), position: 0, limit, counts: this.segments });
      this.#update(i, {
        ids: res.ids,
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
        items: new Map(res.threads.map((t) => [t.id, { ...t, seq }])),
        total: res.total ?? res.ids.length,
        counts: res.counts,
        countSeq: seq,
        totalSeq: seq,
        queryState: res.queryState,
        emailState: res.emailState,
        loaded: true,
        done: res.ids.length < limit || (res.total !== null && res.ids.length >= res.total),
        error: null,
      });
      this.#save(i);
      return p.loaded ? res.ids.filter((id) => !p.items.has(id)).length : 0;
    } catch (error) {
      this.#update(i, { error });
      if (rethrow) throw error;
      return 0;
    }
  }

  /**
   * Parts with the own changes that still apply to their conversations
   * (`edits`), including the rows they add, and the
   * conversations in the order of the list. The order comes from the
   * parts without changes, only with the added rows: an account whose
   * loaded conversations are all gone thus stays the limit until it
   * loads more (changes touch neither date nor names).
   */
  #edited(): { parts: Part[]; threads: ListThread[] } {
    const parts = this.#parts;
    const queued = edits.queue.drafts;
    const boxes = parts.map((p) => this.#draftsOf(p.source.account));
    const key = [parts, edits.version, queued, ...boxes];
    if (this.#view?.key.length === key.length && this.#view.key.every((k, i) => k === key[i])) return this.#view.edited;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const replaced = new Set(
      queued.flatMap((d) => [d.replace, d.moved].flatMap((r) => (r ? [`${r.account}/${r.id}`] : []))),
    );
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const none = new Set<string>();
    const order: Part[] = [];
    const out = parts.map((p, i) => {
      const { account } = p.source;
      const box = boxes[i];
      // Only "Drafts": in other lists a row opens the reading view, which does not know the draft.
      const drafts = !!box && p.source.boxes.includes(box);
      const added = addedRows(
        p,
        {
          rows: edits.carried(account, p.totalSeq),
          drafts: drafts ? queued.filter((d) => d.account === account).map((d) => draftRow(d, box)) : [],
          replaced: drafts ? replaced : none,
        },
        (id, seq) => edits.edit(account, id, seq),
        this.segment,
      );
      // The limit comes from the server's rows: a hidden one stays in the order and is only missing from the display.
      const ordered = withRows(p, { ...added, hide: [] }, this.order);
      order.push(ordered);
      let oldest = Infinity;
      for (const t of p.items.values()) oldest = Math.min(oldest, t.seq);
      const own =
        oldest === Infinity || !edits.pending(account, oldest)
          ? p
          : editedPart(p, (id, seq, until) => edits.edit(account, id, seq, until));
      // The same rows as in the order, otherwise one would silently drop out at a moved limit.
      const shown = { ...added, rows: added.rows.filter((t) => ordered.items.get(t.id) === t) };
      return withRows(own, shown, this.order, false);
    });
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local mapping, not state
    const byAccount = new Map(out.map((p) => [p.source.account, p.items]));
    const threads = mergeParts(order, this.order).threads.flatMap((t) => {
      const shown = byAccount.get(t.account)?.get(t.id);
      return shown ? [shown] : [];
    });
    const edited = { parts: out, threads };
    this.#view = { key, edited };
    return edited;
  }

  #request(p: Part) {
    return { source: p.source, segment: this.segment, order: this.order };
  }

  #update(i: number, patch: Partial<Part>): void {
    if (this.#disposed) return;
    this.#parts = this.#parts.map((p, j) => (j === i ? { ...p, ...patch } : p));
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Lists per view and segment, the most recently opened in memory. */
export class Threads {
  readonly #api: ThreadApi;
  readonly #store: StoreOf;
  readonly #draftsOf: DraftsOf;
  // Not reactive: cache; the page holds the open list itself.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #lists = new Map<string, ThreadList>();
  /** Key of the most recently opened sorted list. */
  #sorted: string | null = null;
  /** Lists a page currently shows (`show()`): the live sync syncs them immediately. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #shown = new Set<ThreadList>();

  constructor(
    api: ThreadApi = jmapThreadApi((account) => accounts.client(account)),
    store: StoreOf = () => session.mailStore,
    draftsOf: DraftsOf = (account) => mailboxes.role(account, 'drafts')?.id ?? null,
  ) {
    this.#api = api;
    this.#store = store;
    this.#draftsOf = draftsOf;
  }

  /**
   * List of the view; `cached` if it already lay in memory (then
   * "Refresh" is worth it). Sorted lists (`sorted`: compact differing from the
   * default) share one slot: a new one evicts the
   * previous one instead of the lists of other mailboxes.
   */
  open(
    sources: readonly ThreadSource[],
    segment: Segment,
    order: ListOrder,
    segments: readonly Segment[] = SEGMENTS,
    sorted = false,
  ): { list: ThreadList; cached: boolean } {
    const key = JSON.stringify([sources, segment, order, segments]);
    const known = this.#lists.get(key);
    if (known) {
      // Most recently opened to the end.
      this.#lists.delete(key);
      this.#lists.set(key, known);
      return { list: known, cached: true };
    }
    const list = new ThreadList(this.#api, sources, segment, order, segments, {
      store: this.#store,
      sorted,
      draftsOf: this.#draftsOf,
    });
    if (sorted) {
      if (this.#sorted !== null) {
        this.#lists.get(this.#sorted)?.dispose();
        this.#lists.delete(this.#sorted);
      }
      this.#sorted = key;
    }
    this.#lists.set(key, list);
    for (const [k, l] of this.#lists) {
      if (this.#lists.size <= CACHE_SIZE) break;
      l.dispose();
      this.#lists.delete(k);
    }
    return { list, cached: false };
  }

  /** The page shows `list` until it calls the return value (cleanup of its effect). */
  show(list: ThreadList): () => void {
    this.#shown.add(list);
    return () => this.#shown.delete(list);
  }

  /**
   * Changes of the live sync: all lists in memory remember them for
   * their next sync (back in a list), displayed ones sync
   * immediately. Errors stay silent, the next sync tries again.
   */
  async touch(change: EmailChange): Promise<void> {
    const shown: ThreadList[] = [];
    for (const list of this.#lists.values()) {
      list.touch(change);
      if (this.#shown.has(list) && list.sources.some((s) => s.account === change.account)) shown.push(list);
    }
    // `refresh()` does not fail, errors stand at the list's account.
    await Promise.all(shown.map((l) => l.refresh(change.account)));
  }

  /**
   * The account answers again: displayed lists with an error on it catch up,
   * even without anything having changed. Stays silent.
   */
  async resume(account: string): Promise<void> {
    await Promise.all([...this.#shown].filter((l) => l.failed.includes(account)).map((l) => l.refresh(account)));
  }

  /** Discards the lists in which an account takes part that is no longer in `accounts`. */
  retain(accounts: readonly string[]): void {
    for (const [key, list] of this.#lists)
      if (list.sources.some((s) => !accounts.includes(s.account))) {
        list.dispose();
        this.#lists.delete(key);
      }
  }

  /** Subject of the conversation with this email if a list in memory knows it. */
  subjectOf(account: string, id: Id): string | null {
    return this.rowOf(account, id)?.subject ?? null;
  }

  /** Conversation with this email in the most recent server state that a list in memory knows. */
  rowOf(account: string, id: Id): ListThread | null {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    return this.rowsOf(account, new Set([id]))[0] ?? null;
  }

  /** Conversations with these emails, per conversation the most recent across all lists in memory, in one run. */
  rowsOf(account: string, ids: ReadonlySet<Id>): ListThread[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local mapping, not state
    const into = new Map<Id, ListThread>();
    for (const list of this.#lists.values()) list.rowsOf(account, ids, into);
    return [...into.values()];
  }

  /** Sign-out: discard everything. */
  reset(): void {
    for (const list of this.#lists.values()) list.dispose();
    this.#lists.clear();
  }
}

export const threads = new Threads();

edits.describe((account, id) => threads.subjectOf(account, id));
edits.carry((account, ids) => threads.rowsOf(account, ids));
