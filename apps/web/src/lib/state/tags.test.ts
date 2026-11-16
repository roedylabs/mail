import type { JmapClient, Mailbox } from '@roedy/jmap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type Call } from './fetch-mock.ts';
import {
  applyTagStages,
  problemKey,
  tagBranch,
  TagFixError,
  Tags,
  tagListBoxes,
  tagProblems,
  tagsByMailbox,
  tagTree,
  type Tag,
  type TagJmap,
  type TagNode,
  type TagProblem,
} from './tags.svelte.ts';

function box(id: string, name: string, overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    ...overrides,
  };
}

function tag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return {
    id,
    name,
    parent_id: null,
    color: null,
    position: 0,
    links: [],
    created_at: '2026-10-28T10:00:00Z',
    ...overrides,
  };
}

const link = (mail_account_id: string, mailbox_id: string) => ({ mail_account_id, mailbox_id });

/** Name, color and counters per node, subtags indented. */
function flat(nodes: readonly TagNode[], d = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(d)}${n.name} c${n.color} ${n.unread}/${n.total}`,
    ...flat(n.children, d + 1),
  ]);
}

// Color only on the top level, subtags inherit it.
const TAGS: Tag[] = [
  tag('important', 'Important', { color: 4, position: 0, links: [link('a1', 'm-w'), link('a2', 'n-w')] }),
  tag('finance', 'Finance', { color: 1, position: 1, links: [link('a1', 'm-f')] }),
  tag('invoice', 'Invoices', { parent_id: 'finance', position: 0, links: [link('a1', 'm-r')] }),
  tag('tax', 'Tax', { parent_id: 'finance', position: 1 }),
  tag('st2025', '2025', { parent_id: 'tax', position: 0, links: [link('a2', 'n-25')] }),
  tag('travel', 'Travel', { color: 3, position: 2 }),
  tag('none', 'No color', { position: 3 }),
];

const A1: Mailbox[] = [
  box('m-in', 'Inbox', { role: 'inbox', unreadThreads: 9, totalThreads: 99 }),
  box('m-t', 'Tags'),
  box('m-w', 'Important', { parentId: 'm-t', unreadThreads: 1, totalThreads: 2 }),
  box('m-f', 'Finance', { parentId: 'm-t', unreadThreads: 0, totalThreads: 1 }),
  box('m-r', 'Invoices', { parentId: 'm-f', unreadThreads: 2, totalThreads: 3 }),
];

const A2: Mailbox[] = [
  box('n-t', 'Tags'),
  box('n-w', 'Important', { parentId: 'n-t', unreadThreads: 3, totalThreads: 4 }),
  box('n-st', 'Tax', { parentId: 'n-t' }),
  box('n-25', '2025', { parentId: 'n-st', unreadThreads: 1, totalThreads: 5 }),
];

describe('List of a tag', () => {
  const boxes = [
    box('root', 'Tags'),
    box('mk', 'Customers', { parentId: 'root' }),
    box('mn', 'North', { parentId: 'mk' }),
    box('out', 'Archiv'),
  ];
  const list = [
    tag('customers', 'Customers', { color: 3, links: [link('k1', 'mk'), link('k2', 'x')] }),
    tag('north', 'North', { parent_id: 'customers', links: [link('k1', 'mn')] }),
    tag('south', 'South', { parent_id: 'customers', links: [link('k1', 'out')] }),
  ];

  it('takes the mailboxes of the tag and its subtags below "Tags"', () => {
    expect(tagListBoxes(list, 'customers', 'k1', boxes)).toEqual(['mk', 'mn']);
    expect(tagListBoxes(list, 'north', 'k1', boxes)).toEqual(['mn']);
    expect(tagListBoxes(list, 'customers', 'k2', boxes)).toEqual([]);
    expect(tagListBoxes(list, 'gone', 'k1', boxes)).toEqual([]);
  });

  it('assigns mailboxes to their tag with the inherited color', () => {
    expect([...tagsByMailbox(list, 'k1', boxes)]).toEqual([
      ['mk', { id: 'customers', name: 'Customers', color: 3, rank: 0 }],
      ['mn', { id: 'north', name: 'North', color: 3, rank: 1 }],
    ]);
  });
});

describe('tagTree', () => {
  it("builds the hierarchy by position and inherits the parent tag's color, at the top without a color 0", () => {
    const shuffled = [TAGS[3]!, TAGS[0]!, TAGS[2]!, TAGS[6]!, TAGS[1]!, TAGS[5]!, TAGS[4]!];
    expect(flat(tagTree(shuffled))).toEqual([
      'Important c4 0/0',
      'Finance c1 0/0',
      '  Invoices c1 0/0',
      '  Tax c1 0/0',
      '    2025 c1 0/0',
      'Travel c3 0/0',
      'No color c0 0/0',
    ]);
  });

  it("takes a subtag's own color before the parent tag's", () => {
    const list = [
      tag('p', 'P', { color: 2 }),
      tag('k', 'K', { parent_id: 'p', color: 5 }),
      tag('e', 'E', { parent_id: 'k' }),
    ];
    expect(flat(tagTree(list))).toEqual(['P c2 0/0', '  K c5 0/0', '    E c5 0/0']);
  });

  it('puts tags with an unknown parent tag on the top level', () => {
    expect(flat(tagTree([tag('x', 'Lost', { parent_id: 'absent' })]))).toEqual(['Lost c0 0/0']);
  });

  it('counts the linked mailbox with all subtags in the account (conversations)', () => {
    expect(flat(tagTree(TAGS, { a1: A1 }))).toEqual([
      'Important c4 1/2',
      'Finance c1 2/4',
      '  Invoices c1 2/3',
      '  Tax c1 0/0',
      '    2025 c1 0/0',
      'Travel c3 0/0',
      'No color c0 0/0',
    ]);
  });

  it('sums across the links of all accounts of the view in "all accounts"', () => {
    expect(flat(tagTree(TAGS, { a1: A1, a2: A2 }))).toEqual([
      'Important c4 4/6',
      'Finance c1 3/9',
      '  Invoices c1 2/3',
      '  Tax c1 1/5',
      '    2025 c1 1/5',
      'Travel c3 0/0',
      'No color c0 0/0',
    ]);
  });

  it('does not count links to missing mailboxes and to mailboxes outside "Tags"', () => {
    const list = [
      tag('gone', 'Gone', { links: [link('a1', 'absent')] }),
      tag('out', 'Out', { links: [link('a1', 'm-in')] }),
      tag('root', 'Root', { links: [link('a1', 'm-t')] }),
    ];
    expect(flat(tagTree(list, { a1: A1 }))).toEqual(['Gone c0 0/0', 'Out c0 0/0', 'Root c0 0/0']);
  });
});

describe('tagProblems', () => {
  it('reports nothing when links and mailboxes fit together', () => {
    expect(tagProblems(TAGS, 'a1', A1)).toEqual([]);
    // Tax has no link in a2: the mailbox "Tax" stands without a link, 2025 stays unchecked in its location.
    expect(tagProblems(TAGS, 'a2', A2)).toEqual([
      {
        kind: 'unlinked',
        account: 'a2',
        mailbox: 'n-st',
        name: 'Tax',
        path: 'Tags/Tax',
        kids: 0,
        parent: null,
        link: null,
      },
    ]);
  });

  it('detects missing mailboxes, mailboxes outside "Tags", renaming, moving and mailboxes without a link', () => {
    const list = [
      box('t', 'Tags'),
      box('a', 'Old', { parentId: 't' }),
      box('b', 'B', { parentId: 'a' }),
      box('free', 'Free', { parentId: 't' }),
      box('folder', 'Folder'),
    ];
    const tags = [
      tag('A', 'New', { links: [link('k', 'a')] }),
      tag('B', 'B', { links: [link('k', 'b')] }),
      tag('C', 'C', { parent_id: 'A', links: [link('k', 'free2')] }),
      tag('D', 'D', { parent_id: 'A', links: [link('k', 'folder'), link('other', 'x')] }),
    ];
    expect(tagProblems(tags, 'k', list)).toEqual([
      { kind: 'renamed', account: 'k', tag: 'A', mailbox: 'a', name: 'Old', path: null },
      { kind: 'renamed', account: 'k', tag: 'B', mailbox: 'b', name: null, path: 'Tags/Old/B' },
      { kind: 'missing', account: 'k', tag: 'C', mailbox: 'free2' },
      { kind: 'outside', account: 'k', tag: 'D', mailbox: 'folder', path: 'Folder' },
      {
        kind: 'unlinked',
        account: 'k',
        mailbox: 'free',
        name: 'Free',
        path: 'Tags/Free',
        kids: 0,
        parent: null,
        link: null,
      },
    ]);
  });

  it('does not check the location of a subtag against a broken link of the parent tag', () => {
    // A's mailbox was deleted and created anew as "New-A"; B lies correctly below it.
    const list = [box('t', 'Tags'), box('y', 'A', { parentId: 't' }), box('b', 'B', { parentId: 'y' })];
    const tags = [
      tag('A', 'A', { links: [link('k', 'x')] }),
      tag('B', 'B', { parent_id: 'A', links: [link('k', 'b')] }),
    ];
    expect(tagProblems(tags, 'k', list)).toEqual([
      { kind: 'missing', account: 'k', tag: 'A', mailbox: 'x' },
      // Tag A has no mailbox here any more: "Link to tag" instead of creating anew.
      { kind: 'unlinked', account: 'k', mailbox: 'y', name: 'A', path: 'Tags/A', kids: 0, parent: null, link: 'A' },
    ]);
  });

  it('reports mailboxes without a tag once at the topmost, with a tag at its location and case-insensitively', () => {
    const list = [
      box('t', 'Tags'),
      box('f', 'Finance', { parentId: 't' }),
      box('old', 'Old', { parentId: 'f' }),
      box('y23', '2023', { parentId: 'old' }),
      box('q1', 'Q1', { parentId: 'y23' }),
      box('w', 'important', { parentId: 't' }),
    ];
    const tags = [
      tag('F', 'Finance', { links: [link('k', 'f')] }),
      tag('W', 'Important', { links: [link('k', 'w2')] }),
    ];
    const loose = tagProblems(tags, 'k', list).filter((p) => p.kind === 'unlinked');
    expect(loose).toEqual([
      {
        kind: 'unlinked',
        account: 'k',
        mailbox: 'old',
        name: 'Old',
        path: 'Tags/Finance/Old',
        kids: 2,
        parent: 'F',
        link: null,
      },
      // "important" matches tag W case-insensitively, whose mailbox is missing.
      {
        kind: 'unlinked',
        account: 'k',
        mailbox: 'w',
        name: 'important',
        path: 'Tags/important',
        kids: 0,
        parent: null,
        link: 'W',
      },
    ]);
    // If the tag of the same name has a mailbox, there is nothing to link.
    const linked = tagProblems([tags[0] as Tag, tag('W', 'Important', { links: [link('k', 'wx')] })], 'k', [
      ...list,
      box('wx', 'Important', { parentId: 't' }),
    ]);
    expect(linked.find((p) => p.kind === 'unlinked' && p.mailbox === 'w')).toMatchObject({ link: null });
  });

  it('compares names in NFC and reports only the links without a root "Tags"', () => {
    const decomposed = 'Café'.normalize('NFD');
    expect(
      tagProblems([tag('f', 'Café', { links: [link('k', 'f')] })], 'k', [
        box('t', 'Tags'),
        box('f', decomposed, { parentId: 't' }),
      ]),
    ).toEqual([]);
    expect(tagProblems([tag('f', 'Café', { links: [link('k', 'f')] })], 'k', [box('f', 'Café')])).toEqual([
      { kind: 'outside', account: 'k', tag: 'f', mailbox: 'f', path: 'Café' },
    ]);
  });
});

describe('Tags', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the tags once, also with simultaneous calls', async () => {
    const { calls } = mockApi({ 'GET tags': [{ body: { tags: TAGS } }] });
    const tags = new Tags(() => null);
    await Promise.all([tags.ensure(), tags.ensure()]);
    await tags.ensure();
    expect(calls).toHaveLength(1);
    expect(tags.list?.map((t) => t.id)).toEqual(TAGS.map((t) => t.id));
  });

  it('tries again after an error and discards older responses on sign-out', async () => {
    let answer!: (reply: { body: unknown }) => void;
    mockApi({
      'GET tags': [
        { status: 500, body: { error: 'internal' } },
        () => new Promise((resolve) => (answer = resolve)),
        { body: { tags: [] } },
      ],
    });
    const tags = new Tags(() => null);
    await expect(tags.ensure()).rejects.toThrow();
    expect(tags.list).toBeNull();
    const pending = tags.ensure();
    tags.reset();
    answer({ body: { tags: TAGS } });
    await pending;
    expect(tags.list).toBeNull();
    await tags.ensure();
    expect(tags.list).toEqual([]);
  });

  it('also discards the error of a load before sign-out', async () => {
    let answer!: (reply: { status: number; body: unknown }) => void;
    mockApi({ 'GET tags': [() => new Promise((resolve) => (answer = resolve))] });
    const tags = new Tags(() => null);
    const pending = tags.ensure();
    tags.reset();
    answer({ status: 401, body: { error: 'unauthorized' } });
    await expect(pending).resolves.toBeUndefined();
    expect(tags.list).toBeNull();
  });

  it('counts only accounts with loaded mailboxes and reports problems only with tags and mailboxes', async () => {
    mockApi({ 'GET tags': [{ body: { tags: TAGS } }] });
    const boxes: Record<string, Mailbox[] | null> = { a1: A1, a2: null };
    const tags = new Tags((account) => boxes[account] ?? null);
    expect(tags.problems('a1')).toEqual([]);
    await tags.ensure();
    expect(flat(tags.tree(['a1', 'a2']))[0]).toBe('Important c4 1/2');
    expect(tags.problems('a2')).toEqual([]);
    boxes.a2 = A2;
    expect(flat(tags.tree(['a1', 'a2']))[0]).toBe('Important c4 4/6');
    expect(tags.problems('a2').map((p) => p.kind)).toEqual(['unlinked']);
  });

  it('expands and collapses tags for all accounts together; sign-out collapses everything', () => {
    const tags = new Tags(() => null);
    tags.toggle('finance');
    expect(tags.isOpen('finance')).toBe(true);
    tags.toggle('finance');
    expect(tags.isOpen('finance')).toBe(false);
    tags.toggle('travel');
    tags.reset();
    expect(tags.isOpen('travel')).toBe(false);
  });
});

/** JMAP client for the sync: records `Mailbox/set`, new mailboxes are called `new1`, `new2` … */
describe('Tags in storage', () => {
  const store = (saved: Tag[] | null) => ({
    tags: <T>() => Promise.resolve(saved as T[] | null),
    saveTags: vi.fn(),
  });

  it('shows stored tags until the server answers, and writes the response', async () => {
    let answer: (value: { body: { tags: Tag[] } }) => void = () => {};
    mockApi({ 'GET tags': [() => new Promise((resolve) => (answer = resolve))] });
    const s = store([tag('old', 'Old')]);
    const tags = new Tags(
      () => null,
      undefined,
      () => s,
    );
    const loading = tags.ensure();
    await vi.waitFor(() => expect(tags.list?.map((t) => t.id)).toEqual(['old']));
    answer({ body: { tags: [tag('new', 'New')] } });
    await loading;
    expect(tags.list?.map((t) => t.id)).toEqual(['new']);
    expect(s.saveTags).toHaveBeenCalledWith([expect.objectContaining({ id: 'new' })]);
  });

  it('stays silent without network if tags are stored, and reports it without', async () => {
    mockApi({
      'GET tags': [
        { status: 500, body: {} },
        { status: 500, body: {} },
      ],
    });
    const tags = new Tags(
      () => null,
      undefined,
      () => store([tag('old', 'Old')]),
    );
    await expect(tags.ensure()).resolves.toBeUndefined();
    expect(tags.failed).toBe(false);
    const none = new Tags(
      () => null,
      undefined,
      () => store(null),
    );
    await expect(none.ensure()).rejects.toThrow();
    expect(none.failed).toBe(true);
  });
});

function fakeJmap(fail?: { notUpdated?: Record<string, { type: string }> }) {
  const sets: Record<string, unknown>[] = [];
  const synced: string[] = [];
  let n = 0;
  const client = {
    accountId: () => Promise.resolve('jmap'),
    call: (_method: string, args: Record<string, unknown>) => {
      sets.push(args);
      const create = (args.create ?? {}) as Record<string, unknown>;
      const created = Object.fromEntries(Object.keys(create).map((k) => [k, { id: `new${++n}` }]));
      return Promise.resolve({ created, notCreated: null, notUpdated: fail?.notUpdated ?? null });
    },
  } as unknown as JmapClient;
  const jmap: TagJmap = {
    client: () => Promise.resolve(client),
    sync: (account) => {
      synced.push(account);
      return Promise.resolve();
    },
  };
  return { sets, synced, jmap };
}

/** Writing API calls as `[method, path, body]`. */
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);

describe('Tags.mailbox (first assignment)', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup(list: Tag[], boxes: Mailbox[], routes: Parameters<typeof mockApi>[0] = {}) {
    const jmap = fakeJmap();
    const api = mockApi({ ...routes, 'GET tags': [{ body: { tags: list } }, { body: { tags: list } }] });
    const tags = new Tags((account) => (account === 'k' ? boxes : null), jmap.jmap);
    await tags.ensure();
    return { tags, api, ...jmap };
  }

  it('returns the linked mailbox below "Tags" without writing anything', async () => {
    const list = [tag('w', 'Important', { links: [link('k', 'mw')] })];
    const { tags, api, sets, synced } = await setup(list, [
      box('t', 'Tags'),
      box('mw', 'Important', { parentId: 't' }),
    ]);
    await expect(tags.mailbox('w', 'k')).resolves.toBe('mw');
    expect(sets).toEqual([]);
    expect(writes(api.calls)).toEqual([]);
    expect(api.calls).toHaveLength(1);
    expect(synced).toEqual([]);
  });

  it('creates root, parent tag and tag, links both and reloads tags and mailboxes', async () => {
    const list = [tag('F', 'Finance', { links: [link('k2', 'x')] }), tag('R', 'Invoices', { parent_id: 'F' })];
    const { tags, api, sets, synced } = await setup(list, [box('in', 'Inbox', { role: 'inbox' })], {
      'PUT tags/F/links': [{ body: {} }],
      'PUT tags/R/links': [{ body: {} }],
    });
    await expect(tags.mailbox('R', 'k')).resolves.toBe('new3');
    expect(sets.map((x) => x.create)).toEqual([
      { tag: { name: 'Tags', parentId: null } },
      { tag: { name: 'Finance', parentId: 'new1' } },
      { tag: { name: 'Invoices', parentId: 'new2' } },
    ]);
    expect(writes(api.calls)).toEqual([
      ['PUT', 'tags/F/links', { links: [link('k2', 'x'), link('k', 'new2')] }],
      ['PUT', 'tags/R/links', { links: [link('k', 'new3')] }],
    ]);
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(synced).toEqual(['k']);
  });

  it('links a mailbox of the same name without a tag at the location instead of creating a new one', async () => {
    const list = [tag('w', 'Important')];
    const { tags, api, sets } = await setup(list, [box('t', 'Tags'), box('old', 'important', { parentId: 't' })], {
      'PUT tags/w/links': [{ body: {} }],
    });
    await expect(tags.mailbox('w', 'k')).resolves.toBe('old');
    expect(sets).toEqual([]);
    expect(writes(api.calls)).toEqual([['PUT', 'tags/w/links', { links: [link('k', 'old')] }]]);
  });

  it('refuses if the mailbox of the same name belongs to another tag, and without a known tag', async () => {
    const list = [tag('w', 'Important'), tag('v', 'Important', { parent_id: 'x', links: [link('k', 'mw')] })];
    const { tags, sets } = await setup(list, [box('t', 'Tags'), box('mw', 'Important', { parentId: 't' })]);
    await expect(tags.mailbox('w', 'k')).rejects.toEqual(new TagFixError('folder', 'Important'));
    await expect(tags.mailbox('gone', 'k')).rejects.toThrow();
    await expect(tags.mailbox('w', 'k2')).rejects.toThrow();
    expect(sets).toEqual([]);
  });
});

describe('Tags.fix', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Tags loaded, mailboxes of account `k` known. */
  async function setup(list: Tag[], boxes: Mailbox[], routes: Parameters<typeof mockApi>[0], jmap = fakeJmap()) {
    const api = mockApi({ ...routes, 'GET tags': [{ body: { tags: list } }, { body: { tags: list } }] });
    const tags = new Tags((account) => (account === 'k' ? boxes : null), jmap.jmap);
    await tags.ensure();
    const problem = (kind: TagProblem['kind']) => tags.problems('k').find((p) => p.kind === kind) as TagProblem;
    return { tags, api, problem, ...jmap };
  }

  it('removes the link of an account and then reloads the tags (mailboxes unchanged)', async () => {
    const list = [tag('p', 'Private', { links: [link('k', 'gone'), link('k2', 'x')] })];
    const { tags, api, problem, synced } = await setup(list, [box('t', 'Tags')], {
      'PUT tags/p/links': [{ body: {} }],
    });
    const missing = problem('missing');
    const run = tags.fix(missing, 'unlink');
    expect(tags.busy.get(problemKey(missing))).toBe('unlink');
    // A second action for the same case is dropped.
    await expect(tags.fix(missing, 'unlink')).resolves.toBe(false);
    await expect(run).resolves.toBe(true);
    expect(writes(api.calls)).toEqual([['PUT', 'tags/p/links', { links: [link('k2', 'x')] }]]);
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(synced).toEqual([]);
    expect(tags.busy.size).toBe(0);
  });

  it("moves back below the parent tag's mailbox and creates missing locations", async () => {
    const list = [
      tag('F', 'Finance', { links: [] }),
      tag('N', 'Follow-up', { parent_id: 'F', links: [link('k', 'n')] }),
    ];
    const boxes = [
      box('in', 'Inbox', { role: 'inbox' }),
      box('ar', 'Archiv'),
      box('n', 'Follow-up', { parentId: 'ar' }),
    ];
    const { tags, problem, sets, api } = await setup(list, boxes, { 'PUT tags/F/links': [{ body: {} }] });
    await tags.fix(problem('outside'), 'back');
    // Root "Tags", then "Finance" (linked), then the mailbox itself.
    expect(sets.map((s) => s.create ?? s.update)).toEqual([
      { tag: { name: 'Tags', parentId: null } },
      { tag: { name: 'Finance', parentId: 'new1' } },
      { n: { parentId: 'new2', name: 'Follow-up' } },
    ]);
    expect(writes(api.calls)).toEqual([['PUT', 'tags/F/links', { links: [link('k', 'new2')] }]]);
  });

  it('aligns a renamed mailbox and refuses if a folder of the same name already lies there', async () => {
    const list = [tag('w', 'Waiting', { links: [link('k', 'w')] })];
    const ok = await setup(list, [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' })], {});
    await ok.tags.fix(ok.problem('renamed'), 'align');
    expect(ok.sets.map((s) => s.update)).toEqual([{ w: { parentId: 't', name: 'Waiting' } }]);
    vi.unstubAllGlobals();
    const taken = await setup(
      list,
      [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' }), box('x', 'waiting', { parentId: 't' })],
      {},
    );
    await expect(taken.tags.fix(taken.problem('renamed'), 'align')).rejects.toEqual(
      new TagFixError('folder', 'Waiting'),
    );
    expect(taken.sets).toEqual([]);
  });

  it('takes the mailbox name as the tag name and renames the mailbox of the other accounts', async () => {
    const list = [tag('w', 'Waiting', { links: [link('k', 'w'), link('k2', 'w2')] })];
    const jmap = fakeJmap();
    const api = mockApi({
      'GET tags': [{ body: { tags: list } }, { body: { tags: list } }],
      'PATCH tags/w': [{ body: {} }],
    });
    const boxes: Record<string, Mailbox[]> = {
      k: [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' })],
      k2: [box('t2', 'Tags'), box('w2', 'Waiting', { parentId: 't2' })],
    };
    const tags = new Tags((account) => boxes[account] ?? null, jmap.jmap);
    await tags.ensure();
    await tags.fix(tags.problems('k')[0] as TagProblem, 'take');
    expect(writes(api.calls)).toEqual([['PATCH', 'tags/w', { name: 'Pending' }]]);
    expect(jmap.sets.map((s) => s.update)).toEqual([{ w2: { name: 'Pending' } }]);
  });

  it('reports a taken tag name as TagFixError, from the list as from the API', async () => {
    const list = [tag('w', 'Waiting', { links: [link('k', 'w')] })];
    const boxes = [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' })];
    const { tags, problem } = await setup(list, boxes, {
      'PATCH tags/w': [{ status: 422, body: { error: 'invalid', fields: { name: { code: 'taken' } } } }],
    });
    await expect(tags.fix(problem('renamed'), 'take')).rejects.toEqual(new TagFixError('tag', 'Pending'));
    vi.unstubAllGlobals();
    const sibling = await setup([...list, tag('x', 'pending')], boxes, {});
    await expect(sibling.tags.fix(sibling.problem('renamed'), 'take')).rejects.toEqual(
      new TagFixError('tag', 'Pending'),
    );
    expect(writes(sibling.api.calls)).toEqual([]);
  });

  it('adopts a mailbox without a tag with subfolders as tags and expands the parent tag', async () => {
    const list = [tag('F', 'Finance', { color: 1, links: [link('k', 'f')] })];
    const boxes = [
      box('t', 'Tags'),
      box('f', 'Finance', { parentId: 't' }),
      box('old', 'Old', { parentId: 'f' }),
      box('y23', '2023', { parentId: 'old' }),
    ];
    const { tags, problem, api } = await setup(list, boxes, {
      'POST tags': [{ body: tag('A', 'Old', { parent_id: 'F' }) }, { body: tag('Y', '2023', { parent_id: 'A' }) }],
      'PUT tags/A/links': [{ body: {} }],
      'PUT tags/Y/links': [{ body: {} }],
    });
    await tags.fix(problem('unlinked'), 'adopt');
    expect(writes(api.calls)).toEqual([
      ['POST', 'tags', { name: 'Old', parent_id: 'F', color: null }],
      ['PUT', 'tags/A/links', { links: [link('k', 'old')] }],
      ['POST', 'tags', { name: '2023', parent_id: 'A', color: null }],
      ['PUT', 'tags/Y/links', { links: [link('k', 'y23')] }],
    ]);
    expect(tags.isOpen('F')).toBe(true);
  });

  it('links with a tag of the same name without a mailbox and gives the next color at the top', async () => {
    const list = [tag('A', 'A', { links: [link('k', 'x'), link('k2', 'z')] })];
    const boxes = [box('t', 'Tags'), box('y', 'A', { parentId: 't' }), box('n', 'New', { parentId: 't' })];
    const { tags, api } = await setup(list, boxes, {
      'PUT tags/A/links': [{ body: {} }],
      'POST tags': [{ body: tag('N', 'New') }],
      'PUT tags/N/links': [{ body: {} }],
    });
    const [y, n] = tags.problems('k').filter((p) => p.kind === 'unlinked') as [TagProblem, TagProblem];
    await tags.fix(y, 'adopt');
    await tags.fix(n, 'adopt');
    expect(writes(api.calls)).toEqual([
      ['PUT', 'tags/A/links', { links: [link('k2', 'z'), link('k', 'y')] }],
      ['POST', 'tags', { name: 'New', parent_id: null, color: 1 }],
      ['PUT', 'tags/N/links', { links: [link('k', 'n')] }],
    ]);
  });

  it('moves a mailbox without a tag to the folders, unless one of the same name already lies there', async () => {
    const boxes = [box('t', 'Tags'), box('old', 'Old', { parentId: 't' })];
    const ok = await setup([], boxes, {});
    await ok.tags.fix(ok.problem('unlinked'), 'toFolder');
    expect(ok.sets.map((s) => s.update)).toEqual([{ old: { parentId: null } }]);
    vi.unstubAllGlobals();
    const taken = await setup([], [...boxes, box('o', 'OLD')], {});
    await expect(taken.tags.fix(taken.problem('unlinked'), 'toFolder')).rejects.toEqual(
      new TagFixError('folder', 'Old'),
    );
  });

  it('reports rejected mailboxes as errors and reloads anyway', async () => {
    const list = [tag('w', 'Waiting', { links: [link('k', 'w')] })];
    const jmap = fakeJmap({ notUpdated: { w: { type: 'forbidden' } } });
    const boxes = [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' })];
    const { tags, problem, synced } = await setup(list, boxes, {}, jmap);
    await expect(tags.fix(problem('renamed'), 'align')).rejects.toThrow('Mailbox/set: forbidden');
    expect(synced).toEqual(['k']);
    expect(tags.busy.size).toBe(0);
  });

  it('adopts subfolders even if another account links a mailbox with the same id', async () => {
    const list = [tag('X', 'X', { links: [link('k2', 'y23')] })];
    const boxes = [box('t', 'Tags'), box('old', 'Old', { parentId: 't' }), box('y23', '2023', { parentId: 'old' })];
    const { tags, problem, api } = await setup(list, boxes, {
      'POST tags': [{ body: tag('A', 'Old') }, { body: tag('Y', '2023', { parent_id: 'A' }) }],
      'PUT tags/A/links': [{ body: {} }],
      'PUT tags/Y/links': [{ body: {} }],
    });
    await tags.fix(problem('unlinked'), 'adopt');
    expect(writes(api.calls).at(-1)).toEqual(['PUT', 'tags/Y/links', { links: [link('k', 'y23')] }]);
  });

  it('syncs the mailboxes of the other accounts after taking the name', async () => {
    const list = [tag('w', 'Waiting', { links: [link('k', 'w'), link('k2', 'w2')] })];
    const jmap = fakeJmap();
    mockApi({ 'GET tags': [{ body: { tags: list } }, { body: { tags: list } }], 'PATCH tags/w': [{ body: {} }] });
    const boxes: Record<string, Mailbox[]> = {
      k: [box('t', 'Tags'), box('w', 'Pending', { parentId: 't' })],
      k2: [box('t2', 'Tags'), box('w2', 'Waiting', { parentId: 't2' })],
    };
    const tags = new Tags((account) => boxes[account] ?? null, jmap.jmap);
    await tags.ensure();
    await tags.fix(tags.problems('k')[0] as TagProblem, 'take');
    expect(jmap.synced).toEqual(['k2']);
  });

  it('runs actions one after another, each on the reloaded state', async () => {
    const before = [tag('p', 'Private', { links: [link('k', 'gone'), link('k2', 'gone2')] })];
    const between = [tag('p', 'Private', { links: [link('k2', 'gone2')] })];
    const api = mockApi({
      'GET tags': [{ body: { tags: before } }, { body: { tags: between } }, { body: { tags: [] } }],
      'PUT tags/p/links': [{ body: {} }, { body: {} }],
    });
    const boxes: Record<string, Mailbox[]> = { k: [box('t', 'Tags')], k2: [box('t2', 'Tags')] };
    const tags = new Tags((account) => boxes[account] ?? null, fakeJmap().jmap);
    await tags.ensure();
    const [a, b] = [tags.problems('k')[0], tags.problems('k2')[0]] as [TagProblem, TagProblem];
    await Promise.all([tags.fix(a, 'unlink'), tags.fix(b, 'unlink')]);
    // The second PUT knows the first: the link of k does not return.
    expect(writes(api.calls)).toEqual([
      ['PUT', 'tags/p/links', { links: [link('k2', 'gone2')] }],
      ['PUT', 'tags/p/links', { links: [] }],
    ]);
  });

  it("links a mailbox of the same name without a tag at the parent tag's location when moving back", async () => {
    const list = [tag('F', 'Finance'), tag('N', 'Follow-up', { parent_id: 'F', links: [link('k', 'n')] })];
    const boxes = [
      box('t', 'Tags'),
      box('f', 'finance', { parentId: 't' }),
      box('ar', 'Archiv'),
      box('n', 'Follow-up', { parentId: 'ar' }),
    ];
    const { tags, problem, sets, api } = await setup(list, boxes, { 'PUT tags/F/links': [{ body: {} }] });
    await tags.fix(problem('outside'), 'back');
    expect(writes(api.calls)).toEqual([['PUT', 'tags/F/links', { links: [link('k', 'f')] }]]);
    expect(sets.map((s) => s.create ?? s.update)).toEqual([{ n: { parentId: 'f', name: 'Follow-up' } }]);
  });

  it('names the mailbox after the tag case-insensitively when linking', async () => {
    const list = [tag('A', 'Old', { links: [link('k', 'gone')] })];
    const { tags, problem, sets } = await setup(list, [box('t', 'Tags'), box('y', 'old', { parentId: 't' })], {
      'PUT tags/A/links': [{ body: {} }],
    });
    await tags.fix(problem('unlinked'), 'adopt');
    expect(sets.map((s) => s.update)).toEqual([{ y: { name: 'Old' } }]);
  });

  it('loads nothing more after sign-out during an action', async () => {
    let answer!: (reply: { body: unknown }) => void;
    const list = [tag('p', 'Private', { links: [link('k', 'gone')] })];
    const { tags, problem, api } = await setup(list, [box('t', 'Tags')], {
      'PUT tags/p/links': [() => new Promise((resolve) => (answer = resolve))],
    });
    const run = tags.fix(problem('missing'), 'unlink');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    tags.reset();
    answer({ body: {} });
    await run;
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});

describe('Layer of pending changes', () => {
  afterEach(() => vi.unstubAllGlobals());

  const list = [
    tag('a', 'A', { color: 1 }),
    tag('b', 'B', { parent_id: 'a' }),
    tag('c', 'C', { parent_id: 'b' }),
    tag('d', 'D', { position: 1 }),
  ];

  it('tagBranch: tag with all subtags, empty for an unknown one', () => {
    expect([...tagBranch(list, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...tagBranch(list, 'gone')]).toEqual([]);
  });

  it('hides a tag with subtags and changes name, location and color', () => {
    expect(applyTagStages(list, [{ hide: ['b'] }])?.map((t) => t.id)).toEqual(['a', 'd']);
    const moved = applyTagStages(list, [{ id: 'b', name: 'New', parent_id: 'd', color: 3 }]);
    expect(flat(tagTree(moved ?? []))).toEqual(['A c1 0/0', 'D c0 0/0', '  New c3 0/0', '    C c3 0/0']);
    // Unchanged, the location stays.
    expect(applyTagStages(list, [{ id: 'd', name: 'D2', parent_id: null, color: null }])?.[3]?.position).toBe(1);
    expect(applyTagStages(null, [{ hide: ['a'] }])).toBeNull();
  });

  it("list shows the layer, the sync the server's state", async () => {
    mockApi({ 'GET tags': [{ body: { tags: [tag('w', 'Important', { links: [link('k', 'mw')] })] } }] });
    const tags = new Tags(() => [box('t', 'Tags'), box('mw', 'Important', { parentId: 't' })]);
    await tags.ensure();
    const token = tags.stage({ id: 'w', name: 'Urgent', parent_id: null, color: 2 });
    expect(tags.list?.[0]?.name).toBe('Urgent');
    expect(flat(tags.tree(['k']))).toEqual(['Urgent c2 0/0']);
    expect(tags.problems('k')).toEqual([]);
    tags.unstage(token);
    expect(tags.list?.[0]?.name).toBe('Important');
    tags.stage({ hide: ['w'] });
    expect(tags.tree(['k'])).toEqual([]);
    tags.reset();
    expect(tags.list).toBeNull();
  });

  it('problems: tags with a pending change drop out until the layer goes', async () => {
    const list = [tag('w', 'Important', { links: [link('k', 'mw')] }), tag('u', 'Sub', { parent_id: 'w' })];
    mockApi({ 'GET tags': [{ body: { tags: list } }] });
    const tags = new Tags(() => [box('t', 'Tags'), box('mw', 'Urgent', { parentId: 't' })]);
    await tags.ensure();
    expect(tags.problems('k').map((p) => p.kind)).toEqual(['renamed']);
    const token = tags.stage({ id: 'w', name: 'Urgent', parent_id: null, color: null });
    expect(tags.problems('k')).toEqual([]);
    tags.unstage(token);
    tags.stage({ hide: ['w'] });
    expect(tags.problems('k')).toEqual([]);
  });
});

describe('Create, change, delete tags', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Tags loaded; mailboxes per account, `k` and `k2` are reachable. */
  async function setup(list: Tag[], boxes: Record<string, Mailbox[]>, routes: Parameters<typeof mockApi>[0] = {}) {
    const jmap = fakeJmap();
    const removed: [string, string][] = [];
    const ensured: string[] = [];
    const api = mockApi({
      'GET tags': [{ body: { tags: list } }, { body: { tags: list } }, { body: { tags: list } }],
      ...routes,
    });
    const tags = new Tags((account) => boxes[account] ?? null, {
      ...jmap.jmap,
      usable: (account) => account === 'k' || account === 'k2',
      ensure: (account) => {
        ensured.push(account);
        return Promise.resolve();
      },
      remove: (account, mailbox) => {
        removed.push([account, mailbox]);
        return Promise.resolve();
      },
    });
    await tags.ensure();
    return { tags, api, removed, ensured, ...jmap };
  }

  it('create: POST with NFC name, color and parent tag; the tag is in the list right away', async () => {
    const created = tag('n', 'Café', { parent_id: 'a', color: 2 });
    const { tags, api } = await setup(
      [tag('a', 'A')],
      {},
      {
        'POST tags': [{ status: 201, body: created }],
        'GET tags': [{ body: { tags: [tag('a', 'A')] } }, { body: { tags: [tag('a', 'A'), created] } }],
      },
    );
    await expect(tags.create('Cafe\u0301', 'a', 2)).resolves.toEqual(created);
    expect(writes(api.calls)).toEqual([['POST', 'tags', { name: 'Café', parent_id: 'a', color: 2 }]]);
    expect(tags.list?.map((t) => t.id)).toEqual(['a', 'n']);
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    // Signed out before the queue reaches it: nothing goes out any more.
    const late = tags.create('Late', null, 0);
    tags.reset();
    await expect(late).rejects.toThrow();
    expect(writes(api.calls)).toHaveLength(1);
  });

  it('edit: changing only the color changes only the tag', async () => {
    const { tags, api, sets } = await setup(
      [tag('w', 'W', { links: [link('k', 'mw')] })],
      {},
      {
        'PATCH tags/w': [{ body: tag('w', 'W', { color: 4, links: [link('k', 'mw')] }) }],
      },
    );
    await tags.edit('w', { color: 4 });
    expect(writes(api.calls)).toEqual([['PATCH', 'tags/w', { color: 4 }]]);
    expect(api.calls[api.calls.length - 1]?.method).toBe('PATCH');
    expect(sets).toEqual([]);
    expect(tags.list?.[0]?.color).toBe(4);
  });

  it('edit: renaming carries the mailboxes of the reachable accounts along, not outside "Tags"', async () => {
    const links = [link('k', 'mw'), link('k2', 'x'), link('k3', 'z')];
    const renamed = tag('w', 'Urgent', { links });
    const { tags, sets, synced, ensured } = await setup(
      [tag('w', 'Important', { links })],
      {
        k: [box('t', 'Tags'), box('mw', 'Important', { parentId: 't' })],
        k2: [box('x', 'Important')],
        k3: [box('t3', 'Tags'), box('z', 'Important', { parentId: 't3' })],
      },
      { 'PATCH tags/w': [{ body: renamed }] },
    );
    await tags.edit('w', { name: 'Urgent' });
    expect(sets).toEqual([{ accountId: 'jmap', update: { mw: { parentId: 't', name: 'Urgent' } } }]);
    expect(ensured).toEqual(['k', 'k2']);
    expect(synced).toEqual(['k']);
  });

  it('edit: moving creates the location of the new parent tag; a name conflict is left to the sync', async () => {
    const list = [tag('p', 'Projects'), tag('w', 'Important', { links: [link('k', 'mw'), link('k2', 'y')] })];
    const moved = tag('w', 'Important', { parent_id: 'p', links: [link('k', 'mw'), link('k2', 'y')] });
    const { tags, api, sets } = await setup(
      list,
      {
        k: [box('t', 'Tags'), box('mw', 'Important', { parentId: 't' })],
        k2: [box('t2', 'Tags'), box('y', 'Important', { parentId: 't2' }), box('py', 'Projects', { parentId: 't2' })],
      },
      {
        'PATCH tags/w': [{ body: moved }],
        'PUT tags/p/links': [{ body: {} }, { body: {} }],
      },
    );
    await tags.edit('w', { parent_id: 'p' });
    expect(sets).toEqual([
      { accountId: 'jmap', create: { tag: { name: 'Projects', parentId: 't' } } },
      { accountId: 'jmap', update: { mw: { parentId: 'new1', name: 'Important' } } },
      { accountId: 'jmap', update: { y: { parentId: 'py', name: 'Important' } } },
    ]);
    expect(writes(api.calls)).toEqual([
      ['PATCH', 'tags/w', { parent_id: 'p' }],
      ['PUT', 'tags/p/links', { links: [link('k', 'new1')] }],
      ['PUT', 'tags/p/links', { links: [link('k', 'new1'), link('k2', 'py')] }],
    ]);
  });

  it('edit: a taken name fails before a mailbox changes', async () => {
    const { tags, sets } = await setup(
      [tag('w', 'W', { links: [link('k', 'mw')] })],
      {},
      {
        'PATCH tags/w': [{ status: 422, body: { error: 'invalid', fields: { name: { code: 'taken' } } } }],
      },
    );
    await expect(tags.edit('w', { name: 'X' })).rejects.toThrow();
    expect(sets).toEqual([]);
  });

  it('usage: subtags and emails of the mailboxes below "Tags" in the reachable accounts', async () => {
    const list = [
      tag('a', 'A', { links: [link('k', 'ma'), link('k3', 'm3')] }),
      tag('b', 'B', { parent_id: 'a', links: [link('k', 'mb'), link('k2', 'out')] }),
      tag('c', 'C', { parent_id: 'b' }),
    ];
    const { tags } = await setup(list, {
      k: [
        box('t', 'Tags'),
        box('ma', 'A', { parentId: 't', totalEmails: 3 }),
        box('mb', 'B', { parentId: 'ma', totalEmails: 2 }),
      ],
      k2: [box('out', 'B', { totalEmails: 7 })],
      k3: [box('t3', 'Tags'), box('m3', 'A', { parentId: 't3', totalEmails: 9 })],
    });
    await expect(tags.usage('a')).resolves.toEqual({ sub: 2, mails: 5 });
    await expect(tags.usage('c')).resolves.toEqual({ sub: 0, mails: 0 });
  });

  it('edit: PATCH goes out immediately, even if an action before it is still running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const list = [tag('a', 'A', { links: [link('k', 'ma')] }), tag('w', 'W')];
    const api = mockApi({
      'GET tags': [{ body: { tags: list } }, { body: { tags: list } }, { body: { tags: list } }],
      'PATCH tags/w': [{ body: tag('w', 'X') }],
      'DELETE tags/a': [{ status: 204 }],
    });
    const tags = new Tags(() => [box('t', 'Tags'), box('ma', 'A', { parentId: 't' })], {
      ...fakeJmap().jmap,
      usable: () => true,
      ensure: () => gate,
      remove: () => Promise.resolve(),
    });
    await tags.ensure();
    const removing = tags.remove('a');
    const editing = tags.edit('w', { name: 'X' }, true);
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    release();
    await Promise.all([removing, editing]);
    expect(tags.list?.find((t) => t.id === 'w')?.name).toBe('X');
  });

  it('remove: refuses before anything changes if the mailbox of another tag lies below', async () => {
    const list = [tag('a', 'A', { links: [link('k', 'ma')] }), tag('c', 'C', { links: [link('k', 'mc')] })];
    const { tags, api, removed } = await setup(list, {
      k: [box('t', 'Tags'), box('ma', 'A', { parentId: 't' }), box('mc', 'C', { parentId: 'ma' })],
    });
    await expect(tags.remove('a')).rejects.toThrow();
    expect(removed).toEqual([]);
    expect(writes(api.calls)).toEqual([]);
  });

  it('remove: per reachable account the topmost mailboxes of the branch, then DELETE', async () => {
    const list = [
      tag('a', 'A', { links: [link('k', 'ma'), link('k2', 'out'), link('k3', 'm3')] }),
      tag('b', 'B', { parent_id: 'a', links: [link('k', 'mb'), link('k2', 'mb2')] }),
    ];
    const { tags, api, removed } = await setup(
      list,
      {
        k: [box('t', 'Tags'), box('ma', 'A', { parentId: 't' }), box('mb', 'B', { parentId: 'ma' })],
        k2: [box('t2', 'Tags'), box('out', 'A'), box('mb2', 'B', { parentId: 't2' })],
      },
      { 'DELETE tags/a': [{ status: 204 }] },
    );
    await tags.remove('a');
    expect(removed).toEqual([
      ['k', 'ma'],
      ['k2', 'mb2'],
    ]);
    expect(writes(api.calls)).toEqual([['DELETE', 'tags/a', undefined]]);
  });

  it('remove: if an account fails, the tag stays; an unknown tag changes nothing', async () => {
    const list = [tag('a', 'A', { links: [link('k', 'ma')] })];
    const api = mockApi({ 'GET tags': Array.from({ length: 4 }, () => ({ body: { tags: list } })) });
    const tags = new Tags(() => [box('t', 'Tags'), box('ma', 'A', { parentId: 't' })], {
      ...fakeJmap().jmap,
      usable: () => true,
      ensure: () => Promise.resolve(),
      remove: () => Promise.reject(new Error('Mailbox/set')),
    });
    await tags.ensure();
    await expect(tags.remove('a')).rejects.toThrow('Mailbox/set');
    await tags.remove('gone');
    expect(writes(api.calls)).toEqual([]);
    expect(tags.list?.map((t) => t.id)).toEqual(['a']);
  });
});
