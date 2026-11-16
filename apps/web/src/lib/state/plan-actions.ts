/**
 * Actions in "Scheduled": cancel
 * sending, send now, and delete with cancellation on execution. Cancelling
 * means at the server: set the email's waiting submission to `undoStatus:
 * canceled` and update the email on success (`onSuccessUpdateEmail`).
 * If it no longer waits (`cannotUnsend`), the status of its submissions follows
 * the sync (`scheduled`): sent to "Sent" with "The message
 * has already been sent.", without an accepted recipient to "Drafts",
 * already cancelled elsewhere counts as the goal reached.
 *
 * `edits` shows the changes as for the other actions; cancel and
 * send now run immediately (`edits.hold`), delete after the toast expires
 * (`EditPart.send`).
 */

import type { EmailSubmission, Id, JmapClient, PatchObject } from '@roedy/jmap';
import { failText } from '#lib/errors.ts';
import {
  cancelEdits,
  patchOf,
  scheduledTrashEdits,
  unscheduleEdit,
  type ActionEmail,
  type ActionRoles,
  type Edits,
  type EmailEdit,
  type PlanBoxes,
} from '#lib/mail-actions.ts';
import { m } from '#lib/paraglide/messages.js';
import { noneAccepted } from '#lib/plan.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { compose } from '#lib/state/compose.svelte.ts';
import { edits, refusedBy, type EditPart } from '#lib/state/edits.svelte.ts';
import { scheduled } from '#lib/state/scheduled.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** What "send now" needs from the previous submission. */
export type PriorSubmission = Pick<EmailSubmission, 'identityId' | 'envelope'>;

/** Submission of an email that was no longer waiting. */
export type LateSubmission = Pick<
  EmailSubmission,
  'undoStatus' | 'deliveryStatus' | 'identityId' | 'envelope' | 'sendAt'
>;

/** Response to the cancellation per email. */
export interface CancelResult {
  /** Cancelled, with the previous submission. */
  canceled: Map<Id, PriorSubmission>;
  /** No longer waiting (`cannotUnsend` or no waiting submission): all its submissions. */
  late: Map<Id, LateSubmission[]>;
  /** Rejected for another reason. */
  failed: Id[];
}

/** Access to the mail servers; replaceable in tests. */
export interface PlanApi {
  /**
   * Cancels the waiting submissions of the emails and then updates each email
   * with its patch. Throws if the request as a whole fails.
   */
  cancel(account: string, patches: Record<Id, PatchObject>, keepalive: boolean): Promise<CancelResult>;
  /** Updates the emails; throws if a change fails. */
  update(account: string, patches: Record<Id, PatchObject>): Promise<void>;
}

const PRIOR = ['emailId', 'identityId', 'envelope', 'undoStatus'] satisfies (keyof EmailSubmission)[];

export function jmapPlanApi(clientOf: (account: string) => Promise<JmapClient>): PlanApi {
  const update = async (client: JmapClient, accountId: Id, patches: Record<Id, PatchObject>) => {
    const res = await client.call('Email/set', { accountId, update: patches });
    const failed = Object.keys(res.notUpdated ?? {});
    if (failed.length) throw new Error(`Email/set: ${failed.join(', ')}`);
  };
  return {
    async cancel(account, patches, keepalive) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const ids = Object.keys(patches);
      const out: CancelResult = { canceled: new Map(), late: new Map(), failed: [] };
      const first = client.batch();
      const query = first.call('EmailSubmission/query', {
        accountId,
        filter: { emailIds: ids, undoStatus: 'pending' },
      });
      const get = first.call('EmailSubmission/get', { accountId, '#ids': query.ref('/ids'), properties: PRIOR });
      const waiting = (await first.send(undefined, { keepalive }))
        .get(get)
        .list.filter((s) => s.undoStatus === 'pending' && Object.hasOwn(patches, s.emailId));
      const late = new Set(ids.filter((id) => !waiting.some((s) => s.emailId === id)));
      const failed = new Set<Id>();
      if (waiting.length) {
        const second = client.batch();
        const set = second.call('EmailSubmission/set', {
          accountId,
          update: Object.fromEntries(waiting.map((s) => [s.id, { undoStatus: 'canceled' }])),
          onSuccessUpdateEmail: Object.fromEntries(waiting.map((s) => [s.id, patches[s.emailId]!])),
        });
        const response = await second.send(undefined, { keepalive });
        const res = response.get(set);
        const changed = response.implicit(set, 'Email/set')?.updated ?? {};
        for (const s of waiting) {
          if (res.updated && Object.hasOwn(res.updated, s.id)) {
            if (!out.canceled.has(s.emailId))
              out.canceled.set(s.emailId, { identityId: s.identityId, envelope: s.envelope ?? null });
          } else if (res.notUpdated?.[s.id]?.type === 'cannotUnsend') late.add(s.emailId);
          else failed.add(s.emailId);
        }
        for (const id of [...late, ...failed]) out.canceled.delete(id);
        for (const id of failed) late.delete(id);
        // `onSuccessUpdateEmail` on an update is unverified with Stalwart: otherwise do it ourselves.
        const missing = [...out.canceled.keys()].filter((id) => !Object.hasOwn(changed, id));
        if (missing.length)
          await update(client, accountId, Object.fromEntries(missing.map((id) => [id, patches[id]!]))).catch(() => {});
      }
      out.failed = [...failed];
      if (late.size) {
        const third = client.batch();
        const all = third.call('EmailSubmission/query', { accountId, filter: { emailIds: [...late] } });
        const got = third.call('EmailSubmission/get', {
          accountId,
          '#ids': all.ref('/ids'),
          properties: [...PRIOR, 'deliveryStatus', 'sendAt'],
        });
        // If the follow-up query fails, the status is unknown: the email stays scheduled (`lateVerdict`).
        const list = await third.send().then(
          (r) => r.get(got).list,
          () => [],
        );
        for (const id of late)
          out.late.set(
            id,
            list.filter((s) => s.emailId === id),
          );
      }
      return out;
    },

    async update(account, patches) {
      const client = await clientOf(account);
      await update(client, await client.accountId(), patches);
    },
  };
}

