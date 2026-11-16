// Sets up an instance for flows after the setup:
// the same calls as the six steps of the page (`#lib/setup.svelte.ts`) via the
// API, after which the administrator is signed in in the browser context.
// "Connect account", by contrast, still goes through the mail server's real
// sign-in page – only it hands out the code for it.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, type Instance, type MailUser, type Stalwart } from './fixtures.ts';
import { CSRF, newPage, settled } from './helpers.ts';

export interface AppUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Sets up `instance` with the Stalwart of the run: setup token, OAuth client
 * via DCR with the Stalwart admin's app password, system mails through that
 * account, administrator `admin`. The session cookie from `setup/complete`
 * ends up in `context` (shared cookie store of `context.request`).
 */
export async function setupByApi(
  context: BrowserContext,
  instance: Instance,
  stalwart: Stalwart,
  admin: AppUser,
): Promise<void> {
  const token = await instance.setupToken();
  const post = async (path: string, data: unknown): Promise<Record<string, unknown>> => {
    const res = await context.request.post(`${instance.url}/api/v1/${path}`, {
      data,
      headers: { ...CSRF, 'x-setup-token': token },
      failOnStatusCode: false,
    });
    // Error responses name codes and fields, no credentials.
    if (!res.ok()) throw new Error(`POST ${path}: ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  };

  await post('setup/token', { token });
  const registered = await post('setup/servers/register-client', {
    url: stalwart.url,
    username: stalwart.admin.login,
    password: stalwart.admin.appPassword,
    public_url: instance.url,
  });
  await post('setup/complete', {
    name: admin.name,
    email: admin.email,
    password: admin.password,
    // The page suggests the domain of the admin address; without it, "Add
    // email account" assigns no server.
    server: { url: stalwart.url, client_id: registered.client_id, domains: [stalwart.domain] },
    public_url: instance.url,
    system_mail: { user: stalwart.admin.email, app_password: stalwart.admin.appPassword },
  });
  expect(await context.cookies(instance.url), 'session cookie after setup/complete').not.toEqual([]);
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
