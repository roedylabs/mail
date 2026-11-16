/**
 * Message actions: which emails an action affects and how they change. A change
 * (`EmailEdit`) puts `edits` over the list and reading view right away and
 * sends it as `Email/set` (`patchOf`).
 *
 * Delete, spam, restore and move affect the emails of the conversation in
 * the view (`inSource`); star, read and tags in the reading view affect the
 * shown ones. Moving replaces all mailboxes except the tags (a tag is a
 * mailbox of its own in each mail account) with the target; this way an email in
 * the trash keeps its tags, and the tag view hides it via `exclude`. A tag
 * is another mailbox (`mailboxIds/<id>`).
 */
import type { Id, PatchObject } from '@roedy/jmap';
import type { ThreadSource } from '#lib/state/threads.svelte.ts';

/** What an action needs from an email. */
export interface ActionEmail {
  id: Id;
  mailboxIds: readonly Id[];
  keywords: Readonly<Record<string, true>>;
  /** Sender address in lower case, for "Restore" of own emails. */
  from?: string | undefined;
}

/** Local change of an email: `true` sets a keyword or mailbox, `false` removes it. */
export interface EmailEdit {
  keywords?: Readonly<Record<string, boolean>>;
  mailboxIds?: Readonly<Record<Id, boolean>>;
  /** Permanently deleted (`Email/set destroy`). */
  destroyed?: true;
}

/** Changes of an action per email. */
export type Edits = ReadonlyMap<Id, EmailEdit>;

/** Mailboxes of an account by role (mailbox id or `null`). */
export type ActionRoles = Record<'inbox' | 'sent' | 'drafts' | 'scheduled' | 'trash' | 'spam', Id | null>;

export const SEEN = '$seen';
export const FLAGGED = '$flagged';
export const DRAFT = '$draft';
export const SCHEDULED = '$scheduled';
/** Spam report for the server's filter (IANA "IMAP and JMAP Keywords", RFC 5788). */
const JUNK = '$junk';
const NOT_JUNK = '$notjunk';
/** Out of spam: not spam for the filter ("Not spam", moving out of spam). */
const NOT_SPAM = { [JUNK]: false, [NOT_JUNK]: true };

/** In one of the mailboxes of the view and in none of the excluded ones (like the list filter). */
export function inSource(mailboxIds: readonly Id[], source: Pick<ThreadSource, 'boxes' | 'exclude'>): boolean {
  return mailboxIds.some((b) => source.boxes.includes(b)) && !mailboxIds.some((b) => source.exclude.includes(b));
}

/** Key in a patch path (JSON Pointer, RFC 6901). */
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Patch for `Email/set update` (RFC 8620, 5.3): `null` removes. */
export function patchOf(edit: EmailEdit): PatchObject {
  const patch: PatchObject = {};
  for (const [k, on] of Object.entries(edit.keywords ?? {})) patch[`keywords/${pointer(k)}`] = on || null;
  for (const [b, on] of Object.entries(edit.mailboxIds ?? {})) patch[`mailboxIds/${pointer(b)}`] = on || null;
  return patch;
}

/** Does the change take the email out of mailboxes and put it into others? */
export function isMove(edit: EmailEdit): boolean {
  const on = Object.values(edit.mailboxIds ?? {});
  return on.includes(true) && on.includes(false);
}

/**
 * Has another device moved the email? It is in none of the mailboxes the
 * change takes it out of, and not at the target either. The patch would
 * then leave it in both folders.
 */
export function movedElsewhere(edit: EmailEdit, boxes: readonly Id[]): boolean {
  return isMove(edit) && !Object.keys(edit.mailboxIds ?? {}).some((b) => boxes.includes(b));
}

/** Keys of two changes combined: the opposite value cancels the earlier one. */
function netKeys(
  first: Readonly<Record<string, boolean>> | undefined,
  then: Readonly<Record<string, boolean>> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...first };
  for (const [key, on] of Object.entries(then ?? {})) {
    if (key in out && out[key] !== on) delete out[key];
    else out[key] = on;
  }
  return out;
}

/**
 * Two changes of the same email as one. Actions name only
 * what changes, so a key with both values is there and back again.
 * `undefined` if nothing remains.
 */
export function netEdit(first: EmailEdit | undefined, then: EmailEdit): EmailEdit | undefined {
  if (!first) return then;
  const keywords = netKeys(first.keywords, then.keywords);
  const mailboxIds = netKeys(first.mailboxIds, then.mailboxIds);
  const hasKeywords = Object.keys(keywords).length > 0;
  const hasBoxes = Object.keys(mailboxIds).length > 0;
  if (!hasKeywords && !hasBoxes) return undefined;
  return { ...(hasKeywords ? { keywords } : {}), ...(hasBoxes ? { mailboxIds } : {}) };
}

