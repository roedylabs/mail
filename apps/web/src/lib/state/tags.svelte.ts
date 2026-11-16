/**
 * State module `tags`: the user's tags
 * from `GET tags` with their links (per mail account one mailbox below
 * the root "Tags"). The browser determines color and counters: color
 * `color`, otherwise the parent tag's, otherwise 0; counters as the sum of the
 * linked mailboxes of the tag and its subtags across the accounts of the
 * view. `tagProblems()` finds links that no longer fit and tag mailboxes
 * without a link; `fix()` resolves a case on click via
 * JMAP and the tags API. Creating, changing and deleting carry
 * the mailboxes in the reachable accounts along; `list` shows pending changes
 * as a layer over the server's state (`stage()`).
 */
import type { Id, JmapClient, Mailbox, PatchObject, SetArgs } from '@roedy/jmap';
import { MA_COLORS } from '@roedy/tokens';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { api, ApiError, fieldsOf } from '#lib/api.ts';
import type { MailStore } from '#lib/mail-store.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import {
  countsOf,
  mailboxes,
  sameName,
  sumCounts,
  TAG_ROOT,
  tagMailboxIds,
  tagRoot,
  type Counts,
} from '#lib/state/mailboxes.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/** Mailbox of a tag in a mail account. */
export interface TagLink {
  mail_account_id: string;
  mailbox_id: Id;
}

/** Tag from `GET tags`: flat, every tag before its subtags, per level by `position`. */
export interface Tag {
  id: string;
  name: string;
  /** `null` = top level. */
  parent_id: string | null;
  /** Index into `MA_COLORS`, `null` = color of the parent tag. */
  color: number | null;
  position: number;
  links: TagLink[];
  created_at: string;
}

/** Tag in the tree of the tag list; counters over the tag and its subtags. */
export interface TagNode extends Counts {
  id: string;
  name: string;
  /** Index into `MA_COLORS`: own color, otherwise the parent tag's, otherwise 0. */
  color: number;
  children: TagNode[];
}

/**
 * Link or mailbox that do not fit together, e.g. after a
 * change in another program. Paths are complete, with the name
 * of the mailbox ("Archiv/Nachfassen"):
 * - `missing`: the linked mailbox no longer exists.
 * - `outside`: the linked mailbox does not lie (any more) below "Tags".
 * - `renamed`: name (`name`) and/or location (`path`) of the mailbox differ from the tag; the other is `null`.
 * - `unlinked`: mailbox below "Tags" that no tag links; only the topmost,
 *   `kids` counts the mailboxes without a tag below it. `parent` is the tag at its
 *   location (`null`: top level), `link` a tag of the same name there that has
 *   no mailbox in this account (link with it instead of creating anew).
 */
export type TagProblem =
  | { kind: 'missing'; account: string; tag: string; mailbox: Id }
  | { kind: 'outside'; account: string; tag: string; mailbox: Id; path: string }
  | { kind: 'renamed'; account: string; tag: string; mailbox: Id; name: string | null; path: string | null }
  | {
      kind: 'unlinked';
      account: string;
      mailbox: Id;
      name: string;
      path: string;
      kids: number;
      parent: string | null;
      link: string | null;
    };

/** Action of the sync; `adopt` links with `link` if it exists. */
export type TagFix = 'unlink' | 'back' | 'align' | 'take' | 'adopt' | 'toFolder';

/** Key of a case, unique across the accounts. */
export function problemKey(p: TagProblem): string {
  return `${p.account}:${p.kind}:${p.kind === 'unlinked' ? p.mailbox : p.tag}`;
}

/**
 * Pending change of a tag during the toast:
 * hidden (with all subtags), or new name, parent tag and color.
 */
export type TagStage =
  { hide: readonly string[] } | { id: string; name: string; parent_id: string | null; color: number | null };

/** Change for `PATCH tags/:id`; only the changed fields. */
export interface TagPatch {
  name?: string;
  parent_id?: string | null;
  color?: number | null;
}

/** Sync rejected before anything changed: at that location there already is a tag or folder of this name. */
export class TagFixError extends Error {
  readonly reason: 'tag' | 'folder';
  readonly label: string;

  constructor(reason: 'tag' | 'folder', label: string) {
    super(`${reason} exists: ${label}`);
    this.name = 'TagFixError';
    this.reason = reason;
    this.label = label;
  }
}

/** Compares names like the backend: NFC, case-insensitive. */
const same = sameName;

/* eslint-disable svelte/prefer-svelte-reactivity -- local helper values of pure functions, not state */

/** Mailboxes of an account, as the tags need them. */
interface TagBoxes {
  byId: Map<Id, Mailbox>;
  /** Root "Tags". */
  root: Id | null;
  /** Mailboxes below the root, without itself. */
  below: Set<Id>;
}

function tagBoxes(list: readonly Mailbox[]): TagBoxes {
  const root = tagRoot(list)?.id ?? null;
  const below = tagMailboxIds(list);
  if (root) below.delete(root);
  return { byId: new Map(list.map((b) => [b.id, b])), root, below };
}

