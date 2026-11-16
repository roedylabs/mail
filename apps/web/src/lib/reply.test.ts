import { describe, expect, it } from 'vitest';
import {
  quoteText,
  replyContext,
  replyRecipients,
  replySubject,
  replyValues,
  splitQuote,
  withQuote,
  type ReplyContext,
} from '#lib/reply.ts';
import type { MessageEmail, MessagePart } from '#lib/state/message.svelte.ts';

const ME = 'me@example.com';
const TIME = {
  tz: 'Europe/Berlin',
  timeFmt: '24h',
  weekStart: 'monday',
  dateFmt: 'de',
  now: Date.UTC(2026, 10, 2, 9),
} as const;
const addr = (email: string, name: string | null = null) => ({ name, email });

function email(patch: Partial<MessageEmail> = {}): MessageEmail {
  return {
    id: 'e1',
    blobId: 'blob-e1',
    threadId: 't1',
    mailboxIds: ['in'],
    keywords: {},
    receivedAt: Date.UTC(2026, 10, 1, 9, 30),
    from: [addr('anna@example.com', 'Anna Baker')],
    to: [addr(ME)],
    cc: [],
    replyTo: [],
    messageId: ['m1@example.com'],
    inReplyTo: [],
    references: [],
    subject: 'Plan',
    preview: '',
    hasAttachment: false,
    textBody: [
      {
        partId: '1',
        blobId: 'b1',
        size: 20,
        name: null,
        type: 'text/plain',
        charset: 'utf-8',
        disposition: null,
        cid: null,
      },
    ],
    htmlBody: [],
    attachments: [],
    bodyValues: {
      '1': { value: 'Hello,\n\nhow are you?\nSecond line', isEncodingProblem: false, isTruncated: false },
    },
    ...patch,
  };
}

const ctxOf = (e: MessageEmail, mine = false, attachments: MessagePart[] = []) =>
  replyContext(e, { mine, own: ME, who: mine ? 'Me' : 'Anna Baker', time: TIME, attachments });

describe('reply', () => {
  it('replies to the sender, reply all also to To and Cc without the own account', () => {
    const ctx = ctxOf(
      email({
        to: [addr('ME@example.com'), addr('ben@example.com', 'Ben')],
        cc: [addr('cara@example.com', 'Cara'), addr('anna@example.com'), addr('ben@example.com')],
      }),
    );
    expect(ctx.to).toEqual([addr('anna@example.com', 'Anna Baker')]);
    expect(replyRecipients(ctx, 'all')).toEqual({
      to: [addr('anna@example.com', 'Anna Baker')],
      cc: [addr('ben@example.com', 'Ben'), addr('cara@example.com', 'Cara')],
    });
    expect(replyRecipients(ctx, 'reply').cc).toEqual([]);
    expect(ctx.hasAll).toBe(true);
    expect(ctxOf(email()).hasAll).toBe(false);
  });

  it('takes the reply-to address instead of the sender', () => {
    const ctx = ctxOf(email({ replyTo: [addr('list@example.com', 'List')] }));
    expect(ctx.to).toEqual([addr('list@example.com', 'List')]);
  });

  it('replies to own emails to their recipients, "all" only from two', () => {
    const one = ctxOf(email({ from: [addr(ME)], to: [addr('ben@example.com', 'Ben')] }), true);
    expect(one.to).toEqual([addr('ben@example.com', 'Ben')]);
    expect(one.hasAll).toBe(false);
    const two = ctxOf(
      email({ from: [addr(ME)], to: [addr('ben@example.com')], cc: [addr('cara@example.com'), addr(ME)] }),
      true,
    );
    expect(two.to).toEqual([addr('ben@example.com')]);
    expect(two.hasAll).toBe(true);
    expect(replyRecipients(two, 'all')).toEqual({ to: [addr('ben@example.com')], cc: [addr('cara@example.com')] });
  });

  it('sets In-Reply-To and References per RFC 5322', () => {
    expect(ctxOf(email())).toMatchObject({ inReplyTo: ['m1@example.com'], references: ['m1@example.com'] });
    expect(ctxOf(email({ messageId: ['m3@x'], inReplyTo: ['m2@x'], references: ['m1@x', 'm2@x'] }))).toMatchObject({
      inReplyTo: ['m3@x'],
      references: ['m1@x', 'm2@x', 'm3@x'],
    });
    // Without References, In-Reply-To counts as the chain.
    expect(ctxOf(email({ messageId: ['m3@x'], inReplyTo: ['m2@x'] })).references).toEqual(['m2@x', 'm3@x']);
    expect(ctxOf(email({ messageId: [] }))).toMatchObject({ inReplyTo: null, references: null });
  });

  it('builds the subject with "Re:" or "Fwd:" without duplicate prefixes', () => {
    expect(ctxOf(email({ subject: '  AW: Re:Plan' })).base).toBe('Plan');
    expect(replySubject('Plan', 'reply')).toBe('Re: Plan');
    expect(replySubject('Plan', 'all')).toBe('Re: Plan');
    expect(replySubject('Plan', 'fwd')).toBe('Fwd: Plan');
    expect(replySubject('', 'reply')).toBe('Re:');
  });

  it('quotes with the "On … wrote:" header and the paragraphs of the original', () => {
    expect(ctxOf(email()).quote).toEqual({
      head: 'On Sunday, 1 November 2026, 10:30, Anna Baker wrote:',
      paras: ['Hello,', 'how are you?\nSecond line'],
    });
  });

  it('takes the shown attachments with their blobs', () => {
    const part: MessagePart = {
      partId: '2',
      blobId: 'b2',
      size: 10,
      name: 'a.pdf',
      type: 'application/pdf',
      charset: null,
      disposition: 'attachment',
      cid: null,
    };
    expect(ctxOf(email(), false, [part]).attachments).toEqual([part]);
  });
});

