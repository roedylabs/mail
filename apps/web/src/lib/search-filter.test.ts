import { describe, expect, it, vi } from 'vitest';
import {
  effective,
  filterChips,
  folderKey,
  mobileChips,
  parseFolderKey,
  parseQuery,
  quickFilters,
  scoped,
  searchOps,
  SF0,
  tileFilters,
  timeAfter,
  withOp,
  type FilterEnv,
  type FilterPatch,
  type SearchFilter,
  type SearchScope,
} from '#lib/search-filter.ts';
import { searchCats } from '#lib/search.ts';

const NOW = Date.parse('2026-11-02T10:30:45Z');
const TZ = 'Europe/Berlin';

const env: FilterEnv = {
  accounts: [
    { id: 'k1', email: 'anna@example.com' },
    { id: 'k2', email: 'team@company.example' },
  ],
  allowed: searchCats(false),
  folders: [
    { key: 'role:inbox', label: 'Inbox' },
    { key: 'role:trash', label: 'Trash' },
    { key: folderKey('k1', 'p1'), label: 'Projects' },
    { key: folderKey('k2', 'p2'), label: 'Projects' },
  ],
  tags: [
    { id: 't1', label: 'Important' },
    { id: 't2', label: 'Private' },
  ],
  folderBoxes: (key, account) => {
    if (key === 'role:inbox') return [`${account}-in`];
    if (key === folderKey('k1', 'p1') && account === 'k1') return ['p1', 'p1a'];
    if (key === folderKey('k2', 'p2') && account === 'k2') return ['p2'];
    return [];
  },
  tagBoxes: (tag, account) => (tag === 't1' ? (account === 'k1' ? ['tg1', 'tg1a'] : ['tg2']) : []),
  tz: TZ,
};

const sf = (over: Partial<SearchFilter> = {}): SearchFilter => ({ ...SF0, ...over });
const filterOf = (eff: ReturnType<typeof effective>, account: string) =>
  eff.queries.find((q) => q.account === account)?.filter;

describe('parseQuery', () => {
  it('splits words and operators', () => {
    const { terms, ops } = parseQuery(
      'Report from:Anna in:inb tag:imp is:unread has:x account:company type:Mess \u00dcber',
    );
    expect(terms).toEqual({ raw: ['report', '\u00fcber'], terms: ['report', 'ueber'] });
    expect(ops).toEqual({ from: 'Anna', in: 'inb', tag: 'imp', account: 'company', type: 'Mess', st: ['u', 'at'] });
    expect(parseQuery('is:starred is:flagged is:attachment is:nonsense').ops.st).toEqual(['st', 'st', 'at', 'x']);
    // Without a value the operator stays a word.
    expect(parseQuery('from: x').terms.raw).toEqual(['from:', 'x']);
  });
});

describe('parseFolderKey', () => {
  it('role, custom folder or nothing', () => {
    expect(parseFolderKey('role:spam')).toEqual({ role: 'spam' });
    expect(parseFolderKey(folderKey('k1', 'a:b'))).toEqual({ account: 'k1', id: 'a:b' });
    expect(parseFolderKey('role:archiv')).toBeNull();
    expect(parseFolderKey('f:1')).toBeNull();
  });
});

