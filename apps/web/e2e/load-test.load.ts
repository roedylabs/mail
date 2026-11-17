// Load test of the web app with 50,000 emails: seeds the
// Stalwart of the run (scripts/load-test-seed.mjs), connects the account and
// measures in the browser the first paint (without and with cache), scrolling,
// search, sync after changes (page open and after closing), IndexedDB storage
// and recipient suggestions with many accounts, plus the binary's memory
// (RSS) after every step and, with LOAD_TEST_LIGHTHOUSE, one Lighthouse run
// for the mailbox. Every step keeps its values in `results`;
// `afterAll` writes them to test-results/load-test/measurements.json. Start
// only via scripts/load-test.sh (`LOAD_TEST_MAILS` and `LOAD_TEST_ACCOUNTS`
// shrink the run).
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { expect, test, type MailUser, type Stalwart } from './fixtures.ts';
import {
  closeAll,
  erika,
  jmap,
  mailboxId,
  need,
  newPage,
  password,
  putMail,
  settled,
  type Session,
} from './helpers.ts';
import { connectAccount, readyWithAccount } from './setup.ts';

test.describe.configure({ mode: 'serial' });

const MAILS = Number(process.env.LOAD_TEST_MAILS || 50_000);
// 4 more by default, to keep the run short. Over HTTP/1.1 (locally without
// TLS) only 3 accounts per server keep a push stream open, the others poll,
// so more accounts do not use up the browser's 6 connections per host.
const ACCOUNTS = Number(process.env.LOAD_TEST_ACCOUNTS ?? 4);
const RUNS = 3;
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const results: Record<string, unknown> = {};
// Memory of the binary after every step in MB (10^6 bytes as in release.yml):
// current (VmRSS) and peak since the start (VmHWM). The instance starts in
// the hook after "seed", so the first value is the idle state before the setup.
const rss: { after: string; mb: number; peakMb: number }[] = [];
results.rssBackend = rss;
let session: Session | undefined;
let context: BrowserContext | undefined;
let extra: MailUser[] = [];
let inbox = '';

test.afterAll(async ({ browser }, info) => {
  // App errors belong in the measurements and make the run fail.
  results.pageErrors = await closeAll(browser);
  const file = join(info.project.outputDir, 'load-test', 'measurements.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Measurements: ${file}\n${JSON.stringify(results, null, 2)}`);
  expect(results.pageErrors, 'app errors').toEqual([]);
});

test.afterEach(async ({ instance }, info) => {
  const { rssKib, peakKib } = await instance.memory();
  const mb = (kib: number) => Math.round((kib * 1024) / 100_000) / 10;
  rss.push({ after: info.title, mb: mb(rssKib), peakMb: mb(peakKib) });
});

const admin = { name: 'Load Admin', email: 'load@example.test', password: password() };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return Math.round(performance.now() - started);
}

/** Row of a subject without "Re: "; the number at the end does not match longer numbers. */
function threadRow(page: Page, subject: string) {
  const base = subject.replace(/^(Re: )+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('main').getByRole('button', { name: new RegExp(`${base}(?!\\d)`) });
}

interface Top {
  subject: string;
  threadId: string;
}

/** The newest `n` threads in the inbox according to the server. */
async function topThreads(stalwart: Stalwart, n: number, position = 0): Promise<Top[]> {
  const user = stalwart.user;
  const res = await jmap(stalwart, user, [
    [
      'Email/query',
      {
        accountId: user.accountId,
        filter: { inMailbox: inbox },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: true,
        position,
        limit: n,
      },
      'q',
    ],
    [
      'Email/get',
      {
        accountId: user.accountId,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'threadId'],
      },
      'g',
    ],
  ]);
  return (res.find((r) => r[2] === 'g')?.[1] as { list: Top[] }).list;
}

/** Deletes all emails of the threads `threads` on the server. */
async function destroyThreads(stalwart: Stalwart, threads: Top[]): Promise<void> {
  const user = stalwart.user;
  const res = await jmap(stalwart, user, [
    ['Thread/get', { accountId: user.accountId, ids: threads.map((t) => t.threadId) }, 't'],
  ]);
  const ids = (res[0]?.[1] as { list: { emailIds: string[] }[] }).list.flatMap((t) => t.emailIds);
  await jmap(stalwart, user, [['Email/set', { accountId: user.accountId, destroy: ids }, 's']]);
}

