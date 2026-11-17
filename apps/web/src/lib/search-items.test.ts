import type { Mailbox } from '@roedy/jmap';
import { describe, expect, it, vi } from 'vitest';
import { tagColors } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { scoreAll, termsOf, type Candidate, type MailHit, type SearchActions } from '#lib/search.ts';
import type { TimeContext } from '#lib/mail-list.ts';
import { hitBox, notifItems, searchCandidates, type SearchItemsInput } from '#lib/search-items.ts';
import type { AppNotification } from '#lib/state/notifications.svelte.ts';
import type { Contact } from '#lib/state/contacts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import type { ListedUser } from '#lib/users.svelte.ts';

function box(id: string, name: string, over: Partial<Mailbox> = {}): Mailbox {
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
    ...over,
  };
}

const BOXES: Mailbox[] = [
  box('in', 'Inbox', { role: 'inbox', unreadThreads: 3, totalThreads: 9 }),
  box('se', 'Sent', { role: 'sent', totalThreads: 1 }),
  box('pl', 'Scheduled', { role: 'scheduled' }),
  box('tr', 'Trash', { role: 'trash' }),
  box('pr', 'Projects', { sortOrder: 1 }),
  box('al', 'Alpha', { parentId: 'pr', totalThreads: 2 }),
  box('tg', 'Tags', { sortOrder: 2 }),
  box('red', 'Red', { parentId: 'tg', totalThreads: 4 }),
];

function contact(name: string, email: string, count = 0): Contact {
  return { name, email, count, at: 0, match: `${name}\n${email}` };
}

