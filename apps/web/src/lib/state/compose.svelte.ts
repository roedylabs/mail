/**
 * Compose: state of the compose page with "send as" across the
 * identities of all mail accounts, To/Cc/Bcc as chips, plain text, signature and
 * autosave after 1.5 s as a draft. Sending submits
 * immediately with `HOLDFOR`; "undo" withdraws the submission.
 * Attachments upload right away, into the account of "send
 * as". Replies prefill the fields, suggestions appear below the recipient
 * fields (contacts from `contacts`). Send later submits with `HOLDUNTIL`; the
 * email waits in "Scheduled" with `$scheduled`.
 *
 * An email cannot be changed in JMAP (RFC 8621, 4.6): every
 * save creates the draft anew and deletes the previous one in the same
 * `Email/set`; so the id changes with every save.
 */
import {
  coreCapability,
  mailCapability,
  submissionCapability,
  type BatchResponse,
  type Call,
  type Email,
  type EmailAddress,
  type EmailBodyPart,
  type EmailBodyValue,
  type EmailSubmission,
  type Envelope,
  type Id,
  type Identity,
  type JmapClient,
  type PatchObject,
  type SetError,
  type SetResponse,
} from '@roedy/jmap';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { failText, isOffline, timeZoneOf } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { rejected } from '#lib/mail-blocks.ts';
import { avatarOf, clock, initials, type TimeContext } from '#lib/mail-list.ts';
import { attachmentsText, fileIcon, fileSize, limitText } from '#lib/message-view.ts';
import { m } from '#lib/paraglide/messages.js';
import {
  holdUntil,
  planDuration,
  noneAccepted,
  planEarliest,
  planLimit,
  planPresets,
  planRefusal,
  planWhen,
  type PlanPreset,
} from '#lib/plan.ts';
import { queueKey, type QueuedDraft } from '#lib/mail-queue.ts';
import type { MailStore } from '#lib/mail-store.ts';
import { mailboxPath } from '#lib/routes.ts';
import { accounts, colorOf, defaultAccountOf, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { contacts, type Contact } from '#lib/state/contacts.svelte.ts';
import { LOCAL_DRAFT, unanswered, type EditQueue, type ReplayedDraft } from '#lib/state/edit-queue.svelte.ts';
import { edits } from '#lib/state/edits.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import type { MessageEmail, MessagePart } from '#lib/state/message.svelte.ts';
import { verdictPatch } from '#lib/state/scheduled.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import {
  replyRecipients,
  replySubject,
  splitQuote,
  withQuote,
  type Quote,
  type ReplyContext,
  type ReplyMode,
  type ReplyState,
} from '#lib/reply.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { deviceZone, fromLocalInput, toLocalInput, zoneName } from '#lib/timezone.ts';
import { UNDO_MS } from '#lib/undo.ts';

/**
 * Buffer on top of `gUndo` for `HOLDFOR`: run time until the toast and
 * of the withdrawal, so that "undo" works until the end of the toast.
 */
export const SEND_BUFFER_S = 5;

/** The toast ends this much before the end of `HOLDFOR`, so that the withdrawal still arrives. */
export const CANCEL_MS = 2000;

/** Up to this text size sending uses `keepalive` (browsers limit such requests to 64 KiB). */
const KEEPALIVE_MAX = 48 * 1024;

/** Autosave after the last change. */
export const AUTOSAVE_MS = 1500;

/** Without a connection saving only goes to the device: reloading thus loses hardly anything. */
export const OFFLINE_SAVE_MS = 200;

/** New attempt for a draft not saved on leaving. */
export const RETRY_MS = 30_000;

/** The replay looks through this many newest drafts after an earlier attempt. */
const RECENT_DRAFTS = 50;

export type Field = 'to' | 'cc' | 'bcc';

export interface Recipient {
  /** Empty without a name. */
  name: string;
  email: string;
}

/** Where "back" or close leads and what the button is called (`backLabel`). */
export interface ComposeReturn {
  href: string;
  label: string;
}

/** Navigation after closing or discarding (page, at the time of the action). */
export interface ComposeNav {
  /** Back; `replace` replaces the history entry (after sending the draft no longer exists). */
  leave: (ret: ComposeReturn, replace?: boolean) => void;
  /** "Undo" after discarding: show compose again. */
  reopen: () => void;
}

/** Prefill of a new email (`openCompose(init)`), e.g. from a `mailto:` link. */
export interface ComposeInit {
  /** Account for "send as"; without it that of the view or the default account. */
  account?: string | null;
  to?: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject?: string;
  text?: string;
  /** Reply or forward: title, placeholder, quote and references. */
  mode?: ReplyMode;
  quote?: Quote | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** Attachments of the original when forwarding: blobs in account `account`, without upload. */
  attachments?: EmailBodyPart[];
}

/** What compose does not show (yet) but keeps on saving, e.g. on a draft from another program. */
export interface DraftExtras {
  inReplyTo: string[] | null;
  references: string[] | null;
  /** Keywords (star) and further mailboxes (tags) of the opened draft. */
  keywords: Record<string, true>;
  mailboxIds: Id[];
  /** Account that `mailboxIds` belong to; in another account they do not apply. */
  origin: string | null;
}

/** Draft at the server. */
export interface SavedDraft {
  account: string;
  id: Id;
}

/** What `ComposeApi.save()` creates. */
export interface DraftEmail extends Omit<DraftExtras, 'origin'> {
  /** Uploaded attachments in the draft's account. */
  attachments: EmailBodyPart[];
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** Plain text including signature. */
  text: string;
  /** Only when saving: by this the replay recognises an attempt whose response did not come. */
  messageId?: string;
}

/** Draft from the server. */
export interface LoadedDraft extends Omit<DraftExtras, 'origin'> {
  attachments: EmailBodyPart[];
  from: EmailAddress | null;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  text: string;
  receivedAt: number;
}

/** Draft from the message storage (`storedDraft`); `null` if it is missing there. */
export type StoredDraft = (account: string, id: Id) => Promise<LoadedDraft | null>;

/**
 * Draft from the message storage: only with the
 * whole text and a known Bcc, so that the next save loses nothing. It keeps attachments via their blobs.
 */
export async function storedDraft(
  store: Pick<MailStore, 'heads' | 'thread' | 'useThread'> | null,
  account: string,
  id: Id,
): Promise<LoadedDraft | null> {
  if (!store) return null;
  // After a merge an outdated head may still name the email: ask all matches.
  for (const head of (await store.heads(account)).filter((h) => h.mails.some((e) => e.id === id))) {
    const e = (await store.thread(head.key))?.emails.find((x) => x.id === id);
    // Another head may hold the same email completely.
    if (!e || !complete(e)) continue;
    // Opened as in the reading view: the conversation stays in storage longer.
    store.useThread(head.key);
    return fromStored(e);
  }
  return null;
}

/**
 * Whole text (every text part with an untruncated, cleanly decoded value) and
 * known Bcc. A value with `isEncodingProblem` (RFC 8621, 4.1.4) carries
 * replacement characters; the next save would make them the draft's text.
 */
function complete(e: MessageEmail): e is MessageEmail & { bcc: EmailAddress[] } {
  const whole = (p: MessagePart) => {
    const value = p.partId ? e.bodyValues[p.partId] : undefined;
    return !!value && !value.isTruncated && !value.isEncodingProblem;
  };
  return !!e.bcc && !e.miss && e.textBody.filter((p) => p.type.startsWith('text/')).every(whole);
}

function fromStored(e: MessageEmail & { bcc: EmailAddress[] }): LoadedDraft {
  return {
    from: e.from[0] ?? null,
    to: toRecipients(e.to),
    cc: toRecipients(e.cc),
    bcc: toRecipients(e.bcc),
    subject: e.subject,
    text: draftText(e.textBody, e.bodyValues),
    receivedAt: e.receivedAt,
    // `MessagePart` carries all fields that `emailObject` needs.
    attachments: e.attachments as EmailBodyPart[],
    inReplyTo: e.inReplyTo.length ? e.inReplyTo : null,
    references: e.references.length ? e.references : null,
    keywords: draftKeywords(e.keywords),
    mailboxIds: e.mailboxIds,
  };
}

/** Text of a draft from `textBody`: images in the body (RFC 8621, 4.1.4) without text, HTML as plain text. */
function draftText(
  parts: readonly Pick<EmailBodyPart, 'partId' | 'type'>[],
  values: Record<string, EmailBodyValue>,
): string {
  return parts
    .filter((p) => p.type.startsWith('text/'))
    .map((p) => {
      const value = (p.partId && values[p.partId]?.value) || '';
      return p.type === 'text/html' ? htmlToText(value) : value.replace(/\r\n/g, '\n');
    })
    .join('\n\n');
}

/** Keywords that every save takes over; it sets `$draft` and `$seen` itself. */
function draftKeywords(keywords: Record<string, boolean> | undefined): Record<string, true> {
  return Object.fromEntries(
    Object.keys(keywords ?? {})
      .filter((k) => k !== '$draft' && k !== '$seen')
      .map((k) => [k, true as const]),
  );
}

/** Attachment in compose. */
export interface Attachment {
  /** Key of the tile. */
  key: string;
  name: string;
  type: string;
  size: number;
  /** Blob at the server with its account (blobs apply only there); `null` until the first upload. */
  blob: { account: string; part: EmailBodyPart } | null;
  /** Content: the file from the device or downloaded for the move to another account. */
  file: Blob | null;
  /**
   * Upload into this account failed; the tile
   * stays with "Try again". Applies only as long as "send as" is this account.
   */
  failed?: { account: string; offline: boolean } | null;
}

/** Limits for attachments from the session of an account. */
export interface AttachmentLimits {
  /** Per file (`maxSizeUpload`, RFC 8620, 2). */
  file: number;
  /** Sum of the attachments of an email (`maxSizeAttachmentsPerEmail`, RFC 8621, 1.3.1). */
  email: number;
}

/** Result of an upload (RFC 8620, 6.1). */
export interface UploadedBlob {
  blobId: Id;
  size: number;
}

/** Running upload of an attachment into an account. */
interface Upload {
  account: string;
  ctrl: AbortController;
  /** Fulfilled as soon as it is done, failed or aborted. */
  done: Promise<void>;
}

/** Submission (RFC 8621, 7) of a draft. */
export interface Submission {
  identity: Id;
  /** Envelope: address of the identity and all recipients. */
  mailFrom: string;
  rcptTo: string[];
  /** Seconds until sending (`HOLDFOR`, RFC 4865); `null` immediately. */
  holdFor: number | null;
  /** Scheduled sending (`HOLDUNTIL`, RFC 4865) in ms; the email then waits in "Scheduled". */
  holdUntil?: number | null;
  /** `null`: without an envelope; the server builds it from the headers ("send now" of a foreign submission). */
  envelope?: null;
}

/** Response to the submission; the email is saved (`email`). */
export type SendResult =
  | {
      ok: true;
      email: Id;
      submission: Id;
      /** No recipient accepted: nothing sent, the email lies in "Sent" anyway. */
      rejected: boolean;
    }
  | { ok: false; email: Id; error: SetError };

/** Calls to the mail server; the tests replace them. */
export interface ComposeApi {
  identities(account: string): Promise<Identity[]>;
  /** `null` if the draft does not exist (any more). */
  load(account: string, id: Id): Promise<LoadedDraft | null>;
  /**
   * Creates the draft and then deletes `replace` in a separate `Email/set`;
   * returns the new id. Throws if creating fails.
   */
  save(account: string, email: DraftEmail, replace: Id | null, keepalive: boolean): Promise<Id>;
  /**
   * Replay of an offline version: replaces `replace` and an earlier
   * attempt with the same `messageId`. If `replace` no longer exists, a
   * new draft arises next to the server's version (`conflict`).
   */
  saveQueued(account: string, email: DraftEmail, replace: Id | null): Promise<ReplayedDraft>;
  destroy(account: string, id: Id, keepalive: boolean): Promise<void>;
  /**
   * Saves the draft and submits it in the same request; `replace` goes
   * afterwards as with `save()`; on success it lies without `$draft` in "Sent", with `holdUntil` in
   * "Scheduled" with `$scheduled`. Throws if saving fails.
   */
  send(
    account: string,
    email: DraftEmail,
    replace: Id | null,
    sub: Submission,
    keepalive: boolean,
  ): Promise<SendResult>;
  /** Submits a saved draft (second attempt without `HOLDFOR`). */
  submit(account: string, email: Id, sub: Submission, keepalive: boolean): Promise<SendResult>;
  /**
   * "Undo": withdraw the submission (`undoStatus: canceled`), email back to Drafts
   * (from "Sent", or with `planned` from "Scheduled"); `false` if only moving it back
   * failed (it is withdrawn anyway then).
   */
  unsend(account: string, submission: Id, email: Id, planned?: boolean): Promise<boolean>;
  /** Sent or scheduled email back to Drafts (no recipient accepted). */
  restore(account: string, email: Id, planned?: boolean): Promise<void>;
  /** `maxDelayedSend` of the account in seconds (RFC 8621, 1.3.2); `null` without a value. */
  maxDelay(account: string): Promise<number | null>;
  /** Limits of the account for attachments; without a value for the sum `Infinity`. */
  limits(account: string): Promise<AttachmentLimits>;
  upload(account: string, data: Blob, type: string, signal: AbortSignal): Promise<UploadedBlob>;
  /** Content of an attachment, to upload it into another account. */
  download(account: string, part: EmailBodyPart, signal: AbortSignal): Promise<Blob>;
}

/** The server rejected saving or deleting a draft. */
export class ComposeError extends Error {
  readonly errors: SetError[];
  constructor(what: string, errors: SetError[] = []) {
    super(`${what}: ${errors.map((e) => e.type).join(', ') || 'rejected'}`);
    this.name = 'ComposeError';
    this.errors = errors;
  }
}

