// First flow: setup through its seven steps (a wrong token up to the lock, then
// the right one; the authenticator app with a wrong and the right code; the
// recovery codes, which "Finish setup" cannot skip; the review with "Change";
// a second tab that goes on too late gets the sign-in), the done
// screen opens Administration › Mail servers; then mail server (OAuth client via DCR) and
// system mails via the administration API → the administrator signs in again
// with a code from the setup's app → invitations to two addresses,
// links from the system mails →
// accept both through the four steps (details; name and password; the
// authenticator app with a wrong and the right code; the recovery codes) up to
// the welcome, the second on a phone → connect an account via the mail server's
// sign-in page and /oauth/callback. The tests build on each other (serial) and
// share the file's instance (fixtures.ts).
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MailUser } from './fixtures.ts';
import {
  Authenticator,
  axeViolations,
  closeAll,
  need,
  newPage,
  password,
  settled,
  under,
  waitForMails,
  type Session,
} from './helpers.ts';
import { connectAccount, connectServer } from './setup.ts';

test.describe.configure({ mode: 'serial' });

/** The administrator; `app` is the authenticator app linked in the setup (its codes are valid once). */
const admin: { name: string; password: string; app?: Authenticator; state?: Session } = {
  name: 'Alex Admin',
  password: password(),
};
/**
 * Invitees: the address of the Stalwart user and a sub-address of it (`tag`);
 * address and link from the mail and session from the previous tests. The
 * second accepts on a phone (`mobile`).
 */
