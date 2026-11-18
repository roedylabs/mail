import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageEmail } from '#lib/state/message.svelte.ts';
import { COMPOSE_SCROLL_DELAY, CONFIRMED_KEEP_MS, SENT_LOCAL, sentReplies } from '#lib/state/sent-replies.svelte.ts';

const T1 = { account: 'k1', threadId: 't1' };
const T2 = { account: 'k1', threadId: 't2' };

function email(id: string, receivedAt: number): MessageEmail {
  return {
    id,
    blobId: `b-${id}`,
    threadId: 't1',
    mailboxIds: ['inbox'],
    keywords: {},
    receivedAt,
    from: [{ name: 'Ben', email: 'ben@example.com' }],
    to: [],
    cc: [],
    replyTo: [],
    messageId: [],
    inReplyTo: [],
    references: [],
    subject: 'Plan',
    preview: '',
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
  };
}

const sent = (receivedAt: number): Omit<MessageEmail, 'id' | 'threadId'> => ({
  ...email('x', receivedAt),
  mailboxIds: ['sent'],
  subject: 'Re: Plan',
});

afterEach(() => {
  sentReplies.reset();
  vi.useRealTimers();
});

describe('sentReplies', () => {
  it('puts a sent reply into its conversation by date, only there', () => {
    const key = sentReplies.add(T1, sent(300), 0);
    const list = [email('e1', 100), email('e2', 400)];
    const merged = sentReplies.merge(T1, list);
    expect(merged.map((e) => e.id)).toEqual(['e1', SENT_LOCAL + key, 'e2']);
    expect(merged[1]).toMatchObject({ threadId: 't1', subject: 'Re: Plan' });
    expect(sentReplies.pending(merged[1]!.id)).toBe(true);
    expect(sentReplies.pending('e1')).toBe(false);
    // Another conversation, and without entries the same array.
    expect(sentReplies.merge(T2, list)).toBe(list);
  });

  it('stands for the submitted email, without actions until the thread holds it', () => {
    const key = sentReplies.add(T1, sent(300), 0);
    sentReplies.confirm(key, 'd9', { ...sent(999), subject: 'Re: Plan (sent)' });
    // The content that went out; the time it appeared stays.
    expect(sentReplies.merge(T1, [])).toMatchObject([{ id: 'd9', subject: 'Re: Plan (sent)', receivedAt: 300 }]);
    expect(sentReplies.pending('d9')).toBe(true);
    // The server already returns it: not twice.
    const server = email('d9', 310);
    expect(sentReplies.merge(T1, [server])).toEqual([server]);
    // An entry that is not submitted yet does not end on settling.
    const other = sentReplies.add(T1, sent(500), 0);
    sentReplies.settle(T1, (ids) => ids.has('d9'));
    expect(sentReplies.pending('d9')).toBe(false);
    expect(sentReplies.merge(T1, []).map((e) => e.id)).toEqual([SENT_LOCAL + other]);
  });

  it('a submitted entry the server never returns ends after a while', () => {
    vi.useFakeTimers();
    const key = sentReplies.add(T1, sent(300), 0);
    sentReplies.confirm(key, 'd9');
    vi.advanceTimersByTime(CONFIRMED_KEEP_MS - 1);
    expect(sentReplies.merge(T1, [])).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sentReplies.merge(T1, [])).toEqual([]);
  });

  it('keeps one jump per conversation, takes it once; removing the reply cancels it', () => {
    const a = sentReplies.add(T1, sent(300), COMPOSE_SCROLL_DELAY);
    // A reply in another conversation does not erase the waiting jump.
    const b = sentReplies.add(T2, sent(300), 0);
    expect(sentReplies.takeScroll(T1)).toMatchObject({ ...T1, delay: 160, key: a });
    expect(sentReplies.takeScroll(T1)).toBeNull();
    expect(sentReplies.live(a)).toBe(true);
    sentReplies.remove(b);
    expect(sentReplies.scrolls).toEqual([]);
    expect(sentReplies.live(b)).toBe(false);
    // The server returning the email does not cancel a jump, not even one already taken.
    sentReplies.confirm(a, 'd9');
    sentReplies.settle(T1, (ids) => ids.has('d9'));
    expect(sentReplies.merge(T1, [])).toEqual([]);
    expect(sentReplies.live(a)).toBe(true);
    // The latest reply of a conversation replaces its jump.
    sentReplies.add(T1, sent(400), COMPOSE_SCROLL_DELAY);
    const c = sentReplies.add(T1, sent(500), 0);
    expect(sentReplies.scrolls).toEqual([{ ...T1, delay: 0, key: c }]);
  });

  it('forgets everything at the end of the session', () => {
    const key = sentReplies.add(T1, sent(300), 0);
    sentReplies.confirm(key, 'd9');
    sentReplies.reset();
    expect(sentReplies.merge(T1, [])).toEqual([]);
    expect(sentReplies.scrolls).toEqual([]);
  });
});
