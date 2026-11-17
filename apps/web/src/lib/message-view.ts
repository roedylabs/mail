/**
 * Values of the reading view: header with subject, tags, position in the
 * list and tools, the emails of the conversation to expand and collapse with
 * text part and attachments, the message theme and the reply bar in the
 * closed state. The emails come from `message`. Plus the source dialog and
 * HTML emails in the iframe with the "External content" banner and the
 * notice about truncated parts with "Load full message". The page carries
 * out star, read, delete, spam and restore via `edits`, also setting tags
 * and moving with their popovers and the move sheet.
 * Without a connection, an email without saved text shows the "not saved
 * for offline use" card, attachments are dimmed.
 */
import type { EmailAddress } from '@roedy/jmap';
import { derivedAccentVars, MA_COLORS, MODES } from '@roedy/tokens';
import type { IconName } from '#lib/icons.ts';
import {
  avatarOf,
  byTagRank,
  fullTime,
  initials,
  isOutbox,
  messagesText,
  nameOf,
  readTime,
  senderText,
  tagColors,
  type ListKind,
  type RowTag,
  type TimeContext,
} from '#lib/mail-list.ts';
import { intlLocale } from '#lib/locale.ts';
import { m } from '#lib/paraglide/messages.js';
import type { SourceHeader, SourceParts } from '#lib/mail-source.ts';
import { loadsRemote, remoteBanner, senderKey, type RemoteBanner } from '#lib/mail/remote-content.ts';
import { cidKey, isInlineImage, partKey } from '#lib/mail/parts.ts';
// Types only: `render.ts` (DOMPurify) comes via `ReadInput.render` from `#lib/mail/renderer.svelte.ts`.
import type { RenderedMail } from '#lib/mail/render.ts';
import type { RenderMail } from '#lib/mail/renderer.svelte.ts';
import { replyContext, type ReplyContext } from '#lib/reply.ts';
import { overlayClose, type OverlayEvent } from '#lib/shell.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import {
  htmlOf,
  inlineCids,
  paragraphsOf,
  truncationOf,
  type MessageEmail,
  type MessagePart,
} from '#lib/state/message.svelte.ts';
import type { Settings } from '#lib/state/prefs.svelte.ts';

/** Mailboxes of an account by role (mailbox id or `null`). */
export type RoleBoxes = Record<'sent' | 'drafts' | 'scheduled' | 'trash' | 'spam', string | null>;

export interface ReadInput {
  /** Emails of the thread by `receivedAt`, oldest first. */
  emails: readonly MessageEmail[];
  /** Email that represented the conversation in the list (`rm`); without it the newest. */
  repId: string | null;
  kind: ListKind;
  /** Title of the view for "Back". */
  title: string;
  /** Account of the thread: address, colour (index in `MA_COLORS`) and state. */
  account: Pick<MailAccount, 'email' | 'color' | 'state'> | undefined;
  roles: RoleBoxes;
  /** "All accounts": dot in the account's colour. */
  multi: boolean;
  /** Tag of a mailbox of the account, otherwise `undefined`. */
  tagOf: (mailbox: string) => (RowTag & { id: string }) | undefined;
  /** Open popover of the toolbar (desktop). */
  menu: 'tag' | 'move' | null;
  /** Tree of the tag list for "Add tag". */
  tagTree: readonly TagNode[];
  /** Tags whose mailbox is being created in the account: they already count as set. */
  tagPending: ReadonlySet<string>;
  /** Targets for "Move". */
  move: MoveTargets;
  time: TimeContext;
  /** Send time of an email in "Scheduled" (`sendAt` of its submission), otherwise `receivedAt` applies. */
  sendAt?: ((email: string, mailboxIds: readonly string[]) => number | undefined) | undefined;
  /** Expanded or collapsed emails by id; otherwise only the last one and `rm` are open. */
  folds: Readonly<Record<string, boolean>>;
  /** App appearance dark and message theme inverted. */
  dark: boolean;
  inverted: boolean;
  /** Mobile: padding of the HTML rendering like the mobile card. */
  isMobile: boolean;
  /** External content settings. */
  ext: Pick<Settings, 'extMode' | 'extAllow'>;
  /** Emails with "Load once". */
  once: ReadonlySet<string>;
  /**
   * Rendering of the HTML parts (with DOMPurify); `null` while the page is
   * still loading `render.ts` (`mailRenderer`) – then no document yet (`hb.doc`).
   */
  render: RenderMail | null;
  /** Embedded images per email (`Conversation.images`); missing while they load. */
  images: Readonly<Record<string, ReadonlyMap<string, string>>>;
  /** Emails whose parts are currently loading without a limit (`Conversation.loadingFull`). */
  loadingFull: ReadonlySet<string>;
  /** Without a connection or an account without access: attachments are never in the store. */
  offline: boolean;
  /** Position in the loaded list; `null` if the conversation is not there. */
  nav: { index: number; total: number; hasPrev: boolean; hasNext: boolean } | null;
}

