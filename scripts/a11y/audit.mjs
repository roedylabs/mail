// Accessibility audit: axe-core over all pages of the web app in a headless
// Chromium against the Vite dev server, plus zoom and reflow, reduced motion, landmarks, visible
// focus and keyboard samples. scripts/a11y/mocks.mjs answers the API and the
// JMAP server with made-up data.
//
// Usage (starts the Vite dev server for the run):
//   scripts/dev/browser.sh run scripts/a11y/audit.mjs <output-dir> \
//     [--only <part-of-route>[,…]] [--checks axe,states,zoom,motion,focus,keyboard] \
//     [--parallel <n>] [--fresh]
// Prerequisite: scripts/dev/browser.sh install (Playwright and axe-core).
//
// What is checked:
//   axe        every route with axe-core (WCAG 2.0/2.1 A and AA, 2.2 AA, best-practice),
//              desktop 1440 × 900 and mobile 390 × 844, each light and dark; also
//              landmarks, number of h1, <title>, lang and skip link per route
//   states     axe in opened states (menus, dialogs, sheets, toasts, select lists,
//              search suggestions, target picker in the rule editor): desktop light/dark, mobile light;
//              bars "Unsaved changes" and "Offline" (real and simulated): desktop and mobile, light and dark
//   zoom       WCAG 1.4.4/1.4.10: every route at 720 × 450 (200 %) and 320 × 640; horizontal
//              scrolling, clipped, covered and off-screen controls
//   motion     prefers-reduced-motion: reduce with the default "animations on":
//              what still runs (splash screen, skeleton, spinner, sheet, toast, popover)
//   focus      visible focus (2.4.7) of the first 30 tab stops on four pages
//   keyboard   samples: select lists, search suggestions, menus and tabs with the keyboard
// Result: <output-dir>/report.json (all findings raw, merged with earlier partial
// runs; --fresh starts empty) and report.md (summary), screenshots in screenshots/.
import axe from 'axe-core';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ACCOUNT_ID, OPEN_THREAD, setupMocks } from './mocks.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const ALL_CHECKS = ['axe', 'states', 'zoom', 'motion', 'focus', 'keyboard'];

// --- Arguments ------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv.splice(i, 2)[1] ?? '') : null;
};
const only = (flag('--only') ?? '').split(',').filter(Boolean);
const checks = (flag('--checks') ?? ALL_CHECKS.join(',')).split(',').filter(Boolean);
const parallel = Number(flag('--parallel') ?? 4);
const fresh = argv.includes('--fresh');
const outDir = argv.find((a) => !a.startsWith('--'));
if (!outDir) {
  console.error('Usage: audit.mjs <output-dir> [--only …] [--checks …] [--parallel n] [--fresh]');
  process.exit(2);
}
for (const c of checks) if (!ALL_CHECKS.includes(c)) throw new Error(`Unknown check: ${c}`);
const OUT = path.resolve(outDir);
const PHOTOS = path.join(OUT, 'screenshots');
fs.mkdirSync(PHOTOS, { recursive: true });

// --- Routes and views -----------------------------------------------------

const VIEWS = {
  d: { w: 1440, h: 900, label: 'Desktop 1440×900' },
  m: { w: 390, h: 844, label: 'mobile 390×844' },
  z: { w: 720, h: 450, label: 'Zoom 200 % (720×450)' },
  s: { w: 320, h: 640, label: 'reflow 320×640' },
};
const isMobile = (v) => VIEWS[v].w < 640;
const guest = { guest: true };
const mailbox = `/mailbox/${ACCOUNT_ID}/inbox`;
const mailAccount = `/account/mail-accounts/${ACCOUNT_ID}`;

/** Fake test values for the setup (only against the mocked API). */
const SETUP_VALUES = {
  'su-token': 'ABCD-EFGH-JKLM',
  'su-name': 'Max Example',
  'su-email': 'max@example.test',
  'su-pw': 'Example-Password-2026!',
  'su-pw2': 'Example-Password-2026!',
  'su-otp': '123456',
};

/**
 * Routes of the axe run: `path` is opened, `prepare` then leads to the
 * checked state (setup step, error, open editor).
 */
const ROUTES = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    id: `/setup (step ${n})`,
    path: '/setup',
    opts: { setup: true },
    prepare: (page) => setupStep(page, n),
  })),
  { id: '/login', path: '/login', opts: guest },
  { id: '/login (error)', path: '/login', opts: { ...guest, loginFail: true }, prepare: loginError },
  { id: '/password/reset/x', path: '/password/reset/x', opts: guest },
  { id: '/password/forgot', path: '/password/forgot', opts: guest },
  { id: '/invite/x', path: '/invite/x', opts: guest },
  { id: '/confirm-email/x', path: '/confirm-email/x', opts: guest },
  { id: '/no-account', path: '/no-account', opts: { noAccount: true } },
  { id: '/error/404', path: '/error/404', opts: guest },
  { id: '/error/403', path: '/error/403', opts: guest },
  { id: '/error/500', path: '/error/500', opts: guest },
  { id: '/start', path: '/start' },
  { id: '/mailbox (list)', path: mailbox },
  { id: '/mailbox (reading view)', path: `${mailbox}/${OPEN_THREAD}` },
  { id: '/search', path: '/search' },
  { id: '/compose/new', path: '/compose/new' },
  ...['general', 'notifications', 'appearance', 'language', 'shortcuts', 'about'].map((s) => ({
    id: `/settings/${s}`,
    path: `/settings/${s}`,
  })),
  { id: '/account/profile', path: '/account/profile' },
  { id: '/account/security', path: '/account/security' },
  { id: '/account/mail-accounts', path: '/account/mail-accounts' },
  { id: '/account/mail-accounts/new', path: '/account/mail-accounts/new' },
  ...['overview', 'connection', 'identities', 'vacation', 'rules'].map((s) => ({
    id: `/account/mail-accounts/a1/${s}`,
    path: `${mailAccount}/${s}`,
  })),
  { id: '/account/mail-accounts/a1/rules (Editor)', path: `${mailAccount}/rules`, prepare: openRuleEditor },
  ...[
    'users',
    'organization',
    'branding',
    'banner',
    'email',
    'mail-servers',
    'developer',
    'audit-log',
    'updates',
    'maintenance',
  ].map((s) => ({ id: `/admin/${s}`, path: `/admin/${s}` })),
];

/** States for axe: desktop light and dark, mobile light (or `views`), each with `prepare`. */
/** Layers a state waits for (`shown`): dialogs and sheets; on mobile, select lists are in the sheet. */
const MODAL = '[role=dialog][aria-modal=true]';
const LISTBOX = (v) => (isMobile(v) ? MODAL : '[role=listbox]');
const ALL_VIEWS = ['d-light', 'd-dark', 'm-light', 'm-dark'];

