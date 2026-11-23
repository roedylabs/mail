// Sign-in and password reset on the guest pages: a wrong password, the
// authenticator app with a wrong and the right code up to "Hello" and the start
// page, Back from the code screen, a recovery code that works once, "Forgot
// password?" up to "Check your inbox", a reset link with an unknown token, and
// the mobile layout. Own instance like mail.spec.ts (setup via API, setup.ts);
// axe checks every screen.
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test, type Instance } from './fixtures.ts';
import { Authenticator, axeViolations, closeAll, need, newPage, password, settled } from './helpers.ts';
import { setupByApi } from './setup.ts';

test.describe.configure({ mode: 'serial' });

const admin = { name: 'Alex Admin', email: '', password: password() };
let app: Authenticator | undefined;
let recoveryCodes: string[] = [];

/** Heading of the authenticator code screen (with its soft hyphen). */
const MFA = /^Multi-factor authen­?tication$/;

test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

/** `/login` in a new page of `context`, settled. */
async function openLogin(context: BrowserContext, instance: Instance): Promise<Page> {
  const page = await newPage(context);
  await page.goto(`${instance.url}/login`);
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  return page;
}

/** Fields of the sign-in screen. */
function fields(page: Page): { id: Locator; pw: Locator; submit: Locator } {
  return {
    id: page.getByLabel('Email or username'),
    pw: page.getByLabel('Password', { exact: true }),
    submit: page.getByRole('button', { name: 'Sign in', exact: true }),
  };
}

/** Email and the right password, then the code screen of the authenticator app. */
async function toCode(page: Page): Promise<void> {
  const { id, pw, submit } = fields(page);
  await id.fill(admin.email);
  await pw.fill(admin.password);
  await submit.click();
  await expect(page.getByRole('heading', { name: MFA })).toBeVisible();
}

/** `below` starts under `above` on the page. */
async function under(above: Locator, below: Locator): Promise<void> {
  const a = need((await above.boundingBox()) ?? undefined, 'box of the upper element');
  const b = need((await below.boundingBox()) ?? undefined, 'box of the lower element');
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
}

/** The sign-in ends on "Hello, Alex" (focused), then the start page (no mail account yet). */
async function hello(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Hello, Alex' });
  await expect(heading).toBeFocused();
  await expect(page.getByText('You stay signed in on this device.')).toBeVisible();
  // No axe here: the page moves on after 2.6 s, in the middle of the check.
  await expect(page).toHaveURL(/\/no-account$/);
  await settled(page);
}

test('setup via API', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  admin.email = stalwart.admin.email;
  const setup = await setupByApi(context, instance, stalwart, admin);
  // The setup confirmed the app with the code of this moment; the next one must be newer.
  app = new Authenticator(setup.secret, Date.now());
  recoveryCodes = setup.recoveryCodes;
  await context.close();
});

test('wrong password: message under the field, password cleared, focus there', async ({ browser, instance }) => {
  const context = await browser.newContext();
  const page = await openLogin(context, instance);
  await expect(page).toHaveTitle(/^Sign in · /);
  const { id, pw, submit } = fields(page);
  // Desktop: entering focuses the first field.
  await expect(id).toBeFocused();
  // No footer and no artwork on the new page.
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  expect(await axeViolations(page), 'axe: sign in').toEqual([]);

  await id.fill(admin.email);
  await pw.fill(`${admin.password}-wrong`);
  await submit.click();
  const failed = page.getByRole('alert').filter({ hasText: 'Sign-in failed.' });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('The email, username, or password is incorrect.');
  await expect(pw).toHaveValue('');
  await expect(pw).toBeFocused();
  await expect(pw).toHaveAttribute('aria-describedby', /\bln-failed\b/);
  await expect(id).toHaveValue(admin.email);
  await under(pw, failed);
  expect(await axeViolations(page), 'axe: sign-in failed').toEqual([]);
  await context.close();
});

test('authenticator app: wrong code, the right one, Hello, start page', async ({ browser, instance }) => {
  const codes = need(app, 'authenticator app of the setup');
  const context = await browser.newContext();
  const page = await openLogin(context, instance);
  await toCode(page);
  await expect(page).toHaveTitle(/^Multi-factor authentication · /);
  const code = page.getByLabel('Verification code');
  await expect(code).toBeFocused();
  expect(await axeViolations(page), 'axe: code').toEqual([]);

  // The sixth digit confirms by itself; the message sits under the boxes.
  await code.fill(codes.wrong());
  const invalid = page.getByRole('alert').filter({ hasText: 'Invalid code.' });
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('Check the current code in your app and try again.');
  await expect(code).toHaveValue('');
  await expect(code).toBeFocused();
  await under(code, invalid);
  expect(await axeViolations(page), 'axe: invalid code').toEqual([]);

  await code.fill(await codes.next());
  await hello(page);
  await context.close();
});

