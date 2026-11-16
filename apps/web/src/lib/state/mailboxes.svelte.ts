/**
 * State module `mailboxes`: the mailboxes per
 * mail account from `Mailbox/get` via the JMAP client from `accounts`,
 * synced with `Mailbox/changes`. The six
 * mailboxes of the sidebar come via their
 * role, the folder tree from `parentId`; the root "Tags" with the
 * tag mailboxes is not part of it. Known mailboxes come
 * from storage first, the sync follows.
 */
import {
  changes,
  type ChangesResult,
  type Id,
  type JmapClient,
  type Mailbox,
  type MailboxSetExtra,
  type PatchObject,
  type SetArgs,
  type SetError,
} from '@roedy/jmap';
import { SvelteSet } from 'svelte/reactivity';
import { isOffline } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { patchOf } from '#lib/mail-actions.ts';
import { eachBlock, rejected } from '#lib/mail-blocks.ts';
import type { MailStore } from '#lib/mail-store.ts';
import { ROLE_IDS, type RoleId } from '#lib/routes.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/** JMAP role (RFC 8621, 2; IANA registry) and icon per sidebar mailbox. */
export const ROLES: Record<RoleId, { role: string; icon: IconName }> = {
  inbox: { role: 'inbox', icon: 'ti-inbox' },
  sent: { role: 'sent', icon: 'ti-send' },
  drafts: { role: 'drafts', icon: 'ti-file-pencil' },
  scheduled: { role: 'scheduled', icon: 'ti-clock' },
  trash: { role: 'trash', icon: 'ti-trash' },
  spam: { role: 'junk', icon: 'ti-alert-octagon' },
};

const SIDEBAR_ROLES: ReadonlySet<string> = new Set(ROLE_IDS.map((id) => ROLES[id].role));

/** Name of the root of the tag mailboxes. */
export const TAG_ROOT = 'Tags';

/** Counters as in the list: conversations (`collapseThreads`). */
export interface Counts {
  unread: number;
  total: number;
}

/** Folder in the tree, children in the server's order. */
export interface FolderNode extends Counts {
  id: Id;
  name: string;
  children: FolderNode[];
}

const collator = new Intl.Collator('de');

/** Order according to RFC 8621 (2): `sortOrder`, then the name. */
export function compareMailboxes(a: Mailbox, b: Mailbox): number {
  return a.sortOrder - b.sortOrder || collator.compare(a.name, b.name);
}

export function countsOf(box: Pick<Mailbox, 'unreadThreads' | 'totalThreads'>): Counts {
  return { unread: box.unreadThreads, total: box.totalThreads };
}

/** Sum of the counters (mailboxes of a role in "all accounts"); `null` if no account has one. */
export function sumCounts(list: readonly (Counts | null)[]): Counts | null {
  return list.reduce<Counts | null>(
    (sum, c) => (c ? { unread: (sum?.unread ?? 0) + c.unread, total: (sum?.total ?? 0) + c.total } : sum),
    null,
  );
}

/** Mailbox with the role; if there are several, the first in order. */
export function roleMailbox(list: readonly Mailbox[], role: RoleId): Mailbox | null {
  const jmap = ROLES[role].role;
  return list.filter((b) => b.role === jmap).sort(compareMailboxes)[0] ?? null;
}

/** Root "Tags": top level, without a role. */
export function tagRoot(list: readonly Mailbox[]): Mailbox | null {
  return (
    list.filter((b) => b.parentId === null && b.role === null && b.name === TAG_ROOT).sort(compareMailboxes)[0] ?? null
  );
}

/* eslint-disable svelte/prefer-svelte-reactivity -- local helper values of pure functions, not state */
/** The root "Tags" and all mailboxes below it; empty without a root. */
export function tagMailboxIds(list: readonly Mailbox[]): Set<Id> {
  const root = tagRoot(list)?.id;
  if (!root) return new Set();
  const byId = new Map(list.map((b) => [b.id, b]));
  const under = (box: Mailbox): boolean => {
    // With protection against cycles in `parentId`.
    const seen = new Set<Id>();
    for (let b: Mailbox | undefined = box; b && !seen.has(b.id); b = b.parentId ? byId.get(b.parentId) : undefined) {
      if (b.id === root) return true;
      seen.add(b.id);
    }
    return false;
  };
  return new Set(list.filter(under).map((b) => b.id));
}