describe('effective', () => {
  it('without filters a text filter per word in every account, no filter for messages', () => {
    const eff = effective(SF0, 'a b', env, NOW);
    expect(eff.mailF).toBe(false);
    expect(eff.queries).toEqual([
      { account: 'k1', filter: { operator: 'AND', conditions: [{ text: 'a' }, { text: 'b' }] } },
      { account: 'k2', filter: { operator: 'AND', conditions: [{ text: 'a' }, { text: 'b' }] } },
    ]);
    expect(effective(SF0, '', env, NOW).queries).toEqual([
      { account: 'k1', filter: null },
      { account: 'k2', filter: null },
    ]);
  });

  it('status, sender, time range and "Search in" as conditions', () => {
    const eff = effective(
      sf({ st: ['u', 'st', 'at'], from: ' anna ', time: '7d', fields: ['s', 'att'] }),
      'x',
      env,
      NOW,
    );
    expect(eff.mailF).toBe(true);
    expect(filterOf(eff, 'k1')).toEqual({
      operator: 'AND',
      conditions: [
        {
          operator: 'OR',
          conditions: [{ subject: 'x' }, { operator: 'AND', conditions: [{ hasAttachment: true }, { text: 'x' }] }],
        },
        { from: 'anna' },
        { notKeyword: '$seen' },
        { hasKeyword: '$flagged' },
        { hasAttachment: true },
        { after: '2026-10-26T10:30:00Z' },
      ],
    });
    expect(filterOf(effective(sf({ fields: ['body'] }), 'x', env, NOW), 'k1')).toEqual({ body: 'x' });
  });

  it('folder: mailbox in all accounts, custom folder with subfolders only in its account', () => {
    const inbox = effective(sf({ folder: 'role:inbox' }), '', env, NOW);
    expect(inbox.queries).toEqual([
      { account: 'k1', filter: { inMailbox: 'k1-in' } },
      { account: 'k2', filter: { inMailbox: 'k2-in' } },
    ]);
    const own = effective(sf({ folder: folderKey('k1', 'p1') }), '', env, NOW);
    expect(own.queries).toEqual([
      { account: 'k1', filter: { operator: 'OR', conditions: [{ inMailbox: 'p1' }, { inMailbox: 'p1a' }] } },
    ]);
    // Trash missing in both accounts: nothing to ask.
    expect(effective(sf({ folder: 'role:trash' }), '', env, NOW).queries).toEqual([]);
  });

  it('tags with subtags per account; account restricts', () => {
    const eff = effective(sf({ tags: ['t1'], account: 'k2' }), '', env, NOW);
    expect(eff.queries).toEqual([{ account: 'k2', filter: { inMailbox: 'tg2' } }]);
    expect(effective(sf({ tags: ['t2'] }), '', env, NOW).queries).toEqual([]);
  });

  it('operators replace account and folder, add tags, `type:` chooses the category', () => {
    const eff = effective(
      sf({ account: 'k1', folder: folderKey('k1', 'p1') }),
      'account:COMPANY in:Inb tag:im type:fold',
      env,
      NOW,
    );
    expect(eff.terms.raw).toEqual([]);
    expect(eff.cats).toEqual(['folders']);
    expect(eff.queries).toEqual([
      { account: 'k2', filter: { operator: 'AND', conditions: [{ inMailbox: 'k2-in' }, { inMailbox: 'tg2' }] } },
    ]);
    // Administration is not a category without permissions: `type:` has no effect.
    expect(effective(SF0, 'type:admin', env, NOW).cats).toEqual([]);
    expect(effective(SF0, 'from:Anna', env, NOW).queries[0]).toEqual({ account: 'k1', filter: { from: 'Anna' } });
  });

  it('`in:` means folders of the same name in all accounts', () => {
    expect(effective(SF0, 'in:proj', env, NOW).queries).toEqual([
      { account: 'k1', filter: { operator: 'OR', conditions: [{ inMailbox: 'p1' }, { inMailbox: 'p1a' }] } },
      { account: 'k2', filter: { inMailbox: 'p2' } },
    ]);
  });

  it('unknown account, folder, tag or status: no query, but a filter for messages', () => {
    for (const q of ['account:nobody', 'in:nowhere', 'tag:missing', 'is:nonsense']) {
      const eff = effective(SF0, `invoice ${q}`, env, NOW);
      expect([q, eff.queries, eff.mailF]).toEqual([q, [], true]);
    }
  });
});

