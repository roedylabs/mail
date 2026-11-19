// First flow: setup in five steps (a wrong token up to the lock, then the
// right one), then mail server (OAuth client via DCR) and
// system mails via the administration API → invitations to two addresses,
// links from the system mails →
// accept both (with mandatory MFA) → connect an account via the mail server's
// sign-in page and /oauth/callback. The tests build on each other (serial) and
// share the file's instance (fixtures.ts).
import type { Page } from '@playwright/test';
import { expect, test, type MailUser } from './fixtures.ts';
import {
  axeViolations,
  closeAll,
  need,
  newPage,
  password,
  settled,
  totp,
  waitForMails,
  type Session,
} from './helpers.ts';
import { connectAccount, connectServer } from './setup.ts';

test.describe.configure({ mode: 'serial' });

const admin: { name: string; password: string; state?: Session } = { name: 'Alex Admin', password: password() };
/**
 * Invitees: the address of the Stalwart user and a sub-address of it (`tag`);
 * link from the mail and session from the previous tests.
 */
const invitees: { name: string; first: string; tag?: string; link?: string; state?: Session }[] = [
  { name: 'Kim User', first: 'Kim' },
  { name: 'Sam Second', first: 'Sam', tag: 'two' },
];

/** Second address via sub-addressing: lands in the mailbox of `user`. */
function subAddress(user: MailUser, tag: string): string {
  const [local, domain] = user.email.split('@');
  return `${local}+${tag}@${domain}`;
}

// Also the contexts of a failed test: otherwise their pages would keep running and report errors in the next one.
test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

/**
 * New setup step: heading present and, where the step has one, focus in the
 * first field (the page sets it shortly after entering); axe without findings.
 */
async function step(page: Page, heading: string, first?: string): Promise<void> {
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  if (first) await expect(page.getByLabel(first, { exact: true })).toBeFocused();
  expect(await axeViolations(page), `axe: ${heading}`).toEqual([]);
}

function next(page: Page) {
  return page.getByRole('button', { name: 'Continue', exact: true });
}

test('setup: five steps, then mail server and system mails', async ({ browser, instance, stalwart }) => {
  // The token lock alone takes 30 s.
  test.slow();
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(`${instance.url}/`);
  await expect(page).toHaveURL(/\/setup$/);
  await settled(page);

  // 1 Language and appearance: applies at once, a custom accent from the colour editor
  await step(page, 'Welcome');
  await expect(page.getByRole('radio', { name: 'System' }).first()).toBeFocused();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.getByRole('radio', { name: 'More' }).click();
  const editor = page.getByRole('dialog', { name: 'More colors' });
  await expect(editor).toBeFocused();
  expect(await axeViolations(page), 'axe: colour editor').toEqual([]);
  // A colour whose ink reaches 4.5 : 1 (the ink rule for custom colours is #164).
  await editor.getByLabel('Or your own hex code').fill('#5b8def');
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Custom #5B8DEF' })).toBeFocused();
  await page.getByRole('radio', { name: 'Custom #5B8DEF' }).press('Enter');

  // 2 Token: a wrong one uses up attempts, the fifth locks the entry (30 s), also after a reload
  await step(page, 'Set up Roedy Mail');
  const token = page.getByLabel('Setup token');
  const alert = page.getByRole('alert');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  await token.fill('2345-6789-ABCD');
  for (const left of ['4 attempts left', '3 attempts left', '2 attempts left', '1 attempt left']) {
    await next(page).click();
    await expect(alert).toContainText('Invalid token.');
    await expect(alert).toContainText(left);
  }
  await next(page).click();
  await expect(alert).toContainText('Too many attempts.');
  await expect(token).toBeDisabled();
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  expect(await axeViolations(page), 'axe: token locked').toEqual([]);
  // A reload forgets the lock in the page; the server's answer brings it back with the time left.
  await page.reload();
  await settled(page);
  await step(page, 'Set up Roedy Mail');
  await token.fill(await instance.setupToken());
  await next(page).click();
  await expect(alert).toContainText('Too many attempts.');
  await expect(token).toBeDisabled();
  // Usable again once the lock is over.
  await expect(token).toBeEnabled({ timeout: 35_000 });
  await expect(alert).toBeHidden();
  await token.fill(await instance.setupToken());
  await next(page).click();

  // 3 Administrator
  await step(page, 'Create administrator', 'Your name');
  await page.getByLabel('Your name').fill(admin.name);
  await page.getByLabel('Email address').fill(stalwart.admin.email);
  await next(page).click();

  // 4 Password
  await step(page, 'Set password', 'Password');
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(admin.password);
  await next(page).click();

  // 5 Review and completion
  await step(page, 'All set?');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Alex' })).toBeVisible();
  await expect(page).toHaveURL(/\/no-account$/);
  // The choices of step 1 are the administrator's settings.
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  await expect(page.getByRole('heading', { name: 'Connect your first email account' })).toBeVisible();
  expect(await axeViolations(page), 'axe: no account').toEqual([]);

  await connectServer(context, instance, stalwart);
  admin.state = await context.storageState();
  await context.close();
});

