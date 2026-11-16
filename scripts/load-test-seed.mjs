// Fills the local Stalwart v1 for the load test: in the
// user's account 50,000 emails as conversations across several folders
// (inbox, archive, newsletter, projects with subfolders, sent), with
// attachments, read/unread/flagged and words for the search; plus contact
// cards and, on request, further accounts with "Sent" and contact cards for
// the recipient suggestions with many accounts.
// Only runs inside scripts/dev/stalwart.sh run (server at
// $STALWART_URL, credentials in $STALWART_CREDENTIALS, header of
// scripts/dev/stalwart.mjs). Tests: load-test-seed.test.mjs.
//
// The generated mail content (names, subjects, words, folder names) is fixed:
// the search terms below depend on it.
//
//   node scripts/load-test-seed.mjs [--mails 50000] [--batch 500]
//        [--parallel 4] [--accounts 0] [--cards 500] [--credentials-out <file>]
//
// Generated with a fixed seed (the same data in every run), created in batches
// with `Email/set` (at most `maxObjectsInSet` per call).
// Output: summary as JSON on stdout (count per folder, duration, search words,
// accounts only with address). `--credentials-out` writes the credentials of
// the further accounts (fields like `user` in $STALWART_CREDENTIALS) with mode
// 600 for the browser run; they appear in no output.