/** Marks `count` unread emails in the inbox as read (oldest first, outside the first page). */
async function markRead(stalwart: Stalwart, count: number): Promise<number> {
  const user = stalwart.user;
  const res = await jmap(stalwart, user, [
    [
      'Email/query',
      {
        accountId: user.accountId,
        filter: { inMailbox: inbox, notKeyword: '$seen' },
        sort: [{ property: 'receivedAt', isAscending: true }],
        limit: count,
      },
      'q',
    ],
  ]);
  const ids = (res[0]?.[1] as { ids: string[] }).ids;
  for (let i = 0; i < ids.length; i += 500) {
    const update = Object.fromEntries(ids.slice(i, i + 500).map((id) => [id, { 'keywords/$seen': true }]));
    await jmap(stalwart, user, [['Email/set', { accountId: user.accountId, update }, 's']]);
  }
  return ids.length;
}

/** JMAP request for a further page: `Email/query` with `anchor` or `position` > 0 (`threads.page()`). */
function isNextPage(body: string): boolean {
  try {
    const { methodCalls } = JSON.parse(body) as { methodCalls: [string, { anchor?: string; position?: number }][] };
    const query = methodCalls.find((c) => c[0] === 'Email/query')?.[1];
    return !!query && (!!query.anchor || (query.position ?? 0) > 0);
  } catch {
    return false;
  }
}

/** Number of ids in the response to `Email/query`. */
function queryIds(text: string): number {
  try {
    const { methodResponses } = JSON.parse(text) as { methodResponses: [string, { ids?: string[] }][] };
    return methodResponses.find((r) => r[0] === 'Email/query')?.[1].ids?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Counts JMAP requests and their response size on `page` until `stop()` is called. */
function countJmap(page: Page): () => Promise<{ requests: number; kb: number }> {
  const sizes: Promise<number>[] = [];
  const listener = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.startsWith('/jmap')) {
      sizes.push(
        request.sizes().then(
          (s) => s.responseBodySize,
          () => 0,
        ),
      );
    }
  };
  page.on('requestfinished', listener);
  return async () => {
    page.off('requestfinished', listener);
    const all = await Promise.all(sizes);
    return { requests: all.length, kb: Math.round(all.reduce((a, b) => a + b, 0) / 1024) };
  };
}

/** Long tasks of the main thread (PerformanceObserver), collected from page load on. */
async function watchLongTasks(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
}

async function takeLongTasks(page: Page): Promise<{ count: number; maxMs: number; sumMs: number }> {
  const tasks = await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    return w.__longTasks.splice(0);
  });
  return {
    count: tasks.length,
    maxMs: Math.round(Math.max(0, ...tasks)),
    sumMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
  };
}

async function openInbox(page: Page, top: Top): Promise<number> {
  return timed(async () => {
    await page.goto('/start');
    await expect(threadRow(page, top.subject)).toBeVisible({ timeout: 60_000 });
  });
}