const STATES = [
  {
    id: 'Account menu / account sheet',
    path: mailbox,
    prepare: (p, v) => clickHeader(p, v, 'avatar'),
    shown: (v) => (isMobile(v) ? MODAL : '[role=group][data-pop]'),
  },
  {
    id: 'Notifications',
    path: mailbox,
    prepare: (p, v) => clickHeader(p, v, 'bell'),
    shown: () => '[role=dialog]',
  },
  // On mobile, command palette and shortcuts open no dialog (desktop only).
  {
    id: 'Command palette',
    path: mailbox,
    views: ['d-light', 'd-dark'],
    prepare: (p) => ui(p, 'ui.openPalette()'),
    shown: () => MODAL,
  },
  {
    id: 'Shortcuts help',
    path: mailbox,
    views: ['d-light', 'd-dark'],
    prepare: (p) => ui(p, 'ui.openHelp()'),
    shown: () => '[role=dialog]',
  },
  {
    id: 'Dialog add mail server',
    path: '/admin/mail-servers',
    prepare: (p) => clickVisible(p, 'button', /Add server/),
    shown: () => MODAL,
  },
  // Licenses: dialog on desktop, sheet on mobile; `licenses.json` from `setupMocks`.
  {
    id: 'All licenses',
    path: '/settings/about',
    prepare: (p) => clickVisible(p, 'button', /All licenses/),
    shown: () => `${MODAL} [aria-busy=false] button[aria-expanded]`,
  },
  {
    id: 'All licenses (expanded)',
    path: '/settings/about',
    prepare: async (p) => {
      await clickVisible(p, 'button', /All licenses/);
      // The rows only come with the list; `clickVisible` counts only once.
      await p.locator(`${MODAL} button[aria-expanded]`).first().waitFor({ state: 'visible' });
      await clickVisible(p, `${MODAL} button[aria-expanded]`);
    },
    shown: () => `${MODAL} button[aria-expanded=true]`,
  },
  {
    id: 'Confirmation (ui.ask)',
    path: '/settings/general',
    shown: () => '[role=alertdialog]',
    prepare: (p) =>
      ui(
        p,
        "ui.ask({ title: 'End all other sessions?', text: 'All other devices will be signed out.', danger: true, ok: 'End', force: true, run() {} })",
      ),
  },
  {
    id: 'Sheet "More"',
    path: mailbox,
    views: ['m-light', 'm-dark'],
    prepare: (p) => clickVisible(p, 'nav.tabbar button', /More/),
    shown: () => MODAL,
  },
  {
    id: 'Toast with undo',
    path: mailbox,
    prepare: (p) => ui(p, "ui.toasts.defer({ text: 'Conversation archived', revert() {} })"),
    shown: () => '[data-g=toast]',
  },
  {
    id: 'Error toast',
    path: mailbox,
    prepare: (p) => ui(p, "ui.toasts.error('Moving failed. Please try again.')"),
    shown: () => '[data-g=toast]',
  },
  {
    id: 'Select list open (general)',
    path: '/settings/general',
    prepare: (p) => clickVisible(p, '.pick-btn', null),
    shown: LISTBOX,
  },
  // On mobile there are no search suggestions: the tab bar leads to /search.
  {
    id: 'Search suggestions open',
    path: mailbox,
    views: ['d-light', 'd-dark'],
    prepare: openSuggestions,
    shown: () => '[role=dialog][data-sfbox]',
  },
  {
    id: 'Menu set tag (reading view)',
    path: `${mailbox}/${OPEN_THREAD}`,
    views: ['d-light', 'd-dark'],
    prepare: (p) => clickVisible(p, 'button[aria-label="Add tag"]', null),
    shown: () => '[role=menu]',
  },
  {
    id: 'More actions (reading view mobile)',
    path: `${mailbox}/${OPEN_THREAD}`,
    views: ['m-light', 'm-dark'],
    prepare: (p) => clickVisible(p, 'button[aria-label="More actions"]', null),
    shown: () => `[role=menu], ${MODAL}`,
  },
  // Bars, in all four views: the bar "Unsaved changes" has text on desktop, on mobile only
  // the two buttons; the notice bar "Offline" shows the text on mobile only as a tooltip.
  {
    id: 'Unsaved changes bar (profile)',
    path: '/account/profile',
    views: ALL_VIEWS,
    prepare: async (p) => {
      await clickVisible(p, 'button[aria-label="Edit display name"]', null);
      await p.locator('input[aria-label="Display name"]').filter({ visible: true }).first().fill('Max Changed');
      await settle(p, 400);
    },
    shown: () => '[role=region][aria-label="Unsaved changes"]',
  },
  // A real loss of connection, without "End simulation": every request fails and the
  // browser reports offline. `setOffline` alone does neither here: the routes of the mocks
  // keep answering (the newest route wins, so it aborts them) and headless Chromium keeps
  // `navigator.onLine` true, so the script sets it and sends the event a browser sends.
  {
    id: 'Offline bar',
    path: mailbox,
    views: ALL_VIEWS,
    prepare: async (p, v) => {
      await awayFromBars(p, v);
      offlinePages.add(p);
      await p.context().route('**/*', (route) => route.abort('internetdisconnected'));
      await p.context().setOffline(true);
      await p.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        window.dispatchEvent(new Event('offline'));
      });
      await settle(p, 400);
    },
    shown: () => '[role=status]:has-text("Offline")',
  },
  // Offline simulation of the Developer page: the same bar with the action "End simulation".
  {
    id: 'Offline bar (simulation)',
    path: mailbox,
    views: ALL_VIEWS,
    prepare: async (p, v) => {
      await awayFromBars(p, v);
      await network(p, 'network.simulate(true)');
    },
    shown: () => '[role=status]:has-text("Offline") button',
  },
  {
    id: 'Target picker in the rule editor',
    path: `${mailAccount}/rules`,
    prepare: async (p) => {
      await openRuleEditor(p);
      await clickVisible(p, '.pick-wrap button.pick', null);
    },
    shown: () => '[role=listbox]',
  },
];

// --- Helpers in the browser -----------------------------------------------