/**
 * Folder tree from `parentId` without the sidebar mailboxes and without
 * the root "Tags" with everything below it. Subfolders of a sidebar
 * mailbox (e.g. from another program), folders with an unknown
 * parent and folders in a `parentId` cycle stand on the
 * top level.
 */
export function folderTree(list: readonly Mailbox[]): FolderNode[] {
  const byId = new Map(list.map((b) => [b.id, b]));
  const tags = tagMailboxIds(list);
  const shown = list.filter((b) => !(b.role && SIDEBAR_ROLES.has(b.role)) && !tags.has(b.id));
  const ids = new Set(shown.map((b) => b.id));
  // If the way up leads back to the folder itself, the tree never reached it from the top.
  const inCycle = (box: Mailbox): boolean => {
    const seen = new Set<Id>();
    for (let p = box.parentId; p && ids.has(p) && !seen.has(p); p = byId.get(p)?.parentId ?? null) {
      if (p === box.id) return true;
      seen.add(p);
    }
    return false;
  };
  const kids = new Map<Id | null, Mailbox[]>();
  for (const b of shown) {
    const parent = b.parentId && ids.has(b.parentId) && !inCycle(b) ? b.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), b]);
  }
  const build = (parent: Id | null): FolderNode[] =>
    (kids.get(parent) ?? [])
      .sort(compareMailboxes)
      .map((b) => ({ id: b.id, name: b.name, ...countsOf(b), children: build(b.id) }));
  return build(null);
}

/** Pending change to folders while its toast runs: deleted, or renamed or moved. */
export type FolderStage = { hide: readonly Id[] } | { id: Id; name: string; parentId: Id | null };

/** Lays pending changes over the server's mailboxes. */
export function applyStages(list: readonly Mailbox[], stages: readonly FolderStage[]): Mailbox[] {
  const hidden = new Set<Id>();
  const moved = new Map<Id, { name: string; parentId: Id | null }>();
  for (const s of stages) {
    if ('hide' in s) for (const id of s.hide) hidden.add(id);
    else moved.set(s.id, { name: s.name, parentId: s.parentId });
  }
  return list
    .filter((b) => !hidden.has(b.id))
    .map((b) => {
      const patch = moved.get(b.id);
      return patch ? { ...b, ...patch } : b;
    });
}

/** Path in the tree from the top to folder `id` (itself last); `null` if it is not there. */
export function folderChain(tree: readonly FolderNode[], id: Id): FolderNode[] | null {
  for (const node of tree) {
    if (node.id === id) return [node];
    const below = folderChain(node.children, id);
    if (below) return [node, ...below];
  }
  return null;
}

/** Folder `id` in the tree with its parent in the tree (`null`: top level); `null` if it is not there. */
export function findFolder(tree: readonly FolderNode[], id: Id): { node: FolderNode; parent: Id | null } | null {
  const chain = folderChain(tree, id);
  const node = chain?.at(-1);
  return chain && node ? { node, parent: chain.at(-2)?.id ?? null } : null;
}

/**
 * Levels of a mailbox by `parentId`: itself, its children, their children
 * … – also those the tree does not show (roles); `null` if it does
 * not exist.
 */
export function folderLevels(list: readonly Mailbox[], id: Id): Mailbox[][] | null {
  const root = list.find((b) => b.id === id);
  if (!root) return null;
  const levels: Mailbox[][] = [];
  const seen = new Set<Id>();
  for (let level = [root]; level.length;) {
    for (const b of level) seen.add(b.id);
    levels.push(level);
    const ids = new Set(level.map((b) => b.id));
    level = list.filter((b) => b.parentId !== null && ids.has(b.parentId) && !seen.has(b.id));
  }
  return levels;
}

/** Can the branch be deleted? No mailbox in it has a role (e.g. archive), all allow it (`mayDelete`). */
export function canDelete(levels: readonly Mailbox[][]): boolean {
  return levels.flat().every((b) => b.role === null && b.myRights.mayDelete);
}

