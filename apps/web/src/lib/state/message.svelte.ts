/**
 * State module `message`: the emails of a
 * thread for the reading view. One request fetches the thread (`Thread/get`) and,
 * via a back-reference, its emails with text and HTML parts
 * (`fetchTextBodyValues`, `fetchHTMLBodyValues`); the browser loads attachments and the source
 * of an email (`MessageSource`) as blobs, as well as
 * embedded images (`cid:`) of the HTML rendering. Plus "Load once"
 * of external content per email and "Load full message"
 * of truncated parts (`loadFull`). Own changes that
 * the server does not show yet (`edits`) lie over the emails.
 * Opened conversations and the top conversations of displayed lists live in the
 * browser's storage: a thread comes from there first, accounts
 * without access (`frozen`) read only from there.
 */
import {
  type EmailAddress,
  type Email,
  type EmailBodyPart,
  type EmailBodyValue,
  type Id,
  type JmapClient,
} from '@roedy/jmap';
import { NetworkError } from '#lib/api.ts';
import { utcDate } from '#lib/search-filter.ts';
import { isOffline } from '#lib/errors.ts';
import type { ListThread } from '#lib/mail-list.ts';
import { decodeSource, sourceParts, type SourceParts } from '#lib/mail-source.ts';
import { fitThread, threadKey, type MailStore } from '#lib/mail-store.ts';
import { cidKey, cidRefs, imagePart, isInlineImage, partKey, textPart } from '#lib/mail/parts.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { edits, stamp } from '#lib/state/edits.svelte.ts';
import type { EmailChange } from '#lib/state/live.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/** At most this many bytes per part (`maxBodyValueBytes`); beyond that the server truncates (`isTruncated`). */
export const MAX_BODY_BYTES = 1 << 20;

/** Opened threads in memory; the oldest drops out. */
const CACHE_SIZE = 20;

/** A list must stand this long (ms) before `prefetch()` runs: whoever scrolls through loads nothing in advance. */
export const PREFETCH_DELAY = 2000;
/** At most this many conversations of a displayed list are fetched by `prefetch()`. */
export const PREFETCH_THREADS = 20;
/** Emails per `prefetch()` request: a thread with very many emails would otherwise exceed `maxObjectsInGet`. */
export const PREFETCH_EMAILS = 100;
/** Emails of the same second that `locate()` searches. */
const LOCATE_LIMIT = 50;
/** Bytes per part when prefetching, tighter than `MAX_BODY_BYTES`: nobody is waiting for these texts. */
export const PREFETCH_BODY_BYTES = 1 << 18;

const EMAIL_PROPS = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'receivedAt',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'messageId',
  'inReplyTo',
  'references',
  'subject',
  'preview',
  'hasAttachment',
  'textBody',
  'htmlBody',
  'attachments',
  'bodyValues',
] satisfies (keyof Email)[];

const BODY_PROPS = [
  'partId',
  'blobId',
  'size',
  'name',
  'type',
  'charset',
  'disposition',
  'cid',
] satisfies (keyof EmailBodyPart)[];

/** Part of an email with the properties from `BODY_PROPS`. */
export type MessagePart = Pick<EmailBodyPart, (typeof BODY_PROPS)[number]>;

/** Email of a thread in the reading view. */
export interface MessageEmail {
  id: Id;
  /** Source of the message. */
  blobId: Id;
  threadId: Id;
  mailboxIds: Id[];
  keywords: Record<string, true>;
  receivedAt: number;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Bcc addresses if known; a draft needs them for the next save without a connection. */
  bcc?: EmailAddress[];
  replyTo: EmailAddress[];
  /** References for replies (`In-Reply-To`, `References`). */
  messageId: string[];
  inReplyTo: string[];
  references: string[];
  subject: string;
  preview: string;
  hasAttachment: boolean;
  textBody: MessagePart[];
  htmlBody: MessagePart[];
  attachments: MessagePart[];
  bodyValues: Record<string, EmailBodyValue>;
  /** Text not in storage: card instead of content (`rd.msgs[].miss`). */
  miss?: true;
}

type Raw = Pick<Email, (typeof EMAIL_PROPS)[number]>;

