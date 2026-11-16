import { describe, expect, it } from 'vitest';
import type { ListThread } from '#lib/mail-list.ts';
import type { MailStore, SavedList, ThreadHead } from '#lib/mail-store.ts';
import { localPage, markSubject, matches, MAX_LOCAL_HITS, savedMails, type LocalMail } from './local-search.ts';

const mail = (over: Partial<LocalMail> = {}): LocalMail => ({
  id: 'e1',
  threadId: 't1',
  receivedAt: Date.parse('2026-11-01T10:00:00Z'),
  from: [{ name: 'Anna Sample', email: 'anna@example.test' }],
  to: [{ name: 'Ben', email: 'ben@example.test' }],
  subject: 'Invoice Zürich',
  preview: 'Documents attached',
  mailboxIds: ['m1'],
  keywords: { $seen: true },
  hasAttachment: true,
  attachments: ['a.pdf'],
  ...over,
});

describe('matches', () => {
  it('searches `text` in subject, sender and preview, case-insensitively', () => {
    for (const text of ['INVOICE', 'anna@example', 'sample', 'documents']) expect(matches(mail(), { text })).toBe(true);
    expect(matches(mail(), { text: 'ben' })).toBe(false);
  });

  it('folds umlauts and accents like the other parts of the search', () => {
    expect(matches(mail(), { subject: 'zuerich' })).toBe(true);
    expect(matches(mail({ subject: 'Café' }), { text: 'cafe' })).toBe(true);
  });

  it('checks the single fields', () => {
    expect(matches(mail(), { subject: 'zürich' })).toBe(true);
    expect(matches(mail(), { subject: 'anna' })).toBe(false);
    expect(matches(mail(), { from: 'anna' })).toBe(true);
    expect(matches(mail(), { from: 'invoice' })).toBe(false);
    expect(matches(mail(), { body: 'documents' })).toBe(true);
    expect(matches(mail(), { body: 'invoice' })).toBe(false);
  });

  it('checks mailbox, keywords, attachment and date range', () => {
    expect(matches(mail(), { inMailbox: 'm1' })).toBe(true);
    expect(matches(mail(), { inMailbox: 'm2' })).toBe(false);
    expect(matches(mail(), { hasKeyword: '$seen' })).toBe(true);
    expect(matches(mail(), { hasKeyword: '$flagged' })).toBe(false);
    expect(matches(mail(), { notKeyword: '$seen' })).toBe(false);
    expect(matches(mail(), { hasAttachment: true })).toBe(true);
    expect(matches(mail(), { hasAttachment: false })).toBe(false);
    expect(matches(mail(), { after: '2026-10-01T00:00:00Z' })).toBe(true);
    expect(matches(mail(), { after: '2026-12-01T00:00:00Z' })).toBe(false);
  });

  it('evaluates operators and the empty filter', () => {
    const yes = { subject: 'invoice' };
    const no = { subject: 'vacation' };
    expect(matches(mail(), null)).toBe(true);
    expect(matches(mail(), { operator: 'AND', conditions: [yes, no] })).toBe(false);
    expect(matches(mail(), { operator: 'OR', conditions: [yes, no] })).toBe(true);
    expect(matches(mail(), { operator: 'NOT', conditions: [no] })).toBe(true);
  });
});

describe('markSubject', () => {
  it('marks hits like `SearchSnippet/get` and escapes the rest', () => {
    expect(markSubject('A & B <Invoice>', ['inv'])).toBe('A &#38; B &#60;<mark>Inv</mark>oice&#62;');
    expect(markSubject('Hello World', ['hel', 'ello', 'world'])).toBe('<mark>Hello</mark> <mark>World</mark>');
  });

  it('returns nothing without hits', () => {
    expect(markSubject('Hello', [])).toBeNull();
    expect(markSubject('Hello', ['x'])).toBeNull();
  });
});

describe('localPage', () => {
  it('returns the hits newest first, as a page from the store', () => {
    const page = localPage(
      [mail({ id: 'old', receivedAt: 1 }), mail({ id: 'new', receivedAt: 2 }), mail({ id: 'x', subject: 'Vacation' })],
      'k1',
      { subject: 'inv' },
      ['inv'],
    );
    expect(page).toMatchObject({ positions: 2, total: 2, local: true });
    expect(page.hits.map((h) => h.id)).toEqual(['new', 'old']);
    expect(page.hits[0]).toMatchObject({
      account: 'k1',
      mailboxIds: { m1: true },
      receivedAt: '1970-01-01T00:00:00.002Z',
      snippet: '<mark>Inv</mark>oice Zürich',
    });
  });

  it('caps at the limit', () => {
    const many = Array.from({ length: MAX_LOCAL_HITS + 1 }, (_, i) => mail({ id: `e${i}` }));
    expect(localPage(many, 'k1', null, []).total).toBe(MAX_LOCAL_HITS);
  });
});

describe('savedMails', () => {
  const row = (id: string, over: Partial<ListThread> = {}) =>
    ({
      id,
      threadId: `t-${id}`,
      receivedAt: 5,
      from: [],
      to: [],
      subject: `Row ${id}`,
      preview: '',
      mailboxIds: ['m1', 'm2'],
      hasAttachment: true,
      members: [{ id, mailboxIds: ['m2'], keywords: { $flagged: true }, from: '' }],
      ...over,
    }) as ListThread;

  const store = (lists: Partial<SavedList>[], heads: Partial<ThreadHead>[] = []) =>
    ({
      lists: () => Promise.resolve(lists),
      heads: () => Promise.resolve(heads),
    }) as unknown as Pick<MailStore, 'lists' | 'heads'>;

  it('combines lists and conversations, each email once', async () => {
    const mails = await savedMails(
      store(
        [{ threads: [row('e1'), row('e2')] }, { threads: [row('e1')] }],
        [{ threadId: 't-e1', mails: [mail({ id: 'e1' }), mail({ id: 'e3' })] }],
      ),
      'k1',
    );
    expect(mails.map((x) => x.id).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(mails.find((x) => x.id === 'e1')).toMatchObject({
      subject: 'Invoice Zürich',
      attachments: ['a.pdf'],
      // The row knows the fresher state.
      keywords: { $flagged: true },
      mailboxIds: ['m2'],
    });
    expect(mails.find((x) => x.id === 'e2')).toMatchObject({
      threadId: 't-e2',
      mailboxIds: ['m2'],
      keywords: { $flagged: true },
      attachments: [],
    });
  });

  it('does without a store', async () => {
    expect(await savedMails(null, 'k1')).toEqual([]);
  });
});
