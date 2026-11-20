// First flow: setup in five steps (a wrong token up to the lock, then the
// right one; a second tab that finishes too late gets the sign-in), the done
// screen opens Administration › Mail servers; then mail server (OAuth client via DCR) and
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

  // 1 Language and appearance: applies at once, a custom accent from "More colors"
  await step(page, 'Welcome');
  await expect(page.getByRole('radio', { name: 'System' }).first()).toBeFocused();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  // One closed row of square tiles; "More colors" in the label row opens all colours inline (no dialog).
  const accents = page.getByRole('radiogroup', { name: 'Accent color' });
  await expect(accents).toBeVisible();
  expect(await axeViolations(page), 'axe: language and appearance').toEqual([]);
  const more = page.getByRole('button', { name: 'More colors' });
  await more.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(accents.getByRole('radio', { name: 'Apricot' })).toBeFocused();
  await expect(accents.getByRole('radio')).toHaveCount(23);
  await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeHidden();
  const hex = page.getByLabel('Your own hex code');
  await expect(hex).toBeVisible();
  expect(await axeViolations(page), 'axe: more colors').toEqual([]);
  // A dark colour, applied at once: the colours derived from it reach 4.5 : 1 on every page axe checks from here on (#164, #185, #187).
  await hex.fill('#1e3a8a');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(hex).toBeHidden();
  await expect(more).toBeFocused();
  // The own colour leads the row now; Enter on a tile does what "Get started" does.
  const custom = page.getByRole('radio', { name: 'Custom #1E3A8A' });
  await expect(accents.getByRole('radio').first()).toHaveAccessibleName('Custom #1E3A8A');
  await expect(custom).toHaveAttribute('aria-checked', 'true');
  await custom.focus();
  await custom.press('Enter');

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
  // The countdown bar moves every second; without motion axe need not wait for it.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await axeViolations(page), 'axe: token locked').toEqual([]);
  await page.emulateMedia({ reducedMotion: null });
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

  // 3 Administrator: Continue greyed out until both fields are valid; the name is checked while typing
  await step(page, 'Create administrator', 'Your name');
  const name = page.getByLabel('Your name');
  const email = page.getByLabel('Email address');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  // Enter on the empty step moves to the first empty field, without a message.
  await name.press('Enter');
  await expect(name).toBeFocused();
  await expect(alert).toBeHidden();
  await name.fill(`${admin.name} (1)`);
  await expect(alert).toContainText('Invalid name.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(await axeViolations(page), 'axe: invalid name').toEqual([]);
  // At most 100 characters (pasting is cut off too), the counter turns red at the limit; no error.
  await name.fill(`${admin.name} `.repeat(12));
  await expect(name).toHaveValue(`${admin.name} `.repeat(12).slice(0, 100));
  await expect(page.locator('#su-name-count')).toHaveText('100 / 100');
  await expect(alert).toBeHidden();
  await name.fill(admin.name);
  // Live account preview with the initials.
  await expect(page.locator('.acct .avatar')).toHaveText('AA');
  await email.fill('alex@example');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  // An invalid address: Enter moves there, no message.
  await name.press('Enter');
  await expect(email).toBeFocused();
  await expect(alert).toBeHidden();
  await email.fill(stalwart.admin.email);
  await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
  await next(page).click();

  // 4 Password
  await step(page, 'Set password', 'Password');
  const pw = page.getByLabel('Password', { exact: true });
  const pw2 = page.getByLabel('Confirm password', { exact: true });
  const rules = page.getByRole('list', { name: 'Password requirements' });
  await expect(page).toHaveTitle('Password · Setup');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  // A hidden username field for password managers.
  await expect(page.locator('input[name="username"]')).toHaveValue(stalwart.admin.email);
  // Enter on the incomplete step stays in the field that is missing something, without a message.
  await pw.press('Enter');
  await expect(pw).toBeFocused();
  await expect(alert).toBeHidden();
  await pw.fill('short');
  await expect(page.getByText('Weak', { exact: true })).toBeVisible();
  await pw.fill(admin.password);
  await expect(rules.getByText(': met')).toHaveCount(3);
  // Each field has its own eye, outside the Tab order: password → confirm → Back → Continue.
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(pw).toHaveAttribute('type', 'text');
  await expect(pw2).toHaveAttribute('type', 'password');
  await expect(pw).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pw2).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Back' })).toBeFocused();
  // A confirmation that differs: the message on Enter.
  await pw2.fill(`${admin.password}x`);
  await pw2.press('Enter');
  await expect(alert).toContainText('The passwords don’t match.');
  expect(await axeViolations(page), 'axe: passwords differ').toEqual([]);
  await pw2.fill(admin.password);
  await expect(alert).toBeHidden();
  await expect(rules.getByText(': met')).toHaveCount(4);
  await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
  // Back and forward again: both passwords are kept (in memory only).
  await page.getByRole('button', { name: 'Back' }).click();
  await step(page, 'Create administrator', 'Your name');
  await next(page).click();
  await step(page, 'Set password', 'Password');
  await expect(pw).toHaveValue(admin.password);
  await expect(pw2).toHaveValue(admin.password);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(admin.password);
  await next(page).click();

  // 5 Review: a summary row per step, the password never shown; focus on the heading
  await step(page, 'All set?');
  await expect(page).toHaveTitle('Review · Setup');
  await expect(page.getByRole('heading', { name: 'All set?' })).toBeFocused();
  const summary = page.getByRole('list', { name: 'Your details' });
  await expect(summary.getByRole('listitem')).toHaveText([
    /Language and appearance\s*System · Dark · Custom #1E3A8A/,
    new RegExp(`Administrator\\s*${admin.name}\\s*${stalwart.admin.email.replace(/[.+]/g, '\\$&')}`),
    /Password\s*••••••••••\s*Set/,
  ]);
  await expect(summary).not.toContainText(admin.password);
  await expect(page.getByText('Next, connect the mail server.')).toBeVisible();
  // Focus order: Change × 3 → Back → Finish setup.
  const change = (label: string) => page.getByRole('button', { name: `Change ${label}` });
  await change('Language and appearance').focus();
  for (const to of [change('Administrator'), change('Password'), page.getByRole('button', { name: 'Back' })]) {
    await page.keyboard.press('Tab');
    await expect(to).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeFocused();
  // "Change" walks forward again through the following steps: the token stays accepted, the passwords filled.
  await change('Language and appearance').click();
  await step(page, 'Welcome');
  await page.getByRole('button', { name: 'Get started' }).click();
  await step(page, 'Set up Roedy Mail');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
  await next(page).click();
  await step(page, 'Create administrator', 'Your name');
  await next(page).click();
  await step(page, 'Set password', 'Password');
  await expect(pw2).toHaveValue(admin.password);
  await next(page).click();
  await step(page, 'All set?');

  // A second tab gets to the review as well, but finishes too late (below).
  const late = await newPage(await browser.newContext());
  await late.goto(`${instance.url}/setup`);
  await settled(late);
  await late.getByRole('button', { name: 'Get started' }).click();
  await late.getByLabel('Setup token').fill(await instance.setupToken());
  await next(late).click();
  await late.getByLabel('Your name').fill('Sam Late');
  await late.getByLabel('Email address').fill('late@example.com');
  await next(late).click();
  await late.getByLabel('Password', { exact: true }).fill(admin.password);
  await late.getByLabel('Confirm password', { exact: true }).fill(admin.password);
  await next(late).click();
  await expect(late.getByRole('heading', { name: 'All set?' })).toBeVisible();

  // Done: welcome with the first name, the chips, the sign-in, then Administration › Mail servers.
  // Enter anywhere on the step finishes (here on the heading).
  await expect(page.getByRole('heading', { name: 'All set?' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome, Alex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Alex' })).toBeFocused();
  await expect(page).toHaveTitle('Done · Setup');
  await expect(page.getByRole('list', { name: 'Done' }).getByRole('listitem')).toHaveText([
    'Administrator created',
    'Setup token revoked',
  ]);
  await expect(page.getByText('Signing you in …')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('roedy-setup-')))).toEqual(
    [],
  );
  await expect(page).toHaveURL(/\/admin\/mail-servers$/);
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Mail servers', level: 1 })).toBeVisible();
  await expect(page.getByText('No mail server yet')).toBeVisible();
  // The choices of step 1 are the administrator's settings.
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  expect(await axeViolations(page), 'axe: mail servers').toEqual([]);

  // The late tab: 409 `setup_done` → the sign-in.
  await late.getByRole('button', { name: 'Finish setup' }).click();
  await expect(late).toHaveURL(/\/login$/);

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