/** Attachment of an email. */
export interface ReadAttachment {
  key: string;
  name: string;
  icon: IconName;
  size: string;
  ext: string;
  part: MessagePart;
  /** Dimmed and without pointer while `offline`; the route decides and reports the toast. */
  op: number;
  dis: 'true' | 'false';
  cur: 'pointer' | 'default';
  tip: string;
  dlIcon: IconName;
}

/** HTML rendering of an email: banner and document for the iframe. */
export interface ReadHtml extends RemoteBanner {
  /** Document for the iframe; `null` while the email is collapsed. */
  doc: string | null;
  /** Sender for "Always load from this sender" (lower case). */
  sender: string;
}

/** Notice about a truncated part with "Load full message". */
export interface ReadTruncation {
  part: 'html' | 'text';
  size: string;
  text: string;
  busy: boolean;
  busyAttr: 'true' | 'false';
  label: string;
  cur: 'progress' | 'pointer';
}

/** Email of the conversation. */
export interface ReadMessage {
  key: string;
  me: boolean;
  notMe: boolean;
  who: string;
  whoShort: string;
  email: string;
  letter: string;
  avBg: string;
  avInk: string;
  toText: string;
  toTip: string;
  hasCc: boolean;
  ccText: string;
  time: string;
  timeFull: string;
  paras: { t: string }[];
  snip: string;
  atts: ReadAttachment[];
  hasAtts: boolean;
  attN: string;
  open: boolean;
  closed: boolean;
  canFold: boolean;
  cur: 'pointer' | 'default';
  isLast: boolean;
  notLast: boolean;
  oBox: string;
  oPad: string;
  isHtml: boolean;
  notHtml: boolean;
  /** Only with `isHtml`. */
  hb: ReadHtml | null;
  /** "Truncated" notice below the text or HTML of the expanded email. */
  trunc: boolean;
  /** Only with `trunc`. */
  tr: ReadTruncation | null;
  /** Text not in the store: card instead of content, neither `isHtml` nor `notHtml`. */
  miss: boolean;
  missText: string;
}

/** State of a header popover button: "Add tag" or "Move". */
export interface ReadMenuButton {
  open: boolean;
  exp: 'true' | 'false';
  bg: string;
  c: string;
}

/** Tag in the popover or in the second level "Add tag". */
export interface ReadTagOption {
  /** Id of the tag (`tags`). */
  id: string;
  label: string;
  /** Colour of the icon: that of the tag (`MA_COLORS`). */
  dot: string;
  /** Indentation by depth in the tree. */
  pl: string;
  /** A shown email carries the tag. */
  on: 'true' | 'false';
  ckBg: string;
  ckRing: string;
  ckOp: number;
}

/** Targets for "Move": inbox and folder tree of the account. */
export interface MoveTargets {
  /** Inbox; `null` while it is missing. */
  inbox: string | null;
  folders: readonly FolderNode[];
  /** The emails are already there (check mark, without effect). */
  on: (mailbox: string) => boolean;
}

