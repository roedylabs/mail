/**
 * Notifications for new mail: content, click target and quiet hours. Without
 * DOM, so that the service worker and tests use the same rules.
 */
import type { QuietCopy } from '#lib/mail-push-store.ts';
import { m } from '#lib/paraglide/messages.js';
import { inQuiet, minutesOf } from '#lib/quiet-hours.ts';
import { mailboxPath } from '#lib/routes.ts';
import { zoneParts } from '#lib/timezone.ts';

/** Icon of the messages, as with the backend's push. */
const ICON = '/branding/push-icon.png';

/** Limit for `data`; never this many mails in one open notification. */
export const MAX_MAILS = 200;

/** A new mail as the open notification remembers it. */
export interface MailSummary {
  id: string;
  thread: string;
  /** Name, otherwise address; empty without a sender. */
  from: string;
  subject: string;
}

/** Account and device the notification is created for. */
export interface MailContext {
  id: string;
  /** Address of the account from the copy; empty until the app has stored it. */
  email: string;
  /** Several mail accounts connected: the text names the account. */
  multi: boolean;
  /** Quiet hours: without sound and vibration. */
  silent: boolean;
  appName: string;
}

export interface MailNotice {
  title: string;
  options: NotificationOptions & { renotify?: boolean };
}

/** One notification per account: the new one replaces the previous one. */
export function mailTag(accountId: string): string {
  return `mail-${accountId}`;
}

function inboxPath(accountId: string): string {
  return mailboxPath(accountId, { role: 'inbox' });
}

function senders(names: readonly string[]): string {
  const [a = '', b = ''] = names;
  if (names.length === 1) return m.mailpush_from_one({ a });
  if (names.length === 2) return m.mailpush_from_two({ a, b });
  const count = names.length - 2;
  return count === 1 ? m.mailpush_from_three({ a, b }) : m.mailpush_from_more({ a, b, count });
}

/** One mail leads to its conversation, several to the inbox. `mails`: newest first. */
export function mailNotice(mails: readonly MailSummary[], ctx: MailContext): MailNotice {
  const first = mails[0];
  const one = mails.length === 1 && first ? first : null;
  const who = (mail: MailSummary) => mail.from || m.list_no_sender();
  const text = one ? one.subject || m.list_no_subject() : senders([...new Set(mails.map(who))]);
  const url = inboxPath(ctx.id) + (one ? `/${encodeURIComponent(one.thread)}` : '');
  return {
    title: one ? who(one) : m.mailpush_many({ count: mails.length }),
    options: {
      body: ctx.multi ? `${text}\n${ctx.email}` : text,
      icon: ICON,
      tag: mailTag(ctx.id),
      renotify: true,
      silent: ctx.silent,
      data: { url, mails },
    },
  };
}

/** Fetching failed, the browser still requires a visible notification. */
export function blindNotice(ctx: MailContext): MailNotice {
  return {
    title: m.mailpush_one(),
    options: {
      body: ctx.email || ctx.appName,
      icon: ICON,
      tag: mailTag(ctx.id),
      silent: ctx.silent,
      data: { url: inboxPath(ctx.id) },
    },
  };
}

/** Sign-in required: once per account, hence without `renotify`. */
export function authNotice(ctx: MailContext): MailNotice {
  return {
    title: m.mail_accounts_st_auth(),
    options: {
      body: m.mailpush_auth_text({ email: ctx.email || ctx.appName }),
      icon: ICON,
      tag: `mail-auth-${ctx.id}`,
      silent: ctx.silent,
      data: { url: `/account/mail-accounts/${encodeURIComponent(ctx.id)}/connection` },
    },
  };
}

/** Mails of the notification still open; whatever does not come from here does not count. */
export function openMails(data: unknown): MailSummary[] {
  const mails = data && typeof data === 'object' ? (data as { mails?: unknown }).mails : undefined;
  return Array.isArray(mails) ? (mails as MailSummary[]) : [];
}

/** New ones before the open ones, each mail once (a push can come again). */
export function mergeMails(fresh: readonly MailSummary[], open: readonly MailSummary[]): MailSummary[] {
  const known = new Set(fresh.map((mail) => mail.id));
  return [...fresh, ...open.filter((mail) => !known.has(mail.id))].slice(0, MAX_MAILS);
}

/** Is `now` within the quiet hours? Start = end counts as off. */
export function isQuiet(quiet: QuietCopy, now: number): boolean {
  if (!quiet.on || minutesOf(quiet.from) === minutesOf(quiet.to)) return false;
  const { h, mi } = zoneParts(now, quiet.tz);
  return inQuiet(h * 60 + mi, quiet.from, quiet.to);
}

/**
 * WebKit revokes a subscription after a few pushes without a notification,
 * even with the app visible; this applies to all browsers on iPhone and iPad.
 */
export function needsEveryNotice(userAgent: string): boolean {
  return userAgent.includes('AppleWebKit') && !/Chrom(e|ium)\//.test(userAgent);
}
