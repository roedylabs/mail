import { MA_COLORS } from '@roedy/tokens';
import { describe, expect, it, vi } from 'vitest';
import { filterDims, panelGroups, SHEET_DIMS, type FilterInput } from '#lib/search-filter-options.ts';
import { folderKey, SF0, type FilterEnv, type FilterPatch, type SearchFilter } from '#lib/search-filter.ts';
import { searchCats } from '#lib/search.ts';

const env: FilterEnv = {
  accounts: [
    { id: 'k1', email: 'anna@example.com', color: 2 },
    { id: 'k2', email: 'team@company.example', color: 1 },
  ],
  allowed: searchCats(false),
  folders: [
    { key: 'role:inbox', label: 'Inbox', icon: 'ti-inbox' },
    { key: 'role:trash', label: 'Trash', icon: 'ti-trash' },
    { key: folderKey('k1', 'p1'), label: 'Projects', path: [] },
    { key: folderKey('k1', 'p1a'), label: 'Old', path: ['Projects'] },
    { key: folderKey('k2', 'p2'), label: 'Customers', path: [] },
  ],
  tags: [
    { id: 't1', label: 'Work', color: 3, path: [] },
    { id: 't1a', label: 'Customer A', color: 3, path: ['Work'] },
    { id: 't2', label: 'Private', color: 5, path: [] },
  ],
  folderBoxes: () => [],
  tagBoxes: () => [],
  tz: 'Europe/Berlin',
};

const senders = [
  { name: 'Anna Berg', email: 'anna@example.com' },
  { name: 'J\u00f6rg M\u00fcller', email: 'joerg@firm.example' },
  { name: '', email: 'info@shop.example' },
];

/** Filter with `set` like `search.set()`: changes end up in `state.sf`. */
function setup(over: Partial<SearchFilter> = {}, envOver: Partial<FilterEnv> = {}) {
  const state = { sf: { ...SF0, ...over } };
  const set = vi.fn((patch: FilterPatch) => {
    state.sf = { ...state.sf, ...(typeof patch === 'function' ? patch(state.sf) : patch) };
  });
  const input = (): FilterInput => ({ sf: state.sf, env: { ...env, ...envOver }, senders, set });
  return { state, set, input };
}

const dim = (input: FilterInput, key: string) => filterDims(input).find((d) => d.key === key)!;