/** Target in the "Move to" popover or in the move sheet. */
export interface ReadMoveOption {
  /** Mailbox id of the target. */
  id: string;
  label: string;
  icon: 'ti-inbox' | 'ti-folder';
  /** Divider before the first top-level folder. */
  sep: boolean;
  pl: string;
  /** The emails are already there: check mark, without effect. */
  dis: 'true' | 'false';
  ckOp: number;
  color: string;
  cursor: 'default' | 'pointer';
}

/** Move sheet: mobile in the sheet, with back to "More actions". */
export interface MoveValues {
  /** Subject of the conversation (desktop below the title). */
  sub: string;
  opts: ReadMoveOption[];
  hasBack: boolean;
  noBack: boolean;
}

/** Colours of the message: token set of the message mode, spacing and corners of the inverted card. */
export interface ReadTheme {
  m: string;
  r: string;
  scheme: 'light' | 'dark';
  accsoft: string;
  deep: string;
  surface: string;
  surface2: string;
  sunken: string;
  bd: string;
  bdhi: string;
  fg: string;
  mfg: string;
  dim: string;
  ink: string;
  inkfg: string;
  hov: string;
  sh1: string;
  danger: string;
}

/** Colours of the app for the "truncated" notice, also with an inverted message theme. */
export const UI_VARS = [
  'surface',
  'surface2',
  'sunken',
  'fg',
  'mfg',
  'sh1',
] as const satisfies readonly (keyof ReadTheme)[];

export type ReadUi = Pick<ReadTheme, (typeof UI_VARS)[number]>;

