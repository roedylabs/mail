/**
 * Search filters: the model, the operators in the search text and their
 * combination with the filters, the query per mail account for `Email/query`
 * (RFC 8621 › 4.4.1), the chips, the quick filters and the "Quick access"
 * tiles. Pure, without state: mail accounts, folders and tags come in via
 * `FilterEnv`.
 */
import type { EmailFilter, Filter, Id } from '@roedy/jmap';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { ROLE_IDS, type RoleId } from '#lib/routes.ts';
import { catLabel, norm, type SearchCat, type Terms } from '#lib/search.ts';
import { zoneDayStart, zoneParts, zoneTime } from '#lib/timezone.ts';

/** Time ranges. */
export const SF_TIMES = ['any', 'today', '7d', '30d', 'year'] as const;
export type SfTime = (typeof SF_TIMES)[number];

/** Status: unread, flagged, with attachment. */
export const SF_STATES = ['u', 'st', 'at'] as const;
export type SfState = (typeof SF_STATES)[number];

/** Fields for "Search in": subject, sender, text, attachments. */
export const SF_FIELDS = ['s', 'from', 'body', 'att'] as const;
export type SfField = (typeof SF_FIELDS)[number];

/**
 * Folder in the filter: a mailbox of the sidebar in all accounts
 * (`role:inbox`) or a custom folder of an account with its subfolders
 * (`box:‹account›:‹mailbox›`).
 */
export type FolderKey = `role:${RoleId}` | `box:${string}:${Id}`;

export function folderKey(account: string, id: Id): FolderKey {
  return `box:${account}:${id}`;
}

/** Parts of a folder key; `null` for a foreign value. */
export function parseFolderKey(key: string): { role: RoleId } | { account: string; id: Id } | null {
  if (key.startsWith('role:')) {
    const role = key.slice(5) as RoleId;
    return ROLE_IDS.includes(role) ? { role } : null;
  }
  const hit = /^box:([^:]+):(.+)$/.exec(key);
  return hit ? { account: hit[1]!, id: hit[2]! } : null;
}

export interface SearchFilter {
  /** Categories; empty = all. */
  cats: SearchCat[];
  /** Mail account; `null` = all. */
  account: string | null;
  folder: FolderKey | null;
  /** Tags with their subtags. */
  tags: string[];
  st: SfState[];
  time: SfTime;
  /** Sender, as entered. */
  from: string;
  /** "Search in"; empty = all fields. */
  fields: SfField[];
}

/** No filters. */
export const SF0: SearchFilter = {
  cats: [],
  account: null,
  folder: null,
  tags: [],
  st: [],
  time: 'any',
  from: '',
  fields: [],
};

// --- Operators in the search text ---

/** Operators; values as entered, without the operator. */
export interface QueryOps {
  from: string | null;
  in: string | null;
  tag: string | null;
  account: string | null;
  type: string | null;
  /** `x`: unknown status (`is:…`), matches nothing. */
  st: (SfState | 'x')[];
}

const OP = /^(from|in|tag|is|has|account|type):(.+)$/i;

/** `is:`: unread, flagged/starred, attachment; otherwise nothing. */
function stateOf(value: string): SfState | 'x' {
  const v = norm(value);
  if (/^unread/.test(v)) return 'u';
  if (/^(star|flag)/.test(v)) return 'st';
  if (/^att/.test(v)) return 'at';
  return 'x';
}

/** Split the search text into words and operators; the last operator of a kind wins. */
export function parseQuery(q: string): { terms: Terms; ops: QueryOps } {
  const ops: QueryOps = { from: null, in: null, tag: null, account: null, type: null, st: [] };
  const raw: string[] = [];
  for (const word of q.split(/\s+/).filter(Boolean)) {
    const hit = OP.exec(word);
    if (!hit) {
      raw.push(word.toLowerCase());
      continue;
    }
    const k = hit[1]!.toLowerCase();
    const v = hit[2]!;
    if (k === 'from') ops.from = v;
    else if (k === 'in') ops.in = v;
    else if (k === 'tag') ops.tag = v;
    else if (k === 'account') ops.account = v;
    else if (k === 'type') ops.type = v;
    else if (k === 'has') ops.st.push('at');
    else ops.st.push(stateOf(v));
  }
  return { terms: { raw, terms: raw.map(norm) }, ops };
}