/** Outcome of an email that was no longer waiting. */
export type LateVerdict = 'sent' | 'draft' | 'canceled' | 'pending';

/**
 * Outcome according to the submissions of an email that was no longer waiting:
 * sent (`sent`), no recipient accepted (`draft`, as when sending),
 * cancelled elsewhere (`canceled`, the action's goal counts) or still
 * scheduled (`pending`, the action counts as failed): rescheduled in the meantime,
 * or without a submission or after a failed follow-up query – just as the
 * sync leaves a young email without a submission alone.
 */
export function lateVerdict(subs: readonly LateSubmission[]): LateVerdict {
  if (!subs.length || subs.some((s) => s.undoStatus === 'pending')) return 'pending';
  const final = subs.filter((s) => s.undoStatus === 'final');
  if (final.length) return final.every((s) => noneAccepted(s.deliveryStatus)) ? 'draft' : 'sent';
  return 'canceled';
}

/** Result of the cancellation in one account. */
export interface PlanOutcome {
  /** The changes that apply afterwards (`edits`). */
  kept: Edits;
  /** Goal reached (cancelled, cancelled elsewhere or back without an accepted recipient). */
  done: Id[];
  /** Already sent. */
  late: Id[];
  /** Failed; stays scheduled. */
  failed: Id[];
  /** Previous submission per email (for "send now"). */
  prior: Map<Id, PriorSubmission>;
}

/** Nothing cancelled (all failed); the changes are dropped. */
export class PlanError extends Error {
  constructor() {
    super('Sending not cancelled');
  }
}

/** Toast text when sending could no longer be cancelled for some or all messages. */
export function lateText(late: number, done: number): string {
  if (!done) return late === 1 ? m.compose_already_sent() : m.plan_late_n({ n: late });
  if (done === 1) return late === 1 ? m.plan_late_mix_one_one() : m.plan_late_mix_one_n({ n: late });
  return late === 1 ? m.plan_late_mix_k_one({ k: done }) : m.plan_late_mix_k_n({ k: done, n: late });
}

/** Part of an action: the affected emails of one account and its mailboxes. */
export interface PlanPart {
  account: string;
  emails: readonly ActionEmail[];
  roles: ActionRoles;
}

export class PlanActions {
  readonly #api: PlanApi;

  constructor(api: PlanApi = jmapPlanApi((account) => accounts.client(account))) {
    this.#api = api;
  }