const invitees: {
  name: string;
  first: string;
  tag?: string;
  mobile?: boolean;
  email?: string;
  link?: string;
  state?: Session;
}[] = [
  { name: 'Kim User', first: 'Kim' },
  { name: 'Sam Second', first: 'Sam', tag: 'two', mobile: true },
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
async function step(page: Page, heading: string | RegExp, first?: string): Promise<void> {
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  if (first) await expect(page.getByLabel(first, { exact: true })).toBeFocused();
  expect(await axeViolations(page), `axe: ${String(heading)}`).toEqual([]);
}

/** Heading of the authenticator app step (with its soft hyphen). */
const MFA = /^Multi-factor authen\u00ad?tication$/;

/** The key of the authenticator app step, without the spaces between its groups. */
async function keyOf(page: Page): Promise<string> {
  return (await page.locator('.key-value').innerText()).replace(/\s/g, '');
}

function next(page: Page) {
  return page.getByRole('button', { name: 'Continue', exact: true });
}

/** Checkbox of the recovery codes step. */
function savedBox(page: Page) {
  return page.getByRole('checkbox', { name: 'I’ve saved the codes in a safe place' });
}

/** `text` as a literal part of a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Invitation step: heading present, the focus where the page puts it on entering (`'heading'` or a field; none on step
 * 1), the layout (desktop: the step overview, no bottom bar; phone: the primary button in the bottom bar, no overview)
 * and axe without findings.
 */
async function inviteStep(
  page: Page,
  heading: string | RegExp,
  mobile: boolean,
  focused?: 'heading' | Locator,
): Promise<void> {
  const head = page.getByRole('heading', { name: heading });
  await expect(head).toBeVisible();
  if (focused) await expect(focused === 'heading' ? head : focused).toBeFocused();
  await expect(page.getByRole('list', { name: 'Invitation steps' })).toHaveCount(mobile ? 0 : 1);
  await expect(page.locator('.bottom button.primary')).toHaveCount(mobile ? 1 : 0);
  expect(await axeViolations(page), `axe: ${String(heading)}${mobile ? ' (phone)' : ''}`).toEqual([]);
}

test('setup: all steps, then mail server and system mails', async ({ browser, instance, stalwart }) => {
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

  // 5 Authenticator app: QR code and key from the setup API; the sixth digit confirms by itself
  await expect(page.getByRole('img', { name: 'QR code for the authenticator app' })).toBeVisible();
  await step(page, MFA, 'Verification code');
  await expect(page).toHaveTitle('Authenticator app · Setup');
  await expect(page.getByRole('img', { name: 'Step 5 of 7' })).toBeVisible();
  const secret = await keyOf(page);
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(secret);
  // No code of this key accepted yet.
  const app = new Authenticator(secret, 0);
  const code = page.getByLabel('Verification code');
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  // Too short: Confirm says so (it is never greyed out for an incomplete code).
  await code.fill('12');
  await expect(confirm).toHaveAttribute('aria-disabled', 'false');
  await confirm.click();
  await expect(alert).toContainText('Please enter all 6 digits.');
  await expect(code).toBeFocused();
  // A wrong code: cleared, "Invalid code.", focus back in the field.
  await code.fill(app.wrong());
  await expect(alert).toContainText('Invalid code.');
  await expect(code).toHaveValue('');
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toBeFocused();
  expect(await axeViolations(page), 'axe: invalid code').toEqual([]);
  // Back and forward again: the same key without a new one.
  await page.getByRole('button', { name: 'Back' }).click();
  await step(page, 'Set password', 'Password');
  await next(page).click();
  await step(page, MFA, 'Verification code');
  expect(await keyOf(page)).toBe(secret);
  await code.fill(await app.next());

  // 6 Recovery codes: the ten codes of the confirmed code, in memory only; reading them comes first (the heading)
  await step(page, 'Recovery codes');
  await expect(page).toHaveTitle('Recovery codes · Setup');
  await expect(page.getByRole('img', { name: 'Step 6 of 7' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeFocused();
  const codeItems = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codeItems).toHaveCount(10);
  const recovery = (await codeItems.allInnerTexts()).map((t) => t.replace(/^\d+\s*/, '').trim());
  expect(new Set(recovery).size).toBe(10);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(recovery[0]);
  // Download: app, address, a blank line, one code per line.
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(file.suggestedFilename()).toBe('recovery-codes.txt');
  expect(await readFile(await file.path(), 'utf8')).toBe(
    `Roedy Mail – Recovery codes\n${stalwart.admin.email}\n\n${recovery.join('\n')}\n`,
  );
  // Focus order: Copy → Download → checkbox → Back → Continue.
  const saved = savedBox(page);
  await page.getByRole('button', { name: 'Copy: Recovery codes' }).focus();
  for (const to of [
    page.getByRole('button', { name: 'Download' }),
    saved,
    page.getByRole('button', { name: 'Back' }),
  ]) {
    await page.keyboard.press('Tab');
    await expect(to).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(next(page)).toBeFocused();
  // Not past this step without the ticked box: Continue (never greyed out) shows the error and moves to the box, and
  // "Finish setup" is out of reach.
  await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
  await next(page).click();
  await expect(alert).toContainText('Confirm that you’ve saved the codes.');
  await expect(saved).toBeFocused();
  await expect(saved).toHaveAttribute('aria-invalid', 'true');
  expect(await axeViolations(page), 'axe: codes not saved').toEqual([]);
  await page.getByRole('heading', { name: 'Recovery codes' }).press('Enter');
  await expect(alert).toContainText('Confirm that you’ve saved the codes.');
  await expect(page.getByRole('button', { name: 'Finish setup' })).toHaveCount(0);
  // Space ticks the box (Enter on it would not continue either) and clears the error.
  await saved.press('Space');
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await expect(alert).toBeHidden();
  await next(page).click();

  // 7 Review: a summary row per step, the password never shown; focus on the heading
  await step(page, 'All set?');
  await expect(page).toHaveTitle('Review · Setup');
  await expect(page.getByRole('heading', { name: 'All set?' })).toBeFocused();
  const summary = page.getByRole('list', { name: 'Your details' });
  await expect(summary.getByRole('listitem')).toHaveText([
    /Language and appearance\s*System · Dark · Custom #1E3A8A/,
    new RegExp(`Administrator\\s*${admin.name}\\s*${stalwart.admin.email.replace(/[.+]/g, '\\$&')}`),
    /Password\s*••••••••••\s*Set/,
    /Multi-factor authentication\s*Authenticator app\s*Set up, 10 recovery codes/,
  ]);
  await expect(summary).not.toContainText(admin.password);
  await expect(page.getByText('Next, connect the mail server.')).toBeVisible();
  // Focus order: Change × 4 → Back → Finish setup.
  const change = (label: string) => page.getByRole('button', { name: `Change ${label}` });
  await change('Language and appearance').focus();
  for (const to of [
    change('Administrator'),
    change('Password'),
    change('Multi-factor authentication'),
    page.getByRole('button', { name: 'Back' }),
  ]) {
    await page.keyboard.press('Tab');
    await expect(to).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeFocused();
  // Back: the same codes with the box still ticked.
  await page.getByRole('button', { name: 'Back' }).click();
  await step(page, 'Recovery codes');
  await expect(codeItems).toHaveText(recovery.map((c, i) => new RegExp(`^${String(i + 1)}\\s*${c}$`)));
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await next(page).click();
  await step(page, 'All set?');
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
  // The same key again; the code must be newer than the confirmed one (the next one of the app).
  await step(page, MFA, 'Verification code');
  expect(await keyOf(page)).toBe(secret);
  await code.fill(await app.next());
  // The same codes, the box still ticked.
  await step(page, 'Recovery codes');
  await expect(codeItems).toHaveText(recovery.map((c, i) => new RegExp(`^${String(i + 1)}\\s*${c}$`)));
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await next(page).click();
  await step(page, 'All set?');
  // "Change" on multi-factor authentication: step 5 with the same key and an empty code field, then on through step 6.
  await change('Multi-factor authentication').click();
  await step(page, MFA, 'Verification code');
  expect(await keyOf(page)).toBe(secret);
  await expect(code).toHaveValue('');
  await code.fill(await app.next());
  await step(page, 'Recovery codes');
  await expect(codeItems).toHaveText(recovery.map((c, i) => new RegExp(`^${String(i + 1)}\\s*${c}$`)));
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await next(page).click();
  await step(page, 'All set?');
  admin.app = app;

  // A second tab gets to the password as well, but goes on too late (below): its authenticator app would replace this
  // tab's key, so it waits before that step.
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
  await expect(next(late)).toHaveAttribute('aria-disabled', 'false');

  // Done: welcome with the first name, the chips, the sign-in, then Administration › Mail servers.
  // Enter anywhere on the step finishes (here on the heading).
  await expect(page.getByRole('heading', { name: 'All set?' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome, Alex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Alex' })).toBeFocused();
  await expect(page).toHaveTitle('Done · Setup');
  await expect(page.getByRole('list', { name: 'Done' }).getByRole('listitem')).toHaveText([
    'Administrator created',
    'Multi-factor on',
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

  // The late tab: its key request gets 409 `setup_done` → the sign-in.
  await next(late).click();
  await expect(late).toHaveURL(/\/login$/);

  await connectServer(context, instance, stalwart);
  admin.state = await context.storageState();
  await context.close();
});

test('administrator signs in again with a code from the setup', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(`${instance.url}/login`);
  await settled(page);
  await page.getByLabel('Email or username').fill(stalwart.admin.email);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The setup's authenticator app asks for its code; the sixth digit confirms by itself.
  await expect(page.getByRole('heading', { name: 'Multi-factor authentication' })).toBeVisible();
  await page.getByLabel('Verification code').fill(await need(admin.app, 'app of the setup').next());
  await expect(page).toHaveURL(/\/no-account$/);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Add email account' })).toBeVisible();
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
    invitee.email = to;
    if (link) invitee.link = link;
  }
});

test('accept invitations with MFA', async ({ browser }) => {
  for (const invitee of invitees) {
    const mobile = invitee.mobile === true;
    const email = need(invitee.email, `address of ${invitee.name}`);
    const context = await browser.newContext(
      mobile ? { viewport: { width: 393, height: 877 }, isMobile: true, hasTouch: true } : {},
    );
    const page = await newPage(context);
    await page.goto(need(invitee.link, `link for ${invitee.name}`));
    await settled(page);

    // 1 Invitation: who invited, the invited address, the role and how long it is valid; nothing focused on opening
    await inviteStep(page, 'Welcome to Roedy Mail', mobile);
    await expect(page).toHaveTitle('Welcome to Roedy Mail');
    await expect(page.getByRole('img', { name: 'Step 1 of 4' })).toBeVisible();
    await expect(page.getByText(`Invitation from ${admin.name}`)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Invitation details' }).getByRole('listitem')).toHaveText([
      new RegExp(`^Email address\\s*${escape(email)}$`),
      /^Role\s*User\b/,
      /^Invitation valid until\s*\S/,
    ]);
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    await page.getByRole('button', { name: 'Accept invitation' }).click();

    // 2 Name and password: Continue greyed out until the name is there and both passwords match
    const name = page.getByLabel('Your name');
    const pw1 = page.getByLabel('Choose a password', { exact: true });
    const pw2 = page.getByLabel('Confirm password', { exact: true });
    await inviteStep(page, 'Set up your account', mobile, mobile ? 'heading' : name);
    await expect(page).toHaveTitle('Set up your account · Invitation');
    await expect(page.getByRole('img', { name: 'Step 2 of 4' })).toBeVisible();
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await name.fill(invitee.name);
    const pw = password();
    await pw1.fill(pw);
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await pw2.fill(`${pw}x`);
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await pw2.fill(pw);
    await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
    await next(page).click();

    // 3 Authenticator app: QR code and key; six digits submit on their own
    const code = page.getByLabel('Verification code');
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    await expect(page.getByRole('img', { name: 'QR code for the authenticator app' })).toBeVisible();
    await inviteStep(page, MFA, mobile, mobile ? 'heading' : code);
    await expect(page).toHaveTitle('Authenticator app · Invitation');
    await expect(page.getByRole('img', { name: 'Step 3 of 4' })).toBeVisible();
    const secret = await keyOf(page);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const app = new Authenticator(secret, 0);
    // A wrong code: cleared, "Invalid code." under the code boxes; on desktop the focus back in the field (on a phone
    // the on-screen keyboard stays as it is).
    await code.fill(app.wrong());
    const invalid = page.locator('#in-code-alert');
    await expect(invalid).toContainText('Invalid code.');
    await under(page.locator('.boxes'), invalid);
    await expect(code).toHaveValue('');
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    if (!mobile) await expect(code).toBeFocused();
    expect(await axeViolations(page), `axe: invalid code${mobile ? ' (phone)' : ''}`).toEqual([]);
    // Too short: Confirm says so (it is never greyed out for an incomplete code); the edit cleared "Invalid code.".
    await code.fill('12');
    await expect(invalid).toHaveCount(0);
    await expect(confirm).toHaveAttribute('aria-disabled', 'false');
    await confirm.click();
    await expect(page.locator('#in-otp-err')).toHaveText('Please enter all 6 digits.');
    // Back keeps the key: Continue shows the same one again (no new scan), the typed code is gone.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
    await expect(pw2).toHaveValue(pw);
    await next(page).click();
    await expect(page.getByRole('heading', { name: MFA })).toBeVisible();
    expect(await keyOf(page)).toBe(secret);
    await expect(code).toHaveValue('');
    // The right code of the displayed key creates the account.
    await code.fill(await app.next());

    // 4 Recovery codes: the heading has the focus, ten codes, no Back; unticked, "Activate account" asks first
    await inviteStep(page, 'Recovery codes', mobile, 'heading');
    await expect(page).toHaveTitle('Recovery codes · Invitation');
    await expect(page.getByRole('img', { name: 'Step 4 of 4' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    const saved = savedBox(page);
    const activate = page.getByRole('button', { name: 'Activate account' });
    await activate.click();
    await expect(page.locator('#in-saved-err')).toHaveText('Confirm that you’ve saved the codes.');
    await expect(saved).toBeFocused();
    await expect(saved).toHaveAttribute('aria-invalid', 'true');
    expect(await axeViolations(page), `axe: codes not saved${mobile ? ' (phone)' : ''}`).toEqual([]);
    await saved.click();
    await expect(page.locator('#in-saved-err')).toHaveCount(0);

    // Welcome with what was set up, then the start page. Loading the new account's settings waits until axe is done:
    // otherwise the page would move on after 2.7 s, in the middle of the check.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/v1\/settings$/, async (route) => {
      await held;
      await route.fallback();
    });
    await activate.click();
    const welcome = page.getByRole('heading', { name: `Welcome, ${invitee.first}` });
    await expect(welcome).toBeFocused();
    await expect(page).toHaveTitle('Welcome to Roedy Mail');
    await expect(page.getByText('Your account is set up.')).toBeVisible();
    if (!mobile) {
      await expect(page.getByRole('list', { name: 'Done' }).getByRole('listitem')).toHaveText([
        'Account created',
        'Authenticator app linked',
        'Recovery codes saved',
      ]);
    }
    await expect(page.getByText('Redirecting you to Roedy Mail …')).toBeVisible();
    await expect(page.getByRole('img', { name: /^Step \d of 4$/ })).toHaveCount(0);
    expect(await axeViolations(page), `axe: welcome${mobile ? ' (phone)' : ''}`).toEqual([]);
    release();
    await expect(page).toHaveURL(/\/no-account$/);
    await page.unrouteAll({ behavior: 'wait' });
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
