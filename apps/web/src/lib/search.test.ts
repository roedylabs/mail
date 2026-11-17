import { describe, expect, it, vi } from 'vitest';
import type { TimeContext } from '#lib/mail-list.ts';
import { filterChips, SF0, type SearchFilter } from '#lib/search-filter.ts';
import {
  GROUP_ROWS,
  highlight,
  mailItems,
  markParts,
  norm,
  resultsValues,
  score,
  scoreAll,
  searchCats,
  suggestGroups,
  SUGGEST_ROWS,
  termsOf,
  type Candidate,
  type HitBox,
  type MailContext,
  type MailHit,
  type ResultsInput,
  type ScoredItem,
  type SearchCat,
  type SearchGroup,
} from '#lib/search.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const TIME: TimeContext = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' };

function hit(id: string, over: Partial<MailHit> = {}): MailHit {
  return {
    account: 'k1',
    id,
    threadId: `t-${id}`,
    mailboxIds: { in: true },
    keywords: {},
    receivedAt: '2026-11-02T09:00:00Z',
    from: [{ name: 'Anna Berger', email: 'anna@example.com' }],
    to: [{ name: 'Ben Kurz', email: 'ben@example.com' }],
    subject: 'Invoice October',
    attachments: [],
    snippet: null,
    ...over,
  };
}

const INBOX: HitBox = { label: 'Inbox', role: 'inbox', target: { role: 'inbox' } };

function ctx(box: HitBox | null = INBOX, over: Partial<MailContext> = {}): MailContext {
  return { time: TIME, multi: false, email: () => 'a1@example.com', box: () => box, open: vi.fn(), ...over };
}

describe('norm and termsOf', () => {
  it('spells out umlauts and removes accents', () => {
    expect(norm('Gr\u00f6\u00dfe Caf\u00e9')).toBe('groesse cafe');
  });

  it('splits at spaces, raw in lower case and in comparison form', () => {
    expect(termsOf('  \u00dcber  May ')).toEqual({ raw: ['\u00fcber', 'may'], terms: ['ueber', 'may'] });
  });
});

describe('score', () => {
  it('scores equal, start, word start, contained and extra', () => {
    expect(score('Folder', '', ['folder'])).toBe(100);
    expect(score('Folder settings', '', ['fol'])).toBe(80);
    expect(score('New folder', '', ['fol'])).toBe(60);
    expect(score('Subfolder', '', ['fol'])).toBe(40);
    expect(score('Appearance', 'theme dark', ['dark'])).toBe(15);
  });

  it('requires every word and averages', () => {
    expect(score('New email', 'compose', ['new', 'xyz'])).toBe(-1);
    expect(score('New email', 'compose', ['new', 'comp'])).toBe((80 + 15) / 2);
  });

  it('also splits words at punctuation', () => {
    expect(score('team@example.com', '', ['example'])).toBe(60);
  });

  it('without words 1', () => {
    expect(score('anything', '', [])).toBe(1);
  });
});

describe('highlight', () => {
  it('merges overlapping hits and keeps the spelling', () => {
    expect(highlight('Invoice Invoices', ['inv', 'nvoice'])).toEqual([
      { t: 'Invoice', hl: true },
      { t: ' ', hl: false },
      { t: 'Invoice', hl: true },
      { t: 's', hl: false },
    ]);
  });

  it('without a hit one part', () => {
    expect(highlight('Hello', ['xyz'])).toEqual([{ t: 'Hello', hl: false }]);
  });
});

describe('markParts', () => {
  it('reads <mark> and entities of the snippet', () => {
    expect(markParts('Your <mark>Invoice</mark> &amp; reminder &#x27;Q3&#39;')).toEqual([
      { t: 'Your ', hl: false },
      { t: 'Invoice', hl: true },
      { t: " & reminder 'Q3'", hl: false },
    ]);
  });

  it('null without a snippet or without hits', () => {
    expect(markParts(null)).toBeNull();
    expect(markParts('Just text')).toBeNull();
  });
});