  /**
   * "Cancel sending" (row, selection bar, reading view): immediately
   * at the server, without undo, to Drafts. Returns the
   * cancelled emails so the reading view opens compose with them;
   * `null` if there was nothing to cancel (the page reports it). `onStart`
   * runs as soon as it starts (after the checks, in the reading view).
   */
  async cancel(parts: readonly PlanPart[], onStart?: () => void): Promise<{ account: string; id: Id }[] | null> {
    const live = parts.map((p) => ({ ...p, edits: cancelEdits(p.emails, p.roles) })).filter((p) => p.edits.size);
    if (!live.length) return null;
    if (refusedBy(live.map((p) => p.account))) return [];
    onStart?.();
    const results = await Promise.allSettled(
      live.map((p) => edits.hold(p.account, p.edits, () => this.#commit(p.account, p.edits, p.roles, false))),
    );
    const outcomes = results.flatMap((r, i) =>
      r.status === 'fulfilled' ? [{ ...r.value, account: live[i]!.account }] : [],
    );
    const done = outcomes.flatMap((o) => o.done.map((id) => ({ account: o.account, id })));
    const late = outcomes.reduce((n, o) => n + o.late.length, 0);
    const error = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason as unknown;
    const failed = error !== undefined || outcomes.some((o) => o.failed.length);
    if (late) ui.toasts.error(lateText(late, done.length));
    else if (failed) ui.toasts.error(failText(error, m.plan_cancel_failed()));
    else ui.toasts.show(done.length === 1 ? m.plan_cancelled() : m.plan_cancelled_n({ n: done.length }));
    return done;
  }

  /**
   * Delete in "Scheduled": part for
   * `edits.runAll()` with undo, which only cancels the sending on execution
   * and moves the email with `$draft` to the trash. Too late:
   * "Sent" and error toast; if it fails, it returns to "Scheduled".
   * `null` without a scheduled email.
   */
  trashPart(p: PlanPart, isTag: (box: Id) => boolean): EditPart | null {
    const changes = scheduledTrashEdits(p.emails, p.roles, isTag);
    if (!changes.size) return null;
    return {
      account: p.account,
      edits: changes,
      send: async (keepalive) => {
        const o = await this.#commit(p.account, changes, p.roles, keepalive);
        if (o.late.length) ui.toasts.error(lateText(o.late.length, o.done.length));
        else if (o.failed.length) ui.toasts.error(m.plan_cancel_failed());
        return o.kept;
      },
    };
  }

  /**
   * "Send now" (reading view only): first cancel, on success
   * resubmit like "Send" (`compose.resend`). If the
   * cancellation fails, there is no second sending: error toast, the message
   * stays scheduled. Too late: "The message has already been sent.". If
   * only the submission fails, `reopen` opens compose with the draft.
   */
  async sendNow(email: ActionEmail & { account: string }, roles: ActionRoles, reopen: () => void): Promise<void> {
    const { account } = email;
    if (refusedBy([account])) return;
    const toDrafts = cancelEdits([email], roles);
    if (!toDrafts.size) {
      ui.toasts.error(m.error_act());
      return;
    }
    // Until the result, the list shows the message in "Sent".
    const shown = new Map([[email.id, unscheduleEdit('sent', roles)]]);
    try {
      await edits.hold(account, shown, async () => {
        const o = await this.#commit(account, toDrafts, roles, false);
        const prior = o.prior.get(email.id);
        if (o.late.length) {
          ui.toasts.error(m.compose_already_sent());
          return o;
        }
        if (!o.done.includes(email.id)) throw new PlanError();
        if (!prior) {
          // No recipient accepted: back to "Drafts" as after sending.
          reopen();
          ui.toasts.error(m.compose_send_failed());
          return o;
        }
        const sent = await compose.resend(account, email.id, prior, reopen);
        return sent ? { ...o, kept: shown } : o;
      });
    } catch (error) {
      ui.toasts.error(failText(error, m.compose_send_failed()));
    }
  }

  /**
   * Cancels in one account; the emails then change with `changes`.
   * Whatever was no longer waiting is filed as the sync does. Throws if nothing
   * applies (all failed).
   */
  async #commit(account: string, changes: Edits, boxes: PlanBoxes, keepalive: boolean): Promise<PlanOutcome> {
    const patches = Object.fromEntries([...changes].map(([id, e]) => [id, patchOf(e)]));
    const res = await this.#api.cancel(account, patches, keepalive);
    const kept = new Map<Id, EmailEdit>();
    const out: PlanOutcome = { kept, done: [], late: [], failed: [...res.failed], prior: new Map(res.canceled) };
    for (const id of res.canceled.keys()) {
      kept.set(id, changes.get(id)!);
      out.done.push(id);
    }
    const fix: Record<Id, PatchObject> = {};
    for (const [id, subs] of res.late) {
      const verdict = lateVerdict(subs);
      if (verdict === 'pending') {
        out.failed.push(id);
        continue;
      }
      if (verdict === 'canceled') {
        // Cancelled elsewhere: the action's goal counts; "send now" takes the most recently scheduled submission.
        const last = subs.reduce<LateSubmission | undefined>(
          (a, b) => (!a || Date.parse(b.sendAt) > Date.parse(a.sendAt) ? b : a),
          undefined,
        );
        if (last) out.prior.set(id, { identityId: last.identityId, envelope: last.envelope ?? null });
        kept.set(id, changes.get(id)!);
        fix[id] = patches[id]!;
        out.done.push(id);
        continue;
      }
      const edit = unscheduleEdit(verdict === 'sent' ? 'sent' : 'drafts', boxes);
      kept.set(id, edit);
      fix[id] = patchOf(edit);
      (verdict === 'sent' ? out.late : out.done).push(id);
    }
    // If filing fails, the sync catches up.
    if (Object.keys(fix).length) await this.#api.update(account, fix).catch(() => {});
    // Drafts again (also in the trash): compose opens them again, although scheduling had remembered them as sent.
    compose.unsent(account, out.done);
    scheduled.touch(account);
    if (!kept.size) throw new PlanError();
    return out;
  }
}

export const planActions = new PlanActions();