function emailOf(raw: Raw): MessageEmail {
  return {
    id: raw.id,
    blobId: raw.blobId,
    threadId: raw.threadId,
    mailboxIds: Object.keys(raw.mailboxIds),
    keywords: raw.keywords,
    receivedAt: Date.parse(raw.receivedAt),
    from: raw.from ?? [],
    to: raw.to ?? [],
    cc: raw.cc ?? [],
    bcc: raw.bcc ?? [],
    replyTo: raw.replyTo ?? [],
    messageId: raw.messageId ?? [],
    inReplyTo: raw.inReplyTo ?? [],
    references: raw.references ?? [],
    subject: raw.subject ?? '',
    preview: raw.preview,
    hasAttachment: raw.hasAttachment,
    textBody: raw.textBody,
    htmlBody: raw.htmlBody,
    attachments: raw.attachments,
    bodyValues: raw.bodyValues,
  };
}

/**
 * Text of a part from `textBody`: plain text unchanged, HTML (an email
 * without a plain-text alternative, RFC 8621, 4.1.4) as its text from an inert
 * document (loads nothing, runs nothing) – for the preview of collapsed
 * emails; HTML itself is shown in the iframe (`htmlOf`).
 */
export function partText(part: MessagePart, values: Record<string, EmailBodyValue>): string {
  const value = part.partId ? values[part.partId]?.value : undefined;
  if (value === undefined) return '';
  if (part.type !== 'text/html') return value;
  const doc = new DOMParser().parseFromString(value, 'text/html');
  for (const el of doc.querySelectorAll('script, style, head, template')) el.remove();
  // Whitespace of the source does not count in HTML (except in `pre`): collapse first, then add line breaks.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (!n.parentElement?.closest('pre')) n.nodeValue = (n.nodeValue ?? '').replace(/\s+/g, ' ');
  for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
  for (const el of doc.querySelectorAll('td, th')) el.append(' ');
  for (const el of doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote, table')) el.append('\n\n');
  return (doc.body.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

// Paragraphs per email (immutable): do not split anew on every clock tick, expand and collapse.
const paragraphCache = new WeakMap<object, string[]>();

/** Paragraphs of an email: parts from `textBody`, split at blank lines. */
export function paragraphsOf(email: Pick<MessageEmail, 'textBody' | 'bodyValues'>): string[] {
  let paras = paragraphCache.get(email);
  if (!paras) paragraphCache.set(email, (paras = splitParagraphs(email)));
  return paras;
}

function splitParagraphs(email: Pick<MessageEmail, 'textBody' | 'bodyValues'>): string[] {
  return email.textBody
    .filter((p) => p.type.startsWith('text/'))
    .map((p) => partText(p, email.bodyValues))
    .join('\n\n')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim());
}

// HTML per email (immutable), like the paragraphs.
const htmlCache = new WeakMap<object, { html: string | null; cids: Set<string> }>();

/**
 * HTML of an email from `htmlBody` (RFC 8621, 4.1.4): its HTML parts, plain text
 * in between as a preformatted block, images in between (mixed emails;
 * they are not in `attachments`) via their key (`partKey`) like
 * `cid:` images. `null` if it has no HTML part (then the page shows `textBody`).
 */
export function htmlOf(email: Pick<MessageEmail, 'htmlBody' | 'bodyValues'>): string | null {
  return htmlEntry(email).html;
}

/** Content IDs the HTML refers to (`cidKey`, also `partKey`); these parts are inline images, not attachments. */
export function inlineCids(email: Pick<MessageEmail, 'htmlBody' | 'bodyValues'>): ReadonlySet<string> {
  return htmlEntry(email).cids;
}

function htmlEntry(email: Pick<MessageEmail, 'htmlBody' | 'bodyValues'>): { html: string | null; cids: Set<string> } {
  let entry = htmlCache.get(email);
  if (!entry) {
    const value = (p: MessagePart) => (p.partId ? (email.bodyValues[p.partId]?.value ?? '') : '');
    const html = email.htmlBody.some((p) => p.type === 'text/html')
      ? email.htmlBody
          .map((p) =>
            p.type === 'text/html'
              ? value(p)
              : p.type.startsWith('text/')
                ? textPart(value(p))
                : p.partId && p.blobId && isInlineImage(p.type)
                  ? imagePart(p.partId)
                  : '',
          )
          .join('')
      : null;
    entry = { html, cids: html === null ? new Set() : cidRefs(html) };
    htmlCache.set(email, entry);
  }
  return entry;
}

/**
 * Row of the list as an email without text (`miss`), for a conversation that
 * is not in storage. The row knows only the representative email exactly,
 * the rest of the conversation is missing.
 */
export function listEmail(thread: ListThread): MessageEmail {
  const rep = thread.members.find((e) => e.id === thread.id);
  return {
    id: thread.id,
    blobId: '',
    threadId: thread.threadId,
    mailboxIds: rep?.mailboxIds ?? thread.mailboxIds,
    keywords: rep?.keywords ?? {},
    receivedAt: thread.receivedAt,
    from: thread.from,
    to: thread.to,
    cc: [],
    replyTo: [],
    messageId: [],
    inReplyTo: [],
    references: [],
    subject: thread.subject,
    preview: thread.preview,
    hasAttachment: thread.hasAttachment,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    miss: true,
  };
}

/** Truncated part of the rendering (`rd.msgs[].tr`): which one and how large. */
export interface Truncation {
  part: 'html' | 'text';
  /** Bytes of the truncated parts (`EmailBodyPart.size`). */
  size: number;
}

/**
 * Did the server truncate a part of the rendering (`isTruncated`, RFC 8621,
 * 4.2)? The parts the page shows count: from `htmlBody` if there is
 * HTML (`htmlOf`), otherwise from `textBody` – if both are truncated, there is only
 * one notice. `null` if nothing is missing.
 */
export function truncationOf(email: Pick<MessageEmail, 'textBody' | 'htmlBody' | 'bodyValues'>): Truncation | null {
  const part = htmlOf(email) === null ? 'text' : 'html';
  const cut = (part === 'html' ? email.htmlBody : email.textBody).filter(
    (p) => p.type.startsWith('text/') && p.partId && email.bodyValues[p.partId]?.isTruncated,
  );
  return cut.length ? { part, size: cut.reduce((sum, p) => sum + p.size, 0) } : null;
}

/** Requests to the mail server; replaced in tests. */
export interface MessageApi {
  /** Emails of the thread by `receivedAt`, oldest first; `null` if it does not exist (any more). */
  thread(account: string, threadId: Id): Promise<MessageEmail[] | null>;
  /** Emails of several threads in one request, parts up to `PREFETCH_BODY_BYTES` (`prefetch()`). */
  threads(account: string, threadIds: readonly Id[]): Promise<Map<Id, MessageEmail[]>>;
  /** Thread this email lies in today (merge); `null`: none. */
  locate(account: string, email: Pick<MessageEmail, 'messageId' | 'receivedAt'>): Promise<Id | null>;
  /** Parts of the rendering (`part`) of an email without limit ("Load full message"); `null` if it no longer exists. */
  fullBody(
    account: string,
    emailId: Id,
    part: Truncation['part'],
    signal?: AbortSignal,
  ): Promise<Record<string, EmailBodyValue> | null>;
  /** Blob of a part or of a whole email (download URL of the session, RFC 8620, 6.2). */
  download(account: string, ref: DownloadRef, signal?: AbortSignal): Promise<Blob>;
}

/** What the download needs: blob, file name and content type (`accept`). */
export type DownloadRef = Pick<MessagePart, 'blobId' | 'name' | 'type'>;

export function jmapMessageApi(clientOf: (account: string) => Promise<JmapClient>): MessageApi {
  return {
    async thread(account, threadId) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const b = client.batch();
      const thread = b.call('Thread/get', { accountId, ids: [threadId] });
      const emails = b.call('Email/get', {
        accountId,
        '#ids': thread.ref('/list/*/emailIds'),
        properties: EMAIL_PROPS,
        bodyProperties: BODY_PROPS,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_BYTES,
      });
      const res = await b.send();
      if (!res.get(thread).list.length) return null;
      const list = (res.get(emails).list as Raw[]).map(emailOf);
      return list.length ? list.sort((a, b) => a.receivedAt - b.receivedAt) : null;
    },
    async threads(account, threadIds) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const b = client.batch();
      const thread = b.call('Thread/get', { accountId, ids: [...threadIds] });
      const emails = b.call('Email/get', {
        accountId,
        '#ids': thread.ref('/list/*/emailIds'),
        properties: EMAIL_PROPS,
        bodyProperties: BODY_PROPS,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: PREFETCH_BODY_BYTES,
      });
      const res = await b.send();
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- data, not state
      const byThread = new Map<Id, MessageEmail[]>();
      for (const raw of res.get(emails).list as Raw[]) {
        const email = emailOf(raw);
        byThread.set(email.threadId, [...(byThread.get(email.threadId) ?? []), email]);
      }
      for (const list of byThread.values()) list.sort((a, b) => a.receivedAt - b.receivedAt);
      return byThread;
    },
    async locate(account, { messageId, receivedAt }) {
      const client = await clientOf(account);
      const accountId = await client.accountId();
      const b = client.batch();
      // Stalwart v1.0.2 finds nothing via `header`: the second of arrival, then the Message-ID.
      const second = Math.floor(receivedAt / 1000) * 1000;
      const filter = { after: utcDate(second), before: utcDate(second + 1000) };
      const query = b.call('Email/query', { accountId, filter, limit: LOCATE_LIMIT });
      const emails = b.call('Email/get', {
        accountId,
        '#ids': query.ref('/ids'),
        properties: ['threadId', 'messageId'],
      });
      const res = await b.send();
      const list = res.get(emails).list as Pick<Email, 'threadId' | 'messageId'>[];
      return list.find((e) => e.messageId?.some((id) => messageId.includes(id)))?.threadId ?? null;
    },
    async fullBody(account, emailId, part, signal) {
      const client = await clientOf(account);
      // Without `maxBodyValueBytes` (default 0) the server does not truncate (RFC 8621, 4.2); only the
      // displayed kind, not e.g. the plain-text alternative of an HTML email.
      const res = await client.call(
        'Email/get',
        {
          accountId: await client.accountId(),
          ids: [emailId],
          properties: ['bodyValues'],
          ...(part === 'html' ? { fetchHTMLBodyValues: true } : { fetchTextBodyValues: true }),
        },
        signal,
      );
      return (res.list[0] as Pick<Email, 'bodyValues'> | undefined)?.bodyValues ?? null;
    },
    async download(account, ref, signal) {
      if (!ref.blobId) throw new Error('Part without blobId');
      const client = await clientOf(account);
      return client.download(
        { accountId: await client.accountId(), blobId: ref.blobId, name: ref.name ?? 'download', type: ref.type },
        signal,
      );
    },
  };
}

