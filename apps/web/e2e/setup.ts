// Sets up an instance for flows after the setup: setup token, authenticator
// app and `setup/complete` via the API, then the mail server and the system emails
// through the administration API (`#lib/servers.svelte.ts`,
// `#lib/system-mail.svelte.ts`), after which the administrator is signed in in
// the browser context. "Connect account", by contrast, still goes through the
// mail server's real sign-in page – only it hands out the code for it.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, type Instance, type MailUser, type Stalwart } from './fixtures.ts';
import { CSRF, newPage, settled, totp } from './helpers.ts';

export interface AppUser {
  name: string;
  email: string;
  password: string;
}

/** Authenticator app of the setup: the key and the recovery codes from its confirmation. */
export interface SetupApp {
  secret: string;
  recoveryCodes: string[];
}

/**
 * Authenticator app for the administrator with `email` via the setup API:
 * `setup/totp`, then `setup/totp/verify` with the current code. `setup/complete`
 * needs it for the same address.
 */
export async function setupAppByApi(
  context: BrowserContext,
  instance: Instance,
  token: string,
  email: string,
): Promise<SetupApp> {
  const send = sender(context, instance, { 'x-setup-token': token });
  const { secret } = (await send('POST', 'setup/totp', { email })) as { secret: string };
  const { recovery_codes } = (await send('POST', 'setup/totp/verify', { code: totp(secret) })) as {
    recovery_codes: string[];
  };
  expect(recovery_codes, 'recovery codes of the setup').toHaveLength(10);
  return { secret, recoveryCodes: recovery_codes };
}

/**
 * Sets up `instance` with the Stalwart of the run: setup token,
 * administrator `admin` with an authenticator app, then OAuth client via DCR
 * with the Stalwart admin's app password, the mail server and system mails
 * through that account. The session cookie from `setup/complete` ends up in
 * `context` (shared cookie store of `context.request`).
 */
export async function setupByApi(
  context: BrowserContext,
  instance: Instance,
  stalwart: Stalwart,
  admin: AppUser,
): Promise<void> {
  const token = await instance.setupToken();
  const send = sender(context, instance, { 'x-setup-token': token });
  await send('POST', 'setup/token', { token });
  await setupAppByApi(context, instance, token, admin.email);
  await send('POST', 'setup/complete', {
    name: admin.name,
    email: admin.email,
    password: admin.password,
    settings: { lang: 'en', mode: 'system', accent: 'apricot' },
  });
  expect(await context.cookies(instance.url), 'session cookie after setup/complete').not.toEqual([]);
  await connectServer(context, instance, stalwart);
}

/** API calls with the cookies of `context`; errors name status and body. */
function sender(context: BrowserContext, instance: Instance, extra: Record<string, string> = {}) {
  return async (method: 'POST' | 'PUT', path: string, data: unknown): Promise<Record<string, unknown>> => {
    const res = await context.request.fetch(`${instance.url}/api/v1/${path}`, {
      method,
      data,
      headers: { ...CSRF, ...extra },
      failOnStatusCode: false,
    });
    // Error responses name codes and fields, no credentials.
    if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  };
}

/**
 * What the administrator does right after the setup, via the administration
 * API with the session of `context`: Administration › Mail servers with the
 * OAuth client via DCR and the domain of the admin address (without it, "Add
 * email account" assigns no server), then Administration › Email with the
 * Stalwart admin's account.
 */
export async function connectServer(context: BrowserContext, instance: Instance, stalwart: Stalwart): Promise<void> {
  const send = sender(context, instance);
  const registered = await send('POST', 'admin/servers/register-client', {
    url: stalwart.url,
    username: stalwart.admin.login,
    password: stalwart.admin.appPassword,
  });
  const server = await send('POST', 'admin/servers', {
    label: 'Stalwart',
    url: stalwart.url,
    client_id: registered.client_id,
    domains: [stalwart.domain],
  });
  const mail = await send('PUT', 'admin/system-mail', {
    server_id: server.id,
    user: stalwart.admin.email,
    app_password: stalwart.admin.appPassword,
  });
  // Saved even if the sign-in fails (`status: err` with `reason`).
  expect(mail.status, `system mail usable (reason: ${String(mail.reason)})`).toBe('ok');
}

/**
 * "Add email account" for `user` on the open page
 * `/account/mail-accounts/new`: Stalwart's sign-in and consent page (English,
 * not part of the app), return via `/oauth/callback` with the code exchange
 * in the backend; ends on the overview of the new account.
 */
export async function connectAccount(page: Page, stalwart: Stalwart, user: MailUser): Promise<void> {
  await page.getByLabel('Email address').fill(user.email);
  await page.getByRole('button', { name: 'Continue to sign-in' }).click();

  // The user is already filled into the form via `login_hint`.
  await page.waitForURL((url) => url.origin === stalwart.url);
  await page.locator('input[type="password"]').fill(user.password);
  await page.locator('input[type="password"]').press('Enter');
  await expect(page.getByRole('heading', { name: 'Authorize access' })).toBeVisible();
  await expect(page.getByText(/Read, send and manage your email/)).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page.getByText(`${user.email} is connected`)).toBeVisible();
  await expect(page).toHaveURL(/\/account\/mail-accounts\/[^/]+\/overview$/);
}

/**
 * Instance set up, administrator `admin` signed in and connected to the mail
 * account `user`: the starting point of the mail flows. Returns the page for
 * the following tests.
 */
export async function readyWithAccount(
  context: BrowserContext,
  instance: Instance,
  stalwart: Stalwart,
  admin: AppUser,
  user: MailUser,
): Promise<Page> {
  await setupByApi(context, instance, stalwart, admin);
  const page = await newPage(context);
  await page.goto(`${instance.url}/account/mail-accounts/new`);
  await settled(page);
  await connectAccount(page, stalwart, user);
  return page;
}
