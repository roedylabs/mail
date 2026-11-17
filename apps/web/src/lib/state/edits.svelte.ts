/**
 * State module `edits`: own changes to emails until the
 * server shows them. An action lays its changes over list and
 * reading view immediately (optimistically) and sends them as `Email/set` – with undo
 * only after the toast expires (`ui.toasts.defer`), otherwise
 * immediately. List and reading view stamp every load run (`stamp()`): data
 * loaded before the server's confirmation gets the change
 * laid over, data loaded later shows the server's state. This way a
 * live sync during the toast turns nothing back, and
 * later changes by other clients are not hidden. If sending fails,
 * the change drops out; if the server rejects only some emails, only theirs.
 * An immediate action sends a pending one with the same emails first,
 * so that the server sees the actions in their order. If the
 * response fails to come, the change waits in the queue (`queue`):
 * it stays laid over, also across a restart, until the replay is through.
 * When the page closes, a queueable change lies in the database before its
 * request goes out (`EditQueue.keep()`): the page may end before the response,
 * even without a known outage, and the next start replays it.
 * If an action puts emails into a mailbox, it takes the rows of their
 * conversations along (`carried()`): this way they are in the target before the server
 * shows it.
 */
import { coreCapability, type Id, type JmapClient, type SetError } from '@roedy/jmap';
import { failText } from '#lib/errors.ts';
import {
  applyEdit,
  isMove,
  mergeEdit,
  movedElsewhere,
  patchOf,
  type EmailEdit,
  type Edits,
} from '#lib/mail-actions.ts';
import { BLOCK, eachBlock, rejected } from '#lib/mail-blocks.ts';
import { editLogs, queueKey, type EditLog, type QueuedEdit } from '#lib/mail-queue.ts';
import type { ListThread } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { EditQueue, LOCAL_DRAFT, exclusive, refused, unanswered } from '#lib/state/edit-queue.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

let clock = 0;

/** Stamp of a load run, taken before the request goes out. */
export function stamp(): number {
  return ++clock;
}

/** Confirmed changes in memory; older ones count as taken over by the server. */
const KEEP_DONE = 100;

interface Entry {
  token: number;
  account: string;
  edits: Edits;
  /** Stamp of the confirmation; until then `Infinity` (applies to all data). */
  done: number;
  /** Waits for the end of a toast (`ui.toasts.defer`). */
  deferred: boolean;
  /** Time of the action (ms); orders it in the queue. */
  at: number;
  /** Key in the queue when the change waits there. */
  key?: string;
  /** Conversations the change puts into a mailbox, as the list knew them before (`carried()`). */
  rows: readonly ListThread[];
}

/**
 * If an account must sign in again first or its server is blocked,
 * an error toast reports it and nothing is run: `true`. The rows of such accounts are there from storage.
 */
export function refusedBy(ids: readonly string[]): boolean {
  const list = ids.map((id) => accounts.get(id));
  const blocked = list.find((a) => a?.blocked);
  const stale = list.find((a) => a?.state === 'needs_reauth');
  if (blocked) ui.toasts.error(m.mail_account_check_blocked({ host: blocked.host }));
  else if (stale) ui.toasts.error(m.compose_check_stale({ email: stale.email }));
  return !!(blocked || stale);
}

/** Does the account have no access? Then `run()` refused because of `refusedBy()`, and the toast is already shown. */
export function lacksAccess(id: string): boolean {
  const account = accounts.get(id);
  return !!account && (account.blocked || account.state === 'needs_reauth');
}

/** The server rejected changes to `ids` (`notUpdated`, `notDestroyed`). */
export class EditError extends Error {
  readonly ids: Id[];
  readonly errors: SetError[];
  constructor(rejected: [Id, SetError][]) {
    super(`Email/set: ${rejected.map(([, e]) => e.type).join(', ')}`);
    this.ids = rejected.map(([id]) => id);
    this.errors = rejected.map(([, e]) => e);
  }
}

/** Access to the mail servers; replaceable in tests. */
export interface EditApi {
  /** Sends the changes as one `Email/set`; fails with `EditError` if the server rejects one. */
  set(account: string, edits: Edits, keepalive: boolean): Promise<void>;
  /**
   * Replays the merged changes of an account in blocks
   * and returns the emails the server did not take
   * over, also deleted ones, ones moved by another device and those of a
   * rejected block; throws if no response came or a retry may help.
   */
  replay(account: string, edits: Edits): Promise<Id[]>;
  /**
   * Empties a mailbox in blocks: emails that lie in no mailbox besides it (and `keep`, the
   * tags) are deleted permanently by the server, the others
   * only leave the mailbox. Returns the count.
   */
  clear(account: string, mailbox: Id, keep: (box: Id) => boolean): Promise<number>;
}