/** One open compose across all saves (not reactive). */
export class ComposeSession {
  /** Last saved draft; deleting after discarding always takes this one. */
  saved: SavedDraft | null = null;
  /** Key of the version in the queue; afterwards all versions queue up there. */
  parked: string | null = null;
  /** `Message-ID` until a response came: if the draft has it at the server, it came from an attempt of this session. */
  mid: string | null = null;
  /** Saves one after another, so that each replaces the previous draft. */
  chain: Promise<void> = Promise.resolve();
  /** Counts changes; if something changes during saving, `dirty` stays. */
  rev = 0;
  /** A rejected autosave was reported; only again after the next successful save. */
  failNoted = false;
  /** Last state, also after compose was left. */
  latest!: Draft;
  /** Timer of the next attempt while the session is orphaned. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** Running uploads per attachment (`Attachment.key`). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, `Draft.atts` is displayed
  readonly uploads = new Map<string, Upload>();
  /**
   * Earlier drafts in other accounts whose blob a failed move
   * without content still needs for "Try again"; deleted as soon as
   * no attachment needs it any more.
   */
  stale: SavedDraft[] = [];
  /**
   * Accounts whose draft stays: closing or leaving left a failed attachment
   * without content there, of which it is the only copy.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  readonly kept = new Set<string>();
}

/** State of compose. */
export interface Draft {
  readonly session: ComposeSession;
  account: string;
  /** Identity for "send as"; `null` = the account's first one or its address. */
  identity: Id | null;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  /** Inputs not yet turned into chips (`inp`). */
  input: Record<Field, string>;
  showCc: boolean;
  subject: string;
  text: string;
  /** Signature removed (`sigOff`). */
  sigOff: boolean;
  /** Attachments (`at`); uploading as long as their blob does not lie in the account of "send as". */
  atts: Attachment[];
  extras: DraftExtras;
  saved: SavedDraft | null;
  /** Key of the version waiting in the queue (`ComposeSession.parked`). */
  parked: string | null;
  savedAt: number | null;
  dirty: boolean;
  /** Last save failed; the next one tries again after the next change. */
  failed: boolean;
  /** Opened from a saved draft (title "Draft"). */
  fromDraft: boolean;
  /** Reply or forward (`mode`): title and placeholder; `null` for a new email. */
  mode: ReplyMode | null;
  /** Quote below text and signature (`quote`), saved at the end of the text. */
  quote: Quote | null;
  /** Quote expanded (`quoteOpen`). */
  quoteOpen: boolean;
  menu: 'from' | 'later' | null;
  /** Field "date and time" in the "send later" popover (`later`, `datetime-local` in `tz`). */
  later: string;
  /** Time rejected by the server; until the next input "Schedule" stays disabled. */
  laterErr: string | null;
  focus: Field | null;
  /** Chosen suggestion in the focused field. */
  sug: number;
  /** Notice at the "To" field (`err: 'to'`, set by the checks on sending). */
  err: 'to' | null;
  ret: ComposeReturn | null;
}

/** Row in "send as" (`from.opts`). */
export interface FromOption {
  key: string;
  name: string;
  email: string;
  letter: string;
  bg: string;
  ink: string;
  on: boolean;
}

/** "Send as" (`cm.from`). */
export interface FromValues extends Omit<FromOption, 'key' | 'on'> {
  open: boolean;
  /** More than one identity: button with a selection; otherwise only the row. */
  multi: boolean;
  /** Account with "sign-in required". */
  stale: boolean;
  opts: FromOption[];
}

/** Preset in the "send later" popover (`later.opts`). */
export interface LaterOption {
  key: PlanPreset;
  label: string;
  icon: IconName;
  /** "Tomorrow, 08:00"; beyond the limit "More than 7 days ahead". */
  sub: string;
  /** Beyond the limit: visible but disabled (`aria-disabled`, dimmed). */
  dis: boolean;
}

/** "Send later" popover. */
export interface LaterValues {
  open: boolean;
  /** No scheduled sending (`maxDelayedSend` 0 or FUTURERELEASE switched off): button disabled. */
  dis: boolean;
  /** Tooltip at the disabled button, otherwise empty; on mobile the same sentence as a toast on tap. */
  tip: string;
  opts: LaterOption[];
  val: string;
  /** Earliest or latest time for the field (`datetime-local` in `tz`). */
  min: string;
  max: string;
  /** Red notice below the field (`role="alert"`); replaces the row with the limit. */
  hasHint: boolean;
  hintText: string;
  invalid: boolean;
  showLimit: boolean;
  /** "Up to 7 days ahead". */
  limitText: string;
  /** Time zone from language & region differs from the device's: "Time zone: ‹name›". */
  tzShow: boolean;
  tzText: string;
  /** "Schedule" disabled. */
  btnDis: boolean;
}

/** Chip of a recipient (`fields[].chips`). */
export interface ChipValues {
  key: string;
  label: string;
  /** "Name <address>" or the address. */
  title: string;
  /** Initials, `!` for an invalid address. */
  letter: string;
  avBg: string;
  avInk: string;
  /** Invalid address: shown in red. */
  bad: boolean;
  rmLabel: string;
}

/** Field To, Cc or Bcc (`cm.fields`). */
export interface FieldValues {
  key: Field;
  label: string;
  val: string;
  /** Focus on opening (To without recipients). */
  auto: boolean;
  ph: string;
  /** Notice "Add a recipient" (label in `--danger`). */
  err: boolean;
  /** "Cc/Bcc" button at the To field. */
  showToggle: boolean;
  chips: ChipValues[];
  /** "Suggestions" list below the field: only in the focused field and with input. */
  hasSug: boolean;
  sug: SuggestionValues[];
}

/** Suggestion below a field. */
export interface SuggestionValues {
  /** Address in lower case. */
  key: string;
  /** Name, without a name the address (`n`). */
  name: string;
  /** Address below the name (`em`); empty if `name` already is the address (`hasEm`). */
  email: string;
  letter: string;
  avBg: string;
  avInk: string;
  /** Chosen with ↑/↓, Enter and Tab take it over (`on`, fill `bg`). */
  on: boolean;
}

/** Tile of an attachment (`cm.atts`). */
export interface AttachmentValues {
  key: string;
  name: string;
  /** `ti-cloud-upload` while uploading, `ti-alert-circle` after an error, otherwise by extension or type. */
  icon: IconName;
  /** Size, "Uploading …" or "Upload failed" or "No connection". */
  sub: string;
  /** Uploading: the tile is dimmed. */
  up: boolean;
  /** Upload failed: icon and subline in `--danger` (`ic`, `subC`), button "Try again". */
  failed: boolean;
  retryLabel: string;
  rmLabel: string;
}

/** Values of the page (without quote and "send later"). */
export interface ComposeValues {
  title: string;
  backLabel: string;
  discardLabel: string;
  status: string;
  /** On mobile, shorter offline. */
  statusM: string;
  hasStatus: boolean;
  statusIcon: IconName;
  /** Without a connection: "Send" disabled (`sendTip`). */
  sendOff: boolean;
  from: FromValues;
  later: LaterValues;
  fields: FieldValues[];
  anyMenu: boolean;
  subj: string;
  text: string;
  /** Focus on opening in the text if "To" already has recipients. */
  taAuto: boolean;
  ph: string;
  sig: string;
  sigShow: boolean;
  sigAdd: boolean;
  atts: AttachmentValues[];
  hasAtts: boolean;
  /** "1 attachment", "3 attachments". */
  attTitle: string;
  hasQuote: boolean;
  quoteHead: string;
  quoteParas: { t: string }[];
  quoteOpen: boolean;
  quoteExp: 'true' | 'false';
  quoteChevT: 'rotate(180deg)' | 'none';
}

/** Popover closed: only the button and the field value count. */
const LATER_CLOSED: LaterValues = {
  open: false,
  dis: false,
  tip: '',
  opts: [],
  val: '',
  min: '',
  max: '',
  hasHint: false,
  hintText: '',
  invalid: false,
  showLimit: true,
  limitText: '',
  tzShow: false,
  tzText: '',
  btnDis: true,
};

/** Time reference of `values()`: time zone and time format from language & region; `now` and `device` for tests. */
export interface ComposeTime extends Pick<TimeContext, 'tz' | 'timeFmt'> {
  now?: number;
  /** Time zone of the device; without a value from the browser. */
  device?: string;
}

/** Actions of the page (handlers of `cm`); the route binds them to `compose` and the navigation. */
export interface ComposeActions {
  close: () => void;
  discard: () => void;
  /** Send (button, Ctrl/⌘ + Enter). */
  send: () => void;
  /** Attaches chosen or dropped files (`onFiles`, `onDrop`). */
  addFiles: (files: readonly File[]) => void;
  /** Removes an attachment (`atts[].remove`); a running upload aborts. */
  removeAttachment: (key: string) => void;
  /** Retries a failed upload. */
  retryAttachment: (key: string) => void;
  /** "Send later" button (`later.toggle`): popover open and closed; when disabled, on mobile the notice as a toast. */
  later: () => void;
  /** Schedules a preset (`later.opts[].onClick`). */
  pickLater: (key: PlanPreset) => void;
  /** Field "date and time" (`later.onVal`). */
  setLater: (value: string) => void;
  /** "Schedule" with the field (`later.plan`). */
  plan: () => void;
  toggleFrom: () => void;
  closeMenu: () => void;
  pickFrom: (key: string) => void;
  input: (field: Field, value: string) => void;
  commit: (field: Field) => void;
  remove: (field: Field, index: number) => void;
  removeLast: (field: Field) => void;
  /** ↑/↓ in the "Suggestions" list, at the end back to the front. */
  moveSuggestion: (field: Field, step: 1 | -1) => void;
  /** Takes a suggestion over as a chip (`onPick`; without an index the chosen one, for Enter and Tab). */
  pickSuggestion: (field: Field, index?: number) => void;
  focus: (field: Field) => void;
  blur: (field: Field) => void;
  showCc: () => void;
  setSubject: (value: string) => void;
  setText: (value: string) => void;
  toggleSig: () => void;
  /** Expands or collapses the quote. */
  toggleQuote: () => void;
}

/** Choice in "send as". */
interface Choice {
  account: MailAccount;
  identity: Id | null;
  name: string;
  email: string;
  sig: string;
}

const FIELD_KEYS: readonly Field[] = ['to', 'cc', 'bcc'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Splits off the signature (RFC 3676, 4.3: "-- " on its own line). */
const SIG_SEP = '\n\n-- \n';

const keyOf = (account: string, identity: Id | null) => `${account}/${identity ?? ''}`;
let attSeq = 0;
const attKey = () => `a${++attSeq}`;

/** Counter in the key of a version (`queueKey()`). */
let parkSeq = 0;
/** The attachment lies in the account of "send as" and belongs to the saved draft. */
const ready = (d: Draft, a: Attachment) => a.blob?.account === d.account;
/** The upload into the account of "send as" failed. */
const uploadFailed = (d: Draft, a: Attachment) => !ready(d, a) && a.failed?.account === d.account;
/** If the attachment does not lie in the account of "send as" (yet) and has not failed, it is uploading. */
const uploading = (d: Draft, a: Attachment) => !ready(d, a) && !uploadFailed(d, a);
/** Without content on the device: the only copy is the blob in another account (move). */
const onlyCopy = (a: Attachment): a is Attachment & { blob: NonNullable<Attachment['blob']> } => !a.file && !!a.blob;
/** Does a failed attachment still need the draft in this account for "Try again"? */
const needsDraftIn = (d: Draft, account: string) =>
  d.atts.some((a) => uploadFailed(d, a) && onlyCopy(a) && a.blob.account === account);
/** Sum of the attachments like `maxSizeAttachmentsPerEmail` (unencoded, all tiles). */
const attsSize = (atts: readonly Attachment[]) => atts.reduce((t, a) => t + a.size, 0);
/** Without a session: no limit, the upload reports the error itself. */
const NO_LIMITS: AttachmentLimits = { file: Infinity, email: Infinity };
/** Error toasts of failed background uploads within this time count together. */
const FAIL_BG_MS = 5000;
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Letters in the avatar: initials, without a name the first character of the address. */
const letterOf = (name: string, email: string) => initials(name) || (email.charAt(0) || '?').toUpperCase();

/** Recipients from an input ("Name <address>", separated by comma, semicolon or line break). */
/**
 * Splits at comma, semicolon and line break, but not inside quotes
 * or angle brackets (`"Doe, Jane" <jane@…>`); the last part may be open.
 */
export function splitRecipients(value: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let angled = false;
  let at = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angled = true;
    else if (!quoted && c === '>') angled = false;
    else if (!quoted && !angled && (c === ',' || c === ';' || c === '\n')) {
      parts.push(value.slice(at, i));
      at = i + 1;
    }
  }
  parts.push(value.slice(at));
  return parts;
}

export function parseRecipients(value: string): Recipient[] {
  return splitRecipients(value)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const named = /^"?(.*?)"?\s*<([^>]+)>$/.exec(x);
      return { name: named?.[1]?.trim() ?? '', email: (named?.[2] ?? x).trim() };
    });
}

/**
 * Appends `add` to `list` without taking in addresses twice; an address
 * without a name gets that of a known contact.
 */
function merge(list: readonly Recipient[], add: readonly Recipient[]): Recipient[] {
  const out = [...list];
  for (const r of add)
    if (!out.some((x) => sameEmail(x.email, r.email)))
      out.push(r.name ? r : { ...r, name: contacts.find(r.email)?.name ?? '' });
  return out;
}

/** Title of compose, also for the page title. */
export function composeTitle(d: Pick<Draft, 'fromDraft' | 'mode'>): string {
  if (d.fromDraft) return m.compose_title_draft();
  if (d.mode === 'reply') return m.compose_title_reply();
  if (d.mode === 'all') return m.compose_title_all();
  if (d.mode === 'fwd') return m.compose_title_fwd();
  return m.compose_title_new();
}

/** Content present; the signature alone does not count. */
export function hasContent(d: Draft): boolean {
  return (
    d.to.length + d.cc.length + d.bcc.length > 0 ||
    Object.values(d.input).some((v) => v.trim()) ||
    !!d.subject.trim() ||
    !!d.text.trim() ||
    // Attachments still uploading are only saved by the end of their upload, failed ones never.
    d.atts.some((a) => ready(d, a))
  );
}

/** Save or keep on leaving. */
const keepOf = (d: Draft) => hasContent(d) && (d.dirty || !!d.saved || !!d.parked);

/** Inputs taken over as recipients. */
function flushed(d: Draft): Record<Field, Recipient[]> {
  const out = { to: d.to, cc: d.cc, bcc: d.bcc };
  for (const k of FIELD_KEYS) out[k] = merge(d[k], parseRecipients(d.input[k]));
  return out;
}

/** Text of the draft: plain text, plus the signature after "-- ". */
export function bodyOf(text: string, sig: string): string {
  const body = text.trimEnd();
  return sig ? `${body}${SIG_SEP}${sig}` : body;
}

/** Counterpart to `bodyOf()`: text without the signature and whether it was there. */
export function splitSignature(body: string, sig: string): { text: string; signed: boolean } {
  const trimmed = body.trimEnd();
  if (sig) {
    for (const sep of [SIG_SEP, '\n\n--\n', '\n-- \n', '\n--\n']) {
      const tail = `${sep}${sig}`;
      if (trimmed.endsWith(tail)) return { text: trimmed.slice(0, -tail.length), signed: true };
    }
    if (trimmed === `-- \n${sig}` || trimmed === `--\n${sig}`) return { text: '', signed: true };
  }
  return { text: trimmed, signed: false };
}

/** Route parameter `[draft]`: `new` or `<account>/<id>` (like threads in "all accounts"). */
export const NEW_DRAFT = 'new';

export function draftRef(saved: SavedDraft | null): string {
  return saved ? `${saved.account}/${saved.id}` : NEW_DRAFT;
}

/** Counterpart to `draftRef()`; `null` for `new`, `undefined` for unknown ones. */
export function parseDraftRef(ref: string): SavedDraft | null | undefined {
  if (ref === NEW_DRAFT) return null;
  const at = ref.indexOf('/');
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { account: ref.slice(0, at), id: ref.slice(at + 1) };
}

