// Helpers of the E2E suite: pages (splash screen, app errors, axe), reading
// and filling the mailbox of a Stalwart account via JMAP (with the app
// password, like the backend's system mails), Sieve scripts and vacation
// response in Stalwart, TOTP codes for the mandatory MFA when accepting an
// invitation, passwords that follow the policy.
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import axe from 'axe-core';
import { createHmac, randomBytes } from 'node:crypto';
import type { MailUser, Stalwart } from './fixtures.ts';

/** Signed-in session (cookies), in memory only: no tokens in test-results/. */
export type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Value from a previous test; if it is missing, the previous test failed. */
export function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing from the previous test`);
  return value;
}

/** Waits until the splash screen is gone and the page has settled. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('.splash')).toHaveCount(0);
  await expect(page.locator('.app, .bare').first()).toBeVisible();
}

/** Uncaught app errors; `takePageErrors()` in `afterEach` makes the test fail on them. */
const pageErrors: string[] = [];

/** New page in `context` whose uncaught errors are collected. */
export async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return page;
}

/** The app errors collected since the last call (and clears the list). */
export function takePageErrors(): string[] {
  return pageErrors.splice(0);
}

/** Closes all browser contexts (including those of a failed test) and returns the app errors. */
export async function closeAll(browser: Browser): Promise<string[]> {
  for (const context of browser.contexts()) await context.close();
  return takePageErrors();
}

/** CSRF protection header, like `#lib/api.ts`. */
export const CSRF = { 'x-requested-with': 'roedy-mail' };

/**
 * `GET /api/v1/<path>` with the page's session (shared cookie store of
 * `page.request`), for checks against the backend next to the UI.
 */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(new URL(`/api/v1/${path}`, page.url()).href, {
    headers: CSRF,
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`GET ${path}: ${res.status()}`);
  return (await res.json()) as T;
}

/** External sender (domain per RFC 6761, never resolves). */
export const erika = { name: 'Erika Sample', email: 'erika@sample.test' };

/** Message list row with the subject `subject`. */
export function row(page: Page, subject: string): Locator {
  return page.getByRole('main').getByRole('button', { name: subject });
}

/**
 * Opens the row `subject` as soon as it is there: emails stored via JMAP only
 * appear with the push, which can take longer than `actionTimeout`.
 */
export async function openRow(page: Page, subject: string): Promise<void> {
  await expect(row(page, subject)).toBeVisible({ timeout: 30_000 });
  await row(page, subject).click();
}

/** New context with the session `state`, page `url` opened and loaded. */
export async function openAs(browser: Browser, state: Session, url: string): Promise<Page> {
  const context = await browser.newContext({ storageState: state });
  const page = await newPage(context);
  await page.goto(url);
  await settled(page);
  return page;
}

export interface Mail {
  id: string;
  subject: string;
  from: string[];
  to: string[];
  text: string;
  messageId: string[];
  inReplyTo: string[];
  references: string[];
  mailboxIds: string[];
  keywords: string[];
}

interface JmapEmail {
  id: string;
  subject: string | null;
  from: { email: string }[] | null;
  to: { email: string }[] | null;
  textBody: { partId: string }[];
  bodyValues: Record<string, { value: string }>;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
}

/** Basic auth with the app password of `user`. */
function basic(user: MailUser): string {
  return `Basic ${Buffer.from(`${user.login}:${user.appPassword}`).toString('base64')}`;
}

/**
 * One JMAP request as `user` with Basic auth and app password (Core and Mail,
 * plus `using`); throws on errors and on abort via `signal` (default 15 s).
 */
export async function jmap(
  stalwart: Stalwart,
  user: MailUser,
  methodCalls: unknown[],
  { signal = AbortSignal.timeout(15_000), using = [] }: { signal?: AbortSignal | undefined; using?: string[] } = {},
): Promise<unknown[][]> {
  const res = await fetch(`${stalwart.url}/jmap/`, {
    method: 'POST',
    signal,
    headers: { authorization: basic(user), 'content-type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...using],
      methodCalls,
    }),
  });
  if (!res.ok) throw new Error(`JMAP responds ${res.status}`);
  const { methodResponses } = (await res.json()) as { methodResponses: unknown[][] };
  const failed = methodResponses.find((r) => r[0] === 'error');
  if (failed) throw new Error(`JMAP error: ${JSON.stringify(failed[1])}`);
  return methodResponses;
}

