/**
 * Reply and forward: recipients, subject, quote and references of a reply to
 * the email of the reading view, the values of the reply bar and the quote in
 * the draft text. `replyInit()` in `compose` builds the prefill for compose.
 */
import type { EmailAddress } from '@roedy/jmap';
import { isEmail } from '#lib/email.ts';
import type { IconName } from '#lib/icons.ts';
import { fullTime, nameOf, type TimeContext } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { paragraphsOf, type MessageEmail, type MessagePart } from '#lib/state/message.svelte.ts';

/** Kind of reply. */
export type ReplyMode = 'reply' | 'all' | 'fwd';

/** Quote of the original: header "On … wrote:" and paragraphs. */
export interface Quote {
  head: string;
  paras: string[];
}

/**
 * Inputs of the open reply bar. They apply to the opened
 * conversation, not to one email: if a new one arrives while typing, the
 * text stays and the reply goes to the new one.
 */
export interface ReplyState {
  mode: ReplyMode;
  text: string;
  /** Recipient when forwarding. */
  to: string;
}

/** What a reply needs from the conversation. */
export interface ReplyContext {
  /** Email being replied to. */
  id: string;
  /** Reply: reply-to address or sender, for own emails the first recipient. */
  to: EmailAddress[];
  /** Reply all: To and Cc without the own account. */
  allTo: EmailAddress[];
  allCc: EmailAddress[];
  hasAll: boolean;
  /** Subject without reply or forward prefixes ("Re:", "AW:", "Wg:", "Fwd:") in front. */
  base: string;
  quote: Quote;
  /** `In-Reply-To` and `References` of the reply (RFC 5322, 3.6.4); none when forwarding. */
  inReplyTo: string[] | null;
  references: string[] | null;
  /** Attachments as the reading view shows them; when forwarding as blobs in the same account. */
  attachments: MessagePart[];
}

/** Prefixes that a new subject replaces, including the ones German mail clients add. */
const PREFIXES = /^((Re|AW|Wg|Fwd):\s*)+/i;

const lower = (a: EmailAddress) => a.email.toLowerCase();