/** Loaded into every page: selector, visibility, style snapshot. */
function pageHelpers() {
  const h = {};
  h.vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  h.sel = (el) => {
    if (!el || el === document.body) return 'body';
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) {
        parts.unshift(`${s}#${e.id}`);
        break;
      }
      const cls = [...e.classList].filter((c) => !c.startsWith('s-') && !c.startsWith('svelte-')).slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      const label = e.getAttribute('aria-label');
      if (label && parts.length === 0) s += `[aria-label="${label.slice(0, 40)}"]`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  h.name = (el) =>
    (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
  h.style = (el, pseudo = null) => {
    const cs = getComputedStyle(el, pseudo);
    return [
      cs.outlineStyle === 'none' || cs.outlineWidth === '0px'
        ? 'outline:none'
        : `outline:${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
      `shadow:${cs.boxShadow}`,
      `bg:${cs.backgroundColor}`,
      `border:${cs.borderTopColor}/${cs.borderBottomColor}/${cs.borderTopWidth}`,
      `color:${cs.color}`,
      `deco:${cs.textDecorationLine}`,
      pseudo ? `content:${cs.content}` : '',
    ].join(' ');
  };
  h.snapshot = (el) => ({
    self: h.style(el),
    before: h.style(el, '::before'),
    after: h.style(el, '::after'),
    parent: el.parentElement ? h.style(el.parentElement) : '',
  });
  h.animations = () =>
    document.getAnimations().map((a) => {
      const t = a.effect?.target;
      const timing = a.effect?.getTiming?.() ?? {};
      return {
        kind: a.constructor.name,
        name: a.animationName ?? a.transitionProperty ?? '',
        target: t ? h.sel(t) : '',
        duration: timing.duration,
        iterations: timing.iterations,
        state: a.playState,
      };
    });
  window.__a11y = h;
}

// --- Opening a page -------------------------------------------------------

let browser;
const runs = {};
const pageErrors = [];
const mockGaps = new Map();
/** Pages whose connection a state has cut: their disconnection errors are expected. */
const offlinePages = new WeakSet();

async function open(job, { view, dark, opts = {}, reducedMotion = 'no-preference', path: p, waitApp = true }) {
  const vp = VIEWS[view];
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 1,
    hasTouch: isMobile(view),
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion,
    serviceWorkers: 'block',
    bypassCSP: true,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
  });
  const tag = `${job} · ${vp.label} · ${dark ? 'dark' : 'light'}`;
  await setupMocks(ctx, {
    mode: dark ? 'dark' : 'light',
    gUndo: '10 s',
    ...opts,
    onUnhandled: (key) => {
      if (!mockGaps.has(key)) mockGaps.set(key, new Set());
      mockGaps.get(key).add(job);
    },
  });
  await ctx.addInitScript(pageHelpers);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message.slice(0, 300)}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    // Expected: `auth/me` answers guests with 401.
    if (opts.guest && /status of 401/.test(text)) return;
    if (opts.setup && /status of 401/.test(text)) return;
    // Expected only after the state "Offline bar" has cut the connection of this page.
    if (offlinePages.has(page) && /ERR_INTERNET_DISCONNECTED/.test(text)) return;
    pageErrors.push(`[${tag}] console.${msg.type()}: ${text.slice(0, 300)}`);
  });
  await page.goto(BASE + p, { waitUntil: waitApp ? 'load' : 'commit' });
  if (waitApp) {
    await page.waitForSelector('.app, .bare', { timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('.splash'), null, { timeout: 20_000 });
    await settle(page);
  }
  return { ctx, page, tag };
}

/** Waits for fonts, the end of the skeletons and of all finite animations and transitions. */
async function settle(page, extra = 150) {
  await page.evaluate(() => document.fonts.ready);
  // Wait for skeletons and the sync pill (first sync, at least 1.5 s).
  await page
    .waitForFunction(() => ![...document.querySelectorAll('.bone, .pill')].some((b) => window.__a11y.vis(b)), null, {
      timeout: 8000,
    })
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

async function ui(page, code) {
  await page.evaluate(
    // Only our own fixed expressions from this script.
    (c) => import('/src/lib/state/ui.svelte.ts').then(({ ui }) => new Function('ui', c)(ui)),
    code,
  );
  await settle(page, 250);
}

/**
 * The mouse rests at (0, 0), where the notice bar appears on mobile: its tooltip
 * (the text on mobile, meant for a long press) would open by hovering. Moves it to
 * the middle of the page first.
 */
async function awayFromBars(page, view) {
  await page.mouse.move(VIEWS[view].w / 2, VIEWS[view].h / 2);
}

/** Runs one of our own fixed expressions against the app's `network` state. */
async function network(page, code) {
  await page.evaluate(
    // Only our own fixed expressions from this script.
    (c) => import('/src/lib/state/network.svelte.ts').then(({ network }) => new Function('network', c)(network)),
    code,
  );
  await settle(page, 400);
}

/**
 * Waits until the layer of a state is visible. If nothing opens (for
 * example a second instance of `ui` after a hot reload), the state reports an
 * error in `report.json` instead of letting axe count 0 findings on the page
 * without the layer.
 */
async function shown(page, selector) {
  try {
    await page.locator(selector).filter({ visible: true }).first().waitFor({ timeout: 5000 });
  } catch {
    throw new Error(`state not opened: ${selector}`);
  }
}

async function clickVisible(page, selector, text) {
  const loc = page.locator(selector).filter(text ? { hasText: text } : {});
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible()) {
      await el.click();
      await settle(page, 300);
      return;
    }
  }
  // Also search by aria-label (icon buttons).
  if (text) {
    const byLabel = page.getByRole('button', { name: text });
    for (let i = 0; i < (await byLabel.count()); i++)
      if (await byLabel.nth(i).isVisible()) {
        await byLabel.nth(i).click();
        await settle(page, 300);
        return;
      }
  }
  throw new Error(`not found: ${selector} ${text ?? ''}`);
}

async function clickHeader(page, view, which) {
  const mobile = isMobile(view);
  const sel =
    which === 'avatar'
      ? mobile
        ? 'header.mobile .avatar'
        : 'header.desk .avatar'
      : mobile
        ? 'header.mobile button[aria-label^="Notifications"]'
        : 'header.desk button[aria-label^="Notifications"]';
  await page.click(sel);
  await settle(page, 400);
}

async function openSuggestions(page) {
  const input = page.locator('input[role=combobox]').filter({ visible: true }).first();
  if (!(await input.count())) {
    // On mobile a button opens the search first.
    await clickVisible(page, 'button', /^Search$/);
  }
  const field = page.locator('input[role=combobox]').filter({ visible: true }).first();
  await field.click();
  await field.pressSequentially('Er', { delay: 60 });
  await settle(page, 600);
}

async function openRuleEditor(page) {
  await clickVisible(page, 'button[aria-label="Edit Invoices"]', null);
}

/**
 * Guest pages are dark without a stored setting (`mode: null`), even with a
 * light system; for the light run use their toggle "Light theme".
 */
async function lightToggle(page) {
  if (!(await page.evaluate(() => document.documentElement.dataset.mode === 'dark'))) return;
  const toggle = page.getByRole('button', { name: 'Light theme', exact: true }).filter({ visible: true });
  if (!(await toggle.count())) return;
  await toggle.first().click();
  await settle(page, 400);
}

async function loginError(page) {
  await page.fill('#ln-id', 'max@example.test');
  await page.fill('#ln-pw', 'wrong-password');
  await page.locator('button[type=submit]').filter({ visible: true }).first().click();
  await settle(page, 700);
}

/**
 * Setup up to step `n`: fill visible empty fields with test values, tick the recovery codes' checkbox, "Continue".
 * The code step confirms by itself with the sixth digit: no click there, which could hit the next step's primary.
 */
async function setupStep(page, n) {
  const stepOf = () =>
    page.evaluate(() => {
      const m = /Step (\d)/.exec(document.querySelector('.bars')?.getAttribute('aria-label') ?? '');
      return m ? Number(m[1]) : null;
    });
  let last = null;
  let same = 0;
  for (let guard = 0; guard < 16; guard++) {
    const at = await stepOf();
    if (at === n) return;
    same = at === last ? same + 1 : 0;
    last = at;
    if (same >= 3 || at === null || at > n) {
      const errs = await page.evaluate(() =>
        [...document.querySelectorAll('[role=alert], .err, .error, [aria-invalid=true]')]
          .filter((e) => window.__a11y.vis(e))
          .map((e) => window.__a11y.name(e) || window.__a11y.sel(e))
          .slice(0, 3),
      );
      throw new Error(`setup: step ${n} not reached (stays at ${at}; ${errs.join('; ')})`);
    }
    const auto = (await page.locator('#su-otp').count()) > 0;
    // The token and the code from the app are invisible inputs over their boxes.
    const fields = await page.evaluate(() =>
      [...document.querySelectorAll('input')]
        .filter((i) => i.id && (window.__a11y.vis(i) || i.id === 'su-token' || i.id === 'su-otp'))
        .map((i) => ({ id: i.id, type: i.type, value: i.value })),
    );
    for (const f of fields) {
      if (f.value || !['text', 'password', 'email', 'url'].includes(f.type)) continue;
      const value =
        SETUP_VALUES[f.id] ??
        (f.type === 'password'
          ? 'example-app-password'
          : f.type === 'url'
            ? 'https://mail.example.test'
            : 'max@example.test');
      await page
        .locator(`#${f.id}`)
        .fill(value)
        .catch(() => {});
    }
    const box = page.locator('button[role=checkbox][aria-checked=false]').filter({ visible: true });
    if (await box.count()) await box.first().click();
    const primary = page.locator('button.primary').filter({ visible: true });
    if (!auto && (await primary.count())) await primary.last().click();
    await settle(page, 900);
  }
  throw new Error(`setup: step ${n} not reached`);
}

// --- Measurements ---------------------------------------------------------

async function runAxe(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axe.source });
  return page.evaluate(async (tags) => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations', 'incomplete'],
    });
    const node = (n) => ({
      target: n.target.flat().join(' '),
      html: n.html.slice(0, 200),
      summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 300),
      data:
        n.any?.find((c) => c.data)?.data ??
        n.all?.find((c) => c.data)?.data ??
        n.none?.find((c) => c.data)?.data ??
        null,
    });
    return {
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        tags: v.tags,
        nodes: v.nodes.map(node),
      })),
      incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
    };
  }, AXE_TAGS);
}

