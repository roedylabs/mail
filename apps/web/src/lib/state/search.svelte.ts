/**
 * State module `search`:
 * search text and filters (`search`, `sf`), "Recent
 * searches", the mail server's hits and the counters of the
 * "Quick access" tiles. Every ready mail account searches messages and
 * attachments itself (`Email/query` with the filters from
 * `#lib/search-filter.ts`, `SearchSnippet/get` for the highlighting in the
 * subject), page by page and sorted by arrival. `#lib/search.ts` evaluates
 * the other areas locally. Without a connection an account searches its
 * stored emails (`#lib/local-search.ts`).
 */
import type { Email, EmailFilter, Filter, Id, JmapClient } from '@roedy/jmap';
import { failText, isOffline, timeZoneOf } from '#lib/errors.ts';
import { localPage, savedMails, type LocalMail } from '#lib/local-search.ts';
import { roleLabel } from '#lib/mailbox-nav.ts';
import { m } from '#lib/paraglide/messages.js';
import { ALL_ACCOUNTS, parseMailboxPath, ROLE_IDS } from '#lib/routes.ts';
import {
  effective,
  filterChips,
  folderKey,
  parseFolderKey,
  parseQuery,
  scoped,
  SF0,
  tileFilters,
  TILES,
  type AccountQuery,
  type Effective,
  type FilterChip,
  type FilterEnv,
  type FilterPatch,
  type FolderOption,
  type SearchFilter,
  type SearchScope,
  type TagOption,
} from '#lib/search-filter.ts';
import { searchCats, type MailHit, type SearchActions } from '#lib/search.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { folderLevels, mailboxes, ROLES, type FolderNode } from '#lib/state/mailboxes.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { tags, tagTree, type TagNode } from '#lib/state/tags.svelte.ts';
import { zoneDayStart } from '#lib/timezone.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Emails per account and fetch. */
export const MAIL_PAGE = 50;
/** Entries in "Recent searches" (`slice(0, 5)`). */
export const RECENT_MAX = 5;
/** Of these, shown on the search page on mobile and in the search suggestions (`sRecent.slice(0, 4)`). */
export const RECENT_SHOWN = 4;
/** Wait after typing before the server is asked. */
export const SEARCH_DELAY = 250;
/** This long the tile counters apply before the page fetches them again. */
export const TILE_TTL = 60_000;

export interface MailPage {
  hits: MailHit[];
  /**
   * Positions of the page in the query, also for emails that `Email/get`
   * no longer found (`notFound`, e.g. after a thread merge in
   * Stalwart v1): the next page loads from here.
   */
  positions: number;
  /** Total hits (`calculateTotal`), `null` = unknown. */
  total: number | null;
  /** From the browser's storage: the server did not answer. */
  local?: boolean;
}

export interface MailQuery {
  filter: Filter<EmailFilter> | null;
  /** With search words: snippets for the highlighting. */
  snippets: boolean;
}

export interface SearchApi {
  page(account: string, query: MailQuery, position: number, limit: number): Promise<MailPage>;
  /** Hits per filter (`calculateTotal`), `null` = unknown. */
  counts(account: string, filters: readonly Filter<EmailFilter>[]): Promise<(number | null)[]>;
}

const HIT_PROPS = [
  'id',
  'threadId',
  'mailboxIds',
  'keywords',
  'receivedAt',
  'from',
  'to',
  'subject',
  'attachments',
] satisfies (keyof Email)[];

type HitEmail = Pick<Email, (typeof HIT_PROPS)[number]>;