/** Response of the call with the id `id`. */
function result<T>(responses: unknown[][], id: string): T {
  const found = responses.find((r) => r[2] === id);
  if (!found) throw new Error(`JMAP response ${id} missing`);
  return found[1] as T;
}

/** Emails in the account `user` matching `filter` (newest first), with text part. */
export async function findMails(
  stalwart: Stalwart,
  user: MailUser,
  filter: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Mail[]> {
  const responses = await jmap(
    stalwart,
    user,
    [
      [
        'Email/query',
        { accountId: user.accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }] },
        'q',
      ],
      [
        'Email/get',
        {
          accountId: user.accountId,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: [
            'subject',
            'from',
            'to',
            'textBody',
            'bodyValues',
            'messageId',
            'inReplyTo',
            'references',
            'mailboxIds',
            'keywords',
          ],
          fetchTextBodyValues: true,
        },
        'g',
      ],
    ],
    { signal },
  );
  // `/get` need not keep the order of the ids (RFC 8620, 5.1): sort by the query.
  const order = new Map(result<{ ids: string[] }>(responses, 'q').ids.map((id, i) => [id, i]));
  const list = result<{ list: JmapEmail[] }>(responses, 'g').list;
  list.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  return list.map((m) => ({
    id: m.id,
    subject: m.subject ?? '',
    from: (m.from ?? []).map((a) => a.email),
    to: (m.to ?? []).map((a) => a.email),
    text: m.textBody.map((p) => m.bodyValues[p.partId]?.value ?? '').join('\n'),
    messageId: m.messageId ?? [],
    inReplyTo: m.inReplyTo ?? [],
    references: m.references ?? [],
    mailboxIds: Object.keys(m.mailboxIds),
    keywords: Object.keys(m.keywords),
  }));
}

/**
 * Waits until the account `user` holds at least `count` emails with the
 * subject `subject` and returns them with text part (newest first).
 */
export async function waitForMails(
  stalwart: Stalwart,
  user: MailUser,
  subject: string,
  count: number,
  timeout = 30_000,
): Promise<Mail[]> {
  const deadline = Date.now() + timeout;
  let mails: Mail[] = [];
  while (Date.now() < deadline) {
    // Every fetch ends at the deadline at the latest, even if Stalwart does not respond.
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      mails = await findMails(stalwart, user, { subject }, signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') break;
      throw err;
    }
    if (mails.length >= count) return mails;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`After ${timeout / 1000} s ${mails.length} instead of ${count} emails "${subject}"`);
}

export interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
}

/** All mailboxes (folders) in the account `user`. */
export async function mailboxes(stalwart: Stalwart, user: MailUser): Promise<Mailbox[]> {
  const responses = await jmap(stalwart, user, [
    ['Mailbox/get', { accountId: user.accountId, properties: ['name', 'role', 'parentId'] }, 'g'],
  ]);
  return result<{ list: Mailbox[] }>(responses, 'g').list;
}

/** Id of the mailbox with the role `role` (RFC 8621, 2) in the account `user`. */
export async function mailboxId(stalwart: Stalwart, user: MailUser, role: string): Promise<string> {
  const id = (await mailboxes(stalwart, user)).find((m) => m.role === role)?.id;
  if (!id) throw new Error(`No mailbox with the role ${role}`);
  return id;
}

/** Creates the top-level folder `name` in the account `user` and returns its id. */
export async function createMailbox(stalwart: Stalwart, user: MailUser, name: string): Promise<string> {
  const responses = await jmap(stalwart, user, [
    ['Mailbox/set', { accountId: user.accountId, create: { m: { name, parentId: null } } }, 's'],
  ]);
  const set = result<{ created?: { m?: { id: string } }; notCreated?: Record<string, unknown> }>(responses, 's');
  const id = set.created?.m?.id;
  if (!id) throw new Error(`Mailbox/set without result: ${JSON.stringify(set.notCreated)}`);
  return id;
}

/** Test data: a received email as an external sender would have sent it. */
export interface IncomingMail {
  from: { name: string; email: string };
  subject: string;
  /** HTML body (`text/html`); Stalwart derives the text part from it. */
  html?: string;
  text?: string;
  /** Id of the mailbox, default the inbox. */
  mailboxId?: string;
  messageId?: string;
}

/**
 * Stores `mail` unread in the account `user` via `Email/set` (without
 * delivery) and returns its id.
 */