function structure(page) {
  return page.evaluate(() => {
    const h = window.__a11y;
    const all = (s) => [...document.querySelectorAll(s)];
    const sectioning =
      'article, aside, main, nav, section, [role=main], [role=navigation], [role=complementary], [role=region]';
    const role = (el) => {
      const r = el.getAttribute('role');
      if (r) return r;
      const t = el.tagName.toLowerCase();
      if (t === 'header') return el.parentElement?.closest(sectioning) ? null : 'banner';
      if (t === 'footer') return el.parentElement?.closest(sectioning) ? null : 'contentinfo';
      if (t === 'main') return 'main';
      if (t === 'nav') return 'navigation';
      if (t === 'aside') return 'complementary';
      if (t === 'section' && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) return 'region';
      if (t === 'form' && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) return 'form';
      return null;
    };
    const landmarks = {};
    for (const el of all('header, footer, main, nav, aside, section, form, [role]')) {
      const r = role(el);
      if (!['banner', 'contentinfo', 'main', 'navigation', 'complementary', 'region', 'form', 'search'].includes(r))
        continue;
      if (!h.vis(el)) continue;
      landmarks[r] = (landmarks[r] ?? 0) + 1;
    }
    const focusables = all('a[href], button, input, select, textarea, [tabindex]').filter(
      (e) => e.tabIndex >= 0 && !e.disabled && h.vis(e),
    );
    const first = focusables[0];
    const skip = all('a[href^="#"]').find((a) => /inhalt|springen|skip|hauptbereich/i.test(a.textContent ?? ''));
    return {
      title: document.title,
      lang: document.documentElement.lang,
      mode: document.documentElement.dataset.mode,
      h1: all('h1')
        .filter(h.vis)
        .map((e) => e.textContent.trim().slice(0, 40)),
      h1Hidden: all('h1').filter((e) => !h.vis(e)).length,
      landmarks,
      skipLink: skip ? { text: skip.textContent.trim(), first: skip === first } : null,
      firstFocusable: first ? h.sel(first) : null,
      url: location.pathname,
    };
  });
}