/** One block of the replay: if an email lies elsewhere or is gone, the server wins. */
async function replayBlock(client: JmapClient, accountId: Id, edits: readonly [Id, EmailEdit][]): Promise<Id[]> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy, not state
  const patches = new Map(edits);
  const lost: Id[] = [];
  const moves = edits.filter(([, edit]) => isMove(edit));
  if (moves.length) {
    const ids = moves.map(([id]) => id);
    const found = await client.call('Email/get', { accountId, ids, properties: ['id', 'mailboxIds'] });
    const boxes = new Map(found.list.map((e) => [e.id, Object.keys(e.mailboxIds ?? {})]));
    for (const [id, edit] of moves) {
      const now = boxes.get(id);
      if (now && !movedElsewhere(edit, now)) continue;
      lost.push(id);
      // Keywords do not depend on the folder: read and star still apply as long as the email is there.
      if (now && edit.keywords) patches.set(id, { keywords: edit.keywords });
      else patches.delete(id);
    }
  }
  if (!patches.size) return lost;
  const update = Object.fromEntries([...patches].map(([id, edit]) => [id, patchOf(edit)]));
  const done = await client.call('Email/set', { accountId, update });
  return [...lost, ...Object.keys(done.notUpdated ?? {}).filter((id) => !lost.includes(id))];
}

export function jmapEditApi(clientOf: (account: string) => Promise<JmapClient>): EditApi {
  return {
    async set(account, edits, keepalive) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const update: Record<Id, ReturnType<typeof patchOf>> = {};
      const destroy: Id[] = [];
      for (const [id, edit] of edits) {
        if (edit.destroyed) destroy.push(id);
        else update[id] = patchOf(edit);
      }
      const b = client.batch();
      const call = b.call('Email/set', {
        accountId,
        ...(Object.keys(update).length ? { update } : {}),
        ...(destroy.length ? { destroy } : {}),
      });
      const res = (await b.send(undefined, { keepalive })).get(call);
      const errors = rejected(res.notUpdated, res.notDestroyed);
      if (errors.length) throw new EditError(errors);
    },

    async replay(account, edits) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const core = coreCapability(await client.session());
      const size = Math.max(1, Math.min(BLOCK, core.maxObjectsInGet, core.maxObjectsInSet));
      const all = [...edits];
      const lost: Id[] = [];
      // If a block fails, the next run repeats all of them: the patches are idempotent.
      for (let i = 0; i < all.length; i += size) {
        const block = all.slice(i, i + size);
        try {
          lost.push(...(await replayBlock(client, accountId, block)));
        } catch (error) {
          // Only this block is rejected; already taken-over ones apply, the others try.
          if (!refused(error)) throw error;
          lost.push(...block.map(([id]) => id));
        }
      }
      return lost;
    },

    async clear(account, mailbox, keep) {
      const client = await clientOf(account);
      let total = 0;
      // Delete or remove per block.
      await eachBlock(client, [mailbox], async (emails, accountId) => {
        const destroy: Id[] = [];
        const update: Record<Id, ReturnType<typeof patchOf>> = {};
        for (const e of emails) {
          const others = e.mailboxIds.some((x) => x !== mailbox && !keep(x));
          if (others) update[e.id] = patchOf({ mailboxIds: { [mailbox]: false } });
          else destroy.push(e.id);
        }
        const done = await client.call('Email/set', { accountId, update, destroy });
        const moved = (done.destroyed?.length ?? 0) + Object.keys(done.updated ?? {}).length;
        total += moved;
        const errors = rejected(done.notUpdated, done.notDestroyed);
        if (errors.length) throw new EditError(errors);
        return moved;
      });
      return total;
    },
  };
}

/** Changes of an account; an action on the selection in "all accounts" has one part per account. */
export interface EditPart {
  account: string;
  edits: Edits;
  /**
   * Own sending instead of `Email/set` (deleting in "Scheduled" cancels the
   * sending): returns the changes that apply afterwards – missing ones drop
   * out, others replace them (e.g. "Sent" if it was too late); throws
   * if none applies.
   */
  send?: ((keepalive: boolean) => Promise<Edits>) | undefined;
  /** Only works with a connection (`purge`): does not wait in the queue. */
  online?: boolean | undefined;
}

