/**
 * Search: categories, scoring of local hits, highlighting, snippets from the
 * server and the values of the results page. Messages and attachments come
 * from the mail server (`Email/query`, `SearchSnippet/get`, state module
 * `search`), the other categories from the app's loaded data
 * (`#lib/search-items.ts`). Filters, operators and chips come from
 * `#lib/search-filter.ts`.
 */
import type { EmailAddress } from '@roedy/jmap';
import type { IconName } from '#lib/icons.ts';
import { avatarOf, initials, nameOf, searchTime, type TimeContext } from '#lib/mail-list.ts';
import { fileIcon } from '#lib/message-view.ts';
import { m } from '#lib/paraglide/messages.js';
import type { MailboxTarget, RoleId } from '#lib/routes.ts';
import type { FilterChip, SfField } from '#lib/search-filter.ts';

/** Categories in display order. */
export const SEARCH_CATS = [
  'mail',
  'contacts',
  'files',
  'folders',
  'tags',
  'settings',
  'admin',
  'actions',
  'notifs',
] as const;
export type SearchCat = (typeof SEARCH_CATS)[number];

/** Icon per category. */
export const CAT_ICON: Record<SearchCat, IconName> = {
  mail: 'ti-mail',
  contacts: 'ti-address-book',
  files: 'ti-paperclip',
  folders: 'ti-folder',
  tags: 'ti-tag',
  settings: 'ti-settings',
  admin: 'ti-shield',
  actions: 'ti-bolt',
  notifs: 'ti-bell',
};

export function catLabel(cat: SearchCat): string {
  return {
    mail: m.search_cat_mail,
    contacts: m.search_cat_contacts,
    files: m.search_cat_files,
    folders: m.search_cat_folders,
    tags: m.search_cat_tags,
    settings: m.search_cat_settings,
    admin: m.search_cat_admin,
    actions: m.search_cat_actions,
    notifs: m.search_cat_notifs,
  }[cat]();
}

/** Categories of the search: "Administration" only for administrators. */
export function searchCats(isAdmin: boolean): SearchCat[] {
  return SEARCH_CATS.filter((c) => isAdmin || c !== 'admin');
}