import { argv, env, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { basicAuth, randomSecret, readCredentials, redact, secretsOf, writePrivate } from './dev/stalwart.mjs';

const JMAP = 'urn:ietf:params:jmap:';
const CORE = `${JMAP}core`;
const MAIL = `${JMAP}mail`;
const CONTACTS = `${JMAP}contacts`;
const STALWART = 'urn:stalwart:jmap';
const DAY = 86_400_000;

/** The user's folders: name, parent folder, role (existing mailbox) and share of the conversations. */
export const FOLDERS = [
  { key: 'inbox', role: 'inbox', share: 0.52 },
  { key: 'archive', name: 'Archive', share: 0.2 },
  { key: 'newsletter', name: 'Newsletter', share: 0.12 },
  { key: 'projects', name: 'Projects', share: 0.04 },
  { key: 'alpha', name: 'Alpha', parent: 'projects', share: 0.06 },
  { key: 'beta', name: 'Beta', parent: 'projects', share: 0.06 },
];

/** Words for the search: rare in few conversations, common in many subjects. */
export const SEARCH = {
  rare: 'Brimstone',
  rareThreads: 25,
  common: 'Quarterly',
  commonShare: 0.02,
  /** Appears in the body of the last created email: once the search finds it, the index is ready. */
  last: 'Keystone',
  /** Appears only in the body of the first email of each conversation with the rare word. */
  body: 'sighted',
};

const FIRST =
  'Anna Ben Clara David Emma Felix Greta Hannes Ida Jonas Karla Lukas Mia Noah Olga Paul Rosa Simon Tara Uwe Vera Willi Yara Zoe Anton Berta Carl Dora Emil Frida Gustav Hilde Ivo Jule Kurt Lene Moritz Nele Oskar Pia'.split(
    ' ',
  );
const LAST =
  'Albrecht Brandt Claasen Dietrich Ebert Fuchs Graf Hahn Imhof Jansen Keller Lange Maier Neumann Otto Peters Quast Roth Schulz Thiel Ullrich Vogel Weber Xander Young Zimmer Arndt Bauer Conrad Dahl'.split(
    ' ',
  );
const DOMAINS = ['example.test', 'company.test', 'club.test', 'agency.test', 'practice.test'];
const TOPICS =
  'Offer Appointment Invoice Minutes Planning Draft Query Approval Budget Workshop Relocation Maintenance Contract Presentation Application Delivery Fair Expenses Training Feedback'.split(
    ' ',
  );
const WORDS =
  'and the a that we they please thanks gladly today tomorrow next week project customer team time plan list file attachment status goal question answer meeting report figures result version review alignment costs offer proposal change note feedback'.split(
    ' ',
  );
const MONTHS = 'January February March April May June July August September October November December'.split(' ');

/** Attachments, uploaded once and used in many emails (Stalwart stores blobs by content). */
export const ATTACHMENTS = [
  { name: 'Offer.pdf', type: 'application/pdf', size: 40_000 },
  { name: 'Photo.png', type: 'image/png', size: 90_000 },
  { name: 'Notes.txt', type: 'text/plain', size: 3_000 },
  {
    name: 'Presentation.pptx',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 250_000,
  },
];

/** Random numbers with a fixed seed (mulberry32). */
export function rng(seed = 417) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

/** Size of a conversation: mostly one email, a third two to four, every tenth up to twelve. */
function threadSize(r) {
  const x = r.next();
  if (x < 0.6) return 1;
  if (x < 0.9) return r.int(2, 4);
  return r.int(5, 12);
}

function weighted(r, items) {
  let x = r.next() * items.reduce((sum, item) => sum + item.share, 0);
  for (const item of items) {
    x -= item.share;
    if (x < 0) return item;
  }
  return items[items.length - 1];
}

/** Senders weighted by Zipf: few write often, many rarely. */
export function senders(count = 2000, seed = 1) {
  const r = rng(seed);
  const list = [];
  for (let i = 0; i < count; i++) {
    const first = r.pick(FIRST);
    const last = r.pick(LAST);
    const email = `${first}.${last}${i}@${r.pick(DOMAINS)}`.toLowerCase();
    list.push({ name: `${first} ${last}`, email });
  }
  return list;
}

function zipf(r, list) {
  return list[Math.min(list.length - 1, Math.floor(list.length * r.next() ** 3))];
}

function text(r, min, max) {
  const n = r.int(min, max);
  const words = [];
  for (let i = 0; i < n; i++) words.push(r.pick(WORDS));
  const out = [];
  for (let i = 0; i < words.length; i += 12) out.push(words.slice(i, i + 12).join(' ') + '.');
  return out.join(' ');
}

function utc(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Plan of the user's emails: `count` emails in conversations, the newest
 * within `years` years before `now`. Folders are keys from [`FOLDERS`] or
 * `sent`; the user's replies are in "Sent", so the conversation spans two
 * folders. Attachments as an index into [`ATTACHMENTS`].
 */
export function planMails({ count = 50_000, now = Date.UTC(2026, 10, 1), years = 3, user, seed = 417 } = {}) {
  const r = rng(seed);
  const people = senders();
  const news = [
    { name: 'Market Shop', email: 'news@shop.test' },
    { name: 'Club Newsletter', email: 'post@club.test' },
    { name: 'Weather Service', email: 'info@weather.test' },
  ];
  const me = user ?? { name: 'User', email: 'user@example.test' };
  const mails = [];
  let thread = 0;
  let rare = 0;
  while (mails.length < count) {
    const folder = weighted(r, FOLDERS);
    const isNews = folder.key === 'newsletter';
    const size = isNews ? 1 : Math.min(threadSize(r), count - mails.length);
    const partner = isNews ? r.pick(news) : zipf(r, people);
    const marker =
      rare < SEARCH.rareThreads && thread % 97 === 13
        ? SEARCH.rare
        : r.next() < SEARCH.commonShare
          ? SEARCH.common
          : null;
    if (marker === SEARCH.rare) rare++;
    const topic = isNews ? `News ${r.pick(MONTHS)}` : `${r.pick(TOPICS)} ${r.pick(TOPICS)}`;
    const subject = marker ? `${topic} – ${marker} ${thread}` : `${topic} ${thread}`;
    let at = now - Math.floor(r.next() ** 1.5 * years * 365 * DAY);
    const ids = [];
    for (let i = 0; i < size; i++) {
      const mine = i > 0 && r.next() < 0.3;
      const messageId = `lt-${thread}-${i}@load-test.test`;
      const age = now - at;
      const seen = mine || r.next() < (age > 30 * DAY ? 0.97 : 0.6);
      const keywords = { ...(seen ? { $seen: true } : {}), ...(r.next() < 0.03 ? { $flagged: true } : {}) };
      const attach = !isNews && r.next() < 0.06 ? [r.int(0, ATTACHMENTS.length - 1)] : [];
      if (attach.length && r.next() < 0.3) attach.push((attach[0] + 1) % ATTACHMENTS.length);
      mails.push({
        folder: mine ? 'sent' : folder.key,
        thread,
        from: mine ? me : partner,
        to: mine ? partner : me,
        subject: i === 0 ? subject : `Re: ${subject}`,
        receivedAt: utc(at),
        messageId,
        inReplyTo: ids.at(-1) ?? null,
        references: [...ids],
        keywords,
        html: isNews,
        body: `${marker === SEARCH.rare && i === 0 ? `${SEARCH.rare} ${SEARCH.body}. ` : ''}${text(r, isNews ? 120 : 30, isNews ? 400 : 250)}`,
        attachments: attach,
      });
      ids.push(messageId);
      at = Math.min(now, at + r.int(1, 48) * 3_600_000);
    }
    thread++;
  }
  const last = mails.at(-1);
  if (last) last.body = `${SEARCH.last} ${last.body}`;
  return mails;
}

/** Number of emails of a plan per folder. */
export function countByFolder(mails) {
  const counts = {};
  for (const m of mails) counts[m.folder] = (counts[m.folder] ?? 0) + 1;
  return counts;
}

/** Create object for `Email/set` from an entry of the plan. */
export function toEmail(mail, mailboxes, blobs) {
  const body = mail.html
    ? {
        htmlBody: [{ partId: 'b', type: 'text/html' }],
        bodyValues: { b: { value: `<html><body><p>${mail.body.replaceAll('. ', '.</p><p>')}</p></body></html>` } },
      }
    : { textBody: [{ partId: 'b', type: 'text/plain' }], bodyValues: { b: { value: mail.body } } };
  return {
    mailboxIds: { [mailboxes[mail.folder]]: true },
    keywords: mail.keywords,
    from: [mail.from],
    to: [mail.to],
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    sentAt: mail.receivedAt,
    messageId: [mail.messageId],
    ...(mail.inReplyTo ? { inReplyTo: [mail.inReplyTo], references: mail.references } : {}),
    ...body,
    ...(mail.attachments.length
      ? {
          attachments: mail.attachments.map((i) => ({
            blobId: blobs[i],
            type: ATTACHMENTS[i].type,
            name: ATTACHMENTS[i].name,
            disposition: 'attachment',
          })),
        }
      : {}),
  };
}

/** Contact cards (`ContactCard/set`) for an address book; `prefix` makes names unique per account. */
export function planCards(count, prefix, seed = 7) {
  const r = rng(seed);
  const cards = [];
  for (let i = 0; i < count; i++) {
    const given = r.pick(FIRST);
    const surname = `${r.pick(LAST)}-${prefix}${i}`;
    cards.push({
      given,
      surname,
      email: `${given}.${surname}@contacts.test`.toLowerCase(),
    });
  }
  return cards;
}

/** Content of an attachment of size `size` (pseudo data, no valid format). */
function blobBytes(size, seed) {
  const r = rng(seed);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(r.next() * 256);
  return buf;
}

// --- JMAP against the local Stalwart ----------------------------------------

class Client {
  constructor(base, login, secret) {
    this.base = base;
    this.auth = basicAuth(login, secret);
  }

  async session() {
    const res = await fetch(`${this.base}/jmap/session`, { headers: { authorization: this.auth } });
    if (!res.ok) throw new Error(`session responds ${res.status}`);
    this.sess = await res.json();
    this.accountId = this.sess.primaryAccounts[MAIL];
    this.maxSet = this.sess.capabilities[CORE].maxObjectsInSet ?? 500;
    return this.sess;
  }

  async call(methodCalls, using = [CORE, MAIL]) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.base}/jmap/`, {
        method: 'POST',
        signal: AbortSignal.timeout(300_000),
        headers: { authorization: this.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ using, methodCalls }),
      });
      // Stalwart limits concurrent requests per account: wait briefly and retry.
      if ((res.status === 429 || res.status === 503) && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`JMAP responds ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { methodResponses } = await res.json();
      const failed = methodResponses.find((m) => m[0] === 'error');
      if (failed) throw new Error(`JMAP error ${failed[2]}: ${JSON.stringify(failed[1]).slice(0, 300)}`);
      return methodResponses;
    }
  }

  async upload(bytes, type) {
    const url = this.sess.uploadUrl.replace('{accountId}', this.accountId);
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: this.auth, 'content-type': type },
      body: bytes,
    });
    if (!res.ok) throw new Error(`upload responds ${res.status}`);
    return (await res.json()).blobId;
  }
}