describe('mailItems', () => {
  it('row with sender, folder, time, unread and snippet', () => {
    const c = ctx();
    const [row] = mailItems([hit('e1', { snippet: '<mark>Invoice</mark> October' })], termsOf('invoice'), c);
    expect(row).toMatchObject({
      cat: 'mail',
      label: 'Invoice October',
      icon: 'ti-mail',
      path: 'Anna Berger · Inbox',
      side: '10:00',
      unread: true,
      parts: [
        { t: 'Invoice', hl: true },
        { t: ' October', hl: false },
      ],
      score: 80,
    });
    expect(row?.av?.text).toBe('AB');
    row?.run();
    expect(c.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), INBOX);
  });

  it('outgoing the recipients, drafts without recipients "Draft", with account when several', () => {
    const sent: HitBox = { label: 'Sent', role: 'sent', target: { role: 'sent' } };
    const drafts: HitBox = { label: 'Drafts', role: 'drafts', target: { role: 'drafts' } };
    const [a] = mailItems([hit('e1')], termsOf(''), ctx(sent, { multi: true }));
    expect(a?.path).toBe('Ben Kurz · Sent · a1@example.com');
    expect(a?.unread).toBe(false);
    const [b] = mailItems([hit('e2', { to: [], subject: null })], termsOf(''), ctx(drafts));
    expect(b).toMatchObject({ path: 'Draft · Drafts', icon: 'ti-file-pencil', label: '(No subject)' });
    const [c] = mailItems([hit('e3', { from: null })], termsOf(''), ctx());
    expect(c?.path).toBe('Unknown · Inbox');
    const [d] = mailItems([hit('e4')], termsOf(''), ctx(null));
    expect(d?.path).toBe('Anna Berger');
  });

  it('without a sender or recipient a tile with the icon instead of initials', () => {
    const sent: HitBox = { label: 'Sent', role: 'sent', target: { role: 'sent' } };
    const drafts: HitBox = { label: 'Drafts', role: 'drafts', target: { role: 'drafts' } };
    const [draft] = mailItems([hit('e1', { to: [] })], termsOf(''), ctx(drafts));
    expect(draft).toMatchObject({ path: 'Draft · Drafts', icon: 'ti-file-pencil' });
    expect(draft?.av).toBeUndefined();
    const [unknown] = mailItems([hit('e2', { from: null })], termsOf(''), ctx());
    expect(unknown).toMatchObject({ path: 'Unknown · Inbox', icon: 'ti-mail' });
    expect(unknown?.av).toBeUndefined();
    const [noRcpt] = mailItems([hit('e3', { to: null })], termsOf(''), ctx(sent));
    expect(noRcpt).toMatchObject({ path: 'No recipient · Sent', icon: 'ti-mail' });
    expect(noRcpt?.av).toBeUndefined();
    // Without letters for initials, too.
    const [digits] = mailItems([hit('e4', { from: [{ name: '1&1', email: '' }] })], termsOf(''), ctx());
    expect(digits?.av).toBeUndefined();
    const row = resultsValues(input({ items: [{ ...unknown!, score: 1 }] })).groups[0]?.rows[0];
    expect(row).toMatchObject({ hasAv: false, round: false, plain: true, tileBg: 'var(--surface)', icon: 'ti-mail' });
  });

  it('times 2 to 6 days ahead with a comma between weekday and time', () => {
    const at = (iso: string) => mailItems([hit('e1', { receivedAt: iso })], termsOf(''), ctx())[0]?.side;
    expect(at('2026-11-02T09:00:00Z')).toBe('10:00');
    expect(at('2026-11-01T09:00:00Z')).toBe('Yesterday');
    expect(at('2026-11-03T07:00:00Z')).toBe('Tomorrow, 08:00');
    expect(at('2026-11-05T07:00:00Z')).toBe('Thu, 08:00');
    expect(at('2026-11-08T07:00:00Z')).toBe('Sun, 08:00');
    expect(at('2026-10-29T07:00:00Z')).toBe('Thursday');
    expect(at('2026-11-09T07:00:00Z')).toBe('9 Nov');
    expect(at('2025-12-24T07:00:00Z')).toBe('24.12.25');
  });

  it('hits only in the text count 15, in the sender at least 55', () => {
    const [body] = mailItems([hit('e1')], termsOf('reminder'), ctx());
    expect(body?.score).toBe(15);
    const [from] = mailItems([hit('e1')], termsOf('anna'), ctx());
    expect(from?.score).toBe(55);
  });

  it('attachments only with a matching name and only with words or category', () => {
    const h = hit('e1', { attachments: ['invoice.pdf', 'logo.png'] });
    const items = mailItems([h], termsOf('invoice'), ctx());
    expect(items.filter((i) => i.cat === 'files')).toEqual([
      expect.objectContaining({
        label: 'invoice.pdf',
        icon: 'ti-file-type-pdf',
        path: 'Anna Berger · Invoice October',
      }),
    ]);
    expect(mailItems([h], termsOf(''), ctx()).filter((i) => i.cat === 'files')).toEqual([]);
    expect(mailItems([h], termsOf(''), ctx(), true).filter((i) => i.cat === 'files')).toHaveLength(2);
  });
});

