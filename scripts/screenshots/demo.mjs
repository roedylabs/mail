// Demo data and mocked servers for the README screenshots
// (scripts/screenshots/capture.mjs). Everything is fictitious: people, companies
// and addresses use the reserved `example.com`/`example.org` domains, and no
// request leaves the browser. The JMAP engine (back-references, filters,
// counters) follows scripts/a11y/mocks.mjs, but serves two mail servers so the
// "All accounts" view has something to merge.
//
//   import { setupDemo } from './demo.mjs';
//   await setupDemo(context, { now, mode: 'dark', vacation: true });
//
// Options of `setupDemo`:
//   now         Date the demo data is relative to (the browser clock is set to it)
//   mode        theme of the settings ('light', 'dark')
//   guest       not signed in (`auth/me` answers 401)
//   setup       setup pending (`setup_required`)
//   vacation    vacation reply of the work account switched on
//   onUnhandled callback per unanswered request

export const WORK = 'acc-work';
export const HOME = 'acc-home';

const WORK_JMAP = 'https://mail.example.com';
const HOME_JMAP = 'https://mail.example.org';
const ME_NAME = 'Alex Morgan';
const GiB = 2 ** 30;
/** Version shown by the mocked server; the web app takes its own from ROEDY_VERSION. */
const VERSION = process.env.ROEDY_VERSION || '0.1.0';