/**
 * Compose from the reply bar: recipients according to the
 * kind of reply, "Re:" or "Fwd:", the text of the bar, quote and references,
 * when forwarding the address of the bar and the attachments of the original.
 */
export function replyInit(
  ctx: ReplyContext,
  state: Pick<ReplyState, 'mode' | 'text' | 'to'>,
  account: string,
): ComposeInit {
  const fwd = state.mode === 'fwd';
  const r = state.mode === 'fwd' ? null : replyRecipients(ctx, state.mode);
  return {
    account,
    mode: state.mode,
    to: r ? toRecipients(r.to) : parseRecipients(state.to),
    cc: r ? toRecipients(r.cc) : [],
    subject: replySubject(ctx.base, state.mode),
    text: state.text,
    quote: ctx.quote,
    inReplyTo: fwd ? null : ctx.inReplyTo,
    references: fwd ? null : ctx.references,
    // Parts as from `Email/get` of the reading view; only blob, type, name, charset, disposition and `cid` are saved.
    attachments: fwd
      ? ctx.attachments.flatMap((p) =>
          p.blobId ? [{ ...p, headers: [], language: null, location: null, subParts: null }] : [],
        )
      : [],
  };
}

/** Prefill from a `mailto:` link (RFC 6068); `null` if it is none. */
export function parseMailto(href: string): ComposeInit | null {
  if (!/^mailto:/i.test(href)) return null;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const rest = href.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const to = parseRecipients(dec(q < 0 ? rest : rest.slice(0, q)));
  const init: Required<Pick<ComposeInit, 'to' | 'cc' | 'bcc' | 'subject' | 'text'>> = {
    to,
    cc: [],
    bcc: [],
    subject: '',
    text: '',
  };
  for (const pair of q < 0 ? [] : rest.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    const key = dec(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = dec(eq < 0 ? '' : pair.slice(eq + 1));
    if (key === 'to' || key === 'cc' || key === 'bcc') init[key] = merge(init[key], parseRecipients(value));
    else if (key === 'subject') init.subject = value;
    else if (key === 'body') init.text = value.replace(/\r\n/g, '\n');
  }
  return init;
}

/** Identities of an account: those with its address first, otherwise in the server's order (also Mail account › Identities). */
export function sortIdentities(list: readonly Identity[], email: string): Identity[] {
  return [...list].sort((a, b) => Number(sameEmail(b.email, email)) - Number(sameEmail(a.email, email)));
}

function blank(account: string, init: ComposeInit, ret: ComposeReturn | null): Draft {
  const session = new ComposeSession();
  const cc = init.cc ?? [];
  const bcc = init.bcc ?? [];
  const draft: Draft = {
    session,
    account,
    identity: null,
    to: init.to ?? [],
    cc,
    bcc,
    input: { to: '', cc: '', bcc: '' },
    showCc: cc.length + bcc.length > 0,
    subject: init.subject ?? '',
    text: init.text ?? '',
    sigOff: false,
    // When forwarding the attachments of the original: their blobs lie in the message's account.
    atts: (init.attachments ?? []).map((part) => ({
      key: attKey(),
      name: part.name ?? '',
      type: part.type,
      size: part.size,
      blob: { account: init.account ?? account, part },
      file: null,
    })),
    extras: {
      inReplyTo: init.inReplyTo ?? null,
      references: init.references ?? null,
      keywords: {},
      mailboxIds: [],
      origin: null,
    },
    saved: null,
    parked: null,
    savedAt: null,
    // A prefill (mailto:) counts as a change; `start()` sets that.
    dirty: false,
    failed: false,
    fromDraft: false,
    mode: init.mode ?? null,
    quote: init.quote ?? null,
    quoteOpen: false,
    menu: null,
    later: '',
    laterErr: null,
    focus: null,
    sug: 0,
    err: null,
    ret,
  };
  session.latest = draft;
  return draft;
}

type IdentityState = Identity[] | 'loading' | 'error';

export class Compose {
  /** Open compose; `null` while none is open. */
  current = $state.raw<Draft | null>(null);
  #ids = $state.raw<Record<string, IdentityState>>({});
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- running fetches, not displayed
  #loads = new Map<string, Promise<Identity[]>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Changes with every opening; a slow load does not overwrite a newer compose. */
  #token = 0;
  /**
   * Running close: session and whether it still waits for uploads. While
   * it waits, `park()` aborts it and saves itself; afterwards
   * the close saves.
   */
  #closing: { s: ComposeSession; waiting: boolean } | null = null;
  /** Counts `reset()`; identities of an earlier sign-out expire. */
  #gen = 0;
  /** Running saves of all sessions (`openDraft` waits for them). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #pending = new Set<Promise<void>>();
  /** Replaced drafts (`<account>/<id>` → new state), so that back in the history opens the current one. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #moved = new Map<string, SavedDraft>();
  /** Sessions not saved on leaving; they try again (`RETRY_MS`). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #orphans = new Set<ComposeSession>();
  /** Sent or currently sending drafts (`<account>/<id>`); their address opens nothing any more. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #sent = new Set<string>();
  /** Sessions with running uploads, also after leaving compose. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #busy = new Set<ComposeSession>();
  /** Last read limits for attachments per account; sending checks the sum without waiting. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #limits = new Map<string, AttachmentLimits>();
  /** Running queries of the limits per account. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #limitLoads = new Map<string, Promise<AttachmentLimits>>();
  /** `maxDelayedSend` per account from its session; without an entry the default applies. */
  #delays = new SvelteMap<string, number | null>();
  /** Running queries of `maxDelayedSend` per account. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #delayLoads = new Map<string, Promise<void>>();
  /** Last failed query of `maxDelayedSend` per account (time). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #delayFailed = new Map<string, number>();
  /** Accounts whose server has switched off FUTURERELEASE: "send later" disabled until reload. */
  #noPlan = new SvelteSet<string>();
  /** Last error toast of a background upload and how many it counts. */
  #failBg = { at: -Infinity, count: 0 };
  /** Sessions with a version in the queue: the replay reports the new id to them. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  #parked = new Map<string, ComposeSession>();
  readonly #api: ComposeApi;
  readonly #outbox: EditQueue;
  readonly #stored: StoredDraft;

  constructor(
    api: ComposeApi = jmapComposeApi((account) => accounts.client(account), foldersOf),
    outbox: EditQueue = edits.queue,
    stored: StoredDraft = (account, id) => storedDraft(session.mailStore, account, id),
  ) {
    this.#api = api;
    this.#outbox = outbox;
    this.#stored = stored;
    outbox.attach({
      replay: (item) => this.#replay(item),
      replayed: (item, id, newer) => this.#replayed(item, id, newer),
      revoke: (account, id) => void api.destroy(account, id, false).catch(() => {}),
    });
  }

  /** Route parameter of the open compose (`new` until the first save, offline `~<key>`). */
  get ref(): string | null {
    const d = this.current;
    if (!d) return null;
    return draftRef(d.saved ?? (d.parked ? { account: d.account, id: LOCAL_DRAFT + d.parked } : null));
  }

  /** "New email" (`openCompose`): without a mail account only the notice. */
  start(init: ComposeInit = {}, ret: ComposeReturn | null = null): boolean {
    const list = accounts.list ?? [];
    const account =
      list.find((a) => a.id === init.account) ?? defaultAccountOf(list, prefs.values.defaultAccount ?? null);
    if (!account) {
      ui.toasts.show(m.compose_no_account());
      return false;
    }
    this.#token++;
    this.#leaveCurrent();
    const draft = blank(account.id, init, ret);
    // A reply only counts as a change with own text, a prefill (mailto:) right away.
    const filled = init.mode
      ? !!init.text?.trim()
      : !!(init.to?.length || init.cc?.length || init.bcc?.length || init.subject || init.text);
    if (filled) {
      draft.dirty = true;
      draft.session.rev++;
      this.#schedule(draft.session);
    }
    this.#set(draft);
    this.#loadIdentities();
    // Forwarded attachments: limit for the sum (sending); if they lie in another account, they move.
    if (draft.atts.length) this.#sync(draft.session);
    return true;
  }

  /**
   * Reply bar of the reading view (`rp.send`): send the reply right away without
   * showing compose; `sent` is the text of the toast. If a
   * check fails, nothing remains (only the notice toast) and the result is
   * `false`. Undo and a failed send open compose
   * (`nav.reopen`).
   */
  sendNow(init: ComposeInit, ret: ComposeReturn, nav: ComposeNav, sent: string): boolean {
    // Without a connection do not even create compose: the text stays in the bar, no draft.
    if (network.offline) {
      this.refuseReply();
      return false;
    }
    if (!this.start(init, ret)) return false;
    // Without asking about the subject: the bar always has one ("Re:", "Fwd:").
    if (this.send(nav, sent, false)) return true;
    clearTimeout(this.#timer);
    this.#set(null);
    return false;
  }

  /**
   * Drafts again: in "Scheduled" their submission was withdrawn
   * ("Cancel send", "Delete", "Send now" before the new submission)
   * or cancelled elsewhere or left without an accepted recipient
   * (`planActions`). Scheduling had remembered them as sent; their address
   * opens compose again.
   */
  unsent(account: string, ids: readonly Id[]): void {
    for (const id of ids) this.#sent.delete(draftRef({ account, id }));
  }

  /**
   * Opens a saved draft. `false` if it no longer
   * exists, loading fails (error toast) or another
   * compose was opened in the meantime. With `sendAt` (after "Cancel send" from the
   * reading view) the previous time is in the "send later" popover,
   * as long as it lies in the future and below the limit (`planPre`).
   */
  async openDraft(account: string, id: Id, ret: ComposeReturn | null = null, sendAt?: number): Promise<boolean> {
    const token = ++this.#token;
    // A running save (leaving, new compose) is replacing the id right now: wait first, then forward.
    await Promise.allSettled([...this.#pending]);
    // After reloading the tab may not know the queue yet.
    await this.#outbox.restore();
    if (token !== this.#token) return false;
    ({ account, id } = this.#latest(account, id));
    // Sent: silently open nothing (the route goes to the drafts), so that no error toast replaces the toast "Message sent".
    if (this.#sent.has(draftRef({ account, id }))) return false;
    const open = this.current?.saved;
    if (open?.account === account && open.id === id) return true;
    // A waiting version is newer than the state at the server and applies even once the connection is back.
    const parked = this.#outbox.findDraft(account, id);
    if (parked && this.current?.parked === parked.key) return true;
    // Orphaned or still uploading in the background: this session instead of the state at the server.
    const orphan = [...this.#orphans, ...this.#busy].find(
      (s) => (s.saved?.account === account && s.saved.id === id) || (parked && s.parked === parked.key),
    );
    if (orphan) {
      this.#orphans.delete(orphan);
      this.#leaveCurrent();
      this.#set({ ...orphan.latest, ret: ret ?? orphan.latest.ret, menu: null });
      return true;
    }
    // Old address of a version replayed long ago: silently to the drafts as after sending.
    if (!parked && id.startsWith(LOCAL_DRAFT)) return false;
    if (parked) account = parked.account;
    let loaded: LoadedDraft | null;
    let list: Identity[] | null;
    try {
      // For the prefill (`sendAt`) know the account's limit, not only the default.
      if (sendAt !== undefined) this.#delayOf(account);
      [loaded, list] = await Promise.all([
        parked ? loadedOf(parked) : this.#load(account, id),
        this.#identities(account).catch(() => null),
        sendAt === undefined ? null : this.#delayLoads.get(account),
      ]);
    } catch (error) {
      if (token === this.#token) ui.toasts.error(failText(error));
      return false;
    }
    if (token !== this.#token) return false;
    if (!loaded) {
      ui.toasts.error(m.error_act());
      return false;
    }
    this.#leaveCurrent();
    const draft = blank(account, {}, ret);
    const saved = parked ? (parked.replace ?? parked.moved) : { account, id };
    const from = loaded.from;
    const ids = list ?? [];
    const identity = from
      ? (ids.find((i) => sameEmail(i.email, from.email) && (i.name || '') === (from.name || '')) ??
        ids.find((i) => sameEmail(i.email, from.email)) ??
        null)
      : null;
    const sig = (identity ?? sortIdentities(ids, accounts.get(account)?.email ?? '')[0])?.textSignature.trim() ?? '';
    // The quote stands behind the signature (`withQuote`).
    const quoted = splitQuote(loaded.text);
    const body = splitSignature(quoted.text, sig);
    Object.assign(draft, {
      identity: identity?.id ?? null,
      to: loaded.to,
      cc: loaded.cc,
      bcc: loaded.bcc,
      showCc: loaded.cc.length + loaded.bcc.length > 0,
      subject: loaded.subject,
      text: body.text,
      // Without identities a signature stays in the text; "Insert signature" does not append it twice.
      sigOff: list === null || (!!sig && !body.signed),
      atts: loaded.attachments.map((part) => ({
        key: attKey(),
        name: part.name ?? '',
        type: part.type,
        size: part.size,
        blob: { account, part },
        file: null,
      })),
      extras: {
        inReplyTo: loaded.inReplyTo,
        references: loaded.references,
        keywords: loaded.keywords,
        mailboxIds: loaded.mailboxIds,
        origin: account,
      },
      saved,
      parked: parked?.key ?? null,
      savedAt: loaded.receivedAt,
      fromDraft: true,
      quote: quoted.quote,
      later: sendAt === undefined ? '' : this.#preset(account, sendAt),
    } satisfies Partial<Draft>);
    draft.session.saved = saved;
    if (parked) {
      draft.session.parked = parked.key;
      draft.session.mid = parked.email.messageId ?? null;
      this.#parked.set(parked.key, draft.session);
    }
    this.#set(draft);
    this.#loadIdentities();
    // Limit for the sum (sending), e.g. for a draft from another program.
    if (draft.atts.length) void this.#limitsOf(account);
    return true;
  }

  /** Close: save if needed, then back; if saving fails, compose stays open. */
  async close(nav: ComposeNav): Promise<void> {
    const open = this.current;
    if (!open || this.#closing?.s === open.session) return;
    clearTimeout(this.#timer);
    const s = open.session;
    const closing = { s, waiting: true };
    this.#closing = closing;
    const done = () => {
      if (this.#closing === closing) this.#closing = null;
    };
    // Attachments belong to the draft: finish uploading first (tiles "Uploading …"), then save.
    await this.#uploaded(s);
    // Left (`park()` aborted it), discarded or another compose opened.
    if (this.#closing !== closing || this.current?.session !== s) {
      done();
      return;
    }
    closing.waiting = false;
    const d = s.latest;
    // The draft does not save failed attachments; they are only left out afterwards.
    const keep = keepOf(d);
    const note = keep && (d.dirty || !d.saved);
    if (note) {
      try {
        // Save right away what was typed during saving (`dirty` stays) and new attachments.
        do {
          await this.#uploaded(s);
          await this.#queue(s);
        } while (this.current?.session === s && s.latest.dirty && hasContent(s.latest));
      } catch (error) {
        ui.toasts.error(failText(error));
        return;
      } finally {
        done();
      }
      // Gone elsewhere in the meantime or another compose opened: that has reported nothing.
      if (this.current?.session !== s) {
        this.#bye(this.#dropFailed(s), true);
        return;
      }
    } else done();
    const bad = this.#dropFailed(s);
    // Emptied: delete an already saved draft (without the only copy of a left-out attachment).
    if (!keep) void this.#destroy(s, false).catch((error: unknown) => ui.toasts.error(failText(error)));
    this.#set(null);
    nav.leave(this.#retOf(d));
    if (!this.#bye(bad, keep) && note) ui.toasts.show(m.compose_saved());
  }

  /** "Discard" or "Delete draft" with undo; deleted only after the toast. */
  discard(nav: ComposeNav): void {
    const d = this.current;
    if (!d) return;
    clearTimeout(this.#timer);
    const s = d.session;
    this.#leaveClose(s);
    // Undo uploads the attachments again (`#reopen`).
    this.#abortUploads(s);
    this.#set(null);
    nav.leave(this.#retOf(d));
    if (!hasContent(d)) {
      void this.#destroy(s, false).catch((error: unknown) => ui.toasts.error(failText(error)));
      return;
    }
    ui.toasts.defer({
      text: d.saved || d.parked ? m.compose_deleted() : m.compose_discarded(),
      // The draft stays at the server until deleted; if that fails or someone signs out, the view stays.
      revert: () => {},
      onUndo: () => this.#reopen(s, nav),
      commit: (keepalive) => this.#destroy(s, keepalive),
      onError: (error) => ui.toasts.error(failText(error)),
    });
  }

  /**
   * "Send": check recipients, red addresses and sign-in, ask
   * without a subject, then submit. Compose closes
   * immediately; if sending fails, it opens again with an error toast.
   */
  /**
   * Send: `false` if a check fails (notice toast)
   * or nothing is open; otherwise the email goes out or waits for the
   * question about the subject (only with `ask`). `sent` is the text of the toast;
   * with `when` it is scheduled for this time (`plan()`).
   */
  send(nav: ComposeNav, sent: string = m.compose_sent(), ask = true, when: number | null = null): boolean {
    const d = this.current;
    if (!d || this.#closing?.s === d.session) return false;
    if (this.#sendOff(d)) {
      this.#refuseSend();
      return false;
    }
    const f = flushed(d);
    const all = [...f.to, ...f.cc, ...f.bcc];
    const fail = (text: string, err: Draft['err'] = null) => {
      // Open inputs become chips so that red addresses are visible; the content stays the same.
      this.#ui({ ...f, input: { to: '', cc: '', bcc: '' }, err, menu: null });
      ui.toasts.show(text);
    };
    if (!all.length) {
      fail(m.compose_need_to(), 'to');
      return false;
    }
    if (all.some((r) => !EMAIL.test(r.email))) {
      fail(m.compose_check_bad());
      return false;
    }
    if (d.atts.some((a) => uploading(d, a))) {
      fail(m.compose_check_uploading());
      return false;
    }
    if (d.atts.some((a) => uploadFailed(d, a))) {
      fail(m.compose_check_failed());
      return false;
    }
    // The session knows the limit since adding or opening (`#sync`); without it the server checks.
    const max = this.#limits.get(d.account)?.email ?? Infinity;
    if (attsSize(d.atts) > max) {
      fail(m.compose_check_sum({ size: limitText(max) }));
      return false;
    }
    const account = this.#choiceOf(d, this.#choices())?.account;
    if (account?.state === 'needs_reauth') {
      fail(m.compose_check_stale({ email: account.email }));
      return false;
    }
    const s = d.session;
    const go = () => {
      if (this.current?.session !== s) return;
      contacts.remember(all);
      void this.#deliver(s, nav, sent, when);
    };
    if (d.subject.trim() || !ask) go();
    else
      ui.ask({
        title: m.compose_no_subject_title(),
        text: m.compose_no_subject_text(),
        icon: 'ti-mail-question',
        ok: when === null ? m.compose_no_subject_ok() : m.compose_no_subject_plan(),
        run: go,
      });
    return true;
  }

  /** Leaves compose without closing (e.g. a mailbox opened): save with a notice. */
  park(): void {
    const d = this.current;
    if (!d) return;
    clearTimeout(this.#timer);
    this.#set(null);
    // The close is saving itself right now.
    if (this.#leaveClose(d.session)) return;
    const bad = this.#dropFailed(d.session);
    this.#stash(d.session.latest, true, bad);
  }

  /** The page is being left (`pagehide`): send unsaved changes with `keepalive`. */
  flush(): void {
    for (const s of this.#orphans) void this.#queue(s, true).catch(() => {});
    const d = this.current;
    if (!d || !d.dirty || !hasContent(d)) return;
    clearTimeout(this.#timer);
    void this.#queue(d.session, true).catch(() => {});
  }

  /** Sign-out: discard everything without saving. */
  reset(): void {
    clearTimeout(this.#timer);
    this.#token++;
    this.current = null;
    this.#closing = null;
    this.#gen++;
    this.#ids = {};
    this.#loads.clear();
    for (const s of this.#orphans) clearTimeout(s.retry);
    this.#orphans.clear();
    this.#parked.clear();
    for (const s of [...this.#busy]) this.#abortUploads(s);
    this.#moved.clear();
    this.#sent.clear();
    this.#limits.clear();
    this.#limitLoads.clear();
    this.#delays.clear();
    this.#delayLoads.clear();
    this.#delayFailed.clear();
    this.#noPlan.clear();
    this.#failBg = { at: -Infinity, count: 0 };
  }

  // — Inputs —

  setSubject(value: string): void {
    this.#edit({ subject: value });
  }

  setText(value: string): void {
    this.#edit({ text: value });
  }

  /** Input in To, Cc or Bcc; comma and semicolon turn the part before them into chips (`onChange`). */
  input(field: Field, value: string): void {
    const parts = splitRecipients(value);
    if (parts.length > 1) {
      const last = parts.pop() ?? '';
      const add = parts.flatMap(parseRecipients);
      this.#edit((d) => ({ [field]: merge(d[field], add), input: { ...d.input, [field]: last.trimStart() }, sug: 0 }));
    } else this.#edit((d) => ({ input: { ...d.input, [field]: value }, sug: 0 }));
  }

  /** Takes over the input as a chip (Enter, Tab, leaving the field). */
  commit(field: Field): void {
    const d = this.current;
    if (!d) return;
    const add = parseRecipients(d.input[field]);
    if (add.length) this.#edit((x) => ({ [field]: merge(x[field], add), input: { ...x.input, [field]: '' } }));
  }

  remove(field: Field, index: number): void {
    this.#edit((d) => ({ [field]: d[field].filter((_, i) => i !== index) }));
  }

  /** Backspace in the empty field removes the last chip. */
  removeLast(field: Field): void {
    const d = this.current;
    if (d && !d.input[field] && d[field].length) this.remove(field, d[field].length - 1);
  }

  /** ↑/↓ in the "Suggestions" list; after the last one the first again. */
  moveSuggestion(field: Field, step: 1 | -1): void {
    const d = this.current;
    const n = d ? this.#suggestions(d, field).length : 0;
    if (d && n) this.#ui({ sug: (Math.min(d.sug, n - 1) + step + n) % n });
  }

  /** Takes over a suggestion as a chip (`pick`); without an index the chosen one (Enter, Tab). */
  pickSuggestion(field: Field, index?: number): void {
    const d = this.current;
    if (!d) return;
    const list = this.#suggestions(d, field);
    const c = list[index ?? Math.min(d.sug, list.length - 1)];
    if (!c) return;
    const add = [{ name: c.name, email: c.email }];
    this.#edit((x) => ({ [field]: merge(x[field], add), input: { ...x.input, [field]: '' }, sug: 0 }));
  }

  focus(field: Field): void {
    this.#ui({ focus: field, sug: 0 });
    void contacts.ensure();
  }

  /**
   * Suggestions below `field`: only in the focused field and with input,
   * without the own addresses (mail accounts, identities) and without recipients
   * already in To, Cc or Bcc.
   */
  #suggestions(d: Draft, field: Field, choices: Choice[] = this.#choices()): Contact[] {
    if (d.focus !== field || !d.input[field].trim()) return [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, new per call
    const skip = new Set(
      [
        ...choices.map((c) => c.email),
        ...(accounts.list ?? []).map((a) => a.email),
        ...[...d.to, ...d.cc, ...d.bcc].map((r) => r.email),
      ].map((e) => e.toLowerCase()),
    );
    return contacts.suggest(d.input[field], (e) => skip.has(e));
  }

  blur(field: Field): void {
    this.commit(field);
    this.#ui((d) => (d.focus === field ? { focus: null } : {}));
  }

  /** "Cc/Bcc" shows both fields. */
  showCc(): void {
    this.#ui({ showCc: true });
  }

  toggleFrom(): void {
    this.#ui((d) => ({ menu: d.menu === 'from' ? null : 'from' }));
  }

  closeMenu(): void {
    this.#ui({ menu: null });
  }

  /**
   * "Send later" button (`later.toggle`): popover open and closed. Without
   * scheduled sending in the account from "send as" it stays closed; on mobile, where the
   * tooltip is missing, a toast says why.
   */
  toggleLater(mobile = false): void {
    const d = this.current;
    if (!d) return;
    if (this.#sendOff(d)) {
      this.#refuseSend();
      return;
    }
    if (this.#planLimit(d.account) <= 0) {
      if (mobile) ui.toasts.show(m.compose_plan_none());
      return;
    }
    this.#ui((x) => ({ menu: x.menu === 'later' ? null : 'later' }));
  }

  /** Field "date and time" (`later.onVal`); a notice from the server disappears with it. */
  setLater(value: string): void {
    this.#ui({ later: value, laterErr: null });
  }

  /**
   * "Schedule" (`later.plan`) or a preset (`opts[].onClick`):
   * checks the time like the popover, then sends like "Send" with
   * `HOLDUNTIL`. `false` if the time does not apply or a check fails.
   */
  plan(nav: ComposeNav, preset?: PlanPreset): boolean {
    const d = this.current;
    if (!d) return false;
    const now = Date.now();
    const limit = this.#planLimit(d.account);
    if (limit <= 0) return false;
    const tz = timeZoneOf(prefs.values);
    const when = preset
      ? (planPresets(now, tz).find((p) => p.key === preset)?.at ?? NaN)
      : d.laterErr
        ? NaN
        : fromLocalInput(d.later, tz);
    if (!(when >= planEarliest(now)) || when - now > limit) {
      // If the time only applied at the last render: redraw the reason at the field or the preset.
      if (preset || !d.later || d.laterErr) this.#ui({});
      else
        this.#ui({
          laterErr: when - now > limit ? m.compose_plan_over({ duration: planDuration(limit) }) : m.compose_plan_past(),
        });
      return false;
    }
    this.#ui({ menu: null });
    return this.send(nav, m.compose_sent(), true, when);
  }

  /** Row in "send as" (`opts[].onClick`); another account saves the draft there. */
  pickFrom(key: string): void {
    const choice = this.#choices().find((c) => keyOf(c.account.id, c.identity) === key);
    if (!choice || !this.current) return;
    this.#edit({ account: choice.account.id, identity: choice.identity, menu: null });
    // Blobs apply only in their account: attachments move along.
    this.#sync(this.current.session);
  }

  /** Removes or adds back the signature. */
  toggleSig(): void {
    this.#edit((d) => ({ sigOff: !d.sigOff }));
  }

  // — Attachments —

  /**
   * Attaches files: files above the per-file limit
   * are not added, the others in their order as long as the sum
   * of all tiles fits – from the first one that does not fit, no more.
   */
  toggleQuote(): void {
    this.#ui((d) => ({ quoteOpen: !d.quoteOpen }));
  }

  async addFiles(files: readonly File[]): Promise<void> {
    const start = this.current;
    if (!start || !files.length) return;
    const s = start.session;
    // If "send as" changes in the meantime, the upload checks the per-file limit and sending checks the sum again.
    const limits = await this.#limitsOf(start.account);
    const d = this.current;
    if (d?.session !== s) return;
    const big: File[] = [];
    const over: File[] = [];
    const ok: File[] = [];
    let sum = attsSize(d.atts);
    for (const f of files) {
      if (f.size > limits.file) big.push(f);
      else if (over.length || sum + f.size > limits.email) over.push(f);
      else {
        sum += f.size;
        ok.push(f);
      }
    }
    const text =
      big.length && over.length
        ? m.compose_att_mix({ count: big.length + over.length })
        : big.length === 1
          ? m.compose_att_too_big({ name: big[0]?.name ?? '', size: limitText(limits.file) })
          : big.length
            ? m.compose_att_too_big_many({ count: big.length, size: limitText(limits.file) })
            : over.length
              ? m.compose_att_sum({ size: limitText(limits.email) })
              : '';
    if (text) ui.toasts.show(text);
    if (!ok.length) return;
    const add = ok.map((f): Attachment => ({
      key: attKey(),
      name: f.name,
      type: f.type || 'application/octet-stream',
      size: f.size,
      blob: null,
      file: f,
    }));
    // Without a blob nothing changes in the draft yet; it is saved after uploading.
    this.#ui((x) => ({ atts: [...x.atts, ...add] }));
    this.#sync(s);
  }

  /** Removes an attachment (`atts[].remove`); a running upload aborts. */
  removeAttachment(key: string): void {
    const d = this.current;
    const a = d?.atts.find((x) => x.key === key);
    if (!d || !a) return;
    this.#cancel(d.session, key);
    const atts = d.atts.filter((x) => x !== a);
    // Without a blob it was not saved; with a blob (also during or after a move) it belonged to the draft.
    if (!a.blob) this.#ui({ atts });
    else this.#edit({ atts });
    this.#release(d.session, false);
  }

  /** "Try again": the tile uploads again. */
  retryAttachment(key: string): void {
    const d = this.current;
    const a = d?.atts.find((x) => x.key === key);
    if (!d || !a || !uploadFailed(d, a)) return;
    this.#ui({ atts: d.atts.map((x) => (x === a ? { ...x, failed: null } : x)) });
    this.#sync(d.session);
  }

  // — Values —

  #suggestionValues(d: Draft, k: Field, choices: Choice[]): Pick<FieldValues, 'hasSug' | 'sug'> {
    const list = this.#suggestions(d, k, choices);
    const on = Math.min(d.sug, list.length - 1);
    const sug = list.map((c, i): SuggestionValues => {
      const [avBg, avInk] = avatarOf(c.name || c.email);
      return {
        key: c.email.toLowerCase(),
        name: c.name || c.email,
        email: c.name ? c.email : '',
        letter: letterOf(c.name, c.email),
        avBg,
        avInk,
        on: i === on,
      };
    });
    return { hasSug: sug.length > 0, sug };
  }

  /**
   * "Send later" popover: limit of the account from
   * "send as", presets and field in `tz`, notice for a
   * time that the popover or the server does not accept.
   */
  #laterValues(d: Draft, time: ComposeTime): LaterValues {
    const now = time.now ?? Date.now();
    const limit = this.#planLimit(d.account);
    const netOff = this.#sendOff(d);
    const off = limit <= 0 || netOff;
    const open = d.menu === 'later' && !off;
    const tip = netOff ? m.offline_send() : off ? m.compose_plan_none() : '';
    // Closed, only the button counts; times and names are only computed by the open popover (every key press renders).
    if (!open) return { ...LATER_CLOSED, dis: off, tip, val: d.later };
    const duration = planDuration(limit);
    const earliest = planEarliest(now);
    const at = d.later ? fromLocalInput(d.later, time.tz) : NaN;
    const past = !!d.later && !(at >= earliest);
    const over = !!d.later && !past && at - now > limit;
    const hint = d.laterErr ?? (past ? m.compose_plan_past() : over ? m.compose_plan_over({ duration }) : '');
    return {
      open,
      dis: off,
      tip,
      opts: planPresets(now, time.tz).map((p) => {
        const dis = p.at - now > limit;
        return {
          key: p.key,
          label: p.label,
          icon: p.icon,
          sub: dis ? m.compose_plan_opt_over({ duration }) : planWhen(p.at, now, time),
          dis,
        };
      }),
      val: d.later,
      min: toLocalInput(earliest, time.tz),
      max: toLocalInput(now + limit, time.tz),
      hasHint: !!hint,
      hintText: hint,
      invalid: !!hint,
      showLimit: !hint,
      limitText: m.compose_plan_max({ duration }),
      tzShow: time.tz !== (time.device ?? deviceZone()),
      tzText: m.compose_plan_tz({ name: zoneName(time.tz, now) }),
      btnDis: !d.later || !!hint,
    };
  }

  values(time: ComposeTime): ComposeValues | null {
    const d = this.current;
    if (!d) return null;
    const choices = this.#choices();
    const cur = this.#choiceOf(d, choices);
    const option = (c: Choice): FromOption => {
      const { bg, ink } = colorOf(c.account);
      return {
        key: keyOf(c.account.id, c.identity),
        name: c.name || c.email,
        email: c.email,
        letter: letterOf(c.name, c.email),
        bg,
        ink,
        on: c === cur,
      };
    };
    const head = cur ? option(cur) : null;
    const from: FromValues = {
      name: head?.name ?? '',
      email: head?.email ?? '',
      letter: head?.letter ?? '?',
      bg: head?.bg ?? '',
      ink: head?.ink ?? '',
      open: d.menu === 'from',
      multi: choices.length > 1,
      stale: cur?.account.state === 'needs_reauth',
      opts: choices.map(option),
    };
    const labels: Record<Field, string> = { to: m.compose_to(), cc: m.compose_cc(), bcc: m.compose_bcc() };
    const fields = (d.showCc ? FIELD_KEYS : (['to'] as const)).map((k): FieldValues => ({
      key: k,
      label: labels[k],
      val: d.input[k],
      auto: k === 'to' && d.to.length === 0,
      ph: k !== 'to' ? '' : d.err === 'to' ? m.compose_to_missing() : m.compose_to_ph(),
      err: k === 'to' && d.err === 'to',
      showToggle: k === 'to' && !d.showCc,
      ...this.#suggestionValues(d, k, choices),
      chips: d[k].map((r, i) => {
        const bad = !EMAIL.test(r.email);
        const label = r.name || r.email;
        const [avBg, avInk] = avatarOf(label);
        return {
          key: `${i}/${r.email}`,
          label,
          title: r.name ? `${r.name} <${r.email}>` : r.email,
          letter: bad ? '!' : letterOf(r.name, r.email),
          avBg,
          avInk,
          bad,
          rmLabel: m.compose_chip_remove({ name: label }),
        };
      }),
    }));
    const saving = d.dirty && hasContent(d) && !d.failed;
    const hasSaved = d.savedAt !== null && !d.failed;
    const sendOff = this.#sendOff(d);
    const sig = cur?.sig ?? '';
    const later = this.#laterValues(d, time);
    return {
      title: composeTitle(d),
      backLabel: this.#retOf(d).label,
      discardLabel: d.saved || d.parked ? m.compose_discard_draft() : m.compose_discard(),
      status: saving
        ? m.compose_status_saving()
        : hasSaved
          ? sendOff
            ? m.offline_saved({ time: clock(d.savedAt!, time) })
            : m.compose_status_saved({ time: clock(d.savedAt!, time) })
          : '',
      statusM: saving
        ? m.compose_status_saving()
        : hasSaved
          ? sendOff
            ? m.offline_saved_mobile()
            : m.compose_status_saved({ time: clock(d.savedAt!, time) })
          : '',
      hasStatus: saving || hasSaved,
      statusIcon: saving ? 'ti-cloud-upload' : sendOff ? 'ti-cloud-off' : 'ti-cloud-check',
      sendOff,
      from,
      later,
      fields,
      // A popover the account does not allow is not an open menu either.
      anyMenu: d.menu === 'from' || later.open,
      subj: d.subject,
      text: d.text,
      taAuto: d.to.length > 0,
      ph: d.mode === 'fwd' ? m.compose_fwd_ph() : m.compose_text_ph(),
      sig,
      sigShow: !!sig && !d.sigOff,
      sigAdd: !!sig && d.sigOff,
      atts: d.atts.map((a): AttachmentValues => {
        const name = a.name || m.read_file();
        const up = uploading(d, a);
        const fail = uploadFailed(d, a);
        return {
          key: a.key,
          name,
          icon: fail ? 'ti-alert-circle' : up ? 'ti-cloud-upload' : fileIcon(name, a.type),
          sub: fail
            ? a.failed?.offline
              ? m.compose_att_offline()
              : m.compose_att_failed()
            : up
              ? m.compose_att_uploading()
              : fileSize(a.size),
          up,
          failed: fail,
          retryLabel: m.compose_att_retry({ name }),
          rmLabel: m.compose_att_remove({ name }),
        };
      }),
      hasAtts: d.atts.length > 0,
      attTitle: attachmentsText(d.atts.length),
      hasQuote: !!d.quote,
      quoteHead: d.quote?.head ?? '',
      quoteParas: (d.quote?.paras ?? []).map((t) => ({ t })),
      quoteOpen: d.quoteOpen,
      quoteExp: d.quoteOpen ? 'true' : 'false',
      quoteChevT: d.quoteOpen ? 'rotate(180deg)' : 'none',
    };
  }

  // — internal —

  #set(d: Draft | null): void {
    this.current = d;
    if (!d) return;
    d.session.latest = d;
    if (!this.#delays.has(d.account)) this.#delayOf(d.account);
  }

  /** Change to the content: `dirty`, notice at the field gone, reschedule autosave. */
  #edit(patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)): void {
    const d = this.current;
    if (!d) return;
    d.session.rev++;
    this.#set({ ...d, ...(typeof patch === 'function' ? patch(d) : patch), dirty: true, err: null, failed: false });
    this.#schedule(d.session);
  }

  /** Display only: menu, focus, Cc/Bcc. */
  #ui(patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)): void {
    const d = this.current;
    if (d) this.#set({ ...d, ...(typeof patch === 'function' ? patch(d) : patch) });
  }

  #schedule(s: ComposeSession): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        const d = s.latest;
        if (this.current?.session === s && d.dirty && hasContent(d))
          void this.#queue(s).catch((error: unknown) => this.#saveFailed(s, error));
      },
      s.parked || network.offline ? OFFLINE_SAVE_MS : AUTOSAVE_MS,
    );
  }

  /**
   * Autosave rejected: the state at the server stays, the status display
   * disappears, the next change tries again. The error toast
   * comes once per series of failures, not on every attempt.
   */
  #saveFailed(s: ComposeSession, error: unknown): void {
    if (s.failNoted || this.current?.session !== s) return;
    s.failNoted = true;
    ui.toasts.error(failText(error, m.error_pref()));
  }

  /**
   * Saved draft from the server; if the response fails to come, from the message
   * storage. If it is missing there or only incomplete,
   * the error stays (toast "No connection").
   */
  async #load(account: string, id: Id): Promise<LoadedDraft | null> {
    try {
      return await this.#api.load(account, id);
    } catch (error) {
      if (!unanswered(error)) throw error;
      const stored = await this.#stored(account, id).catch(() => null);
      if (!stored) throw error;
      return stored;
    }
  }

  /** Saves behind all running operations of the same session. */
  #queue(s: ComposeSession, keepalive = false): Promise<void> {
    return this.#enqueue(s, () => this.#save(s, keepalive));
  }

  /** Operation (save, send) behind all running ones of the same session; `openDraft` waits for it. */
  #enqueue<T>(s: ComposeSession, task: () => Promise<T>): Promise<T> {
    const run = s.chain.then(task);
    const done = run.then(
      () => {},
      () => {},
    );
    s.chain = done;
    this.#pending.add(done);
    void done.then(() => this.#pending.delete(done));
    return run;
  }

  /** Newest state of a draft that has been replaced in the meantime. */
  #latest(account: string, id: Id): SavedDraft {
    let at: SavedDraft = { account, id };
    for (let next = this.#moved.get(draftRef(at)); next; next = this.#moved.get(draftRef(at))) at = next;
    return at;
  }

  /** What gets saved or sent: open inputs as recipients, signature in the text. */
  #emailOf(d: Draft, choice: Choice): DraftEmail {
    const f = flushed(d);
    const addr = (r: Recipient): EmailAddress => ({ name: r.name || null, email: r.email });
    const { origin, mailboxIds, ...extras } = d.extras;
    return {
      from: { name: choice.name || null, email: choice.email },
      to: f.to.map(addr),
      cc: f.cc.map(addr),
      bcc: f.bcc.map(addr),
      subject: d.subject,
      text: withQuote(bodyOf(d.text, d.sigOff ? '' : choice.sig), d.quote),
      // Whatever is still uploading follows with the next save.
      attachments: d.atts.flatMap((a) => (a.blob?.account === choice.account.id ? [a.blob.part] : [])),
      ...extras,
      // Further mailboxes (tags) apply only in the account the draft comes from.
      mailboxIds: origin === choice.account.id ? mailboxIds : [],
    };
  }

  /**
   * Without a connection: sending cannot wait. The browser alone
   * does not decide (`network.offline`); a waiting version
   * means the last attempt got no response.
   */
  #sendOff(d: Draft): boolean {
    // If another tab replayed the version, nothing waits any more, even if the session does not know it.
    return network.offline || (!!d.parked && this.#outbox.drafts.some((x) => x.key === d.parked));
  }

  /** Sending disabled: a waiting version tries again right away, afterwards it works. */
  #refuseSend(text = m.offline_send()): void {
    ui.toasts.error(text);
    void this.#outbox.replay(true);
  }

  /**
   * Sending from the reply bar without a connection (`rp.sendOff`): error toast
   * with the hint to "Open in editor"; as in compose a
   * waiting version tries the replay right away.
   */
  refuseReply(): void {
    this.#refuseSend(m.offline_reply());
  }

  async #save(s: ComposeSession, keepalive: boolean): Promise<void> {
    const d = s.latest;
    if (!hasContent(d) || (!d.dirty && (s.saved || s.parked))) return;
    const rev = s.rev;
    const gen = this.#gen;
    const choice = this.#choiceOf(d, this.#choices());
    if (!choice) throw new ComposeError('Send as');
    const account = choice.account.id;
    const old = s.saved;
    // If attachments are still moving, the draft stays in the previous account until they lie in the new one;
    // otherwise saving would delete them there with it (the end of the upload saves again).
    // A failed move does not hold up; it keeps the previous draft below.
    if (old && old.account !== account && d.atts.some((a) => a.blob && a.blob.account !== account && uploading(d, a)))
      return;
    s.mid ??= newMessageId();
    const email = { ...this.#emailOf(d, choice), messageId: s.mid };
    // If a version is already waiting, the next one queues up: only the replay detects a conflict.
    if (s.parked || (keepalive && network.offline)) {
      await this.#park(s, account, email, rev, false, keepalive);
      return;
    }
    let id: Id;
    try {
      id = await this.#api.save(account, email, old?.account === account ? old.id : null, keepalive);
    } catch (error) {
      if (unanswered(error)) {
        // After sign-out the text belongs in no queue: the next one would be that of another user.
        if (gen === this.#gen) await this.#park(s, account, email, rev, true, keepalive);
        return;
      }
      this.#patch(s, { failed: true });
      throw error;
    }
    s.mid = null;
    s.failNoted = false;
    // Another account under "send as": delete the draft in the previous account – unless it is
    // the only copy of a failed attachment.
    if (old && old.account !== account) {
      if (needsDraftIn(d, old.account)) s.stale.push(old);
      else if (!s.kept.has(old.account)) void this.#api.destroy(old.account, old.id, keepalive).catch(() => {});
    }
    if (old) this.#moved.set(draftRef(old), { account, id });
    s.saved = { account, id };
    this.#patch(s, { saved: s.saved, savedAt: Date.now(), dirty: s.rev !== rev, failed: false });
    this.#release(s, keepalive);
  }

  /**
   * Without a response: the version waits in the queue and shows itself as
   * saved. `failed`: the attempt ran, the replay
   * comes by itself. `closing`: the page is going away.
   */
  async #park(
    s: ComposeSession,
    account: string,
    email: DraftEmail,
    rev: number,
    failed: boolean,
    closing: boolean,
  ): Promise<void> {
    const old = s.saved;
    const same = old?.account === account;
    const key = s.parked ?? queueKey(Date.now(), ++parkSeq);
    s.parked = key;
    this.#parked.set(key, s);
    const at = Date.now();
    this.#patch(s, { parked: key, savedAt: at, dirty: s.rev !== rev, failed: false });
    // A draft in another account only goes after the replay, unless it holds a failed attachment.
    const gone = old && !same && !needsDraftIn(s.latest, old.account) && !s.kept.has(old.account);
    const item: QueuedDraft = { key, account, email, replace: same ? old : null, moved: gone ? old : null, at };
    await this.#outbox.addDraft(item, failed, closing);
  }

  /** Takes back the waiting version: discarded or sent. */
  #unpark(s: ComposeSession): void {
    const key = s.parked;
    if (!key) return;
    s.parked = null;
    this.#parked.delete(key);
    this.#patch(s, { parked: null });
    void this.#outbox.dropDraft(key);
  }

  /**
   * Brings a version to the server. If a blob or a further mailbox is missing
   * (after a long time offline, another device has cleaned up), the
   * text goes out without them. If the server rejects it itself, it stays.
   */
  async #replay(item: QueuedDraft): Promise<ReplayedDraft> {
    let email = item.email;
    for (;;) {
      try {
        const saved = await this.#api.saveQueued(item.account, email, item.replace?.id ?? null);
        if (item.moved) void this.#api.destroy(item.moved.account, item.moved.id, false).catch(() => {});
        this.#trimmed(item, email);
        return saved;
      } catch (error) {
        const next = error instanceof ComposeError ? lighter(email, error.errors) : null;
        if (!next) throw error;
        email = next;
      }
    }
  }

  /** What the replay had to leave out also applies to the open compose, and the toast names the attachments. */
  #trimmed(item: QueuedDraft, email: DraftEmail): void {
    if (email === item.email) return;
    const kept = email.attachments.map((a) => a.blobId);
    const gone = item.email.attachments.filter((a) => !kept.includes(a.blobId));
    const name = gone[0]?.name || m.read_file();
    if (gone.length)
      ui.toasts.show(
        gone.length === 1 ? m.compose_saved_without({ name }) : m.compose_saved_without_many({ count: gone.length }),
      );
    const s = this.#parked.get(item.key);
    if (!s) return;
    const d = s.latest;
    this.#patch(s, {
      atts: d.atts.filter((a) => !a.blob || a.blob.account !== item.account || kept.includes(a.blob.part.blobId)),
      extras: { ...d.extras, mailboxIds: email.mailboxIds },
    });
  }

  /** The version lies at the server: the session continues with the new id, old addresses follow it. */
  #replayed(item: QueuedDraft, id: Id, newer: boolean): void {
    const to = { account: item.account, id };
    if (item.replace) this.#moved.set(draftRef(item.replace), to);
    if (item.moved) this.#moved.set(draftRef(item.moved), to);
    this.#moved.set(draftRef({ account: item.account, id: LOCAL_DRAFT + item.key }), to);
    const s = this.#parked.get(item.key);
    if (!s) return;
    const old = s.saved;
    // If the previous draft holds a failed attachment, it stays until nobody needs it any more.
    if (old && old.account !== item.account && !item.moved && !s.kept.has(old.account)) s.stale.push(old);
    s.saved = to;
    s.failNoted = false;
    if (!newer) {
      s.parked = null;
      s.mid = null;
      this.#parked.delete(item.key);
    }
    this.#patch(s, { saved: to, parked: s.parked, savedAt: Date.now() });
    this.#release(s, false);
  }

  /** Deletes earlier drafts that no failed attachment needs any more (`stale`). */
  #release(s: ComposeSession, keepalive: boolean): void {
    const d = s.latest;
    const gone = s.stale.filter((x) => !needsDraftIn(d, x.account));
    if (!gone.length) return;
    s.stale = s.stale.filter((x) => !gone.includes(x));
    for (const x of gone) void this.#api.destroy(x.account, x.id, keepalive).catch(() => {});
  }

  #patch(s: ComposeSession, patch: Partial<Draft>): void {
    const next = { ...s.latest, ...patch };
    s.latest = next;
    if (this.current?.session === s) this.current = next;
  }

  /**
   * Uploads every attachment missing in the account of "send as" there and
   * aborts uploads into another account; from another account the
   * content comes via a download if the file is no longer available.
   */
  #sync(s: ComposeSession): void {
    const d = s.latest;
    // Sending checks the sum against the limit of this account.
    if (d.atts.length) void this.#limitsOf(d.account);
    const start: Attachment[] = [];
    for (const a of d.atts) {
      if (s.uploads.get(a.key)?.account === d.account) continue;
      this.#cancel(s, a.key);
      // Failed stays failed until "Try again"; another account tries anew.
      if (uploading(d, a)) start.push(a);
    }
    // An error from an earlier account no longer applies, not even after switching back.
    if (start.some((a) => a.failed))
      this.#patch(s, { atts: s.latest.atts.map((x) => (start.includes(x) ? { ...x, failed: null } : x)) });
    for (const a of start) this.#upload(s, a, d.account);
  }

  /** Limit for "send later" in the account; 0 = no scheduled sending. */
  #planLimit(account: string): number {
    return this.#noPlan.has(account) ? 0 : planLimit(this.#delays.get(account) ?? null);
  }

  /**
   * Reads `maxDelayedSend` of an account once per sign-in, already when
   * opening compose (`#set`), so that the popover knows the limit.
   * If it fails, the default applies; a new attempt at the earliest after
   * `RETRY_MS`, not on every input.
   */
  #delayOf(account: string): void {
    if (this.#delays.has(account) || this.#delayLoads.has(account)) return;
    if (Date.now() - (this.#delayFailed.get(account) ?? -Infinity) < RETRY_MS) return;
    const gen = this.#gen;
    // Asynchronous even if the call itself throws: `#set` must never fail.
    const load = Promise.resolve()
      .then(() => this.#api.maxDelay(account))
      .then(
        (delay) => {
          if (gen !== this.#gen) return;
          this.#delays.set(account, delay);
          // If the popover opened with the default, it is no longer a menu now (Escape).
          const d = this.current;
          if (d?.account === account && d.menu === 'later' && this.#planLimit(account) <= 0) this.#ui({ menu: null });
        },
        () => {
          if (gen === this.#gen) this.#delayFailed.set(account, Date.now());
        },
      )
      .finally(() => {
        if (this.#delayLoads.get(account) === load) this.#delayLoads.delete(account);
      });
    this.#delayLoads.set(account, load);
  }

  /**
   * Limits of an account from its session (the client keeps them
   * current); simultaneous queries share one, `#limits` keeps the
   * last state for sending. Without a session no limit.
   */
  #limitsOf(account: string): Promise<AttachmentLimits> {
    const running = this.#limitLoads.get(account);
    if (running) return running;
    const gen = this.#gen;
    const load = this.#api.limits(account).then(
      (limits) => {
        if (gen === this.#gen) this.#limits.set(account, limits);
        return limits;
      },
      () => NO_LIMITS,
    );
    this.#limitLoads.set(account, load);
    void load.then(() => {
      if (this.#limitLoads.get(account) === load) this.#limitLoads.delete(account);
    });
    return load;
  }

  /** Aborts the upload of an attachment; a session is in `#busy` exactly with running uploads. */
  #cancel(s: ComposeSession, key: string): void {
    s.uploads.get(key)?.ctrl.abort();
    s.uploads.delete(key);
    if (!s.uploads.size) this.#busy.delete(s);
  }

  #upload(s: ComposeSession, a: Attachment, account: string): void {
    const gen = this.#gen;
    // Register before the first `await`, so that even an immediate error removes the entry.
    const run: Upload = { account, ctrl: new AbortController(), done: Promise.resolve() };
    s.uploads.set(a.key, run);
    this.#busy.add(s);
    // Removed, aborted, moved to another account or signed out: discard the result.
    const live = () => gen === this.#gen && s.uploads.get(a.key) === run;
    const { signal } = run.ctrl;
    run.done = (async () => {
      let file = a.file;
      try {
        // The target account's limit, also when moving (before a download).
        const { file: max } = await this.#limitsOf(account);
        if (a.size > max) throw new TooBig(max);
        file ??= a.blob ? await this.#api.download(a.blob.account, a.blob.part, signal) : null;
        if (!file) throw new ComposeError('Attachment without content');
        const res = await this.#api.upload(account, file, a.type, signal);
        if (!live()) return;
        this.#cancel(s, a.key);
        const part = partOf(a, res);
        const atts = s.latest.atts.map((x) =>
          x.key === a.key ? { ...x, file, size: res.size, blob: { account, part }, failed: null } : x,
        );
        this.#changed(s, atts);
      } catch (error) {
        if (!live()) return;
        this.#cancel(s, a.key);
        const name = a.name || m.read_file();
        if (error instanceof TooBig) {
          // Too large for this account (after a switch under "send as"): drops out as when adding.
          this.#drop(s, a);
          ui.toasts.show(m.compose_att_too_big({ name, size: limitText(error.max) }));
        } else if (this.current?.session === s) {
          // Compose open: the tile shows the error, without a toast; the content stays for "Try again".
          const fail = { account, offline: isOffline(error) };
          this.#patch(s, { atts: s.latest.atts.map((x) => (x.key === a.key ? { ...x, file, failed: fail } : x)) });
          // If the move held up saving, the autosave catches up (without the tile).
          if (s.latest.dirty) this.#schedule(s);
        } else {
          // In the background after leaving: the draft stays without the file, error toast.
          if (onlyCopy(a)) s.kept.add(a.blob.account);
          this.#drop(s, a);
          this.#failToast([a]);
        }
      }
    })();
  }

  /** Takes an attachment without a blob in this account out of the session. */
  #drop(s: ComposeSession, a: Attachment): void {
    const atts = s.latest.atts.filter((x) => x.key !== a.key);
    // If it already lay in another account, it was part of the saved draft.
    if (a.blob) this.#changed(s, atts);
    else this.#patch(s, { atts });
  }

  /**
   * Error toast for failed uploads; errors shortly after one another count together.
   */
  #failToast(bad: readonly Attachment[]): void {
    const now = Date.now();
    const count = (now - this.#failBg.at < FAIL_BG_MS ? this.#failBg.count : 0) + bad.length;
    this.#failBg = { at: now, count };
    const name = bad[0]?.name || m.read_file();
    ui.toasts.error(count === 1 ? m.compose_att_fail_bg({ name }) : m.compose_att_fail_bg_many({ count }));
  }

  /** Attachments changed after an upload: save as after an input, right away outside compose. */
  #changed(s: ComposeSession, atts: Attachment[]): void {
    s.rev++;
    this.#patch(s, { atts, dirty: true, failed: false });
    if (this.current?.session === s) this.#schedule(s);
    else this.#stash(s.latest, false);
  }

  /** Waits for all uploads of the session, also those added later. */
  async #uploaded(s: ComposeSession): Promise<void> {
    while (s.uploads.size) await Promise.all([...s.uploads.values()].map((u) => u.done));
  }

  #abortUploads(s: ComposeSession): void {
    for (const key of [...s.uploads.keys()]) this.#cancel(s, key);
  }

  /** Deletes the last saved draft after running saves have finished. */
  #destroy(s: ComposeSession, keepalive: boolean): Promise<void> {
    return s.chain.then(async () => {
      this.#unpark(s);
      // Earlier drafts that only a failed attachment still needed go along.
      for (const x of s.stale.splice(0)) void this.#api.destroy(x.account, x.id, keepalive).catch(() => {});
      const saved = s.saved;
      // Only location of a left-out attachment (`kept`): stays.
      if (!saved || s.kept.has(saved.account)) return;
      await this.#api.destroy(saved.account, saved.id, keepalive);
      if (s.saved === saved) s.saved = null;
      this.#patch(s, { saved: null, savedAt: null });
    });
  }

  /**
   * Submits after "Send"; compose is already closed.
   * Success: toast "Message sent", whose undo withdraws the
   * submission. Otherwise compose opens again with an error toast; if the
   * server rejects only `HOLDFOR`, it sends without it after the toast expires.
   * Scheduled with `when` (`HOLDUNTIL`): toast "Scheduled: …"; a
   * rejected time is reported by `#planRefused`.
   */
  async #deliver(s: ComposeSession, nav: ComposeNav, sentText: string, when: number | null): Promise<void> {
    const d = s.latest;
    clearTimeout(this.#timer);
    this.#set(null);
    // Replace: "back" does not lead to a draft that no longer exists after sending.
    nav.leave(this.#retOf(d), true);
    const gen = this.#gen;
    const live = () => gen === this.#gen;
    const planned = when !== null;
    const fail = (error: unknown) => {
      if (!live()) return;
      this.#reopen(s, nav);
      // Scheduling has no error text of its own: the general one.
      ui.toasts.error(failText(error, planned ? m.error_act() : m.compose_send_failed()));
    };
    const holdFor = planned ? null : Math.ceil(UNDO_MS[prefs.values.gUndo] / 1000) + SEND_BUFFER_S;
    const start = Date.now();
    let sent: { account: string; sub: Submission; res: SendResult };
    try {
      sent = await this.#enqueue(s, () => this.#submit(s, { holdFor, holdUntil: when }, gen));
    } catch (error) {
      fail(error);
      return;
    }
    const { account, sub, res } = sent;
    if (!live()) return;
    const ref = draftRef({ account, id: res.email });
    if (!res.ok && planned) {
      const why = planRefusal(res.error);
      if (why) this.#planRefused(s, nav, account, why, when);
      else fail(new ComposeError('EmailSubmission/set', [res.error]));
      return;
    }
    if (!res.ok) {
      if (holdRefused(res.error))
        this.#sendDeferred(s, nav, { account, ref, email: res.email, sub, live, fail, sent: sentText });
      else fail(new ComposeError('EmailSubmission/set', [res.error]));
      return;
    }
    if (res.rejected) {
      await this.#api.restore(account, res.email, planned).catch(() => {});
      fail(new ComposeError('EmailSubmission/set'));
      return;
    }
    // Undo only as long as the withdrawal arrives before sending.
    const text = planned ? m.compose_planned({ when: planWhen(when, Date.now(), this.#time()) }) : sentText;
    const ms = planned
      ? Math.min(UNDO_MS[prefs.values.gUndo], when - Date.now() - CANCEL_MS)
      : (holdFor ?? 0) * 1000 - (Date.now() - start) - CANCEL_MS;
    if (ms < 1000) {
      ui.toasts.show(text);
      return;
    }
    let back = true;
    ui.toasts.undoable({
      text,
      ms,
      undo: async () => {
        back = await this.#api.unsend(account, res.submission, res.email, planned);
      },
      onUndone: () => {
        if (!live()) return;
        this.#sent.delete(ref);
        // If the email still lies in "Sent", the next save replaces it with a draft.
        this.#reopen(s, nav, !back);
      },
      onError: (error) => ui.toasts.error(cannotUnsend(error) ? m.compose_already_sent() : failText(error)),
    });
  }

  /**
   * Saves the last state and submits. If the email afterwards lies (again)
   * in "Drafts", its id counts as the session's draft; sent addresses
   * open nothing any more. After sign-out (`gen`) the state stays untouched.
   */
  async #submit(
    s: ComposeSession,
    hold: Pick<Submission, 'holdFor' | 'holdUntil'>,
    gen: number,
  ): Promise<{ account: string; sub: Submission; res: SendResult }> {
    const d = s.latest;
    // The submission needs an identity; if they are not loaded yet, now.
    await this.#identities(d.account).catch(() => []);
    const choice = this.#choiceOf(d, this.#choices());
    if (!choice?.identity) throw new ComposeError('Send as');
    const account = choice.account.id;
    const email = this.#emailOf(d, choice);
    const f = flushed(d);
    // Every recipient once in the envelope, even if it is in To and Cc.
    const rcptTo = merge([], [...f.to, ...f.cc, ...f.bcc]).map((r) => r.email);
    const sub: Submission = { identity: choice.identity, mailFrom: choice.email, rcptTo, ...hold };
    // With `keepalive` sending survives closing the tab right after the click.
    const keepalive = new TextEncoder().encode(email.text).length < KEEPALIVE_MAX;
    const old = s.saved;
    const res = await this.#api.send(account, email, old?.account === account ? old.id : null, sub, keepalive);
    if (gen !== this.#gen) return { account, sub, res };
    if (old && old.account !== account) void this.#api.destroy(old.account, old.id, false).catch(() => {});
    // If a version was still stored while sending: it would otherwise give a ghost draft.
    this.#unpark(s);
    s.mid = null;
    s.saved = { account, id: res.email };
    const ref = draftRef(s.saved);
    // A rejected time (`HOLDUNTIL`) leaves the draft in place; only `HOLDFOR` sends right away once more.
    if (res.ok ? !res.rejected : !hold.holdUntil && holdRefused(res.error)) {
      if (old) this.#sent.add(draftRef(old));
      this.#sent.add(ref);
    } else if (old) this.#moved.set(draftRef(old), s.saved);
    this.#patch(s, { saved: s.saved, savedAt: Date.now(), dirty: false, failed: false });
    return { account, sub, res };
  }

  /** `HOLDFOR` rejected: like the other actions send only after the toast expires. */
  #sendDeferred(
    s: ComposeSession,
    nav: ComposeNav,
    at: {
      account: string;
      ref: string;
      email: Id;
      sub: Submission;
      live: () => boolean;
      fail: (error: unknown) => void;
      /** Text of the toast (`send()`). */
      sent: string;
    },
  ): void {
    const { account, ref, email, sub, live, fail } = at;
    ui.toasts.defer({
      text: at.sent,
      // The draft still lies in "Drafts"; undo only opens it again.
      revert: () => {},
      onUndo: () => {
        this.#sent.delete(ref);
        if (live()) this.#reopen(s, nav);
      },
      commit: async (keepalive) => {
        const res = await this.#api.submit(account, email, { ...sub, holdFor: null }, keepalive);
        if (!res.ok) throw new ComposeError('EmailSubmission/set', [res.error]);
        if (res.rejected) {
          await this.#api.restore(account, res.email).catch(() => {});
          throw new ComposeError('EmailSubmission/set');
        }
      },
      onError: (error) => {
        this.#sent.delete(ref);
        fail(error);
      },
    });
  }

  /**
   * Time rejected when scheduling: nothing is
   * scheduled, the draft is saved, compose opens again with the
   * time in the field. Beyond the limit and in the past the
   * reason also stands in the open popover; if FUTURERELEASE is switched off,
   * "send later" stays disabled for the account until reload.
   */
  #planRefused(s: ComposeSession, nav: ComposeNav, account: string, why: 'ext' | 'over' | 'past', when: number) {
    const text =
      why === 'ext' ? m.compose_plan_ext() : why === 'over' ? m.compose_plan_reject() : m.compose_plan_past();
    if (why === 'ext') this.#noPlan.add(account);
    const later = toLocalInput(when, this.#time().tz);
    this.#reopen(s, nav, false, why === 'ext' ? { later } : { later, laterErr: text, menu: 'later' });
    ui.toasts.error(text);
  }

  /** Previous time for the field "date and time" (`planPre`), otherwise empty. */
  #preset(account: string, sendAt: number): string {
    const now = Date.now();
    return sendAt >= planEarliest(now) && sendAt - now <= this.#planLimit(account)
      ? toLocalInput(sendAt, this.#time().tz)
      : '';
  }

  /**
   * "Send now" of a scheduled message whose sending was just cancelled:
   * submits it with identity and envelope of the previous
   * submission like "Send" (`HOLDFOR`), toast "Message sent" with
   * undo, which withdraws it and opens compose (`reopen`). If it
   * fails, it lies as a draft in "Drafts": compose opens with it, and an
   * error toast reports it. `true` if it is submitted.
   */
  async resend(
    account: string,
    email: Id,
    prev: { identityId: Id; envelope: Envelope | null },
    reopen: () => void,
  ): Promise<boolean> {
    // After sign-out (`#gen`) neither toast nor compose.
    const gen = this.#gen;
    const live = () => gen === this.#gen;
    const fail = (error?: unknown) => {
      if (!live()) return false;
      reopen();
      ui.toasts.error(failText(error, m.compose_send_failed()));
      return false;
    };
    // Without an envelope (another client let the server build it) there is no `HOLDFOR` and thus no undo.
    const env = prev.envelope;
    const holdFor = env ? Math.ceil(UNDO_MS[prefs.values.gUndo] / 1000) + SEND_BUFFER_S : null;
    const sub: Submission = {
      identity: prev.identityId,
      mailFrom: env?.mailFrom.email ?? '',
      rcptTo: env?.rcptTo.map((r) => r.email) ?? [],
      holdFor,
      ...(env ? {} : { envelope: null }),
    };
    const start = Date.now();
    let res: SendResult;
    try {
      res = await this.#api.submit(account, email, sub, false);
    } catch (error) {
      return fail(error);
    }
    if (!res.ok) return fail();
    if (res.rejected) {
      await this.#api.restore(account, email).catch(() => {});
      return fail();
    }
    if (!live()) return true;
    // Sent as after "Send": its address opens nothing any more until undo withdraws it.
    const ref = draftRef({ account, id: email });
    this.#sent.add(ref);
    const ms = (holdFor ?? 0) * 1000 - (Date.now() - start) - CANCEL_MS;
    if (ms < 1000) {
      ui.toasts.show(m.compose_sent());
      return true;
    }
    ui.toasts.undoable({
      text: m.compose_sent(),
      ms,
      undo: async () => {
        await this.#api.unsend(account, res.submission, email);
      },
      onUndone: () => {
        if (!live()) return;
        this.#sent.delete(ref);
        reopen();
      },
      onError: (error) => ui.toasts.error(cannotUnsend(error) ? m.compose_already_sent() : failText(error)),
    });
    return true;
  }

  /** Time zone and time format from language & region. */
  #time(): ComposeTime {
    return { tz: timeZoneOf(prefs.values), timeFmt: prefs.values.timeFmt };
  }

  /** Opens compose again with the state of a session (undo, failed send). */
  #reopen(s: ComposeSession, nav: ComposeNav, dirty = false, extra: Partial<Draft> = {}): void {
    this.#token++;
    this.#leaveCurrent();
    this.#set({ ...s.latest, menu: null, focus: null, ...(dirty ? { dirty } : {}), ...extra });
    this.#sync(s);
    if (dirty) {
      s.rev++;
      this.#schedule(s);
    }
    nav.reopen();
  }

  /** Another compose opens: save the previous one silently (`openCompose`). */
  #leaveCurrent(): void {
    const d = this.current;
    if (!d) return;
    clearTimeout(this.#timer);
    if (this.#leaveClose(d.session)) return;
    const bad = this.#dropFailed(d.session);
    this.#stash(d.session.latest, false, bad);
  }

  /**
   * Compose is being left: a close that is still waiting for uploads
   * ends without saving (the caller takes that over); `true` if the
   * close is already saving itself.
   */
  #leaveClose(s: ComposeSession): boolean {
    const closing = this.#closing;
    if (closing?.s !== s) return false;
    if (!closing.waiting) return true;
    this.#closing = null;
    return false;
  }

  /**
   * Close and leave drop failed attachments; they were not saved anyway. If an earlier draft is the
   * only copy of such an attachment (move without content), it stays.
   */
  #dropFailed(s: ComposeSession): Attachment[] {
    const d = s.latest;
    const bad = d.atts.filter((a) => uploadFailed(d, a));
    if (!bad.length) return bad;
    for (const a of bad) if (onlyCopy(a)) s.kept.add(a.blob.account);
    s.stale = s.stale.filter((x) => !s.kept.has(x.account));
    this.#patch(s, { atts: d.atts.filter((a) => !uploadFailed(d, a)) });
    return bad;
  }

  /**
   * Toast about left-out attachments: with a draft "Saved as draft
   * without …", without one an error toast; `true` if one came.
   */
  #bye(bad: readonly Attachment[], keep: boolean): boolean {
    if (!bad.length) return false;
    const name = bad[0]?.name || m.read_file();
    if (keep)
      ui.toasts.show(
        bad.length === 1 ? m.compose_saved_without({ name }) : m.compose_saved_without_many({ count: bad.length }),
      );
    else this.#failToast(bad);
    return true;
  }

  /** Saves on leaving; with `note` a toast reports the draft, `bad` names left-out attachments. */
  #stash(d: Draft, note: boolean, bad: readonly Attachment[] = []): void {
    const keep = keepOf(d);
    if (!keep || (!d.dirty && d.saved)) {
      this.#bye(bad, keep);
      return;
    }
    const s = d.session;
    this.#queue(s).then(
      () => {
        if (!this.#bye(bad, true) && note) ui.toasts.show(m.compose_saved());
      },
      (error: unknown) => {
        ui.toasts.error(failText(error));
        // Do not lose it: try again later; the draft opens again via its address.
        this.#orphans.add(s);
        this.#retry(s);
      },
    );
  }

  #retry(s: ComposeSession): void {
    const gen = this.#gen;
    clearTimeout(s.retry);
    s.retry = setTimeout(() => {
      if (gen !== this.#gen || !this.#orphans.has(s)) return;
      this.#queue(s).then(
        () => this.#orphans.delete(s),
        () => this.#retry(s),
      );
    }, RETRY_MS);
  }

  #retOf(d: Draft): ComposeReturn {
    return d.ret ?? { href: mailboxPath(d.account, { role: 'inbox' }), label: m.mailbox_inbox() };
  }

  /** All senders per account its identities, without loaded ones the account's address. */
  #choices(): Choice[] {
    return (accounts.list ?? []).flatMap((account): Choice[] => {
      const ids = this.#ids[account.id];
      if (!Array.isArray(ids) || ids.length === 0)
        return [{ account, identity: null, name: '', email: account.email, sig: '' }];
      return sortIdentities(ids, account.email).map((i) => ({
        account,
        identity: i.id,
        name: i.name,
        email: i.email,
        sig: i.textSignature.trim(),
      }));
    });
  }

  #choiceOf(d: Draft, choices: Choice[]): Choice | undefined {
    return (
      choices.find((c) => c.account.id === d.account && c.identity === d.identity) ??
      // An account removed in the meantime does not silently move into another one.
      choices.find((c) => c.account.id === d.account)
    );
  }

  /** Identities of an account after saving in Mail account › Identities: sender and signature for the next compose. */
  identitiesChanged(account: string, list: Identity[]): void {
    // A fetch still running is older and no longer overwrites the list.
    this.#loads.delete(account);
    this.#ids = { ...this.#ids, [account]: list };
  }

  /** Loads the identities of all accounts; the next opening retries failed ones. */
  #loadIdentities(): void {
    for (const a of accounts.list ?? []) {
      const state = this.#ids[a.id];
      if (state === undefined || state === 'error') void this.#identities(a.id).catch(() => {});
    }
  }

  #identities(account: string): Promise<Identity[]> {
    const state = this.#ids[account];
    if (Array.isArray(state)) return Promise.resolve(state);
    let load = this.#loads.get(account);
    if (!load) {
      this.#ids = { ...this.#ids, [account]: 'loading' };
      const gen = this.#gen;
      const current = () => gen === this.#gen && this.#loads.get(account) === load;
      load = this.#api.identities(account).then(
        (list) => {
          if (!current()) return list;
          this.#ids = { ...this.#ids, [account]: list };
          this.#loads.delete(account);
          return list;
        },
        (error: unknown) => {
          if (!current()) throw error;
          this.#ids = { ...this.#ids, [account]: 'error' };
          this.#loads.delete(account);
          throw error;
        },
      );
      this.#loads.set(account, load);
    }
    return load;
  }
}

