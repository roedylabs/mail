// Settings of the mail account and the device: rules with a check of the script
// via `SieveScript/validate` and real delivery, vacation response (reply in
// Stalwart, rules paused), push dialog without browser permission, license list
// from the build, remove an account with undo. Own instance like mail.spec.ts
// (setup via API, setup.ts); axe checks every visited page.
import { devices, type Page } from '@playwright/test';
import { expect, test, type Stalwart } from './fixtures.ts';
import {
  apiGet,
  axeViolations,
  blobText,
  closeAll,
  createMailbox,
  erika,
  mailboxId,
  need,
  newPage,
  openAs,
  password,
  putMail,
  resetDelivery,
  row,
  sendMail,
  settled,
  sieveScripts,
  vacation,
  validateSieve,
  waitForMails,
  word,
  type Session,
} from './helpers.ts';
import { readyWithAccount } from './setup.ts';

test.describe.configure({ mode: 'serial' });

let session: Session | undefined;
let accountId: string | undefined;

test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

// Rules and vacation response also apply to the following files in the shared
// Stalwart: reset them even after a failed test.
test.afterAll(async ({ stalwart }) => {
  await resetDelivery(stalwart, stalwart.user);
});

/** Name of the active Sieve script in the user's account (or `null`). */
async function activeScript(stalwart: Stalwart): Promise<string | null> {
  return (await sieveScripts(stalwart, stalwart.user)).find((s) => s.isActive)?.name ?? null;
}

test('setup via API and connect account', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  const admin = { name: 'Alex Admin', email: stalwart.admin.email, password: password() };
  const page = await readyWithAccount(context, instance, stalwart, admin, stalwart.user);
  accountId = /\/account\/mail-accounts\/([^/]+)\//.exec(page.url())?.[1];
  session = await context.storageState();
});

test('create a rule: script valid, delivery sorted', async ({ browser, instance, stalwart }) => {
  const { user, admin } = stalwart;
  const folder = word('Filing');
  const folderId = await createMailbox(stalwart, user, folder);
  const page = await openAs(
    browser,
    need(session, 'session'),
    `${instance.url}/account/mail-accounts/${need(accountId, 'account')}/rules`,
  );
  const main = page.getByRole('main');
  await expect(main.getByText('No rules yet.', { exact: false })).toBeVisible();

  const name = word('Rule');
  const key = word('important');
  await main.getByRole('button', { name: 'Add rule' }).click();
  const editor = main.getByRole('group', { name: 'New rule' });
  // Exact names: the folder picker's name contains the random folder name.
  await editor.getByRole('textbox', { name: 'Rule name', exact: true }).fill(name);
  await editor.getByRole('combobox', { name: 'Field', exact: true }).selectOption({ label: 'Subject contains' });
  await editor.getByRole('textbox', { name: 'Value', exact: true }).fill(key);
  await editor.getByRole('combobox', { name: /^Folder(:|$)/ }).click();
  await editor
    .getByRole('listbox', { name: 'Folder', exact: true })
    .getByRole('option', { name: folder, exact: true })
    .click();
  expect(await axeViolations(page), 'axe: edit rule').toEqual([]);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Rule added', { exact: true })).toBeVisible();
  await expect(main.getByRole('switch', { name: `${name} active` })).toHaveAttribute('aria-checked', 'true');

  // In Stalwart: the own script active, with rule and model line, valid
  // according to `SieveScript/validate`.
  let blobId: string | undefined;
  await expect
    .poll(async () => {
      const script = (await sieveScripts(stalwart, user)).find((s) => s.name === 'roedy-mail');
      blobId = script?.blobId;
      return script?.isActive ?? false;
    }, 'script roedy-mail active')
    .toBe(true);
  const script = await blobText(stalwart, user, need(blobId, 'script'));
  expect(script).toContain(`# ${name}\n`);
  expect(script).toContain(`"${key}"`);
  expect(script).toContain(`fileinto "${folder}";`);
  expect(script).toMatch(/^# roedy-mail-rules: \{"v":1,/m);
  expect(await validateSieve(stalwart, user, need(blobId, 'script'))).toBeNull();

  // "Show Sieve script" shows the same script without the model line.
  await main.getByRole('button', { name: 'Show Sieve script' }).click();
  await expect(main.getByText(`# ${name}`, { exact: false })).toBeVisible();
  await expect(main).not.toContainText('roedy-mail-rules');
  expect(await axeViolations(page), 'axe: rules with script').toEqual([]);

  // Real delivery: Stalwart runs the script.
  const subject = `Please read ${key}`;
  await sendMail(stalwart, admin, user, subject, 'Sorted by rule.');
  const [mail] = await waitForMails(stalwart, user, subject, 1);
  expect(mail?.mailboxIds).toEqual([folderId]);
});

test('vacation response: reply arrives, rules paused', async ({ browser, instance, stalwart }) => {
  const { user, admin } = stalwart;
  const base = `${instance.url}/account/mail-accounts/${need(accountId, 'account')}`;
  const page = await openAs(browser, need(session, 'session'), `${base}/vacation`);
  const main = page.getByRole('main');
  const unsaved = page.getByRole('region', { name: 'Unsaved changes' });

  // Until one week from now, as a day in the device's time zone.
  const until = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toLocaleDateString('sv');
  });
  const subject = word('Away');
  const text = 'I am out of the office until next week.';
  await main.getByRole('switch', { name: 'Vacation reply' }).click();
  await main.getByRole('textbox', { name: 'Until (optional)' }).fill(until);
  await main.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await main.getByRole('textbox', { name: 'Message' }).fill(text);
  expect(await axeViolations(page), 'axe: vacation response').toEqual([]);
  await unsaved.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Vacation reply turned on', { exact: true })).toBeVisible();
  await expect(unsaved).toBeHidden();

  // In Stalwart: enabled until the start of the following day (`toDate` is exclusive).
  const end = await page.evaluate((day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1).getTime();
  }, until);
  const saved = await vacation(stalwart, user);
  expect(saved).toMatchObject({ isEnabled: true, fromDate: null, subject, textBody: text });
  expect(Date.parse(saved.toDate ?? ''), 'toDate').toBe(end);
  // In Stalwart the vacation response is the active script, the rules are paused.
  expect(await activeScript(stalwart)).toBe('vacation');

  const asked = word('Request');
  await sendMail(stalwart, admin, user, asked, 'Are you there?');
  const [reply] = await waitForMails(stalwart, admin, subject, 1);
  expect(reply?.from).toEqual([user.email]);
  expect(reply?.text).toContain(text);

  // The rules say that they are paused and lead to the vacation response.
  await page.goto(`${base}/rules`);
  await settled(page);
  const note = main.getByRole('status').filter({ hasText: 'Your vacation reply is on' });
  await expect(note).toBeVisible();
  await note.getByRole('button', { name: 'Go to vacation reply' }).click();
  await expect(page.getByRole('heading', { name: 'Vacation reply', level: 1 })).toBeVisible();

  // Switching off activates the rules again (`rules.resume()`).
  await main.getByRole('switch', { name: 'Vacation reply' }).click();
  await unsaved.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Vacation reply saved', { exact: true })).toBeVisible();
  expect((await vacation(stalwart, user)).isEnabled).toBe(false);
  await expect.poll(() => activeScript(stalwart), 'rules active again').toBe('roedy-mail');
});