/** Builds all data relative to `now`, so that relative times ("10:42", "Yesterday") stay plausible. */
function demoData(now) {
  const NOW = now.getTime();
  const ago = (min) => new Date(NOW - min * 60_000).toISOString();
  const ahead = (min) => new Date(NOW + min * 60_000).toISOString();
  const H = 60;
  const D = 24 * H;

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
    loginText: 'Sign in to read and write your email.',
    loginArt: true,
  };
  const ORG = {
    name: 'Lakeside Studio',
    website: 'https://www.example.com',
    help: 'https://help.example.com',
    email: 'it@example.com',
    imprint: null,
    privacy: 'https://www.example.com/privacy',
    terms: null,
    source: null,
  };
  const ME = {
    id: 'u1',
    username: 'alex',
    email: 'alex@example.com',
    display_name: ME_NAME,
    role: 'admin',
    mfa_enabled: true,
    password_changed_at: ago(41 * D),
    email_change: null,
    system_mail_configured: true,
    sole_admin: false,
  };
  const ACCOUNTS = [
    {
      id: WORK,
      email: 'alex@example.com',
      username: 'alex@example.com',
      url: WORK_JMAP,
      host: 'mail.example.com',
      server_id: 's1',
      auth_kind: 'oauth',
      color: 0,
      state: 'ok',
      blocked: false,
      quota_used: 3_420_000_000,
      quota_total: 10 * GiB,
      last_check_at: ago(12),
      created_at: ago(64 * D),
    },
    {
      id: HOME,
      email: 'alex.morgan@example.org',
      username: 'alex.morgan@example.org',
      url: HOME_JMAP,
      host: 'mail.example.org',
      server_id: 's2',
      auth_kind: 'oauth',
      color: 3,
      state: 'ok',
      blocked: false,
      quota_used: 1_130_000_000,
      quota_total: 5 * GiB,
      last_check_at: ago(12),
      created_at: ago(58 * D),
    },
  ];
  const diag = { reach: 'ok', cors: 'ok', oauth: 'ok' };
  const SERVERS = [
    {
      id: 's1',
      label: 'Lakeside Mail',
      url: WORK_JMAP,
      host: 'mail.example.com',
      domains: ['example.com'],
      client_id: 'roedy-mail',
      has_secret: true,
      backend_exchange: true,
      ...diag,
      tested_at: ago(2 * H),
      accounts: 7,
    },
    {
      id: 's2',
      label: 'Family Mail',
      url: HOME_JMAP,
      host: 'mail.example.org',
      domains: ['example.org'],
      client_id: 'roedy-mail',
      has_secret: true,
      backend_exchange: true,
      ...diag,
      tested_at: ago(2 * H),
      accounts: 2,
    },
  ];
  const user = (id, name, username, role, mfa, seen, created) => ({
    id,
    status: 'active',
    name,
    email: `${username}@example.com`,
    username,
    role,
    mfa,
    last_seen_at: ago(seen),
    created_at: ago(created),
  });
  const USERS = [
    user('u1', ME_NAME, 'alex', 'admin', true, 2, 64 * D),
    user('u2', 'Priya Shah', 'priya', 'admin', true, 35, 63 * D),
    user('u3', 'Daniel Kim', 'daniel', 'user', true, 3 * H, 60 * D),
    user('u4', 'Sofia Martinez', 'sofia', 'user', false, 26 * H, 41 * D),
    user('u5', 'Marcus Lee', 'marcus', 'user', true, 50, 39 * D),
    user('u6', 'Hannah Becker', 'hannah', 'user', false, 6 * D, 22 * D),
    { ...user('u7', 'Tom Walsh', 'tom', 'user', false, 19 * D, 30 * D), status: 'locked' },
    {
      id: 'u8',
      status: 'invited',
      name: 'Nora Quinn',
      email: 'nora@example.com',
      role: 'user',
      mfa: false,
      created_at: ago(20 * H),
      invited_by: { id: 'u1', name: ME_NAME },
      mail_sent_at: ago(20 * H),
      expires_at: ahead(6 * D),
      expired: false,
    },
  ];
  const AUDIT = [
    [12, 'login', 'ti-login', ME_NAME, 'signed in', 'Firefox on macOS', false],
    [95, 'users', 'ti-user-plus', 'Priya Shah', 'invited nora@example.com', 'Role User', false],
    [3 * H, 'settings', 'ti-palette', ME_NAME, 'changed the branding', 'Accent color', false],
    [7 * H, 'login', 'ti-alert-triangle', 'tom@example.com', 'Sign-in failed', '5 attempts', true],
    [9 * H, 'system', 'ti-database-export', 'System', 'Backup created', '14.2 MB', false],
    [26 * H, 'users', 'ti-user-check', 'Sofia Martinez', 'accepted the invitation', 'Role User', false],
    [33 * H, 'system', 'ti-database-export', 'System', 'Backup created', '14.1 MB', false],
  ].map(([min, cat, icon, who, act, meta, warn], i) => ({
    id: 200 - i,
    at: ago(min),
    cat,
    icon,
    who,
    act,
    meta,
    warn,
  }));
  const NOTIFICATIONS = [
    ['security', 'login', 'ti-login', 'New sign-in to your account', 'Safari on iPhone · Portland', 25, false],
    [
      'team',
      'invite_accepted',
      'ti-user-check',
      'Sofia Martinez joined',
      'She accepted your invitation.',
      3 * H,
      false,
    ],
    ['system', 'backup', 'ti-database-export', 'Backup completed', 'Nightly backup · 14.2 MB', 9 * H, true],
    ['account', 'mail_account', 'ti-mail', 'Mail account connected', 'alex.morgan@example.org', 2 * D, true],
  ].map(([topic, kind, icon, title, text, min, read], i) => ({
    id: `n${i}`,
    topic,
    kind,
    icon,
    title,
    text,
    target: null,
    created_at: ago(min),
    read_at: read ? ago(min - 5) : null,
  }));
  const TAGS = [
    { id: 't1', name: 'Important', color: 4 },
    { id: 't2', name: 'Follow up', color: 5 },
    { id: 't3', name: 'Finance', color: 1 },
    { id: 't4', name: 'Travel', color: 3 },
  ].map((t, position) => ({
    ...t,
    parent_id: null,
    position,
    links: [WORK, HOME].map((acc) => ({ mail_account_id: acc, mailbox_id: `${acc}-tag-${t.id}` })),
    created_at: ago(50 * D),
  }));

  return { ago, ahead, H, D, BRANDING, ORG, ME, ACCOUNTS, SERVERS, USERS, AUDIT, NOTIFICATIONS, TAGS };
}

// --- Mail ------------------------------------------------------------------

const p = (...paragraphs) => paragraphs.map((t) => `<p>${t}</p>`).join('');

/**
 * Messages per account: `box` is the mailbox key, `min` minutes before `now`,
 * `tags` tag ids; a thread groups replies (oldest first).
 */