export async function putMail(stalwart: Stalwart, user: MailUser, mail: IncomingMail): Promise<string> {
  const mailbox = mail.mailboxId ?? (await mailboxId(stalwart, user, 'inbox'));
  const body = mail.html
    ? { htmlBody: [{ partId: 'b', type: 'text/html' }], bodyValues: { b: { value: mail.html } } }
    : { textBody: [{ partId: 'b', type: 'text/plain' }], bodyValues: { b: { value: mail.text ?? '' } } };
  const responses = await jmap(stalwart, user, [
    [
      'Email/set',
      {
        accountId: user.accountId,
        create: {
          m: {
            mailboxIds: { [mailbox]: true },
            keywords: {},
            from: [mail.from],
            to: [{ name: user.name, email: user.email }],
            subject: mail.subject,
            receivedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            sentAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            ...(mail.messageId ? { messageId: [mail.messageId] } : {}),
            ...body,
          },
        },
      },
      's',
    ],
  ]);
  const set = result<{ created?: { m?: { id: string } }; notCreated?: Record<string, unknown> }>(responses, 's');
  const id = set.created?.m?.id;
  if (!id) throw new Error(`Email/set without result: ${JSON.stringify(set.notCreated)}`);
  return id;
}

const SUBMISSION = 'urn:ietf:params:jmap:submission';

/**
 * Sends a text mail from `from` to `to` via `EmailSubmission/set`, i.e. with
 * real delivery (the recipient's Sieve rules and vacation response apply,
 * unlike with `putMail()`). The sender's draft is destroyed afterwards.
 */
export async function sendMail(
  stalwart: Stalwart,
  from: MailUser,
  to: MailUser,
  subject: string,
  text: string,
): Promise<void> {
  const using = [SUBMISSION];
  const identities = result<{ list: { id: string; email: string }[] }>(
    await jmap(stalwart, from, [['Identity/get', { accountId: from.accountId }, 'i']], { using }),
    'i',
  ).list;
  let identityId = identities.find((i) => i.email === from.email)?.id;
  if (!identityId) {
    const created = result<{ created?: { i?: { id: string } } }>(
      await jmap(
        stalwart,
        from,
        [['Identity/set', { accountId: from.accountId, create: { i: { name: from.name, email: from.email } } }, 'i']],
        { using },
      ),
      'i',
    );
    identityId = created.created?.i?.id;
  }
  if (!identityId) throw new Error(`No identity for ${from.login}`);
  const responses = await jmap(
    stalwart,
    from,
    [
      [
        'Email/set',
        {
          accountId: from.accountId,
          create: {
            e: {
              mailboxIds: { [await mailboxId(stalwart, from, 'drafts')]: true },
              keywords: { $draft: true },
              from: [{ name: from.name, email: from.email }],
              to: [{ name: to.name, email: to.email }],
              subject,
              bodyValues: { t: { value: text } },
              textBody: [{ partId: 't', type: 'text/plain' }],
            },
          },
        },
        'e',
      ],
      [
        'EmailSubmission/set',
        {
          accountId: from.accountId,
          create: { s: { identityId, emailId: '#e' } },
          onSuccessDestroyEmail: ['#s'],
        },
        's',
      ],
    ],
    { using },
  );
  const sent = result<{ created?: { s?: unknown }; notCreated?: Record<string, unknown> }>(responses, 's');
  if (!sent.created?.s) throw new Error(`EmailSubmission/set without result: ${JSON.stringify(sent.notCreated)}`);
}

const SIEVE = 'urn:ietf:params:jmap:sieve';