test('seed', async ({ stalwart }) => {
  const dir = await mkdtemp(join(tmpdir(), 'roedy-load-'));
  try {
    const credentials = join(dir, 'accounts.json');
    const args = ['scripts/load-test-seed.mjs', '--mails', String(MAILS), '--accounts', String(ACCOUNTS)];
    if (ACCOUNTS > 0) args.push('--credentials-out', credentials);
    const { stdout } = await promisify(execFile)('node', args, { cwd: REPO, maxBuffer: 1 << 20 });
    results.seed = JSON.parse(stdout) as unknown;
    if (ACCOUNTS > 0) extra = JSON.parse(await readFile(credentials, 'utf8')) as MailUser[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  inbox = await mailboxId(stalwart, stalwart.user, 'inbox');
  results.environment = {
    cpus: cpus().length,
    mails: MAILS,
    accounts: 1 + extra.length,
    date: new Date().toISOString(),
  };
});

test('first paint without and with cache', async ({ browser, instance, stalwart }) => {
  const ctx = await browser.newContext({ baseURL: instance.url });
  await readyWithAccount(ctx, instance, stalwart, admin, stalwart.user);
  session = await ctx.storageState();
  await ctx.close();
  const [top] = await topThreads(stalwart, 1);
  const first = need(top, 'newest thread');

  const cold: number[] = [];
  let jmapCold = { requests: 0, kb: 0 };
  for (let i = 0; i < RUNS; i++) {
    const fresh = await browser.newContext({ baseURL: instance.url, storageState: session });
    const p = await newPage(fresh);
    const stop = countJmap(p);
    cold.push(await openInbox(p, first));
    jmapCold = await stop();
    await fresh.close();
  }

  context = await browser.newContext({ baseURL: instance.url, storageState: need(session, 'session') });
  await watchLongTasks(context);
  const warmPage = await newPage(context);
  await openInbox(warmPage, first);
  // The cache writes in batches; wait briefly before reloading.
  await warmPage.waitForTimeout(2_000);
  const warm: number[] = [];
  let jmapWarm = { requests: 0, kb: 0 };
  for (let i = 0; i < RUNS; i++) {
    const stop = countJmap(warmPage);
    warm.push(await openInbox(warmPage, first));
    await warmPage.waitForTimeout(2_000);
    jmapWarm = await stop();
  }
  results.firstPaint = {
    coldMs: cold,
    coldMedian: median(cold),
    jmapCold,
    warmMs: warm,
    warmMedian: median(warm),
    jmapWarm,
  };
});

test('scrolling', async () => {
  const page = need(context, 'context').pages()[0];
  if (!page) throw new Error('page missing');
  await takeLongTasks(page);
  const scroller = page.locator('.pf .scroll');
  const pages: number[] = [];
  const taskMax: number[] = [];
  // The first page came with the first paint (PAGE_SIZE).
  let loaded = 50;
  // 100 pages of 50 threads (PAGE_SIZE), as far as it goes. A page only
  // counts with the response to its `Email/query` and the new
  // height; the height alone also changes when new rows are measured.
  for (let i = 0; i < 100; i++) {
    const height = await scroller.evaluate((el) => el.scrollHeight);
    let ids = 0;
    const ms = await timed(async () => {
      const response = page.waitForResponse(
        (r) => new URL(r.url()).pathname.startsWith('/jmap') && isNextPage(r.request().postData() ?? ''),
        { timeout: 30_000 },
      );
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      ids = queryIds(await (await response).text());
      await expect.poll(() => scroller.evaluate((el) => el.scrollHeight), { timeout: 30_000 }).toBeGreaterThan(height);
    }).catch(() => -1);
    if (ms < 0) break;
    pages.push(ms);
    loaded += ids;
    taskMax.push((await takeLongTasks(page)).maxMs);
  }
  const dom = await page.locator('.pf .scroll .band').count();
  const heap = await page.evaluate(() => {
    const p = performance as unknown as { memory?: { usedJSHeapSize: number } };
    return p.memory ? Math.round(p.memory.usedJSHeapSize / 1048576) : null;
  });
  results.scrolling = {
    pages: pages.length,
    // Loaded according to the responses to `Email/query`.
    threads: loaded,
    msPerPageMedian: median(pages),
    msPerPageMax: Math.max(0, ...pages),
    msLastTenMedian: median(pages.slice(-10)),
    totalMs: pages.reduce((a, b) => a + b, 0),
    // Longest task per page: does it grow with the length of the list?
    longestTaskFirstTenMs: Math.max(0, ...taskMax.slice(0, 10)),
    longestTaskLastTenMs: Math.max(0, ...taskMax.slice(-10)),
    pagesWithLongTask: taskMax.filter((t) => t > 0).length,
    rowsInDom: dom,
    heapMb: heap,
  };
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
});

test('search', async ({ instance }) => {
  const page = need(context, 'context').pages()[0];
  if (!page) throw new Error('page missing');
  // Keys and words come from the output of scripts/load-test-seed.mjs.
  const filled = results.seed as {
    search: { rare: { word: string; threads: number }; common: { word: string }; body: { word: string } };
  };
  const out: Record<string, unknown> = {};
  for (const [key, term] of [
    ['rare', filled.search.rare.word],
    ['common', filled.search.common.word],
    ['text', filled.search.body.word],
  ] as const) {
    await page.goto(`${instance.url}/start`);
    await settled(page);
    const search = page.getByRole('combobox', { name: 'Search' });
    await search.fill(term);
    const ms = await timed(async () => {
      await search.press('Enter');
      await expect(page.getByText('Search results').first()).toBeVisible({ timeout: 60_000 });
      await expect(
        page
          .getByRole('main')
          .getByRole('button', { name: new RegExp(key === 'text' ? filled.search.rare.word : term) })
          .first(),
      ).toBeVisible({ timeout: 60_000 });
    });
    out[key] = { word: term, ms };
  }
  results.search = out;
});

test('sync with the page open', async ({ stalwart }) => {
  const page = need(context, 'context').pages()[0];
  if (!page) throw new Error('page missing');
  const top = await topThreads(stalwart, 11);
  await openInbox(page, need(top[0], 'thread'));
  await page.waitForTimeout(3_000);

  const subject = `New with open page ${Date.now()}`;
  const added = await timed(async () => {
    await putMail(stalwart, stalwart.user, { from: erika, subject, text: 'Load test', mailboxId: inbox });
    await expect(threadRow(page, subject)).toBeVisible({ timeout: 60_000 });
  });

  const read = await markRead(stalwart, 1000);
  const bulk = await timed(async () => {
    await destroyThreads(stalwart, top.slice(0, 10));
    await expect(threadRow(page, need(top[0], 'thread').subject)).toHaveCount(0, { timeout: 60_000 });
    await expect(threadRow(page, need(top[10], 'thread').subject)).toBeVisible({ timeout: 60_000 });
  });
  results.syncOpen = { newMailMs: added, tenThreadsDeletedMs: bulk, markedRead: read };
});

test('sync after closing', async ({ stalwart }) => {
  const ctx = need(context, 'context');
  const old = ctx.pages()[0];
  const top = await topThreads(stalwart, 12);
  if (old) {
    await old.waitForTimeout(3_000);
    await old.close();
  }
  await destroyThreads(stalwart, top.slice(0, 10));
  const read = await markRead(stalwart, 1000);
  const subject = `New with closed page ${Date.now()}`;
  await putMail(stalwart, stalwart.user, { from: erika, subject, text: 'Load test', mailboxId: inbox });

  const page = await newPage(ctx);
  const started = performance.now();
  await page.goto('/start');
  // First the cached state is shown, then the sync (`Email/changes`) catches up.
  // Whether the first paint still showed the old state depends on timing and is only a measurement.
  await expect(page.locator('.pf .scroll .band').first()).toBeVisible({ timeout: 60_000 });
  const first = Math.round(performance.now() - started);
  const staleShown = (await threadRow(page, need(top[0], 'thread').subject).count()) > 0;
  await expect(threadRow(page, subject)).toBeVisible({ timeout: 60_000 });
  await expect(threadRow(page, need(top[0], 'thread').subject)).toHaveCount(0, { timeout: 60_000 });
  const fresh = Math.round(performance.now() - started);
  results.syncClosed = {
    firstPaintMs: first,
    firstPaintStale: staleShown,
    currentStateMs: fresh,
    markedRead: read,
  };
});

test('IndexedDB storage', async () => {
  const page = need(context, 'context').pages()[0];
  if (!page) throw new Error('page missing');
  // The message prefetch comes 2 s after the first paint.
  await page.waitForTimeout(5_000);
  results.storage = await page.evaluate(async () => {
    const estimate = await navigator.storage.estimate();
    const out: { name: string; stores: { name: string; count: number; kb: number; readMs: number }[] }[] = [];
    for (const { name: dbName } of await indexedDB.databases()) {
      if (!dbName) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
      });
      const stores = [];
      for (const name of Array.from(db.objectStoreNames)) {
        const started = performance.now();
        const all = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(name).objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
        });
        const readMs = Math.round(performance.now() - started);
        const kb = Math.round(all.reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0) / 1024);
        stores.push({ name, count: all.length, kb, readMs });
      }
      db.close();
      out.push({ name: dbName.replace(/:.*/, ':…'), stores });
    }
    return { usedMb: Math.round(((estimate.usage ?? 0) / 1048576) * 10) / 10, databases: out };
  });
});