/** `SearchApi` via the JMAP client per mail account: query, emails and snippets in one request. */
export function jmapSearchApi(clientOf: (account: string) => Promise<JmapClient>): SearchApi {
  return {
    async page(account, query, position, limit) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const b = client.batch();
      const ids = b.call('Email/query', {
        accountId,
        filter: query.filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
        position,
        limit,
        calculateTotal: true,
      });
      const emails = b.call('Email/get', {
        accountId,
        '#ids': ids.ref('/ids'),
        properties: HIT_PROPS,
        bodyProperties: ['name'],
      });
      const snippets = query.snippets
        ? b.call('SearchSnippet/get', { accountId, filter: query.filter, '#emailIds': ids.ref('/ids') })
        : null;
      const res = await b.send();
      const q = res.get(ids);
      const marks: Record<Id, string | null> = {};
      if (snippets) {
        // Without snippets only the app's highlighting remains; the hits apply anyway.
        const got = res.result(snippets);
        if (got.ok) for (const s of got.value.list) marks[s.emailId] = s.subject;
      }
      const byId: Record<Id, HitEmail> = {};
      for (const e of res.get(emails).list as HitEmail[]) byId[e.id] = e;
      const hits: MailHit[] = [];
      for (const id of q.ids) {
        const e = byId[id];
        // `notFound`: like deleted, the query just does not know it yet.
        if (!e) continue;
        hits.push({
          account,
          id: e.id,
          threadId: e.threadId,
          mailboxIds: e.mailboxIds,
          keywords: e.keywords,
          receivedAt: e.receivedAt,
          from: e.from,
          to: e.to,
          subject: e.subject,
          attachments: (e.attachments ?? []).flatMap((a) => (a.name ? [a.name] : [])),
          snippet: marks[e.id] ?? null,
        });
      }
      return { hits, positions: q.ids.length, total: q.total ?? null };
    },
    async counts(account, filters) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const b = client.batch();
      // Only the number counts; `limit: 1`, because RFC 8620 › 5.5 specifies nothing for 0.
      const calls = filters.map((filter) =>
        b.call('Email/query', { accountId, filter, collapseThreads: false, limit: 1, calculateTotal: true }),
      );
      const res = await b.send();
      return calls.map((c) => {
        const got = res.result(c);
        return got.ok ? (got.value.total ?? null) : null;
      });
    },
  };
}

/** Folders in tree order (parents before children), with the names of the parents. */
function walkFolders(
  nodes: readonly FolderNode[],
  out: (node: FolderNode, path: readonly string[]) => void,
  path: readonly string[] = [],
): void {
  for (const n of nodes) {
    out(n, path);
    walkFolders(n.children, out, [...path, n.name]);
  }
}

function walkTags(nodes: readonly TagNode[], out: TagOption[], path: readonly string[] = []): void {
  for (const n of nodes) {
    out.push({ id: n.id, label: n.name, color: n.color, path });
    walkTags(n.children, out, [...path, n.name]);
  }
}

/** Mail accounts, folders, tags and time zone from the state modules. */
export function appFilterEnv(): FilterEnv {
  const ready = (accounts.list ?? []).filter((a) => a.state === 'ok' && !a.blocked);
  const folders: FolderOption[] = ROLE_IDS.map((role) => ({
    key: `role:${role}`,
    label: roleLabel(role),
    icon: ROLES[role].icon,
  }));
  for (const a of ready)
    walkFolders(mailboxes.tree(a.id), (n, path) => folders.push({ key: folderKey(a.id, n.id), label: n.name, path }));
  const tagList: TagOption[] = [];
  walkTags(tagTree(tags.list ?? []), tagList);
  return {
    accounts: ready.map((a) => ({ id: a.id, email: a.email, color: a.color })),
    allowed: searchCats(session.isAdmin),
    folders,
    tags: tagList,
    folderBoxes: (key, account) => {
      const p = parseFolderKey(key);
      if (!p) return [];
      if ('role' in p) {
        const box = mailboxes.role(account, p.role);
        return box ? [box.id] : [];
      }
      if (p.account !== account) return [];
      // The folder with all descendants; unknown (mailboxes not loaded yet) only itself.
      return (
        folderLevels(mailboxes.list(account), p.id)
          ?.flat()
          .map((b) => b.id) ?? [p.id]
      );
    },
    tagBoxes: (tag, account) => tags.listBoxes(tag, account) ?? [],
    tz: timeZoneOf(prefs.values),
  };
}

/**
 * Pages of an email account (`/account/mail-accounts/<id>/…`): own view,
 * no "Settings" area. "Add account" (`…/new`) belongs to the account.
 */
const MAIL_ACCOUNT_PAGE = /^\/account\/mail-accounts\/(?!new(?:\/|$))[^/]+/;

/**
 * Area of the view under `path` for the search suggestions:
 * settings and account, administration (administrators only),
 * mailbox, folder or tag; otherwise `null` (start page, email account,
 * unknown folder or tag).
 */
