/**
 * Sync of "Scheduled" per mail account: sending a
 * scheduled email changes no state at the server, nor does it trigger a
 * push. The app therefore queries the submissions – at start, on every
 * new email state (`touch()` from the live sync) and with a timer for
 * the earliest `sendAt`, then at growing intervals while a
 * submission is still `pending` after its `sendAt` – and files every email with
 * `$scheduled` according to the status of its submission: `final` to "Sent",
 * `canceled` as a draft to "Drafts", without a submission (Stalwart deletes them
 * three days after `sendAt`; only for emails that are older) also to
 * "Sent", each without `$scheduled`.
 * Along the way it keeps the send times for list and reading view (`sendAt()`).
 */

import type { EmailSubmission, Id, JmapClient, PatchObject } from '@roedy/jmap';
import { SvelteMap } from 'svelte/reactivity';
import { patchOf, unscheduleEdit, type PlanBoxes } from '#lib/mail-actions.ts';
import type { RoleId } from '#lib/routes.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';

/** Intervals after the earliest `sendAt` while the submission is still `pending` (delivery, retries). */
export const LATE_STEPS = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000] as const;
/** Buffer after `sendAt`: the server releases the message only at that time. */
export const SLACK = 1000;
/** Longest wait in one go (`setTimeout` holds at most about 24 days). */
export const MAX_WAIT = 24 * 60 * 60_000;
/** Next attempt after a failed sync. */
export const RETRY = 60_000;
/**
 * Stalwart deletes submissions three days after `sendAt`: if an email
 * that is younger (`receivedAt` lies before `sendAt`) lacks one, something
 * else is wrong, and the email stays in "Scheduled".
 */
export const GONE_AFTER = 3 * 24 * 60 * 60_000;

/** Submission as the sync needs it. */
export type ScheduledSubmission = Pick<EmailSubmission, 'emailId' | 'sendAt' | 'undoStatus'>;

/** Target of an email from "Scheduled": stays (`pending`), "Sent" or "Drafts". */
export type Verdict = 'pending' | 'sent' | 'draft';

/** Email in "Scheduled" with `$scheduled`. */
export interface ScheduledEmail {
  id: Id;
  /** Saving of the draft (ms). */
  receivedAt: number;
}

/** Mailboxes of the sync. */
export interface ScheduledBoxes {
  scheduled: Id;
  sent: Id | null;
  drafts: Id | null;
}

/**
 * Target according to the status of all submissions of the email: a waiting one wins
 * (e.g. after cancelling and rescheduling), then a sent one, then a
 * withdrawn one; without a submission the email counts as sent.
 */
export function verdictOf(statuses: readonly ScheduledSubmission['undoStatus'][]): Verdict {
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('final')) return 'sent';
  if (statuses.includes('canceled')) return 'draft';
  return 'sent';
}

/**
 * Change of the email to "Sent" or as a draft to "Drafts", without
 * `$scheduled` (`unscheduleEdit()`, also for undo after scheduling in
 * `compose` and cancel sending). If the mailbox is missing, it stays in "Scheduled".
 */
export function verdictPatch(verdict: Exclude<Verdict, 'pending'>, boxes: PlanBoxes): PatchObject {
  return patchOf(unscheduleEdit(verdict === 'sent' ? 'sent' : 'drafts', boxes));
}

/**
 * Wait until the next sync: until the next `sendAt` (plus
 * `SLACK`); if one already lies in the past, at most the step `late` from
 * `LATE_STEPS` (the last one repeats). `null` without a waiting submission.
 */
export function nextWait(sendAts: readonly number[], now: number, late: number): { wait: number | null; late: number } {
  const ahead = sendAts.filter((t) => t + SLACK > now);
  const overdue = ahead.length < sendAts.length;
  const waits = [
    ...(ahead.length ? [Math.min(...ahead) + SLACK - now] : []),
    ...(overdue ? [LATE_STEPS[Math.min(late, LATE_STEPS.length - 1)]!] : []),
  ];
  return { wait: waits.length ? Math.min(...waits, MAX_WAIT) : null, late: overdue ? late + 1 : 0 };
}