test('mobile settings: back to the last view, panel at the top after every switch', async ({
  browser,
  instance,
  stalwart,
}) => {
  const subject = word('Back');
  await putMail(stalwart, stalwart.user, {
    from: erika,
    subject,
    text: 'Back to this folder.',
    mailboxId: await mailboxId(stalwart, stalwart.user, 'sent'),
  });
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 600 },
    storageState: need(session, 'session'),
  });
  const page = await newPage(context);
  const folder = `${instance.url}/mailbox/${need(accountId, 'account')}/sent`;
  await page.goto(folder);
  await settled(page);
  await expect(row(page, subject)).toBeVisible({ timeout: 30_000 });

  const back = page.getByRole('button', { name: 'Back to Roedy Mail' });
  /** More › Settings: the area's list. */
  const openSettings = async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(back).toBeVisible();
  };
  // "Back to Roedy Mail" returns to the folder, not to the inbox.
  await openSettings();
  await back.click();
  await expect(page).toHaveURL(folder);
  await expect(row(page, subject)).toBeVisible();

  // Swiping back from the list leads to the same folder.
  await openSettings();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 400 }] });
  for (let i = 1; i <= 100; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 40 + 2 * i, y: 400 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page).toHaveURL(folder);
  await expect(row(page, subject)).toBeVisible();

  // The panel starts at the top: list → page and page → list.
  await openSettings();
  const scrollDown = async () => {
    await page.locator('main.m-panel').evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await top(page)).toBeGreaterThan(0);
  };
  await scrollDown();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(back).toBeHidden();
  await expect.poll(() => top(page)).toBe(0);
  await scrollDown();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(back).toBeVisible();
  await expect.poll(() => top(page)).toBe(0);
  expect(await axeViolations(page), 'axe: mobile settings list').toEqual([]);
  await context.close();
});

/** Scroll position of the mobile panel. */
function top(page: Page): Promise<number> {
  return page.locator('main.m-panel').evaluate((el) => el.scrollTop);
}