/** Mailboxes "Drafts", "Sent" and "Scheduled" of an account. */
export interface Folders {
  drafts: Id;
  /** Without "Sent" a sent email stays in "Drafts", only without `$draft`. */
  sent: Id | null;
  /** Mailbox with the role `scheduled`; before the first scheduling it is often missing. */
  scheduled?: Id | null;
}

/** Mailboxes of the account; with `plan` it creates "Scheduled" if it is missing. */
async function foldersOf(account: string, plan = false): Promise<Folders> {
  await mailboxes.ensure(account);
  const drafts = mailboxes.role(account, 'drafts');
  if (!drafts) throw new ComposeError('Drafts');
  let scheduled = mailboxes.role(account, 'scheduled')?.id ?? null;
  if (plan && !scheduled) scheduled = await mailboxes.create(account, m.mailbox_scheduled(), null, 'scheduled');
  return { drafts: drafts.id, sent: mailboxes.role(account, 'sent')?.id ?? null, scheduled };
}

/** `HOLDFOR` rejected (FUTURERELEASE off or beyond the limit); other reasons of `forbiddenMailFrom` do not count. */
export function holdRefused(error: SetError): boolean {
  const text = error.description ?? '';
  // Only the responses about FUTURERELEASE, not e.g. "Message size exceeds maximum".
  return (
    error.type === 'forbiddenMailFrom' &&
    (/FUTURERELEASE/i.test(text) || /\b(hold|release)\b[^.]*\bexceeds maximum/i.test(text))
  );
}