/** Access to the mail servers; replaceable in tests. */
export interface ScheduledApi {
  /** Mailboxes of the account; `null` without "Scheduled". */
  boxes(account: string, signal: AbortSignal): Promise<ScheduledBoxes | null>;
  /** Emails in "Scheduled" with `$scheduled` and the account's waiting submissions, in one request. */
  pending(
    account: string,
    box: Id,
    signal: AbortSignal,
  ): Promise<{ emails: ScheduledEmail[]; submissions: ScheduledSubmission[] }>;
  /** All submissions of these emails. */
  submissions(account: string, emails: readonly Id[], signal: AbortSignal): Promise<ScheduledSubmission[]>;
  /** Updates the emails; throws if a change fails. */
  update(account: string, patches: Record<Id, PatchObject>, signal: AbortSignal): Promise<void>;
}

const PROPS = ['emailId', 'sendAt', 'undoStatus'] satisfies (keyof EmailSubmission)[];

export function jmapScheduledApi(clientOf: (account: string) => Promise<JmapClient>): ScheduledApi {
  return {
    async boxes(account, signal) {
      // Take loaded mailboxes; the others are only loaded by the sidebar where they are visible (layout), here
      // the roles are enough.
      let roleOf = (role: RoleId) => mailboxes.role(account, role)?.id ?? null;
      if (mailboxes.of(account)?.status !== 'ready') {
        const client = await clientOf(account);
        const accountId = await client.accountId(undefined, signal);
        const res = await client.call('Mailbox/get', { accountId, ids: null, properties: ['role'] }, signal);
        roleOf = (role) => res.list.find((b) => b.role === role)?.id ?? null;
      }
      const scheduled = roleOf('scheduled');
      return scheduled ? { scheduled, sent: roleOf('sent'), drafts: roleOf('drafts') } : null;
    },

    async pending(account, box, signal) {
      const client = await clientOf(account);
      const accountId = await client.accountId(undefined, signal);
      const b = client.batch();
      const inBox = b.call('Email/query', { accountId, filter: { inMailbox: box, hasKeyword: '$scheduled' } });
      const emails = b.call('Email/get', { accountId, '#ids': inBox.ref('/ids'), properties: ['receivedAt'] });
      const query = b.call('EmailSubmission/query', { accountId, filter: { undoStatus: 'pending' } });
      const get = b.call('EmailSubmission/get', { accountId, '#ids': query.ref('/ids'), properties: PROPS });
      const res = await b.send(signal);
      return {
        emails: res.get(emails).list.map((e) => ({ id: e.id, receivedAt: Date.parse(e.receivedAt) })),
        submissions: res.get(get).list,
      };
    },

    async submissions(account, emails, signal) {
      const client = await clientOf(account);
      const accountId = await client.accountId(undefined, signal);
      const b = client.batch();
      const query = b.call('EmailSubmission/query', { accountId, filter: { emailIds: [...emails] } });
      const get = b.call('EmailSubmission/get', { accountId, '#ids': query.ref('/ids'), properties: PROPS });
      return (await b.send(signal)).get(get).list;
    },

    async update(account, patches, signal) {
      const client = await clientOf(account);
      const accountId = await client.accountId(undefined, signal);
      const res = await client.call('Email/set', { accountId, update: patches }, signal);
      const failed = Object.keys(res.notUpdated ?? {});
      if (failed.length) throw new Error(`Email/set: ${failed.join(', ')}`);
    },
  };
}

/** Sync of one account. */
interface AccountScheduled {
  account: string;
  /** Aborts everything: account removed, no longer usable or signed out. */
  stop: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** Pending sync; several triggers during one run result in one more. */
  want: boolean;
  running: Promise<void> | null;
  /** Timer expired: only then the step in `LATE_STEPS` advances, not on every new email state. */
  timed: boolean;
  /** Consecutive timer syncs after which a `sendAt` already lay in the past (step in `LATE_STEPS`). */
  late: number;
}

export class ScheduledSync {
  readonly #api: ScheduledApi;
  /** Per account "Scheduled" and the send times (ms) of its emails with a waiting submission. */
  readonly #times = new SvelteMap<string, { box: Id; at: ReadonlyMap<Id, number> }>();
  // Not reactive: timers and runs are not displayed.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #accounts = new Map<string, AccountScheduled>();

  constructor(api: ScheduledApi = jmapScheduledApi((account) => accounts.client(account))) {
    this.#api = api;
  }

  /**
   * Send time of a scheduled email while its submission is waiting
   * and it lies in "Scheduled" (`mailboxIds`): if it leaves it, the time no longer
   * applies, even before the next sync knows.
   */
  sendAt(account: string, email: Id, mailboxIds: readonly Id[]): number | undefined {
    const known = this.#times.get(account);
    return known && mailboxIds.includes(known.box) ? known.at.get(email) : undefined;
  }