export interface SieveScript {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

/** All Sieve scripts in the account `user` (RFC 9661). */
export async function sieveScripts(stalwart: Stalwart, user: MailUser): Promise<SieveScript[]> {
  const responses = await jmap(stalwart, user, [['SieveScript/get', { accountId: user.accountId }, 'g']], {
    using: [SIEVE],
  });
  return result<{ list: SieveScript[] }>(responses, 'g').list;
}

/** Content of the blob `blobId` as text (download endpoint from the session, RFC 8620 › 6.2). */
export async function blobText(stalwart: Stalwart, user: MailUser, blobId: string): Promise<string> {
  const headers = { authorization: basic(user) };
  const session = await fetch(`${stalwart.url}/jmap/session`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!session.ok) throw new Error(`JMAP session responds ${session.status}`);
  const { downloadUrl } = (await session.json()) as { downloadUrl: string };
  const url = downloadUrl
    .replace('{accountId}', encodeURIComponent(user.accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', 'script.sieve')
    .replace('{type}', encodeURIComponent('application/sieve'));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Download responds ${res.status}`);
  return res.text();
}

/** `SieveScript/validate` (RFC 9661 › 2.5) for the blob `blobId`: `null` or the server's error. */
export async function validateSieve(
  stalwart: Stalwart,
  user: MailUser,
  blobId: string,
): Promise<{ type: string; description?: string } | null> {
  const responses = await jmap(stalwart, user, [['SieveScript/validate', { accountId: user.accountId, blobId }, 'v']], {
    using: [SIEVE],
  });
  return result<{ error: { type: string; description?: string } | null }>(responses, 'v').error;
}

const VACATION = 'urn:ietf:params:jmap:vacationresponse';

export interface Vacation {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
}

/** The vacation response of the account `user` (RFC 8621 › 8). */
export async function vacation(stalwart: Stalwart, user: MailUser): Promise<Vacation> {
  const responses = await jmap(
    stalwart,
    user,
    [['VacationResponse/get', { accountId: user.accountId, ids: ['singleton'] }, 'g']],
    { using: [VACATION] },
  );
  const [found] = result<{ list: Vacation[] }>(responses, 'g').list;
  if (!found) throw new Error('No vacation response');
  return found;
}

/**
 * Resets the vacation response and Sieve scripts of `user` (off, none
 * active), so that rules and automatic replies of one flow do not affect the
 * delivery in the following files (shared Stalwart). Throws if anything is
 * still on afterwards.
 */
export async function resetDelivery(stalwart: Stalwart, user: MailUser): Promise<void> {
  const responses = await jmap(
    stalwart,
    user,
    [
      ['VacationResponse/set', { accountId: user.accountId, update: { singleton: { isEnabled: false } } }, 'v'],
      ['SieveScript/set', { accountId: user.accountId, onSuccessDeactivateScript: true }, 's'],
    ],
    { using: [VACATION, SIEVE] },
  );
  const refused = result<{ notUpdated?: Record<string, unknown> | null }>(responses, 'v').notUpdated;
  if (refused) throw new Error(`Vacation response not switched off: ${JSON.stringify(refused)}`);
  const active = (await sieveScripts(stalwart, user)).filter((s) => s.isActive).map((s) => s.name);
  if ((await vacation(stalwart, user)).isEnabled || active.length > 0) {
    throw new Error(`Delivery not reset (active scripts: ${active.join(', ') || 'none'})`);
  }
}

/** WCAG 2.2 AA levels and `best-practice` as in the audit run (`scripts/a11y/audit.mjs`). */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/**
 * axe-core findings on the page, per node with rule, target and HTML; empty
 * if everything passes. Like the audit run, only after running animations
 * have ended (a fade-in would otherwise count as too little contrast);
 * endless ones like spinners do not count. axe gets into the page via
 * `evaluate`, not as `<script>` (the app's CSP would not allow it).
 */
export async function axeViolations(page: Page): Promise<string[]> {
  try {
    await page.waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      null,
      { timeout: 5000, polling: 100 },
    );
  } catch {
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) =>
          a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : a.id,
        ),
    );
    throw new Error(`axe: animations still running after 5 s: ${running.join(', ')}`);
  }
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axe.source);
  return page.evaluate(async (tags) => {
    const run = (window as unknown as { axe: typeof axe }).axe.run;
    // Without iframes: they only hold the content of external mails (sandboxed, no scripts).
    const r = await run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations'],
      iframes: false,
    });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id} ${n.target.join(' ')}: ${n.html.slice(0, 160)} – ${n.failureSummary ?? ''}`),
    );
  }, AXE_TAGS);
}

/** Waits until `check` returns true (polling every 500 ms), otherwise fails with `what`. */
export async function eventually(check: () => Promise<boolean>, what: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Not reached after ${timeout / 1000} s: ${what}`);
}

/** Random word for unique subjects and search terms per run (letters only). */
export function word(prefix: string): string {
  const letters = randomBytes(6)
    .toString('hex')
    .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] ?? 'x');
  return `${prefix}${letters}`;
}

/** Base32 (RFC 4648) without padding; spaces and lowercase letters allowed. */
function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/[\s=]/g, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Key is not Base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}

/** TOTP per RFC 6238 (SHA-1, 6 digits, 30 s) like the authenticator apps. */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/** Random password following the policy (≥ 10 characters, upper, lower, non-letter). */
export function password(): string {
  return `Rm-${randomBytes(12).toString('base64url')}-aZ7`;
}