async function zoomCheck(page) {
  return page.evaluate(() => {
    const h = window.__a11y;
    const de = document.documentElement;
    const overflowX = (el) => getComputedStyle(el).overflowX;
    const scrollable = (el) => ['auto', 'scroll'].includes(overflowX(el)) && el.scrollWidth > el.clientWidth + 1;
    const doc = {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
    const mains = [...document.querySelectorAll('main, [role=main]')].filter(h.vis).map((m) => ({
      sel: h.sel(m),
      scrollWidth: m.scrollWidth,
      clientWidth: m.clientWidth,
      overflowX: overflowX(m),
    }));
    const scrollers = [...document.querySelectorAll('body *')]
      .filter((e) => h.vis(e) && scrollable(e) && e.clientWidth > 0)
      .map((e) => ({ sel: h.sel(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }))
      .slice(0, 8);
    const controls = [
      ...document.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=combobox]',
      ),
    ].filter(h.vis);
    const offscreen = [];
    const clipped = [];
    const covered = [];
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // Ancestors with their own overflow rule: scrollable ones may clip, hiding ones may not.
      let inScroller = false;
      let hiddenBy = null;
      let outOfScroll = false;
      // Beyond the first scrollable ancestor, clipping is just scrolled away, not a finding.
      let pastScroller = false;
      for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        const scrolls = ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY);
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (scrolls) {
          if (a.scrollWidth > a.clientWidth + 1) inScroller = true;
          if (cx < ar.left || cx > ar.right || cy < ar.top || cy > ar.bottom) outOfScroll = true;
          pastScroller = true;
          continue;
        }
        if (pastScroller) continue;
        const cut = r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1;
        if (cut && !hiddenBy) hiddenBy = a;
      }
      const label = `${h.sel(c)} "${h.name(c)}"`;
      if (!inScroller && (r.right > innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${label} x=${Math.round(r.left)}…${Math.round(r.right)}`);
        continue;
      }
      if (hiddenBy) {
        const ar = hiddenBy.getBoundingClientRect();
        clipped.push(
          `${label} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}] in ${h.sel(hiddenBy)} [${Math.round(ar.left)},${Math.round(ar.top)} ${Math.round(ar.width)}×${Math.round(ar.height)}]`,
        );
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (outOfScroll || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && !c.contains(top) && !top.contains(c) && !top.closest('label')?.contains(c))
        covered.push(`${label} under ${h.sel(top)}`);
    }
    return { doc, mains, scrollers, offscreen, clipped, covered, controls: controls.length };
  });
}

// --- Checks ---------------------------------------------------------------

const matchesOnly = (id) => !only.length || only.some((o) => id.includes(o));
const tasks = [];
const task = (key, fn) => tasks.push({ key, fn });

async function photo(page, name, opts = {}) {
  const file = path.join(PHOTOS, `${name.replace(/[^a-z0-9-]+/gi, '_').slice(0, 90)}.png`);
  await page.screenshot({ path: file, ...opts });
  return file;
}

if (checks.includes('axe'))
  for (const r of ROUTES.filter((x) => matchesOnly(x.id)))
    for (const view of ['d', 'm'])
      for (const dark of [false, true])
        task(`axe|${r.id}|${view}|${dark ? 'dark' : 'light'}`, async () => {
          const { ctx, page } = await open(r.id, { view, dark, opts: r.opts, path: r.path });
          try {
            if (r.prepare) await r.prepare(page);
            if (!dark) await lightToggle(page);
            const res = await runAxe(page);
            return { ...res, structure: await structure(page) };
          } finally {
            await ctx.close();
          }
        });

if (checks.includes('states'))
  for (const s of STATES.filter((x) => matchesOnly(x.id) || matchesOnly(x.path)))
    for (const v of s.views ?? ['d-light', 'd-dark', 'm-light'])
      task(`states|${s.id}|${v}`, async () => {
        const [view, theme] = v.split('-');
        const { ctx, page } = await open(s.id, { view, dark: theme === 'dark', path: s.path });
        try {
          await s.prepare(page, view);
          await shown(page, s.shown(view));
          const res = await runAxe(page);
          return { ...res, structure: await structure(page) };
        } finally {
          await ctx.close();
        }
      });

if (checks.includes('zoom'))
  for (const r of ROUTES.filter((x) => matchesOnly(x.id)))
    for (const view of ['z', 's'])
      task(`zoom|${r.id}|${view}`, async () => {
        const { ctx, page } = await open(r.id, { view, dark: false, opts: r.opts, path: r.path });
        try {
          if (r.prepare) await r.prepare(page);
          const res = await zoomCheck(page);
          const docScroll = res.doc.scrollWidth > res.doc.clientWidth + 1;
          const mainScroll = res.mains.some((m) => m.scrollWidth > m.clientWidth + 1);
          if (docScroll || mainScroll || res.offscreen.length || res.clipped.length || res.covered.length)
            res.photo = await photo(page, `zoom-${r.id}-${view}`);
          return res;
        } finally {
          await ctx.close();
        }
      });

if (checks.includes('motion')) {
  const samples = async (page, ms) => {
    const seen = new Map();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const list = await page.evaluate(() => window.__a11y?.animations() ?? []).catch(() => []);
      for (const a of list) {
        const k = `${a.kind} ${a.name} @ ${a.target}`;
        if (!seen.has(k)) seen.set(k, a);
      }
      await page.waitForTimeout(80);
    }
    return [...seen.values()];
  };
  const motion = (id, fn, opts = {}) =>
    task(`motion|${id}`, async () => {
      const out = {};
      for (const [label, animations] of [
        ['reduce + animations on', undefined],
        ['reduce + animations off', false],
      ]) {
        const { ctx, page } = await open(id, {
          view: opts.view ?? 'd',
          dark: false,
          reducedMotion: 'reduce',
          opts: { ...(opts.mock ?? {}), ...(animations === undefined ? {} : { animations }) },
          path: opts.path ?? mailbox,
          waitApp: !opts.early,
        });
        try {
          out[label] = await fn(page, samples);
        } finally {
          await ctx.close();
        }
      }
      return out;
    });
  motion(
    'Splash screen',
    async (page, sample) => {
      const list = await sample(page, 3500);
      return { animations: list };
    },
    { early: true },
  );
  const control = {};
  motion(
    'Skeleton and spinner (folder switch, JMAP delayed)',
    async (page, sample) => {
      control.jmapDelay = 4000;
      void page.locator('aside, nav, .sidebar').getByText('Sent', { exact: true }).first().click();
      await page.waitForSelector('.bone', { timeout: 5000 }).catch(() => {});
      const css = await page.evaluate(() =>
        [...document.querySelectorAll('.bone, .spin, [class*=spin]')].slice(0, 6).map((e) => {
          const cs = getComputedStyle(e);
          return `${window.__a11y.sel(e)}: animation ${cs.animationName} ${cs.animationDuration} ${cs.animationIterationCount}`;
        }),
      );
      const animations = await sample(page, 800);
      control.jmapDelay = 0;
      return { css, animations };
    },
    { mock: { control } },
  );
  motion(
    'Sheet "More" (mobile)',
    async (page, sample) => {
      void page.locator('nav.tabbar button').filter({ hasText: /More/ }).first().click();
      return { animations: await sample(page, 900) };
    },
    { view: 'm' },
  );
  motion('Toast', async (page, sample) => {
    void page.evaluate(() => import('/src/lib/state/ui.svelte.ts').then(({ ui }) => ui.toasts.show('Setting saved')));
    return { animations: await sample(page, 900) };
  });
  motion('Popover account menu', async (page, sample) => {
    void page.click('header.desk .avatar');
    return { animations: await sample(page, 900) };
  });
  motion('Mail list while loading', async (page, sample) => {
    await page.goto(`${BASE}/mailbox/${ACCOUNT_ID}/archive`);
    return { animations: await sample(page, 1500) };
  });
}

if (checks.includes('focus'))
  for (const [id, p, opts] of [
    ['/mailbox (list)', mailbox, {}],
    ['/settings/appearance', '/settings/appearance', {}],
    ['/login', '/login', guest],
    ['/admin/users', '/admin/users', {}],
  ].filter(([id]) => matchesOnly(id)))
    for (const dark of [false, true])
      task(`focus|${id}|${dark ? 'dark' : 'light'}`, async () => {
        const { ctx, page } = await open(id, { view: 'd', dark, opts, path: p });
        try {
          await page.mouse.move(1, 899);
          await page.evaluate(() => {
            document.activeElement?.blur();
            window.scrollTo(0, 0);
          });
          const stops = [];
          for (let i = 1; i <= 30; i++) {
            await page.keyboard.press('Tab');
            await page.waitForTimeout(280);
            const info = await page.evaluate((n) => {
              const el = document.activeElement;
              if (!el || el === document.body) return null;
              el.dataset.a11yStop = String(n);
              const r = el.getBoundingClientRect();
              return {
                sel: window.__a11y.sel(el),
                name: window.__a11y.name(el),
                rect: [r.left, r.top, r.width, r.height].map(Math.round),
                focusVisible: el.matches(':focus-visible'),
                styles: window.__a11y.snapshot(el),
              };
            }, i);
            if (!info) {
              stops.push({ n: i, sel: 'body', visible: null });
              continue;
            }
            const [x, y, w, hgt] = info.rect;
            const clip = {
              x: Math.max(0, x - 6),
              y: Math.max(0, y - 6),
              width: Math.min(1440 - Math.max(0, x - 6), w + 12),
              height: Math.min(900 - Math.max(0, y - 6), hgt + 12),
            };
            const inView = clip.width > 2 && clip.height > 2 && x < 1440 && y < 900 && x + w > 0 && y + hgt > 0;
            const a = inView ? await page.screenshot({ clip }) : null;
            await page.evaluate(() => document.activeElement?.blur());
            await page.waitForTimeout(280);
            const unfocused = await page.evaluate(
              (n) => window.__a11y.snapshot(document.querySelector(`[data-a11y-stop="${n}"]`)),
              i,
            );
            const b = inView ? await page.screenshot({ clip }) : null;
            const pixelsDiffer = a && b ? !a.equals(b) : null;
            const styleDiff = Object.keys(info.styles).filter((k) => info.styles[k] !== unfocused[k]);
            const stop = {
              n: i,
              sel: info.sel,
              name: info.name,
              focusVisible: info.focusVisible,
              inView,
              pixelsDiffer,
              styleDiff,
            };
            if (pixelsDiffer === false) {
              stop.photo = await photo(page, `focus-${id}-${dark ? 'dark' : 'light'}-${i}`, {
                clip: {
                  ...clip,
                  x: Math.max(0, clip.x - 40),
                  width: Math.min(1440 - Math.max(0, clip.x - 40), clip.width + 80),
                },
              });
              stop.focused = info.styles.self;
            }
            stops.push(stop);
            // Focus back, so that Tab continues at the next element.
            await page.evaluate((n) => document.querySelector(`[data-a11y-stop="${n}"]`)?.focus(), i);
          }
          return { stops };
        } finally {
          await ctx.close();
        }
      });

if (checks.includes('keyboard')) {
  const active = (page) =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || !el ? 'body' : `${window.__a11y.sel(el)} "${window.__a11y.name(el)}"`;
    });
  const listOpen = (page) =>
    page.evaluate(() => [...document.querySelectorAll('[role=listbox]')].filter((e) => window.__a11y.vis(e)).length);

  task('keyboard|a: select list after mouse click', async () => {
    const { ctx, page } = await open('mkSel', { view: 'd', dark: false, path: '/settings/general' });
    try {
      const out = {};
      const btn = page.locator('.pick-btn').filter({ visible: true }).first();
      out.button = (await btn.textContent())?.trim();
      await btn.click();
      await settle(page, 300);
      out.afterOpen = await active(page);
      const opt = page.locator('[role=listbox] [role=option][aria-selected=false]').filter({ visible: true }).first();
      out.option = (await opt.textContent())?.trim();
      await opt.click();
      await settle(page, 400);
      out.afterMouseChoice = await active(page);
      out.listStillOpen = await listOpen(page);
      // Cross-check with the keyboard.
      await btn.focus();
      await page.keyboard.press('Enter');
      await settle(page, 300);
      await page.keyboard.press('ArrowDown');
      await settle(page, 200);
      // Select-only combobox: the button points to the list and the highlighted option.
      out.combobox = await page.evaluate(() => {
        const el = document.activeElement;
        const target = document.getElementById(el?.getAttribute('aria-activedescendant') ?? '');
        return {
          role: el?.getAttribute('role') ?? null,
          expanded: el?.getAttribute('aria-expanded') ?? null,
          controlsList: document.getElementById(el?.getAttribute('aria-controls') ?? '')?.getAttribute('role') ?? null,
          activeOption: target ? window.__a11y.name(target) : null,
          activeIsMarked: !!target?.classList.contains('hi'),
        };
      });
      await page.keyboard.press('Enter');
      await settle(page, 400);
      out.afterKeyboardChoice = await active(page);
      // Does Escape close and leave the focus on the button?
      await page.keyboard.press('Enter');
      await settle(page, 300);
      await page.keyboard.press('Escape');
      await settle(page, 300);
      out.afterEscape = await active(page);
      out.listOpenAfterEscape = await listOpen(page);
      return out;
    } finally {
      await ctx.close();
    }
  });

  task('keyboard|b: arrow keys in a long select list', async () => {
    const out = [];
    for (const p of ['/settings/language', '/settings/general']) {
      const { ctx, page } = await open('mkSel long', { view: 'd', dark: false, path: p });
      try {
        await page.setViewportSize({ width: 1440, height: 600 });
        await settle(page, 200);
        const buttons = page.locator('.pick-btn').filter({ visible: true });
        const n = await buttons.count();
        for (let i = 0; i < n; i++) {
          const btn = buttons.nth(i);
          // Move the button to the bottom edge of the visible area.
          await btn.evaluate((el) => {
            el.scrollIntoView({ block: 'end' });
          });
          await btn.focus();
          await page.keyboard.press('ArrowDown');
          await settle(page, 300);
          const total = await page.locator('[role=listbox] [role=option]').filter({ visible: true }).count();
          if (!total) {
            await page.keyboard.press('Escape');
            continue;
          }
          const state = () =>
            page.evaluate(() => {
              const box = [...document.querySelectorAll('[role=listbox]')].find((e) => window.__a11y.vis(e));
              const hi = box?.querySelector('.hi');
              const scrollers = [];
              for (let a = box?.parentElement; a; a = a.parentElement)
                if (a.scrollHeight > a.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(a).overflowY))
                  scrollers.push(a);
              const r = hi?.getBoundingClientRect();
              const br = box?.getBoundingClientRect();
              return {
                pageScroll: Math.round(window.scrollY + (scrollers[0]?.scrollTop ?? 0)),
                listScroll: Math.round(box?.scrollTop ?? 0),
                hi: hi ? hi.textContent.trim().slice(0, 30) : null,
                hiInWindow: r ? r.top >= 0 && r.bottom <= innerHeight : null,
                hiInList: r && br ? r.top >= br.top - 1 && r.bottom <= br.bottom + 1 : null,
                listBottom: br ? Math.round(br.bottom) : null,
                innerHeight,
              };
            });
          const first = await state();
          const steps = [];
          // One key press fewer than options, otherwise the highlight wraps back to the start.
          for (let k = 0; k < Math.min(total - 1, 40); k++) {
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(60);
            steps.push(await state());
          }
          const outside = steps.filter((s) => s.hiInWindow === false);
          out.push({
            route: p,
            button: (await btn.textContent())?.trim(),
            options: total,
            start: first,
            end: steps.at(-1),
            pageScrolled: steps.some((s) => s.pageScroll !== first.pageScroll),
            listScrolled: steps.some((s) => s.listScroll !== first.listScroll),
            hiOutsideWindow: outside.length,
            firstOutside: outside[0] ?? null,
          });
          await page.keyboard.press('Escape');
          await settle(page, 200);
        }
      } finally {
        await ctx.close();
      }
    }
    return out;
  });

  task('keyboard|c: search suggestions and Tab', async () => {
    const { ctx, page } = await open('Search', { view: 'd', dark: false, path: mailbox });
    try {
      const shown = () =>
        page.evaluate(() => {
          const input = document.querySelector('header.desk input[role=combobox]');
          const pop = document.querySelector('header.desk .search .pop');
          const el = document.activeElement;
          return {
            focus: el === document.body || !el ? 'body' : `${window.__a11y.sel(el)} "${window.__a11y.name(el)}"`,
            focusInSearch: !!el?.closest('header.desk .search'),
            expanded: input?.getAttribute('aria-expanded'),
            popupVisible: pop ? window.__a11y.vis(pop) : false,
          };
        });
      await page.focus('header.desk input[role=combobox]');
      await page.keyboard.type('Er', { delay: 60 });
      await settle(page, 500);
      const steps = [{ key: 'input "Er"', ...(await shown()) }];
      // Tab until the focus has left the search twice in a row.
      let outside = 0;
      for (let i = 0; i < 20 && outside < 2; i++) {
        await page.keyboard.press('Tab');
        await settle(page, 250);
        const st = await shown();
        steps.push({ key: `Tab ${i + 1}`, ...st });
        outside = st.focusInSearch ? 0 : outside + 1;
      }
      const firstOut = steps.find((x) => x.key !== 'input "Er"' && !x.focusInSearch);
      // Cross-check backwards: Shift+Tab out of the search field.
      await page.focus('header.desk input[role=combobox]');
      await settle(page, 300);
      const back0 = await shown();
      await page.keyboard.press('Shift+Tab');
      await settle(page, 300);
      const back = await shown();
      return {
        openWhenFocusLeft: firstOut ? firstOut.popupVisible : null,
        firstOutside: firstOut ?? null,
        tabsInsideSearch: steps.filter((x) => x.focusInSearch).length - 1,
        shiftTab: { before: back0, after: back },
        steps,
      };
    } finally {
      await ctx.close();
    }
  });

  const menuTest = (label, p, trigger, opts = {}) =>
    task(`keyboard|d: ${label}`, async () => {
      const { ctx, page } = await open(label, { view: opts.view ?? 'd', dark: false, path: p });
      try {
        const out = {};
        const t = page.locator(trigger).filter({ visible: true }).first();
        const popup = () =>
          page.evaluate(
            () =>
              [...document.querySelectorAll('[role=menu], [role=dialog], .pop, .sheet')]
                .filter((e) => window.__a11y.vis(e))
                .map((e) => window.__a11y.sel(e))
                .slice(0, 2)
                .join(' | ') || null,
          );
        const opened = async () => {
          await t.focus();
          await page.keyboard.press('Enter');
          await settle(page, 400);
        };
        out.popupBefore = await popup();
        await opened();
        out.ariaExpanded = await t.getAttribute('aria-expanded');
        out.popup = await popup();
        out.focusAfterOpen = await active(page);
        await page.keyboard.press('Escape');
        await settle(page, 400);
        out.escapeAtTrigger = { focus: await active(page), popup: await popup() };
        await opened();
        await page.keyboard.press('ArrowDown');
        await settle(page, 150);
        out.afterArrowDown = await active(page);
        await page.keyboard.press('ArrowDown');
        await settle(page, 150);
        out.afterArrowDown2 = await active(page);
        await page.keyboard.press('ArrowUp');
        await settle(page, 150);
        out.afterArrowUp = await active(page);
        if (
          !out.afterArrowDown.includes('menuitem') &&
          !(await page.evaluate(() => !!document.activeElement?.closest('[role=menu], .pop, .sheet')))
        ) {
          await page.keyboard.press('Tab');
          await settle(page, 150);
          out.afterTab = await active(page);
          await page.keyboard.press('ArrowDown');
          await settle(page, 150);
          out.afterTabArrowDown = await active(page);
        }
        await page.keyboard.press('Escape');
        await settle(page, 400);
        out.escapeInMenu = {
          focus: await active(page),
          popup: await popup(),
          ariaExpanded: await t.getAttribute('aria-expanded'),
        };
        return out;
      } finally {
        await ctx.close();
      }
    });
  menuTest('Account menu', mailbox, 'header.desk .avatar');
  menuTest('Notifications', mailbox, 'header.desk button[aria-label^="Notifications"]');
  menuTest('Set tag (reading view)', `${mailbox}/${OPEN_THREAD}`, 'button[aria-label="Add tag"]');
  menuTest('Move (reading view)', `${mailbox}/${OPEN_THREAD}`, 'button[aria-label="Move"]');
  menuTest('More actions (reading view mobile)', `${mailbox}/${OPEN_THREAD}`, 'button[aria-label="More actions"]', {
    view: 'm',
  });

  task('keyboard|d: tabs (sidebar, admin email)', async () => {
    const out = [];
    for (const p of [mailbox, '/admin/email']) {
      const { ctx, page } = await open('Tabs', { view: 'd', dark: false, path: p });
      try {
        const lists = page.locator('[role=tablist]').filter({ visible: true });
        for (let i = 0; i < (await lists.count()); i++) {
          const list = lists.nth(i);
          const sel = list.locator('[role=tab][aria-selected=true]').first();
          if (!(await sel.count())) continue;
          await sel.focus();
          const r = { route: p, tablist: await list.getAttribute('aria-label'), start: await active(page) };
          r.tabindex = await list.evaluate((l) =>
            [...l.querySelectorAll('[role=tab]')].map((t) => `${t.textContent.trim().slice(0, 15)}:${t.tabIndex}`),
          );
          await page.keyboard.press('ArrowRight');
          await settle(page, 300);
          r.afterArrowRight = await active(page);
          r.selectedAfter = await list.evaluate((l) =>
            l.querySelector('[role=tab][aria-selected=true]')?.textContent.trim().slice(0, 20),
          );
          await page.keyboard.press('Home');
          await settle(page, 200);
          r.afterHome = await active(page);
          out.push(r);
        }
      } finally {
        await ctx.close();
      }
    }
    return out;
  });
}

// --- Run ------------------------------------------------------------------

browser = await chromium.launch();
const started = Date.now();
let next = 0;
let doneCount = 0;
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    const t0 = Date.now();
    let result;
    try {
      result = await t.fn();
    } catch (e) {
      result = { error: e.message.split('\n')[0].slice(0, 300) };
    }
    result.ms = Date.now() - t0;
    runs[t.key] = result;
    doneCount++;
    const v = result.violations ? ` axe:${result.violations.length}` : '';
    console.log(
      `[${doneCount}/${tasks.length}] ${t.key}${v}${result.error ? ` ERROR ${result.error}` : ''} (${result.ms} ms)`,
    );
  }
}
// First call alone: Vite compiles on the first load and may reload.
if (tasks.length) {
  const ctx = await browser.newContext();
  await setupMocks(ctx, {});
  const page = await ctx.newPage();
  await page.goto(BASE + mailbox).catch(() => {});
  await page.waitForTimeout(4000);
  await ctx.close();
}
await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
await browser.close();

// --- Report ---------------------------------------------------------------

const reportFile = path.join(OUT, 'report.json');
let report = { runs: {}, pageErrors: [], mockGaps: {} };
if (!fresh && fs.existsSync(reportFile)) report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
Object.assign(report.runs, runs);
report.axeVersion = axe.version;
report.updated = new Date().toISOString();
report.pageErrors = [...new Set([...(report.pageErrors ?? []), ...pageErrors])];
for (const [k, v] of mockGaps) report.mockGaps[k] = [...new Set([...(report.mockGaps[k] ?? []), ...v])];
fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(OUT, 'report.md'), markdown(report));
console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${reportFile}`);

