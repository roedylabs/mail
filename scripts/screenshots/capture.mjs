// Screenshots for the README and docs/walkthrough.md: drives the web app in a
// headless Chromium against the Vite dev server and answers the API and both
// mail servers with the fictitious demo data from ./demo.mjs.
//
// Usage (`just screenshots` runs both steps and writes to docs/screenshots):
//   scripts/dev/browser.sh install                      # once: Playwright and Chromium
//   scripts/dev/browser.sh run scripts/screenshots/capture.mjs <output-dir> [--only <name>[,…]]
//
// Images are taken at device scale factor 2. If ImageMagick (`magick`) is on
// the PATH, every image is reduced to a 256-color palette afterwards, which
// keeps each file well below 400 kB without visible loss for UI screenshots.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { setupDemo, WORK } from './demo.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
/** Point in time of the demo: a Tuesday morning, so the list shows times, "Yesterday" and weekdays. */
const NOW = new Date('2026-11-17T10:42:00-05:00');
const TZ = 'America/New_York';

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv.splice(onlyAt, 2)[1].split(',') : [];
const outDir = argv[0];
if (!outDir) {
  console.error('Usage: capture.mjs <output-dir> [--only <name>[,…]]');
  process.exit(2);
}
const OUT = path.resolve(outDir);
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const ALL = '/mailbox/all/inbox';

// --- Helpers ----------------------------------------------------------------

/** Waits for fonts, the end of skeletons and sync pill and of finite animations. */
async function settle(page, extra = 200) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('.bone, .pill')].some((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
        }),
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== 'running' || a.effect?.getTiming?.().iterations === Infinity),
      null,
      { timeout: 4000, polling: 100 },
    )
    .catch(() => {});
  await page.waitForTimeout(extra);
}

async function clickVisible(page, locator) {
  const n = await locator.count();
  for (let i = 0; i < n; i++)
    if (await locator.nth(i).isVisible()) {
      await locator.nth(i).click();
      await settle(page, 400);
      return;
    }
  throw new Error(`not visible: ${locator}`);
}

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function openThread(page, subject) {
  await clickVisible(page, page.getByText(subject, { exact: false }));
}

/**
 * Guest pages (setup, sign-in) start dark without a stored theme and switch
 * only via their own toggle. Brings the page to the wanted theme.
 */
async function ensureTheme(page, mode) {
  for (let i = 0; i < 3; i++) {
    if ((await page.evaluate(() => document.documentElement.dataset.mode)) === mode) return;
    let toggle = button(page, mode === 'dark' ? 'Dark theme' : 'Light theme').filter({ visible: true });
    // The setup wizard: the theme cards of its first step.
    if (!(await toggle.count())) {
      toggle = page
        .getByRole('radio', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true })
        .filter({ visible: true });
    }
    if (!(await toggle.count())) return;
    await toggle.first().click();
    await settle(page, 400);
  }
}

const lightTheme = (page) => ensureTheme(page, 'light');

// --- Shots ------------------------------------------------------------------

/** Fictitious values for the setup wizard (only sent to the mocked API). */
const SETUP_VALUES = {
  'su-token': 'K7QM-4XRT-9WPL',
  'su-name': 'Alex Morgan',
  'su-email': 'alex@example.com',
  'su-pw': 'Lakeside-Harbor-2026!',
  'su-pw2': 'Lakeside-Harbor-2026!',
};

/** Fills the visible setup fields with the demo values. */
async function fillSetup(page) {
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('input')]
      .filter((i) => i.id && (i.offsetParent || i.id === 'su-token'))
      .map((i) => ({ id: i.id, type: i.type, value: i.value })),
  );
  for (const f of fields) {
    if (f.value || !['text', 'password', 'email', 'url'].includes(f.type)) continue;
    await page
      .locator(`#${f.id}`)
      .fill(SETUP_VALUES[f.id] ?? (f.type === 'password' ? 'demo-app-password' : 'noreply@example.com'))
      .catch(() => {});
  }
}

/** Walks the setup wizard to step `n` (1–4): fills each step, then "Continue". */
async function setupStep(page, n) {
  const stepOf = () =>
    page.evaluate(() => {
      const m = /Step (\d)/.exec(document.querySelector('.bars')?.getAttribute('aria-label') ?? '');
      return m ? Number(m[1]) : null;
    });
  for (let guard = 0; guard < 16; guard++) {
    if ((await stepOf()) === n) return;
    await fillSetup(page);
    const primary = page.locator('button.primary').filter({ visible: true });
    if (await primary.count()) await primary.last().click();
    await settle(page, 900);
  }
  throw new Error(`setup: step ${n} not reached`);
}

async function search(page, query) {
  const field = page.locator('header.desk input[role=combobox]');
  await field.click();
  await field.pressSequentially(query, { delay: 30 });
  await field.press('Enter');
  await settle(page, 800);
}

/**
 * `name` is the file name without extension, `path` the page that is opened,
 * `prepare` leads to the shown state.
 */
