/**
 * Queue for actions on emails: whatever got no response from the
 * server lies in `#lib/mail-queue.ts` and goes out later in its
 * order. `edits` lays the entries over list and reading view;
 * this module only knows order, replay and what the display needs.
 * If the response fails to come again, the account pauses and tries again on the
 * next trigger. If the server rejects, it wins, and the notice bar
 * names it. Drafts run behind the actions of their account;
 * they are never lost: on a conflict a new draft arises, and
 * if the server rejects, the version stays.
 */
/* eslint-disable svelte/prefer-svelte-reactivity -- local copies and bookkeeping; state only changes by reassignment */
import { isJmapError, isMethodError, type Id } from '@roedy/jmap';
import { ApiError } from '#lib/api.ts';
import { isOffline } from '#lib/errors.ts';
import { netEdit, type EmailEdit, type Edits } from '#lib/mail-actions.ts';
import type { EditLog, QueuedDraft, QueuedEdit } from '#lib/mail-queue.ts';

/**
 * Pause per account after a failed draft (ms): every attempt may reach the
 * server, the live sync reports that as `reached`, and the next one
 * would follow immediately. Patches are idempotent, drafts are not.
 */
export const DRAFT_PAUSE_MS = 10_000;

/** Before the id: a draft that exists only in the queue (`~` does not occur in JMAP ids). */
export const LOCAL_DRAFT = '~';

/** Responses of proxies when the mail server behind them is missing. */
const GATEWAY = [502, 503, 504];
/** Method errors after which a retry may help (RFC 8620, 3.6.2). */
const TRANSIENT = ['serverFail', 'serverPartialFail', 'serverUnavailable', 'rateLimit'];
/** The pill stays at least as long as for the sync (`PILL_MIN`), otherwise it would only flash. */
const PILL_MIN = 1500;

/** Interval of the attempts while the page is visible (ms); `reached` of the live sync usually comes earlier. */
export const QUEUE_POLL_MS = 60_000;

/** No response from the server: the action waits instead of failing. */
export function unanswered(error: unknown): boolean {
  if (isOffline(error)) return true;
  if (error instanceof ApiError) return GATEWAY.includes(error.status);
  return isJmapError(error, 'status') && GATEWAY.includes(error.status ?? 0);
}

/** The server has answered, and a retry would not help. */
export function refused(error: unknown): boolean {
  return isJmapError(error, 'request') || (isMethodError(error) && !TRANSIENT.includes(error.type));
}

/** Change per email over entries in their order; there and back again leaves nothing. */
function netOf(items: readonly QueuedEdit[]): Map<Id, EmailEdit> {
  const out = new Map<Id, EmailEdit>();
  for (const item of items)
    for (const [id, edit] of item.edits) {
      const net = netEdit(out.get(id), edit);
      if (net) out.set(id, net);
      else out.delete(id);
    }
  return out;
}

/** What the server did not take over (notice bar "Not synced"). */
export interface QueueLoss {
  /** Affected emails. */
  count: number;
  /** Subject of the first; with a single one the notice names it. */
  subject: string;
}

/** Offline versions that became a new draft (notice bar "Two versions"). */
export interface DraftConflict {
  count: number;
  /** Subject of the first; with a single one the notice names it. */
  subject: string;
  /** Their new draft: "View" opens it, with several the drafts. */
  account: string;
  id: Id;
  /** Accounts of the versions. */
  accounts: readonly string[];
}

/** Result of replaying a draft. */
export interface ReplayedDraft {
  id: Id;
  /** The state at the server was a different one: both versions stay. */
  conflict: boolean;
}

/** Brings drafts to the server; `compose` registers here. */
export interface DraftReplayer {
  /** Throws if the draft should stay: without a response or rejected. */
  replay(item: QueuedDraft): Promise<ReplayedDraft>;
  /** `newer`: in the meantime a newer version is waiting, which now replaces `id`. */
  replayed(item: QueuedDraft, id: Id, newer: boolean): void;
  /** Discarded or sent while the version was in flight: the new draft goes. */
  revoke(account: string, id: Id): void;
}