/** Withdrawal too late: the message is already on its way (RFC 8621, 7.5). */
export function cannotUnsend(error: unknown): boolean {
  return error instanceof ComposeError && error.errors.some((e) => e.type === 'cannotUnsend');
}

/** Sent: from "Drafts" to "Sent", without `$draft`. */
function sentPatch(f: Folders): PatchObject {
  return f.sent
    ? { [`mailboxIds/${f.drafts}`]: null, [`mailboxIds/${f.sent}`]: true, 'keywords/$draft': null }
    : { 'keywords/$draft': null };
}

/** Scheduled: from "Drafts" to "Scheduled", without `$draft`, with `$scheduled`. */
function scheduledPatch(f: Folders): PatchObject {
  if (!f.scheduled) throw new ComposeError('Scheduled');
  return {
    [`mailboxIds/${f.drafts}`]: null,
    [`mailboxIds/${f.scheduled}`]: true,
    'keywords/$draft': null,
    'keywords/$scheduled': true,
  };
}

/** Back as a draft (undo, no recipient accepted), from "Sent" or with `planned` from "Scheduled". */
function draftPatch(f: Folders, planned = false): PatchObject {
  if (planned) return verdictPatch('draft', { ...f, scheduled: f.scheduled ?? null });
  return f.sent
    ? { [`mailboxIds/${f.sent}`]: null, [`mailboxIds/${f.drafts}`]: true, 'keywords/$draft': true }
    : { 'keywords/$draft': true };
}