/** Access to storage; `null` without sign-in or in tests. */
type StoreOf = () => Pick<
  MailStore,
  'thread' | 'saveThread' | 'useThread' | 'dropThread' | 'dropEmails' | 'heads'
> | null;

/** An opened thread: loads on creation, `refresh()` reloads. */
export class Conversation {
  readonly account: string;
  readonly threadId: Id;
  /** Account without access: only storage, never network. */
  readonly frozen: boolean;
  status = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');
  /** `missing`: thread the emails now lie in (merge); `null`: deleted. */
  movedTo = $state<Id | null>(null);
  /** Emails as the server returned them, and the stamp of their load run (`edits`). */
  #emails = $state.raw<MessageEmail[]>([]);
  #seq = $state(0);
  /** `emails` per state of emails, stamp and `edits` (not reactive). */
  #view: { emails: MessageEmail[]; seq: number; version: unknown; out: MessageEmail[] } | null = null;
  /** Error of the last load (`status` `error`). */
  error = $state.raw<unknown>(null);
  /** First load (for `Loading.run`); fails with the server's error. */
  readonly ready: Promise<void>;
  /** Embedded images per email: content ID (`cidKey`) → blob URL; missing while they load. */
  images = $state.raw<Readonly<Record<Id, ReadonlyMap<string, string>>>>({});
  /** Emails with "Load once": external content until the thread is discarded. */
  // Immutable, every change replaces the set (`$state.raw`).
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  once = $state.raw<ReadonlySet<Id>>(new Set());
  /** Emails whose parts are loading without limit right now ("Load full message"). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  loadingFull = $state.raw<ReadonlySet<Id>>(new Set());
  readonly #api: MessageApi;
  readonly #store: StoreOf;
  /** The state comes from storage; the server has not confirmed it yet. */
  #unconfirmed = false;
  /** Full parts per email: they replace the truncated ones even after `refresh()` (an email's content never changes). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #full = new Map<Id, Record<string, EmailBodyValue>>();
  #disposed = false;
  /** Images per email: `true` while a pass runs, `false` afterwards (not reactive). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #imaging = new Map<Id, boolean>();
  /** Emails whose HTML was loaded completely during a pass: again afterwards (new images). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #again = new Set<Id>();
  /** Created blob URLs, released with `dispose()`. */
  readonly #urls: string[] = [];
  readonly #abort = new AbortController();
  /** Counter of the load runs: only the response of the latest counts (back, forward, back). */
  #run = 0;