function created(responses, id) {
  const res = responses.find((m) => m[2] === id)[1];
  const failed = Object.values(res.notCreated ?? {});
  if (failed.length) throw new Error(`${failed.length} not created: ${JSON.stringify(failed[0]).slice(0, 300)}`);
  return res.created ?? {};
}

/** Creates or finds the folders from [`FOLDERS`]; returns key → id (with `sent`). */
async function ensureFolders(client) {
  const [[, got]] = await client.call([
    ['Mailbox/get', { accountId: client.accountId, properties: ['name', 'role', 'parentId'] }, 'g'],
  ]);
  const ids = {};
  for (const box of got.list) if (box.role) ids[box.role] = box.id;
  if (!ids.inbox || !ids.sent) throw new Error('inbox or sent missing');
  for (const f of FOLDERS.filter((f) => f.name)) {
    const parentId = f.parent ? ids[f.parent] : null;
    const found = got.list.find((b) => b.name === f.name && (b.parentId ?? null) === parentId);
    if (found) {
      ids[f.key] = found.id;
      continue;
    }
    const res = await client.call([
      ['Mailbox/set', { accountId: client.accountId, create: { m: { name: f.name, parentId } } }, 's'],
    ]);
    ids[f.key] = created(res, 's').m.id;
  }
  for (const f of FOLDERS) if (f.role) ids[f.key] = ids[f.role];
  return ids;
}