/** Parameter at `MAIL FROM`: `HOLDUNTIL` or `HOLDFOR` (RFC 4865). */
function holdParameters(sub: Submission): Record<string, string> | null {
  if (sub.holdUntil) return { HOLDUNTIL: holdUntil(sub.holdUntil) };
  return sub.holdFor ? { HOLDFOR: String(sub.holdFor) } : null;
}

/** Envelope with `HOLDFOR` or `HOLDUNTIL` at `MAIL FROM`. */
function submissionOf(emailId: string, sub: Submission): Partial<EmailSubmission> {
  if (sub.envelope === null) return { identityId: sub.identity, emailId, envelope: null };
  return {
    identityId: sub.identity,
    emailId,
    envelope: {
      mailFrom: { email: sub.mailFrom, parameters: holdParameters(sub) },
      rcptTo: sub.rcptTo.map((email) => ({ email, parameters: null })),
    },
  };
}

async function updateEmail(c: JmapClient, accountId: Id, id: Id, patch: PatchObject): Promise<void> {
  const res = await c.call('Email/set', { accountId, update: { [id]: patch } });
  const error = res.notUpdated?.[id];
  if (error) throw new ComposeError('Email/set', [error]);
}

/** Has the server changed the email after `onSuccessUpdateEmail` (implicit `Email/set`)? */
function emailUpdated(response: BatchResponse, call: Call<'EmailSubmission/set'>, id: Id): boolean {
  const updated = response.implicit(call, 'Email/set')?.updated;
  return !!updated && Object.hasOwn(updated, id);
}

