/**
 * State module `sentReplies`: a reply sent from the reading view (reply bar,
 * or compose opened from it with "Reply" or "Reply all") stands in its
 * conversation right away, before the sync brings it from the server
 * (`pfConvX`). Forwards, scheduled emails and replies sent from another
 * account do not. The entry goes away on undo and when sending fails, and
 * once the server returns its email in the thread (at the latest
 * `CONFIRMED_KEEP_MS` after the submission); only undo and failure cancel its jump. Until then it is only shown:
 * actions work on the email the server returns. Plus the jump to the end of
 * the conversation after sending (`rdScrollRef` › `scrollTop = scrollHeight`,
 * without animation): from the reply bar in the next frame, from compose
 * 160 ms after returning to the reading view; one per conversation.
 */
import type { Id } from '@roedy/jmap';
import type { MessageEmail } from '#lib/state/message.svelte.ts';

/** Conversation of a reply: account and thread. */
export interface ThreadRef {
  account: string;
  threadId: Id;
}

/** What a sent reply shows: an email without id and thread. */
export type ReplyEmail = Omit<MessageEmail, 'id' | 'threadId'>;

/** Delay of the jump to the end after sending from compose (`setTimeout(…, 160)`). */
export const COMPOSE_SCROLL_DELAY = 160;

/** How long the reading view stays at the end after the jump while its content still grows (`toEnd`). */
export const END_FOLLOW_MS = 3000;

/** How long a submitted reply stands in for its email if the server does not return it in the thread. */
export const CONFIRMED_KEEP_MS = 5 * 60_000;

/** Id prefix of an entry whose email the server has not created yet. */
export const SENT_LOCAL = 'sent-local:';

interface Entry extends ThreadRef {
  key: number;
  email: MessageEmail;
  /** Submitted (`confirm()`): the entry ends once the thread holds its email. */
  confirmed: boolean;
}

/** Jump to the end of a conversation, waiting for the reading view to show it. */
export interface ScrollRequest extends ThreadRef {
  /** `0`: in the next frame; otherwise after this many milliseconds. */
  delay: number;
  /** Reply it belongs to (`add()`). */
  key: number;
}

export const sameThread = (a: ThreadRef, b: ThreadRef): boolean => a.account === b.account && a.threadId === b.threadId;

export class SentReplies {
  #entries = $state.raw<Entry[]>([]);
  #scrolls = $state.raw<ScrollRequest[]>([]);
  #next = 0;
  /** Replies undone or failed (`remove()`): their jump does not happen any more, even if already scheduled. */
  // Not reactive: only read when a jump fires.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #cancelled = new Set<number>();
  /** Expiry of submitted entries (`CONFIRMED_KEEP_MS`). */
  // Not reactive: only timers.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * A sent reply joins its conversation (`email` with a provisional id), and its
   * jump to the end waits for the reading view (`delay` as in `ScrollRequest`); it
   * replaces an earlier jump of the same conversation, not those of others.
   * Returns the key for `confirm()` and `remove()`.
   */
  add(thread: ThreadRef, email: ReplyEmail, delay: number): number {
    const key = ++this.#next;
    const entry: Entry = {
      ...thread,
      key,
      email: { ...email, id: SENT_LOCAL + key, threadId: thread.threadId },
      confirmed: false,
    };
    this.#entries = [...this.#entries, entry];
    this.#scrolls = [...this.#scrolls.filter((s) => !sameThread(s, thread)), { ...thread, delay, key }];
    return key;
  }

  /**
   * Submitted: the entry stands for the email `id` with the content that went
   * out (`email`, e.g. sender and signature once the identities loaded); the
   * time it appeared stays.
   */
  confirm(key: number, id: Id, email?: ReplyEmail): void {
    if (!this.#entries.some((e) => e.key === key)) return;
    this.#entries = this.#entries.map((e) =>
      e.key === key
        ? {
            ...e,
            confirmed: true,
            email: { ...e.email, ...email, id, threadId: e.threadId, receivedAt: e.email.receivedAt },
          }
        : e,
    );
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => this.#drop(key), CONFIRMED_KEEP_MS),
    );
  }

  /** Undo or failed send: the reply leaves the conversation, its jump does not happen any more. */
  remove(key: number): void {
    this.#drop(key);
    this.#cancelled.add(key);
    if (this.#scrolls.some((s) => s.key === key)) this.#scrolls = this.#scrolls.filter((s) => s.key !== key);
  }

  /** The server returned the email or the entry expired: it ends, its jump stays. */
  #drop(key: number): void {
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
    if (this.#entries.some((e) => e.key === key)) this.#entries = this.#entries.filter((e) => e.key !== key);
  }

  /** Whether the email is (still) shown from an entry: no actions on it until the server returns it. */
  pending(account: string, id: Id): boolean {
    return id.startsWith(SENT_LOCAL) || this.#entries.some((e) => e.account === account && e.email.id === id);
  }

  /**
   * Emails of a conversation in the server's order, then its sent replies in the order they
   * were sent (not by the browser's clock); an entry whose email is already among them does not appear twice.
   */
  merge(thread: ThreadRef, emails: MessageEmail[]): MessageEmail[] {
    const extra = this.#entries.filter((e) => sameThread(e, thread) && !emails.some((x) => x.id === e.email.id));
    if (!extra.length) return emails;
    return [...emails, ...extra.map((e) => e.email)];
  }

  /**
   * The server returned the thread (`holds`, also for emails an own change hides):
   * submitted entries it holds are done.
   */
  settle(thread: ThreadRef, holds: (ids: ReadonlySet<Id>) => boolean): void {
    // A lookup set, not state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const done = this.#entries.filter((e) => e.confirmed && sameThread(e, thread) && holds(new Set([e.email.id])));
    for (const e of done) this.#drop(e.key);
  }

  /** Takes the jump to the end for this conversation, or `null` if none waits. */
  takeScroll(thread: ThreadRef): ScrollRequest | null {
    const s = this.#scrolls.find((x) => sameThread(x, thread));
    if (!s) return null;
    this.#scrolls = this.#scrolls.filter((x) => x !== s);
    return s;
  }

  /** Whether the jump of a reply still stands (it was not undone and did not fail in the meantime). */
  live(key: number): boolean {
    return !this.#cancelled.has(key);
  }

  /** Jumps that wait, for the reading view to react to (reactive). */
  get scrolls(): readonly ScrollRequest[] {
    return this.#scrolls;
  }

  /** End of the session. */
  reset(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#cancelled.clear();
    this.#entries = [];
    this.#scrolls = [];
  }
}

export const sentReplies = new SentReplies();