describe('reply bar', () => {
  const ctx: ReplyContext = ctxOf(
    email({ to: [addr(ME), addr('ben@example.com', 'Ben Webster')], cc: [addr('cara@example.com')] }),
  );

  it('is closed without state', () => {
    expect(replyValues(ctx, null, 'Ctrl')).toMatchObject({ open: false, closed: true, hasAll: true, can: false });
  });

  it('shows kind, recipients, placeholder and send only with text', () => {
    const empty = replyValues(ctx, { mode: 'reply', text: ' ', to: '' }, '⌘');
    expect(empty).toMatchObject({
      open: true,
      notFwd: true,
      toLabel: 'To: Anna Baker',
      ph: 'Reply to Anna …',
      can: false,
      sendBg: 'var(--sunken)',
      sendCur: 'default',
      hint: '⌘ + Enter to send',
    });
    expect(empty.modes.map((o) => [o.id, o.label, o.short, o.on])).toEqual([
      ['reply', 'Reply', 'Reply', 'true'],
      ['all', 'Reply all', 'All', 'false'],
      ['fwd', 'Forward', 'Forward', 'false'],
    ]);
    const all = replyValues(ctx, { mode: 'all', text: 'Sure', to: '' }, 'Ctrl');
    expect(all).toMatchObject({ toLabel: 'To: Anna Baker, Ben Webster, cara@example.com', can: true });
    expect(all.sendBg).toBe('var(--ink)');
  });

  it('only two kinds without "Reply all"; without a name "recipient"', () => {
    const solo = ctxOf(email({ from: [addr('anna@example.com')] }));
    const v = replyValues(solo, { mode: 'reply', text: '', to: '' }, 'Ctrl');
    expect(v.modes.map((o) => o.id)).toEqual(['reply', 'fwd']);
    expect(v.ph).toBe('Reply to recipient …');
    expect(v.toLabel).toBe('To: anna@example.com');
  });

  it('forwarding needs a valid address, text is optional', () => {
    const fwd = (to: string) => replyValues(ctx, { mode: 'fwd', text: '', to }, 'Ctrl');
    expect(fwd('ben@')).toMatchObject({
      isFwd: true,
      notFwd: false,
      can: false,
      ph: 'Add a message (optional)',
    });
    expect(fwd(' ben@example.com ').can).toBe(true);
  });

  it('disables send without a connection; half transparent only with text', () => {
    const tip = 'Not available offline. Use “Open in editor” to keep your text as a draft.';
    const on = replyValues(ctx, { mode: 'reply', text: 'Sure', to: '' }, 'Ctrl');
    expect(on).toMatchObject({ can: true, sendOff: false, sendOp: 1, sendTip: '', sendCur: 'pointer' });
    const off = replyValues(ctx, { mode: 'reply', text: 'Sure', to: '' }, 'Ctrl', true);
    expect(off).toMatchObject({ can: true, sendOff: true, sendOp: 0.5, sendTip: tip, sendCur: 'default' });
    expect(off.sendBg).toBe('var(--ink)');
    const empty = replyValues(ctx, { mode: 'reply', text: '', to: '' }, 'Ctrl', true);
    expect(empty).toMatchObject({ can: false, sendOff: true, sendOp: 1, sendTip: tip, sendBg: 'var(--sunken)' });
  });
});

describe('quote in the text', () => {
  const q = { head: 'On Sunday, Anna wrote:', paras: ['Hello,', 'Line 1\nLine 2', '> old'] };

  it('quotes lines with "> ", empty lines and already quoted text with ">"', () => {
    expect(quoteText(q)).toBe('On Sunday, Anna wrote:\n> Hello,\n>\n> Line 1\n> Line 2\n>\n>> old');
    expect(withQuote('Text\n\n-- \nSig', q)).toBe(`Text\n\n-- \nSig\n\n${quoteText(q)}`);
    expect(withQuote('', q)).toBe(quoteText(q));
    expect(withQuote('Text', null)).toBe('Text');
  });

  it('splits the quote off again on opening', () => {
    expect(splitQuote(withQuote('Text\n\n-- \nSig', q))).toEqual({ text: 'Text\n\n-- \nSig', quote: q });
    expect(splitQuote(quoteText(q))).toEqual({ text: '', quote: q });
    // Original without text: only the header, still recognized as a quote.
    const head = { head: 'On Sunday, Anna wrote:', paras: [] };
    expect(quoteText(head)).toBe('On Sunday, Anna wrote:\n>');
    expect(splitQuote(withQuote('Text\n\n-- \nSig', head))).toEqual({ text: 'Text\n\n-- \nSig', quote: head });
    // No quote: no header ending in ":", header without an empty line before it or nothing quoted after it.
    for (const body of ['Text\n> only quoted', 'Text\nOn Sunday, Anna wrote:\n> x', 'Text\n\nSo:', 'Text']) {
      expect(splitQuote(body)).toEqual({ text: body, quote: null });
    }
  });
});