/** Two consecutive changes of the same email; the later one wins. */
export function mergeEdit(first: EmailEdit | undefined, then: EmailEdit): EmailEdit {
  if (!first) return then;
  if (first.destroyed || then.destroyed) return { destroyed: true };
  return {
    keywords: { ...first.keywords, ...then.keywords },
    mailboxIds: { ...first.mailboxIds, ...then.mailboxIds },
  };
}

/** Email with the change; `null` if it is deleted. */
export function applyEdit<E extends { mailboxIds: Id[]; keywords: Record<string, true> }>(
  email: E,
  edit: EmailEdit | undefined,
): E | null {
  if (!edit) return email;
  if (edit.destroyed) return null;
  const keywords = { ...email.keywords };
  for (const [k, on] of Object.entries(edit.keywords ?? {})) {
    if (on) keywords[k] = true;
    else delete keywords[k];
  }
  const boxes = new Set(email.mailboxIds);
  for (const [b, on] of Object.entries(edit.mailboxIds ?? {})) {
    if (on) boxes.add(b);
    else boxes.delete(b);
  }
  return { ...email, keywords, mailboxIds: [...boxes] };
}

/** Only the keywords that change. */
function keywordEdit(e: ActionEmail, want: Readonly<Record<string, boolean>>): Record<string, boolean> | null {
  const out = Object.fromEntries(Object.entries(want).filter(([k, on]) => !!e.keywords[k] !== on));
  return Object.keys(out).length ? out : null;
}

function keywordEdits(emails: readonly ActionEmail[], want: Readonly<Record<string, boolean>>): Map<Id, EmailEdit> {
  const out = new Map<Id, EmailEdit>();
  for (const e of emails) {
    const keywords = keywordEdit(e, want);
    if (keywords) out.set(e.id, { keywords });
  }
  return out;
}

/** Read or unread (`$seen`). */
export const seenEdits = (emails: readonly ActionEmail[], seen: boolean) => keywordEdits(emails, { [SEEN]: seen });

/** Flagged or not (`$flagged`). */
export const flagEdits = (emails: readonly ActionEmail[], flagged: boolean) =>
  keywordEdits(emails, { [FLAGGED]: flagged });

/**
 * Move to `to`: all mailboxes except tags (`keep`) go, the target is
 * added, plus the keywords `keywords`. Emails without a target stay.
 */
function moveEdits(
  emails: readonly ActionEmail[],
  to: (e: ActionEmail) => Id | null,
  keep: (box: Id) => boolean,
  keywords: Readonly<Record<string, boolean>> = {},
): Map<Id, EmailEdit> {
  const out = new Map<Id, EmailEdit>();
  for (const e of emails) {
    const target = to(e);
    if (!target) continue;
    const boxes: Record<Id, boolean> = {};
    for (const b of e.mailboxIds) if (b !== target && !keep(b)) boxes[b] = false;
    if (!e.mailboxIds.includes(target)) boxes[target] = true;
    const kw = keywordEdit(e, keywords);
    if (!Object.keys(boxes).length && !kw) continue;
    out.set(e.id, { mailboxIds: boxes, ...(kw ? { keywords: kw } : {}) });
  }
  return out;
}

/**
 * Set or remove a tag (`box`: its mailbox in the account), only on emails
 * that change. If an email is only in the tag's mailbox (e.g. from another
 * program), the tag stays: without a mailbox the server would not accept it
 * (RFC 8621, 4.1.1).
 */
export function tagEdits(emails: readonly ActionEmail[], box: Id, on: boolean): Map<Id, EmailEdit> {
  const out = new Map<Id, EmailEdit>();
  for (const e of emails) {
    const has = e.mailboxIds.includes(box);
    if (has !== on && (on || e.mailboxIds.length > 1)) out.set(e.id, { mailboxIds: { [box]: on } });
  }
  return out;
}

/** Is in "Scheduled". */
export const isScheduled = (e: Pick<ActionEmail, 'mailboxIds'>, roles: Pick<ActionRoles, 'scheduled'>) =>
  !!roles.scheduled && e.mailboxIds.includes(roles.scheduled);

/**
 * Only cancelling the sending moves scheduled emails (delete:
 * `scheduledTrashEdits()`); otherwise they would go out anyway. Move and
 * spam do not exist in "Scheduled".
 */
const unscheduled = (emails: readonly ActionEmail[], roles: ActionRoles) =>
  emails.filter((e) => !isScheduled(e, roles));

/** Mailboxes of a scheduled email and its targets. */
export type PlanBoxes = Pick<ActionRoles, 'scheduled' | 'sent' | 'drafts'>;