function item(cat: ScoredItem['cat'], id: string, score = 50, t = 0): ScoredItem {
  return { cat, id, label: id, icon: 'ti-folder', path: '', score, t, run: vi.fn() };
}

function input(over: Partial<ResultsInput> = {}): ResultsInput {
  return {
    q: 'x',
    terms: termsOf('x'),
    allowed: searchCats(true),
    cats: [],
    mailF: false,
    chips: [],
    items: [],
    mailTotal: null,
    setCats: vi.fn(),
    clearFilters: vi.fn(),
    done: vi.fn(),
    ...over,
  };
}

describe('resultsValues', () => {
  it('idle without words, filters and category', () => {
    const v = resultsValues(input({ q: '', terms: termsOf('') }));
    expect(v).toMatchObject({ idle: true, active: false, pills: [], groups: [], has: false, empty: false });
    expect(v.countText).toBe('Enter a search term or choose filters.');
    expect(v.title).toBe('Filtered search');
  });

  it('groups by best score, at most five rows, "Show all ‹n›"', () => {
    const folders = Array.from({ length: 7 }, (_, i) => item('folders', `f${i}`, 40));
    const set = input({ items: [...folders, item('settings', 's1', 90)] });
    const v = resultsValues(set);
    expect(v.title).toBe('“x”');
    expect(v.countText).toBe('8 results');
    expect(v.groups.map((g) => g.cat)).toEqual(['settings', 'folders']);
    const fg = v.groups[1]!;
    expect(fg.rows).toHaveLength(GROUP_ROWS);
    expect(fg).toMatchObject({ n: '7', hasMore: true, moreLabel: 'Show all 7', canLoad: false });
    fg.more();
    expect(set.setCats).toHaveBeenCalledWith(['folders']);
    expect(v.pills.map((p) => [p.label, p.n, p.on])).toEqual([
      ['All', '8', true],
      ['Folders', '7', false],
      ['Settings', '1', false],
    ]);
  });

  it('one category shows all rows; messages count by the server and load more', () => {
    const mails = Array.from({ length: 6 }, (_, i) => item('mail', `m${i}`, 15, i));
    const set = input({ cats: ['mail'], items: [...mails, item('folders', 'f1')], mailTotal: 120 });
    const v = resultsValues(set);
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]).toMatchObject({ n: '120', hasMore: false, canLoad: true });
    expect(v.groups[0]!.rows.map((r) => r.key)).toEqual([
      'mail:m5',
      'mail:m4',
      'mail:m3',
      'mail:m2',
      'mail:m1',
      'mail:m0',
    ]);
    expect(v.countText).toBe('120 results');
    const pill = v.pills.find((p) => p.cat === 'mail')!;
    expect(pill.on).toBe(true);
    pill.onClick();
    expect(set.setCats).toHaveBeenCalledWith([]);
  });

  const chipsOf = (sf: Partial<SearchFilter>) =>
    filterChips({ ...SF0, ...sf }, { email: () => null, folder: () => null, tag: () => null }, vi.fn());

  it('a filter for messages restricts to messages and attachments, with a chip', () => {
    const set = input({
      q: '',
      terms: termsOf(''),
      mailF: true,
      chips: chipsOf({ from: 'anna@example.com' }),
      items: [item('mail', 'm1'), item('folders', 'f1')],
    });
    const v = resultsValues(set);
    expect(v).toMatchObject({ idle: false, hasChips: true, qfOn: true });
    expect(v.groups.map((g) => g.cat)).toEqual(['mail']);
    expect(v.chips.map((c) => [c.label, c.aria])).toEqual([
      ['From: anna@example.com', 'Remove From: anna@example.com'],
    ]);
  });

  it('chips without categories; the quick filters appear only with another filter', () => {
    const v = resultsValues(input({ cats: ['mail'], chips: chipsOf({ cats: ['mail'], st: ['u'], time: '30d' }) }));
    expect(v.chips.map((c) => c.label)).toEqual(['Unread', 'Date: 30 days']);
    expect(v.qfOn).toBe(true);
    expect(resultsValues(input({ cats: ['mail'], chips: chipsOf({ cats: ['mail'] }) })).qfOn).toBe(false);
    expect(resultsValues(input()).qfOn).toBe(false);
  });

  it('empty state depending on filters; administration only if allowed', () => {
    expect(resultsValues(input()).emptyText).toBe('Check the spelling or try a different search term.');
    expect(resultsValues(input({ mailF: true, chips: chipsOf({ from: 'x@example.org' }) })).emptyText).toBe(
      'Try fewer filters or a different search term.',
    );
    // Only a category: no filter on the results page, but in the suggestions.
    const cat = resultsValues(input({ cats: ['mail'], chips: chipsOf({ cats: ['mail'] }) }));
    expect(cat).toMatchObject({
      emptyText: 'Check the spelling or try a different search term.',
      suggestEmptyText: 'Try fewer filters or a different search term.',
      hasChips: false,
    });
    const both = resultsValues(input({ cats: ['mail'], chips: chipsOf({ cats: ['mail'], st: ['u'] }) }));
    expect(both).toMatchObject({
      emptyText: 'Try fewer filters or a different search term.',
      suggestEmptyText: 'Try fewer filters or a different search term.',
      hasChips: true,
    });
    expect(resultsValues(input()).suggestEmptyText).toBe('Check the spelling or try a different search term.');
    const v = resultsValues(input({ allowed: searchCats(false), items: [item('admin', 'a1')] }));
    expect(v.empty).toBe(true);
  });

  it('row: highlighting, meta with description, executing first remembers the search', () => {
    const run = vi.fn();
    const done = vi.fn(() => expect(run).not.toHaveBeenCalled());
    const r: ScoredItem = {
      ...item('settings', 'Appearance'),
      path: 'Settings',
      desc: 'Colors',
      unread: true,
      run,
    };
    const row = resultsValues(input({ q: 'app', terms: termsOf('app'), items: [r], done })).groups[0]!.rows[0]!;
    expect(row).toMatchObject({
      meta: 'Settings · Colors',
      fw: 800,
      round: false,
      tileBg: 'var(--surface)',
      parts: [
        { t: 'App', hl: true },
        { t: 'earance', hl: false },
      ],
    });
    row.run();
    expect(done).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });
});