  constructor(
    api: MessageApi,
    account: string,
    threadId: Id,
    { store = () => null, frozen = false }: { store?: StoreOf; frozen?: boolean } = {},
  ) {
    this.#api = api;
    this.#store = store;
    this.account = account;
    this.threadId = threadId;
    this.frozen = frozen;
    this.ready = store() || frozen ? this.#start() : this.#load();
    // Whoever waits for `ready` reports the error; without a consumer no unhandled rejection.
    this.ready.catch(() => {});
  }

  /** Emails of the thread with the own changes; permanently deleted ones are missing. */
  get emails(): MessageEmail[] {
    const emails = this.#emails;
    const seq = this.#seq;
    const version = edits.version;
    const v = this.#view;
    if (v && v.emails === emails && v.seq === seq && v.version === version) return v.out;
    const out = emails.map((e) => edits.apply(this.account, e, seq)).filter((e): e is MessageEmail => !!e);
    this.#view = { emails, seq, version, out };
    return out;
  }

  /** Whether the server last returned one of these emails in the thread, even if an own change deleted it. */
  holds(ids: ReadonlySet<Id>): boolean {
    return this.#emails.some((e) => ids.has(e.id));
  }

  /** Neither server nor storage return the thread: the page shows what the list knows (`listEmail`). */
  get unreachable(): boolean {
    return this.status === 'error' && isOffline(this.error);
  }