/** Compares names as for tags: NFC, case-insensitive. */
export const sameName = (a: string, b: string): boolean =>
  a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

/**
 * Is the name already taken under `parent` (except by `self`)? All
 * mailboxes count, also roles and the tag mailboxes, because Stalwart rejects equal
 * names among siblings; "Tags" on the top level is reserved for the root
 * of the tags, even before it exists.
 */
export function nameTaken(list: readonly Mailbox[], parent: Id | null, name: string, self: Id | null): boolean {
  if (parent === null && sameName(name, TAG_ROOT)) return true;
  return list.some((b) => b.id !== self && b.parentId === parent && sameName(b.name, name));
}
/* eslint-enable svelte/prefer-svelte-reactivity */

/** The server rejected a change to folders or their emails (`notCreated`, `notUpdated`, `notDestroyed`). */
export class FolderError extends Error {
  readonly errors: SetError[];
  constructor(method: string, errors: SetError[]) {
    super(`${method}: ${errors.map((e) => e.type).join(', ')}`);
    this.name = 'FolderError';
    this.errors = errors;
  }
}

/** Rejected, except what no longer exists (deleted elsewhere). */
const refused = (...maps: (Record<Id, SetError> | null | undefined)[]): SetError[] =>
  rejected(...maps).map(([, e]) => e);

/** Mailboxes of a mail account. */
export interface AccountMailboxes {
  /** `loading` until the first response, `error` if it failed. */
  status: 'loading' | 'ready' | 'error';
  list: Mailbox[];
  error: unknown;
}

type ClientOf = (account: string) => Promise<JmapClient>;
type StoreOf = () => Pick<MailStore, 'mailboxes' | 'saveMailboxes'> | null;

export class Mailboxes {
  #data = $state.raw<Record<string, AccountMailboxes>>({});
  /** Pending changes to folders per account (`stage()`), in the order they arose. */
  #stages = $state.raw<readonly { token: number; account: string; stage: FolderStage }[]>([]);
  #stageToken = 0;
  /** Cache of `list()` per account while data and changes stay the same (not reactive). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #staged = new Map<string, { list: Mailbox[]; stages: unknown; out: Mailbox[] }>();
  /** Expanded folders as `<account>/<folder>`. */
  readonly open = new SvelteSet<string>();
  /** Accounts expanded in the folder tree in "all accounts". */
  readonly openAccounts = new SvelteSet<string>();

  readonly #client: ClientOf;
  readonly #store: StoreOf;
  // Not reactive: JMAP account and state for `Mailbox/changes`, queue per account.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #jmap = new Map<string, { accountId: Id; state: string }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #queue = new Map<string, Promise<void>>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #pendingSync = new Map<string, Promise<void>>();
  /** Counter per account; `forget()` increments it, older responses expire. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #gen = new Map<string, number>();

  constructor(client: ClientOf = (account) => accounts.client(account), store: StoreOf = () => session.mailStore) {
    this.#client = client;
    this.#store = store;
  }

  of(account: string): AccountMailboxes | undefined {
    return this.#data[account];
  }

  /** Mailboxes of the account with the pending changes to folders; computed once per state. */
  list(account: string): Mailbox[] {
    const list = this.#data[account]?.list ?? [];
    const all = this.#stages;
    if (!all.length) return list;
    const known = this.#staged.get(account);
    if (known?.list === list && known.stages === all) return known.out;
    const stages = all.filter((s) => s.account === account).map((s) => s.stage);
    const out = stages.length ? applyStages(list, stages) : list;
    this.#staged.set(account, { list, stages: all, out });
    return out;
  }

  /** Shows a change to folders before the server knows it (during the toast); returns the token for `unstage()`. */
  stage(account: string, stage: FolderStage): number {
    const token = ++this.#stageToken;
    this.#stages = [...this.#stages, { token, account, stage }];
    return token;
  }

  unstage(token: number): void {
    this.#stages = this.#stages.filter((s) => s.token !== token);
  }