/** Creates `mails` in batches (`parallel` calls at once) and reports the progress on stderr. */
async function createMails(client, mails, mailboxes, blobs, { batch, parallel, label }) {
  const size = Math.min(batch, client.maxSet);
  const batches = [];
  for (let i = 0; i < mails.length; i += size) batches.push(mails.slice(i, i + size));
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const create = Object.fromEntries(batch.map((m, i) => [`m${i}`, toEmail(m, mailboxes, blobs)]));
      const res = await client.call([['Email/set', { accountId: client.accountId, create }, 's']]);
      created(res, 's');
      done += batch.length;
      if (done % 5000 < size)
        stderr.write(`${label}: ${done}/${mails.length} (${Math.round((Date.now() - started) / 1000)} s)\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  return Date.now() - started;
}

/**
 * Stalwart indexes for the search in the background: waits until `Email/query`
 * finds the marker of the last email and all emails with the rare search word;
 * returns the waiting time in ms.
 */
async function waitForIndex(client, rareMails) {
  const started = Date.now();
  const total = async (text) => {
    const [[, res]] = await client.call([
      ['Email/query', { accountId: client.accountId, filter: { text }, calculateTotal: true, limit: 1 }, 'q'],
    ]);
    return res.total;
  };
  while (Date.now() - started < 30 * 60_000) {
    if ((await total(SEARCH.last)) >= 1 && (await total(SEARCH.rare)) >= rareMails) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('search index not ready after 30 min');
}

async function createCards(client, cards) {
  if (!client.sess.capabilities[CONTACTS] || cards.length === 0) return 0;
  const using = [CORE, CONTACTS];
  const [[, books]] = await client.call(
    [['AddressBook/get', { accountId: client.accountId, properties: ['isDefault'] }, 'a']],
    using,
  );
  const book = books.list.find((b) => b.isDefault) ?? books.list[0];
  if (!book) throw new Error('no address book');
  for (let i = 0; i < cards.length; i += client.maxSet) {
    const create = Object.fromEntries(
      cards.slice(i, i + client.maxSet).map((c, j) => [
        `c${j}`,
        {
          addressBookIds: { [book.id]: true },
          name: {
            components: [
              { kind: 'given', value: c.given },
              { kind: 'surname', value: c.surname },
            ],
          },
          emails: { e: { address: c.email } },
        },
      ]),
    );
    created(await client.call([['ContactCard/set', { accountId: client.accountId, create }, 's']], using), 's');
  }
  return cards.length;
}

/** Further account `accountNN@<domain>` with an app password (created by the admin). */
/** Secrets of the further accounts, for the error message (`redact`). */
const createdSecrets = [];

/** Id of the credentials' domain (`x:Domain/get` as admin). */
async function domainId(cred, admin) {
  const [[, domains]] = await admin.call([['x:Domain/get', {}, 'd']], [CORE, STALWART]);
  const domain = domains.list.find((d) => d.name === cred.domain);
  if (!domain) throw new Error(`domain ${cred.domain} missing`);
  return domain.id;
}

async function createAccount(cred, admin, domain, n) {
  const name = `account${String(n).padStart(2, '0')}`;
  const password = randomSecret();
  createdSecrets.push(password);
  const using = [CORE, STALWART];
  const res = await admin.call(
    [
      [
        'x:Account/set',
        {
          create: {
            u: {
              '@type': 'User',
              name,
              domainId: domain,
              description: 'Roedy Mail load test',
              credentials: { 0: { '@type': 'Password', secret: password } },
              roles: { '@type': 'User' },
            },
          },
        },
        'u',
      ],
    ],
    using,
  );
  created(res, 'u');
  const login = `${name}@${cred.domain}`;
  const own = new Client(cred.url, login, password);
  const [[, app]] = await own.call(
    [['x:AppPassword/set', { create: { p: { description: 'load test', permissions: { '@type': 'Inherit' } } } }, 'p']],
    using,
  );
  const appPassword = app.created?.p?.secret;
  if (!appPassword) throw new Error(`no app password for ${login}`);
  createdSecrets.push(appPassword);
  return { name, login, email: login, password, appPassword };
}

function option(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

/** Integer option from `min`, otherwise an error with its name. */
function count(args, name, fallback, min) {
  const raw = option(args, name, fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} needs an integer from ${min} (${raw})`);
  return n;
}