const MAIL = {
  [WORK]: [
    {
      thread: 'roadmap',
      from: ['Priya Shah', 'priya@example.com'],
      cc: [['Daniel Kim', 'daniel@example.com']],
      subject: 'Q4 roadmap review – agenda for Thursday',
      min: 26 * 60 + 15,
      tags: ['t1'],
      seen: true,
      html: p(
        'Hi Alex,',
        'ahead of Thursday’s review I put together a short agenda. Could you take the item on the mobile release and bring the latest numbers from the beta?',
        '<strong>Agenda</strong><br>1. Where we stand on the Q4 goals<br>2. Mobile release and beta feedback<br>3. Hiring plan for the platform team<br>4. Open questions',
        'The slides are attached. Comments welcome until Wednesday evening.',
        'Thanks,<br>Priya',
      ),
      attach: [
        ['Q4-roadmap-review.pdf', 'application/pdf', 1_840_000],
        ['beta-feedback.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 96_000],
      ],
    },
    {
      thread: 'roadmap',
      from: ['Daniel Kim', 'daniel@example.com'],
      to: [['Priya Shah', 'priya@example.com']],
      cc: [[ME_NAME, 'alex@example.com']],
      subject: 'Re: Q4 roadmap review – agenda for Thursday',
      min: 3 * 60 + 40,
      seen: true,
      html: p('Looks good to me. I’ll add two slides on the infrastructure costs under item 4.', 'Daniel'),
    },
    {
      thread: 'roadmap',
      from: ['Priya Shah', 'priya@example.com'],
      cc: [['Daniel Kim', 'daniel@example.com']],
      subject: 'Re: Q4 roadmap review – agenda for Thursday',
      min: 18,
      html: p(
        'Perfect, thank you both. I moved the meeting to the large room on the 4th floor – we’ll be eight people now.',
        'See you Thursday at 10:00!',
        'Priya',
      ),
    },
    {
      thread: 'onboarding',
      from: ['Sofia Martinez', 'sofia@example.com'],
      subject: 'Design review: new onboarding flow',
      min: 52,
      flagged: true,
      html: p(
        'Hi Alex,',
        'the new onboarding screens are ready for review. I simplified the sign-up to two steps and moved the workspace setup to after the first login.',
        'Mock-ups are attached – let me know what you think before Friday.',
        'Sofia',
      ),
      attach: [
        ['onboarding-step-1.png', 'image/png', 412_000],
        ['onboarding-step-2.png', 'image/png', 388_000],
      ],
    },
    {
      thread: 'invoice',
      from: ['Northgate Billing', 'billing@example.org'],
      subject: 'Your invoice INV-2026-1142 is ready',
      min: 2 * 60 + 5,
      tags: ['t3'],
      html: p(
        'Hello,',
        'your invoice for November is ready. The amount of $1,284.00 will be charged to the card on file on December 1.',
        'You can find the invoice as a PDF attached to this email.',
        'Northgate Billing',
      ),
      attach: [['INV-2026-1142.pdf', 'application/pdf', 64_000]],
    },
    {
      thread: 'contract',
      from: ['Marcus Lee', 'marcus@example.com'],
      subject: 'Contract draft v3 for the Harbor project',
      min: 4 * 60 + 30,
      seen: true,
      flagged: true,
      tags: ['t2'],
      html: p(
        'Alex,',
        'legal sent back version 3 of the contract. The changes are in sections 4 (payment terms) and 7 (support hours). Can you have a look by tomorrow noon?',
        'Marcus',
      ),
      attach: [
        ['Harbor-contract-v3.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 212_000],
      ],
    },
    {
      thread: 'lunch',
      from: ['Hannah Becker', 'hannah@example.com'],
      subject: 'Team lunch on Friday?',
      min: 6 * 60 + 10,
      seen: true,
      html: p(
        'Hi everyone,',
        'how about lunch at the new Thai place around the corner on Friday at 12:30? Reply by Thursday so I can book a table.',
        'Hannah',
      ),
    },
    {
      thread: 'api',
      from: ['Olivia Brown', 'olivia@example.org'],
      subject: 'Quick question about the API limits',
      min: 22 * 60,
      seen: true,
      answered: true,
      html: p(
        'Hi Alex,',
        'we are planning a bulk import of about 40,000 contacts next week. Is there a rate limit we should keep in mind, or can we run the import in one go?',
        'Best,<br>Olivia',
      ),
    },
    {
      thread: 'build',
      from: ['Build server', 'ci@example.com'],
      subject: 'Nightly build passed on main',
      min: 30 * 60,
      seen: true,
      html: p('All 1,482 tests passed in 6 min 12 s.', 'Artifacts are available for 14 days.'),
    },
    {
      thread: 'weekly',
      from: ['The Weekly Brief', 'news@example.org'],
      subject: 'The Weekly Brief: five ideas for calmer meetings',
      min: 2 * 24 * 60 + 60,
      seen: true,
      html: p(
        'This week: why shorter agendas lead to better decisions, a template for async status updates, and three tools our readers love.',
      ),
    },
    {
      thread: 'flight',
      from: ['Skyline Travel', 'bookings@example.org'],
      subject: 'Your trip to Lisbon: booking confirmed',
      min: 3 * 24 * 60 + 200,
      seen: true,
      tags: ['t4'],
      html: p(
        'Thank you for your booking. Flight SK 482 departs on December 9 at 07:25.',
        'Your e-ticket and the hotel voucher are attached.',
      ),
      attach: [['e-ticket.pdf', 'application/pdf', 118_000]],
    },
    {
      thread: 'maint',
      from: ['IT Support', 'it@example.com'],
      subject: 'Scheduled maintenance this Saturday',
      min: 4 * 24 * 60 + 90,
      seen: true,
      html: p('On Saturday between 8:00 and 9:00 the VPN will be briefly unavailable. Email is not affected.'),
    },
    {
      thread: 'sent-1',
      box: 'sent',
      from: [ME_NAME, 'alex@example.com'],
      to: [['Olivia Brown', 'olivia@example.org']],
      subject: 'Re: Quick question about the API limits',
      min: 20 * 60,
      seen: true,
      html: p(
        'Hi Olivia,',
        'the limit is 600 requests per minute. For 40,000 contacts the batch endpoint is the better choice – it takes 500 contacts per call.',
        'Alex',
      ),
    },
    {
      thread: 'draft-1',
      box: 'drafts',
      from: [ME_NAME, 'alex@example.com'],
      to: [['Marcus Lee', 'marcus@example.com']],
      subject: 'Re: Contract draft v3 for the Harbor project',
      min: 3 * 60,
      seen: true,
      draft: true,
      html: p('Hi Marcus,', 'section 4 looks fine. On section 7 I would'),
    },
    {
      thread: 'archived-1',
      box: 'archive',
      from: ['Priya Shah', 'priya@example.com'],
      subject: 'Offsite photos',
      min: 12 * 24 * 60,
      seen: true,
      html: p('Here are the photos from the offsite. Thanks for a great two days!'),
    },
  ],
  [HOME]: [
    {
      thread: 'weekend',
      from: ['Jamie Morgan', 'jamie@example.org'],
      subject: 'Weekend plans',
      min: 75,
      html: p(
        'Hey,',
        'the weather looks great for Saturday. Shall we take the bikes to the lake and have lunch at the boathouse?',
        'J.',
      ),
    },
    {
      thread: 'books',
      from: ['Riverside Book Club', 'club@example.org'],
      subject: 'November pick: “The Lighthouse Keeper”',
      min: 5 * 60 + 20,
      seen: true,
      html: p('Our next meeting is on November 27 at 7 pm in the library’s reading room.'),
    },
    {
      thread: 'order',
      from: ['Corner Shop', 'orders@example.org'],
      subject: 'Your order #20419 has shipped',
      min: 27 * 60,
      seen: true,
      tags: ['t3'],
      html: p('Good news: your order is on its way and should arrive on Thursday.'),
    },
    {
      thread: 'garden',
      from: ['Community Garden', 'garden@example.org'],
      subject: 'Autumn planting day',
      min: 3 * 24 * 60 + 30,
      seen: true,
      html: p('Join us on Sunday at 10 am to plant bulbs for the spring.'),
    },
  ],
};

const MAILBOX_LAYOUT = {
  [WORK]: [
    ['inbox', 'Inbox', 'inbox', null, 1],
    ['drafts', 'Drafts', 'drafts', null, 2],
    ['sent', 'Sent', 'sent', null, 3],
    ['archive', 'Archive', 'archive', null, 4],
    ['junk', 'Spam', 'junk', null, 5],
    ['trash', 'Trash', 'trash', null, 6],
    ['projects', 'Projects', null, null, 10],
    ['harbor', 'Harbor', null, 'projects', 10],
    ['website', 'Website relaunch', null, 'projects', 11],
    ['receipts', 'Receipts', null, null, 11],
  ],
  [HOME]: [
    ['inbox', 'Inbox', 'inbox', null, 1],
    ['drafts', 'Drafts', 'drafts', null, 2],
    ['sent', 'Sent', 'sent', null, 3],
    ['archive', 'Archive', 'archive', null, 4],
    ['junk', 'Spam', 'junk', null, 5],
    ['trash', 'Trash', 'trash', null, 6],
    ['family', 'Family', null, null, 10],
  ],
};

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

function mailboxesOf(acc, tags) {
  const id = (key) => `${acc}-${key}`;
  const boxes = MAILBOX_LAYOUT[acc].map(([key, name, role, parent, sortOrder]) => ({
    id: id(key),
    name,
    role,
    parentId: parent ? id(parent) : null,
    sortOrder,
    myRights: RIGHTS,
    isSubscribed: true,
  }));
  boxes.push({
    id: id('tags'),
    name: 'Tags',
    role: null,
    parentId: null,
    sortOrder: 50,
    myRights: RIGHTS,
    isSubscribed: true,
  });
  for (const t of tags)
    boxes.push({
      id: id(`tag-${t.id}`),
      name: t.name,
      role: null,
      parentId: id('tags'),
      sortOrder: t.position,
      myRights: RIGHTS,
      isSubscribed: true,
    });
  return boxes;
}

const toText = (html) =>
  html
    .replace(/<br>/g, '\n')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim();

function emailsOf(acc, ago) {
  const meAddr = acc === WORK ? 'alex@example.com' : 'alex.morgan@example.org';
  return MAIL[acc].map((m, i) => {
    const id = `${acc}-e${i}`;
    const keywords = {};
    if (m.seen) keywords.$seen = true;
    if (m.flagged) keywords.$flagged = true;
    if (m.answered) keywords.$answered = true;
    if (m.draft) keywords.$draft = true;
    const mailboxIds = { [`${acc}-${m.box ?? 'inbox'}`]: true };
    for (const t of m.tags ?? []) mailboxIds[`${acc}-tag-${t}`] = true;
    const text = toText(m.html);
    const part = (partId, type, size, name = null, disposition = null) => ({
      partId,
      blobId: `blob-${id}-${partId}`,
      size,
      name,
      type,
      charset: type.startsWith('text/') ? 'utf-8' : null,
      disposition,
      cid: null,
    });
    const addr = ([name, email]) => ({ name, email });
    return {
      id,
      blobId: `blob-${id}`,
      threadId: `${acc}-${m.thread}`,
      mailboxIds,
      keywords,
      size: 6_000 + m.html.length + (m.attach ?? []).reduce((s, a) => s + a[2], 0),
      receivedAt: ago(m.min),
      sentAt: ago(m.min),
      messageId: [`${id}@example.com`],
      inReplyTo: null,
      references: null,
      from: [addr(m.from)],
      to: (m.to ?? [[ME_NAME, meAddr]]).map(addr),
      cc: m.cc ? m.cc.map(addr) : null,
      bcc: null,
      replyTo: null,
      subject: m.subject,
      preview: text.replace(/\s+/g, ' ').slice(0, 160),
      hasAttachment: !!m.attach?.length,
      textBody: [part('1', 'text/html', m.html.length)],
      htmlBody: [part('1', 'text/html', m.html.length)],
      attachments: (m.attach ?? []).map(([name, type, size], k) => part(String(k + 2), type, size, name, 'attachment')),
      bodyValues: { 1: { value: `<div>${m.html}</div>`, isEncodingProblem: false, isTruncated: false } },
    };
  });
}

// --- JMAP ------------------------------------------------------------------

const CAP = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  sub: 'urn:ietf:params:jmap:submission',
  vac: 'urn:ietf:params:jmap:vacationresponse',
  sieve: 'urn:ietf:params:jmap:sieve',
  quota: 'urn:ietf:params:jmap:quota',
  vapid: 'urn:ietf:params:jmap:webpush-vapid',
  epush: 'urn:ietf:params:jmap:emailpush',
};

function jmapSession(base, username) {
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
      // Any valid P-256 public key: the push subscription itself is never created.
      [CAP.vapid]: {
        applicationServerKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
      },
      [CAP.epush]: {},
    },
    accounts: {
      j1: { name: username, isPersonal: true, isReadOnly: false, accountCapabilities: accountCaps },
    },
    primaryAccounts: Object.fromEntries(Object.keys(accountCaps).map((k) => [k, 'j1'])),
    username,
    apiUrl: `${base}/jmap/`,
    downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${base}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${base}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 's1',
  };
}

