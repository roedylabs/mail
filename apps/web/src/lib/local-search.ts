/**
 * Search without a connection: evaluates the filter of the query over the stored
 * emails, the rows of the lists and the details of the conversations. Text is
 * only in subject, sender and preview; the page points that out (`srOffText`).
 */
import type { EmailAddress, EmailFilter, Filter, Id } from '@roedy/jmap';
import type { ListThread } from '#lib/mail-list.ts';
import type { MailStore, SavedMail } from '#lib/mail-store.ts';
import { escapeHtml } from '#lib/mail/parts.ts';
import { norm, type MailHit } from '#lib/search.ts';

/** Hits per account; the page does not show more at once either. */
export const MAX_LOCAL_HITS = 200;

/** Stored email of a thread. */
export type LocalMail = SavedMail & { threadId: Id };

const addresses = (list: readonly EmailAddress[]): string =>
  norm(list.map((a) => `${a.name ?? ''} ${a.email ?? ''}`).join(' '));

/** A word in subject, sender or preview, like `text` on the server, only without the mail body. */
function inText(mail: LocalMail, word: string): boolean {
  return [mail.subject, mail.preview].some((t) => norm(t).includes(word)) || addresses(mail.from).includes(word);
}

/** Condition met; what the app does not ask counts as met. */
function condition(mail: LocalMail, f: EmailFilter): boolean {
  if (f.text !== undefined && !inText(mail, norm(f.text))) return false;
  // The store does not know the full text, the preview is its beginning.
  if (f.body !== undefined && !norm(mail.preview).includes(norm(f.body))) return false;
  if (f.subject !== undefined && !norm(mail.subject).includes(norm(f.subject))) return false;
  if (f.from !== undefined && !addresses(mail.from).includes(norm(f.from))) return false;
  if (f.inMailbox !== undefined && !mail.mailboxIds.includes(f.inMailbox)) return false;
  if (f.hasAttachment !== undefined && mail.hasAttachment !== f.hasAttachment) return false;
  if (f.hasKeyword !== undefined && !mail.keywords[f.hasKeyword]) return false;
  if (f.notKeyword !== undefined && mail.keywords[f.notKeyword]) return false;
  if (f.after !== undefined && mail.receivedAt < Date.parse(f.after)) return false;
  return true;
}

export function matches(mail: LocalMail, filter: Filter<EmailFilter> | null): boolean {
  if (!filter) return true;
  if (!('operator' in filter)) return condition(mail, filter);
  const parts = filter.conditions;
  if (filter.operator === 'AND') return parts.every((f) => matches(mail, f));
  if (filter.operator === 'OR') return parts.some((f) => matches(mail, f));
  return !parts.some((f) => matches(mail, f));
}

/** Subject with `<mark>` like `SearchSnippet/get`, for `markParts()`. */
export function markSubject(subject: string, words: readonly string[]): string | null {
  const wanted = words.map((w) => w.toLowerCase()).filter(Boolean);
  const text = subject.toLowerCase();
  // Lowercasing lengthens single characters (`İ`): then rather without highlighting.
  if (!wanted.length || text.length !== subject.length) return null;
  const marked = new Array<boolean>(subject.length).fill(false);
  for (const word of wanted)
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) marked.fill(true, at, at + word.length);
  if (!marked.includes(true)) return null;
  let out = '';
  for (let start = 0, end = 1; start < subject.length; start = end, end = start + 1) {
    while (end < subject.length && marked[end] === marked[start]) end += 1;
    const piece = escapeHtml(subject.slice(start, end));
    out += marked[start] ? `<mark>${piece}</mark>` : piece;
  }
  return out;
}

function hitOf(mail: LocalMail, account: string, words: readonly string[]): MailHit {
  return {
    account,
    id: mail.id,
    threadId: mail.threadId,
    mailboxIds: Object.fromEntries(mail.mailboxIds.map((id) => [id, true])),
    keywords: mail.keywords,
    receivedAt: new Date(mail.receivedAt).toISOString(),
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    attachments: mail.attachments,
    snippet: markSubject(mail.subject, words),
  };
}

/** Page for `Search`: all hits of the account, newest first, up to `MAX_LOCAL_HITS`. */
export function localPage(
  mails: readonly LocalMail[],
  account: string,
  filter: Filter<EmailFilter> | null,
  words: readonly string[],
) {
  const hits = mails
    .filter((mail) => matches(mail, filter))
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, MAX_LOCAL_HITS)
    .map((mail) => hitOf(mail, account, words));
  return { hits, positions: hits.length, total: hits.length, local: true };
}

/** Row of a list as an email: it only knows the representative email and no file names. */
function mailOfRow(t: ListThread): LocalMail {
  const rep = t.members.find((e) => e.id === t.id);
  return {
    id: t.id,
    threadId: t.threadId,
    receivedAt: t.receivedAt,
    from: t.from,
    to: t.to,
    subject: t.subject,
    preview: t.preview,
    mailboxIds: rep?.mailboxIds ?? t.mailboxIds,
    keywords: rep?.keywords ?? {},
    hasAttachment: t.hasAttachment,
    attachments: [],
  };
}

/** Stored emails of an account; the details of a conversation take precedence over the row. */
export async function savedMails(
  store: Pick<MailStore, 'lists' | 'heads'> | null,
  account: string,
): Promise<LocalMail[]> {
  if (!store) return [];
  const [lists, heads] = await Promise.all([store.lists(account), store.heads(account)]);
  const mails = new Map<Id, LocalMail>();
  for (const list of lists) for (const t of list.threads) mails.set(t.id, mailOfRow(t));
  for (const head of heads)
    for (const mail of head.mails) {
      const row = mails.get(mail.id);
      // Read, flagged and mailbox are kept current by the sync only in the rows.
      const fresh = row && { keywords: row.keywords, mailboxIds: row.mailboxIds };
      mails.set(mail.id, { ...mail, ...fresh, threadId: head.threadId });
    }
  return [...mails.values()];
}