/** Comparison form: lower case, German umlauts spelled out, without accents. */
export function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00e4/g, 'ae')
    .replace(/\u00f6/g, 'oe')
    .replace(/\u00fc/g, 'ue')
    .replace(/\u00df/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Search words: `raw` lower case for highlighting, `terms` in comparison form. */
export interface Terms {
  raw: string[];
  terms: string[];
}

export function termsOf(q: string): Terms {
  const raw = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  return { raw, terms: raw.map(norm) };
}

const SEP = /[-_./@()|,:›·]/g;

/**
 * Scoring: every word must occur in the label or in `extra`, otherwise
 * -1; equal 100, start 80, word start 60, contained 40, only in `extra` 15,
 * averaged. Without words 1.
 */
export function score(label: string, extra: string, terms: readonly string[]): number {
  if (!terms.length) return 1;
  const l = norm(label);
  const w = ' ' + l.replace(SEP, ' ');
  const x = norm(extra);
  let total = 0;
  for (const t of terms) {
    const v =
      l === t ? 100 : l.startsWith(t) ? 80 : w.includes(' ' + t) ? 60 : l.includes(t) ? 40 : x.includes(t) ? 15 : -1;
    if (v < 0) return -1;
    total += v;
  }
  return total / terms.length;
}

/** Part of a label, `hl` = highlighted. */
export interface Part {
  t: string;
  hl: boolean;
}

/** Highlighting of the search words, overlapping hits merged. */
export function highlight(text: string, raw: readonly string[]): Part[] {
  const low = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const q of raw) {
    if (!q) continue;
    let i = low.indexOf(q);
    while (i >= 0) {
      ranges.push([i, i + q.length]);
      i = low.indexOf(q, i + q.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const parts: Part[] = [];
  let p = 0;
  for (const [x, y] of merged) {
    if (x > p) parts.push({ t: text.slice(p, x), hl: false });
    parts.push({ t: text.slice(x, y), hl: true });
    p = y;
  }
  if (p < text.length) parts.push({ t: text.slice(p), hl: false });
  return parts.filter((x) => x.t);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/**
 * Snippet of the server (`SearchSnippet` › `subject`, RFC 8621 › 5.1): HTML
 * text with `<mark>` around the hits; other tags do not exist and are read as
 * text. `null` without hits in the snippet.
 */
export function markParts(snippet: string | null | undefined): Part[] | null {
  if (!snippet || !snippet.includes('<mark>')) return null;
  const parts: Part[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let p = 0;
  for (let hit = re.exec(snippet); hit; hit = re.exec(snippet)) {
    if (hit.index > p) parts.push({ t: unescape(snippet.slice(p, hit.index)), hl: false });
    parts.push({ t: unescape(hit[1] ?? ''), hl: true });
    p = hit.index + hit[0].length;
  }
  if (p < snippet.length) parts.push({ t: unescape(snippet.slice(p)), hl: false });
  return parts.filter((x) => x.t);
}

/** Hit of a category before scoring. */
export interface SearchItem {
  /** Unique within the category (key of the row). */
  id: string;
  cat: SearchCat;
  label: string;
  icon: IconName;
  /** Avatar with initials; otherwise a tile with an icon. */
  av?: { text: string; bg: string; ink: string };
  /** Colours of the tile (tags). */
  tile?: { bg: string; ink: string };
  path: string;
  desc?: string;
  /** Time on the right (messages, attachments). */
  side?: string;
  unread?: boolean;
  /** Point in time (ms) for sorting with equal score. */
  t?: number;
  /** Keyboard shortcut of the action. */
  k?: string;
  /** Highlighting from the server; otherwise from the search words. */
  parts?: Part[] | null;
  run: () => void;
}

export interface ScoredItem extends SearchItem {
  score: number;
}

/** Local hit with search words outside the label. */
export interface Candidate extends SearchItem {
  extra: string;
}

/** Score local hits; those without a hit drop out. */
export function scoreAll(list: readonly Candidate[], terms: readonly string[]): ScoredItem[] {
  const out: ScoredItem[] = [];
  for (const c of list) {
    const s = score(c.label, c.extra, terms);
    if (s >= 0) out.push({ ...c, score: s });
  }
  return out;
}

// --- Messages and attachments from the server ---

/** Email from `Email/query` with `Email/get` and `SearchSnippet/get`. */
export interface MailHit {
  account: string;
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  receivedAt: string;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  subject: string | null;
  attachments: string[];
  /** `SearchSnippet` › `subject` with `<mark>`. */
  snippet: string | null;
}

/** Folder of an email for path and target. */
export interface HitBox {
  label: string;
  role: RoleId | null;
  target: MailboxTarget;
}

export interface MailContext {
  time: TimeContext;
  /** Several mail accounts: address in the path. */
  multi: boolean;
  email: (account: string) => string;
  box: (hit: MailHit) => HitBox | null;
  open: (hit: MailHit, box: HitBox | null) => void;
}

const OUTGOING: ReadonlySet<RoleId | null> = new Set<RoleId | null>(['sent', 'drafts', 'scheduled']);

/** Who is in the row: for outgoing mail the recipients, otherwise the sender; empty if none. */
function nameIn(hit: MailHit, role: RoleId | null): string {
  if (OUTGOING.has(role)) return (hit.to ?? []).map(nameOf).filter(Boolean).join(', ');
  return nameOf(hit.from?.[0]);
}

/** Without names: "Draft", "No recipient" or "Unknown". */
function whoOf(name: string, role: RoleId | null): string {
  if (name) return name;
  return role === 'drafts' ? m.search_draft() : OUTGOING.has(role) ? m.list_no_recipient() : m.list_no_sender();
}

/**
 * Messages and attachments.
 * The server has filtered; the scoring only orders: hits in the subject before
 * the sender, otherwise 15 like a hit outside the label.
 */
export function mailItems(
  hits: readonly MailHit[],
  t: Terms,
  ctx: MailContext,
  /** List attachments: with search words or in the category attachments. */
  files: boolean = t.terms.length > 0,
  /** "Search in": subject and sender count only if chosen; empty = all. */
  fields: readonly SfField[] = [],
): ScoredItem[] {
  const inField = (f: SfField) => !fields.length || fields.includes(f);
  const out: ScoredItem[] = [];
  for (const hit of hits) {
    const box = ctx.box(hit);
    const role = box?.role ?? null;
    const name = nameIn(hit, role);
    const who = whoOf(name, role);
    const at = Date.parse(hit.receivedAt);
    const subject = hit.subject?.trim() || m.list_no_subject();
    const from = inField('from') ? (hit.from ?? []).map((a) => `${a.name ?? ''} ${a.email ?? ''}`).join(' ') : '';
    let s = score(inField('s') ? (hit.subject ?? '') : '', from, t.terms);
    if (t.terms.length && from && s >= 0 && t.terms.every((x) => norm(from).includes(x))) s = Math.max(s, 55);
    const [bg, ink] = avatarOf(who);
    // Without a sender or recipient (or without letters for initials) a tile with the icon.
    const ini = initials(name);
    const path = [who, box?.label ?? '', ...(ctx.multi ? [ctx.email(hit.account)] : [])].filter(Boolean).join(' · ');
    const side = searchTime(at, ctx.time);
    const run = () => ctx.open(hit, box);
    out.push({
      id: `${hit.account}/${hit.id}`,
      cat: 'mail',
      label: subject,
      icon: role === 'drafts' ? 'ti-file-pencil' : 'ti-mail',
      ...(ini ? { av: { text: ini, bg, ink } } : {}),
      path,
      side,
      unread: !hit.keywords['$seen'] && role !== 'drafts' && role !== 'sent' && role !== 'scheduled',
      t: at,
      parts: hit.subject ? markParts(hit.snippet) : null,
      run,
      score: s < 0 ? 15 : s,
    });
    if (!files || !inField('att')) continue;
    hit.attachments.forEach((file, i) => {
      const fs = score(file, '', t.terms);
      if (fs < 0) return;
      out.push({
        id: `${hit.account}/${hit.id}/${i}`,
        cat: 'files',
        label: file,
        icon: fileIcon(file),
        path: `${name || m.search_draft()} · ${subject}`,
        side,
        t: at,
        run,
        score: fs,
      });
    });
  }
  return out;
}

// --- Values of the results page ---

export interface SearchRow {
  key: string;
  label: string;
  parts: Part[];
  icon: IconName;
  hasAv: boolean;
  av: string;
  /** Avatar round, otherwise a tile with rounded corners. */
  round: boolean;
  tileBg: string;
  tileInk: string;
  /** Without own colours (avatar, tag): `--surface2` in the search suggestions, `--acc` when marked. */
  plain: boolean;
  meta: string;
  /** Subline of the search suggestions: description, otherwise path; none for actions. */
  sub: string;
  side: string;
  k: string;
  /** Font weight: unread bold. */
  fw: number;
  run: () => void;
}

export interface SearchPill {
  cat: SearchCat | null;
  label: string;
  n: string;
  on: boolean;
  onClick: () => void;
}

export interface SearchGroup {
  cat: SearchCat;
  label: string;
  n: string;
  rows: SearchRow[];
  hasMore: boolean;
  moreLabel: string;
  more: () => void;
  /** Only messages open and the server has more: load more at the end. */
  canLoad: boolean;
}

export interface ResultsInput {
  q: string;
  terms: Terms;
  /** Categories to choose from. */
  allowed: readonly SearchCat[];
  /** Chosen categories (after `type:`). */
  cats: readonly SearchCat[];
  /** A filter for messages is set. */
  mailF: boolean;
  /** Chips of all filters, including the categories. */
  chips: readonly FilterChip[];
  items: readonly ScoredItem[];
  /** Server hits for messages (`total`), `null` = unknown. */
  mailTotal: number | null;
  setCats: (cats: SearchCat[]) => void;
  clearFilters: () => void;
  /** Row executed: remember the search, close the results. */
  done: () => void;
}

export interface ResultsValues {
  idle: boolean;
  active: boolean;
  total: number;
  empty: boolean;
  has: boolean;
  title: string;
  countText: string;
  /** Results page: only chips without a category count as filters. */
  emptyText: string;
  /** Search suggestions: every chip counts, categories included. */
  suggestEmptyText: string;
  pills: SearchPill[];
  groups: SearchGroup[];
  /** Chips without categories (desktop: the pills show the categories). */
  chips: FilterChip[];
  hasChips: boolean;
  /** Mobile, the row of quick filters: as soon as a filter other than the categories is set. */
  qfOn: boolean;
  clearF: () => void;
}

/** Rows per category as long as several categories are visible. */
export const GROUP_ROWS = 5;

function rowOf(r: ScoredItem, raw: readonly string[], done: () => void): SearchRow {
  const meta = r.desc ? (r.path ? `${r.path} · ${r.desc}` : r.desc) : r.path;
  return {
    key: `${r.cat}:${r.id}`,
    label: r.label,
    parts: r.parts ?? highlight(r.label, raw),
    icon: r.icon,
    hasAv: !!r.av,
    av: r.av?.text ?? '',
    round: !!r.av,
    tileBg: r.tile?.bg ?? r.av?.bg ?? 'var(--surface)',
    tileInk: r.tile?.ink ?? r.av?.ink ?? 'var(--fg)',
    plain: !r.tile && !r.av,
    meta,
    sub: r.cat === 'actions' ? '' : r.desc || r.path,
    side: r.side ?? '',
    k: r.k ?? '',
    fw: r.unread ? 800 : 700,
    run: () => {
      done();
      r.run();
    },
  };
}

const countText = (n: number): string =>
  n === 0 ? m.search_count_none() : n === 1 ? m.search_count_one() : m.search_count({ n });

/** Values of the results page. */
export function resultsValues(input: ResultsInput): ResultsValues {
  const { terms, raw } = input.terms;
  const mailF = input.mailF;
  const chips = input.chips.filter((c) => !c.cat);
  const idle = !terms.length && !mailF && !input.cats.length;
  const q = input.q.trim();
  const base: SearchCat[] = idle
    ? []
    : mailF
      ? [...new Set<SearchCat>(['mail', 'files', ...input.cats])]
      : [...input.allowed];
  const shown = input.cats.length ? base.filter((c) => input.cats.includes(c)) : base;
  const by = new Map<SearchCat, ScoredItem[]>(base.map((c) => [c, []]));
  for (const it of input.items) by.get(it.cat)?.push(it);
  for (const list of by.values()) list.sort((x, y) => y.score - x.score || (y.t ?? 0) - (x.t ?? 0));
  const loaded = (c: SearchCat) => by.get(c)?.length ?? 0;
  const countOf = (c: SearchCat) => (c === 'mail' ? Math.max(input.mailTotal ?? 0, loaded(c)) : loaded(c));
  const order = (c: SearchCat) => SEARCH_CATS.indexOf(c);
  const best = (c: SearchCat) => by.get(c)?.[0]?.score ?? 0;
  const cats = shown
    .filter((c) => countOf(c) > 0 && loaded(c) > 0)
    .sort((x, y) => (terms.length ? best(y) - best(x) : 0) || order(x) - order(y));
  const one = cats.length === 1;
  const total = cats.reduce((n, c) => n + countOf(c), 0);
  const pills: SearchPill[] = idle
    ? []
    : [
        {
          cat: null,
          label: m.search_all(),
          n: String(base.reduce((n, c) => n + countOf(c), 0)),
          on: !input.cats.length,
          onClick: () => input.setCats([]),
        },
        ...base
          .filter((c) => countOf(c) > 0 || input.cats.includes(c))
          .map((c) => ({
            cat: c,
            label: catLabel(c),
            n: String(countOf(c)),
            on: input.cats.includes(c),
            onClick: () => input.setCats(input.cats.length === 1 && input.cats[0] === c ? [] : [c]),
          })),
      ];
  const groups: SearchGroup[] = cats.map((c) => {
    const list = by.get(c) ?? [];
    const n = countOf(c);
    const rows = one ? list : list.slice(0, GROUP_ROWS);
    return {
      cat: c,
      label: catLabel(c),
      n: String(n),
      rows: rows.map((r) => rowOf(r, raw, input.done)),
      hasMore: !one && n > GROUP_ROWS,
      moreLabel: m.search_more({ n }),
      more: () => input.setCats([c]),
      canLoad: one && c === 'mail' && n > list.length,
    };
  });
  return {
    idle,
    active: !idle,
    total,
    empty: !idle && total === 0,
    has: total > 0,
    title: q ? m.search_title({ q }) : m.search_title_filtered(),
    countText: idle ? m.search_count_idle() : countText(total),
    emptyText: chips.length ? m.search_empty_filtered() : m.search_empty_text(),
    suggestEmptyText: input.chips.length ? m.search_empty_filtered() : m.search_empty_text(),
    pills,
    groups,
    chips,
    hasChips: chips.length > 0,
    qfOn: chips.length > 0,
    clearF: input.clearFilters,
  };
}

// --- Search suggestions ---

/** Rows of the search suggestions in total. */
export const SUGGEST_ROWS = 9;

/**
 * Groups of the search suggestions from those of the results: at most
 * `SUGGEST_ROWS` rows, per group 9 with one, 5 with two and 3 with more
 * groups, in the order of the results; empty groups drop out.
 */
export function suggestGroups(groups: readonly SearchGroup[]): SearchGroup[] {
  const full = groups.filter((g) => g.rows.length > 0);
  const cap = full.length === 1 ? SUGGEST_ROWS : full.length === 2 ? 5 : 3;
  let left = SUGGEST_ROWS;
  const out: SearchGroup[] = [];
  for (const g of full) {
    const rows = g.rows.slice(0, Math.max(0, Math.min(cap, left)));
    left -= rows.length;
    if (rows.length) out.push({ ...g, rows });
  }
  return out;
}

// --- Actions of the shell ---

/** What hits execute; set by the layout (`search.actions`) because it serves the shell. */
export interface SearchActions {
  /** Navigate (settings, administration, notification targets). */
  go: (path: string) => void;
  /** Open a mailbox, folder or tag (`select`): its list starts with the segment "All". */
  mailbox: (path: string) => void;
  /** Open a page and scroll to the section `[data-sec]`, briefly marked. */
  section: (path: string, sec: string) => void;
  compose: () => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  help: () => void;
  palette: () => void;
  addAccount: () => void;
  invite: () => void;
  /** Expand a user in Administration › Users. */
  openUser: (id: string) => void;
  /** Contact chosen: messages from this address, outside the search page as results. */
  searchFrom: (email: string) => void;
  logout: () => void;
}