/** JSON pointer with `*` as in RFC 8620, 3.7 (back-references). */
function pointer(value, path) {
  const parts = path
    .split('/')
    .slice(1)
    .map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
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

function withCounts(boxes, emails) {
  return boxes.map((m) => {
    const inBox = emails.filter((e) => e.mailboxIds[m.id]);
    const unread = inBox.filter((e) => !e.keywords.$seen);
    return {
      ...m,
      totalEmails: inBox.length,
      unreadEmails: unread.length,
      totalThreads: new Set(inBox.map((e) => e.threadId)).size,
      unreadThreads: new Set(unread.map((e) => e.threadId)).size,
    };
  });
}

const pick = (obj, props) => (props ? Object.fromEntries(props.filter((k) => k in obj).map((k) => [k, obj[k]])) : obj);

function rulesScript(acc) {
  const model = {
    v: 1,
    forward: { on: false, to: '', keep: true },
    rules: [
      {
        id: 'r1',
        name: 'Invoices and receipts',
        on: true,
        match: 'any',
        conds: [
          ['from', 'billing@'],
          ['subj', 'invoice'],
        ],
        acts: [
          ['move', `${acc}-receipts`],
          ['tag', 't3'],
        ],
      },
      {
        id: 'r2',
        name: 'Newsletters',
        on: true,
        match: 'all',
        conds: [['from', 'news@example.org']],
        acts: [['read', '']],
      },
      {
        id: 'r3',
        name: 'Harbor project',
        on: true,
        match: 'any',
        conds: [['subj', 'Harbor']],
        acts: [['move', `${acc}-harbor`]],
      },
      {
        id: 'r4',
        name: 'Build notifications',
        on: false,
        match: 'all',
        conds: [['from', 'ci@example.com']],
        acts: [['del', '']],
      },
    ],
  };
  return (
    'require ["fileinto", "imap4flags", "copy"];\n' +
    'if header :contains "from" "billing@" {\n  fileinto "Receipts";\n}\n' +
    `# roedy-mail-rules: ${JSON.stringify(model)}\n`
  );
}

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
      return list(withCounts(st.mailboxes, st.emails));
    case 'Email/get': {
      const res = list(st.emails);
      return { ...res, list: res.list.map((e) => pick(e, args.properties)) };
    }
    case 'Thread/get': {
      const ids = [...new Set(st.emails.map((e) => e.threadId))];
      return list(
        ids.map((id) => ({
          id,
          emailIds: st.emails
            .filter((e) => e.threadId === id)
            .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
            .map((e) => e.id),
        })),
      );
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
      return list([st.identity]);
    case 'VacationResponse/get':
      return list([st.vacation]);
    case 'SieveScript/get':
      return list(st.scripts);
    case 'Quota/get':
      return list([
        {
          id: 'q1',
          resourceType: 'octets',
          used: st.quota[0],
          hardLimit: st.quota[1],
          scope: 'account',
          name: st.identity.email,
          types: ['Mail'],
        },
      ]);
    case 'PushSubscription/get':
      return { list: [], notFound: [] };
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
    if (type === 'Email')
      for (const [k, v] of Object.entries(args.update ?? {})) {
        const e = st.emails.find((x) => x.id === k);
        if (!e) continue;
        for (const [path, val] of Object.entries(v)) {
          if (path === 'keywords') e.keywords = val;
          else if (path.startsWith('keywords/')) {
            const kw = path.slice(9);
            if (val) e.keywords[kw] = true;
            else delete e.keywords[kw];
          }
        }
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

/** Fake mail server of one account. */
function mailServer(acc, data, opts) {
  const work = acc === WORK;
  const email = work ? 'alex@example.com' : 'alex.morgan@example.org';
  const scripts = work ? [{ id: 'sc1', name: 'roedy-mail', blobId: 'b-sc1', isActive: true }] : [];
  return {
    base: work ? WORK_JMAP : HOME_JMAP,
    username: email,
    mailboxes: mailboxesOf(acc, data.TAGS),
    emails: emailsOf(acc, data.ago),
    identity: {
      id: 'id1',
      name: ME_NAME,
      email,
      replyTo: null,
      bcc: null,
      textSignature: work ? `${ME_NAME}\nProduct Lead · Lakeside Studio` : '',
      htmlSignature: '',
      mayDelete: false,
    },
    vacation: {
      id: 'singleton',
      isEnabled: work && !!opts.vacation,
      fromDate: work && opts.vacation ? data.ahead(14 * data.D) : null,
      toDate: work && opts.vacation ? data.ahead(24 * data.D) : null,
      subject: work && opts.vacation ? 'Out of office until December 11' : null,
      textBody:
        work && opts.vacation
          ? 'Thanks for your email. I am out of the office and will reply after December 11. For urgent questions please contact Priya Shah (priya@example.com).'
          : null,
      htmlBody: null,
    },
    scripts,
    blobs: work ? { 'b-sc1': rulesScript(acc) } : {},
    quota: work ? [3_420_000_000, 10 * GiB] : [1_130_000_000, 5 * GiB],
  };
}

// --- API -------------------------------------------------------------------

/** Sets up API and both JMAP servers on a browser context. */
export async function setupDemo(ctx, opts = {}) {
  const now = opts.now ?? new Date();
  const data = demoData(now);
  const base = process.env.BASE ?? 'http://127.0.0.1:5173';
  const miss = (key) => opts.onUnhandled?.(key);
  const st = {
    settings: {
      mode: opts.mode ?? 'light',
      lang: 'en',
      region: 'US',
      dateFmt: 'us',
      timeFmt: '12h',
      weekStart: 'sunday',
      numFmt: '1,234.56',
      tzAuto: true,
      tz: 'America/New_York',
      defaultAccount: 'all',
      nCh: { app: true, mail: true, push: false },
      ...opts.settings,
    },
    version: 1,
  };
  const servers = Object.fromEntries([WORK, HOME].map((acc) => [acc, mailServer(acc, data, opts)]));

  await ctx.clock.install({ time: now });
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true, configurable: true });
  });
  await ctx.route('**/licenses.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, generated: now.toISOString(), packages: [], texts: [] }),
    }),
  );

  await ctx.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const method = req.method();
    const r = apiAnswer(method, path, data, st, servers, opts, base);
    if (r)
      return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
    miss(`${method} ${path}`);
    if (method !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
  });

  for (const srv of Object.values(servers)) {
    await ctx.route(`${srv.base}/**`, async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (path.startsWith('/jmap/eventsource'))
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: 'text/event-stream',
          body: 'retry: 3600000\nevent: state\ndata: {"@type":"StateChange","changed":{}}\n\n',
        });
      if (path.startsWith('/.well-known/jmap'))
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify(jmapSession(srv.base, srv.username)),
        });
      if (path.startsWith('/jmap/download/')) {
        const blob = srv.blobs[decodeURIComponent(path.split('/')[4])];
        return blob === undefined
          ? route.fulfill({ status: 404, headers: cors })
          : route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: blob });
      }
      if (path === '/jmap/' || path === '/jmap') {
        const done = [];
        for (const [name, args, id] of req.postDataJSON().methodCalls)
          done.push([name, answer(name, resolveRefs(args, done), srv, miss), id]);
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({ methodResponses: done, sessionState: 's1' }),
        });
      }
      miss(`JMAP ${req.method()} ${path}`);
      return route.fulfill({ status: 404, headers: cors });
    });
  }
  return { data, st, servers };
}