/** Toast and error behaviour of an action (`runAll()`). */
export interface EditOptions {
  /** Text of the toast with undo; without it the change goes out immediately. */
  text?: string | undefined;
  /** Without a toast: revert failures silently (read on opening), otherwise with an error toast. */
  quiet?: boolean | undefined;
  /** After "undo" or if everything fails, e.g. to restore the selection. */
  onRevert?: (() => void) | undefined;
  /** Text of the error toast instead of the general one (`error_undo` or `error_act`). */
  failed?: string | undefined;
}

/** An action for `run()`. */
export interface EditRequest extends EditPart, EditOptions {}

/** Subject of an email if the source knows it (`describe()`). */
type SubjectOf = (account: string, id: Id) => string | null;

/** Conversations with these emails, as loaded lists show them (`carry()`), one per conversation. */
type RowsOf = (account: string, ids: ReadonlySet<Id>) => ListThread[];

/**
 * Without drafts that exist only in the queue (row from
 * `draftRow()`): at the server they only exist after the replay.
 * If nothing remains, an error toast reports it (except `quiet`).
 */
function withoutLocal(parts: readonly EditPart[], quiet: boolean): EditPart[] {
  const out = parts
    .map((p) => {
      if (![...p.edits.keys()].some((id) => id.startsWith(LOCAL_DRAFT))) return p;
      return { ...p, edits: new Map([...p.edits].filter(([id]) => !id.startsWith(LOCAL_DRAFT))) };
    })
    .filter((p) => p.edits.size > 0);
  if (!out.length && parts.length && !quiet) ui.toasts.error(network.offline ? m.error_offline() : m.error_act());
  return out;
}

/** Does the change put the email into a mailbox (move, restore, tag)? */
const adds = (edit: EmailEdit): boolean => Object.values(edit.mailboxIds ?? {}).some(Boolean);

/** Queue of the signed-in user. */
const currentLog = (): EditLog | null => (session.user ? editLogs.of(session.user.id) : null);

/** Can the action wait? Not with own sending and not if it deletes something permanently. */
const queueable = ({ edits, send, online }: EditPart): boolean =>
  !send && !online && ![...edits.values()].some((e) => e.destroyed);

export class EmailEdits {
  #entries = $state.raw<readonly Entry[]>([]);
  #token = 0;
  readonly #api: EditApi;
  readonly #subjects: SubjectOf[] = [];
  #rowsOf: RowsOf = () => [];
  /** Changes waiting for the server. */
  readonly queue: EditQueue;

  constructor(
    api: EditApi = jmapEditApi((account) => accounts.client(account)),
    log: () => EditLog | null = currentLog,
  ) {
    this.#api = api;
    this.queue = new EditQueue({
      log,
      replay: (account, edits) => this.#api.replay(account, edits),
      offline: () => network.offline,
      lacksAccess,
      exclusive,
      restored: (item) => this.#restored(item),
      finished: (key, lost) => this.#finished(key, lost),
      transferred: (count) => {
        // `show()` sent an action whose undo is currently running; the pill has already shown the replay.
        if (!ui.toasts.pending) ui.toasts.show(count === 1 ? m.offline_done_one() : m.offline_done_many({ count }));
      },
    });
  }

  /** Source for the subject of a queue entry; lists and conversations register here. */
  describe(source: SubjectOf): void {
    this.#subjects.push(source);
  }

  /** Source for the rows an action takes along (`carried()`); the lists register here. */
  carry(source: RowsOf): void {
    this.#rowsOf = source;
  }

  /**
   * Conversations that own changes of the account put into a mailbox and
   * that a list with the stamp `since` cannot know yet: all
   * unconfirmed ones and those confirmed afterwards. Per conversation the
   * most recent version; which list shows it is decided by the list with the
   * changes (`addedRows()` in `threads`).
   */
  carried(account: string, since: number): ListThread[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local mapping, not state
    const out = new Map<Id, ListThread>();
    for (const e of this.#entries) {
      if (e.account !== account || e.done < since) continue;
      for (const row of e.rows) {
        const known = out.get(row.threadId);
        if (!known || known.seq <= row.seq) out.set(row.threadId, row);
      }
    }
    return [...out.values()];
  }