/** Environment of the queue; `edits` supplies it, tests replace it. */
export interface QueueEnv {
  log(): EditLog | null;
  /** Replays the changes of an account; returns the emails that were not taken over. */
  replay(account: string, edits: Edits): Promise<Id[]>;
  /** Does the browser report no connection? Then an attempt shows no pill. */
  offline(): boolean;
  /** Does the account have no access? Then it waits until it signs in again. */
  lacksAccess(account: string): boolean;
  /** One tab at a time; `task` does not run while another one is replaying. */
  exclusive(task: () => Promise<void>): Promise<void>;
  /** Entry from the database that `edits` does not know yet. */
  restored(item: QueuedEdit): void;
  /** Entry is done; the server did not take over `lost`. */
  finished(key: string, lost: readonly Id[]): void;
  /** Replay finished; the changes to `count` emails have arrived. */
  transferred(count: number): void;
}

/** One tab at a time (`navigator.locks`); in insecure contexts without protection, the patches are idempotent. */
export function exclusive(task: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return task();
  return locks.request('roedy-mail-queue', { ifAvailable: true }, (lock) => (lock ? task() : undefined));
}

export class EditQueue {
  /** Waiting entries in their order. */
  items = $state.raw<readonly QueuedEdit[]>([]);
  /** Waiting drafts in their order. */
  drafts = $state.raw<readonly QueuedDraft[]>([]);
  /** Changes at the start of the replay; `0` if it is not running (sync pill). */
  replaying = $state(0);
  /** Notice bar "Not synced", until closed or reloaded. */
  lost = $state.raw<QueueLoss | null>(null);
  /** Notice bar "Two versions", until closed, "View" or reloaded. */
  conflict = $state.raw<DraftConflict | null>(null);
  /** Accounts whose last attempt got no response. */
  #failed = $state.raw<ReadonlySet<string>>(new Set());