  /** Nothing heard from the server yet: the state comes from storage or is missing for lack of connection. */
  get unconfirmed(): boolean {
    return this.#unconfirmed || this.unreachable;
  }

  /** First state from storage as soon as it is there; the server follows in the background. */
  async #start(): Promise<void> {
    const store = this.#store();
    const key = threadKey(this.account, this.threadId);
    const saved = await store?.thread(key);
    if (this.#disposed) return;
    if (saved) {
      store?.useThread(key);
      this.#emails = saved.emails;
      this.#unconfirmed = true;
      this.status = 'ready';
      void this.#load().catch(() => {});
    } else if (this.frozen) {
      this.error = new NetworkError('Account without access');
      this.status = 'error';
    } else await this.#load();
  }

  async #load(): Promise<void> {
    if (this.frozen) return;
    const run = ++this.#run;
    try {
      const seq = stamp();
      const emails = await this.#api.thread(this.account, this.threadId);
      if (this.#disposed || run !== this.#run) return;
      const moved = emails ? null : await this.#locate();
      if (this.#disposed || run !== this.#run) return;
      this.#emails = (emails ?? []).map((e) => this.#withFull(e));
      this.#seq = seq;
      this.#unconfirmed = false;
      this.error = null;
      this.movedTo = moved;
      this.status = emails ? 'ready' : 'missing';
      if (emails) this.#save();
      else this.#store()?.dropThread(threadKey(this.account, this.threadId));
    } catch (error) {
      if (!this.#disposed && run === this.#run && this.status === 'loading') {
        this.error = error;
        this.status = 'error';
      }
      throw error;
    }
  }

  /**
   * Thread no longer there: on a merge the
   * email has a new id and lies in another thread; Message-ID and
   * arrival stay. If the search fails, the thread counts as deleted.
   */
  async #locate(): Promise<Id | null> {
    const email = this.#emails.findLast((e) => e.messageId.length);
    if (!email) return null;
    const found = await this.#api.locate(this.account, email).catch(() => null);
    return found === this.threadId ? null : found;
  }