  /** Changes with every change (for caches of lists and conversations); reactive. */
  get version(): unknown {
    return this.#entries;
  }

  /**
   * Change of an email for data with the stamp `seq`: all actions that
   * were not yet confirmed when it was loaded, in their order; with
   * `until` only those confirmed before this stamp (what a counter
   * with this stamp already knows).
   */
  edit(account: string, id: Id, seq: number, until = Infinity): EmailEdit | undefined {
    let out: EmailEdit | undefined;
    for (const e of this.#entries) {
      if (e.account !== account || e.done < seq || (until !== Infinity && e.done >= until)) continue;
      const edit = e.edits.get(id);
      if (edit) out = mergeEdit(out, edit);
    }
    return out;
  }

  /** Whether anything applies for data of the account with the stamp `seq` (fast path for lists). */
  pending(account: string, seq: number): boolean {
    return this.#entries.some((e) => e.account === account && e.done >= seq);
  }

  /** Email with the changes that apply for its stamp; `null` if it is deleted. */
  apply<E extends { id: Id; mailboxIds: Id[]; keywords: Record<string, true> }>(
    account: string,
    email: E,
    seq: number,
  ): E | null {
    return applyEdit(email, this.edit(account, email.id, seq));
  }

  /**
   * Runs an action: shows changes immediately, then sends – with `text` after
   * the toast with undo expires, otherwise right away. If sending fails,
   * they drop out, and an error toast reports it (except `quiet`). `false`
   * if there was nothing to change.
   */
  run({ account, edits, ...options }: EditRequest): boolean {
    return this.runAll([{ account, edits }], options);
  }