export function scopeOf(path: string, isAdmin: boolean, env: FilterEnv): SearchScope | null {
  if (path.startsWith('/settings/') || (path.startsWith('/account/') && !MAIL_ACCOUNT_PAGE.test(path)))
    return { here: m.search_scope_settings(), icon: 'ti-settings', patch: { cats: ['settings'] } };
  if (path.startsWith('/admin/'))
    return isAdmin ? { here: m.search_scope_admin(), icon: 'ti-shield', patch: { cats: ['admin'] } } : null;
  const at = parseMailboxPath(path);
  if (!at) return null;
  const account = at.account === ALL_ACCOUNTS ? null : at.account;
  if ('role' in at)
    return {
      here: m.search_scope_in({ name: roleLabel(at.role) }),
      icon: ROLES[at.role].icon,
      patch: { folder: `role:${at.role}`, account },
    };
  if ('tag' in at) {
    const tag = env.tags.find((t) => t.id === at.tag);
    return tag ? { here: m.search_scope_tag({ name: tag.label }), icon: 'ti-tag', patch: { tags: [tag.id] } } : null;
  }
  const owner = account ?? at.owner ?? null;
  const key = owner ? folderKey(owner, at.folder) : null;
  const folder = key && env.folders.find((f) => f.key === key);
  return folder && owner
    ? {
        here: m.search_scope_in({ name: folder.label }),
        icon: 'ti-folder',
        patch: { folder: folder.key, account: owner },
      }
    : null;
}

interface AccountPage {
  loaded: number;
  total: number | null;
}

/**
 * State of an account after a page from `loaded`. Without positions the
 * account is done, even if an outdated `total` promises more – otherwise
 * loading more would keep asking for the same empty page.
 */
function after(loaded: number, page: MailPage): AccountPage {
  return { loaded: loaded + page.positions, total: page.positions ? page.total : loaded };
}

interface MailResult {
  /** Query of these hits (`#want` at the time of the request). */
  key: string;
  /** Query per account, for loading more. */
  queries: Record<string, MailQuery>;
  /** Search words, for the highlighting in hits from storage. */
  words: readonly string[];
  hits: MailHit[];
  pages: Record<string, AccountPage>;
  /** At least one account did not answer: its hits come from storage. */
  local: boolean;
}

/** Where a hit was opened from (`navRet.label`): mobile search or the results page. */
export type ReturnKind = 'search' | 'results';

/** The search when a hit was opened (`navSnap`): text, filters, area and way back of the results. */
export interface SearchSnapshot {
  q: string;
  sf: SearchFilter;
  scope: 'here' | 'all';
  back: string | null;
  /** Reference of the time range, so that the same query (and its hits) applies again. */
  anchor: number;
}

/** Return path to the search (`navRet`): valid only at `target`, the address the hit opened. */
export interface SearchReturn {
  kind: ReturnKind;
  target: string;
  snap: SearchSnapshot;
}

const byReceived = (a: MailHit, b: MailHit) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0);

export class Search {
  /** Text of the search field (`search`): header on desktop, the page's field on mobile; with operators. */
  q = $state('');
  /** Filters (`sf`); change only via `set()` and `clearFilters()`. */
  sf = $state.raw<SearchFilter>(SF0);
  /** "Recent searches", newest first; only in memory until sign-out. */
  recent = $state<string[]>([]);
  /** Way back for "Close search results". */
  back: string | null = null;
  /** Return path to the search after opening a hit (`navRet`); see `expectReturn()`. */
  ret = $state.raw<SearchReturn | null>(null);
  /** The server's hits for the most recently answered query. */
  mail = $state<MailResult | null>(null);
  /** Loads more pages (`more()`). */
  loadingMore = $state(false);
  /** Shell actions for hits; set by the layout. */
  actions = $state.raw<SearchActions | null>(null);
  /** Counters of the "Quick access" tiles in the order of `TILES`; `null` = not known yet. */
  tileCounts = $state.raw<(number | null)[] | null>(null);
  /** Filter panel hidden while docked; applies until sign-out. */
  panelHidden = $state(false);
  /** Filter panel open as an overlay where there is no room to dock. */
  panelOver = $state(false);
  /** Search suggestions: only in the open view or everywhere (`sScope`). */
  scope = $state<'here' | 'all'>('here');
  /**
   * Area of the open view (`scopeOf`); set by the layout. `null`
   * on the search page, on mobile and in views without an area.
   */
  context = $state.raw<SearchScope | null>(null);