  /** Server state into storage; own changes do not belong to it. */
  #save(): void {
    const { account, threadId } = this;
    this.#store()?.saveThread({
      key: threadKey(account, threadId),
      account,
      threadId,
      emails: fitThread(this.#emails),
    });
  }

  /** Reloads (back in a thread, "Try again"); the previous state stays until the response. */
  refresh(): Promise<void> {
    if (this.frozen) return Promise.resolve();
    if (this.status === 'error') this.status = 'loading';
    return this.#load();
  }

  /**
   * "Try again" of the card and return of the network: like
   * `refresh()`, but the card stays until the server answers.
   * Fails with the server's error, without access without an attempt.
   */
  retry(): Promise<void> {
    return this.frozen ? Promise.reject(new NetworkError('Account without access')) : this.#load();
  }

  /** Full parts over the truncated ones; parts the response does not name stay as they were. */
  #withFull(email: MessageEmail): MessageEmail {
    const values = this.#full.get(email.id);
    return values ? { ...email, bodyValues: { ...email.bodyValues, ...values } } : email;
  }

  /**
   * "Load full message" (`tr.load`): the truncated parts of the rendering without
   * limit; the next `loadImages()` loads the images in the now complete HTML.
   * Fails with the server's error, the truncated state stays; if the
   * server truncates even without a limit (own upper limit), it fails as well instead of
   * silently doing nothing.
   */
  async loadFull(emailId: Id): Promise<void> {
    const email = this.emails.find((e) => e.id === emailId);
    const cut = email && truncationOf(email);
    if (this.#disposed || !cut || this.loadingFull.has(emailId)) return;
    if (this.frozen) throw new NetworkError('Account without access');
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    this.loadingFull = new Set([...this.loadingFull, emailId]);
    try {
      const values = await this.#api.fullBody(this.account, emailId, cut.part, this.#abort.signal);
      if (this.#disposed) return;
      if (!values) throw new Error('Email no longer exists');
      this.#full.set(emailId, { ...this.#full.get(emailId), ...values });
      if (this.#imaging.get(emailId)) this.#again.add(emailId);
      else this.#imaging.delete(emailId);
      this.#emails = this.#emails.map((e) => (e.id === emailId ? this.#withFull(e) : e));
      this.#save();
      const now = this.emails.find((e) => e.id === emailId);
      if (now && truncationOf(now)) throw new Error('Part truncated even without limit');
    } catch (error) {
      // Discarded (`dispose()`): nobody waits for the result any more.
      if (!this.#disposed) throw error;
    } finally {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const rest = new Set(this.loadingFull);
      rest.delete(emailId);
      this.loadingFull = rest;
    }
  }

  /** Loads external content of an email once (`hb.once`). */
  allowOnce(emailId: Id): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    if (!this.once.has(emailId)) this.once = new Set([...this.once, emailId]);
  }

  /**
   * Loads the inline images of an email (`cid:` from `attachments`, images from
   * `htmlBody`) as blob URLs, raster images only. Failed ones are missing in the
   * mapping; the next call tries them again, until then they appear
   * among the attachments (`message-view.ts`).
   */
  loadImages(emailId: Id): void {
    if (this.#imaging.has(emailId) || this.#disposed || this.frozen) return;
    const email = this.emails.find((e) => e.id === emailId);
    if (!email) return;
    this.#imaging.set(emailId, true);
    const refs = inlineCids(email);
    const known = this.images[emailId];
    const parts = [
      ...email.attachments.filter((p) => p.cid).map((p) => [cidKey(p.cid!), p] as const),
      ...email.htmlBody.filter((p) => p.partId).map((p) => [partKey(p.partId!), p] as const),
    ].filter(([key, p]) => refs.has(key) && !known?.has(key) && p.blobId && isInlineImage(p.type));
    void Promise.allSettled(
      parts.map(async ([key, p]) => {
        const blob = await this.#api.download(this.account, p, this.#abort.signal);
        // Type of the part instead of the response: the blob should never count as a document (e.g. HTML).
        return [key, new Blob([blob], { type: p.type })] as const;
      }),
    ).then((results) => {
      if (this.#disposed) return;
      // At the state on completion: a later pass may already have entered images.
      const done = this.images[emailId];
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const map = new Map(done);
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const url = URL.createObjectURL(r.value[1]);
        this.#urls.push(url);
        map.set(r.value[0], url);
      }
      // Only set on something new: a repeated failure would otherwise trigger the next attempt immediately via the page.
      if (!done || map.size > done.size) this.images = { ...this.images, [emailId]: map };
      const again = this.#again.delete(emailId);
      if (again || results.some((r) => r.status === 'rejected')) this.#imaging.delete(emailId);
      else this.#imaging.set(emailId, false);
      if (again) this.loadImages(emailId);
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort.abort();
    for (const url of this.#urls.splice(0)) URL.revokeObjectURL(url);
  }
}

/** Content type of a whole email (RFC 5322) for the download. */
const MESSAGE_TYPE = 'message/rfc822';

/** Source of an email: loads on creation via its `blobId`, `dispose()` aborts. */
export class MessageSource {
  /** Email whose source it is. */
  readonly emailId: Id;
  /** File name for "Download as .eml". */
  readonly fileName: string;
  /** The email as the server returns it (download). */
  readonly blob: Promise<Blob>;
  /** Its text (copy); fails with the download's error. */
  readonly text: Promise<string>;
  /** Header and body for display; `null` while it loads or if loading fails. */
  parts = $state.raw<SourceParts | null>(null);
  readonly #abort = new AbortController();

  constructor(api: MessageApi, account: string, email: Pick<MessageEmail, 'id' | 'blobId'>, fileName: string) {
    this.emailId = email.id;
    this.fileName = fileName;
    this.blob = api.download(account, { blobId: email.blobId, name: fileName, type: MESSAGE_TYPE }, this.#abort.signal);
    this.text = this.blob.then(async (blob) => {
      const text = decodeSource(await blob.arrayBuffer());
      this.#abort.signal.throwIfAborted();
      return text;
    });
    // Whoever waits for `text` reports the error.
    this.text.then(
      (text) => (this.parts = sourceParts(text)),
      () => {},
    );
  }

  /** Closed: abort the download; `blob` and `text` then fail with the abort. */
  get disposed(): boolean {
    return this.#abort.signal.aborted;
  }

  dispose(): void {
    this.#abort.abort();
  }
}

export class Messages {
  readonly #api: MessageApi;
  // Not reactive: cache; the page holds the open thread itself.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #open = new Map<string, Conversation>();
  /** Conversations a page currently shows (`show()`): the live sync reloads them immediately. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #shown = new Set<Conversation>();
  readonly #store: StoreOf;
  /** `prefetch()` is running: one is enough, the next trigger fetches the rest. */
  #prefetching = false;

  constructor(
    api: MessageApi = jmapMessageApi((account) => accounts.client(account)),
    store: StoreOf = () => session.mailStore,
  ) {
    this.#api = api;
    this.#store = store;
  }

  /** Subject of this email if an open conversation knows it. */
  subjectOf(account: string, id: Id): string | null {
    for (const c of this.#open.values()) {
      const hit = c.account === account ? c.emails.find((e) => e.id === id) : undefined;
      if (hit) return hit.subject;
    }
    return null;
  }

  /** Thread of an account; `cached` if it already lay in storage (then `refresh()` is worth it). */
  open(account: string, threadId: Id, frozen = false): { conversation: Conversation; cached: boolean } {
    const key = threadKey(account, threadId);
    const known = this.#open.get(key);
    if (known && known.status !== 'error' && known.frozen === frozen) {
      // Most recently opened to the end.
      this.#open.delete(key);
      this.#open.set(key, known);
      return { conversation: known, cached: true };
    }
    known?.dispose();
    const conversation = new Conversation(this.#api, account, threadId, { store: this.#store, frozen });
    this.#open.delete(key);
    this.#open.set(key, conversation);
    for (const [k, c] of this.#open) {
      if (this.#open.size <= CACHE_SIZE) break;
      c.dispose();
      this.#open.delete(k);
    }
    return { conversation, cached: false };
  }

  /** The page shows `conversation` until it calls the return value (cleanup of its effect). */
  show(conversation: Conversation): () => void {
    this.#shown.add(conversation);
    return () => this.#shown.delete(conversation);
  }

  /**
   * Changes from the live sync: displayed conversations they affect
   * (new or changed email in the thread, deleted email, `reset`) reload;
   * the page reloads the others anyway when they are opened
   * again. Errors stay silent, the previous state stays. Deleted
   * emails also leave storage, `prefetch()` catches up on changed ones.
   */
  async touch(change: EmailChange): Promise<void> {
    if (change.destroyed.size) this.#store()?.dropEmails(change.account, change.destroyed);
    const hit = [...this.#shown].filter(
      (c) =>
        c.account === change.account && (change.reset || change.threads.has(c.threadId) || c.holds(change.destroyed)),
    );
    // If the first load is still running, afterwards: reloading now would replace it, and `ready` would come without content.
    await Promise.all(
      hit.map((c) => (c.status === 'loading' ? c.ready.then(() => c.refresh()) : c.refresh()).catch(() => {})),
    );
  }

  /** The account answers again: displayed states from storage and "not stored" cards catch up. */
  async resume(account: string): Promise<void> {
    const open = [...this.#shown].filter((c) => c.account === account && c.unconfirmed);
    await Promise.all(open.map((c) => c.retry().catch(() => {})));
  }

  /**
   * Stores the top conversations of a displayed list in storage
   * (`PREFETCH_THREADS`) if they are missing there or an email was added; this way
   * even never-opened emails are readable offline. Errors stay silent, the
   * next trigger tries again.
   */
  async prefetch(rows: readonly Pick<ListThread, 'account' | 'threadId' | 'members'>[]): Promise<void> {
    const store = this.#store();
    if (!store || this.#prefetching || saveData()) return;
    this.#prefetching = true;
    try {
      const top = rows.slice(0, PREFETCH_THREADS);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- data, not state
      for (const account of new Set(top.map((r) => r.account))) {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- data, not state
        const heads = new Map((await store.heads(account)).map((h) => [h.threadId, h.mails]));
        const want: Id[] = [];
        let emails = 0;
        for (const row of top.filter((r) => r.account === account)) {
          const known = heads.get(row.threadId);
          if (known && row.members.every((e) => known.some((k) => k.id === e.id))) continue;
          if (emails + row.members.length > PREFETCH_EMAILS) continue;
          emails += row.members.length;
          want.push(row.threadId);
        }
        if (!want.length) continue;
        for (const [threadId, list] of await this.#api.threads(account, want))
          store.saveThread({ key: threadKey(account, threadId), account, threadId, emails: fitThread(list) });
      }
    } catch {
      // Only a stock: the page does not need it.
    } finally {
      this.#prefetching = false;
    }
  }

  /** Loads an attachment as a blob. */
  download(account: string, part: DownloadRef): Promise<Blob> {
    return this.#api.download(account, part);
  }

  /** Source of an email of the account; every call reloads. */
  source(account: string, email: Pick<MessageEmail, 'id' | 'blobId'>, fileName: string): MessageSource {
    return new MessageSource(this.#api, account, email, fileName);
  }

  /** Discards the threads of accounts no longer in `accounts`. */
  retain(accounts: readonly string[]): void {
    for (const [key, c] of this.#open)
      if (!accounts.includes(c.account)) {
        c.dispose();
        this.#open.delete(key);
      }
  }

  /** Sign-out: discard everything. */
  reset(): void {
    for (const c of this.#open.values()) c.dispose();
    this.#open.clear();
  }
}

/** Browser's data saver mode: load nothing in advance. */
function saveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

export const message = new Messages();

edits.describe((account, id) => message.subjectOf(account, id));