/** Excerpt of the Lighthouse result (`lhr`), as far as read here. */
interface LighthouseResult {
  /** Set if Lighthouse could not measure the page; the metrics are missing then. */
  runtimeError?: { code: string; message: string };
  categories: { performance?: { score: number | null } };
  audits: Record<
    string,
    | {
        numericValue?: number;
        details?: { items?: { url: string; resourceType?: string; transferSize?: number; resourceSize?: number }[] };
      }
    | undefined
  >;
}
type Lighthouse = (
  url: string,
  flags: Record<string, unknown>,
  config?: unknown,
) => Promise<{ lhr: LighthouseResult } | undefined>;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Metrics and loaded JS; gz from the build's files because the binary does not compress. */
async function lighthouseSummary(lhr: LighthouseResult, origin: string) {
  const value = (id: string) => lhr.audits[id]?.numericValue ?? Number.NaN;
  const scripts = (lhr.audits['network-requests']?.details?.items ?? []).filter(
    (item) => item.resourceType === 'Script' && item.url.startsWith(origin),
  );
  let gz = 0;
  for (const script of scripts) {
    const file = join(REPO, 'apps/web/build', new URL(script.url).pathname);
    // With --no-build the binary may embed a different build than apps/web/build.
    const data = await readFile(file).catch((err: unknown) => {
      throw new Error(`${file} missing: apps/web/build does not match the binary (run without --no-build)`, {
        cause: err,
      });
    });
    gz += gzipSync(data).length;
  }
  const kb = (bytes: number) => Math.round(bytes / 1000);
  return {
    score: Math.round((lhr.categories.performance?.score ?? Number.NaN) * 100),
    fcpMs: Math.round(value('first-contentful-paint')),
    lcpMs: Math.round(value('largest-contentful-paint')),
    tbtMs: Math.round(value('total-blocking-time')),
    speedIndexMs: Math.round(value('speed-index')),
    cls: Math.round(value('cumulative-layout-shift') * 1000) / 1000,
    js: {
      files: scripts.length,
      rawKb: kb(scripts.reduce((n, s) => n + (s.resourceSize ?? 0), 0)),
      transferredKb: kb(scripts.reduce((n, s) => n + (s.transferSize ?? 0), 0)),
      gzKb: kb(gz),
    },
  };
}