describe('filterDims', () => {
  it('fixed order, account only with several accounts', () => {
    const { input } = setup();
    expect(filterDims(input()).map((d) => d.key)).toEqual([
      'cats',
      'account',
      'folder',
      'tags',
      'st',
      'time',
      'from',
      'fields',
    ]);
    const one = setup({}, { accounts: [env.accounts[0]!] });
    expect(filterDims(one.input()).map((d) => d.key)).not.toContain('account');
    expect(SHEET_DIMS).toEqual(['cats', 'account', 'folder', 'tags', 'from', 'fields']);
  });

  it('values without and with a choice', () => {
    const empty = filterDims(setup().input());
    expect(empty.map((d) => [d.key, d.value, d.def])).toEqual([
      ['cats', 'Everywhere', true],
      ['account', 'All accounts', true],
      ['folder', 'All folders', true],
      ['tags', 'All tags', true],
      ['st', 'All messages', true],
      ['time', 'Any time', true],
      ['from', 'Any sender', true],
      ['fields', 'All fields', true],
    ]);
    const { input } = setup({
      cats: ['mail', 'files', 'tags'],
      account: 'k2',
      folder: folderKey('k1', 'p1a'),
      tags: ['t1', 't2'],
      st: ['u', 'at'],
      time: '30d',
      from: ' anna ',
      fields: ['s', 'body'],
    });
    expect(filterDims(input()).map((d) => [d.value, d.def])).toEqual([
      ['3 categories', false],
      ['team@company.example', false],
      ['Old', false],
      ['Work & Private', false],
      ['Unread & Attachment', false],
      ['30 days', false],
      ['anna', false],
      ['Subject, Body', false],
    ]);
    expect(dim(setup({ cats: ['mail', 'files'] }).input(), 'cats').value).toBe('Messages & Attachments');
    expect(dim(setup({ tags: ['t1', 't1a', 't2'] }).input(), 'tags').value).toBe('3 tags');
  });

  it('toggle categories, "Everywhere" clears', () => {
    const { state, input } = setup();
    const cats = dim(input(), 'cats');
    expect(cats.opts.map((o) => o.label)).toEqual([
      'Everywhere',
      'Messages',
      'Contacts',
      'Attachments',
      'Folders',
      'Tags',
      'Settings',
      'Actions',
      'Notifications',
    ]);
    cats.opts[1]!.select();
    dim(input(), 'cats').opts[3]!.select();
    expect(state.sf.cats).toEqual(['mail', 'files']);
    dim(input(), 'cats').opts[1]!.select();
    expect(state.sf.cats).toEqual(['files']);
    dim(input(), 'cats').opts[0]!.select();
    expect(state.sf.cats).toEqual([]);
    expect(cats.opts.every((o) => !o.closes)).toBe(true);
  });

  it('choosing an account drops the custom folder of another account', () => {
    const { state, input } = setup({ folder: folderKey('k1', 'p1') });
    const acct = dim(input(), 'account');
    expect(acct.opts.map((o) => [o.label, o.dot, o.closes])).toEqual([
      ['All accounts', undefined, true],
      ['anna@example.com', MA_COLORS[2][1], true],
      ['team@company.example', MA_COLORS[1][1], true],
    ]);
    acct.opts[1]!.select();
    expect([state.sf.account, state.sf.folder]).toEqual(['k1', folderKey('k1', 'p1')]);
    dim(input(), 'account').opts[2]!.select();
    expect([state.sf.account, state.sf.folder]).toEqual(['k2', null]);
    state.sf = { ...state.sf, folder: 'role:inbox' };
    dim(input(), 'account').opts[1]!.select();
    expect(state.sf.folder).toBe('role:inbox');
  });

  it('folder: mailboxes, then custom folders of the chosen account with indentation', () => {
    const all = dim(setup().input(), 'folder');
    expect(all.opts.map((o) => [o.label, o.icon, o.depth])).toEqual([
      ['All folders', 'ti-folders', 0],
      ['Inbox', 'ti-inbox', 0],
      ['Trash', 'ti-trash', 0],
      ['Projects', 'ti-folder', 0],
      ['Old', 'ti-folder', 1],
      ['Customers', 'ti-folder', 0],
    ]);
    const { state, input } = setup({ account: 'k2' });
    const f = dim(input(), 'folder');
    expect(f.opts.map((o) => o.label)).toEqual(['All folders', 'Inbox', 'Trash', 'Customers']);
    f.opts[3]!.select();
    expect(state.sf.folder).toBe(folderKey('k2', 'p2'));
    expect(dim(input(), 'folder').opts[3]!.on).toBe(true);
    dim(input(), 'folder').opts[0]!.select();
    expect(state.sf.folder).toBeNull();
  });

  it('tags with colour and indentation, status with icons', () => {
    const { state, input } = setup();
    const tags = dim(input(), 'tags');
    expect(tags.opts.map((o) => [o.label, o.dot, o.depth])).toEqual([
      ['All tags', undefined, 0],
      ['Work', MA_COLORS[3][1], 0],
      ['Customer A', MA_COLORS[3][1], 1],
      ['Private', MA_COLORS[5][1], 0],
    ]);
    tags.opts[2]!.select();
    expect(state.sf.tags).toEqual(['t1a']);
    const st = dim(input(), 'st');
    expect(st.opts.map((o) => [o.label, o.icon])).toEqual([
      ['All messages', 'ti-mails'],
      ['Unread', 'ti-mail'],
      ['Flagged', 'ti-star'],
      ['Attachment', 'ti-paperclip'],
    ]);
    st.opts[2]!.select();
    dim(input(), 'st').opts[2]!.select();
    expect(state.sf.st).toEqual([]);
  });

  it('time range is a single choice', () => {
    const { state, input } = setup();
    const time = dim(input(), 'time');
    expect(time.opts.map((o) => [o.label, o.icon, o.on])).toEqual([
      ['Any time', 'ti-infinity', true],
      ['Today', 'ti-calendar-event', false],
      ['7 days', 'ti-calendar', false],
      ['30 days', 'ti-calendar', false],
      ['This year', 'ti-calendar', false],
    ]);
    time.opts[2]!.select();
    expect(state.sf.time).toBe('7d');
    expect(time.opts.every((o) => o.closes)).toBe(true);
  });

  it('sender: contacts for the input with avatar, chosen by address', () => {
    const none = dim(setup().input(), 'from');
    expect(none.opts.map((o) => o.label)).toEqual([
      'Any sender',
      'Anna Berg',
      'J\u00f6rg M\u00fcller',
      'info@shop.example',
    ]);
    expect(none.opts[3]!.avatar?.text).toBe('I');
    const { state, input } = setup({ from: 'JOERG' });
    const from = dim(input(), 'from');
    expect(from.opts.map((o) => o.label)).toEqual(['Any sender', 'J\u00f6rg M\u00fcller']);
    expect(from.opts[1]).toMatchObject({ email: 'joerg@firm.example', on: false, closes: true });
    expect(from.opts[1]!.avatar?.text).toBe('JM');
    from.opts[1]!.select();
    expect(state.sf.from).toBe('joerg@firm.example');
    expect(dim(input(), 'from').opts[1]!.on).toBe(true);
  });

  it('"Search in": all fields chosen individually means all', () => {
    const { state, input } = setup({ fields: ['s', 'from', 'body'] });
    dim(input(), 'fields').opts[4]!.select();
    expect(state.sf.fields).toEqual([]);
    dim(input(), 'fields').opts[1]!.select();
    expect(state.sf.fields).toEqual(['s']);
  });
});