/** Values of the reading view: header, conversation, toolbar popovers and the closed reply bar. */
export interface ReadValues {
  id: string;
  subj: string;
  tags: { label: string; bg: string; ink: string }[];
  hasTags: boolean;
  folder: string;
  pos: string;
  hasPos: boolean;
  prevOp: number;
  nextOp: number;
  prevCur: 'pointer' | 'default';
  nextCur: 'pointer' | 'default';
  n: number;
  hasN: boolean;
  nLabel: string;
  multi: boolean;
  acctBg: string;
  acctMail: string;
  starIcon: 'ti-star-filled' | 'ti-star';
  starC: string;
  starTip: string;
  starOn: 'true' | 'false';
  isTrash: boolean;
  notTrash: boolean;
  /**
   * The shown email is in Scheduled: in the Scheduled view and, per its
   * mailbox, also in tag views. Then "Send now" and "Cancel send" replace
   * "Mark as unread"; delete cancels the sending.
   */
  sched: boolean;
  /** "Mark as unread": not in the trash and not in Scheduled. */
  canUnread: boolean;
  /** Mobile: spacing in place of the reply buttons if there are neither them nor the pill. */
  noReplyGap: boolean;
  /** Mobile: "Cancel send" as a pill with text in place of the reply buttons. */
  schedPill: boolean;
  /**
   * Mobile: "Cancel send" as a round button next to the reply buttons. It is
   * never true in practice, because an email from Scheduled has no reply bar
   * even in tag views (`canReply`).
   */
  schedIcon: boolean;
  delTip: string;
  delIcon: 'ti-trash-x' | 'ti-trash';
  canReply: boolean;
  noReply: boolean;
  hasChip: boolean;
  chip: string;
  chipIcon: 'ti-pencil' | 'ti-clock';
  chipText: string;
  msgs: ReadMessage[];
  /** Recipients, quote and references of a reply; the bar computes `replyValues()`. */
  reply: ReplyContext;
  tv: ReadTheme;
  ui: ReadUi;
  canTag: boolean;
  tg: ReadMenuButton;
  tgOpts: ReadTagOption[];
  /** "Move": not for an email in drafts or Scheduled (per its mailbox, also in tag views). */
  canMove: boolean;
  mv: ReadMenuButton;
  mvOpts: ReadMoveOption[];
  /** "Report spam": not in the trash and not for an email in sent, drafts or Scheduled (per its mailbox). */
  canSpam: boolean;
  spamIcon: 'ti-shield-check' | 'ti-alert-octagon';
  spamTip: string;
  thIcon: 'ti-sun' | 'ti-moon';
  thTip: string;
  thOn: 'true' | 'false';
  thBg: string;
  thC: string;
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase();

/** Icon of an attachment by extension, without an extension by content type. */
export function fileIcon(name: string, type = ''): IconName {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf' || (!ext && type === 'application/pdf')) return 'ti-file-type-pdf';
  if (/^docx?$/.test(ext)) return 'ti-file-type-doc';
  if (/^(xlsx?|csv)$/.test(ext) || (!ext && type === 'text/csv')) return 'ti-file-spreadsheet';
  if (/^(jpe?g|png|gif|webp)$/.test(ext) || (!ext && type.startsWith('image/'))) return 'ti-photo';
  if (/^(log|txt)$/.test(ext) || (!ext && type === 'text/plain')) return 'ti-file-text';
  return 'ti-file';
}

/** Extension in upper case, "FILE" without an extension. */
export function fileExt(name: string): string {
  return (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? m.read_file()).toUpperCase();
}

const KB = 1024;
const MB = KB * 1024;

/** Number with the decimal separator of the language. */
const decimal = (n: number, options: Intl.NumberFormatOptions) => n.toLocaleString(intlLocale(), options);

/** Size: up to 1 MB whole KB ("121 KB"), above MB with one decimal ("1.2 MB"; decimal separator per locale). */
export function fileSize(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  return `${decimal(bytes / MB, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/**
 * Limit for attachments in the units of `fileSize`, rounded down to one
 * decimal and without a trailing ".0", so that "larger than" is right
 * ("25 MB", "47.6 MB", "878 KB"); below 1 KB in bytes.
 */
export function limitText(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.floor(bytes / KB)} KB`;
  return `${decimal(Math.floor((bytes * 10) / MB) / 10, { maximumFractionDigits: 1 })} MB`;
}

/** Size of a truncated part: MB, rounded up to one decimal ("4.5 MB"). */
export function truncSize(bytes: number): string {
  return `${decimal(Math.ceil((bytes * 10) / MB) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** "Truncated" notice of an expanded email; `null` if nothing is missing. */
function truncView(e: MessageEmail, open: boolean, loading: ReadonlySet<string>): ReadTruncation | null {
  const cut = open ? truncationOf(e) : null;
  if (!cut) return null;
  const busy = loading.has(e.id);
  const size = truncSize(cut.size);
  return {
    part: cut.part,
    size,
    text: m.read_trunc({ size }),
    busy,
    busyAttr: busy ? 'true' : 'false',
    label: busy ? m.read_trunc_busy() : m.read_trunc_load(),
    cur: busy ? 'progress' : 'pointer',
  };
}

export function attachmentsText(n: number): string {
  return n === 1 ? m.read_attachments_one() : m.read_attachments({ n });
}

/** Name, otherwise address; "me" for an own address. */
function namesOf(list: readonly EmailAddress[], own: string): string {
  return list.map((a) => (lower(a.email) === own ? m.read_me() : senderText(a))).join(', ');
}

/** Token set of the message: mode of the app, with `inverted` the other one. */
export function readTheme(dark: boolean, inverted: boolean): ReadTheme {
  const mode = dark !== inverted ? 'dark' : 'light';
  const pm = MODES[mode];
  const accent = derivedAccentVars(mode);
  return {
    m: inverted ? '0 10px 10px' : '0',
    r: inverted ? '24px' : '0',
    scheme: mode,
    accsoft: accent['--accsoft']!,
    deep: accent['--deep']!,
    surface: pm['--surface'],
    surface2: pm['--surface2'],
    sunken: pm['--sunken'],
    bd: pm['--bd'],
    bdhi: pm['--bdhi'],
    fg: pm['--fg'],
    mfg: pm['--mfg'],
    dim: pm['--dim'],
    ink: pm['--ink'],
    inkfg: pm['--inkfg'],
    hov: pm['--hov'],
    sh1: pm['--sh1'],
    danger: pm['--danger'],
  };
}

/** First paragraph that does not end in a comma like a salutation, otherwise the server's preview. */
function snipOf(paras: readonly string[], preview: string): string {
  const p = paras.find((x) => !/,$/.test(x.trim())) ?? paras[0] ?? preview;
  return p.replace(/\s+/g, ' ').trim();
}

/** Padding of the document inside the message card (desktop, mobile). */
const HTML_PAD = { desktop: '22px 24px 24px', mobile: '18px 16px' };

// Last rendering per email: do not sanitize again on every clock tick, every expand and collapse.
const renderCache = new WeakMap<object, { key: string; cids: ReadonlyMap<string, string>; out: RenderedMail }>();

const NO_IMAGES: ReadonlyMap<string, string> = new Map();

function htmlView(e: MessageEmail, open: boolean, input: ReadInput, theme: ReadTheme): ReadHtml | null {
  const html = htmlOf(e);
  if (html === null) return null;
  const sender = senderKey(e.from[0]?.email);
  const remote = loadsRemote(input.ext, sender, input.once.has(e.id));
  // Images in the text appear as soon as they are loaded (the iframe then reloads once).
  const cids = input.images[e.id] ?? NO_IMAGES;
  let out: RenderedMail | null = null;
  if (open && input.render) {
    const padding = input.isMobile ? HTML_PAD.mobile : HTML_PAD.desktop;
    const key = JSON.stringify([remote, padding, theme]);
    const cached = renderCache.get(e);
    if (cached && cached.key === key && cached.cids === cids) out = cached.out;
    else {
      out = input.render(html, { remote, cids, theme, padding, blockedLabel: m.read_img_blocked() });
      renderCache.set(e, { key, cids, out });
    }
  }
  return { doc: out?.html ?? null, sender, ...remoteBanner(input.ext, out?.blocked ?? 0, sender) };
}

/**
 * Attachments of the email: `attachments` without the images the text shows
 * (they are still loading or loaded; failed ones stay for downloading), plus
 * images and other parts from the body that are not in `attachments`
 * (mixed emails, RFC 8621, 4.1.4), unless the text shows them.
 */
function attachmentParts(
  e: MessageEmail,
  html: boolean,
  images: ReadonlyMap<string, string> | undefined,
): MessagePart[] {
  const refs = html ? inlineCids(e) : new Set<string>();
  const shown = (key: string, p: MessagePart) => refs.has(key) && isInlineImage(p.type) && (!images || images.has(key));
  const listed = e.attachments.filter((p) => p.blobId && !(p.cid && shown(cidKey(p.cid), p)));
  const known = new Set(e.attachments.map((p) => p.partId));
  const body = (html ? e.htmlBody : e.textBody).filter(
    (p) =>
      p.blobId && !p.type.startsWith('text/') && !known.has(p.partId) && !(p.partId && shown(partKey(p.partId), p)),
  );
  return [...listed, ...body];
}

/** Button of a header popover: highlighted when open. */
function menuButton(open: boolean): ReadMenuButton {
  return open
    ? { open, exp: 'true', bg: 'var(--accsoft)', c: 'var(--deep)' }
    : { open, exp: 'false', bg: 'transparent', c: 'var(--mfg)' };
}

/** Tags for "Add tag" in the order of the tag list; `on` are the set ones. */
export function tagOptions(tree: readonly TagNode[], on: ReadonlySet<string>): ReadTagOption[] {
  const out: ReadTagOption[] = [];
  const walk = (nodes: readonly TagNode[], depth: number) => {
    for (const n of nodes) {
      const set = on.has(n.id);
      out.push({
        id: n.id,
        label: n.name,
        dot: tagColors(n.color).bg,
        pl: `${12 + depth * 16}px`,
        on: set ? 'true' : 'false',
        ckBg: set ? 'var(--ink)' : 'transparent',
        ckRing: set ? 'none' : 'inset 0 0 0 2px var(--bdhi)',
        ckOp: set ? 1 : 0,
      });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/**
 * Targets for "Move": the inbox, then the folder tree with a divider before
 * it. Indentation: reading view popover 12 + 16 px per level, move sheet
 * 14 + 18 px.
 */
export function moveOptions(targets: MoveTargets, indent: { base: number; step: number }): ReadMoveOption[] {
  const out: ReadMoveOption[] = [];
  const add = (id: string, label: string, icon: ReadMoveOption['icon'], depth: number, sep: boolean) => {
    const on = targets.on(id);
    out.push({
      id,
      label,
      icon,
      sep,
      pl: `${indent.base + depth * indent.step}px`,
      dis: on ? 'true' : 'false',
      ckOp: on ? 1 : 0,
      color: on ? 'var(--mfg)' : 'var(--fg)',
      cursor: on ? 'default' : 'pointer',
    });
  };
  if (targets.inbox) add(targets.inbox, m.mailbox_inbox(), 'ti-inbox', 0, false);
  const walk = (nodes: readonly FolderNode[], depth: number) =>
    nodes.forEach((f, i) => {
      // Divider only below the inbox, not directly below the title.
      add(f.id, f.name, 'ti-folder', depth, depth === 0 && i === 0 && out.length > 0);
      walk(f.children, depth + 1);
    });
  walk(targets.folders, 0);
  return out;
}

/** Move sheet for the conversation with the subject `subject`. */
export function moveValues(subject: string, targets: MoveTargets, hasBack: boolean): MoveValues {
  return {
    sub: subject.trim() || m.list_no_subject(),
    opts: moveOptions(targets, { base: 14, step: 18 }),
    hasBack,
    noBack: !hasBack,
  };
}

/**
 * Shown emails of the conversation (`seq`): those of the thread without trash
 * and spam (except in these mailboxes themselves) and always the
 * representing one; plus the one the reading view stands for (`rm`). `emails` must not be empty.
 */
export function shownEmails(input: Pick<ReadInput, 'emails' | 'repId' | 'kind' | 'roles'>): {
  seq: MessageEmail[];
  rm: MessageEmail;
} {
  const { kind, roles } = input;
  const role = 'role' in kind ? kind.role : null;
  const hidden = new Set(
    role === 'trash' || role === 'spam' ? [] : [roles.trash, roles.spam].filter((b): b is string => !!b),
  );
  const shown = input.emails.filter((e) => e.id === input.repId || !e.mailboxIds.some((b) => hidden.has(b)));
  const seq = shown.length ? shown : [...input.emails];
  return { seq, rm: seq.find((e) => e.id === input.repId) ?? seq[seq.length - 1]! };
}

/**
 * Values of the reading view over the shown emails (`shownEmails`). Own
 * emails (in sent, drafts, scheduled or with the account's address as the
 * sender) show the own name and the recipients.
 */
export function readValues(input: ReadInput): ReadValues {
  const { kind, roles, time } = input;
  const role = 'role' in kind ? kind.role : null;
  const isTrash = role === 'trash';
  const inSpam = role === 'spam';
  const drafts = role === 'drafts';
  const scheduled = role === 'scheduled';
  const own = lower(input.account?.email);
  const { seq, rm } = shownEmails(input);
  const shownAt = (e: MessageEmail) => input.sendAt?.(e.id, e.mailboxIds) ?? e.receivedAt;
  const outBoxes = new Set([roles.sent, roles.drafts, roles.scheduled].filter((b): b is string => !!b));
  const isMine = (e: MessageEmail) =>
    e.mailboxIds.some((b) => outBoxes.has(b)) || (!!own && lower(e.from[0]?.email) === own);
  const last = seq.length - 1;
  const tv = readTheme(input.dark, input.inverted);
  const app = readTheme(input.dark, false);
  const ui = Object.fromEntries(UI_VARS.map((k) => [k, app[k]])) as ReadUi;
  const attState = input.offline
    ? ({
        op: 0.5,
        dis: 'true',
        cur: 'default',
        tip: m.read_att_off_tip(),
        dlIcon: 'ti-cloud-off',
      } as const)
    : ({ op: 1, dis: 'false', cur: 'pointer', tip: m.read_download(), dlIcon: 'ti-download' } as const);
  // The generic text also for a locked server: only a sign-in is something you can redo yourself.
  const missText =
    input.account?.state === 'needs_reauth' ? m.read_miss_auth({ email: input.account.email }) : m.read_miss_text();

  const msgs = seq.map((e, i): ReadMessage => {
    const me = isMine(e);
    const isLast = i === last;
    const canFold = seq.length > 1 && !isLast;
    const key = e.id;
    const open = canFold && key in input.folds ? input.folds[key]! : isLast || key === rm.id;
    const sender = e.from[0];
    const meName = sender?.name?.trim() || m.read_me();
    const person = nameOf(sender);
    const [avBg, avInk] = me
      ? ['var(--acc)', 'var(--accink)']
      : person
        ? avatarOf(person)
        : ['var(--sunken)', 'var(--mfg)'];
    const recipients = namesOf(e.to, own);
    const miss = !!e.miss;
    const paras = paragraphsOf(e);
    const hb = miss ? null : htmlView(e, open, input, tv);
    const tr = miss ? null : truncView(e, open, input.loadingFull);
    const atts = attachmentParts(e, !!hb, input.images[e.id]).map((p, j): ReadAttachment => {
      const name = p.name?.trim() || m.read_file();
      return {
        key: p.partId ?? `${p.blobId}/${j}`,
        name,
        icon: fileIcon(name, p.type),
        size: fileSize(p.size),
        ext: fileExt(name),
        part: p,
        ...attState,
      };
    });
    return {
      key,
      me,
      notMe: !me,
      who: me ? meName : senderText(sender),
      whoShort: me ? m.read_you() : senderText(sender),
      // Own emails with their sender address (alias), without `From` the account's.
      email: sender?.email ?? (me ? (input.account?.email ?? '') : ''),
      letter: me ? initials(meName) || initials(m.read_me()) : initials(person),
      avBg,
      avInk,
      toText: m.read_to({ names: me ? recipients || m.list_no_recipient() : recipients || m.read_me() }),
      toTip: e.to.length ? e.to.map((a) => a.email).join(', ') : me ? '' : (input.account?.email ?? ''),
      hasCc: e.cc.length > 0,
      ccText: m.read_cc({ names: namesOf(e.cc, own) }),
      time: readTime(shownAt(e), time),
      timeFull: fullTime(shownAt(e), time),
      paras: paras.map((t) => ({ t })),
      snip: snipOf(paras, e.preview),
      atts,
      hasAtts: atts.length > 0,
      attN: attachmentsText(atts.length),
      open,
      closed: !open,
      canFold,
      cur: canFold ? 'pointer' : 'default',
      isLast,
      notLast: !isLast,
      oBox: isLast ? 'none' : 'inset 0 0 0 1.5px var(--bd)',
      oPad: isLast ? (seq.length > 1 ? '22px 0 0' : '0') : '20px 22px 22px',
      isHtml: !!hb,
      notHtml: !hb && !miss,
      hb,
      trunc: !!tr,
      tr,
      miss,
      missText,
    };
  });

  const boxes = [...new Set(seq.flatMap((e) => e.mailboxIds))];
  const shownTags = boxes.flatMap((b) => input.tagOf(b) ?? []);
  const tagged = new Set([...shownTags.map((x) => x.id), ...input.tagPending]);
  const tags = shownTags.sort(byTagRank).map((x) => ({ label: x.name, ...tagColors(x.color) }));
  const flagged = seq.some((e) => !!e.keywords['$flagged']);
  // Also per the mailbox of the email (e.g. a scheduled message in a tag view).
  const rmIn = (box: string | null) => !!box && rm.mailboxIds.includes(box);
  const sched = scheduled || rmIn(roles.scheduled);
  const draft = drafts || rmIn(roles.drafts);
  const outbox = isOutbox(kind) || draft || sched || rmIn(roles.sent);
  const canReply = !(draft || sched || isTrash);
  // "Reply all" if there is someone besides the sender and the own account; for own
  // emails the reply goes to the recipients, so "all" only from two (`replyContext`).
  const shown = msgs.find((x) => x.key === rm.id);
  const reply = replyContext(rm, {
    mine: isMine(rm),
    own,
    who: shown?.who ?? senderText(rm.from[0]),
    time,
    attachments: shown?.atts.map((a) => a.part) ?? [],
  });
  const { nav } = input;
  const subject = rm.subject.trim();
  const mDark = input.dark !== input.inverted;
  const inv = input.inverted;
  return {
    id: rm.id,
    subj: subject || m.list_no_subject(),
    tags,
    hasTags: tags.length > 0,
    folder: input.title,
    pos: nav ? m.read_pos({ n: nav.index + 1, total: nav.total }) : '',
    hasPos: !!nav,
    prevOp: nav?.hasPrev ? 1 : 0.35,
    nextOp: nav?.hasNext ? 1 : 0.35,
    prevCur: nav?.hasPrev ? 'pointer' : 'default',
    nextCur: nav?.hasNext ? 'pointer' : 'default',
    n: seq.length,
    hasN: seq.length > 1,
    nLabel: messagesText(seq.length),
    multi: input.multi,
    acctBg: input.account ? (MA_COLORS[input.account.color]?.[1] ?? MA_COLORS[0][1]) : 'var(--mfg)',
    acctMail: input.account?.email ?? '',
    starIcon: flagged ? 'ti-star-filled' : 'ti-star',
    starC: flagged ? '#e3a93a' : 'var(--mfg)',
    starTip: flagged ? m.list_unstar() : m.list_star(),
    starOn: flagged ? 'true' : 'false',
    isTrash,
    notTrash: !isTrash,
    sched,
    canUnread: !isTrash && !sched,
    noReplyGap: !canReply && !sched,
    schedPill: sched && !canReply,
    schedIcon: sched && canReply,
    delTip: isTrash ? m.list_purge() : m.list_delete(),
    delIcon: isTrash ? 'ti-trash-x' : 'ti-trash',
    canReply,
    noReply: !canReply,
    hasChip: drafts || scheduled,
    chip: drafts ? m.list_chip_draft() : m.list_chip_scheduled(),
    chipIcon: drafts ? 'ti-pencil' : 'ti-clock',
    chipText: (drafts ? m.read_draft_edited : m.read_sends_at)({ time: readTime(shownAt(rm), time) }),
    msgs,
    reply,
    tv,
    ui,
    canTag: !isTrash,
    tg: menuButton(input.menu === 'tag'),
    tgOpts: tagOptions(input.tagTree, tagged),
    canMove: !draft && !sched,
    mv: menuButton(input.menu === 'move'),
    mvOpts: moveOptions(input.move, { base: 12, step: 16 }),
    canSpam: !outbox && !isTrash,
    spamIcon: inSpam ? 'ti-shield-check' : 'ti-alert-octagon',
    spamTip: inSpam ? m.read_not_spam() : m.read_spam(),
    thIcon: mDark ? 'ti-sun' : 'ti-moon',
    thTip: mDark ? m.read_theme_light() : m.read_theme_dark(),
    thOn: inv ? 'true' : 'false',
    thBg: inv ? 'var(--accsoft)' : 'transparent',
    thC: inv ? 'var(--deep)' : 'var(--mfg)',
  };
}

/**
 * Source of the email: a dialog on desktop, in the sheet on mobile. While it is loading, header and body are empty
 * (`busy`); copy and download then wait for it.
 */
export interface SourceValues {
  /** Subject as in the reading view, without a subject "(No subject)". */
  sub: string;
  head: SourceHeader[];
  body: string;
  busy: boolean;
  close: () => void;
  /** Click on the backdrop (desktop) closes. */
  overlay: (event: OverlayEvent) => void;
  copy: () => void;
  download: () => void;
}

/** Values of the source from header and body (`null` while it is loading) and the page's actions. */
export function sourceValues(
  parts: SourceParts | null,
  sub: string,
  actions: Pick<SourceValues, 'close' | 'copy' | 'download'>,
): SourceValues {
  return {
    sub,
    head: parts?.head ?? [],
    body: parts?.body ?? '',
    busy: !parts,
    overlay: overlayClose(actions.close),
    ...actions,
  };
}