const SHOTS = [
  // README
  { name: 'mailbox-light', path: ALL },
  { name: 'mailbox-dark', path: ALL, dark: true, prepare: (p) => openThread(p, 'Q4 roadmap review') },
  {
    name: 'compose',
    path: '/compose/new',
    prepare: async (p) => {
      await p.getByRole('combobox', { name: 'To' }).pressSequentially('priya', { delay: 30 });
      await settle(p, 300);
      await p.keyboard.press('Enter');
      await p.getByRole('textbox', { name: 'Subject' }).fill('Slides for Thursday');
      await p
        .getByRole('textbox', { name: 'Message' })
        .fill(
          'Hi Priya,\n\nthe beta numbers are in: 1,240 testers, 4.6 average rating and a crash rate below 0.3 %. ' +
            'I added three slides to your deck under item 2.\n\nSee you Thursday!\nAlex',
        );
      await settle(p, 2500);
    },
  },
  { name: 'settings', path: '/settings/appearance' },
  { name: 'admin', path: '/admin/users' },
  { name: 'mobile-mailbox', path: ALL, mobile: true },
  { name: 'mobile-message', path: ALL, mobile: true, prepare: (p) => openThread(p, 'Q4 roadmap review') },
  // Walkthrough
  {
    name: 'setup-token',
    path: '/setup',
    opts: { setup: true },
    prepare: async (p) => {
      await lightTheme(p);
      await setupStep(p, 2);
    },
  },
  {
    name: 'setup-review',
    path: '/setup',
    opts: { setup: true },
    prepare: async (p) => {
      await lightTheme(p);
      await setupStep(p, 5);
    },
  },
  { name: 'login', path: '/login', opts: { guest: true }, prepare: lightTheme },
  {
    name: 'add-account',
    path: '/account/mail-accounts/new',
    prepare: async (p) => {
      await p.getByRole('textbox', { name: 'Email address' }).fill('alex.morgan@example.org');
      await settle(p, 600);
    },
  },
  { name: 'mail-accounts', path: '/account/mail-accounts' },
  { name: 'message', path: ALL, prepare: (p) => openThread(p, 'Design review') },
  { name: 'search', path: ALL, prepare: (p) => search(p, 'roadmap') },
  { name: 'rules', path: `/account/mail-accounts/${WORK}/rules` },
  { name: 'vacation', path: `/account/mail-accounts/${WORK}/vacation`, opts: { vacation: true } },
  {
    name: 'notifications',
    path: ALL,
    prepare: (p) => clickVisible(p, p.locator('header.desk button[aria-label^="Notifications"]')),
  },
  {
    name: 'notification-settings',
    path: '/settings/notifications',
    prepare: (p) => clickVisible(p, p.getByRole('button', { name: 'Topics', exact: true })),
  },
  { name: 'mail-servers', path: '/admin/mail-servers' },
  { name: 'branding', path: '/admin/branding' },
  {
    name: 'backups',
    path: '/admin/maintenance',
    prepare: (p) => clickVisible(p, p.getByRole('button', { name: 'Backups', exact: true })),
  },
  { name: 'updates', path: '/admin/updates' },
];

// --- Run --------------------------------------------------------------------

// Native date fields follow the browser's language, not the page's.
const browser = await chromium.launch({ args: ['--lang=en-US'], env: { ...process.env, LANG: 'en_US.UTF-8' } });
const problems = [];
const quantize = (() => {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn('ImageMagick (magick) not found: images stay unoptimized.');
    return false;
  }
})();

for (const shot of SHOTS) {
  if (only.length && !only.includes(shot.name)) continue;
  const ctx = await browser.newContext({
    viewport: shot.mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: 2,
    hasTouch: !!shot.mobile,
    colorScheme: shot.dark ? 'dark' : 'light',
    serviceWorkers: 'block',
    bypassCSP: true,
    locale: 'en-US',
    timezoneId: TZ,
    permissions: ['notifications'],
  });
  const unhandled = new Set();
  await setupDemo(ctx, {
    now: NOW,
    mode: shot.dark ? 'dark' : 'light',
    ...shot.opts,
    onUnhandled: (k) => unhandled.add(k),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${shot.name}: pageerror ${e.message.slice(0, 200)}`));
  page.on('console', (msg) => {
    // The sandboxed email frame blocks scripts on purpose.
    if (msg.type() === 'error' && !/status of 401|frame is sandboxed/.test(msg.text()))
      problems.push(`${shot.name}: console ${msg.text().slice(0, 200)}`);
  });
  try {
    await page.goto(BASE + shot.path, { waitUntil: 'load' });
    await page.waitForSelector('.app, .bare', { timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('.splash'), null, { timeout: 20_000 });
    await settle(page, 600);
    if (shot.prepare) await shot.prepare(page);
    await ensureTheme(page, shot.dark ? 'dark' : 'light');
    await settle(page, 400);
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    if (quantize) execFileSync('magick', [file, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${file}`]);
    console.log(`${shot.name}.png  ${Math.round(fs.statSync(file).size / 1024)} kB`);
  } catch (e) {
    const failed = path.join(os.tmpdir(), `screenshot-failed-${shot.name}.png`);
    await page.screenshot({ path: failed }).catch(() => {});
    problems.push(`${shot.name}: ${e.message.split('\n')[0]} (state: ${failed})`);
  }
  if (unhandled.size) problems.push(`${shot.name}: unanswered ${[...unhandled].join(', ')}`);
  await ctx.close();
}
await browser.close();
if (problems.length) {
  console.log('--- Problems:');
  for (const p of problems) console.log(p);
}