test('push dialog without browser permission', async ({ browser, instance }) => {
  // Headless Chromium refuses notifications (even with `grantPermissions`);
  // subscribing to the push service, the test message and the active state
  // remain to be checked manually in a real browser.
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/settings/notifications`);
  const main = page.getByRole('main');
  const channel = main.getByRole('switch', { name: 'Push notifications', exact: true });
  await expect(main.getByText('Blocked in the browser. Allow notifications in your browser settings.')).toBeVisible();
  await channel.click();
  const denied = page.getByRole('dialog', { name: 'Blocked by the browser' });
  await expect(denied).toContainText(`Your browser is blocking notifications for ${new URL(instance.url).host}.`);
  await expect(denied.getByRole('listitem')).toHaveCount(3);
  expect(await axeViolations(page), 'axe: push denied').toEqual([]);
  await denied.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Permission checked again', { exact: true })).toBeVisible();
  await expect(denied).toBeVisible();
  await denied.getByRole('button', { name: 'Close' }).last().click();
  await expect(denied).toBeHidden();
  await expect(channel).toHaveAttribute('aria-checked', 'false');

  // The palette opens the same dialog.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByLabel('Command palette').fill('Push');
  await palette.getByRole('button', { name: 'Set up push notifications' }).click();
  await expect(palette).toBeHidden();
  await expect(denied).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(denied).toBeHidden();
});

test('all licenses: list from the build with the packages of app and service worker', async ({ browser, instance }) => {
  // In the real build the list once held only two packages because the service
  // worker overwrote licenses.json. Without ROEDY_SERVER_LICENSES only the web
  // packages are listed.
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/settings/about`);
  await page.getByRole('button', { name: /^All licenses/ }).click();
  const dialog = page.getByRole('dialog', { name: 'All licenses' });
  const sub = await dialog.getByText(/^\d+ packages that .+ ships$/).textContent();
  expect(Number.parseInt(sub ?? '', 10), sub ?? '').toBeGreaterThan(10);
  for (const name of [/^svelte \d/, /^dompurify \d/, /^@sveltejs\/kit \d/, /^@tabler\/icons-svelte-runes \d/]) {
    await expect(dialog.getByRole('button', { name })).toHaveCount(1);
  }
  const svelte = dialog.getByRole('button', { name: /^svelte \d/ });
  await svelte.click();
  await expect(svelte).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('region').first()).toContainText('Permission is hereby granted');
  expect(await axeViolations(page), 'axe: all licenses').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /^All licenses/ })).toBeFocused();
});

test('push dialog: browser request denied', async ({ browser, instance }) => {
  // Without a real request: the permission is "default", and
  // `requestPermission()` only answers when the test says so – this way the
  // "Turn on" step, "Waiting for the browser" and the denial can be checked.
  const context = await browser.newContext({ storageState: need(session, 'session') });
  type Answer = { answerPermission?: (p: NotificationPermission) => void };
  await context.addInitScript(() => {
    let permission: NotificationPermission = 'default';
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
    Notification.requestPermission = () =>
      new Promise((resolve) => {
        (window as Answer).answerPermission = (p) => {
          permission = p;
          resolve(p);
        };
      });
  });
  const page = await newPage(context);
  /** Answers the open request as soon as the app waits for the browser. */
  const answer = async (p: NotificationPermission) => {
    await expect(page.getByRole('dialog', { name: 'Waiting for the browser' })).toBeVisible();
    await page.evaluate((value) => (window as Answer).answerPermission?.(value), p);
  };
  await page.goto(`${instance.url}/settings/notifications`);
  await settled(page);

  await page.getByRole('main').getByRole('switch', { name: 'Push notifications', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Turn on push notifications' });
  await expect(ask).toContainText('Your browser will ask for your permission once.');
  expect(await axeViolations(page), 'axe: enable push').toEqual([]);
  await ask.getByRole('button', { name: 'Grant permission' }).click();

  // Without a decision (request closed) the question stays.
  await answer('default');
  await expect(page.getByText('No decision was made in the browser', { exact: true })).toBeVisible();
  await expect(ask).toBeVisible();

  await ask.getByRole('button', { name: 'Grant permission' }).click();
  await answer('denied');
  await expect(page.getByRole('dialog', { name: 'Blocked by the browser' })).toBeVisible();
});

test('remove an account with undo', async ({ browser, instance, stalwart }) => {
  const { user } = stalwart;
  const page = await openAs(
    browser,
    need(session, 'session'),
    `${instance.url}/account/mail-accounts/${need(accountId, 'account')}/connection`,
  );
  const accounts = async () =>
    (await apiGet<{ accounts: { email: string }[] }>(page, 'mail-accounts')).accounts.map((a) => a.email);
  const remove = async () => {
    await page.getByRole('main').getByRole('button', { name: 'Remove' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Remove ${user.email}?` });
    await expect(confirm).toContainText(`Messages and folders stay on ${new URL(stalwart.url).host}.`);
    await confirm.getByRole('button', { name: 'Remove' }).click();
  };
  const toast = page.getByRole('status').filter({ hasText: `${user.email} removed` });
  expect(await axeViolations(page), 'axe: connection').toEqual([]);

  // While the toast is shown the account is only hidden.
  await remove();
  await expect(toast).toBeVisible();
  await expect(page).toHaveURL(/\/account\/mail-accounts$/);
  expect(await accounts()).toEqual([user.email]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toBeHidden();
  await expect(page.getByRole('main')).toContainText(user.email);

  // Once the toast expires it is removed – also after reloading.
  await page.goto(`${instance.url}/account/mail-accounts/${need(accountId, 'account')}/connection`);
  await settled(page);
  await remove();
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 20_000 });
  await expect.poll(accounts, 'account removed in the backend').toEqual([]);
  await page.reload();
  await settled(page);
  await expect(page.getByRole('main').getByText(user.email)).toHaveCount(0);
});