test('Back from the code screen keeps the identifier and clears the password', async ({ browser, instance }) => {
  const context = await browser.newContext();
  const page = await openLogin(context, instance);
  await toCode(page);
  // "Back" with the full name for screen readers.
  await page.getByRole('button', { name: 'Back to sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  const { id, pw } = fields(page);
  await expect(id).toHaveValue(admin.email);
  await expect(pw).toHaveValue('');
  await expect(pw).toBeFocused();
  await context.close();
});

test('recovery code: signs in once, the same code a second time is rejected', async ({ browser, instance }) => {
  const recovery = need(recoveryCodes[0], 'recovery code of the setup');

  /** From the code screen to the recovery code screen; returns its field. */
  async function toRecovery(page: Page): Promise<Locator> {
    await toCode(page);
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code', exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/^Recovery code · /);
    const field = page.getByLabel('Recovery code', { exact: true });
    await expect(field).toBeFocused();
    return field;
  }

  const first = await browser.newContext();
  const page = await openLogin(first, instance);
  const field = await toRecovery(page);
  expect(await axeViolations(page), 'axe: recovery code').toEqual([]);
  // The eighth character confirms by itself.
  await field.fill(recovery);
  await hello(page);
  await first.close();

  const second = await browser.newContext();
  const again = await openLogin(second, instance);
  const used = await toRecovery(again);
  await used.fill(recovery);
  const invalid = again.getByRole('alert').filter({ hasText: 'Invalid code.' });
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('The code is incorrect or has already been used.');
  await under(used, invalid);
  await expect(again).toHaveURL(/\/login$/);
  await second.close();
});

test('forgot password: the identifier carried over, then Check your inbox', async ({ browser, instance }) => {
  const context = await browser.newContext();
  const page = await openLogin(context, instance);
  const { id } = fields(page);
  await id.fill(admin.email);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/password\/forgot$/);
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
  await expect(page).toHaveTitle(/^Reset password · /);
  const email = page.getByLabel('Email address');
  await expect(email).toHaveValue(admin.email);
  await expect(email).toBeFocused();
  expect(await axeViolations(page), 'axe: reset password').toEqual([]);

  await page.getByRole('button', { name: 'Send link' }).click();
  const heading = page.getByRole('heading', { name: 'Check your inbox' });
  await expect(heading).toBeFocused();
  await expect(page.locator('strong', { hasText: admin.email })).toBeVisible();
  // "Resend" waits 30 seconds after each send.
  const resend = page.getByRole('button', { name: /^Resend in 0:[0-3]\d$/ });
  await expect(resend).toBeDisabled();
  await expect(page).toHaveURL(/\/password\/forgot$/);
  expect(await axeViolations(page), 'axe: check your inbox').toEqual([]);
  await context.close();
});

test('reset link with an unknown token: Link expired or invalid, then a new link', async ({ browser, instance }) => {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(`${instance.url}/password/reset/unknown-token-of-the-e2e-suite`);
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  const pw = page.getByLabel('New password', { exact: true });
  await expect(pw).toBeFocused();
  expect(await axeViolations(page), 'axe: set a new password').toEqual([]);
  const save = page.getByRole('button', { name: 'Save password' });
  // Greyed out until all four requirements are met.
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  const next = password();
  await pw.fill(next);
  await page.getByLabel('Confirm password', { exact: true }).fill(next);
  await expect(save).not.toHaveAttribute('aria-disabled', 'true');
  await save.click();

  const heading = page.getByRole('heading', { name: 'Link expired or invalid' });
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle(/^Link expired or invalid · /);
  expect(await axeViolations(page), 'axe: link expired or invalid').toEqual([]);
  await page.getByRole('button', { name: 'Request a new link' }).click();
  await expect(page).toHaveURL(/\/password\/forgot$/);
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('');
  await context.close();
});

test('mobile: Sign in in the bottom bar, the focus on the heading', async ({ browser, instance }) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 877 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await openLogin(context, instance);
  // Entering focuses the heading, so the on-screen keyboard stays closed.
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  const submit = fields(page).submit;
  await expect(submit).toHaveCount(1);
  await expect(page.locator('.bottom').getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const box = need((await submit.boundingBox()) ?? undefined, 'box of "Sign in"');
  expect(box.y + box.height).toBeGreaterThan(877 - 80);
  expect(await axeViolations(page), 'axe: sign in on mobile').toEqual([]);
  await context.close();
});