// --- Effective filters and query per account ---

/** Folders to choose from: mailboxes of the sidebar, then custom folders per account. */
export interface FolderOption {
  key: FolderKey;
  label: string;
  /** Mailbox of the sidebar (`role:…`): its icon. */
  icon?: IconName;
  /** Custom folder: names of the parents (indentation and tooltip "‹account› › … › ‹name›"). */
  path?: readonly string[];
}

export interface TagOption {
  id: string;
  label: string;
  /** Index in the mail account colour palette. */
  color?: number;
  /** Names of the parent tags; empty on the top level. */
  path?: readonly string[];
}

export interface FilterEnv {
  /** Ready mail accounts of the search, with the colour as an index in the mail account colour palette. */
  accounts: readonly { id: string; email: string; color?: number }[];
  /** Categories to choose from, for `type:`. */
  allowed: readonly SearchCat[];
  /** Folders in the order of the sidebar, for `in:` and the chips. */
  folders: readonly FolderOption[];
  /** Tags in the order of the tag list, for `tag:` and the chips. */
  tags: readonly TagOption[];
  /** Mailboxes of a folder with subfolders in an account; empty if the account does not have it. */
  folderBoxes: (key: FolderKey, account: string) => Id[];
  /** Mailboxes of a tag with subtags in an account; empty if the account has none. */
  tagBoxes: (tag: string, account: string) => Id[];
  /** Time zone for "Today" and "This year" (Settings › Language & region). */
  tz: string;
}

export interface AccountQuery {
  account: string;
  filter: Filter<EmailFilter> | null;
}