  #api: SearchApi;
  #saved: (account: string) => Promise<LocalMail[]>;
  #env: () => FilterEnv;
  #width: () => number;
  /** State of the environment; `reset()` discards it (sign-out). */
  #envGen = $state(0);
  /** Environment once per change of accounts, folders, tags and settings instead of on every read. */
  #envNow = $derived.by(() => {
    void this.#envGen;
    return this.#env();
  });
  #prepare: (accounts: readonly string[]) => Promise<void>;
  #tilesKey = '';
  #tilesAt = 0;
  /** Counts tile fetches; only the response of the latest counts. */
  #tilesSeq = 0;
  /**
   * Reference for the time range (`after`): when the filters were last set.
   * This way the query stays the same as long as nobody changes the filters, instead of
   * asking anew every minute.
   */
  #anchor = Date.now();
  /** Wanted query; empty = none. */
  #want = $state('');
  #gen = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Next query without waiting (Enter, palette, contact), not while typing. */
  #now = false;
  /** Hits while only local areas are chosen; back on messages they apply again. */
  #parked: MailResult | null = null;
  /** The last query already failed: no further toast while typing. */
  #failed = false;
  /** Hit just opened: the navigation it starts becomes the return path's target. */
  #pending: { kind: ReturnKind; snap: SearchSnapshot } | null = null;
  #pendingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    api: SearchApi = jmapSearchApi((account) => accounts.client(account)),
    env: () => FilterEnv = appFilterEnv,
    /** Load mailboxes before the tiles exclude trash and spam. */
    prepare: (accounts: readonly string[]) => Promise<void> = async (list) => {
      await Promise.allSettled(list.map((a) => mailboxes.ensure(a)));
    },
    /** Width of the app for docking the filter panel. */
    width: () => number = () => ui.width,
    /** Stored emails of an account, for searching without a connection. */
    saved: (account: string) => Promise<LocalMail[]> = (account) => savedMails(session.mailStore, account),
  ) {
    this.#api = api;
    this.#saved = saved;
    this.#env = env;
    this.#prepare = prepare;
    this.#width = width;
  }

  /** Search words without operators. */
  get terms() {
    return parseQuery(this.q).terms;
  }

  /** Mail accounts, folders, tags and time zone of the filters. */
  get env(): FilterEnv {
    return this.#envNow;
  }

  /**
   * Sets the area of the view (layout). The same area as a new object –
   * e.g. after new mailbox counters – changes nothing, so that evaluation and
   * query do not start anew.
   */
  setContext(next: SearchScope | null): void {
    if (JSON.stringify(next) !== JSON.stringify(this.context)) this.context = next;
  }

  /** Area currently in effect: the view's under "Nur in …", otherwise none. */
  get here(): SearchScope | null {
    return this.scope === 'here' ? this.context : null;
  }

  /** Filters, view area and operators together; the time range applies from setting the filters. */
  effective(): Effective {
    return effective(scoped(this.sf, this.here), this.q, this.env, this.#anchor);
  }

  /** A filter is set (also only an area). */
  get filtered(): boolean {
    const f = this.sf;
    return (
      f.cats.length > 0 ||
      !!f.account ||
      !!f.folder ||
      f.tags.length > 0 ||
      f.st.length > 0 ||
      f.time !== 'any' ||
      !!f.from.trim() ||
      f.fields.length > 0
    );
  }

  /** Chips of all filters, also of the areas. */
  get chips(): FilterChip[] {
    // Without filters no names are needed: the header counts along on every page.
    if (!this.filtered) return [];
    const env = this.env;
    return filterChips(
      this.sf,
      {
        email: (id) => env.accounts.find((a) => a.id === id)?.email ?? accounts.get(id)?.email ?? null,
        folder: (key) => env.folders.find((f) => f.key === key)?.label ?? null,
        tag: (id) => env.tags.find((t) => t.id === id)?.label ?? null,
      },
      (patch) => this.set(patch),
    );
  }

  /** Room to dock the filter panel (`rfDock()`): app width − 32 px ≥ 960 px. */
  get dock(): boolean {
    return this.#width() - 32 >= 960;
  }

  /** Filter panel open as an overlay: above the results, with backdrop (`rf.over`). */
  get panelOverlaid(): boolean {
    return !this.dock && this.panelOver;
  }

  /** Filter panel visible (`rf.show`): docked as long as not hidden, otherwise overlaid. */
  get panelShown(): boolean {
    return this.dock ? !this.panelHidden : this.panelOver;
  }

  /** Filter button of the page and of the header on the search page. */
  togglePanel(): void {
    if (this.dock) this.panelHidden = !this.panelHidden;
    else this.panelOver = !this.panelOver;
  }

  /** "Hide filters", "Close" and "Show ‹n› results" of the panel. */
  closePanel(): void {
    if (this.dock) this.panelHidden = true;
    else this.panelOver = false;
  }

  /** Leaves the search: filters back, the overlay closed; the text stays. */
  leave(): void {
    this.clearFilters();
    this.panelOver = false;
  }

  /** Changes filters: replaces parts, the rest stays. */
  set(patch: FilterPatch): void {
    const cur = this.sf;
    this.sf = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    this.#anchor = Date.now();
  }

  /** Hits for the wanted query; until the response is there, the previous ones. */
  get hits(): MailHit[] {
    return this.#want && this.mail ? this.mail.hits : [];
  }

  /** Total hits across all accounts; unknown as soon as an account returns no number. */
  get mailTotal(): number | null {
    if (!this.#want || !this.mail) return null;
    let n = 0;
    for (const p of Object.values(this.mail.pages)) {
      if (p.total == null) return null;
      n += p.total;
    }
    return n;
  }

  /** The displayed hits come wholly or partly from storage (`srOff`). */
  get local(): boolean {
    return !!this.#want && !!this.mail?.local;
  }

  /** The response to the wanted query is pending. */
  get loading(): boolean {
    return !!this.#want && this.mail?.key !== this.#want;
  }

  /** No hits to show at all yet (skeleton instead of results). */
  get pending(): boolean {
    return this.loading && !this.mail;
  }

  /**
   * Aligns the server query with search text, filters and accounts (effect of the
   * page). Messages are only searched if a word, a filter for
   * messages or an area is set, the areas include messages or
   * attachments, and an account can find something; every change
   * waits `SEARCH_DELAY`, except after `open()` and `searchFrom()`.
   */
  sync(): void {
    const eff = this.effective();
    const { raw } = eff.terms;
    const cats = eff.cats;
    const queries = [...eff.queries].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
    const need =
      (raw.length > 0 || eff.mailF || cats.length > 0) &&
      (!cats.length || cats.includes('mail') || cats.includes('files')) &&
      queries.length > 0;
    const key = need ? JSON.stringify(queries) : '';
    if (key === this.#want) {
      // The same query opened again: the flag does not apply to the next typing.
      if (key) this.#now = false;
      return;
    }
    const soon = this.#now;
    this.#now = false;
    this.#want = key;
    clearTimeout(this.#timer);
    const gen = ++this.#gen;
    this.loadingMore = false;
    if (!key) {
      if (this.mail) this.#parked = this.mail;
      this.mail = null;
      return;
    }
    // Back from a local area or to the search: the hits are there again immediately, the query
    // refreshes them as far as they were loaded, so that loaded pages do not disappear.
    const back = !this.mail && this.#parked?.key === key ? this.#parked : null;
    if (back) this.mail = back;
    this.#parked = null;
    const extent: Record<string, number> = {};
    if (back) for (const [account, p] of Object.entries(back.pages)) extent[account] = p.loaded;
    this.#timer = setTimeout(() => void this.#load(gen, key, queries, raw, extent), soon ? 0 : SEARCH_DELAY);
  }

  /** Online again: refetch hits from storage from the server; the displayed ones stay until the response. */
  resume(): void {
    const cur = this.mail;
    if (!cur?.local || cur.key !== this.#want) return;
    const list = Object.entries(cur.queries).map(([account, q]) => ({ account, filter: q.filter }));
    void this.#load(++this.#gen, cur.key, list, cur.words);
  }

  /**
   * First page of an account: from the server, without a response from storage.
   * With `extent` further pages up to that many positions (hits loaded before);
   * if one of them fails, the pages so far apply.
   */
  async #page(account: string, query: MailQuery, words: readonly string[], extent = 0): Promise<MailPage> {
    let first: MailPage;
    try {
      first = await this.#api.page(account, query, 0, MAIL_PAGE);
    } catch (error) {
      if (!isOffline(error)) throw error;
      return localPage(await this.#saved(account), account, query.filter, words);
    }
    const out = { ...first, hits: [...first.hits] };
    while (out.positions < extent && first.positions > 0 && out.total != null && out.positions < out.total) {
      try {
        first = await this.#api.page(account, query, out.positions, MAIL_PAGE);
      } catch {
        break;
      }
      out.hits.push(...first.hits);
      out.positions += first.positions;
      out.total = first.total;
    }
    return out;
  }

  async #load(
    gen: number,
    key: string,
    list: readonly AccountQuery[],
    words: readonly string[],
    extent: Readonly<Record<string, number>> = {},
  ): Promise<void> {
    const snippets = words.length > 0;
    const queries: Record<string, MailQuery> = {};
    for (const q of list) queries[q.account] = { filter: q.filter, snippets };
    const got = await Promise.allSettled(
      list.map((q) => this.#page(q.account, queries[q.account]!, words, extent[q.account])),
    );
    if (gen !== this.#gen) return;
    const pages: Record<string, AccountPage> = {};
    const hits: MailHit[] = [];
    let failed: unknown = null;
    let local = false;
    got.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed ??= r.reason;
        return;
      }
      pages[list[i]!.account] = after(0, r.value);
      hits.push(...r.value.hits);
      local ||= !!r.value.local;
    });
    this.mail = { key, queries, words, hits: hits.sort(byReceived), pages, local };
    if (failed && !this.#failed) ui.toasts.error(failText(failed));
    this.#failed = !!failed;
  }

  /** Loads more messages as long as an account has more (area messages only). */
  async more(): Promise<void> {
    const cur = this.mail;
    if (!cur || this.loadingMore || cur.key !== this.#want) return;
    const open = Object.entries(cur.pages).filter(([, p]) => p.total != null && p.loaded < p.total);
    if (!open.length) return;
    const gen = this.#gen;
    this.loadingMore = true;
    const got = await Promise.allSettled(open.map(([a, p]) => this.#api.page(a, cur.queries[a]!, p.loaded, MAIL_PAGE)));
    if (gen !== this.#gen || this.mail !== cur) return;
    this.loadingMore = false;
    const pages = { ...cur.pages };
    const seen = cur.hits.map((h) => `${h.account}/${h.id}`);
    const hits = [...cur.hits];
    let failed: unknown = null;
    got.forEach((r, i) => {
      const [a, p] = open[i]!;
      if (r.status === 'rejected') {
        failed ??= r.reason;
        return;
      }
      pages[a] = after(p.loaded, r.value);
      for (const h of r.value.hits) if (!seen.includes(`${h.account}/${h.id}`)) hits.push(h);
    });
    this.mail = { ...cur, hits: hits.sort(byReceived), pages };
    if (failed) ui.toasts.error(failText(failed));
  }

  /**
   * Opens results (Enter, palette, `openResults`): takes over and
   * remembers the text; set filters stay (left results have already
   * reset them). From the search suggestions (`fromSuggestions`) the
   * results under "Nur in …" take the area along as a filter (`openResults`
   * with `ctx.p`); the palette searches everywhere, its text never applied to the area.
   */
  open(q: string, back: string | null, fromSuggestions = false): void {
    if (fromSuggestions) this.sf = scoped(this.sf, this.here);
    this.q = q;
    this.back = back;
    this.#anchor = Date.now();
    this.#now = true;
    this.remember(q);
  }

  /** Messages of a contact: only "From", area messages, without text. */
  searchFrom(email: string): void {
    this.q = '';
    this.sf = { ...SF0, from: email, cats: ['mail'] };
    this.#anchor = Date.now();
    this.#now = true;
  }

  /** "Clear filters" (`setSf(SF0)`): also the areas. */
  clearFilters(): void {
    this.sf = SF0;
    this.#anchor = Date.now();
  }

  /**
   * Fetches the counters of the "Quick access" tiles across all ready accounts
   * (on mobile when idle), at most every `TILE_TTL` and anew as soon as the
   * accounts or the day change. If an account fails, the others count.
   */
  async loadTiles(now: number = Date.now()): Promise<void> {
    const env = this.env;
    const list = env.accounts.map((a) => a.id);
    const key = JSON.stringify([list, zoneDayStart(now, env.tz)]);
    if (key === this.#tilesKey && now - this.#tilesAt < TILE_TTL) return;
    this.#tilesKey = key;
    this.#tilesAt = now;
    const seq = ++this.#tilesSeq;
    await this.#prepare(list);
    // Signed out or already requested anew: these counters no longer apply.
    if (seq !== this.#tilesSeq) return;
    const got = await Promise.allSettled(
      list.map((a) =>
        this.#api.counts(
          a,
          tileFilters([...this.env.folderBoxes('role:trash', a), ...this.env.folderBoxes('role:spam', a)], now, env.tz),
        ),
      ),
    );
    if (seq !== this.#tilesSeq) return;
    const sums: (number | null)[] = TILES.map(() => null);
    for (const r of got) {
      if (r.status !== 'fulfilled') continue;
      r.value.forEach((n, i) => {
        if (n != null) sums[i] = (sums[i] ?? 0) + n;
      });
    }
    this.tileCounts = sums;
  }

  /** Closes results: filters back, the text stays; returns the way back. */
  close(): string | null {
    this.clearFilters();
    this.panelOver = false;
    const back = this.back;
    this.back = null;
    return back;
  }

  /**
   * A hit was opened: remember the search, clear text and filters. The
   * way back stays because a contact stays on the search page (`searchFrom`).
   */
  done(): void {
    this.remember(this.q);
    this.q = '';
    this.clearFilters();
    this.panelOver = false;
  }

  /** The search as it is now, for the return path. */
  snapshot(): SearchSnapshot {
    return { q: this.q, sf: this.sf, scope: this.scope, back: this.back, anchor: this.#anchor };
  }

  /**
   * A hit is about to run (before `done()`): the navigation it starts
   * synchronously becomes the return path (`navigating()`). A hit that
   * does not navigate (contact, action) leaves none: the expectation
   * ends with the current task, the navigation starts within its microtasks.
   */
  expectReturn(kind: ReturnKind, snap: SearchSnapshot = this.snapshot()): void {
    this.#pending = { kind, snap };
    clearTimeout(this.#pendingTimer);
    this.#pendingTimer = setTimeout(() => (this.#pending = null), 0);
  }

  /**
   * A navigation to `path` starts. After a hit it becomes the return
   * path, if the target can have one (`navTarget`: an open message or
   * a view other than a mailbox list, start or search); otherwise it ends
   * a return path whose target it leaves (J/K, another page).
   */
  navigating(path: string, returnable: boolean): void {
    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(this.#pendingTimer);
    if (pending) this.ret = returnable ? { kind: pending.kind, target: path, snap: pending.snap } : null;
    else this.arrived(path);
  }

  /** A navigation ended at `path`: the return path applies only at its target. */
  arrived(path: string): void {
    if (this.ret && this.ret.target !== path) this.ret = null;
  }

  /** Return path that applies at `path` (`navHere()`). */
  returnAt(path: string): SearchReturn | null {
    return this.ret?.target === path ? this.ret : null;
  }

  /**
   * Back to the search (`navBack()`): restores text, filters, area and way
   * back of the results; the hits come again with the same query. `false`
   * if no return path applies at `path` (it is discarded).
   */
  takeReturn(path: string): boolean {
    const r = this.returnAt(path);
    this.ret = null;
    if (!r) return false;
    const { snap } = r;
    this.q = snap.q;
    this.sf = snap.sf;
    this.scope = snap.scope;
    this.back = snap.back;
    this.#anchor = snap.anchor;
    this.panelOver = false;
    this.#now = true;
    return true;
  }

  remember(q: string): void {
    const t = q.trim();
    if (!t) return;
    this.recent = [t, ...this.recent.filter((r) => r !== t)].slice(0, RECENT_MAX);
  }

  forget(q: string): void {
    this.recent = this.recent.filter((r) => r !== q);
  }

  /** Sign-out: discard everything. */
  reset(): void {
    clearTimeout(this.#timer);
    this.#gen++;
    this.#want = '';
    this.#now = false;
    this.#parked = null;
    this.#failed = false;
    this.#pending = null;
    clearTimeout(this.#pendingTimer);
    this.ret = null;
    this.q = '';
    this.sf = SF0;
    this.recent = [];
    this.back = null;
    this.mail = null;
    this.loadingMore = false;
    this.tileCounts = null;
    this.#envGen++;
    this.panelHidden = false;
    this.panelOver = false;
    this.scope = 'here';
    this.context = null;
    this.#tilesKey = '';
    this.#tilesAt = 0;
    this.#tilesSeq++;
  }
}

export const search = new Search();