  readonly #env: QueueEnv;
  #replayer: DraftReplayer | null = null;
  /** Waiting changes per account: one per email, a draft counts as one. */
  #counts = $derived.by(() => {
    const out = new Map<string, number>();
    for (const account of new Set([...this.items, ...this.drafts].map((i) => i.account))) {
      const net = netOf(this.items.filter((i) => i.account === account && !i.sent));
      // A message stays one change, even if an action waits next to its version.
      const drafts = this.drafts.filter((d) => d.account === account && !net.has(d.replace?.id ?? ''));
      out.set(account, net.size + drafts.length);
    }
    return out;
  });
  /** Until when the drafts of an account wait after a failure. */
  #draftPause = new Map<string, number>();
  /** Entries that are safely in the database. */
  #saved = new Set<string>();
  /** Copies of entries whose `keepalive` request is still running (`keep()`): only in the database. */
  #flying = new Set<string>();
  /** Finished entries: an `all()` that read before the deletion would otherwise bring them back. */
  #settled = new Set<string>();
  #run: Promise<void> | null = null;
  #again = false;
  /** "Try again": the pill shows the attempt, even after a failure. */
  #asked = false;
  /** Increases with `reset()`: a running pass then belongs to the old session. */
  #epoch = 0;
  #pillAt = 0;
  #pillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(env: QueueEnv) {
    this.#env = env;
  }

  /** Attaches the replay of the drafts (`compose`). */
  attach(replayer: DraftReplayer): void {
    this.#replayer = replayer;
  }

  /** Waiting changes: one per email, there and back cancels out. */
  get count(): number {
    return [...this.#counts.values()].reduce((a, b) => a + b, 0);
  }

  /** Must a new action of the account queue up instead of overtaking? */
  holds(account: string): boolean {
    return this.items.some((i) => i.account === account);
  }

  /** Accounts whose changes wait although the app is online: last attempt without a response or no access. */
  get stuck(): { account: string; count: number }[] {
    return [...this.#counts]
      .filter(([account, count]) => count && (this.#failed.has(account) || this.#env.lacksAccess(account)))
      .map(([account, count]) => ({ account, count }));
  }

  /**
   * Takes in an entry. `failed`: its attempt got no response; the
   * next replay comes by itself. `closing`: the page is going away; nobody would see the
   * result of a replay any more.
   */
  async add(item: QueuedEdit, failed: boolean, closing = false): Promise<void> {
    this.#flying.delete(item.key);
    this.items = sorted([...this.items, item]);
    if (failed) this.#failed = new Set([...this.#failed, item.account]);
    const saved = (await this.#env.log()?.add(item)) ?? false;
    if (saved) this.#saved.add(item.key);
    if (!failed && !closing) void this.replay();
  }

  /**
   * The page is closing while `item` goes out with `keepalive`: a copy goes to the
   * database first, because the page may end before the response, also without
   * a known outage. If it ends, the next start replays the copy (`sent`); this tab
   * does not replay it, it waits for the response (`release()`, or `add()` if none comes).
   */
  async keep(item: QueuedEdit): Promise<void> {
    this.#flying.add(item.key);
    await this.#env.log()?.add({ ...item, sent: true });
  }

  /** The server has answered to a copy from `keep()`: it leaves the database. */
  async release(key: string): Promise<void> {
    if (!this.#flying.delete(key)) return;
    // An `all()` that read before the deletion would otherwise bring it back.
    this.#settled.add(key);
    await this.#env.log()?.remove(key);
  }

  /**
   * Takes in a version; the previous one of the same draft goes. `failed`: its
   * attempt got no response. `closing`: the page is going away.
   */
  async addDraft(item: QueuedDraft, failed: boolean, closing = false): Promise<void> {
    this.drafts = sorted([...this.drafts.filter((d) => d.key !== item.key), item]);
    this.#settled.delete(item.key);
    if (failed) this.#failed = new Set([...this.#failed, item.account]);
    const saved = (await this.#env.log()?.putDraft(item)) ?? false;
    if (saved) this.#saved.add(item.key);
    if (!failed && !closing) void this.replay();
  }

  /** Waiting version of draft `account`/`id`: state at the server or own key (`LOCAL_DRAFT`). */
  findDraft(account: string, id: Id): QueuedDraft | undefined {
    return this.drafts.find(
      (d) =>
        (d.replace?.account === account && d.replace.id === id) ||
        (d.moved?.account === account && d.moved.id === id) ||
        (d.account === account && `${LOCAL_DRAFT}${d.key}` === id),
    );
  }

  /** Takes a version out of the queue: discarded, sent. */
  async dropDraft(key: string): Promise<void> {
    if (!this.drafts.some((d) => d.key === key)) return;
    this.drafts = this.drafts.filter((d) => d.key !== key);
    this.#saved.delete(key);
    this.#settled.add(key);
    await this.#env.log()?.removeDraft(key);
  }

  /** At start and before every run: take over entries from the database, discard ones finished by other tabs. */
  async restore(): Promise<void> {
    const epoch = this.#epoch;
    const log = this.#env.log();
    const [saved, drafts] = await Promise.all([log?.all(), log?.drafts()]);
    if (!saved || !drafts || epoch !== this.#epoch) return;
    this.#restoreDrafts(drafts);
    const known = new Set(saved.map((i) => i.key));
    const gone = this.items.filter((i) => this.#saved.has(i.key) && !known.has(i.key));
    for (const item of gone) this.#saved.delete(item.key);
    const fresh = saved.filter(
      (s) => !this.#settled.has(s.key) && !this.#flying.has(s.key) && !this.items.some((i) => i.key === s.key),
    );
    for (const item of [...this.items, ...fresh]) if (known.has(item.key)) this.#saved.add(item.key);
    if (!gone.length && !fresh.length) return;
    this.items = sorted([...this.items.filter((i) => !gone.includes(i)), ...fresh]);
    for (const item of gone) this.#env.finished(item.key, []);
    for (const item of fresh) this.#env.restored(item);
  }

  /** Like `restore()` for drafts; a newer version of this tab outweighs the one read. */
  #restoreDrafts(saved: readonly QueuedDraft[]): void {
    const known = new Set(saved.map((d) => d.key));
    const gone = this.drafts.filter((d) => this.#saved.has(d.key) && !known.has(d.key));
    for (const item of gone) this.#saved.delete(item.key);
    const fresh = saved.filter((s) => !this.#settled.has(s.key) && !this.drafts.some((d) => d.key === s.key));
    for (const item of [...this.drafts, ...fresh]) if (known.has(item.key)) this.#saved.add(item.key);
    if (gone.length || fresh.length) this.drafts = sorted([...this.drafts.filter((d) => !gone.includes(d)), ...fresh]);
  }

  get #empty(): boolean {
    return !this.items.length && !this.drafts.length;
  }

  /** Replays what is waiting; ends when nothing more goes. If a pass is already running, another one follows it. */
  async replay(asked = false): Promise<void> {
    if (this.#empty && !this.#run) await this.restore();
    if (this.#empty && !this.#run) return;
    if (asked) this.#draftPause.clear();
    this.#again = true;
    this.#asked ||= asked;
    this.#run ??= this.#start();
    return this.#run;
  }

  async #start(): Promise<void> {
    let ran = false;
    try {
      await this.#env.exclusive(() => {
        ran = true;
        return this.#loop();
      });
    } finally {
      this.#run = null;
    }
    // Was something added after the end of the loop? Without the lock (`ran`) the other tab or the next trigger takes over.
    if (ran && this.#again) await this.replay();
  }

  /** Connection back: old failures no longer count, otherwise "Not synced" would show until the first result. */
  resume(): void {
    this.#failed = new Set();
    this.#draftPause.clear();
    void this.replay();
  }

  /** Discards the entries of all accounts not in `accounts`. */
  retain(accounts: readonly string[]): void {
    const gone = this.items.filter((i) => !accounts.includes(i.account));
    if (gone.length) this.items = this.items.filter((i) => !gone.includes(i));
    const drafts = this.drafts.filter((d) => !accounts.includes(d.account));
    if (drafts.length) this.drafts = this.drafts.filter((d) => !drafts.includes(d));
    for (const item of drafts) {
      this.#saved.delete(item.key);
      this.#settled.add(item.key);
    }
    for (const item of gone) {
      this.#saved.delete(item.key);
      this.#settled.add(item.key);
      this.#env.finished(
        item.key,
        item.edits.map(([id]) => id),
      );
    }
    void this.#env.log()?.retain(accounts);
  }

  /** Sign-out: forget everything; the database ends with the session. */
  reset(): void {
    this.#epoch++;
    this.items = [];
    this.drafts = [];
    this.lost = null;
    this.conflict = null;
    this.#failed = new Set();
    this.#saved.clear();
    this.#settled.clear();
    this.#flying.clear();
    this.#draftPause.clear();
    this.#again = false;
    if (this.#pillTimer) clearTimeout(this.#pillTimer);
    this.#pillTimer = null;
    this.replaying = 0;
  }

  async #loop(): Promise<void> {
    const epoch = this.#epoch;
    let done = 0;
    while (this.#again && epoch === this.#epoch) {
      this.#again = false;
      await this.restore();
      const accounts = [...new Set([...this.items, ...this.drafts].map((i) => i.account))].filter(
        (a) => !this.#env.lacksAccess(a),
      );
      if (!accounts.length) continue;
      // An attempt without a connection shows nothing: offline the pill would otherwise run on every action.
      if (!this.#env.offline() && (this.#asked || accounts.some((a) => !this.#failed.has(a)))) this.#pill();
      this.#asked = false;
      const counts = await Promise.all(accounts.map((a) => this.#replayAccount(a, epoch)));
      done += counts.reduce((a, b) => a + b, 0);
    }
    if (epoch !== this.#epoch) return;
    this.#pillOff();
    if (done) this.#env.transferred(done);
  }

  /**
   * What is waiting for an account, also what is added meanwhile: first the
   * actions, then the drafts, because a version replaces the email that
   * an action may target. Returns the number of changes that arrived.
   */
  async #replayAccount(account: string, epoch: number): Promise<number> {
    const edits = await this.#replayEdits(account, epoch);
    return edits.stopped ? edits.done : edits.done + (await this.#replayDrafts(account, epoch));
  }

  /** One change per email; `stopped`: no response came, the account pauses. */
  async #replayEdits(account: string, epoch: number): Promise<{ done: number; stopped: boolean }> {
    let done = 0;
    for (;;) {
      const batch = nextBatch(this.items.filter((i) => i.account === account));
      if (!batch.length || this.#env.lacksAccess(account)) return { done, stopped: false };
      const net = netOf(batch);
      let lost: readonly Id[] = [];
      try {
        if (net.size) lost = await this.#env.replay(account, net);
      } catch (error) {
        if (epoch !== this.#epoch) return { done, stopped: true };
        if (!refused(error)) {
          this.#failed = new Set([...this.#failed, account]);
          return { done, stopped: true };
        }
        lost = [...net.keys()];
      }
      if (epoch !== this.#epoch) return { done, stopped: true };
      for (const item of batch) {
        this.#settled.add(item.key);
        this.#saved.delete(item.key);
      }
      this.items = this.items.filter((i) => !batch.includes(i));
      const log = this.#env.log();
      if (log) await Promise.all(batch.map((item) => log.remove(item.key)));
      if (epoch !== this.#epoch) return { done, stopped: true };
      if (this.#failed.has(account)) this.#failed = new Set([...this.#failed].filter((a) => a !== account));
      for (const item of batch)
        this.#env.finished(
          item.key,
          lost.filter((id) => item.edits.some(([e]) => e === id)),
        );
      this.#report(batch, lost);
      // Copies from `keep()` arrive without a toast: nobody saw them waiting.
      done += [...netOf(batch.filter((i) => !i.sent)).keys()].filter((id) => !lost.includes(id)).length;
    }
  }

  /**
   * Drafts of an account, one after the other. If the response fails to come, the account
   * pauses. If the server rejects one, it stays, because it is self-written
   * text and "Try again" is in the bar; the others
   * go out anyway.
   */
  async #replayDrafts(account: string, epoch: number): Promise<number> {
    let done = 0;
    if (Date.now() < (this.#draftPause.get(account) ?? 0)) return done;
    const skipped = new Set<string>();
    for (;;) {
      const replayer = this.#replayer;
      const item = this.drafts.find((d) => d.account === account && !skipped.has(d.key));
      if (!item || !replayer || this.#env.lacksAccess(account)) return done;
      let saved: ReplayedDraft;
      try {
        saved = await replayer.replay(item);
      } catch (error) {
        if (epoch !== this.#epoch) return done;
        this.#failed = new Set([...this.#failed, account]);
        // If someone wanted a new attempt meanwhile, it follows right away.
        if (!this.#asked) this.#draftPause.set(account, Date.now() + DRAFT_PAUSE_MS);
        if (unanswered(error)) return done;
        skipped.add(item.key);
        continue;
      }
      if (epoch !== this.#epoch) return done;
      if (!skipped.size) {
        this.#draftPause.delete(account);
        if (this.#failed.has(account)) this.#failed = new Set([...this.#failed].filter((a) => a !== account));
      }
      const current = this.drafts.find((d) => d.key === item.key);
      if (!current) {
        replayer.revoke(account, saved.id);
        continue;
      }
      if (saved.conflict) this.#doubled(item, saved.id);
      replayer.replayed(item, saved.id, current !== item);
      if (current !== item) {
        // Written during the replay: this version now replaces the draft just created,
        // even if it switched to another account; that account's pass then follows.
        const same = current.account === account;
        const old = { account, id: saved.id };
        await this.addDraft({ ...current, replace: same ? old : null, moved: same ? null : old }, false, true);
        this.#again ||= !same;
        continue;
      }
      this.drafts = this.drafts.filter((d) => d !== item);
      this.#saved.delete(item.key);
      this.#settled.add(item.key);
      await this.#env.log()?.removeDraft(item.key);
      if (epoch !== this.#epoch) return done;
      done++;
    }
  }

  /** Notice bar "Two versions". */
  #doubled(item: QueuedDraft, id: Id): void {
    const was = this.conflict;
    this.conflict = {
      count: (was?.count ?? 0) + 1,
      subject: was?.subject ?? item.email.subject,
      account: was?.account ?? item.account,
      id: was?.id ?? id,
      accounts: [...new Set([...(was?.accounts ?? []), item.account])],
    };
  }

  /** Notice bar "Not synced"; whatever nobody triggered themselves (`quiet`) is not reported. */
  #report(batch: readonly QueuedEdit[], lost: readonly Id[]): void {
    const seen = batch.filter((i) => !i.quiet);
    const told = lost.filter((id) => seen.some((i) => i.edits.some(([e]) => e === id)));
    if (!told.length) return;
    const first = told[0]!;
    const subject = seen.find((i) => first in i.subjects)?.subjects[first] ?? '';
    this.lost = { count: (this.lost?.count ?? 0) + told.length, subject: this.lost?.subject ?? subject };
  }

  #pill(): void {
    if (this.#pillTimer) clearTimeout(this.#pillTimer);
    this.#pillTimer = null;
    if (!this.replaying) this.#pillAt = Date.now();
    this.replaying = Math.max(this.replaying, this.count);
  }

  #pillOff(): void {
    if (!this.replaying) return;
    if (this.#pillTimer) clearTimeout(this.#pillTimer);
    this.#pillTimer = setTimeout(
      () => {
        this.#pillTimer = null;
        this.replaying = 0;
      },
      Math.max(0, this.#pillAt + PILL_MIN - Date.now()),
    );
  }
}

/**
 * Entries of an account that go out together: the waiting ones up to the next copy from
 * `keep()`, a copy alone. A copy may already apply at the server; netted with
 * a later opposite change, nothing would go out and the server would keep the copy's value.
 */
function nextBatch(items: readonly QueuedEdit[]): readonly QueuedEdit[] {
  if (items[0]?.sent) return items.slice(0, 1);
  const copy = items.findIndex((i) => i.sent);
  return copy < 0 ? items : items.slice(0, copy);
}

const sorted = <T extends { key: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