describe('rows of the search suggestions', () => {
  const rowOf = (r: ScoredItem) => resultsValues(input({ items: [r] })).groups[0]!.rows[0]!;

  it('subline: description before path, none for actions', () => {
    expect(rowOf({ ...item('settings', 'Appearance'), path: 'Settings', desc: 'Colors' }).sub).toBe('Colors');
    expect(rowOf({ ...item('settings', 'Profile'), path: 'Account' }).sub).toBe('Account');
    expect(rowOf({ ...item('folders', 'Projects'), path: 'k1@example.com', desc: '' }).sub).toBe('k1@example.com');
    expect(rowOf({ ...item('folders', 'Empty') }).sub).toBe('');
    expect(rowOf({ ...item('actions', 'New email'), path: 'Actions', desc: 'Compose', k: 'N' })).toMatchObject({
      sub: '',
      meta: 'Actions · Compose',
      k: 'N',
    });
  });

  it('"plain" without own colours, not with avatar or tile', () => {
    expect(rowOf(item('folders', 'Projects'))).toMatchObject({ plain: true, round: false, hasAv: false });
    const av = { text: 'AB', bg: '#123', ink: '#fff' };
    expect(rowOf({ ...item('contacts', 'Anna'), av })).toMatchObject({ plain: false, round: true, tileBg: '#123' });
    const tile = { bg: '#e0f', ink: '#306' };
    expect(rowOf({ ...item('tags', 'Important'), tile })).toMatchObject({ plain: false, round: false, tileBg: '#e0f' });
  });
});