export interface Effective {
  /** Search words without operators. */
  terms: Terms;
  /** Categories after `type:`. */
  cats: SearchCat[];
  /** A filter for messages is set: categories only messages, attachments and the chosen ones. */
  mailF: boolean;
  /** "Search in"; empty = all fields. */
  fields: SfField[];
  /** Query per account; without accounts that cannot find anything (unknown operator, folder missing). */
  queries: AccountQuery[];
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `UTCDate` per RFC 8620 › 1.4: without fractional seconds. */
export function utcDate(t: number): string {
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Start of the time range; `null` = any. To the minute so that the query stays stable. */
export function timeAfter(time: SfTime, now: number, tz: string): number | null {
  const t = Math.floor(now / MINUTE) * MINUTE;
  if (time === 'today') return zoneDayStart(t, tz);
  if (time === '7d') return t - 7 * DAY;
  if (time === '30d') return t - 30 * DAY;
  if (time === 'year') return zoneTime(zoneParts(t, tz).y, 1, 1, 0, 0, tz);
  return null;
}

const anyOf = (list: Filter<EmailFilter>[]): Filter<EmailFilter> =>
  list.length === 1 ? list[0]! : { operator: 'OR', conditions: list };

const allOf = (list: Filter<EmailFilter>[]): Filter<EmailFilter> | null =>
  list.length === 0 ? null : list.length === 1 ? list[0]! : { operator: 'AND', conditions: list };

/**
 * A word in the fields of "Search in": without a selection `text` (all
 * fields), otherwise per field `subject`, `from`, `body`; `Email/query` does
 * not know attachments individually, hence `text` on emails with attachment.
 */
function wordFilter(word: string, fields: readonly SfField[]): Filter<EmailFilter> {
  if (!fields.length) return { text: word };
  return anyOf(
    SF_FIELDS.filter((f) => fields.includes(f)).map((f) =>
      f === 's'
        ? { subject: word }
        : f === 'from'
          ? { from: word }
          : f === 'body'
            ? { body: word }
            : { operator: 'AND', conditions: [{ hasAttachment: true }, { text: word }] },
    ),
  );
}

const ST_FILTER: Record<SfState, EmailFilter> = {
  u: { notKeyword: '$seen' },
  st: { hasKeyword: '$flagged' },
  at: { hasAttachment: true },
};

/** First entry whose label starts with the value (`startsWith` in comparison form). */
const byPrefix = <T>(list: readonly T[], label: (x: T) => string, value: string): T | undefined => {
  const v = norm(value);
  return list.find((x) => norm(label(x)).startsWith(v));
};

/** Filters and operators combined, and the query per account. */
export function effective(sf: SearchFilter, q: string, env: FilterEnv, now: number): Effective {
  const { terms, ops } = parseQuery(q);
  // An operator without a match (unknown account, folder, tag or status) lets no message through.
  let none = ops.st.includes('x');

  let accounts = env.accounts.map((a) => a.id);
  let account = sf.account;
  if (ops.account) {
    const v = norm(ops.account);
    account = env.accounts.find((a) => norm(a.email).includes(v))?.id ?? null;
    if (!account) none = true;
  }
  if (account) accounts = accounts.filter((a) => a === account);

  // `in:` means all folders of that name, including custom folders of the same name in several accounts.
  let folders: FolderKey[] = sf.folder ? [sf.folder] : [];
  if (ops.in) {
    const hit = byPrefix(env.folders, (f) => f.label, ops.in);
    folders = hit ? env.folders.filter((f) => f.label === hit.label).map((f) => f.key) : [];
    if (!hit) none = true;
  }

  const tags = [...sf.tags];
  if (ops.tag) {
    const tag = byPrefix(env.tags, (t) => t.label, ops.tag);
    if (tag) tags.push(tag.id);
    else none = true;
  }

  const st = [...new Set([...sf.st, ...ops.st])].filter((s): s is SfState => s !== 'x');
  const from = (ops.from ?? sf.from).trim();
  let cats = sf.cats;
  if (ops.type) {
    const cat = byPrefix(env.allowed, catLabel, ops.type);
    if (cat) cats = [cat];
  }
  const after = timeAfter(sf.time, now, env.tz);
  const mailF =
    none ||
    !!account ||
    folders.length > 0 ||
    tags.length > 0 ||
    st.length > 0 ||
    after != null ||
    !!from ||
    sf.fields.length > 0;

  const queries: AccountQuery[] = [];
  if (!none) {
    for (const a of accounts) {
      const conditions: Filter<EmailFilter>[] = terms.raw.map((w) => wordFilter(w, sf.fields));
      if (from) conditions.push({ from });
      if (folders.length) {
        const boxes = [...new Set(folders.flatMap((f) => env.folderBoxes(f, a)))];
        if (!boxes.length) continue;
        conditions.push(anyOf(boxes.map((id) => ({ inMailbox: id }))));
      }
      if (tags.length) {
        const boxes = [...new Set(tags.flatMap((t) => env.tagBoxes(t, a)))];
        if (!boxes.length) continue;
        conditions.push(anyOf(boxes.map((id) => ({ inMailbox: id }))));
      }
      for (const s of st) conditions.push(ST_FILTER[s]);
      if (after != null) conditions.push({ after: utcDate(after) });
      queries.push({ account: a, filter: allOf(conditions) });
    }
  }
  return { terms, cats, mailF, fields: sf.fields, queries };
}

// --- Chips, quick filters, tiles ---

export const timeLabel = (time: SfTime): string =>
  ({
    any: m.search_time_any,
    today: m.search_time_today,
    '7d': m.search_time_7d,
    '30d': m.search_time_30d,
    year: m.search_time_year,
  })[time]();

export const stateLabel = (st: SfState): string =>
  ({ u: m.search_st_unread, st: m.search_st_flagged, at: m.search_st_attachment })[st]();

export const fieldLabel = (field: SfField): string =>
  ({ s: m.search_field_subject, from: m.search_field_from, body: m.search_field_body, att: m.search_field_files })[
    field
  ]();

export const STATE_ICON: Record<SfState, IconName> = { u: 'ti-mail', st: 'ti-star', at: 'ti-paperclip' };

export type FilterPatch = Partial<SearchFilter> | ((sf: SearchFilter) => Partial<SearchFilter>);

export interface FilterChip {
  /** `cat:mail`, `account`, `folder`, `tag:‹id›`, `st:u`, `time:7d`, `from`, `fields`. */
  key: string;
  label: string;
  /** Category chip: not on the desktop, the pills show it there. */
  cat: boolean;
  aria: string;
  remove: (event?: Event) => void;
}

/** Names for the chips; without a name (e.g. an account that is currently missing) the value itself. */
export interface FilterNames {
  email: (account: string) => string | null;
  folder: (key: FolderKey) => string | null;
  tag: (id: string) => string | null;
}

/** One chip per filter. */
export function filterChips(sf: SearchFilter, names: FilterNames, set: (patch: FilterPatch) => void): FilterChip[] {
  const out: { key: string; label: string; cat?: boolean; patch: FilterPatch }[] = [];
  for (const c of sf.cats)
    out.push({
      key: `cat:${c}`,
      label: m.search_chip_cat({ cat: catLabel(c) }),
      cat: true,
      patch: (x) => ({ cats: x.cats.filter((y) => y !== c) }),
    });
  if (sf.account)
    out.push({
      key: 'account',
      label: m.search_chip_account({ email: names.email(sf.account) ?? sf.account }),
      patch: { account: null },
    });
  if (sf.folder)
    out.push({
      key: 'folder',
      label: m.search_chip_folder({ folder: names.folder(sf.folder) ?? sf.folder }),
      patch: { folder: null },
    });
  for (const id of sf.tags)
    out.push({
      key: `tag:${id}`,
      label: m.search_chip_tag({ tag: names.tag(id) ?? id }),
      patch: (x) => ({ tags: x.tags.filter((y) => y !== id) }),
    });
  for (const s of sf.st)
    out.push({ key: `st:${s}`, label: stateLabel(s), patch: (x) => ({ st: x.st.filter((y) => y !== s) }) });
  if (sf.time !== 'any')
    out.push({
      key: `time:${sf.time}`,
      label: m.search_chip_time({ time: timeLabel(sf.time) }),
      patch: { time: 'any' },
    });
  if (sf.from.trim())
    out.push({ key: 'from', label: m.search_chip_from({ from: sf.from.trim() }), patch: { from: '' } });
  if (sf.fields.length)
    out.push({
      key: 'fields',
      label: m.search_chip_fields({ fields: sf.fields.map(fieldLabel).join(', ') }),
      patch: { fields: [] },
    });
  return out.map((c) => ({
    key: c.key,
    label: c.label,
    cat: !!c.cat,
    aria: m.search_chip_remove({ label: c.label }),
    remove: (event?: Event) => {
      event?.stopPropagation();
      set(c.patch);
    },
  }));
}

export interface QuickFilter {
  key: string;
  label: string;
  icon: IconName;
  on: boolean;
  onClick: () => void;
}

/** Quick filters on mobile: status and "Today", "Last 7 days" to toggle. */
export function quickFilters(sf: SearchFilter, set: (patch: FilterPatch) => void): QuickFilter[] {
  const toggleTime = (time: SfTime) => () => set((x) => ({ time: x.time === time ? 'any' : time }));
  return [
    ...SF_STATES.map((s) => ({
      key: `st:${s}`,
      label: stateLabel(s),
      icon: STATE_ICON[s],
      on: sf.st.includes(s),
      onClick: () => set((x) => ({ st: x.st.includes(s) ? x.st.filter((y) => y !== s) : [...x.st, s] })),
    })),
    {
      key: 'time:today',
      label: m.search_time_today(),
      icon: 'ti-calendar-event',
      on: sf.time === 'today',
      onClick: toggleTime('today'),
    },
    {
      key: 'time:7d',
      label: m.search_quick_7d(),
      icon: 'ti-calendar-week',
      on: sf.time === '7d',
      onClick: toggleTime('7d'),
    },
  ];
}

/** Chips that the quick filters already show. */
export const QUICK_KEYS: ReadonlySet<string> = new Set(['st:u', 'st:st', 'st:at', 'time:today', 'time:7d']);

/**
 * On mobile next to the quick filters: all chips except those a quick filter
 * shows, and without the categories (the pills and "Category" in the filter
 * sheet show those).
 */
export function mobileChips(chips: readonly FilterChip[]): FilterChip[] {
  return chips.filter((c) => !c.cat && !QUICK_KEYS.has(c.key));
}

// --- Search suggestions: scope of the view and operators ---

/**
 * Scope of the open view: mailbox, folder or tag, the settings or the
 * administration. Under "In … only", `patch` supplements the filters as far
 * as they are still at the default (`scoped`).
 */
export interface SearchScope {
  /** Label of the segment: "In Inbox only", "Tag “Work” only", "Settings only". */
  here: string;
  icon: IconName;
  patch: Partial<SearchFilter>;
}

/** Filters with the scope of the view: only fields still at `SF0`. */
export function scoped(sf: SearchFilter, scope: SearchScope | null): SearchFilter {
  if (!scope) return sf;
  const out: SearchFilter = { ...sf };
  for (const key of Object.keys(scope.patch) as (keyof SearchFilter)[]) {
    const d = SF0[key];
    const unset = Array.isArray(d) ? (sf[key] as readonly unknown[]).length === 0 : sf[key] === d;
    if (unset) Object.assign(out, { [key]: scope.patch[key] });
  }
  return out;
}

/** Search operators to insert into the search text, spelled like `parseQuery` understands them. */
export function searchOps(): readonly string[] {
  return ['from:', 'tag:', 'in:', 'is:unread', 'has:attachment'];
}

/** Operator at the end of the search text: with a space before, after a complete operator also after it. */
export function withOp(q: string, op: string): string {
  const head = q.replace(/\s+$/, '');
  return (head ? head + ' ' : '') + op + (op.endsWith(':') ? '' : ' ');
}

/** "Quick access" tiles: filter, icon and fixed colours. */
export interface TileDef {
  key: string;
  label: () => string;
  icon: IconName;
  bg: string;
  ink: string;
  patch: Partial<SearchFilter>;
}

export const TILES: readonly TileDef[] = [
  {
    key: 'u',
    label: m.search_st_unread,
    icon: 'ti-mail',
    bg: 'var(--acc)',
    ink: 'var(--accink)',
    patch: { st: ['u'] },
  },
  { key: 'st', label: m.search_st_flagged, icon: 'ti-star', bg: '#f2c46b', ink: '#3d2a00', patch: { st: ['st'] } },
  {
    key: 'at',
    label: m.search_st_attachment,
    icon: 'ti-paperclip',
    bg: '#82bbec',
    ink: '#0b2a47',
    patch: { st: ['at'] },
  },
  {
    key: 'today',
    label: m.search_time_today,
    icon: 'ti-calendar-event',
    bg: '#94c48d',
    ink: '#13300f',
    patch: { time: 'today' },
  },
];

/**
 * Filter of the counters per tile: all emails except trash and spam
 * (`exclude`), "Today" from the start to the end of the day.
 */
export function tileFilters(exclude: readonly Id[], now: number, tz: string): Filter<EmailFilter>[] {
  const day = timeAfter('today', now, tz)!;
  const p = zoneParts(day, tz);
  const end = zoneTime(p.y, p.mo, p.d + 1, 0, 0, tz);
  const base: Filter<EmailFilter>[] = exclude.length ? [{ inMailboxOtherThan: [...exclude] }] : [];
  return [ST_FILTER.u, ST_FILTER.st, ST_FILTER.at, { after: utcDate(day), before: utcDate(end) }].map((f) =>
    allOf([...base, f])!,
  );
}