/**
 * Scheduled email to "Sent", or as a draft to "Drafts", without
 * `$scheduled` (sync, cancel sending, undo after scheduling).
 * If the target is missing, it stays in "Scheduled" (as a sent email without
 * "Sent" stays in "Drafts").
 */
export function unscheduleEdit(to: 'sent' | 'drafts', boxes: PlanBoxes): EmailEdit {
  const target = boxes[to];
  return {
    ...(target && boxes.scheduled ? { mailboxIds: { [boxes.scheduled]: false, [target]: true } } : {}),
    keywords: { [SCHEDULED]: false, ...(to === 'drafts' ? { [DRAFT]: true } : {}) },
  };
}

/** "Cancel send": the scheduled emails as drafts to "Drafts". */
export function cancelEdits(emails: readonly ActionEmail[], roles: ActionRoles): Map<Id, EmailEdit> {
  return new Map(emails.filter((e) => isScheduled(e, roles)).map((e) => [e.id, unscheduleEdit('drafts', roles)]));
}

/**
 * Delete in "Scheduled": to the trash, with `$draft` instead of `$scheduled`,
 * so that "Restore" leads to drafts; only executing it cancels the sending.
 */
export function scheduledTrashEdits(emails: readonly ActionEmail[], roles: ActionRoles, isTag: (box: Id) => boolean) {
  return moveEdits(
    emails.filter((e) => isScheduled(e, roles)),
    () => roles.trash,
    isTag,
    { [SCHEDULED]: false, [DRAFT]: true },
  );
}

/**
 * "Move" to a folder or the inbox; empty if all are already there.
 * Scheduled ones stay in "Scheduled" (as when deleting); out of spam like
 * "Not spam" with `$notjunk`.
 */
export function folderEdits(emails: readonly ActionEmail[], to: Id, roles: ActionRoles, isTag: (box: Id) => boolean) {
  const movable = unscheduled(emails, roles);
  const inSpam = (e: ActionEmail) => !!roles.spam && e.mailboxIds.includes(roles.spam);
  return new Map([
    ...moveEdits(
      movable.filter((e) => !inSpam(e)),
      () => to,
      isTag,
    ),
    ...moveEdits(movable.filter(inSpam), () => to, isTag, NOT_SPAM),
  ]);
}

/** Delete: to the trash. */
export function trashEdits(emails: readonly ActionEmail[], roles: ActionRoles, isTag: (box: Id) => boolean) {
  return moveEdits(unscheduled(emails, roles), () => roles.trash, isTag);
}

/** "Report spam": to spam, with `$junk` for the filter. */
export function spamEdits(emails: readonly ActionEmail[], roles: ActionRoles, isTag: (box: Id) => boolean) {
  return moveEdits(unscheduled(emails, roles), () => roles.spam, isTag, { [JUNK]: true, [NOT_JUNK]: false });
}

/** "Not spam": to the inbox, with `$notjunk`. */
export function notSpamEdits(emails: readonly ActionEmail[], roles: ActionRoles, isTag: (box: Id) => boolean) {
  return moveEdits(emails, () => roles.inbox, isTag, NOT_SPAM);
}

/**
 * Target of "Restore": drafts (`$draft`, also deleted scheduled ones) to
 * drafts, own emails (sender is
 * the account address) to sent, all others to the inbox. If the mailbox of
 * the role is missing, also to the inbox.
 */
export function restoreTarget(e: ActionEmail, roles: ActionRoles, own: string): Id | null {
  if (e.keywords[DRAFT]) return roles.drafts ?? roles.inbox;
  if (own && e.from === own) return roles.sent ?? roles.inbox;
  return roles.inbox;
}

/** "Restore" from the trash. */
export function restoreEdits(
  emails: readonly ActionEmail[],
  roles: ActionRoles,
  isTag: (box: Id) => boolean,
  own: string,
) {
  return moveEdits(emails, (e) => restoreTarget(e, roles, own.toLowerCase()), isTag);
}

/**
 * "Delete permanently" in the trash: emails that, apart from the trash and
 * tags, are in another mailbox (JMAP allows several, e.g. after a copy in
 * another client) only leave the trash; the server deletes the rest
 * (`Email/set destroy`).
 */
export function purgeEdits(
  emails: readonly ActionEmail[],
  trash: Id | null,
  isTag: (box: Id) => boolean,
): Map<Id, EmailEdit> {
  return new Map(
    emails.map((e): [Id, EmailEdit] => [
      e.id,
      trash && e.mailboxIds.some((b) => b !== trash && !isTag(b))
        ? { mailboxIds: { [trash]: false } }
        : { destroyed: true },
    ]),
  );
}
