// Mocked API (`/api/v1/**`) and fake JMAP server for audit runs in the
// development browser (scripts/a11y/audit.mjs, visual checks). All data is
// made up (`example.test`); nothing goes to a real server.
//
//   import { setupMocks, unhandled } from './mocks.mjs';
//   await setupMocks(context, { mode: 'dark', guest: false });
//
// Options of `setupMocks`:
//   mode        theme of the settings ('light', 'dark', 'system')
//   animations  setting "Animations" (app default: on)
//   guest       not signed in (`auth/me` 401)
//   setup       setup pending (`setup_required`)
//   noAccount   without a mail account
//   loginFail   `POST auth/login` with wrong credentials (422)
//   jmapDelay   delay JMAP responses by this many milliseconds (skeletons)
//   control     object the caller can change later (`control.jmapDelay`)
//   unread/read number of unread or read notifications
//   gUndo       duration of the toast with "Undo" ('3 s', '5 s', '10 s')
//   onUnhandled callback per unanswered request (mock gap)
// Unanswered endpoints also end up in `unhandled`.

export const JMAP = 'https://mail.example.test';
export const ACCOUNT_ID = 'a1';
/** Conversation with two messages that the reading view opens. */
export const OPEN_THREAD = 'th1';

/** Unanswered requests ("GET path", "JMAP method"). */
export const unhandled = new Set();

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600_000).toISOString();
const ahead = (hours) => new Date(NOW + hours * 3600_000).toISOString();

const BRANDING = {
  kind: 'standard',
  letter: '',
  icon: 'ti-mountain',
  image: null,
  fit: 'padded',
  plate: 'accent',
  tilt: true,
  color: 'apricot',
  userAccent: true,
  loginTitle: 'Welcome back',
  loginText: 'Sign in with your account.',
  loginArt: true,
};
const ORG = {
  name: 'Example Ltd',
  website: 'https://www.example.test',
  help: null,
  email: 'help@example.test',
  imprint: null,
  privacy: null,
  terms: null,
  source: null,
};
const ME = {
  id: 'u1',
  username: 'max',
  email: 'max@example.test',
  display_name: 'Max Example',
  role: 'admin',
  mfa_enabled: false,
  password_changed_at: ago(24 * 14),
  email_change: null,
  system_mail_configured: true,
  sole_admin: false,
};
const MAIL_ACCOUNT = {
  id: ACCOUNT_ID,
  email: 'max@example.test',
  username: 'max@example.test',
  url: JMAP,
  host: 'mail.example.test',
  server_id: 's1',
  auth_kind: 'oauth',
  color: 2,
  state: 'ok',
  blocked: false,
  quota_used: 1_200_000_000,
  quota_total: 5_000_000_000,
  last_check_at: ago(1),
  created_at: ago(24 * 13),
};
const diag = { reach: 'ok', cors: 'ok', oauth: 'ok' };
const ADMIN_SERVER = {
  id: 's1',
  label: 'Example Mail',
  url: JMAP,
  host: 'mail.example.test',
  domains: ['example.test'],
  client_id: 'roedy-mail',
  has_secret: true,
  ...diag,
  tested_at: ago(2),
  accounts: 3,
};
const LOGIN_SERVER = {
  id: 's1',
  label: 'Example Mail',
  url: JMAP,
  host: 'mail.example.test',
  domains: ['example.test'],
  client_id: 'roedy-mail',
  backend_exchange: true,
  ...diag,
};
const USERS = [
  {
    id: 'u1',
    status: 'active',
    name: 'Max Example',
    email: 'max@example.test',
    username: 'max',
    role: 'admin',
    mfa: false,
    last_seen_at: ago(0.2),
    created_at: ago(24 * 30),
  },
  {
    id: 'u2',
    status: 'active',
    name: 'Erika Example',
    email: 'erika@example.test',
    username: 'erika',
    role: 'user',
    mfa: true,
    last_seen_at: ago(5),
    created_at: ago(24 * 20),
  },
  {
    id: 'u3',
    status: 'locked',
    name: 'Jonas Test',
    email: 'jonas@example.test',
    username: 'jonas',
    role: 'user',
    mfa: false,
    last_seen_at: ago(24 * 9),
    created_at: ago(24 * 19),
  },
  {
    id: 'u4',
    status: 'invited',
    name: null,
    email: 'new@example.test',
    role: 'user',
    mfa: false,
    created_at: ago(30),
    invited_by: { id: 'u1', name: 'Max Example' },
    mail_sent_at: ago(30),
    expires_at: ahead(24 * 6),
    expired: false,
  },
];
const AUDIT = [
  ['login', 'ti-login', 'Max Example', 'signed in', 'Chrome on Linux', false],
  ['users', 'ti-user-plus', 'Max Example', 'invited new@example.test', 'Role User', false],
  ['login', 'ti-alert-triangle', 'jonas@example.test', 'Sign-in failed', '5 attempts', true],
  ['settings', 'ti-palette', 'Max Example', 'changed the branding', 'Accent color', false],
  ['system', 'ti-database-export', 'System', 'Backup created', '12 MB', false],
].map(([cat, icon, who, act, meta, warn], i) => ({ id: 100 - i, at: ago(i * 5 + 1), cat, icon, who, act, meta, warn }));