/** Evaluates the response to creating the submission `send`. */
async function submitted(
  c: JmapClient,
  accountId: Id,
  response: BatchResponse,
  call: Call<'EmailSubmission/set'>,
  email: Id,
  /** Target after success (`onSuccessUpdateEmail`) in case the server does not run it. */
  done: PatchObject,
): Promise<SendResult> {
  // If `EmailSubmission/set` fails as a whole, the draft is saved in the same request anyway.
  const result = response.result(call);
  if (!result.ok) {
    const description = result.error.details['description'];
    return {
      ok: false,
      email,
      error: typeof description === 'string' ? { type: result.error.type, description } : { type: result.error.type },
    };
  }
  const created = result.value.created?.['send'];
  if (!created?.id) return { ok: false, email, error: result.value.notCreated?.['send'] ?? { type: 'serverFail' } };
  let { undoStatus, deliveryStatus } = created;
  if (undoStatus === undefined) {
    // Not in the response to `create`: ask. If that fails, the submission exists anyway.
    try {
      const got = await c.call('EmailSubmission/get', {
        accountId,
        ids: [created.id],
        properties: ['undoStatus', 'deliveryStatus'],
      });
      ({ undoStatus, deliveryStatus } = got.list[0] ?? {});
    } catch {
      // Without a status it counts as accepted.
    }
  }
  const rejected = undoStatus === 'final' && noneAccepted(deliveryStatus);
  // If the server did not run `onSuccessUpdateEmail`, move it to "Sent" or "Scheduled" ourselves.
  if (!rejected && !emailUpdated(response, call, email)) await updateEmail(c, accountId, email, done).catch(() => {});
  return { ok: true, email, submission: created.id, rejected };
}