  /**
   * One action across several accounts (selection in "all accounts"): one toast,
   * one undo, one `Email/set` per account. If an account fails, only
   * its changes drop out, and an error toast reports it; if all fail,
   * the action reverts everything like `run()`.
   */
  runAll(parts: readonly EditPart[], { text, quiet = false, onRevert, failed: failedText }: EditOptions = {}): boolean {
    const live = withoutLocal(
      parts.filter((p) => p.edits.size > 0),
      quiet,
    );
    if (!live.length) return false;
    // Without access: what the user did not trigger themselves (`quiet`) silently fails.
    if (quiet ? live.some((p) => lacksAccess(p.account)) : refusedBy(live.map((p) => p.account))) return false;
    const tokens = live.map((p) => this.#add(p.account, p.edits, !!text));
    const revert = () => {
      for (const t of tokens) this.#drop(t);
      onRevert?.();
    };
    const failed = failedText ?? (text ? m.error_undo() : m.error_act());
    const commit = (keepalive: boolean) => this.#commitAll(live, tokens, keepalive, quiet ? null : failed);
    if (text) {
      ui.toasts.defer({ text, revert, commit, onError: (error) => ui.toasts.error(failText(error, failed)) });
      return true;
    }
    this.#beforeAll(live)
      .then(() => commit(false))
      .catch((error: unknown) => {
        revert();
        if (!quiet) ui.toasts.error(failText(error, failedText));
      });
    return true;
  }

  /**
   * Immediate action with own sending without a toast (cancel sending):
   * shows `changes` while `send` runs; afterwards the
   * changes from its result apply (`kept`). If `send` throws, all drop out,
   * and the error goes to the caller, who reports it.
   */
  async hold<T extends { kept: Edits }>(account: string, changes: Edits, send: () => Promise<T>): Promise<T> {
    const token = this.#add(account, changes, false);
    try {
      await this.#beforeAll([{ account, edits: changes }]);
      const out = await send();
      this.#keep(token, out.kept);
      this.#settle(token);
      return out;
    } catch (error) {
      this.#drop(token);
      throw error;
    }
  }

  /**
   * "Delete permanently" after confirmation (runs immediately): the
   * emails disappear right away, the toast reports it without undo; if it
   * fails, they return.
   */
  purge(account: string, edits: Edits, text: string): void {
    this.purgeAll([{ account, edits }], text);
  }

  /** "Delete permanently" across several accounts (selection); if an account fails, only its emails return. */
  purgeAll(parts: readonly EditPart[], text: string): void {
    const live = withoutLocal(
      parts.filter((p) => p.edits.size > 0),
      false,
    );
    if (!live.length || refusedBy(live.map((p) => p.account))) return;
    // Before the toast: `show()` would send a pending action anyway, but without waiting for it.
    const before = this.#beforeAll(live);
    const tokens = live.map((p) => this.#add(p.account, p.edits, false));
    ui.toasts.show(text);
    before
      .then(() =>
        this.#commitAll(
          live.map((p) => ({ ...p, online: true })),
          tokens,
          false,
          m.error_act(),
        ),
      )
      .catch((error: unknown) => {
        for (const t of tokens) this.#drop(t);
        ui.toasts.error(failText(error));
      });
  }

  /**
   * "Empty Trash" after confirmation: the loaded emails (`shown`)
   * disappear right away, the server empties the mailbox (`keep`: tags). If it
   * fails, the loaded ones return until the next sync shows what remained.
   * Before that, every pending action goes out and is awaited: an email just
   * deleted is already shown in the trash by the list, at the server it only lies
   * there afterwards – otherwise it would stay (found with the E2E suite).
   */
  async clear(account: string, mailbox: Id, shown: Edits, keep: (box: Id) => boolean): Promise<void> {
    const token = this.#add(account, shown, false);
    try {
      await ui.toasts.flush();
      await this.#api.clear(account, mailbox, keep);
      this.#settle(token);
    } catch (error) {
      this.#drop(token);
      throw error;
    }
  }

  /** Lays waiting changes from the database over again (app start). */
  restore(): Promise<void> {
    return this.queue.restore();
  }

  /** "Try again" of the notice bar; without access or again without a response an error toast reports it. */
  async retry(): Promise<void> {
    refusedBy(this.queue.stuck.map((s) => s.account).filter(lacksAccess));
    await this.queue.replay(true);
    if (this.queue.stuck.some((s) => !lacksAccess(s.account))) ui.toasts.error(m.error_offline());
  }

  /** Sign-out: discard everything. */
  reset(): void {
    this.queue.reset();
    this.#entries = [];
  }

  /**
   * Sending per account (`tokens` belong to `parts`); if an account fails, its
   * changes drop out and `failed` reports it (`null`: silently). If all
   * fail, it throws the first error, and the caller reverts everything.
   */
  async #commitAll(parts: readonly EditPart[], tokens: readonly number[], keepalive: boolean, failed: string | null) {
    const results = await Promise.allSettled(parts.map((p, i) => this.#commit(tokens[i]!, p, keepalive, failed)));
    const errors = results.flatMap((r, i) => (r.status === 'rejected' ? [{ i, reason: r.reason as unknown }] : []));
    if (!errors.length) return;
    if (errors.length === parts.length) throw errors[0]!.reason;
    for (const { i } of errors) this.#drop(tokens[i]!);
    if (failed !== null) ui.toasts.error(failText(errors[0]!.reason, failed));
  }

  /**
   * Sending; if the server rejects only some emails, the rest applies, and
   * `partial` reports it as an error toast (`null`: silently).
   */
  async #commit(token: number, part: EditPart, keepalive: boolean, partial: string | null) {
    const { account, edits, send } = part;
    if (send) {
      this.#keep(token, await send(keepalive));
      this.#settle(token);
      return;
    }
    const waits = queueable(part);
    // Do not overtake; and when the page is closing nobody would see whether an attempt succeeded.
    if (waits && (this.queue.holds(account) || (keepalive && network.offline))) {
      await this.#enqueue(token, account, edits, partial === null, false, keepalive);
      return;
    }
    // Closing without a known outage: the request may fail without the page living to see it.
    const copy = waits && keepalive ? this.#copy(token, account, edits, partial === null) : null;
    try {
      await this.#api.set(account, edits, keepalive);
    } catch (error) {
      if (waits && unanswered(error)) {
        await copy;
        await this.#enqueue(token, account, edits, partial === null, true);
        return;
      }
      // The server has answered: nothing remains to replay.
      await this.#release(copy);
      if (!(error instanceof EditError) || error.ids.length >= edits.size) throw error;
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
      const rejected = new Set(error.ids);
      this.#entries = this.#entries.map((e) =>
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, not state
        e.token === token ? { ...e, edits: new Map([...e.edits].filter(([id]) => !rejected.has(id))) } : e,
      );
      if (partial) ui.toasts.error(partial);
      this.#settle(token);
      return;
    }
    await this.#release(copy);
    this.#settle(token);
  }