function apiAnswer(method, path, d, st, servers, opts, base) {
  const ok = (body) => ({ body });
  const bare = path.replace(/\?.*$/, '');
  const { ago, ahead, H, D } = d;
  switch (`${method} ${bare}`) {
    case 'GET public/config':
      return ok({
        name: 'Roedy Mail',
        branding: d.BRANDING,
        org: d.ORG,
        banner: null,
        maintenance: { on: false, message: null },
        version: VERSION,
        update: null,
        setup_required: !!opts.setup,
        client_cache_version: 1,
      });
    case 'GET auth/me':
      return opts.guest || opts.setup ? { status: 401, body: { error: 'unauthorized' } } : ok(d.ME);
    case 'POST auth/login':
      return ok({ status: 'ok', user: d.ME });
    case 'GET settings':
      return ok({ version: st.version, settings: st.settings });
    case 'PUT settings':
      st.version++;
      return ok({ version: st.version, settings: st.settings });
    case 'GET mail-accounts':
      return ok({ accounts: d.ACCOUNTS });
    case 'GET notifications':
      return ok({ notifications: d.NOTIFICATIONS, unread: d.NOTIFICATIONS.filter((n) => !n.read_at).length });
    case 'GET tags':
      return ok({ tags: d.TAGS });
    case 'GET push/subscriptions':
      return ok({ subscriptions: [] });
    case 'GET servers':
      return ok({ servers: d.SERVERS, allow_custom_servers: false });
    case 'GET admin/servers':
      return ok({ servers: d.SERVERS, redirect_uri: `${base}/oauth/callback`, system_mail_server: 's1' });
    case 'GET admin/servers/policy':
      return ok({ allow_custom_servers: false });
    case 'GET auth/sessions':
      return ok({
        sessions: [
          {
            id: 'se1',
            current: true,
            device: 'Firefox on macOS',
            device_type: 'desktop',
            app: null,
            place: 'Portland',
            ip: '192.0.2.10',
            created_at: ago(5 * D),
            last_seen_at: ago(0),
          },
          {
            id: 'se2',
            current: false,
            device: 'Safari on iPhone',
            device_type: 'mobile',
            app: 'Roedy Mail',
            place: 'Portland',
            ip: '198.51.100.7',
            created_at: ago(25),
            last_seen_at: ago(25),
          },
        ],
      });
    case 'GET auth/totp/devices':
      return ok({
        devices: [{ id: 'd1', name: 'Authenticator app', created_at: ago(40 * D), last_used_at: ago(5 * D) }],
        recovery: { remaining: 8, created_at: ago(40 * D) },
      });
    case 'GET directory':
      return ok({ users: d.USERS.filter((u) => u.name).map((u) => ({ name: u.name, email: u.email })) });
    case 'GET users':
      return ok({ users: d.USERS });
    case 'GET admin/system-mail':
      return ok({
        server_id: 's1',
        auth: 'password',
        user: 'noreply@example.com',
        has_secret: true,
        identity_id: 'id1',
        sender_name: 'Roedy Mail',
        reply_to: null,
        keep_sent: false,
        status: 'ok',
        reason: null,
        checked_at: ago(3 * H),
        identities: [{ id: 'id1', name: 'Roedy Mail', email: 'noreply@example.com' }],
      });
    case 'GET admin/system-mail/preview':
      return ok({
        subject: 'You are invited to Roedy Mail',
        from: 'Roedy Mail <noreply@example.com>',
        to: 'nora@example.com',
        body: '<p>Hello Nora,</p><p>Alex Morgan invited you to Roedy Mail at Lakeside Studio.</p>',
      });
    case 'GET admin/branding':
      return ok({ ...d.BRANDING, name: 'Roedy Mail', imageName: '', imageMeta: '' });
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
      return ok(d.ORG);
    case 'GET admin/audit':
      return ok({
        entries: d.AUDIT,
        counts: { all: 7, login: 2, users: 2, settings: 1, system: 2 },
        next: null,
      });
    case 'GET admin/audit/retention':
      return ok({ days: 90 });
    case 'GET admin/updates':
      return ok({
        version: VERSION,
        latest: VERSION,
        available: false,
        status: 'ok',
        reason: null,
        checked_at: ago(4 * H),
        next_at: ahead(20 * H),
        auto: true,
        every: 'daily',
        time: '03:00',
        weekday: 'monday',
        show: true,
        pat: null,
        update: null,
      });
    case 'GET admin/maintenance':
      return ok({ on: false, message: null });
    case 'GET admin/backups':
      return ok({
        backups: [
          { id: 'b1', at: ago(9 * H), size: 14_200_000, auto: true },
          { id: 'b2', at: ago(33 * H), size: 14_100_000, auto: true },
          { id: 'b3', at: ago(57 * H), size: 13_900_000, auto: true },
        ],
        auto: true,
        every: 'daily',
        keep: 30,
        next_at: ahead(15 * H),
      });
    case 'GET admin/storage':
      return ok({ database: 52_000_000, assets: 320_000, asset_name: null, compacted_at: ago(7 * D) });
    case 'POST setup/token':
      return ok({ public_url: null });
    case 'POST setup/servers/test':
      return ok({ url: 'https://mail.example.com', host: 'mail.example.com', reach: 'ok', cors: 'ok', oauth: 'ok' });
    case 'POST setup/servers/register-client':
      return ok({ client_id: 'roedy-mail' });
    case 'POST setup/system-mail/test':
      return ok({ status: 'ok' });
  }
  const token = /^mail-accounts\/([^/]+)\/token$/.exec(bare);
  if (token && servers[token[1]]) {
    const srv = servers[token[1]];
    return ok({ accessToken: 'demo-token', expiresAt: null, session: jmapSession(srv.base, srv.username) });
  }
  return null;
}