export async function main(args = argv.slice(2)) {
  const file = env.STALWART_CREDENTIALS;
  if (!file || !env.STALWART_URL) throw new Error('only in scripts/dev/stalwart.sh run (STALWART_CREDENTIALS missing)');
  const cred = readCredentials(file);
  const opts = {
    mails: count(args, 'mails', 50_000, 1),
    batch: count(args, 'batch', 500, 1),
    parallel: count(args, 'parallel', 4, 1),
    accounts: count(args, 'accounts', 0, 0),
    cards: count(args, 'cards', 500, 0),
    credentialsOut: option(args, 'credentials-out', null),
  };
  const started = Date.now();
  const user = new Client(cred.url, cred.user.login, cred.user.appPassword);
  await user.session();
  const mailboxes = await ensureFolders(user);
  const blobs = [];
  for (const [i, a] of ATTACHMENTS.entries()) blobs.push(await user.upload(blobBytes(a.size, i + 1), a.type));

  const mails = planMails({ count: opts.mails, user: { name: 'Example User', email: cred.user.email } });
  const mailMs = await createMails(user, mails, mailboxes, blobs, { ...opts, label: cred.user.email });
  const rareMails = mails.filter((m) => m.subject.includes(SEARCH.rare)).length;
  const indexMs = await waitForIndex(user, rareMails);
  const cards = await createCards(user, planCards(opts.cards, 'n'));

  const accounts = [];
  if (opts.accounts > 0) {
    const admin = new Client(cred.url, cred.admin.login, cred.admin.appPassword);
    const domain = await domainId(cred, admin);
    for (let n = 1; n <= opts.accounts; n++) {
      const account = await createAccount(cred, admin, domain, n);
      const client = new Client(cred.url, account.login, account.appPassword);
      await client.session();
      account.accountId = client.accountId;
      const boxes = await ensureFolders(client);
      // 200 sent emails per account, to 150 recipients, partly the same as in other accounts.
      const people = senders(150, 100 + (n % 3));
      const r = rng(1000 + n);
      const sent = Array.from({ length: 200 }, (_, i) => ({
        folder: 'sent',
        from: { name: account.name, email: account.email },
        to: zipf(r, people),
        subject: `Message ${i} from ${account.name}`,
        receivedAt: utc(Date.UTC(2026, 10, 1) - i * 3_600_000),
        messageId: `lt-${account.name}-${i}@load-test.test`,
        inReplyTo: null,
        references: [],
        keywords: { $seen: true },
        html: false,
        body: text(r, 20, 60),
        attachments: [],
      }));
      await createMails(client, sent, boxes, [], { ...opts, label: account.email });
      await createCards(client, planCards(opts.cards, `k${n}-`, 7 + n));
      accounts.push(account);
    }
    if (opts.credentialsOut) writePrivate(opts.credentialsOut, JSON.stringify(accounts, null, 2));
  }

  const summary = {
    mails: mails.length,
    threads: new Set(mails.map((m) => m.thread)).size,
    perFolder: countByFolder(mails),
    withAttachments: mails.filter((m) => m.attachments.length > 0).length,
    unread: mails.filter((m) => !m.keywords.$seen).length,
    contactCards: cards,
    // `search.*.word` is read by apps/web/e2e/load-test.load.ts.
    search: {
      rare: {
        word: SEARCH.rare,
        mails: rareMails,
        threads: new Set(mails.filter((m) => m.subject.includes(SEARCH.rare)).map((m) => m.thread)).size,
      },
      common: {
        word: SEARCH.common,
        threads: new Set(mails.filter((m) => m.subject.includes(SEARCH.common)).map((m) => m.thread)).size,
      },
      body: { word: SEARCH.body },
    },
    extraAccounts: accounts.map((a) => a.email),
    mailsMs: mailMs,
    mailsPerSecond: Math.round((mails.length / mailMs) * 1000),
    indexMs,
    totalMs: Date.now() - started,
  };
  stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((err) => {
    let secrets = [...createdSecrets];
    try {
      secrets = [...secrets, ...secretsOf(readCredentials(env.STALWART_CREDENTIALS))];
    } catch {
      // Without credentials there is nothing to redact.
    }
    stderr.write(`load-test-seed: ${redact(String(err?.message ?? err), secrets)}\n`);
    exit(1);
  });
}