function notifications(unread, read) {
  return Array.from({ length: unread + read }, (_, i) => ({
    id: `n${i}`,
    topic: 'security',
    kind: 'login',
    icon: i % 2 ? 'ti-shield-lock' : 'ti-login',
    title: i % 2 ? 'New sign-in to your account' : 'Password changed',
    text: 'Chrome on Linux, Berlin',
    target: null,
    created_at: ago(i * 7),
    read_at: i >= unread ? ago(0) : null,
  }));
}

// --- JMAP ---------------------------------------------------------------

const CAP = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  sub: 'urn:ietf:params:jmap:submission',
  vac: 'urn:ietf:params:jmap:vacationresponse',
  sieve: 'urn:ietf:params:jmap:sieve',
  vapid: 'urn:ietf:params:jmap:webpush-vapid',
  epush: 'urn:ietf:params:jmap:emailpush',
  quota: 'urn:ietf:params:jmap:quota',
};

function jmapSession() {
  const accountCaps = {
    [CAP.mail]: {
      maxMailboxesPerEmail: null,
      maxMailboxDepth: 10,
      maxSizeMailboxName: 255,
      maxSizeAttachmentsPerEmail: 50_000_000,
      emailQuerySortOptions: ['receivedAt'],
      mayCreateTopLevelMailbox: true,
    },
    [CAP.sub]: { maxDelayedSend: 2_592_000, submissionExtensions: {} },
    [CAP.vac]: {},
    [CAP.quota]: {},
    [CAP.sieve]: {
      maxSizeScriptName: 512,
      maxSizeScript: 1_048_576,
      maxNumberScripts: 100,
      maxNumberRedirects: 1,
      sieveExtensions: ['fileinto', 'imap4flags', 'copy', 'vacation', 'body'],
      notificationMethods: null,
      externalLists: null,
      implementation: 'Stalwart',
    },
  };
  return {
    capabilities: {
      [CAP.core]: {
        maxSizeUpload: 50_000_000,
        maxConcurrentUpload: 4,
        maxSizeRequest: 10_000_000,
        maxConcurrentRequests: 4,
        maxCallsInRequest: 32,
        maxObjectsInGet: 500,
        maxObjectsInSet: 500,
        collationAlgorithms: ['i;unicode-casemap'],
      },
      [CAP.mail]: {},
      [CAP.sub]: {},
      [CAP.vac]: {},
      [CAP.quota]: {},
      [CAP.sieve]: { implementation: 'Stalwart' },
      [CAP.vapid]: {
        applicationServerKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
      },
      [CAP.epush]: {},
    },
    accounts: {
      j1: { name: 'max@example.test', isPersonal: true, isReadOnly: false, accountCapabilities: accountCaps },
    },
    primaryAccounts: Object.fromEntries(Object.keys(accountCaps).map((k) => [k, 'j1'])),
    username: 'max@example.test',
    apiUrl: `${JMAP}/jmap/`,
    downloadUrl: `${JMAP}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${JMAP}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${JMAP}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 's1',
  };
}

const RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};
const mailbox = (id, name, role = null, parentId = null, sortOrder = 10) => ({
  id,
  name,
  role,
  parentId,
  sortOrder,
  myRights: RIGHTS,
  isSubscribed: true,
});
const MAILBOXES = [
  mailbox('m-in', 'Inbox', 'inbox', null, 1),
  mailbox('m-dr', 'Drafts', 'drafts', null, 2),
  mailbox('m-se', 'Sent', 'sent', null, 3),
  mailbox('m-ar', 'Archive', 'archive', null, 4),
  mailbox('m-ju', 'Spam', 'junk', null, 5),
  mailbox('m-tr', 'Trash', 'trash', null, 6),
  mailbox('m-re', 'Invoices'),
  mailbox('m-pr', 'Projects'),
  mailbox('m-pa', 'Alpha', null, 'm-pr'),
  mailbox('m-nl', 'Newsletter'),
];
const TAGS = [
  { id: 't1', name: 'Important', parent_id: null, color: 1, position: 0, links: [], created_at: ago(24 * 13) },
  { id: 't2', name: 'Read later', parent_id: null, color: 3, position: 1, links: [], created_at: ago(24 * 13) },
];

const PEOPLE = [
  ['Erika Example', 'erika@example.test'],
  ['Jonas Test', 'jonas@example.test'],
  ['Lena Sample', 'lena@example.test'],
  ['Billing office', 'billing@example.test'],
  ['Club board', 'board@club.example.test'],
  ['Garden newsletter', 'news@garden.example.test'],
];
const SUBJECTS = [
  'Meeting on Thursday',
  'Your invoice for October',
  'Minutes of the meeting',
  'Photos from the trip',
  'Newsletter: autumn in the garden',
  'Question about the offer',
  'Invitation to the general meeting',
  'New version of the draft',
  'Vacation planning 2027',
  'Quick question',
  'Dentist appointment',
  'Order shipped',
];
const ME_ADDR = { name: 'Max Example', email: 'max@example.test' };
const HTML_BODY =
  '<div><p>Hi Max,</p><p>as discussed, here is the <a href="https://www.example.test/agenda">agenda</a> ' +
  'for Thursday. Please bring the documents.</p><ul><li>Review</li><li>Planning</li><li>Other business</li></ul>' +
  '<p>Best regards<br>Erika</p></div>';

function makeEmail(i, opts) {
  const [name, email] = PEOPLE[i % PEOPLE.length];
  const threadId = i < 2 ? OPEN_THREAD : `th${i}`;
  const id = `e${i}`;
  const html = i === 1 || opts.html;
  const text = `Hi Max,\n\n${SUBJECTS[i % SUBJECTS.length]} – plus a few lines of sample text.\n\nBest regards\n${name}`;
  const body = html ? HTML_BODY : text;
  const boxes = opts.box ?? (i === 3 ? 'm-re' : i === 4 ? 'm-nl' : i === 10 ? 'm-se' : i === 11 ? 'm-dr' : 'm-in');
  return {
    id,
    blobId: `blob-${id}`,
    threadId,
    mailboxIds: { [boxes]: true },
    keywords: i % 3 === 0 ? {} : i === 5 ? { $seen: true, $flagged: true } : { $seen: true },
    size: 4200 + i * 100,
    receivedAt: ago(i * 9 + 0.5),
    sentAt: ago(i * 9 + 0.5),
    messageId: [`${id}@example.test`],
    inReplyTo: i === 1 ? ['e0@example.test'] : null,
    references: i === 1 ? ['e0@example.test'] : null,
    from: [i === 1 ? { name: 'Erika Example', email: 'erika@example.test' } : { name, email }],
    to: [ME_ADDR],
    cc: i === 1 ? [{ name: 'Lena Sample', email: 'lena@example.test' }] : null,
    bcc: null,
    replyTo: null,
    subject: i === 1 ? 'Re: Meeting on Thursday' : SUBJECTS[i % SUBJECTS.length],
    preview: body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 120),
    hasAttachment: i === 2,
    textBody: [
      {
        partId: '1',
        blobId: `blob-${id}-1`,
        size: body.length,
        name: null,
        type: html ? 'text/html' : 'text/plain',
        charset: 'utf-8',
        disposition: null,
        cid: null,
      },
    ],
    htmlBody: [
      {
        partId: '1',
        blobId: `blob-${id}-1`,
        size: body.length,
        name: null,
        type: html ? 'text/html' : 'text/plain',
        charset: 'utf-8',
        disposition: null,
        cid: null,
      },
    ],
    attachments:
      i === 2
        ? [
            {
              partId: '2',
              blobId: `blob-${id}-2`,
              size: 182_000,
              name: 'Minutes.pdf',
              type: 'application/pdf',
              charset: null,
              disposition: 'attachment',
              cid: null,
            },
          ]
        : [],
    bodyValues: { 1: { value: body, isEncodingProblem: false, isTruncated: false } },
  };
}

/** JSON pointer with `*` as in RFC 8620, 3.7 (back-references). */
function pointer(value, path) {
  const parts = path
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  const walk = (v, i) => {
    if (i === parts.length) return v;
    if (parts[i] === '*' && Array.isArray(v))
      return v.flatMap((x) => {
        const r = walk(x, i + 1);
        return Array.isArray(r) ? r : [r];
      });
    return v == null ? undefined : walk(v[parts[i]], i + 1);
  };
  return walk(value, 0);
}

function resolveRefs(args, done) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (!k.startsWith('#')) {
      out[k] = v;
      continue;
    }
    const hit = done.find(([name, , id]) => id === v.resultOf && name === v.name);
    out[k.slice(1)] = hit ? (pointer(hit[1], v.path) ?? []) : [];
  }
  return out;
}

function matches(e, f) {
  if (!f) return true;
  if (f.operator) {
    const r = f.conditions.map((c) => matches(e, c));
    if (f.operator === 'AND') return r.every(Boolean);
    if (f.operator === 'OR') return r.some(Boolean);
    return !r.some(Boolean);
  }
  if (f.inMailbox && !e.mailboxIds[f.inMailbox]) return false;
  if (f.inMailboxOtherThan?.some((id) => e.mailboxIds[id])) return false;
  if (f.hasKeyword && !e.keywords[f.hasKeyword]) return false;
  if (f.notKeyword && e.keywords[f.notKeyword]) return false;
  if (f.after && e.receivedAt < f.after) return false;
  if (f.before && e.receivedAt >= f.before) return false;
  if (f.hasAttachment !== undefined && e.hasAttachment !== f.hasAttachment) return false;
  const hay = {
    text: `${e.subject} ${e.preview} ${e.from[0].name} ${e.from[0].email}`,
    from: `${e.from[0].name} ${e.from[0].email}`,
    to: e.to.map((a) => `${a.name} ${a.email}`).join(' '),
    subject: e.subject,
    body: e.preview,
  };
  for (const k of Object.keys(hay))
    if (f[k] && !hay[k].toLowerCase().includes(String(f[k]).toLowerCase())) return false;
  return true;
}

function mailboxesWithCounts(emails) {
  return MAILBOXES.map((m) => {
    const inBox = emails.filter((e) => e.mailboxIds[m.id]);
    const unread = inBox.filter((e) => !e.keywords.$seen);
    const threads = new Set(inBox.map((e) => e.threadId));
    const unreadThreads = new Set(unread.map((e) => e.threadId));
    return {
      ...m,
      totalEmails: inBox.length,
      unreadEmails: unread.length,
      totalThreads: threads.size,
      unreadThreads: unreadThreads.size,
    };
  });
}

const pick = (obj, props) => (props ? Object.fromEntries(props.filter((p) => p in obj).map((p) => [p, obj[p]])) : obj);

const RULES_MODEL = {
  v: 1,
  forward: { on: false, to: '', keep: true },
  rules: [
    { id: 'r1', name: 'Invoices', on: true, match: 'all', conds: [['from', 'billing@']], acts: [['move', 'm-re']] },
    {
      id: 'r2',
      name: 'Newsletter',
      on: true,
      match: 'any',
      conds: [['subj', 'Newsletter']],
      acts: [
        ['tag', 't1'],
        ['read', ''],
      ],
    },
  ],
};
const SIEVE_SCRIPT =
  'require ["fileinto", "imap4flags", "copy"];\n# Invoices\nif header :contains "from" "billing@" {\n  fileinto "Invoices";\n}\n' +
  `# roedy-mail-rules: ${JSON.stringify(RULES_MODEL)}\n`;

function answer(name, args, st, miss) {
  const accountId = args.accountId ?? 'j1';
  const [type, verb] = name.split('/');
  const list = (items) => ({
    accountId,
    state: 's1',
    list: args.ids ? items.filter((x) => args.ids.includes(x.id)) : items,
    notFound: args.ids ? args.ids.filter((id) => !items.some((x) => x.id === id)) : [],
  });
  switch (name) {
    case 'Mailbox/get':
      return list(mailboxesWithCounts(st.emails));
    case 'Email/get': {
      const res = list(st.emails);
      return { ...res, list: res.list.map((e) => pick(e, args.properties)) };
    }
    case 'Thread/get': {
      const ids = [...new Set(st.emails.map((e) => e.threadId))];
      const threads = ids.map((id) => ({
        id,
        emailIds: st.emails
          .filter((e) => e.threadId === id)
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
          .map((e) => e.id),
      }));
      return list(threads);
    }
    case 'Email/query': {
      let found = st.emails
        .filter((e) => matches(e, args.filter))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      if (args.collapseThreads) {
        const seen = new Set();
        found = found.filter((e) => !seen.has(e.threadId) && seen.add(e.threadId));
      }
      const position = args.position ?? 0;
      const ids = found.slice(position, args.limit ? position + args.limit : undefined).map((e) => e.id);
      return { accountId, queryState: 'q1', canCalculateChanges: false, position, ids, total: found.length };
    }
    case 'Identity/get':
      return list([
        {
          id: 'id1',
          name: 'Max Example',
          email: 'max@example.test',
          replyTo: null,
          bcc: null,
          textSignature: 'Max Example\nExample Ltd',
          htmlSignature: '',
          mayDelete: false,
        },
      ]);
    case 'VacationResponse/get':
      return list([
        {
          id: 'singleton',
          isEnabled: false,
          fromDate: null,
          toDate: null,
          subject: null,
          textBody: null,
          htmlBody: null,
        },
      ]);
    case 'SieveScript/get':
      return list(st.scripts);
    case 'Quota/get':
      return list([
        {
          id: 'q1',
          resourceType: 'octets',
          used: 1_200_000_000,
          hardLimit: 5_000_000_000,
          scope: 'account',
          name: 'max',
          types: ['Mail'],
        },
      ]);
    case 'PushSubscription/get':
      return { list: [], notFound: [] };
    case 'PushSubscription/set':
      return {
        created: {},
        notCreated: Object.fromEntries(Object.keys(args.create ?? {}).map((k) => [k, { type: 'forbidden' }])),
        updated: {},
        destroyed: [],
      };
  }
  if (verb === 'get') return list([]);
  if (verb === 'query')
    return { accountId, queryState: 'q1', canCalculateChanges: false, position: 0, ids: [], total: 0 };
  if (verb === 'changes')
    return {
      accountId,
      oldState: args.sinceState,
      newState: args.sinceState,
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
      ...(type === 'Mailbox' ? { updatedProperties: null } : {}),
    };
  if (verb === 'queryChanges')
    return {
      accountId,
      oldQueryState: args.sinceQueryState,
      newQueryState: args.sinceQueryState,
      added: [],
      removed: [],
    };
  if (verb === 'set') {
    const created = Object.fromEntries(
      Object.keys(args.create ?? {}).map((k) => [k, { id: `new-${k}`, blobId: `blob-new-${k}` }]),
    );
    if (type === 'SieveScript') {
      for (const [k, v] of Object.entries(args.create ?? {}))
        st.scripts.push({ id: created[k].id, name: v.name, blobId: v.blobId, isActive: false });
      for (const [k, v] of Object.entries(args.update ?? {}))
        st.scripts = st.scripts.map((s) => (s.id === k ? { ...s, ...v } : s));
    }
    return {
      accountId,
      oldState: 's1',
      newState: 's1',
      created,
      updated: Object.fromEntries(Object.keys(args.update ?? {}).map((k) => [k, null])),
      destroyed: args.destroy ?? [],
    };
  }
  if (verb === 'validate') return { accountId, error: null };
  miss(`JMAP ${name}`);
  return { accountId };
}

// --- API ----------------------------------------------------------------

/** Made-up license list in the format of `vite/licenses.ts` (packages of the web app and the server). */
const LICENSES = {
  version: 1,
  generated: '2026-11-12T00:00:00.000Z',
  packages: [
    {
      name: 'example-ui',
      version: '2.1.0',
      license: 'MIT',
      url: 'https://example.test/ui',
      origin: 'web',
      texts: [0],
    },
    { name: '@example/font', version: '5.0.1', license: 'OFL-1.1', origin: 'web', texts: [1] },
    { name: 'no-text', version: '0.3.0', license: 'ISC', origin: 'web', texts: [] },
    {
      name: 'example-server',
      version: '0.8.0',
      license: 'MIT OR Apache-2.0',
      url: 'https://example.test/server',
      origin: 'server',
      texts: [0, 2],
    },
  ],
  texts: [
    'MIT License\n\nCopyright (c) Example\n\nPermission is hereby granted, free of charge, …',
    'SIL Open Font License, Version 1.1 …',
    'Apache License, Version 2.0 …',
  ],
};

/** Sets up API and JMAP on a browser context (options in the file header). */
export async function setupMocks(ctx, opts = {}) {
  const base = opts.base ?? process.env.BASE ?? 'http://127.0.0.1:5173';
  const miss = (key) => {
    unhandled.add(key);
    opts.onUnhandled?.(key);
  };
  const st = {
    settings: {
      mode: opts.mode ?? 'light',
      tzAuto: false,
      ...(opts.animations === undefined ? {} : { animations: opts.animations }),
      ...(opts.gUndo ? { gUndo: opts.gUndo } : {}),
      nCh: { app: true, mail: true, push: false },
    },
    version: 1,
    notifications: notifications(opts.unread ?? 3, opts.read ?? 2),
    scripts: [{ id: 'sc1', name: 'roedy-mail', blobId: 'b-sc1', isActive: true }],
    blobs: { 'b-sc1': SIEVE_SCRIPT },
    emails: Array.from({ length: 12 }, (_, i) => makeEmail(i, {})),
  };
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true, configurable: true });
  });

  // `licenses.json` of the build (Settings › About › All licenses); the dev server has none.
  await ctx.route('**/licenses.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LICENSES) }),
  );

  await ctx.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const method = req.method();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => {
      try {
        return req.postDataJSON() ?? {};
      } catch {
        return {};
      }
    };
    const key = `${method} ${path}`;
    const r = apiAnswer(key, path, method, body, st, opts, base, miss);
    if (r) return json(r.body, r.status ?? 200);
    miss(key.replace(/\?.*$/, ''));
    return json({ error: 'not_found' }, 404);
  });

  await ctx.route(`${JMAP}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/jmap/eventsource'))
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'text/event-stream',
        body: 'retry: 3600000\nevent: state\ndata: {"@type":"StateChange","changed":{}}\n\n',
      });
    if (p.startsWith('/.well-known/jmap'))
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify(jmapSession()),
      });
    if (p.startsWith('/jmap/download/')) {
      const blobId = decodeURIComponent(p.split('/')[4]);
      const blob = st.blobs[blobId];
      return blob === undefined
        ? route.fulfill({ status: 404, headers: cors })
        : route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: blob });
    }
    if (p.startsWith('/jmap/upload/')) {
      const id = `b-up${Object.keys(st.blobs).length}`;
      st.blobs[id] = req.postData() ?? '';
      return route.fulfill({
        status: 201,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          accountId: 'j1',
          blobId: id,
          type: 'application/octet-stream',
          size: st.blobs[id].length,
        }),
      });
    }
    if (p === '/jmap/' || p === '/jmap') {
      const delay = opts.control?.jmapDelay ?? opts.jmapDelay ?? 0;
      if (delay) await new Promise((res) => setTimeout(res, delay));
      const done = [];
      for (const [name, args, id] of req.postDataJSON().methodCalls) {
        done.push([name, answer(name, resolveRefs(args, done), st, miss), id]);
      }
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ methodResponses: done, sessionState: 's1' }),
      });
    }
    miss(`JMAP ${req.method()} ${p}`);
    return route.fulfill({ status: 404, headers: cors });
  });
  return st;
}

function apiAnswer(key, path, method, body, st, opts, base, miss) {
  const ok = (b) => ({ body: b });
  const bare = path.replace(/\?.*$/, '');
  switch (`${method} ${bare}`) {
    case 'GET public/config':
      return ok({
        name: 'Roedy Mail',
        branding: BRANDING,
        org: ORG,
        banner: null,
        maintenance: { on: false, message: null },
        version: '0.5.0',
        update: null,
        setup_required: !!opts.setup,
        client_cache_version: 1,
      });
    case 'GET auth/me':
      return opts.guest || opts.setup ? { status: 401, body: { error: 'unauthorized' } } : ok(ME);
    case 'POST auth/login':
      return opts.loginFail ? { status: 422, body: { error: 'invalid_credentials' } } : ok({ status: 'ok', user: ME });
    case 'POST auth/password/forgot':
      return ok({ status: 'ok' });
    case 'POST auth/email/check':
      return ok({ state: 'valid', email: 'new@example.test', own_session: false });
    case 'GET settings':
      return ok({ version: st.version, settings: st.settings });
    case 'PUT settings':
      st.settings = { ...st.settings, ...body().settings };
      st.version++;
      return ok({ version: st.version, settings: st.settings });
    case 'GET mail-accounts':
      return ok({ accounts: opts.noAccount ? [] : [MAIL_ACCOUNT] });
    case `GET mail-accounts/${ACCOUNT_ID}/token`:
      return ok({ accessToken: 'test-token', expiresAt: null, session: jmapSession() });
    case 'GET notifications':
      return ok({ notifications: st.notifications, unread: st.notifications.filter((n) => !n.read_at).length });
    case 'POST notifications/read':
      return ok({});
    case 'GET tags':
      return ok({ tags: TAGS });
    case 'GET push/subscriptions':
      return ok({ subscriptions: [] });
    case 'GET push/vapid-public-key':
      return ok({ key: 'BEl62iUYgUivxIkv69yViEuiBIa' });
    case 'GET servers':
      return ok({ servers: [LOGIN_SERVER], allow_custom_servers: true });
    case 'GET admin/servers':
      return ok({ servers: [ADMIN_SERVER], redirect_uri: `${base}/oauth/callback`, system_mail_server: 's1' });
    case 'GET admin/servers/policy':
      return ok({ allow_custom_servers: true });
    case 'GET auth/sessions':
      return ok({
        sessions: [
          {
            id: 'se1',
            current: true,
            device: 'Chrome on Linux',
            device_type: 'desktop',
            app: null,
            place: 'Berlin',
            ip: '192.0.2.10',
            created_at: ago(30),
            last_seen_at: ago(0),
          },
          {
            id: 'se2',
            current: false,
            device: 'Safari on iPhone',
            device_type: 'mobile',
            app: 'Roedy Mail',
            place: 'Hamburg',
            ip: '198.51.100.7',
            created_at: ago(24 * 3),
            last_seen_at: ago(6),
          },
        ],
      });
    case 'GET auth/totp/devices':
      return ok({ devices: [], recovery: null });
    case 'GET directory':
      return ok({ users: PEOPLE.map(([name, email]) => ({ name, email })) });
    case 'GET users':
      return ok({ users: USERS });
    case 'GET admin/system-mail':
      return ok({
        server_id: 's1',
        auth: 'password',
        user: 'system@example.test',
        has_secret: true,
        identity_id: 'id1',
        sender_name: 'Roedy Mail',
        reply_to: null,
        keep_sent: false,
        status: 'ok',
        reason: null,
        checked_at: ago(3),
        identities: [{ id: 'id1', name: 'Roedy Mail', email: 'system@example.test' }],
      });
    case 'GET admin/system-mail/preview':
      return ok({
        subject: 'Invitation to Roedy Mail',
        from: 'Roedy Mail <system@example.test>',
        to: 'new@example.test',
        body: '<p>Hello,</p><p>You have been invited to Roedy Mail.</p>',
      });
    case 'GET admin/branding':
      return ok({ ...BRANDING, name: 'Roedy Mail', imageName: '', imageMeta: '' });
    case 'GET admin/banner':
      return ok({
        title: 'Maintenance on Saturday',
        text: 'Between 8 and 9 a.m. the service is briefly unavailable.',
        link: '',
        linkLabel: '',
        tone: 'accent',
        icon: 'ti-speakerphone',
        closable: true,
        on: false,
        revision: 1,
      });
    case 'GET admin/org':
      return ok(ORG);
    case 'GET admin/audit':
      return ok({ entries: AUDIT, counts: { all: 5, login: 2, users: 1, settings: 1, system: 1 }, next: null });
    case 'GET admin/audit/retention':
      return ok({ days: 90 });
    case 'GET admin/updates':
      return ok({
        version: '0.5.0',
        latest: '0.5.0',
        available: false,
        status: 'ok',
        reason: null,
        checked_at: ago(4),
        next_at: ahead(20),
        auto: true,
        every: 'daily',
        time: '03:00',
        weekday: 'monday',
        show: true,
        pat: { prefix: 'github_pat_', tail: 'x7Q2', saved_at: ago(24 * 10) },
        update: null,
      });
    case 'GET admin/maintenance':
      return ok({ on: false, message: null });
    case 'GET admin/backups':
      return ok({
        backups: [
          { id: 'b1', at: ago(20), size: 12_400_000, auto: true },
          { id: 'b2', at: ago(44), size: 12_100_000, auto: true },
        ],
        auto: true,
        every: 'daily',
        keep: 30,
        next_at: ahead(4),
      });
    case 'GET admin/storage':
      return ok({ database: 48_000_000, assets: 320_000, asset_name: null, compacted_at: ago(24 * 7) });
    case 'POST setup/token':
      return ok({});
  }
  let m;
  if ((m = /^invites\/([^/]+)$/.exec(bare)) && method === 'GET')
    return ok({
      email: 'new@example.test',
      name: 'Nora New',
      role: 'user',
      inviter: 'Max Example',
      expires_at: ahead(24 * 5),
      expired: false,
      token: m[1],
    });
  if (/^invites\/[^/]+\/link$/.test(bare)) return ok({ url: `${base}/invite/example-link` });
  if (method === 'PUT' || method === 'PATCH' || method === 'POST' || method === 'DELETE') {
    // Writing calls without their own response: confirm empty, but report as a gap.
    miss(`${key.replace(/\?.*$/, '')} (confirmed empty)`);
    return ok({});
  }
  return null;
}