/** Id of the draft just created; if the server rejects, `ComposeError` with its reasons. */
function createdDraft(res: Pick<SetResponse<Email>, 'created' | 'notCreated'>): Id {
  const id = res.created?.['draft']?.id;
  if (!id) throw new ComposeError('Email/set', Object.values(res.notCreated ?? {}));
  return id;
}

/**
 * Deletes the replaced draft in a separate `Email/set` after the new one
 * is created. If that fails, at most one
 * draft too many stays; the save counts.
 */
async function dropReplaced(c: JmapClient, accountId: Id, id: Id, keepalive: boolean): Promise<void> {
  const batch = c.batch();
  batch.call('Email/set', { accountId, destroy: [id] });
  await batch.send(undefined, { keepalive }).catch(() => {});
}

/** Plain text from HTML (draft of another program without a text part). */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const p of doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6')) p.append('\n');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Draft as a new email in "Drafts" (`$draft`, `$seen`) with further
 * mailboxes. Empty recipient fields are missing: Stalwart v1.0.2 rejects `null`
 * on creation with `invalidProperties` (RFC 8621 allows both).
 */
/** Restore from the queue: the same fields as from the server. */
function loadedOf({ email, at }: QueuedDraft): LoadedDraft {
  return {
    ...email,
    to: toRecipients(email.to),
    cc: toRecipients(email.cc),
    bcc: toRecipients(email.bcc),
    receivedAt: at,
  };
}

/**
 * Own `Message-ID` of a save; `.invalid` (RFC 2606), because on sending
 * the server assigns the final one, and a domain name from the sender
 * could be non-ASCII.
 */
function newMessageId(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@roedy.invalid`;
}

/** The version without what the server misses; `null` if that is not the reason. */
function lighter(email: DraftEmail, errors: readonly SetError[]): DraftEmail | null {
  const blobs = errors.flatMap((e) => (e.type === 'blobNotFound' ? ((e['notFound'] as Id[] | undefined) ?? []) : []));
  const boxes = errors.some((e) => e.type === 'invalidProperties' && e.properties?.includes('mailboxIds'));
  const attachments = email.attachments.filter((a) => !a.blobId || !blobs.includes(a.blobId));
  const mailboxIds = boxes ? [] : email.mailboxIds;
  if (attachments.length === email.attachments.length && mailboxIds.length === email.mailboxIds.length) return null;
  return { ...email, attachments, mailboxIds };
}

function emailObject(email: DraftEmail, drafts: Id) {
  const list = (key: 'to' | 'cc' | 'bcc') => (email[key].length ? { [key]: email[key] } : {});
  return {
    mailboxIds: Object.fromEntries([...email.mailboxIds, drafts].map((b) => [b, true as const])),
    keywords: { ...email.keywords, $draft: true as const, $seen: true as const },
    from: [email.from],
    ...list('to'),
    ...list('cc'),
    ...list('bcc'),
    subject: email.subject,
    bodyValues: { body: { value: email.text, isEncodingProblem: false, isTruncated: false } },
    textBody: [{ partId: 'body', type: 'text/plain' } as EmailBodyPart],
    ...(email.attachments.length
      ? {
          attachments: email.attachments.map(
            (p) =>
              ({
                blobId: p.blobId,
                type: p.type,
                name: p.name,
                disposition: p.disposition,
                cid: p.cid,
                ...(p.charset ? { charset: p.charset } : {}),
              }) as EmailBodyPart,
          ),
        }
      : {}),
    ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
    ...(email.references ? { references: email.references } : {}),
    ...(email.messageId ? { messageId: [email.messageId] } : {}),
  };
}

/** File above `maxSizeUpload` of the target account. */
class TooBig extends Error {
  readonly max: number;
  constructor(max: number) {
    super('maxSizeUpload');
    this.max = max;
  }
}

/**
 * Part of an uploaded attachment (RFC 8621, 4.1.4): name and type as
 * chosen; when moving, charset, disposition and `cid` of the original stay.
 */
function partOf(a: Attachment, res: UploadedBlob): EmailBodyPart {
  const base = a.blob?.part;
  return {
    partId: null,
    blobId: res.blobId,
    size: res.size,
    headers: [],
    name: a.name || null,
    type: a.type,
    charset: base?.charset ?? null,
    disposition: base?.disposition ?? 'attachment',
    cid: base?.cid ?? null,
    language: base?.language ?? null,
    location: base?.location ?? null,
    subParts: null,
  };
}

const toRecipients = (list: EmailAddress[] | null): Recipient[] =>
  (list ?? []).map((a) => ({ name: a.name?.trim() ?? '', email: a.email }));

/** `ComposeApi` via JMAP (RFC 8621: `Identity/get`, `Email/get`, `Email/set`, `EmailSubmission/set`). */
export function jmapComposeApi(
  client: (account: string) => Promise<JmapClient>,
  folders: (account: string, plan?: boolean) => Promise<Folders>,
): ComposeApi {
  /** Mailboxes on sending, so that "undo" withdraws without a further fetch. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, not displayed
  const known = new Map<string, Folders>();
  const foldersFor = async (account: string, plan = false) => {
    const f = await folders(account, plan);
    known.set(account, f);
    return f;
  };
  return {
    async identities(account) {
      const c = await client(account);
      const res = await c.call('Identity/get', { accountId: await c.accountId(), ids: null });
      return res.list;
    },
    async load(account, id) {
      const c = await client(account);
      const res = await c.call('Email/get', {
        accountId: await c.accountId(),
        ids: [id],
        properties: [
          'from',
          'to',
          'cc',
          'bcc',
          'subject',
          'receivedAt',
          'inReplyTo',
          'references',
          'textBody',
          'attachments',
          'bodyValues',
          'keywords',
          'mailboxIds',
        ],
        fetchTextBodyValues: true,
      });
      const e = res.list[0];
      if (!e) return null;
      const text = draftText(e.textBody ?? [], e.bodyValues ?? {});
      return {
        from: e.from?.[0] ?? null,
        to: toRecipients(e.to),
        cc: toRecipients(e.cc),
        bcc: toRecipients(e.bcc),
        subject: e.subject ?? '',
        text,
        receivedAt: Date.parse(e.receivedAt),
        attachments: e.attachments ?? [],
        inReplyTo: e.inReplyTo ?? null,
        references: e.references ?? null,
        keywords: draftKeywords(e.keywords),
        mailboxIds: Object.keys(e.mailboxIds ?? {}),
      };
    },
    async save(account, email, replace, keepalive) {
      const [c, f] = await Promise.all([client(account), folders(account)]);
      const accountId = await c.accountId();
      const batch = c.batch();
      const call = batch.call('Email/set', { accountId, create: { draft: emailObject(email, f.drafts) } });
      const id = createdDraft((await batch.send(undefined, { keepalive })).get(call));
      // The previous one only now: Stalwart also deletes in the same call when it rejects `create`.
      // Do not wait: the draft is already saved, the next operations do not need the deletion.
      if (replace) void dropReplaced(c, accountId, replace, keepalive);
      return id;
    },
    async saveQueued(account, email, replace) {
      const [c, f] = await Promise.all([client(account), folders(account)]);
      const accountId = await c.accountId();
      // If only the response failed to come, the attempt already lies there. Stalwart does not find `Message-ID` via the `header` filter.
      const look = c.batch();
      const query = look.call('Email/query', {
        accountId,
        filter: { inMailbox: f.drafts },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: RECENT_DRAFTS,
      });
      const recent = look.call('Email/get', { accountId, '#ids': query.ref('/ids'), properties: ['messageId'] });
      const arrived = (await look.send())
        .get(recent)
        .list.filter((e) => !!email.messageId && e.messageId?.includes(email.messageId))
        .map((e) => e.id);
      // Own earlier attempts go in the same call: if they stayed, they would grow with every lost response.
      const res = await c.call('Email/set', {
        accountId,
        create: { draft: emailObject(email, f.drafts) },
        destroy: arrived.filter((id) => id !== replace),
      });
      const id = createdDraft(res);
      if (!replace) return { id, conflict: false };
      // The state at the server only now, as when saving.
      const done = await c.call('Email/set', { accountId, destroy: [replace] });
      // Contents are immutable: if another device changes the draft, it gets a new id.
      const conflict = !arrived.length && done.notDestroyed?.[replace]?.type === 'notFound';
      return { id, conflict };
    },
    async destroy(account, id, keepalive) {
      const c = await client(account);
      const batch = c.batch();
      const call = batch.call('Email/set', { accountId: await c.accountId(), destroy: [id] });
      const res = (await batch.send(undefined, { keepalive })).get(call);
      const errors = rejected(res.notDestroyed);
      if (errors.length)
        throw new ComposeError(
          'Email/set',
          errors.map(([, e]) => e),
        );
    },
    async send(account, email, replace, sub, keepalive) {
      const [c, f] = await Promise.all([client(account), foldersFor(account, !!sub.holdUntil)]);
      const done = sub.holdUntil ? scheduledPatch(f) : sentPatch(f);
      const accountId = await c.accountId();
      const batch = c.batch();
      const set = batch.call('Email/set', { accountId, create: { draft: emailObject(email, f.drafts) } });
      // `#draft` refers to the draft just created, `#send` to the submission (RFC 8620, 5.3);
      // if the draft is missing, the submission fails as a whole (`invalidResultReference`).
      const call = batch.call('EmailSubmission/set', {
        accountId,
        create: { send: submissionOf('#draft', sub) },
        onSuccessUpdateEmail: { '#send': done },
      });
      const response = await batch.send(undefined, { keepalive });
      const id = createdDraft(response.get(set));
      // The new draft replaces the previous one even if the submission fails; deleted only now.
      if (replace) void dropReplaced(c, accountId, replace, keepalive);
      return submitted(c, accountId, response, call, id, done);
    },
    async submit(account, email, sub, keepalive) {
      const [c, f] = await Promise.all([client(account), foldersFor(account, !!sub.holdUntil)]);
      const done = sub.holdUntil ? scheduledPatch(f) : sentPatch(f);
      const accountId = await c.accountId();
      const batch = c.batch();
      const call = batch.call('EmailSubmission/set', {
        accountId,
        create: { send: submissionOf(email, sub) },
        onSuccessUpdateEmail: { '#send': done },
      });
      return submitted(c, accountId, await batch.send(undefined, { keepalive }), call, email, done);
    },
    async unsend(account, submission, email, planned = false) {
      const [c, f] = await Promise.all([client(account), known.get(account) ?? folders(account)]);
      const accountId = await c.accountId();
      const batch = c.batch();
      const call = batch.call('EmailSubmission/set', {
        accountId,
        update: { [submission]: { undoStatus: 'canceled' } },
        onSuccessUpdateEmail: { [submission]: draftPatch(f, planned) },
      });
      const response = await batch.send();
      const res = response.get(call);
      if (!res.updated || !Object.hasOwn(res.updated, submission))
        throw new ComposeError('EmailSubmission/set', Object.values(res.notUpdated ?? {}));
      // `onSuccessUpdateEmail` on an update is unverified with Stalwart: otherwise do it ourselves.
      // The submission is already withdrawn; if only moving it back fails, `false` reports it.
      if (emailUpdated(response, call, email)) return true;
      return updateEmail(c, accountId, email, draftPatch(f, planned)).then(
        () => true,
        () => false,
      );
    },
    async restore(account, email, planned = false) {
      const [c, f] = await Promise.all([client(account), known.get(account) ?? folders(account)]);
      await updateEmail(c, await c.accountId(), email, draftPatch(f, planned));
    },
    async maxDelay(account) {
      const c = await client(account);
      return submissionCapability(await c.session(), await c.accountId()).maxDelayedSend;
    },
    async limits(account) {
      const c = await client(account);
      const session = await c.session();
      return {
        file: coreCapability(session).maxSizeUpload,
        email: mailCapability(session, await c.accountId()).maxSizeAttachmentsPerEmail ?? Infinity,
      };
    },
    async upload(account, data, type, signal) {
      const c = await client(account);
      const res = await c.upload(await c.accountId(), data, type, signal);
      return { blobId: res.blobId, size: res.size };
    },
    async download(account, part, signal) {
      if (!part.blobId) throw new ComposeError('Attachment without blob');
      const c = await client(account);
      return c.download(
        {
          accountId: await c.accountId(),
          blobId: part.blobId,
          type: part.type,
          ...(part.name ? { name: part.name } : {}),
        },
        signal,
      );
    },
  };
}

export const compose = new Compose();