function markdown(rep) {
  const L = [];
  const entries = Object.entries(rep.runs);
  const axeRuns = entries.filter(([k]) => k.startsWith('axe|') || k.startsWith('states|'));
  L.push('# Accessibility audit', '', `As of ${rep.updated}, axe-core ${rep.axeVersion}, ${entries.length} runs.`, '');

  // axe by rule
  const rules = new Map();
  for (const [k, r] of axeRuns) {
    for (const v of r.violations ?? []) {
      if (!rules.has(v.id))
        rules.set(v.id, { id: v.id, impact: v.impact, help: v.help, nodes: 0, runs: [], examples: new Map() });
      const g = rules.get(v.id);
      g.nodes += v.nodes.length;
      g.runs.push(k);
      for (const n of v.nodes) {
        const d = n.data;
        const why =
          d && d.fgColor
            ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (required ${d.expectedContrastRatio}, ${d.fontSize} ${d.fontWeight})`
            : n.summary.slice(0, 160);
        if (!g.examples.has(n.target)) g.examples.set(n.target, why);
      }
    }
  }
  const impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  L.push('## axe findings by rule', '');
  L.push('| Rule | Impact | Nodes | Runs | Routes/states | only | Examples |', '|---|---|---|---|---|---|---|');
  for (const g of [...rules.values()].sort(
    (a, b) => impactOrder[a.impact] - impactOrder[b.impact] || b.nodes - a.nodes,
  )) {
    const where = [...new Set(g.runs.map((k) => k.split('|')[1]))];
    const views = new Set(g.runs.map((k) => k.split('|').slice(2).join('-')));
    const themes = new Set([...views].map((v) => (v.includes('dark') ? 'dark' : 'light')));
    const sizes = new Set([...views].map((v) => v[0]));
    const onlyIn = [
      themes.size === 1 ? [...themes][0] : '',
      sizes.size === 1 ? ([...sizes][0] === 'd' ? 'desktop' : 'mobile') : '',
    ]
      .filter(Boolean)
      .join(', ');
    const ex = [...g.examples.entries()].slice(0, 2).map(([t, w]) => `\`${t}\`: ${w}`);
    L.push(
      `| ${g.id} | ${g.impact} | ${g.nodes} | ${g.runs.length} | ${where.join('; ')} | ${onlyIn} | ${ex.join('<br>')} |`,
    );
  }
  const failed = entries.filter(([, r]) => r.error);
  if (failed.length) {
    L.push('', '## Runs with errors', '');
    for (const [k, r] of failed) L.push(`- ${k}: ${r.error}`);
  }

  // Structure
  L.push('', '## Structure per route (axe runs, light)', '');
  L.push('| Route | View | title | lang | h1 | main | Landmarks | Skip link |', '|---|---|---|---|---|---|---|---|');
  for (const [k, r] of axeRuns.filter(([k]) => k.endsWith('|light') && k.startsWith('axe|'))) {
    const s = r.structure;
    if (!s) continue;
    const [, id, view] = k.split('|');
    const lm = Object.entries(s.landmarks)
      .map(([a, b]) => `${a}:${b}`)
      .join(' ');
    L.push(
      `| ${id} | ${view} | ${s.mode} | ${s.title} | ${s.lang} | ${s.h1.length} (${s.h1.join(' / ')}) | ${s.landmarks.main ?? 0} | ${lm} | ${s.skipLink ? s.skipLink.text : '–'} |`,
    );
  }

  // Zoom
  const zoom = entries.filter(([k]) => k.startsWith('zoom|'));
  if (zoom.length) {
    L.push('', '## Zoom 200 % and reflow 320 px', '');
    L.push(
      '| Route | View | Document scrolls | Main area scrolls | off-screen | clipped | covered | Screenshot |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const [k, r] of zoom) {
      if (r.error) continue;
      const [, id, view] = k.split('|');
      const doc = r.doc.scrollWidth > r.doc.clientWidth + 1 ? `${r.doc.scrollWidth}/${r.doc.clientWidth}` : '–';
      const main =
        r.mains
          .filter((m) => m.scrollWidth > m.clientWidth + 1)
          .map((m) => `${m.scrollWidth}/${m.clientWidth}`)
          .join(' ') || '–';
      const ex = (list) => (list.length ? `${list.length}: ${list.slice(0, 2).join('; ')}` : '–');
      L.push(
        `| ${id} | ${view} | ${doc} | ${main} | ${ex(r.offscreen)} | ${ex(r.clipped)} | ${ex(r.covered)} | ${r.photo ?? ''} |`,
      );
    }
  }

  // Motion
  const motion = entries.filter(([k]) => k.startsWith('motion|'));
  if (motion.length) {
    L.push('', '## prefers-reduced-motion: reduce', '');
    for (const [k, r] of motion) {
      L.push(`### ${k.split('|')[1]}`);
      if (r.error) {
        L.push(`Error: ${r.error}`);
        continue;
      }
      for (const [label, v] of Object.entries(r)) {
        if (label === 'ms') continue;
        const list = (v.animations ?? []).map(
          (a) => `${a.kind} ${a.name} ${a.duration}ms×${a.iterations} @ ${a.target}`,
        );
        L.push(`- ${label}: ${list.length ? '' : 'no animation'}`);
        for (const x of list.slice(0, 12)) L.push(`  - ${x}`);
        for (const x of v.css ?? []) L.push(`  - CSS ${x}`);
      }
    }
  }

  // Focus
  const focus = entries.filter(([k]) => k.startsWith('focus|'));
  if (focus.length) {
    L.push('', '## Visible focus (first 30 tab stops)', '');
    for (const [k, r] of focus) {
      if (r.error) {
        L.push(`- ${k}: error ${r.error}`);
        continue;
      }
      const bad = r.stops.filter((s) => s.pixelsDiffer === false);
      const out = r.stops.filter((s) => s.inView === false);
      L.push(
        `- ${k.split('|').slice(1).join(' ')}: ${r.stops.length} stops, without visible change ${bad.length}, outside the window ${out.length}`,
      );
      for (const s of bad)
        L.push(`  - #${s.n} \`${s.sel}\` "${s.name}" (focus-visible ${s.focusVisible}) ${s.photo ?? ''}`);
    }
  }

  // Keyboard
  const keys = entries.filter(([k]) => k.startsWith('keyboard|'));
  if (keys.length) {
    L.push('', '## Keyboard samples', '');
    for (const [k, r] of keys) L.push(`### ${k.split('|')[1]}`, '```json', JSON.stringify(r, null, 1), '```');
  }

  L.push('', '## Errors and console', '');
  if (!rep.pageErrors.length) L.push('none');
  const grouped = new Map();
  for (const e of rep.pageErrors) {
    const msg = e.replace(/^\[[^\]]*\] /, '');
    grouped.set(msg, (grouped.get(msg) ?? 0) + 1);
  }
  for (const [msg, n] of grouped) L.push(`- ${n}× ${msg}`);
  L.push('', '## Mock gaps (unanswered requests)', '');
  const gaps = Object.entries(rep.mockGaps);
  if (!gaps.length) L.push('none');
  for (const [k, v] of gaps) L.push(`- ${k}: ${v.slice(0, 5).join('; ')}${v.length > 5 ? ' …' : ''}`);
  return L.join('\n') + '\n';
}