/**
 * Tree of the tags with colors and counters. `boxes` contains the mailboxes of the
 * accounts of the view (account ID → mailboxes); links of other accounts, to
 * missing mailboxes and to mailboxes outside "Tags" do not count.
 * A counter counts conversations per mailbox; if one is in
 * several tags of a branch, it counts several times.
 */
export function tagTree(list: readonly Tag[], boxes: Readonly<Record<string, readonly Mailbox[]>> = {}): TagNode[] {
  if (!list.length) return [];
  const index = new Map(Object.entries(boxes).map(([account, l]) => [account, tagBoxes(l)]));
  const own = (tag: Tag): Counts | null =>
    sumCounts(
      tag.links.map((l) => {
        const at = index.get(l.mail_account_id);
        const box = at?.below.has(l.mailbox_id) ? at.byId.get(l.mailbox_id) : undefined;
        return box ? countsOf(box) : null;
      }),
    );
  const ids = new Set(list.map((t) => t.id));
  const kids = new Map<string | null, Tag[]>();
  for (const t of list) {
    // Unknown parent tag (not from the backend): top level instead of disappearing.
    const parent = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    const siblings = kids.get(parent);
    if (siblings) siblings.push(t);
    else kids.set(parent, [t]);
  }
  // From the top level the tree reaches no cycle (the backend rejects it anyway).
  const build = (parent: string | null, inherited: number): TagNode[] =>
    (kids.get(parent) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((t) => {
        const color = (t.color ?? inherited) % MA_COLORS.length;
        const children = build(t.id, color);
        const counts = own(t);
        return {
          id: t.id,
          name: t.name,
          color,
          unread: (counts?.unread ?? 0) + children.reduce((n, k) => n + k.unread, 0),
          total: (counts?.total ?? 0) + children.reduce((n, k) => n + k.total, 0),
          children,
        };
      });
  return build(null, 0);
}

/** Full path of a mailbox, with protection against cycles in `parentId`. */
export function mailboxPath(byId: ReadonlyMap<Id, Mailbox>, box: Mailbox): string {
  const names: string[] = [];
  const seen = new Set<Id>();
  for (let b: Mailbox | undefined = box; b && !seen.has(b.id); b = b.parentId ? byId.get(b.parentId) : undefined) {
    seen.add(b.id);
    names.unshift(b.name);
  }
  return names.join('/');
}

/** Ancestors of a mailbox by `parentId`, the nearest first, with protection against cycles. */
function ancestors(byId: ReadonlyMap<Id, Mailbox>, id: Id): Id[] {
  const out: Id[] = [];
  let p = byId.get(id)?.parentId ?? null;
  while (p !== null && p !== id && !out.includes(p)) {
    out.push(p);
    p = byId.get(p)?.parentId ?? null;
  }
  return out;
}

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** Mailbox of the tag in an account, otherwise `undefined`. */
const linkIn = (t: Tag, account: string): Id | undefined =>
  t.links.find((l) => l.mail_account_id === account)?.mailbox_id;

/**
 * Mailboxes of a tag and its subtags in an account (list of a
 * tag); as with the counter only links to mailboxes below "Tags".
 * Empty if the tag does not exist.
 */
export function tagListBoxes(list: readonly Tag[], tag: string, account: string, boxes: readonly Mailbox[]): Id[] {
  const { below } = tagBoxes(boxes);
  const kids = new Map<string, Tag[]>();
  for (const t of list) if (t.parent_id) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
  const out: Id[] = [];
  const seen = new Set<string>();
  const walk = (t: Tag | undefined) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    const id = linkIn(t, account);
    if (id && below.has(id)) out.push(id);
    for (const k of kids.get(t.id) ?? []) walk(k);
  };
  walk(list.find((t) => t.id === tag));
  return out;
}

/** Tag on a mailbox: id, name, color (index into `MA_COLORS`) and position in the tag list. */
export interface TagRef {
  id: string;
  name: string;
  color: number;
  rank: number;
}

/** Tag per linked mailbox of an account, with its color (tags on the rows of the list). */
export function tagsByMailbox(list: readonly Tag[], account: string, boxes: readonly Mailbox[]): Map<Id, TagRef> {
  const { below } = tagBoxes(boxes);
  const nodes = new Map<string, { color: number; rank: number }>();
  const walk = (level: TagNode[]) => {
    for (const n of level) {
      nodes.set(n.id, { color: n.color, rank: nodes.size });
      walk(n.children);
    }
  };
  walk(tagTree(list));
  const out = new Map<Id, TagRef>();
  for (const t of list) {
    const id = linkIn(t, account);
    const n = nodes.get(t.id);
    if (id && below.has(id)) out.set(id, { id: t.id, name: t.name, color: n?.color ?? 0, rank: n?.rank ?? nodes.size });
  }
  return out;
}