function user(id: string, over: Partial<ListedUser> = {}): ListedUser {
  return {
    id,
    status: 'active',
    name: null,
    email: `${id}@example.com`,
    role: 'user',
    mfa: false,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function tag(id: string, name: string, over: Partial<TagNode> = {}): TagNode {
  return { id, name, color: 0, unread: 0, total: 0, children: [], ...over };
}

function actions(): SearchActions {
  return {
    go: vi.fn(),
    mailbox: vi.fn(),
    section: vi.fn(),
    compose: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    help: vi.fn(),
    palette: vi.fn(),
    addAccount: vi.fn(),
    invite: vi.fn(),
    openUser: vi.fn(),
    searchFrom: vi.fn(),
    logout: vi.fn(),
  };
}

function input(over: Partial<SearchItemsInput> = {}): SearchItemsInput {
  return {
    isAdmin: false,
    isMobile: false,
    dark: false,
    advanced: false,
    mod: 'Ctrl',
    accounts: [{ id: 'k1', email: 'a@example.com' }],
    mailboxes: (account) => (account === 'k1' ? BOXES : []),
    tags: [],
    tagAccount: null,
    contacts: [],
    users: [],
    me: null,
    actions: actions(),
    ...over,
  };
}

const ofCat = (list: Candidate[], cat: Candidate['cat']) => list.filter((c) => c.cat === cat);
const byLabel = (list: Candidate[], label: string) => list.find((c) => c.label === label);

describe('searchCandidates › contacts', () => {
  it('name, avatar, address with count and search by sender', () => {
    const inp = input({
      contacts: [
        contact('Anna Becker', 'anna@example.com', 1),
        contact('', '1pass@example.com', 5),
        contact('', 'bo@example.org'),
      ],
    });
    const list = ofCat(searchCandidates(inp), 'contacts');
    expect(list.map((c) => [c.label, c.path, c.extra, c.av?.text, c.icon])).toEqual([
      ['Anna Becker', 'anna@example.com · 1 message', 'anna@example.com', 'AB', 'ti-user'],
      ['1pass@example.com', '1pass@example.com · 5 messages', '1pass@example.com', '1', 'ti-user'],
      ['bo@example.org', 'bo@example.org', 'bo@example.org', 'B', 'ti-user'],
    ]);
    list[0]!.run();
    expect(inp.actions.searchFrom).toHaveBeenCalledWith('anna@example.com');
  });
});

describe('searchCandidates › folders', () => {
  it('system folders in the order of the sidebar with counters, then custom folders without tags', () => {
    const inp = input();
    const list = ofCat(searchCandidates(inp), 'folders');
    expect(list.map((c) => [c.label, c.path, c.icon])).toEqual([
      ['Inbox', 'a@example.com · 3 unread', 'ti-inbox'],
      ['Sent', 'a@example.com · 1 message', 'ti-send'],
      ['Scheduled', 'a@example.com', 'ti-clock'],
      ['Trash', 'a@example.com', 'ti-trash'],
      ['Projects', 'a@example.com', 'ti-folder'],
      ['Alpha', 'a@example.com › Projects · 2 messages', 'ti-folder'],
    ]);
    expect(byLabel(list, 'Inbox')?.extra).toBe('a@example.com inbox');
    expect(byLabel(list, 'Alpha')?.extra).toBe('Projects');
    byLabel(list, 'Inbox')!.run();
    byLabel(list, 'Alpha')!.run();
    expect(inp.actions.mailbox).toHaveBeenNthCalledWith(1, '/mailbox/k1/inbox');
    expect(inp.actions.mailbox).toHaveBeenNthCalledWith(2, '/mailbox/k1/f/al');
  });

  it('an account without loaded mailboxes returns nothing', () => {
    const list = ofCat(searchCandidates(input({ accounts: [{ id: 'k2', email: 'b@example.com' }] })), 'folders');
    expect(list).toEqual([]);
  });
});

describe('searchCandidates › tags', () => {
  const tree = [tag('t1', 'Work', { color: 1, total: 4, children: [tag('t2', 'Customer', { color: 1, total: 1 })] })];

  it('path of the parents, counters, colours and target in the account of the tags', () => {
    const inp = input({ tags: tree, tagAccount: 'all' });
    const list = ofCat(searchCandidates(inp), 'tags');
    expect(list.map((c) => [c.label, c.path, c.extra])).toEqual([
      ['Work', '4 messages', ''],
      ['Customer', 'Work · 1 message', 'Work'],
    ]);
    expect(list[0]).toMatchObject({ icon: 'ti-tag', tile: tagColors(1) });
    list[1]!.run();
    expect(inp.actions.mailbox).toHaveBeenCalledWith('/mailbox/all/t/t2');
  });

  it('no hits without an account for tags', () => {
    expect(ofCat(searchCandidates(input({ tags: tree })), 'tags')).toEqual([]);
  });
});

describe('searchCandidates › settings', () => {
  it('pages with path and description, sections with page', () => {
    const inp = input();
    const list = ofCat(searchCandidates(inp), 'settings');
    expect(byLabel(list, 'Profile')).toMatchObject({
      path: 'Account',
      desc: 'The local account you sign in with.',
      extra: 'The local account you sign in with.',
    });
    expect(byLabel(list, 'Notifications')?.path).toBe('Settings');
    expect(byLabel(list, 'Language & region')?.path).toBe('Settings · System');
    expect(byLabel(list, 'Keyboard shortcuts')?.path).toBe('Settings · System');
    const sessions = byLabel(list, 'Signed-in devices')!;
    expect(sessions).toMatchObject({ path: 'Account › Security', icon: 'ti-devices' });
    expect(sessions.extra).toBe('sessions devices sign out Security');
    expect(byLabel(list, 'External content in emails')?.path).toBe('Settings › General');
    sessions.run();
    expect(inp.actions.section).toHaveBeenCalledWith('/account/security', 'sessions');
    byLabel(list, 'Language & region')!.run();
    expect(inp.actions.go).toHaveBeenCalledWith('/settings/language');
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
  });

  it('mobile without keyboard shortcuts', () => {
    const list = ofCat(searchCandidates(input({ isMobile: true })), 'settings');
    expect(byLabel(list, 'Keyboard shortcuts')).toBeUndefined();
    expect(byLabel(list, 'Language & region')).toBeDefined();
  });
});

describe('searchCandidates › administration', () => {
  it('administrators only', () => {
    const list = searchCandidates(input({ users: [user('u1')] }));
    expect(ofCat(list, 'admin')).toEqual([]);
  });

  it('pages, sections and users without the own account', () => {
    const inp = input({
      isAdmin: true,
      me: 'me',
      users: [
        user('me', { name: 'Myself', role: 'admin' }),
        user('u1', { name: 'Luke Wagner', status: 'invited' }),
        user('u2', { role: 'admin', status: 'locked' }),
      ],
    });
    const list = ofCat(searchCandidates(inp), 'admin');
    expect(byLabel(list, 'Users')).toMatchObject({
      path: 'Administration',
      desc: 'Create, edit, and suspend accounts.',
    });
    expect(byLabel(list, 'Mail servers')?.path).toBe('Administration · System');
    expect(byLabel(list, 'Developer')).toBeUndefined();
    const policy = byLabel(list, 'Allow custom server URLs')!;
    expect(policy.path).toBe('Administration › Mail servers');
    policy.run();
    expect(inp.actions.section).toHaveBeenCalledWith('/admin/mail-servers', 'policy');
    expect(byLabel(list, 'Myself')).toBeUndefined();
    const luke = byLabel(list, 'Luke Wagner')!;
    expect(luke).toMatchObject({
      path: 'User · User · Invited',
      extra: 'u1@example.com users User Invited',
      icon: 'ti-user',
    });
    expect(luke.av?.text).toBe('LW');
    expect(byLabel(list, 'u2@example.com')).toMatchObject({ path: 'User · Administrator · Suspended' });
    expect(byLabel(list, 'u2@example.com')?.av?.text).toBe('U');
    luke.run();
    expect(inp.actions.openUser).toHaveBeenCalledWith('u1');
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
  });

  it('developer only with advanced settings', () => {
    const list = ofCat(searchCandidates(input({ isAdmin: true, advanced: true })), 'admin');
    expect(byLabel(list, 'Developer')).toMatchObject({ path: 'Administration · Advanced' });
  });

  it('sections of the developer page only with advanced settings', () => {
    const labels = ['Debug mode', 'Log level', 'Test error pages', 'Environment'];
    const on = ofCat(searchCandidates(input({ isAdmin: true, advanced: true })), 'admin');
    expect(labels.map((label) => byLabel(on, label)?.path)).toEqual(labels.map(() => 'Administration › Developer'));
    const off = ofCat(searchCandidates(input({ isAdmin: true, advanced: false })), 'admin');
    expect(labels.map((label) => byLabel(off, label))).toEqual(labels.map(() => undefined));
  });
});

/** Page in the section index with label and `data-sec` per section. */
interface IdxPage {
  path: string;
  route: string;
  secs: [label: string, sec: string][];
}

/** Expected section index of the settings and the account. */
const SETTINGS_IDX: IdxPage[] = [
  {
    path: 'Settings › Appearance',
    route: '/settings/appearance',
    secs: [
      ['Color scheme', 'mode'],
      ['Accent color', 'accent'],
      ['Font size', 'text'],
      ['Animations', 'text'],
      ['Density', 'layout'],
      ['Message list', 'layout'],
      ['Sidebar', 'layout'],
    ],
  },
  {
    path: 'Settings › General',
    route: '/settings/general',
    secs: [
      ['Open on startup', 'start'],
      ['Ask before deleting', 'behavior'],
      ['Undo period', 'behavior'],
      ['Enable keyboard shortcuts', 'behavior'],
      ['Gestures', 'swipe'],
      ['External content in emails', 'ext'],
      ['Export data', 'data'],
      ['Clear local data', 'data'],
      ['Delete account', 'danger'],
    ],
  },
  {
    path: 'Settings › Notifications',
    route: '/settings/notifications',
    secs: [
      ['Notification channels', 'channels'],
      ['Notification topics', 'topics'],
      ['Push notifications for new emails', 'mailpush'],
    ],
  },
  {
    path: 'Settings › Language & region',
    route: '/settings/language',
    secs: [
      ['Language', 'lang'],
      ['Country or region', 'region'],
      ['Time zone', 'region'],
      ['Date format', 'formats'],
      ['Time format', 'formats'],
      ['Week starts on', 'formats'],
      ['Number format', 'formats'],
    ],
  },
  {
    path: 'Settings › About',
    route: '/settings/about',
    secs: [
      ['Version and build', 'version'],
      ['Support', 'support'],
      ['Legal', 'legal'],
      ['Licenses', 'licenses'],
    ],
  },
  { path: 'Account › Profile', route: '/account/profile', secs: [['Profile and display name', 'profile']] },
  { path: 'Account › Email accounts', route: '/account/mail-accounts', secs: [['Email accounts', 'mail']] },
  {
    path: 'Account › Security',
    route: '/account/security',
    secs: [
      ['Change password', 'password'],
      ['Multi-factor authentication', '2fa'],
      ['Signed-in devices', 'sessions'],
    ],
  },
];

/** Expected section index of the administration (with advanced settings). */
const ADMIN_IDX: IdxPage[] = [
  {
    path: 'Administration › Organization',
    route: '/admin/organization',
    secs: [
      ['Company details', 'firm'],
      ['Support contact', 'support'],
      ['Legal notice and privacy policy', 'legal'],
      ['Source code', 'source'],
    ],
  },
  {
    path: 'Administration › Branding',
    route: '/admin/branding',
    secs: [
      ['App name', 'name'],
      ['Logo', 'logo'],
      ['Brand color', 'color'],
      ['Sign-in page', 'login'],
    ],
  },
  {
    path: 'Administration › Banner',
    route: '/admin/banner',
    secs: [
      ['Show banner', 'status'],
      ['Banner text', 'content'],
    ],
  },
  {
    path: 'Administration › Email',
    route: '/admin/email',
    secs: [
      ['Mail server connection', 'conn'],
      ['Sender for system emails', 'sender'],
      ['Delivery', 'delivery'],
      ['Send test email', 'test'],
      ['System email templates', 'tpl'],
    ],
  },
  {
    path: 'Administration › Mail servers',
    route: '/admin/mail-servers',
    secs: [
      ['Mail servers', 'list'],
      ['Allow custom server URLs', 'policy'],
    ],
  },
  {
    path: 'Administration › Updates',
    route: '/admin/updates',
    secs: [
      ['Update status', 'status'],
      ['Access token', 'source'],
      ['Automatic update check', 'schedule'],
    ],
  },
  {
    path: 'Administration › Maintenance',
    route: '/admin/maintenance',
    secs: [
      ['Maintenance mode', 'mode'],
      ['Backups', 'backups'],
      ['Storage', 'storage'],
    ],
  },
  {
    path: 'Administration › Audit log',
    route: '/admin/audit-log',
    secs: [['Audit log retention', 'keep']],
  },
  {
    path: 'Administration › Developer',
    route: '/admin/developer',
    secs: [
      ['Debug mode', 'diag'],
      ['Log level', 'log'],
      ['Test error pages', 'test'],
      ['Environment', 'env'],
    ],
  },
];

/** Sections (`sec/…`) of a category with the target that its `run()` passes to `actions.section`. */
function sectionTargets(inp: SearchItemsInput, cat: Candidate['cat']) {
  const secs = ofCat(searchCandidates(inp), cat).filter((c) => c.id.startsWith('sec/'));
  const section = vi.mocked(inp.actions.section);
  return secs.map((c) => {
    section.mockClear();
    c.run();
    const [route, sec] = section.mock.calls[0] ?? [];
    return { label: c.label, path: c.path, route, sec };
  });
}

const expected = (pages: IdxPage[]) =>
  pages.flatMap((p) => p.secs.map(([label, sec]) => ({ label, path: p.path, route: p.route, sec })));

const PAGES = import.meta.glob<string>('/src/routes/**/+page.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const COMPONENTS = import.meta.glob<string>('/src/lib/components/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Source of a page including the components it includes from `#lib/components/`. */
function pageSource(route: string): string {
  const src = PAGES[`/src/routes${route}/+page.svelte`] ?? '';
  const used = [...src.matchAll(/from '#lib\/components\/(\w+)\.svelte'/g)].map(
    ([, name]) => COMPONENTS[`/src/lib/components/${name}.svelte`] ?? '',
  );
  return [src, ...used].join('\n');
}

/** `data-sec="<sec>"` or, for sections from a list (`data-sec={s.key}`), their `key: '<sec>'`. */
function hasSection(src: string, sec: string): boolean {
  return src.includes(`data-sec="${sec}"`) || (/data-sec=\{\w+\.key\}/.test(src) && src.includes(`key: '${sec}'`));
}

describe('searchCandidates › section index', () => {
  it('settings and account: every section with page and data-sec', () => {
    expect(sectionTargets(input(), 'settings')).toEqual(expected(SETTINGS_IDX));
    expect(sectionTargets(input(), 'admin')).toEqual([]);
  });

  it('administration: every section with page and data-sec, administrators only', () => {
    expect(sectionTargets(input({ isAdmin: true, advanced: true }), 'admin')).toEqual(expected(ADMIN_IDX));
    expect(sectionTargets(input({ isAdmin: true, advanced: true }), 'settings')).toEqual(expected(SETTINGS_IDX));
  });

  it('without advanced settings without the sections of the developer page', () => {
    const off = ADMIN_IDX.filter((p) => p.route !== '/admin/developer');
    expect(sectionTargets(input({ isAdmin: true, advanced: false }), 'admin')).toEqual(expected(off));
  });

  it('every page carries the data-sec of its sections', () => {
    const all = [
      ...sectionTargets(input(), 'settings'),
      ...sectionTargets(input({ isAdmin: true, advanced: true }), 'admin'),
    ];
    expect(all.length).toBe(expected([...SETTINGS_IDX, ...ADMIN_IDX]).length);
    const missing = all.filter((t) => !hasSection(pageSource(t.route!), t.sec!)).map((t) => `${t.route} ${t.sec}`);
    expect(missing).toEqual([]);
  });
});

describe('searchCandidates › actions', () => {
  it('desktop: all actions with keys, without inviting for users', () => {
    const inp = input({ dark: true });
    const list = ofCat(searchCandidates(inp), 'actions');
    expect(list.map((c) => [c.label, c.path, c.k])).toEqual([
      ['New email', 'Shortcut C', 'C'],
      ['Switch to light theme', 'Action', undefined],
      ['Show or hide sidebar', 'Shortcut [', '['],
      ['Show keyboard shortcuts', 'Shortcut ?', '?'],
      ['Open command palette', 'Shortcut Ctrl K', 'Ctrl K'],
      ['Add email account', 'Action', undefined],
      ['Sign out', 'Action', undefined],
    ]);
    expect(byLabel(list, 'Switch to light theme')?.icon).toBe('ti-sun');
    expect(byLabel(list, 'Sign out')?.extra).toBe('logout sign out log out');
    byLabel(list, 'New email')!.run();
    byLabel(list, 'Open command palette')!.run();
    expect(inp.actions.compose).toHaveBeenCalledOnce();
    expect(inp.actions.palette).toHaveBeenCalledOnce();
  });

  it('administrators can invite', () => {
    const inp = input({ isAdmin: true });
    const invite = byLabel(ofCat(searchCandidates(inp), 'actions'), 'Invite user')!;
    expect(invite).toMatchObject({ path: 'Action', icon: 'ti-user-plus' });
    invite.run();
    expect(inp.actions.invite).toHaveBeenCalledOnce();
  });

  it('mobile without sidebar, keyboard shortcuts and command palette', () => {
    const list = ofCat(searchCandidates(input({ isMobile: true, mod: '⌘' })), 'actions');
    expect(list.map((c) => c.label)).toEqual(['New email', 'Switch to dark theme', 'Add email account', 'Sign out']);
    expect(byLabel(list, 'Switch to dark theme')?.icon).toBe('ti-moon');
  });
});

describe('searchCandidates with scoreAll', () => {
  it('scores the label before search help', () => {
    const scored = scoreAll(searchCandidates(input()), termsOf('inbo').terms);
    // Sections with "inbox" in the search help follow with a lower score.
    expect(scored.map((s) => [s.cat, s.label, s.score])).toEqual([
      ['folders', 'Inbox', 80],
      ['settings', 'Open on startup', 15],
      ['settings', 'Push notifications for new emails', 15],
    ]);
    const devices = scoreAll(searchCandidates(input()), termsOf('devices').terms);
    expect(devices.map((s) => [s.label, s.score])).toEqual([['Signed-in devices', 60]]);
  });

  it('takes the keywords from the language of the interface', () => {
    const dark = scoreAll(searchCandidates(input()), termsOf('dark').terms);
    expect(dark.map((s) => s.label)).toContain('Color scheme');
    expect(scoreAll(searchCandidates(input()), termsOf('dunkel').terms)).toEqual([]);
    const trash = scoreAll(searchCandidates(input()), termsOf('bin').terms);
    expect(trash.map((s) => s.cat)).toContain('folders');
    prefs.set({ lang: 'de' });
    try {
      const label = m.appearance_tab_mode({}, { locale: 'de' });
      const german = scoreAll(searchCandidates(input()), termsOf('dunkel').terms);
      expect(german.map((s) => s.label)).toContain(label);
    } finally {
      prefs.set({ lang: 'en' });
    }
  });
});

describe('hitBox', () => {
  const hit = (ids: string[]): MailHit => ({
    account: 'k1',
    id: 'e1',
    threadId: 't1',
    mailboxIds: Object.fromEntries(ids.map((id) => [id, true])),
    keywords: {},
    receivedAt: '2026-11-01T10:00:00Z',
    from: null,
    to: null,
    subject: null,
    attachments: [],
    snippet: null,
  });

  it('role before custom folder', () => {
    expect(hitBox(hit(['al', 'in']), BOXES)).toEqual({
      label: 'Inbox',
      role: 'inbox',
      target: { role: 'inbox' },
    });
    expect(hitBox(hit(['pl']), BOXES)).toEqual({
      label: 'Scheduled',
      role: 'scheduled',
      target: { role: 'scheduled' },
    });
  });

  it('custom folder, tag mailboxes skipped', () => {
    expect(hitBox(hit(['red', 'al']), BOXES)).toEqual({ label: 'Alpha', role: null, target: { folder: 'al' } });
  });

  it('null without a folder', () => {
    expect(hitBox(hit(['red']), BOXES)).toBeNull();
    expect(hitBox(hit(['missing']), BOXES)).toBeNull();
  });

  it('only in one tag: the tag as target', () => {
    const tagOf = (id: string) => (id === 'red' ? { id: 'tg1', name: 'Red' } : undefined);
    expect(hitBox(hit(['red']), BOXES, tagOf)).toEqual({ label: 'Red', role: null, target: { tag: 'tg1' } });
  });
});

describe('notifItems', () => {
  /** Monday, 2 November 2026, 13:00 in Berlin (CET). */
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const TIME: TimeContext = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' };

  function notif(id: string, over: Partial<AppNotification> = {}): AppNotification {
    return {
      id,
      topic: 'security',
      kind: 'login.new_device',
      icon: 'ti-login',
      title: 'New sign-in',
      text: 'Firefox on Linux',
      target: { view: 'settings', page: 'security', path: '/account/security' },
      created_at: '2026-11-02T08:30:00Z',
      read_at: null,
      ...over,
    };
  }

  const LIST: AppNotification[] = [
    notif('n1'),
    notif('n2', {
      topic: 'team',
      kind: 'user.joined',
      icon: 'ti-user-plus',
      title: 'Invitation accepted',
      text: 'Bo joined the team',
      target: { view: 'admin', page: 'users', path: '/admin/users', user_id: 'u7' },
      created_at: '2026-11-01T09:00:00Z',
      read_at: '2026-11-01T10:00:00Z',
    }),
    notif('n3', { icon: 'ti-unknown-icon', title: 'Storage almost full', text: '', target: null }),
  ];

  it('title, icon, text as the path, time on the right and unread bold', () => {
    const list = notifItems(LIST, TIME, vi.fn(), vi.fn());
    expect(list.map((c) => [c.cat, c.id, c.label, c.icon, c.path, c.side, c.unread, c.extra])).toEqual([
      ['notifs', 'n1', 'New sign-in', 'ti-login', 'Firefox on Linux', '09:30', true, 'Firefox on Linux'],
      [
        'notifs',
        'n2',
        'Invitation accepted',
        'ti-user-plus',
        'Bo joined the team',
        m.list_yesterday(),
        false,
        'Bo joined the team',
      ],
      ['notifs', 'n3', 'Storage almost full', 'ti-bell', '', '09:30', true, ''],
    ]);
    expect(list[0]!.t).toBe(Date.parse('2026-11-02T08:30:00Z'));
    expect(list.every((c) => !c.av && !c.tile)).toBe(true);
  });

  it('scored by title before text, every word must match', () => {
    const list = notifItems(LIST, TIME, vi.fn(), vi.fn());
    const scored = (q: string) =>
      scoreAll(list, termsOf(q).terms)
        .sort((a, b) => b.score - a.score)
        .map((c) => [c.id, c.score]);
    expect(scored('invitation')).toEqual([['n2', 80]]);
    expect(scored('sign')).toEqual([['n1', 60]]);
    expect(scored('firefox')).toEqual([['n1', 15]]);
    expect(scored('storage full')).toEqual([['n3', 70]]);
    expect(scored('team bo')).toEqual([['n2', 15]]);
    expect(scored('firefox team')).toEqual([]);
  });

  it('a hit marks as read, then leads to the target without expanding a user', () => {
    const calls: string[] = [];
    const go = vi.fn((path: string) => calls.push(`go ${path}`));
    const read = vi.fn((id: string) => calls.push(`read ${id}`));
    const list = notifItems(LIST, TIME, go, read);
    list[0]!.run();
    list[1]!.run();
    expect(calls).toEqual(['read n1', 'go /account/security', 'read n2', 'go /admin/users']);
  });

  it('without a target a hit only marks as read', () => {
    const go = vi.fn();
    const read = vi.fn();
    notifItems(LIST, TIME, go, read)[2]!.run();
    expect(read).toHaveBeenCalledExactlyOnceWith('n3');
    expect(go).not.toHaveBeenCalled();
  });

  it('not part of the other local categories', () => {
    expect(ofCat(searchCandidates(input({ isAdmin: true })), 'notifs')).toEqual([]);
  });
});