describe('panelGroups', () => {
  it('accounts to toggle, mailboxes and custom folders', () => {
    const { state, input } = setup();
    const g = panelGroups(input());
    expect(g.accounts?.map((o) => o.label)).toEqual(['All accounts', 'anna@example.com', 'team@company.example']);
    g.accounts![1]!.select();
    expect(state.sf.account).toBe('k1');
    panelGroups(input()).accounts![1]!.select();
    expect(state.sf.account).toBeNull();
    expect(panelGroups(setup({}, { accounts: [env.accounts[0]!] }).input()).accounts).toBeNull();

    expect(g.sysFolders.map((o) => [o.label, o.on])).toEqual([
      ['All', true],
      ['Inbox', false],
      ['Trash', false],
    ]);
    g.sysFolders[1]!.select();
    expect(state.sf.folder).toBe('role:inbox');
    panelGroups(input()).sysFolders[1]!.select();
    expect(state.sf.folder).toBeNull();

    expect(g.customFolders.map((o) => [o.label, o.tip])).toEqual([
      ['Projects', 'anna@example.com › Projects'],
      ['Old', 'anna@example.com › Projects › Old'],
      ['Customers', 'team@company.example › Customers'],
    ]);
    expect(g.customButton).toEqual({ label: 'Custom folders', on: false });
    g.customFolders[1]!.select();
    expect(panelGroups(input()).customButton).toEqual({ label: 'Old', on: true });
    // Another account drops the custom folder.
    panelGroups(input()).accounts![2]!.select();
    expect([state.sf.account, state.sf.folder]).toEqual(['k2', null]);
    expect(panelGroups(input()).customFolders.map((o) => o.label)).toEqual(['Customers']);
  });

  it('tags and subtags separately, the button names the chosen ones', () => {
    const { state, input } = setup();
    const g = panelGroups(input());
    expect(g.tags.map((o) => o.label)).toEqual(['Work', 'Private']);
    expect(g.subTags.map((o) => [o.label, o.tip])).toEqual([['Customer A', 'Work › Customer A']]);
    expect(g.subButton).toEqual({ label: 'Subtags', on: false });
    g.subTags[0]!.select();
    expect(state.sf.tags).toEqual(['t1a']);
    expect(panelGroups(input()).subButton).toEqual({ label: 'Customer A', on: true });
    const two = setup(
      { tags: ['s1', 's2'] },
      {
        tags: [
          { id: 's1', label: 'One', path: ['A'] },
          { id: 's2', label: 'Two', path: ['A'] },
        ],
      },
    );
    expect(panelGroups(two.input()).subButton).toEqual({ label: '2 subtags', on: true });
  });

  it('time range as steps, "Search in" with check marks', () => {
    const { state, input } = setup({ time: '30d' });
    const g = panelGroups(input());
    expect(g.time.map((o) => o.label)).toEqual(['Today', '7 days', '30 days', 'This year', 'Any time']);
    expect(g.timeIndex).toBe(2);
    expect(panelGroups(setup().input()).timeIndex).toBe(4);
    expect(g.fields.map((o) => [o.label, o.on, o.icon])).toEqual([
      ['Subject', true, 'ti-check'],
      ['Sender', true, 'ti-check'],
      ['Body', true, 'ti-check'],
      ['Attachments', true, 'ti-check'],
    ]);
    g.fields[2]!.select();
    expect(state.sf.fields).toEqual(['s', 'from', 'att']);
    const g2 = panelGroups(input());
    expect(g2.fields[2]).toMatchObject({ on: false, icon: 'ti-plus' });
    g2.fields[2]!.select();
    expect(state.sf.fields).toEqual([]);
    // Deselecting the last field means all again.
    state.sf = { ...state.sf, fields: ['s'] };
    panelGroups(input()).fields[0]!.select();
    expect(state.sf.fields).toEqual([]);
  });

  it('sender suggestions from two characters on, without the chosen address', () => {
    expect(panelGroups(setup({ from: 'a' }).input()).fromSuggestions).toEqual([]);
    const g = panelGroups(setup({ from: 'an' }).input());
    expect(g.fromSuggestions.map((o) => o.email)).toEqual(['anna@example.com']);
    expect(panelGroups(setup({ from: 'anna@example.com' }).input()).fromSuggestions).toEqual([]);
    const { state, input } = setup({ from: 'firm' });
    panelGroups(input()).fromSuggestions[0]!.select();
    expect(state.sf.from).toBe('joerg@firm.example');
  });

  it('sections show and clear their filter', () => {
    const { state, input } = setup({ st: ['u'], time: 'today', from: 'x', tags: ['t2'] });
    const sec = panelGroups(input()).sections;
    expect(Object.entries(sec).map(([k, v]) => [k, v.on])).toEqual([
      ['st', true],
      ['time', true],
      ['account', false],
      ['folder', false],
      ['tags', true],
      ['from', true],
      ['fields', false],
    ]);
    sec.st.clear();
    sec.time.clear();
    sec.tags.clear();
    sec.from.clear();
    expect(state.sf).toEqual(SF0);
  });
});