/** Tag `id` and all subtags (empty if it does not exist). */
export function tagBranch(list: readonly Tag[], id: string): Set<string> {
  const out = new Set(list.some((t) => t.id === id) ? [id] : []);
  for (let grew = out.size > 0; grew;) {
    grew = false;
    for (const t of list)
      if (t.parent_id !== null && out.has(t.parent_id) && !out.has(t.id)) {
        out.add(t.id);
        grew = true;
      }
  }
  return out;
}

/**
 * Tags with the pending changes (`stage()`): hidden ones drop out with
 * their subtags (otherwise `tagTree()` would put them at the top); a
 * moved tag goes to the end of its new level like `nameCommit`.
 */
export function applyTagStages(list: Tag[] | null, stages: readonly TagStage[]): Tag[] | null {
  if (!list || !stages.length) return list;
  let out = list;
  for (const s of stages) {
    if ('hide' in s) {
      const gone = new Set(s.hide.flatMap((id) => [...tagBranch(out, id)]));
      out = out.filter((t) => !gone.has(t.id));
    } else
      out = out.map((t) =>
        t.id !== s.id
          ? t
          : {
              ...t,
              name: s.name,
              color: s.color,
              ...(t.parent_id === s.parent_id ? {} : { parent_id: s.parent_id, position: Number.MAX_SAFE_INTEGER }),
            },
      );
  }
  return out;
}

/** Links and tag mailboxes of an account that do not fit together; `list` are its mailboxes. */
export function tagProblems(tags: readonly Tag[], account: string, list: readonly Mailbox[]): TagProblem[] {
  const { byId, root, below } = tagBoxes(list);
  const linkOf = new Map<string, Id>();
  for (const t of tags) {
    const link = linkIn(t, account);
    if (link) linkOf.set(t.id, link);
  }
  const problems: TagProblem[] = [];
  for (const t of tags) {
    const mailbox = linkOf.get(t.id);
    if (mailbox === undefined) continue;
    const box = byId.get(mailbox);
    if (!box) problems.push({ kind: 'missing', account, tag: t.id, mailbox });
    else if (!below.has(mailbox))
      problems.push({ kind: 'outside', account, tag: t.id, mailbox, path: mailboxPath(byId, box) });
    else {
      // Location only checkable if the parent tag has a fitting mailbox below "Tags" in this account
      // (top level: the root); a broken link of the parent tag reports itself.
      const up = t.parent_id === null ? root : linkOf.get(t.parent_id);
      const parent = up && (up === root || below.has(up)) ? up : undefined;
      const moved = parent !== undefined && box.parentId !== parent;
      const renamed = box.name.normalize('NFC') !== t.name;
      if (moved || renamed)
        problems.push({
          kind: 'renamed',
          account,
          tag: t.id,
          mailbox,
          name: renamed ? box.name : null,
          path: moved ? mailboxPath(byId, box) : null,
        });
    }
  }
  const linked = new Set(linkOf.values());
  const loose = new Set([...below].filter((id) => !linked.has(id)));
  const tagAt = new Map([...linkOf].map(([t, m]) => [m, t]));
  // Mailboxes without a tag below a mailbox without a tag count with the topmost; every chain ends at the root.
  const top = (id: Id): Id => {
    let at = id;
    for (let up = byId.get(at)?.parentId; up && loose.has(up); up = byId.get(at)?.parentId) at = up;
    return at;
  };
  const kids = new Map<Id, number>();
  for (const id of loose) {
    const t = top(id);
    if (t !== id) kids.set(t, (kids.get(t) ?? 0) + 1);
  }
  for (const id of loose) {
    const box = byId.get(id);
    if (!box || top(id) !== id) continue;
    const parent = box.parentId === root ? null : ((box.parentId && tagAt.get(box.parentId)) ?? null);
    const named = tags.find((t) => t.parent_id === parent && same(t.name, box.name));
    const free = named && !byId.has(linkOf.get(named.id) ?? '');
    problems.push({
      kind: 'unlinked',
      account,
      mailbox: id,
      name: box.name,
      path: mailboxPath(byId, box),
      kids: kids.get(id) ?? 0,
      parent,
      link: free ? named.id : null,
    });
  }
  return problems;
}

/* eslint-enable svelte/prefer-svelte-reactivity */

/** Mailboxes of an account as soon as they are loaded; otherwise `null`. */
type BoxesOf = (account: string) => readonly Mailbox[] | null;
type StoreOf = () => Pick<MailStore, 'tags' | 'saveTags'> | null;

/** JMAP for the sync: client of an account and sync of its mailboxes afterwards. */
export interface TagJmap {
  client: (account: string) => Promise<JmapClient>;
  sync: (account: string) => Promise<void>;
  /** Loads mailboxes if needed (changing and deleting across all accounts). */
  ensure?: (account: string) => Promise<void>;
  /** Account the browser may reach (not "sign-in required", not blocked). */
  usable?: (account: string) => boolean;
  /**
   * Deletes a mailbox with everything below (`Mailboxes.remove()`): whatever afterwards lies
   * in no mailbox except tags goes to the inbox.
   */
  remove?: (account: string, mailbox: Id) => Promise<void>;
}