  /** A pending delayed action with the same emails goes out first (`ui.toasts.flush`). */
  #beforeAll(parts: readonly EditPart[]): Promise<void> {
    const waiting = this.#entries.some(
      (e) =>
        e.deferred &&
        e.done === Infinity &&
        parts.some((p) => e.account === p.account && [...p.edits.keys()].some((id) => e.edits.has(id))),
    );
    return waiting ? ui.toasts.flush() : Promise.resolve();
  }

  #add(account: string, edits: Edits, deferred: boolean): number {
    const token = ++this.#token;
    const rows = this.#rows(account, edits);
    this.#entries = [...this.#entries, { token, account, edits, done: Infinity, deferred, at: Date.now(), rows }];
    return token;
  }

  /** Rows of the conversations whose emails the change puts into a mailbox, as far as a list knows them. */
  #rows(account: string, edits: Edits): ListThread[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const ids = new Set([...edits].filter(([, edit]) => adds(edit)).map(([id]) => id));
    return ids.size ? this.#rowsOf(account, ids) : [];
  }

  /** The change stays laid over and waits for the server. */
  async #enqueue(token: number, account: string, edits: Edits, quiet: boolean, failed: boolean, closing = false) {
    const item = this.#item(token, account, edits, quiet);
    if (!item) return;
    this.#entries = this.#entries.map((e) => (e.token === token ? { ...e, key: item.key, deferred: false } : e));
    await this.queue.add(item, failed, closing);
  }

  /** Copy in the database while the request goes out as the page closes (`EditQueue.keep()`); returns its key. */
  async #copy(token: number, account: string, edits: Edits, quiet: boolean): Promise<string | null> {
    const item = this.#item(token, account, edits, quiet);
    if (!item) return null;
    await this.queue.keep(item);
    return item.key;
  }

  /** The copy from `#copy()` is no longer needed. */
  async #release(copy: Promise<string | null> | null): Promise<void> {
    const key = await copy;
    if (key) await this.queue.release(key);
  }

  /** Queue entry of an action; the same key for the copy and the entry. */
  #item(token: number, account: string, edits: Edits, quiet: boolean): QueuedEdit | null {
    const entry = this.#entries.find((e) => e.token === token);
    if (!entry) return null;
    const rows = entry.rows.length ? { rows: [...entry.rows] } : {};
    const key = queueKey(entry.at, token);
    return { key, account, edits: [...edits], subjects: this.#titles(account, edits), quiet, ...rows };
  }

  /** Subjects of the emails, as far as a source knows them. */
  #titles(account: string, edits: Edits): Record<Id, string> {
    const out: Record<Id, string> = {};
    for (const id of edits.keys())
      for (const source of this.#subjects) {
        const subject = source(account, id);
        if (subject === null) continue;
        out[id] = subject;
        break;
      }
    return out;
  }

  /** Lays an entry from the database over again. */
  #restored({ key, account, edits, rows = [] }: QueuedEdit): void {
    if (this.#entries.some((e) => e.key === key)) return;
    const token = ++this.#token;
    // From an earlier session: every change since then is new to them.
    const old = rows.map((r) => ({ ...r, seq: 0 }));
    this.#entries = [
      ...this.#entries,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, not state
      { token, account, edits: new Map(edits), done: Infinity, deferred: false, at: Date.now(), key, rows: old },
    ];
  }

  /** Replay of an entry done: `lost` ones drop out, the server wins; the rest counts as confirmed. */
  #finished(key: string, lost: readonly Id[]): void {
    const entry = this.#entries.find((e) => e.key === key);
    if (!entry) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, not state
    if (lost.length) this.#keep(entry.token, new Map([...entry.edits].filter(([id]) => !lost.includes(id))));
    if (lost.length >= entry.edits.size) this.#drop(entry.token);
    else this.#settle(entry.token);
  }

  /** The changes that apply after sending (`EditPart.send`, `hold()`). */
  #keep(token: number, kept: Edits): void {
    this.#entries = this.#entries.map((e) => (e.token === token ? { ...e, edits: kept } : e));
  }

  #drop(token: number): void {
    this.#entries = this.#entries.filter((e) => e.token !== token);
  }

  #settle(token: number): void {
    const done = stamp();
    const entries = this.#entries.map((e) => (e.token === token ? { ...e, done } : e));
    // The oldest confirmed ones drop out; by then a sync has long fetched them.
    const settled = entries.filter((e) => e.done !== Infinity);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local set, not state
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - KEEP_DONE)).map((e) => e.token));
    this.#entries = drop.size ? entries.filter((e) => !drop.has(e.token)) : entries;
  }
}

export const edits = new EmailEdits();