/** Without duplicate addresses and without those in `skip`. */
function unique(list: readonly EmailAddress[], skip: ReadonlySet<string>): EmailAddress[] {
  const seen = new Set(skip);
  return list.filter((a) => {
    const k = lower(a);
    if (!a.email || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Reply to `rm`. Foreign emails go to their reply-to address (`Reply-To`)
 * or the sender, "Reply all" also to To and Cc; own emails go to their
 * recipients, "Reply" then only to the first (like `hasAll`: "all"
 * only from two). The own account is dropped in each case.
 */
export function replyContext(
  rm: MessageEmail,
  opts: {
    mine: boolean;
    /** Address of the account. */
    own: string;
    /** Name in the quote header. */
    who: string;
    time: TimeContext;
    /** Shown attachments of the email (without embedded images of an HTML email). */
    attachments: readonly MessagePart[];
  },
): ReplyContext {
  const own = new Set(opts.own ? [opts.own.toLowerCase()] : []);
  let to: EmailAddress[];
  let allTo: EmailAddress[];
  let allCc: EmailAddress[];
  if (opts.mine) {
    const recipients = unique([...rm.to, ...rm.cc], own);
    to = recipients.slice(0, 1);
    allTo = unique(rm.to, own);
    if (!allTo.length) allTo = to;
    allCc = unique(rm.cc, new Set([...own, ...allTo.map(lower)]));
  } else {
    to = unique(rm.replyTo.length ? rm.replyTo : rm.from.slice(0, 1), new Set());
    allTo = to;
    allCc = unique([...rm.to, ...rm.cc], new Set([...own, ...to.map(lower), ...rm.from.map(lower)]));
  }
  const ids = rm.messageId;
  const refs = [...(rm.references.length ? rm.references : rm.inReplyTo), ...ids].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return {
    id: rm.id,
    to,
    allTo,
    allCc,
    hasAll: allTo.length + allCc.length > to.length,
    base: rm.subject.trim().replace(PREFIXES, ''),
    quote: {
      head: m.compose_quote_head({ date: fullTime(rm.receivedAt, opts.time), name: opts.who }),
      paras: paragraphsOf(rm),
    },
    inReplyTo: ids.length ? [...ids] : null,
    references: refs.length ? refs : null,
    attachments: [...opts.attachments],
  };
}

/** Subject of the reply or forward: "Re: …", "Fwd: …". */
export function replySubject(base: string, mode: ReplyMode): string {
  const prefix = mode === 'fwd' ? m.compose_prefix_fwd() : m.compose_prefix_re();
  return base ? `${prefix} ${base}` : prefix;
}

/** Recipients of a reply in the chosen kind. */
export function replyRecipients(
  ctx: ReplyContext,
  mode: Exclude<ReplyMode, 'fwd'>,
): {
  to: EmailAddress[];
  cc: EmailAddress[];
} {
  return mode === 'all' ? { to: ctx.allTo, cc: ctx.allCc } : { to: ctx.to, cc: [] };
}

/** Kind of reply in the switcher. */
export interface ReplyModeOption {
  id: ReplyMode;
  label: string;
  /** Mobile ("All"). */
  short: string;
  icon: IconName;
  on: 'true' | 'false';
  bg: string;
  color: string;
  sh: string;
}

/** Reply bar of the reading view. */
export interface ReplyValues {
  open: boolean;
  closed: boolean;
  hasAll: boolean;
  mode: ReplyMode;
  isFwd: boolean;
  notFwd: boolean;
  text: string;
  to: string;
  /** "To: Anna Baker, Jonas Weber". */
  toLabel: string;
  ph: string;
  /** Sending possible: reply with text, forward with a valid address. */
  can: boolean;
  sendBg: string;
  sendInk: string;
  sendCur: 'pointer' | 'default';
  /**
   * Without a connection: "Send" is disabled
   * (`aria-disabled`); click and ‹mod› + Enter show
   * `sendTip` as an error toast, the text stays in the bar.
   */
  sendOff: boolean;
  /** Opacity: disabled with text 0.5; empty keeps the dimmed look. */
  sendOp: number;
  /** Tooltip (desktop only, only without a connection); otherwise empty. */
  sendTip: string;
  modes: ReplyModeOption[];
  /** "‹mod› + Enter to send" (desktop). */
  hint: string;
}

/** Values of the bar; closed without `state`, `off` without a connection. */
export function replyValues(ctx: ReplyContext, state: ReplyState | null, mod: string, off = false): ReplyValues {
  const r = state;
  const mode = r?.mode ?? 'reply';
  const fwd = mode === 'fwd';
  const all = mode === 'all';
  const names = [...ctx.to, ...(all ? [...ctx.allTo.filter((a) => !ctx.to.includes(a)), ...ctx.allCc] : [])]
    .map(nameOf)
    .filter(Boolean);
  // First name of the recipient; without a name "recipient".
  const first = ctx.to[0]?.name?.trim().split(/\s+/)[0] ?? '';
  const can = !!r && (fwd ? isEmail(r.to.trim()) : !!r.text.trim());
  const modes: [ReplyMode, string, string, IconName][] = [
    ['reply', m.read_reply(), m.read_reply(), 'ti-arrow-back-up'],
    ['fwd', m.read_forward(), m.read_forward(), 'ti-arrow-forward-up'],
  ];
  if (ctx.hasAll) modes.splice(1, 0, ['all', m.read_reply_all(), m.read_reply_all_short(), 'ti-arrow-back-up-double']);
  return {
    open: !!r,
    closed: !r,
    hasAll: ctx.hasAll,
    mode,
    isFwd: fwd,
    notFwd: !fwd,
    text: r?.text ?? '',
    to: r?.to ?? '',
    toLabel: fwd ? m.read_forward() : m.read_to({ names: names.join(', ') || m.list_no_recipient() }),
    ph: fwd ? m.compose_fwd_ph() : m.read_reply_ph({ name: first || m.read_reply_someone() }),
    can,
    sendBg: can ? 'var(--ink)' : 'var(--sunken)',
    sendInk: can ? 'var(--inkfg)' : 'var(--dim)',
    sendCur: can && !off ? 'pointer' : 'default',
    sendOff: off,
    sendOp: off && can ? 0.5 : 1,
    sendTip: off ? m.offline_reply() : '',
    modes: modes.map(([id, label, short, icon]) => {
      const on = id === mode;
      return {
        id,
        label,
        short,
        icon,
        on: on ? 'true' : 'false',
        bg: on ? 'var(--surface)' : 'transparent',
        color: on ? 'var(--fg)' : 'var(--mfg)',
        sh: on ? 'var(--sh1)' : 'none',
      };
    }),
    hint: m.compose_send_hint({ mod }),
  };
}

/** Quoted line: "> " in front, already quoted lines only ">", empty lines ">" (RFC 3676, 4.5). */
const quoteLine = (line: string) => (!line ? '>' : line.startsWith('>') ? `>${line}` : `> ${line}`);

/** Quote as text below the reply and signature. */
export function quoteText(q: Quote): string {
  // Without paragraphs (original without text) an empty quoted line, so that `splitQuote()` finds the quote again.
  const body = q.paras.map((p) => p.split('\n').map(quoteLine).join('\n')).join('\n>\n');
  return `${q.head}\n${body || '>'}`;
}

/** Draft text with the quote at the end. */
export function withQuote(body: string, q: Quote | null): string {
  if (!q) return body;
  return body ? `${body}\n\n${quoteText(q)}` : quoteText(q);
}

/**
 * Counterpart of `withQuote()` for an opened draft: if the text ends with a
 * line ending in ":" followed only by quoted lines, that is the quote.
 */
export function splitQuote(body: string): { text: string; quote: Quote | null } {
  const lines = body.trimEnd().split('\n');
  let i = lines.length;
  while (i > 0 && lines[i - 1]!.startsWith('>')) i--;
  const head = lines[i - 1];
  if (i === lines.length || !head?.trimEnd().endsWith(':') || (i > 1 && lines[i - 2]!.trim())) {
    return { text: body, quote: null };
  }
  const plain = lines.slice(i).map((l) => l.replace(/^> ?/, ''));
  const paras = plain
    .join('\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim());
  return { text: lines.slice(0, Math.max(0, i - 2)).join('\n'), quote: { head: head.trimEnd(), paras } };
}

/** Actions of the reply bar; the route binds them to its state and `compose`. */
export interface ReplyActions {
  /** Reply, reply all, forward. */
  open: (mode: ReplyMode) => void;
  /** Kind in the switcher. */
  mode: (mode: ReplyMode) => void;
  text: (value: string) => void;
  /** Address when forwarding. */
  to: (value: string) => void;
  /** Send (‹mod› + Enter); no effect while `can` is false. */
  send: () => void;
  /** Discard. */
  cancel: () => void;
  /** Open in the editor. */
  expand: () => void;
  /** Add attachment: compose with the chosen files. */
  files: (files: readonly File[]) => void;
}