const JMAP: Required<TagJmap> = {
  client: (account) => accounts.client(account),
  sync: (account) => mailboxes.sync(account),
  ensure: (account) => mailboxes.ensure(account),
  usable: (account) => accounts.list?.some((a) => a.id === account && a.state === 'ok' && !a.blocked) ?? false,
  remove: (account, mailbox) => {
    const tagged = tagMailboxIds(mailboxes.list(account));
    return mailboxes.remove(account, mailbox, mailboxes.role(account, 'inbox')?.id ?? null, (box) => tagged.has(box));
  },
};

/** State of an account during an action of the sync. */
interface FixContext {
  account: string;
  tags: Tag[];
  byId: Map<Id, Mailbox>;
  root: Id | null;
  below: Set<Id>;
  /** Already written (API or JMAP): reload afterwards. */
  wrote: boolean;
  /** Accounts whose mailboxes have changed. */
  touched: string[];
}

export class Tags {
  /** State of the server; `null` while unknown (before the first load, signed out). */
  #data = $state.raw<Tag[] | null>(null);
  /** Pending changes (`stage()`), in the order they arose. */
  #stages = $state.raw<readonly { token: number; stage: TagStage }[]>([]);
  #stageToken = 0;
  /**
   * Tags as the view shows them: the server's state with the
   * pending changes; `null` while unknown. The sync
   * (`problems()`, `fix()`) works on the server's state.
   */
  readonly list = $derived(
    applyTagStages(
      this.#data,
      this.#stages.map((s) => s.stage),
    ),
  );
  /** The last load failed (a tag's list then stops waiting). */
  failed = $state(false);
  /** Expanded tags, shared by all accounts. */
  readonly open = new SvelteSet<string>();
  /** Running sync actions per case (`problemKey()`). */
  readonly busy = new SvelteMap<string, TagFix>();

  readonly #boxes: BoxesOf;
  readonly #jmap: Required<TagJmap>;
  readonly #store: StoreOf;
  #seq = 0;
  #loading: Promise<void> | null = null;
  /** Sync actions run one after another, each on the state after the previous one (`PUT` replaces links entirely). */
  #fixes: Promise<unknown> = Promise.resolve();
  /** Counts sign-outs; an action from before loads nothing more. */
  #gen = 0;

  constructor(
    boxes: BoxesOf = (account) => (mailboxes.of(account)?.status === 'ready' ? mailboxes.list(account) : null),
    jmap: TagJmap = JMAP,
    store: StoreOf = () => session.mailStore,
  ) {
    this.#boxes = boxes;
    this.#jmap = { ...JMAP, ...jmap };
    this.#store = store;
  }

  /** Tree of the tag list with the counters of the view's accounts (whose mailboxes are already loaded). */
  tree(accounts: readonly string[]): TagNode[] {
    const boxes: Record<string, readonly Mailbox[]> = {};
    for (const account of accounts) {
      const list = this.#boxes(account);
      if (list) boxes[account] = list;
    }
    return tagTree(this.list ?? [], boxes);
  }

  /** Mailboxes of a tag's list in an account; `null` while tags or mailboxes are unknown. */
  listBoxes(tag: string, account: string): Id[] | null {
    const list = this.#boxes(account);
    return this.list && list ? tagListBoxes(this.list, tag, account, list) : null;
  }

  /** Tags of an account's mailboxes; empty while tags or mailboxes are unknown. */
  byMailbox(account: string): Map<Id, TagRef> {
    const list = this.#boxes(account);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- return value, not state
    return this.list && list ? tagsByMailbox(this.list, account, list) : new Map<Id, TagRef>();
  }

