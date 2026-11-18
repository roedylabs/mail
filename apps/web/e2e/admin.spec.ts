// Administration: create, download and delete a backup (with undo), switch
// the banner on, dismiss it and see it again after a change, revoke an
// invitation (with undo, sent when leaving the page). Own instance
// without mail account (setup via API, setup.ts); the state in the backend is
// checked too, axe checks every visited page.
import { expect, test } from './fixtures.ts';
import {
  CSRF,
  apiGet,
  axeViolations,
  closeAll,
  need,
  openAs,
  password,
  settled,
  word,
  type Session,
} from './helpers.ts';
import { setupByApi } from './setup.ts';

test.describe.configure({ mode: 'serial' });

let session: Session | undefined;

test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

interface Backups {
  backups: { id: string; size: number; auto: boolean }[];
  auto: boolean;
}

interface Banner {
  on: boolean;
  title: string;
  revision: number;
}

test('setup via API', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  await setupByApi(context, instance, stalwart, {
    name: 'Alex Admin',
    email: stalwart.admin.email,
    password: password(),
  });
  // Without previous backups the scheduled backup is due right after the
  // setup, the job checks 60 s after the start: switch it off
  // right here so that only the backups of this flow are in the list.
  const schedule = await context.request.put(`${instance.url}/api/v1/admin/backups/schedule`, {
    data: { auto: false },
    headers: CSRF,
  });
  expect(schedule.status(), 'backup schedule').toBe(200);
  session = await context.storageState();
});

test('create and delete a backup', async ({ browser, instance }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/admin/maintenance`);
  const main = page.getByRole('main');
  await expect(main.getByText('No backups yet').first()).toBeVisible();
  // Without a schedule, frequency and retention are disabled (axe checks this state below).
  await expect(main.getByRole('switch', { name: 'Back up automatically' })).toHaveAttribute('aria-checked', 'false');
  await expect(main.getByRole('button', { name: 'Weekly' })).toBeDisabled();

  await main.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('Backup created', { exact: true })).toBeVisible();
  const { backups } = await apiGet<Backups>(page, 'admin/backups');
  expect(backups).toHaveLength(1);
  const backup = need(backups[0], 'backup');
  expect(backup.auto).toBe(false);
  await expect(main.getByText('Last backup just now')).toBeVisible();
  await expect(main.getByText('· Manual', { exact: false })).toBeVisible();
  expect(await axeViolations(page), 'axe: maintenance with backup').toEqual([]);

  // "Download" serves the file with the size from the list.
  const download = `/api/v1/admin/backups/${backup.id}/download`;
  await expect(main.getByRole('link', { name: 'Download' })).toHaveAttribute('href', download);
  const file = await page.request.get(`${instance.url}${download}`);
  expect(file.status()).toBe(200);
  expect((await file.body()).length).toBe(backup.size);

  // Deleted only after the toast: undo keeps it.
  const toast = page.getByRole('status').filter({ hasText: 'Backup deleted' });
  await main.getByRole('button', { name: 'Delete' }).click();
  await expect(toast).toBeVisible();
  await expect(main.getByText('No backups yet').first()).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(main.getByRole('link', { name: 'Download' })).toBeVisible();
  expect((await apiGet<Backups>(page, 'admin/backups')).backups.map((b) => b.id)).toEqual([backup.id]);

  await main.getByRole('button', { name: 'Delete' }).click();
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await apiGet<Backups>(page, 'admin/backups')).backups, 'backup deleted').toEqual([]);
  await page.reload();
  await settled(page);
  await expect(main.getByText('No backups', { exact: false }).first()).toBeVisible();
  await expect(main.getByRole('link', { name: 'Download' })).toHaveCount(0);
});

test('switch the banner on, dismiss it and see it again after a change', async ({ browser, instance }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/admin/banner`);
  const main = page.getByRole('main');
  const title = word('Maintenance');
  await main.getByRole('textbox', { name: 'Title' }).fill(title);
  await main
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('The app will be briefly unavailable from 6 pm today.');
  await expect(main.getByRole('figure', { name: 'Preview' })).toContainText(title);
  await main.getByRole('switch', { name: 'Show banner' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Turn on banner?' });
  await expect(confirm).toContainText('Your changes will be saved.');
  await confirm.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Banner active', { exact: true })).toBeVisible();
  const first = await apiGet<Banner>(page, 'admin/banner');
  expect(first).toMatchObject({ on: true, title });
  expect(await axeViolations(page), 'axe: banner').toEqual([]);

  // Notice bar on another page: dismissing applies to this revision, also after reloading.
  await page.goto(`${instance.url}/settings/general`);
  await settled(page);
  const notice = page.getByText(title, { exact: true });
  await expect(notice).toBeVisible();
  expect(await axeViolations(page), 'axe: page with banner').toEqual([]);
  await page.getByRole('button', { name: 'Close banner' }).click();
  await expect(notice).toBeHidden();
  await expect
    .poll(
      async () =>
        (await apiGet<{ settings: { bannerDismissedRev: number | null } }>(page, 'settings')).settings
          .bannerDismissedRev,
      'bannerDismissedRev',
    )
    .toBe(first.revision);
  await page.reload();
  await settled(page);
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  await expect(notice).toHaveCount(0);

  // A change increases the revision: the banner appears again.
  await page.goto(`${instance.url}/admin/banner`);
  await settled(page);
  await main.getByRole('textbox', { name: 'Text', exact: true }).fill('Postponed to tomorrow.');
  await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await apiGet<Banner>(page, 'admin/banner')).revision, 'new revision')
    .toBe(first.revision + 1);
  await page.goto(`${instance.url}/settings/general`);
  await settled(page);
  await expect(notice).toBeVisible();
  await expect(page.getByText('Postponed to tomorrow.', { exact: true })).toBeVisible();
});

test('revoke an invitation with undo, sent when leaving the page', async ({ browser, instance }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/admin/users`);
  const email = 'revoke@example.com';
  const created = await page.request.post(`${instance.url}/api/v1/invites`, {
    data: { emails: [email], role: 'user' },
    headers: CSRF,
  });
  expect(created.status(), 'invite').toBe(201);
  const invited = async () =>
    (await apiGet<{ users: { email: string; status: string }[] }>(page, 'users')).users.some(
      (u) => u.email === email && u.status === 'invited',
    );
  await page.reload();
  await settled(page);
  const main = page.getByRole('main');
  const revoke = async () => {
    await main.getByRole('button', { name: email }).filter({ visible: true }).click();
    await main.getByRole('button', { name: 'Revoke invitation' }).filter({ visible: true }).click();
    await page.getByRole('alertdialog', { name: 'Revoke invitation?' }).getByRole('button', { name: 'Revoke' }).click();
  };

  // Sent only after the toast: undo keeps the invitation.
  const toast = page.getByRole('status').filter({ hasText: 'Invitation revoked' });
  await revoke();
  await expect(toast).toBeVisible();
  await expect(main.getByText(email)).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(main.getByText(email).filter({ visible: true })).toBeVisible();
  expect(await invited(), 'still invited after undo').toBe(true);

  // Leaving the page sends it right away and closes the toast, well before its 5 s run out.
  await revoke();
  await expect(toast).toBeVisible();
  await page.getByRole('link', { name: 'Maintenance' }).filter({ visible: true }).click();
  await expect(toast).toBeHidden({ timeout: 1_500 });
  await expect.poll(invited, { message: 'invitation revoked', timeout: 2_000 }).toBe(false);
  await expect(page.getByRole('heading', { name: 'Maintenance', level: 1 })).toBeVisible();
});