describe('timeAfter', () => {
  it('today and this year in the time zone, otherwise days back; to the minute', () => {
    expect(timeAfter('any', NOW, TZ)).toBeNull();
    expect(new Date(timeAfter('today', NOW, TZ)!).toISOString()).toBe('2026-11-01T23:00:00.000Z');
    expect(new Date(timeAfter('today', NOW, 'America/New_York')!).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(new Date(timeAfter('30d', NOW, TZ)!).toISOString()).toBe('2026-10-03T10:30:00.000Z');
    expect(new Date(timeAfter('year', NOW, TZ)!).toISOString()).toBe('2025-12-31T23:00:00.000Z');
  });
});

describe('filterChips', () => {
  const names = {
    email: (id: string) => (id === 'k1' ? 'anna@example.com' : null),
    folder: (key: string) => (key === 'role:inbox' ? 'Inbox' : null),
    tag: (id: string) => (id === 't1' ? 'Important' : null),
  };

  it('one chip per filter in a fixed order', () => {
    const chips = filterChips(
      sf({
        cats: ['mail'],
        account: 'k1',
        folder: 'role:inbox',
        tags: ['t1', 'tx'],
        st: ['at', 'u'],
        time: 'year',
        from: ' anna ',
        fields: ['s', 'body'],
      }),
      names,
      vi.fn(),
    );
    expect(chips.map((c) => [c.key, c.label, c.cat])).toEqual([
      ['cat:mail', 'Messages only', true],
      ['account', 'Account: anna@example.com', false],
      ['folder', 'Folder: Inbox', false],
      ['tag:t1', 'Tag: Important', false],
      ['tag:tx', 'Tag: tx', false],
      ['st:at', 'Attachment', false],
      ['st:u', 'Unread', false],
      ['time:year', 'Date: This year', false],
      ['from', 'From: anna', false],
      ['fields', 'Only in: Subject, Body', false],
    ]);
    expect(chips[1]!.aria).toBe('Remove Account: anna@example.com');
    expect(filterChips(SF0, names, vi.fn())).toEqual([]);
  });

  it('removing resets only this filter and stops the event', () => {
    const set = vi.fn<(patch: FilterPatch) => void>();
    const cur = sf({ cats: ['mail', 'files'], tags: ['t1', 't2'], st: ['u', 'st'], time: '7d' });
    const chips = filterChips(cur, names, set);
    const event = new Event('click');
    const stop = vi.spyOn(event, 'stopPropagation');
    chips.find((c) => c.key === 'tag:t1')!.remove(event);
    expect(stop).toHaveBeenCalled();
    const apply = (i: number) => {
      const p = set.mock.calls[i]![0];
      return typeof p === 'function' ? p(cur) : p;
    };
    expect(apply(0)).toEqual({ tags: ['t2'] });
    chips.find((c) => c.key === 'cat:mail')!.remove();
    expect(apply(1)).toEqual({ cats: ['files'] });
    chips.find((c) => c.key === 'st:st')!.remove();
    expect(apply(2)).toEqual({ st: ['u'] });
    chips.find((c) => c.key === 'time:7d')!.remove();
    expect(apply(3)).toEqual({ time: 'any' });
  });
});

describe('mobileChips', () => {
  it('without the chips of the quick filters and without the categories', () => {
    const chips = filterChips(
      sf({ cats: ['mail'], st: ['u', 'at'], time: '30d', from: 'x' }),
      { email: () => null, folder: () => null, tag: () => null },
      vi.fn(),
    );
    expect(mobileChips(chips).map((c) => c.label)).toEqual(['Date: 30 days', 'From: x']);
    const today = filterChips(
      sf({ time: 'today' }),
      { email: () => null, folder: () => null, tag: () => null },
      vi.fn(),
    );
    expect(mobileChips(today)).toEqual([]);
  });
});

describe('quickFilters', () => {
  it('status and time ranges to toggle', () => {
    let cur = sf({ st: ['st'], time: 'today' });
    const set = (patch: FilterPatch) => {
      cur = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    };
    const quick = quickFilters(cur, set);
    expect(quick.map((q) => [q.label, q.icon, q.on])).toEqual([
      ['Unread', 'ti-mail', false],
      ['Flagged', 'ti-star', true],
      ['Attachment', 'ti-paperclip', false],
      ['Today', 'ti-calendar-event', true],
      ['Last 7 days', 'ti-calendar-week', false],
    ]);
    quick[0]!.onClick();
    quick[1]!.onClick();
    expect(cur.st).toEqual(['u']);
    quick[4]!.onClick();
    expect(cur.time).toBe('7d');
    quickFilters(cur, set)[4]!.onClick();
    expect(cur.time).toBe('any');
  });
});

describe('tileFilters', () => {
  it('without trash and spam; without known mailboxes only the condition', () => {
    expect(tileFilters([], NOW, TZ)).toEqual([
      { notKeyword: '$seen' },
      { hasKeyword: '$flagged' },
      { hasAttachment: true },
      { after: '2026-11-01T23:00:00Z', before: '2026-11-02T23:00:00Z' },
    ]);
    expect(tileFilters(['tr'], NOW, TZ)[2]).toEqual({
      operator: 'AND',
      conditions: [{ inMailboxOtherThan: ['tr'] }, { hasAttachment: true }],
    });
  });
});

describe('scoped', () => {
  const inbox: SearchScope = {
    here: 'In Inbox only',
    icon: 'ti-inbox',
    patch: { folder: 'role:inbox', account: null },
  };
  const own: SearchScope = {
    here: 'In Projects only',
    icon: 'ti-folder',
    patch: { folder: folderKey('k1', 'p1'), account: 'k1' },
  };

  it('unchanged without a scope, the same object', () => {
    const f = sf({ st: ['u'], from: 'anna' });
    expect(scoped(f, null)).toBe(f);
    expect(scoped(SF0, null)).toBe(SF0);
  });

  it('supplements fields at the default, the others stay; the input stays untouched', () => {
    const f = sf({ st: ['u'], from: 'anna', time: '7d', fields: ['s'] });
    const out = scoped(f, inbox);
    expect(out).not.toBe(f);
    expect(out).toEqual({ ...f, folder: 'role:inbox', account: null });
    expect(f.folder).toBeNull();
    expect(scoped(SF0, own)).toEqual({ ...SF0, folder: 'box:k1:p1', account: 'k1' });
    expect([SF0.folder, SF0.account]).toEqual([null, null]);
    // Lists count as unset as long as they are empty.
    const settings: SearchScope = { here: 'Settings only', icon: 'ti-settings', patch: { cats: ['settings'] } };
    const tag: SearchScope = { here: 'Tag “Important” only', icon: 'ti-tag', patch: { tags: ['t1'] } };
    expect(scoped(SF0, settings).cats).toEqual(['settings']);
    expect(scoped(sf({ st: ['at'] }), tag)).toEqual(sf({ st: ['at'], tags: ['t1'] }));
  });

  it('set filters stay, per field', () => {
    // Custom folder set: the folder of the scope does not apply, the still free account does.
    expect(scoped(sf({ folder: 'role:trash' }), own)).toEqual(sf({ folder: 'role:trash', account: 'k1' }));
    expect(scoped(sf({ folder: 'role:trash', account: 'k2' }), own)).toEqual(
      sf({ folder: 'role:trash', account: 'k2' }),
    );
    expect(
      scoped(sf({ cats: ['mail'] }), { here: 'Settings only', icon: 'ti-settings', patch: { cats: ['settings'] } })
        .cats,
    ).toEqual(['mail']);
    expect(
      scoped(sf({ tags: ['t2'] }), { here: 'Tag “Important” only', icon: 'ti-tag', patch: { tags: ['t1'] } }).tags,
    ).toEqual(['t2']);
  });

  it('acts in effective like a set filter', () => {
    const eff = effective(scoped(sf(), own), 'report', env, NOW);
    expect(eff.mailF).toBe(true);
    expect(eff.queries.map((q) => q.account)).toEqual(['k1']);
    expect(filterOf(eff, 'k1')).toEqual({
      operator: 'AND',
      conditions: [{ text: 'report' }, { operator: 'OR', conditions: [{ inMailbox: 'p1' }, { inMailbox: 'p1a' }] }],
    });
  });
});

describe('withOp and searchOps', () => {
  it('appends the operator with a space before, after a complete operator also after it', () => {
    expect(withOp('', 'from:')).toBe('from:');
    expect(withOp('', 'is:unread')).toBe('is:unread ');
    expect(withOp('   ', 'has:attachment')).toBe('has:attachment ');
    expect(withOp('Report', 'tag:')).toBe('Report tag:');
    expect(withOp('Report  ', 'in:')).toBe('Report in:');
    expect(withOp('Report \t', 'is:unread')).toBe('Report is:unread ');
    // No double space after a complete operator.
    expect(withOp(withOp('Report', 'is:unread'), 'from:')).toBe('Report is:unread from:');
  });

  it('parseQuery knows every operator, open ones with an appended value', () => {
    expect(searchOps()).toEqual(['from:', 'tag:', 'in:', 'is:unread', 'has:attachment']);
    const opsOf = (op: string) => {
      const { terms, ops } = parseQuery(withOp('Report', op) + (op.endsWith(':') ? 'anna' : ''));
      expect(terms.raw).toEqual(['report']);
      return ops;
    };
    const none = { from: null, in: null, tag: null, account: null, type: null, st: [] };
    expect(searchOps().map(opsOf)).toEqual([
      { ...none, from: 'anna' },
      { ...none, tag: 'anna' },
      { ...none, in: 'anna' },
      { ...none, st: ['u'] },
      { ...none, st: ['at'] },
    ]);
  });

  it('understands account, category and flagged', () => {
    const { ops } = parseQuery('account:private type:mail is:flagged');
    expect(ops).toMatchObject({ account: 'private', type: 'mail', st: ['st'] });
  });
});