  /**
   * Problems of an account's links; empty while tags or
   * mailboxes are unknown. Tags with a pending change (`stage()`)
   * are missing: their mailboxes only follow after the toast.
   */
  problems(account: string): TagProblem[] {
    const list = this.#boxes(account);
    if (!this.#data || !list) return [];
    const data = this.#data;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const pending = new Set(
      this.#stages.flatMap(({ stage }) =>
        'hide' in stage ? stage.hide.flatMap((id) => [...tagBranch(data, id)]) : [stage.id],
      ),
    );
    return tagProblems(data, account, list).filter((p) => p.kind === 'unlinked' || !pending.has(p.tag));
  }

  /** Shows a pending change; `unstage()` with the returned token removes it again. */
  stage(stage: TagStage): number {
    const token = ++this.#stageToken;
    this.#stages = [...this.#stages, { token, stage }];
    return token;
  }

  unstage(token: number): void {
    this.#stages = this.#stages.filter((s) => s.token !== token);
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  toggle(id: string): void {
    if (!this.open.delete(id)) this.open.add(id);
  }

  /** Loads the tags if they are still unknown; a running load counts. */
  ensure(): Promise<void> {
    if (this.#data !== null) return Promise.resolve();
    if (!this.#loading) {
      const loading = this.load().finally(() => {
        if (this.#loading === loading) this.#loading = null;
      });
      this.#loading = loading;
    }
    return this.#loading;
  }

  /**
   * Loads the tags with their links; until the response storage applies;
   * if that fails after reading from storage, it stays silent.
   * Responses and errors of an older call (also before sign-out) expire.
   */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const store = this.#store();
    let restored = false;
    if (store && this.#data === null) {
      const saved = await store.tags<Tag>();
      if (seq !== this.#seq) return;
      if (saved && this.#data === null) {
        this.#data = saved;
        restored = true;
      }
    }
    let res: { tags: Tag[] };
    try {
      res = await api<{ tags: Tag[] }>('GET', 'tags');
    } catch (error) {
      if (seq !== this.#seq || restored) return;
      this.failed = true;
      throw error;
    }
    if (seq !== this.#seq) return;
    this.#data = res.tags;
    this.failed = false;
    this.#store()?.saveTags(res.tags);
  }

  /**
   * Takes over the server's state after an own change without
   * reloading; an older load still running expires. Before the first load
   * it stays unknown (`ensure()` then loads).
   */
  #put(tags: Tag[]): void {
    if (this.#data === null) return;
    this.#seq++;
    this.#data = tags;
    this.#store()?.saveTags(tags);
  }

  /**
   * New tag (`POST tags`): at the end of its level, still without a
   * mailbox – it arises on the first assignment. Runs after the
   * actions before it (e.g. deleting a tag of the same name), no longer after
   * sign-out; the tag is in the list right away.
   */
  create(name: string, parent: string | null, color: number): Promise<Tag> {
    const gen = this.#gen;
    const run = this.#fixes.then(async () => {
      if (gen !== this.#gen) throw new Error('Signed out');
      const tag = await api<Tag>('POST', 'tags', { name: name.normalize('NFC'), parent_id: parent, color });
      if (gen === this.#gen && this.#data && !this.#data.some((t) => t.id === tag.id)) this.#put([...this.#data, tag]);
      return tag;
    });
    this.#fixes = run.catch(() => undefined);
    return run;
  }

  /**
   * Changes a tag (`PATCH tags/:id`; name, parent tag and color in one
   * statement), then aligns its mailboxes in the reachable
   * accounts: new name, moved to the location of the new
   * parent tag (missing locations arise as on the first assignment). If
   * that fails in an account, the sync reports the mailbox there.
   * `PATCH` goes out immediately (with `keepalive` also when leaving the
   * page); the alignment runs in the sync's queue.
   */
  edit(id: string, patch: TagPatch, keepalive = false): Promise<void> {
    const gen = this.#gen;
    const body = patch.name === undefined ? patch : { ...patch, name: patch.name.normalize('NFC') };
    const sent = api<Tag>('PATCH', `tags/${id}`, body, { keepalive });
    const run = Promise.all([sent, this.#fixes]).then(([tag]) => this.#edited(tag, patch, gen));
    this.#fixes = run.catch(() => undefined);
    return run;
  }

  async #edited(tag: Tag, patch: TagPatch, gen: number): Promise<void> {
    if (gen !== this.#gen || !this.#data) return;
    // Own list: `PUT …/links` when creating a location replaces entries in it, not in the state.
    const tags = this.#data.map((t) => (t.id === tag.id ? tag : t));
    const touched: string[] = [];
    if (patch.name !== undefined || patch.parent_id !== undefined)
      for (const l of tag.links)
        // If an account fails, the sync reports the mailbox there as renamed.
        await this.#follow(tag, l.mail_account_id, tags, patch.parent_id !== undefined, touched).catch(() => undefined);
    if (gen !== this.#gen) return;
    // The server's state: the changed tag and new links of the parent tags; reloading is not needed.
    this.#put(tags);
    await Promise.allSettled(unique(touched).map((a) => this.#jmap.sync(a)));
  }

  /** Aligns the mailbox of tag `t` in an account with name and (`moved`) location of the tag. */
  async #follow(t: Tag, account: string, tags: Tag[], moved: boolean, touched: string[]): Promise<void> {
    if (!this.#jmap.usable(account)) return;
    await this.#jmap.ensure(account);
    const list = this.#boxes(account);
    const id = linkIn(t, account);
    if (!list || id === undefined) return;
    const { byId, root, below } = tagBoxes(list);
    const box = byId.get(id);
    // If it is missing or lies outside "Tags", that is left to the sync.
    if (!box || !below.has(box.id)) return;
    // The same list for all accounts: `PUT …/links` replaces all links, the next account needs the new ones.
    const c: FixContext = { account, tags, byId, root, below, wrote: false, touched };
    const parent = moved ? await this.#place(c, t.parent_id) : box.parentId;
    if (parent === box.parentId && box.name === t.name) return;
    this.#free(c, parent, t.name, box.id);
    await this.#update(c, box.id, { parentId: parent, name: t.name });
  }

  /**
   * Subtags and messages of a tag for the confirmation before deleting:
   * emails in the branch's mailboxes below "Tags" in the reachable
   * accounts, whose mailboxes are loaded for it (`totalEmails`; if an
   * email lies in two of them, it counts twice as when deleting folders).
   */
  async usage(id: string): Promise<{ sub: number; mails: number }> {
    const list = this.list ?? [];
    const branch = tagBranch(list, id);
    const tags = list.filter((t) => branch.has(t.id));
    const accounts = unique(tags.flatMap((t) => t.links.map((l) => l.mail_account_id))).filter((a) =>
      this.#jmap.usable(a),
    );
    await Promise.allSettled(accounts.map((a) => this.#jmap.ensure(a)));
    let mails = 0;
    for (const account of accounts) {
      const boxes = this.#boxes(account);
      if (!boxes) continue;
      const { byId, below } = tagBoxes(boxes);
      for (const t of tags) {
        const box = linkIn(t, account);
        if (box !== undefined && below.has(box)) mails += byId.get(box)?.totalEmails ?? 0;
      }
    }
    return { sub: Math.max(branch.size - 1, 0), mails };
  }

  /**
   * Deletes a tag with all subtags according to the
   * server's state at sending: per reachable account the mailboxes of the
   * branch below "Tags" with everything below them (the emails lose the tag,
   * whatever afterwards lies in no mailbox except tags goes to the
   * inbox), then `DELETE tags/:id`. If the mailbox of another tag lies below or
   * mailboxes are missing, it fails before anything
   * changes; if an account fails afterwards, the tag stays, and whatever was already
   * deleted is reported by the sync. If the tag no longer exists, nothing
   * remains to do.
   */
  remove(id: string): Promise<void> {
    const gen = this.#gen;
    const run = this.#fixes.then(() => this.#remove(id, gen));
    this.#fixes = run.catch(() => undefined);
    return run;
  }

  async #remove(id: string, gen: number): Promise<void> {
    if (gen !== this.#gen) return;
    await this.load();
    const list = this.#data ?? [];
    const branch = tagBranch(list, id);
    if (!branch.size) return;
    const tags = list.filter((t) => branch.has(t.id));
    const accounts = unique(tags.flatMap((t) => t.links.map((l) => l.mail_account_id))).filter((a) =>
      this.#jmap.usable(a),
    );
    await Promise.all(accounts.map((a) => this.#jmap.ensure(a)));
    const plan = accounts.map((account) => {
      const boxes = this.#boxes(account);
      if (!boxes) throw new Error('Mailboxes unknown');
      const { byId, below } = tagBoxes(boxes);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
      const doomed = new Set(tags.flatMap((t) => linkIn(t, account) ?? []).filter((b) => below.has(b)));
      // Only the topmost: `remove` takes everything below along.
      const tops = [...doomed].filter((b) => !ancestors(byId, b).some((a) => doomed.has(a)));
      // The mailbox of another tag below (e.g. moved there via IMAP) would be lost along with it.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
      const foreign = new Set(list.filter((t) => !branch.has(t.id)).flatMap((t) => linkIn(t, account) ?? []));
      if (boxes.some((b) => foreign.has(b.id) && ancestors(byId, b.id).some((a) => tops.includes(a))))
        throw new Error('Mailbox of another tag in the branch');
      return { account, tops };
    });
    try {
      for (const { account, tops } of plan) for (const top of tops) await this.#jmap.remove(account, top);
      await api('DELETE', `tags/${id}`);
    } finally {
      if (gen === this.#gen) await this.load().catch(() => undefined);
    }
  }

  /**
   * Resolves a case of the sync. Actions run one after another;
   * afterwards tags and the changed mailboxes reload, also after an
   * error, because part of the steps may already have run. A second
   * action for the same case is dropped, as is one for a case that a
   * previous one already resolved (`false`). `TagFixError` if a tag or folder
   * of the same name already stands at that location.
   */
  fix(problem: TagProblem, action: TagFix): Promise<boolean> {
    const key = problemKey(problem);
    if (this.busy.has(key)) return Promise.resolve(false);
    this.busy.set(key, action);
    const gen = this.#gen;
    const run = this.#fixes.then(() => this.#run(problem, action, gen));
    this.#fixes = run.catch(() => undefined);
    return run.finally(() => {
      if (gen === this.#gen) this.busy.delete(key);
    });
  }

  /**
   * Mailbox of tag `tag` in the account for the first assignment: a linked one below "Tags" as it is, otherwise
   * it arises at the tag's location – with the root "Tags" and the
   * mailboxes of the parent tags where they are missing; a mailbox of the same name without a
   * tag at this location gets linked, one outside "Tags" returns.
   * Runs after the sync's actions, because `PUT …/links` replaces
   * all links of a tag; if it has written, tags and mailboxes of the
   * account reload before it returns the mailbox (the list then knows it as a
   * tag). `TagFixError` if a mailbox of the same name there belongs to another
   * tag.
   */
  mailbox(tag: string, account: string): Promise<Id> {
    const gen = this.#gen;
    const run = this.#fixes.then(() => this.#mailbox(tag, account, gen));
    this.#fixes = run.catch(() => undefined);
    return run;
  }

  async #mailbox(tag: string, account: string, gen: number): Promise<Id> {
    const list = this.#boxes(account);
    if (gen !== this.#gen || !this.#data || !list || !this.#data.some((t) => t.id === tag))
      throw new Error('Tag or mailboxes unknown');
    const { byId, root, below } = tagBoxes(list);
    const c: FixContext = { account, tags: [...this.#data], byId, root, below, wrote: false, touched: [] };
    try {
      return await this.#place(c, tag);
    } finally {
      if (c.wrote && gen === this.#gen)
        await Promise.allSettled([this.load(), ...(c.touched.length ? [this.#jmap.sync(account)] : [])]);
    }
  }

  async #run(problem: TagProblem, action: TagFix, gen: number): Promise<boolean> {
    const list = this.#boxes(problem.account);
    const key = problemKey(problem);
    if (gen !== this.#gen || !this.#data || !list || !this.problems(problem.account).some((p) => problemKey(p) === key))
      return false;
    const { byId, root, below } = tagBoxes(list);
    const c: FixContext = {
      account: problem.account,
      tags: [...this.#data],
      byId,
      root,
      below,
      wrote: false,
      touched: [],
    };
    try {
      await this.#fix(c, problem, action);
      return true;
    } finally {
      if (c.wrote && gen === this.#gen)
        await Promise.allSettled([this.load(), ...unique(c.touched).map((a) => this.#jmap.sync(a))]);
    }
  }

  async #fix(c: FixContext, p: TagProblem, action: TagFix): Promise<void> {
    if (p.kind === 'unlinked') {
      if (action === 'adopt') await this.#adopt(c, p.mailbox, p.parent, true);
      else if (action === 'toFolder') {
        const box = c.byId.get(p.mailbox);
        if (!box) return;
        this.#free(c, null, box.name, box.id);
        await this.#update(c, box.id, { parentId: null });
      }
      return;
    }
    const t = c.tags.find((x) => x.id === p.tag);
    if (!t) return;
    if (action === 'unlink') await this.#relink(c, t, null);
    else if (action === 'back' || action === 'align') {
      // If the location already exists, check before the first write.
      const known = this.#placed(c, t.parent_id);
      if (known !== undefined) this.#free(c, known, t.name, p.mailbox);
      const parent = known ?? (await this.#place(c, t.parent_id));
      this.#free(c, parent, t.name, p.mailbox);
      await this.#update(c, p.mailbox, { parentId: parent, name: t.name });
    } else if (action === 'take' && p.kind === 'renamed' && p.name !== null) await this.#rename(c, t, p.name);
  }

  /** No folder of the same name (except `self`) under `parent`; otherwise `TagFixError`. */
  #free(c: FixContext, parent: Id | null, name: string, self: Id): void {
    for (const b of c.byId.values())
      if (b.id !== self && b.parentId === parent && same(b.name, name)) throw new TagFixError('folder', name);
  }

  /**
   * Mailbox for the children of tag `id` (`null`: the root "Tags"); missing
   * locations arise as on the first assignment: a
   * mailbox outside "Tags" returns, a missing one is created
   * and linked.
   */
  async #place(c: FixContext, id: string | null): Promise<Id> {
    const known = this.#placed(c, id);
    if (known !== undefined) return known;
    const t = id === null ? undefined : c.tags.find((x) => x.id === id);
    if (!t) {
      c.root = await this.#create(c, { name: TAG_ROOT, parentId: null });
      return c.root;
    }
    const linked = linkIn(t, c.account);
    const box = linked === undefined ? undefined : c.byId.get(linked);
    const parent = await this.#place(c, t.parent_id);
    if (box) {
      this.#free(c, parent, t.name, box.id);
      await this.#update(c, box.id, { parentId: parent, name: t.name });
      return box.id;
    }
    // If a mailbox of the same name without a tag already lies there, it gets linked (Stalwart rejects equal names).
    const taken = [...c.byId.values()].find((b) => b.parentId === parent && same(b.name, t.name));
    if (taken && c.tags.some((x) => linkIn(x, c.account) === taken.id)) throw new TagFixError('folder', t.name);
    const target = taken?.id ?? (await this.#create(c, { name: t.name, parentId: parent }));
    await this.#relink(c, t, target);
    return target;
  }

  /** Location for the children of tag `id` if it already exists below "Tags"; changes nothing. */
  #placed(c: FixContext, id: string | null): Id | undefined {
    const t = id === null ? undefined : c.tags.find((x) => x.id === id);
    if (!t) return c.root ?? undefined;
    const linked = linkIn(t, c.account);
    return linked !== undefined && c.below.has(linked) ? linked : undefined;
  }

  /** Renames the tag to the mailbox's name; the mailboxes of the other accounts follow. */
  async #rename(c: FixContext, t: Tag, name: string): Promise<void> {
    if (c.tags.some((x) => x.id !== t.id && x.parent_id === t.parent_id && same(x.name, name)))
      throw new TagFixError('tag', name);
    c.wrote = true;
    try {
      await api('PATCH', `tags/${t.id}`, { name: name.normalize('NFC') });
    } catch (error) {
      throw takenError(error) ? new TagFixError('tag', name) : error;
    }
    // Other accounts: rename the mailbox below "Tags"; if it fails, the sync reports it there as renamed.
    for (const l of t.links) {
      const list = l.mail_account_id === c.account ? null : this.#boxes(l.mail_account_id);
      const box = list && tagBoxes(list).below.has(l.mailbox_id) ? list.find((b) => b.id === l.mailbox_id) : undefined;
      if (box && box.name !== name) {
        c.touched.push(l.mail_account_id);
        await this.#set(l.mail_account_id, { update: { [box.id]: { name } } }).catch(() => undefined);
      }
    }
  }

  /**
   * Adopts a mailbox without a tag as a tag under `parent`: links with a tag
   * of the same name without a mailbox in this account, otherwise creates
   * it anew; its mailboxes without a tag follow as subtags. If a tag with its own
   * mailbox already stands there, the topmost one refuses; below it the
   * mailbox stays without a tag.
   */
  async #adopt(c: FixContext, mailbox: Id, parent: string | null, top: boolean): Promise<void> {
    const box = c.byId.get(mailbox);
    if (!box) return;
    const named = c.tags.find((t) => t.parent_id === parent && same(t.name, box.name));
    let tag: Tag;
    if (named) {
      const linked = linkIn(named, c.account);
      if (linked !== undefined && c.byId.has(linked)) {
        if (top) throw new TagFixError('tag', box.name);
        return;
      }
      tag = named;
    } else {
      const color = parent === null ? c.tags.filter((t) => t.parent_id === null).length % MA_COLORS.length : null;
      c.wrote = true;
      try {
        tag = await api<Tag>('POST', 'tags', { name: box.name.normalize('NFC'), parent_id: parent, color });
      } catch (error) {
        throw takenError(error) ? new TagFixError('tag', box.name) : error;
      }
      c.tags.push(tag);
    }
    await this.#relink(c, tag, mailbox);
    // Same name only up to case: the mailbox is then named like the tag.
    if (box.name.normalize('NFC') !== tag.name) await this.#update(c, mailbox, { name: tag.name });
    if (parent !== null) this.open.add(parent);
    const linked = c.tags.flatMap((t) => linkIn(t, c.account) ?? []);
    for (const kid of c.byId.values())
      if (kid.parentId === mailbox && c.below.has(kid.id) && !linked.includes(kid.id))
        // If a subfolder fails (e.g. too deep), it stays without a tag and shows up again in the sync.
        await this.#adopt(c, kid.id, tag.id, false).catch(() => undefined);
  }

  /** Replaces the links of a tag: in this account `mailbox`, or none. */
  async #relink(c: FixContext, t: Tag, mailbox: Id | null): Promise<void> {
    const links = t.links.filter((l) => l.mail_account_id !== c.account);
    if (mailbox !== null) links.push({ mail_account_id: c.account, mailbox_id: mailbox });
    c.wrote = true;
    await api('PUT', `tags/${t.id}/links`, { links });
    const i = c.tags.indexOf(t);
    if (i >= 0) c.tags[i] = { ...t, links };
  }

  async #create(c: FixContext, props: Partial<Mailbox>): Promise<Id> {
    c.wrote = true;
    c.touched.push(c.account);
    const res = await this.#set(c.account, { create: { tag: props } });
    const id = res.created?.tag?.id;
    if (!id) throw new Error('Mailbox/set: no id');
    c.byId.set(id, { ...props, id } as Mailbox);
    c.below.add(id);
    return id;
  }

  async #update(c: FixContext, id: Id, patch: PatchObject): Promise<void> {
    c.wrote = true;
    c.touched.push(c.account);
    await this.#set(c.account, { update: { [id]: patch } });
  }

  /** `Mailbox/set`; rejected objects (`notCreated`, `notUpdated`) as errors. */
  async #set(account: string, args: Omit<SetArgs<Mailbox>, 'accountId'>) {
    const client = await this.#jmap.client(account);
    const accountId = await client.accountId();
    const res = await client.call('Mailbox/set', { accountId, ...args });
    const failed = Object.values({ ...res.notCreated, ...res.notUpdated })[0];
    if (failed) throw new Error(`Mailbox/set: ${failed.type}`);
    return res;
  }

  /** Sign-out: discard tags, expanded branches and running actions. */
  reset(): void {
    this.#seq++;
    this.#gen++;
    this.#loading = null;
    this.#data = null;
    this.#stages = [];
    this.open.clear();
    this.busy.clear();
  }
}

/** 422 of the tags API: name already taken on this level. */
export function takenError(error: unknown): boolean {
  return error instanceof ApiError && fieldsOf(error).name?.code === 'taken';
}

export const tags = new Tags();
