/**
 * State module `sentReplies`: a reply sent from the reading view (reply bar,
 * or compose opened from it with "Reply" or "Reply all") stands in its
 * conversation right away, before the sync brings it from the server
 * (`pfConvX`). Forwards and scheduled emails do not. The entry goes away
 * on undo and when sending fails, and once the server returns its email in
 * the thread. Plus the one jump to the end of the conversation after
 * sending (`rdScrollRef` › `scrollTop = scrollHeight`, without animation):
 * from the reply bar in the next frame, from compose 160 ms after
 * returning to the reading view.
 */
import type { Id } from '@roedy/jmap';
import type { MessageEmail } from '#lib/state/message.svelte.ts';

/** Conversation of a reply: account and thread. */
export interface ThreadRef {
  account: string;
  threadId: Id;
}

/** Delay of the jump to the end after sending from compose (`setTimeout(…, 160)`). */
export const COMPOSE_SCROLL_DELAY = 160;

/** Id prefix of an entry the server has not confirmed yet. */
export const SENT_LOCAL = 'sent-local:';

interface Entry extends ThreadRef {
  key: number;
  email: MessageEmail;
  /** The server's id is known (`confirm()`): the entry ends once the thread holds it. */
  confirmed: boolean;
}

/** Jump to the end of a conversation, waiting for the reading view to show it. */
export interface ScrollRequest extends ThreadRef {
  /** `0`: in the next frame; otherwise after this many milliseconds. */
  delay: number;
}

const same = (a: ThreadRef, b: ThreadRef) => a.account === b.account && a.threadId === b.threadId;

export class SentReplies {
  #entries = $state.raw<Entry[]>([]);
  #scroll = $state.raw<(ScrollRequest & { key: number }) | null>(null);
  #next = 0;

  /**
   * A sent reply joins its conversation (`email` with a provisional id), and the
   * jump to the end waits for the reading view (`delay` as in `ScrollRequest`).
   * Returns the key for `confirm()` and `remove()`.
   */
  add(thread: ThreadRef, email: Omit<MessageEmail, 'id' | 'threadId'>, delay: number): number {
    const key = ++this.#next;
    const entry: Entry = {
      ...thread,
      key,
      email: { ...email, id: SENT_LOCAL + key, threadId: thread.threadId },
      confirmed: false,
    };
    this.#entries = [...this.#entries, entry];
    this.#scroll = { ...thread, delay, key };
    return key;
  }

  /** The server created the email with `id`: from now on the entry stands for it. */
  confirm(key: number, id: Id): void {
    this.#entries = this.#entries.map((e) =>
      e.key === key ? { ...e, confirmed: true, email: { ...e.email, id } } : e,
    );
  }

  /** Undo or failed send: the reply leaves the conversation, the jump does not happen any more. */
  remove(key: number): void {
    if (this.#entries.some((e) => e.key === key)) this.#entries = this.#entries.filter((e) => e.key !== key);
    if (this.#scroll?.key === key) this.#scroll = null;
  }

  /** Whether the id is that of an entry the server has not confirmed yet (no actions on it). */
  pending(id: Id): boolean {
    return id.startsWith(SENT_LOCAL);
  }

  /**
   * Emails of a conversation with its sent replies, by `receivedAt`; an entry whose
   * email is already among them does not appear twice.
   */
  merge(thread: ThreadRef, emails: MessageEmail[]): MessageEmail[] {
    const extra = this.#entries.filter((e) => same(e, thread) && !emails.some((x) => x.id === e.email.id));
    if (!extra.length) return emails;
    return [...emails, ...extra.map((e) => e.email)].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /**
   * The server returned the thread (`holds`, also for emails an own change hides):
   * confirmed entries it holds are done.
   */
  settle(thread: ThreadRef, holds: (ids: ReadonlySet<Id>) => boolean): void {
    // A lookup set, not state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const done = this.#entries.filter((e) => e.confirmed && same(e, thread) && holds(new Set([e.email.id])));
    if (done.length) this.#entries = this.#entries.filter((e) => !done.includes(e));
  }

  /** Takes the jump to the end for this conversation: its delay, or `null` if none waits. */
  takeScroll(thread: ThreadRef): number | null {
    const s = this.#scroll;
    if (!s || !same(s, thread)) return null;
    this.#scroll = null;
    return s.delay;
  }

  /** Jump that waits, for the reading view to react to (reactive). */
  get scroll(): ScrollRequest | null {
    return this.#scroll;
  }

  /** End of the session. */
  reset(): void {
    this.#entries = [];
    this.#scroll = null;
  }
}

export const sentReplies = new SentReplies();