  /**
   * Creates a folder (subscribed, RFC 8621, 2) and then syncs; returns its id.
   * With `role` a mailbox with a role, e.g. "Scheduled" on the first scheduling.
   */
  async create(account: string, name: string, parentId: Id | null, role: RoleId | null = null): Promise<Id> {
    const res = await this.#call(account, {
      create: { folder: { name, parentId, isSubscribed: true, ...(role ? { role: ROLES[role].role } : {}) } },
    });
    const errors = refused(res.notCreated);
    const id = res.created?.folder?.id;
    if (errors.length || !id) throw new FolderError('Mailbox/set', errors);
    await this.sync(account).catch(() => undefined);
    return id;
  }

  /** Renames or moves a folder; with `keepalive` when leaving the page. */
  async update(account: string, id: Id, patch: { name?: string; parentId?: Id | null }, keepalive = false) {
    const res = await this.#call(account, { update: { [id]: patch } }, keepalive);
    const errors = refused(res.notUpdated);
    if (errors.length) throw new FolderError('Mailbox/set', errors);
    await this.sync(account).catch(() => undefined);
  }

  /**
   * Deletes empty folders (undo after creating): `onDestroyRemoveEmails`
   * off; if emails lie in it by then, the server rejects.
   */
  async destroy(account: string, ids: readonly Id[]): Promise<void> {
    const res = await this.#call(account, { destroy: [...ids], onDestroyRemoveEmails: false });
    const errors = refused(res.notDestroyed);
    if (errors.length) throw new FolderError('Mailbox/set', errors);
    await this.sync(account).catch(() => undefined);
  }

  /**
   * Deletes folder `id` with all subfolders
   * according to the server's state at sending (a sync before). A branch
   * with a role or without `mayDelete` and a missing trash with
   * emails in it fail before anything changes. Then the
   * emails leave the folders in blocks (`eachBlock()`); whatever afterwards lies in no
   * mailbox except tags (`keep`) goes to the trash
   * `trash`. Finally `Mailbox/set destroy` per level, the deepest first,
   * all in one request. If the folder no longer exists, nothing remains to do.
   */
  async remove(account: string, id: Id, trash: Id | null, keep: (box: Id) => boolean): Promise<void> {
    await this.sync(account).catch(() => undefined);
    const levels = folderLevels(this.#data[account]?.list ?? [], id);
    if (!levels) return;
    if (!canDelete(levels)) throw new FolderError('Mailbox/set', [{ type: 'forbidden' }]);
    const boxes = levels.flat();
    if (!trash && boxes.some((b) => b.totalEmails > 0)) throw new Error('Trash missing');
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const doomed = new Set(boxes.map((b) => b.id));
    const client = await this.#client(account);
    await eachBlock(client, [...doomed], async (emails, accountId) => {
      const update: Record<Id, PatchObject> = {};
      for (const e of emails) {
        const change: Record<Id, boolean> = {};
        for (const x of e.mailboxIds) if (doomed.has(x)) change[x] = false;
        if (!e.mailboxIds.some((x) => !doomed.has(x) && !keep(x))) {
          // Without a mailbox the server would not accept the email (RFC 8621, 4.1.1).
          if (!trash) throw new Error('Trash missing');
          change[trash] = true;
        }
        update[e.id] = patchOf({ mailboxIds: change });
      }
      const done = await client.call('Email/set', { accountId, update });
      const errors = refused(done.notUpdated);
      if (errors.length) throw new FolderError('Email/set', errors);
      return Object.keys(done.updated ?? {}).length;
    });
    const accountId = await client.accountId();
    const b = client.batch();
    const calls = [...levels]
      .reverse()
      .map((level) =>
        b.call('Mailbox/set', { accountId, destroy: level.map((x) => x.id), onDestroyRemoveEmails: false }),
      );
    const res = await b.send();
    const errors = calls.flatMap((call) => refused(res.get(call).notDestroyed));
    if (errors.length) throw new FolderError('Mailbox/set', errors);
    await this.sync(account).catch(() => undefined);
  }

  role(account: string, role: RoleId): Mailbox | null {
    return roleMailbox(this.list(account), role);
  }

  tree(account: string): FolderNode[] {
    return folderTree(this.list(account));
  }

  isOpen(account: string, id: Id): boolean {
    return this.open.has(`${account}/${id}`);
  }

  toggle(account: string, id: Id): void {
    const key = `${account}/${id}`;
    if (!this.open.delete(key)) this.open.add(key);
  }

  /** Expands or collapses an account in the folder tree of "all accounts". */
  toggleAccount(account: string): void {
    if (!this.openAccounts.delete(account)) this.openAccounts.add(account);
  }

  /** Loads the mailboxes if they are unknown or loading failed; a running load counts. */
  ensure(account: string): Promise<void> {
    // Loaded is loaded, even while a sync is running (its error belongs to the caller of `sync()`).
    if (this.#data[account]?.status === 'ready') return Promise.resolve();
    return this.#queue.get(account) ?? this.load(account);
  }

  /**
   * Loads the mailboxes: first from storage, then `Mailbox/changes` syncs
   * in the background (errors stay silent, the live sync tries again);
   * otherwise all with `Mailbox/get`. If it fails, already known ones stay.
   */
  load(account: string): Promise<void> {
    this.#loading(account);
    return this.#enqueue(account, async (gen) => {
      if (await this.#restored(account, gen)) void this.#catchUp(account);
      else await this.#load(account, gen);
    });
  }

  /** Sync after storage; if the server rejects the state, reloads everything instead of repeating it at every start. */
  async #catchUp(account: string): Promise<void> {
    try {
      await this.sync(account);
    } catch (error) {
      if (!isOffline(error)) await this.#enqueue(account, (gen) => this.#load(account, gen)).catch(() => {});
    }
  }

  /**
   * Mailboxes of an account without access (sign-in required, blocked
   * server): only from storage, without network. If nothing is there, it counts as
   * failed and is missing in the view.
   */
  restore(account: string): Promise<void> {
    if (this.#data[account] || this.#queue.has(account)) return this.#queue.get(account) ?? Promise.resolve();
    this.#loading(account);
    return this.#enqueue(account, async (gen) => {
      if (!(await this.#restored(account, gen)) && !this.#stale(account, gen))
        this.#set(account, { status: 'error', list: [], error: null });
    });
  }

  /**
   * Syncs with `Mailbox/changes` (with the changed mailboxes in the
   * same request); without a known state or on `cannotCalculateChanges`
   * it reloads everything. Several calls before the start run once.
   */
  sync(account: string): Promise<void> {
    const pending = this.#pendingSync.get(account);
    if (pending) return pending;
    const task: Promise<void> = this.#enqueue(account, (gen) => {
      if (this.#pendingSync.get(account) === task) this.#pendingSync.delete(account);
      return this.#jmap.has(account) ? this.#sync(account, gen) : this.#load(account, gen);
    });
    this.#pendingSync.set(account, task);
    return task;
  }

  /** Account removed: discard mailboxes and expanded folders. */
  forget(account: string): void {
    this.#gen.set(account, (this.#gen.get(account) ?? 0) + 1);
    this.#jmap.delete(account);
    this.#queue.delete(account);
    this.#pendingSync.delete(account);
    if (account in this.#data)
      this.#data = Object.fromEntries(Object.entries(this.#data).filter(([a]) => a !== account));
    for (const key of [...this.open]) if (key.startsWith(`${account}/`)) this.open.delete(key);
    this.openAccounts.delete(account);
    if (this.#stages.some((s) => s.account === account))
      this.#stages = this.#stages.filter((s) => s.account !== account);
  }

  /** Discards the mailboxes of all accounts no longer in the list (removed, also on another device). */
  retain(accounts: readonly string[]): void {
    for (const account of [...Object.keys(this.#data), ...this.#queue.keys(), ...this.#jmap.keys()])
      if (!accounts.includes(account)) this.forget(account);
  }

  /** Sign-out: discard everything. */
  reset(): void {
    for (const account of [...Object.keys(this.#data), ...this.#queue.keys(), ...this.#jmap.keys()])
      this.forget(account);
    this.open.clear();
    this.openAccounts.clear();
  }

  /** `Mailbox/set` in the JMAP account of the mail account (with `keepalive` via `send()`). */
  async #call(account: string, args: Omit<SetArgs<Mailbox> & MailboxSetExtra, 'accountId'>, keepalive = false) {
    const client = await this.#client(account);
    const accountId = await client.accountId();
    const b = client.batch();
    const call = b.call('Mailbox/set', { accountId, ...args });
    return (await b.send(undefined, { keepalive })).get(call);
  }

  /** Tasks of an account run one after another. */
  #enqueue(account: string, task: (gen: number) => Promise<void>): Promise<void> {
    const gen = this.#gen.get(account) ?? 0;
    const previous = this.#queue.get(account) ?? Promise.resolve();
    const next = previous.then(
      () => task(gen),
      () => task(gen),
    );
    this.#queue.set(account, next);
    const done = () => {
      if (this.#queue.get(account) === next) this.#queue.delete(account);
    };
    void next.then(done, done);
    return next;
  }

  #stale(account: string, gen: number): boolean {
    return (this.#gen.get(account) ?? 0) !== gen;
  }

  #set(account: string, value: AccountMailboxes): void {
    this.#data = { ...this.#data, [account]: value };
  }

  /** Without known mailboxes: `loading` right at the call, not only in the queue. */
  #loading(account: string): void {
    const known = this.#data[account];
    if (!known || known.status === 'error') this.#set(account, { status: 'loading', list: [], error: null });
  }

  /** Takes over the stored state as long as nothing newer is known. */
  async #restored(account: string, gen: number): Promise<boolean> {
    if (this.#jmap.has(account) || this.#stale(account, gen)) return false;
    const saved = await this.#store()?.mailboxes(account);
    if (!saved || this.#stale(account, gen)) return false;
    this.#jmap.set(account, { accountId: saved.accountId, state: saved.state });
    this.#set(account, { status: 'ready', list: saved.list, error: null });
    return true;
  }

  #save(account: string): void {
    const known = this.#jmap.get(account);
    const list = this.#data[account]?.list;
    if (known && list) this.#store()?.saveMailboxes({ account, ...known, list });
  }

  async #load(account: string, gen: number): Promise<void> {
    if (this.#stale(account, gen)) return;
    this.#loading(account);
    try {
      const client = await this.#client(account);
      const accountId = await client.accountId();
      const res = await client.call('Mailbox/get', { accountId, ids: null });
      if (this.#stale(account, gen)) return;
      this.#jmap.set(account, { accountId, state: res.state });
      this.#set(account, { status: 'ready', list: res.list, error: null });
      this.#save(account);
    } catch (error) {
      if (this.#stale(account, gen)) return;
      if (this.#data[account]?.status !== 'ready') this.#set(account, { status: 'error', list: [], error });
      throw error;
    }
  }

  async #sync(account: string, gen: number): Promise<void> {
    const known = this.#jmap.get(account);
    if (!known || this.#stale(account, gen)) return;
    let result: ChangesResult<Mailbox>;
    try {
      const client = await this.#client(account);
      result = await changes(client, 'Mailbox', { accountId: known.accountId, sinceState: known.state, fetch: true });
    } catch (error) {
      // After `forget()` or sign-out nobody cares about the error any more.
      if (this.#stale(account, gen)) return;
      throw error;
    }
    if (this.#stale(account, gen)) return;
    if (result.reset) return this.#load(account, gen);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
    const byId = new Map((this.#data[account]?.list ?? []).map((b) => [b.id, b]));
    for (const id of result.destroyed) byId.delete(id);
    // Without an object (deleted between `changes` and `get`): drops out, `destroyed` follows.
    for (const id of [...result.created, ...result.updated]) {
      const box = result.objects.get(id);
      if (box) byId.set(id, box);
      else byId.delete(id);
    }
    this.#jmap.set(account, { accountId: known.accountId, state: result.newState });
    this.#set(account, { status: 'ready', list: [...byId.values()], error: null });
    if (result.newState !== known.state) this.#save(account);
  }
}

export const mailboxes = new Mailboxes();