// Own browser with a debug port, because Lighthouse connects by itself and
// opens a tab in the default context; the persistent context is that default
// context and carries the sign-in. Before the run Lighthouse clears the HTTP
// cache and the service worker, cookie and IndexedDB stay.
test('Lighthouse: mailbox', async ({ instance }) => {
  const lhModule = process.env.LOAD_TEST_LIGHTHOUSE ?? '';
  test.skip(!lhModule, 'only with LOAD_TEST_LIGHTHOUSE (path to lighthouse/core/index.js)');
  const { default: lighthouse } = (await import(lhModule)) as { default: Lighthouse };
  const desktop = (
    (await import(new URL('config/desktop-config.js', pathToFileURL(lhModule)).href)) as { default: unknown }
  ).default;
  const state = need(session, 'session');
  const dir = await mkdtemp(join(tmpdir(), 'roedy-lh-'));
  const port = await freePort();
  const ctx = await chromium.launchPersistentContext(dir, {
    args: [`--remote-debugging-port=${port}`],
    baseURL: instance.url,
  });
  try {
    await ctx.addCookies(state.cookies);
    const stored = state.origins.find((o) => o.origin === instance.url)?.localStorage ?? [];
    await ctx.addInitScript((items) => {
      for (const { name, value } of items) if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
    }, stored);
    const page = await ctx.newPage();
    await page.goto('/start');
    await page.waitForURL(/\/mailbox\//, { timeout: 60_000 });
    await settled(page);
    // The cache writes in batches.
    await page.waitForTimeout(3_000);
    const url = page.url();
    await page.close();
    const runs: Record<string, unknown> = {};
    for (const [name, config] of [
      ['mobile', undefined],
      ['desktop', desktop],
    ] as const) {
      const flags = { port, hostname: '127.0.0.1', output: 'json', logLevel: 'error', onlyCategories: ['performance'] };
      const result = await lighthouse(url, flags, config);
      const lhr = need(result, 'Lighthouse result').lhr;
      // Without a measurement all values would be NaN and the step would still pass.
      if (lhr.runtimeError)
        throw new Error(`Lighthouse (${name}): ${lhr.runtimeError.code} – ${lhr.runtimeError.message}`);
      if (typeof lhr.categories.performance?.score !== 'number')
        throw new Error(`Lighthouse (${name}): no performance score`);
      runs[name] = await lighthouseSummary(lhr, instance.url);
    }
    results.lighthouse = { path: new URL(url).pathname.replace(/\/mailbox\/[^/]+/, '/mailbox/…'), ...runs };
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recipient suggestions with many accounts', async ({ instance, stalwart }) => {
  test.skip(extra.length === 0, 'without further accounts');
  const ctx = need(context, 'context');
  const page = ctx.pages()[0] ?? (await newPage(ctx));
  const connect = await timed(async () => {
    for (const user of extra) {
      await page.goto(`${instance.url}/account/mail-accounts/new`);
      await settled(page);
      await connectAccount(page, stalwart, user);
    }
  });
  await page.goto('/start');
  await settled(page);
  const field = page.getByRole('combobox', { name: 'To' });
  const last = extra.length;
  const stop = countJmap(page);
  // From the click on: compose focuses "To" by itself, and the focus loads the contacts.
  const ms = await timed(async () => {
    await page.getByRole('navigation').getByRole('button', { name: 'New email' }).click();
    await field.focus();
    // Contact card 499 of the last account (planCards in load-test-seed.mjs): only one match.
    await field.pressSequentially(`k${last}-499`);
    await expect(page.getByRole('option', { name: new RegExp(`k${last}-499`, 'i') }).first()).toBeVisible({
      timeout: 60_000,
    });
  });
  results.suggestions = { accounts: 1 + extra.length, ms, jmap: await stop(), connectMs: connect };
});

// Last value in the hook: idle after the load.
test('idle after 10 s', async () => {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});
