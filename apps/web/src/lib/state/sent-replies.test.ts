import { afterEach, describe, expect, it } from 'vitest';
import type { MessageEmail } from '#lib/state/message.svelte.ts';
import { COMPOSE_SCROLL_DELAY, SENT_LOCAL, sentReplies } from './sent-replies.svelte.ts';

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

afterEach(() => sentReplies.reset());

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

  it('stands for the email once confirmed and ends when the thread holds it', () => {
    const key = sentReplies.add(T1, sent(300), 0);
    sentReplies.confirm(key, 'd9');
    expect(sentReplies.merge(T1, []).map((e) => e.id)).toEqual(['d9']);
    // The server already returns it: not twice.
    const server = email('d9', 310);
    expect(sentReplies.merge(T1, [server])).toEqual([server]);
    // An unconfirmed entry does not end on settling.
    const other = sentReplies.add(T1, sent(500), 0);
    sentReplies.settle(T1, (ids) => ids.has('d9'));
    expect(sentReplies.merge(T1, []).map((e) => e.id)).toEqual([SENT_LOCAL + other]);
  });

  it('takes the jump to the end once, only for its conversation; removing cancels it', () => {
    const first = sentReplies.add(T1, sent(300), COMPOSE_SCROLL_DELAY);
    expect(sentReplies.takeScroll(T2)).toBeNull();
    expect(sentReplies.takeScroll(T1)).toBe(160);
    expect(sentReplies.takeScroll(T1)).toBeNull();
    const key = sentReplies.add(T1, sent(300), 0);
    expect(sentReplies.scroll).toMatchObject({ ...T1, delay: 0 });
    sentReplies.remove(key);
    expect(sentReplies.scroll).toBeNull();
    expect(sentReplies.merge(T1, []).map((e) => e.id)).toEqual([SENT_LOCAL + first]);
  });

  it('forgets everything at the end of the session', () => {
    sentReplies.add(T1, sent(300), 0);
    sentReplies.reset();
    expect(sentReplies.merge(T1, [])).toEqual([]);
    expect(sentReplies.scroll).toBeNull();
  });
});