describe('suggestGroups', () => {
  /** Group of a category with `rows` rows, as `resultsValues` returns it. */
  const group = (cat: SearchCat, rows: number, n?: string): SearchGroup => {
    const items = Array.from({ length: rows }, (_, i) => item(cat, `${cat}${i}`));
    const g = resultsValues(input({ cats: [cat], items })).groups[0]!;
    return n ? { ...g, n } : g;
  };
  const sizes = (list: SearchGroup[]) => list.map((g) => [g.cat, g.rows.length]);

  it('one group up to nine rows, the number stays', () => {
    expect(SUGGEST_ROWS).toBe(9);
    const [g] = suggestGroups([group('folders', 12, '120')]);
    expect(g).toMatchObject({ cat: 'folders', n: '120' });
    expect(g!.rows.map((r) => r.key)).toEqual(Array.from({ length: 9 }, (_, i) => `folders:folders${i}`));
    expect(sizes(suggestGroups([group('folders', 4)]))).toEqual([['folders', 4]]);
  });

  it('two groups at most five each, nine together', () => {
    const out = suggestGroups([group('settings', 5, '7'), group('folders', 8, '12')]);
    expect(sizes(out)).toEqual([
      ['settings', 5],
      ['folders', 4],
    ]);
    expect(out.map((g) => g.n)).toEqual(['7', '12']);
    expect(sizes(suggestGroups([group('settings', 2), group('folders', 8)]))).toEqual([
      ['settings', 2],
      ['folders', 5],
    ]);
  });

  it('three and more groups three each, up to nine in total', () => {
    expect(
      sizes(suggestGroups([group('contacts', 1), group('folders', 5), group('tags', 5), group('settings', 5)])),
    ).toEqual([
      ['contacts', 1],
      ['folders', 3],
      ['tags', 3],
      ['settings', 2],
    ]);
    // The fourth group gets no row any more and drops out.
    expect(
      sizes(suggestGroups([group('contacts', 4), group('folders', 4), group('tags', 4), group('settings', 4)])),
    ).toEqual([
      ['contacts', 3],
      ['folders', 3],
      ['tags', 3],
    ]);
  });

  it('groups without rows drop out; the input stays unchanged', () => {
    expect(suggestGroups([])).toEqual([]);
    const empty = { ...group('folders', 1), rows: [] };
    const big = group('settings', 7);
    const out = suggestGroups([empty, big]);
    expect(out.map((g) => g.cat)).toEqual(['settings']);
    // The empty group does not count: the one remaining gets all 7 rows, not only 5.
    expect(out[0]!.rows).toHaveLength(7);
    expect(out[0]).not.toBe(big);
    expect(out[0]!.more).toBe(big.more);
    expect(big.rows).toHaveLength(7);
  });

  it('from the results: order by best score stays', () => {
    const folders = Array.from({ length: 7 }, (_, i) => item('folders', `f${i}`, 40));
    const v = resultsValues(input({ items: [...folders, item('settings', 's1', 90)] }));
    expect(sizes(suggestGroups(v.groups))).toEqual([
      ['settings', 1],
      ['folders', 5],
    ]);
  });
});

describe('scoreAll', () => {
  it('omits candidates without hits', () => {
    const c = (label: string, extra = ''): Candidate => ({ ...item('actions', label), extra });
    const out = scoreAll([c('Sign out', 'logout'), c('New email')], termsOf('logout').terms);
    expect(out.map((o) => [o.label, o.score])).toEqual([['Sign out', 15]]);
  });
});