  /** Syncs exactly these accounts: starts new ones, ends the rest. */
  retain(ids: readonly string[]): void {
    for (const account of [...this.#accounts.keys()]) if (!ids.includes(account)) this.#stop(account);
    for (const account of ids)
      if (!this.#accounts.has(account)) {
        const a: AccountScheduled = {
          account,
          stop: new AbortController(),
          timer: null,
          want: false,
          running: null,
          timed: false,
          late: 0,
        };
        this.#accounts.set(account, a);
        this.#request(a);
      }
  }

  /** New email state of the account (live sync): sync again. */
  touch(account: string): void {
    const a = this.#accounts.get(account);
    if (a) this.#request(a);
  }

  /** Sign-out: end everything. */
  reset(): void {
    this.retain([]);
    this.#times.clear();
  }

  #stop(account: string): void {
    const a = this.#accounts.get(account);
    if (!a) return;
    this.#accounts.delete(account);
    a.stop.abort();
    if (a.timer) clearTimeout(a.timer);
    this.#times.delete(account);
  }

  #request(a: AccountScheduled): void {
    if (a.stop.signal.aborted) return;
    a.want = true;
    a.running ??= this.#work(a);
  }

  async #work(a: AccountScheduled): Promise<void> {
    while (a.want && !a.stop.signal.aborted) {
      a.want = false;
      if (a.timer) clearTimeout(a.timer);
      a.timer = null;
      const timed = a.timed;
      a.timed = false;
      const wait = await this.#check(a, timed).catch(() => RETRY);
      if (wait !== null && !a.stop.signal.aborted && !a.want)
        a.timer = setTimeout(() => {
          a.timer = null;
          a.timed = true;
          this.#request(a);
        }, wait);
    }
    // In the same step as the last check: a trigger after it starts a new run.
    a.running = null;
  }

  /** One sync; returns the wait until the next one (`null`: none needed). */
  async #check(a: AccountScheduled, timed: boolean): Promise<number | null> {
    const { account } = a;
    const { signal } = a.stop;
    const boxes = await this.#api.boxes(account, signal);
    if (signal.aborted) return null;
    if (!boxes) {
      if (this.#times.has(account)) this.#times.delete(account);
      return null;
    }
    const { emails, submissions } = await this.#api.pending(account, boxes.scheduled, signal);
    if (signal.aborted) return null;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- result, not state
    const inBox = new Set(emails.map((e) => e.id));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- result, not state
    const times = new Map<Id, number>();
    const add = (s: ScheduledSubmission) => {
      if (s.undoStatus !== 'pending' || !inBox.has(s.emailId)) return;
      const t = Date.parse(s.sendAt);
      if (!Number.isNaN(t)) times.set(s.emailId, Math.min(times.get(s.emailId) ?? t, t));
    };
    submissions.forEach(add);
    const rest = emails.filter((e) => !times.has(e.id));
    const patches: Record<Id, PatchObject> = {};
    if (rest.length) {
      // No longer waiting – or beyond the query's limit: the status of these emails one by one.
      const all = await this.#api.submissions(
        account,
        rest.map((e) => e.id),
        signal,
      );
      if (signal.aborted) return null;
      all.forEach(add);
      const now = Date.now();
      for (const { id, receivedAt } of rest) {
        const statuses = all.filter((s) => s.emailId === id).map((s) => s.undoStatus);
        if (!statuses.length && receivedAt > now - GONE_AFTER) continue;
        const verdict = verdictOf(statuses);
        if (verdict !== 'pending') patches[id] = verdictPatch(verdict, boxes);
      }
    }
    // Only on changes: list and reading view would otherwise recalculate on every email state.
    const known = this.#times.get(account);
    if (
      !known ||
      known.box !== boxes.scheduled ||
      known.at.size !== times.size ||
      [...times].some(([id, t]) => known.at.get(id) !== t)
    )
      this.#times.set(account, { box: boxes.scheduled, at: times });
    const next = nextWait([...times.values()], Date.now(), a.late);
    // A new email state (e.g. every incoming email) does not advance the step; without delay it starts anew.
    if (timed || !next.late) a.late = next.late;
    if (Object.keys(patches).length) {
      // If filing fails, the next sync tries again, at the latest after `RETRY`.
      const failed = await this.#api.update(account, patches, signal).then(
        () => false,
        () => true,
      );
      if (failed) return Math.min(next.wait ?? RETRY, RETRY);
    }
    return next.wait;
  }
}

export const scheduled = new ScheduledSync();