test('invitations to two addresses via system mail', async ({ browser, instance, stalwart }) => {
  const address = (tag?: string) => (tag ? subAddress(stalwart.user, tag) : stalwart.user.email);
  const context = await browser.newContext({ storageState: need(admin.state, "admin's session") });
  const page = await newPage(context);
  await page.goto(`${instance.url}/admin/users`);
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const input = page.getByLabel('Email addresses');
  for (const invitee of invitees) {
    await input.fill(address(invitee.tag));
    await input.press('Enter');
  }
  await page.getByRole('button', { name: `Send ${invitees.length} invitations` }).click();
  await expect(page.getByText(`${invitees.length} invitations sent`)).toBeVisible();
  await context.close();

  // The links are only in the mails (the API only returns them on request).
  const mails = await waitForMails(stalwart, stalwart.user, 'Invitation to Roedy Mail', invitees.length);
  for (const invitee of invitees) {
    const to = address(invitee.tag);
    const mail = mails.find((m) => m.to.includes(to));
    const link = mail && /https?:\/\/\S+\/invite\/[0-9a-f]{64}/.exec(mail.text)?.[0];
    expect(link?.startsWith(`${instance.url}/invite/`), `link in the invitation to ${to}`).toBe(true);
    if (link) invitee.link = link;
  }
});

test('accept invitations with MFA', async ({ browser }) => {
  for (const invitee of invitees) {
    const context = await browser.newContext();
    const page = await newPage(context);
    await page.goto(need(invitee.link, `link for ${invitee.name}`));
    await settled(page);

    // 1 Welcome
    await expect(page.getByRole('heading', { name: 'Welcome to Roedy Mail' })).toBeVisible();
    await page.getByRole('button', { name: 'Accept invitation' }).click();

    // 2 Account
    await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
    await page.getByLabel('Your name').fill(invitee.name);
    await page.getByLabel('Choose a password', { exact: true }).fill(password());
    await next(page).click();

    // 3 MFA with the displayed key; six digits submit on their own
    await expect(page.getByRole('heading', { name: 'Multi-factor authentication' })).toBeVisible();
    expect(await axeViolations(page), 'axe: multi-factor').toEqual([]);
    const secret = (await page.locator('.key-value').innerText()).trim();
    await page.getByLabel('Verification code').fill(totp(secret));

    // 4 Recovery codes (heading with a soft hyphen)
    await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' }).click();
    await page.getByRole('button', { name: 'Activate account' }).click();

    await expect(page.getByRole('heading', { name: `Welcome, ${invitee.first}` })).toBeVisible();
    await expect(page).toHaveURL(/\/no-account$/);
    invitee.state = await context.storageState();
    await context.close();
  }
});

test("connect an account via the mail server's sign-in page", async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext({
    storageState: need(invitees[0]?.state, "first invitee's session"),
  });
  const page = await newPage(context);
  await page.goto(`${instance.url}/no-account`);
  await settled(page);
  await page.getByRole('button', { name: 'Add email account' }).click();
  await expect(page).toHaveURL(/\/account\/mail-accounts\/new$/);

  await connectAccount(page, stalwart, stalwart.user);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  // The inbox comes straight from the mail server and shows both invitations.
  await page.goto(`${instance.url}/start`);
  await settled(page);
  await expect(page.getByText('Invitation to Roedy Mail').first()).toBeVisible();
  await context.close();
});

test('mobile without a mail account: tab bar on search and error pages', async ({ browser, instance }) => {
  const context = await browser.newContext({
    storageState: need(invitees[1]?.state, "second invitee's session"),
    viewport: { width: 390, height: 700 },
  });
  const page = await newPage(context);
  const tabbar = page.locator('nav.tabbar');
  const tab = (name: string) => tabbar.getByRole('button', { name, exact: true });
  await page.goto(`${instance.url}/no-account`);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Add email account' })).toBeVisible();
  await expect(tabbar).toHaveCount(0);

  // Search by address: tab bar with "Search" open.
  await page.goto(`${instance.url}/search`);
  await settled(page);
  await expect(tabbar).toBeVisible();
  await expect(tab('Search')).toHaveAttribute('aria-current', 'page');
  await expect(tab('Inbox')).not.toHaveAttribute('aria-current', 'page');
  // "Compose" only reports the missing account, "Inbox" leads to "No account".
  await tab('Compose').click();
  await expect(page.getByText('Connect an email account first')).toBeVisible();
  await expect(page).toHaveURL(/\/search$/);
  await tab('Inbox').click();
  await expect(page).toHaveURL(/\/no-account$/);
  await expect(tabbar).toHaveCount(0);

  // Error pages: unknown address and `/error/[code]`, without an open tab.
  for (const path of ['/nowhere', '/error/500']) {
    await page.goto(`${instance.url}${path}`);
    await settled(page);
    await expect(tabbar).toBeVisible();
    await expect(tabbar.locator('[aria-current="page"]')).toHaveCount(0);
  }
  await context.close();
});
