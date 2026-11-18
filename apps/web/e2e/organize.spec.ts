// Organizing and finding: create a folder and delete it with content, create,
// set and delete a tag, empty the trash, search (on mobile too). Own instance like
// mail.spec.ts (setup via API, setup.ts); what ends up in Stalwart afterwards
// is checked too.
import { devices, type Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  axeViolations,
  closeAll,
  erika,
  eventually,
  findMails,
  mailboxId,
  mailboxes,
  need,
  newPage,
  openAs,
  openRow,
  password,
  putMail,
  row,
  settled,
  word,
  type Mailbox,
  type Session,
} from './helpers.ts';
import { readyWithAccount } from './setup.ts';

test.describe.configure({ mode: 'serial' });

let session: Session | undefined;

test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

function sidebar(page: Page) {
  return page.getByRole('navigation');
}

/** Folder or tag in the sidebar: the button with the name as text (next to it the icon with `aria-label`). */
function entry(page: Page, name: string) {
  return sidebar(page).getByRole('button').filter({ hasText: name });
}

test('setup via API and connect account', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  const admin = { name: 'Alex Admin', email: stalwart.admin.email, password: password() };
  await readyWithAccount(context, instance, stalwart, admin, stalwart.user);
  session = await context.storageState();
});

test('create a folder and delete it with content', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const name = word('Project');
  await sidebar(page).getByRole('tab', { name: 'Folders' }).click();
  await sidebar(page).getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(`Folder “${name}” created`)).toBeVisible();

  let id: string | undefined;
  await eventually(async () => {
    id = (await mailboxes(stalwart, stalwart.user)).find((m) => m.name === name)?.id;
    return id !== undefined;
  }, `folder ${name} in Stalwart`);
  const subject = word('File');
  const mail = await putMail(stalwart, stalwart.user, {
    from: erika,
    subject,
    text: 'Filed.',
    mailboxId: need(id, 'folder'),
  });

  await entry(page, name).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(row(page, subject)).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Delete folder' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete folder “${name}”?` });
  await expect(confirm).toContainText('The message in it will be moved to Trash.');
  expect(await axeViolations(page), 'axe: delete folder?').toEqual([]);
  await confirm.getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.getByText(`Folder “${name}” deleted`)).toBeVisible();

  // Folder gone, the email from it in the trash.
  const trash = await mailboxId(stalwart, stalwart.user, 'trash');
  await eventually(
    async () => !(await mailboxes(stalwart, stalwart.user)).some((m) => m.name === name),
    `folder ${name} deleted`,
  );
  const [moved] = await findMails(stalwart, stalwart.user, { subject });
  expect(moved?.id).toBe(mail);
  expect(moved?.mailboxIds).toEqual([trash]);
});

test('create, set and delete a tag', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const tag = word('Invoice');
  await sidebar(page).getByRole('tab', { name: 'Tags' }).click();
  await sidebar(page).getByRole('button', { name: 'New tag' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(tag);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(`Tag “${tag}” created`)).toBeVisible();

  const subject = word('Receipt');
  await putMail(stalwart, stalwart.user, { from: erika, subject, text: 'Please file.' });
  await sidebar(page).getByRole('tab', { name: 'Mailboxes' }).click();
  await sidebar(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await openRow(page, subject);
  await page.getByRole('toolbar', { name: 'Message' }).getByRole('button', { name: 'Add tag' }).click();
  await page.getByRole('menu', { name: 'Add tag' }).getByRole('menuitemcheckbox', { name: tag }).click();

  // In Stalwart the tag is a mailbox below "Tags" that is created when first
  // set; the email is then in the inbox and the tag.
  const inbox = await mailboxId(stalwart, stalwart.user, 'inbox');
  const placesOf = async () => (await findMails(stalwart, stalwart.user, { subject }))[0]?.mailboxIds.sort() ?? [];
  let box: Mailbox | undefined;
  await eventually(async () => {
    const all = await mailboxes(stalwart, stalwart.user);
    const root = all.find((m) => m.name === 'Tags' && m.parentId === null);
    box = all.find((m) => m.name === tag && m.parentId === root?.id);
    return box !== undefined && (await placesOf()).includes(box.id);
  }, `mailbox of tag ${tag} on the email`);
  const tagBox = need(box, 'mailbox of the tag');
  expect(await placesOf()).toEqual([inbox, tagBox.id].sort());

  await sidebar(page).getByRole('tab', { name: 'Tags' }).click();
  await entry(page, tag).click();
  await expect(row(page, subject)).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Delete tag' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete tag “${tag}”?` });
  await expect(confirm).toContainText('The tag will be removed from one message.');
  await confirm.getByRole('button', { name: 'Delete tag' }).click();
  await expect(page.getByText(`Tag “${tag}” deleted`)).toBeVisible();
  // After the toast: mailbox gone, the email only loses the tag.
  await eventually(
    async () => !(await mailboxes(stalwart, stalwart.user)).some((m) => m.id === tagBox.id),
    `mailbox of tag ${tag} deleted`,
  );
  expect(await placesOf()).toEqual([inbox]);
});

test('empty the trash', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const trash = await mailboxId(stalwart, stalwart.user, 'trash');
  const kept = word('Old');
  const gone = word('Gone');
  await putMail(stalwart, stalwart.user, { from: erika, subject: kept, text: 'Already deleted.', mailboxId: trash });
  await putMail(stalwart, stalwart.user, { from: erika, subject: gone, text: 'Deleted soon.' });

  await openRow(page, gone);
  await page.getByRole('toolbar', { name: 'Message' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Moved to Trash', { exact: true })).toBeVisible();

  await sidebar(page)
    .getByRole('button', { name: /^Trash/ })
    .click();
  await expect(row(page, kept)).toBeVisible();
  await expect(row(page, gone)).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Empty Trash' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Empty Trash?' });
  await expect(confirm).toContainText('This can’t be undone.');
  await confirm.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText(/^\d+ messages deleted$/)).toBeVisible();
  await expect(page.getByText('Trash is empty', { exact: true })).toBeVisible();

  await eventually(
    async () => (await findMails(stalwart, stalwart.user, { inMailbox: trash })).length === 0,
    'trash in Stalwart empty',
  );
  expect(await findMails(stalwart, stalwart.user, { subject: gone })).toEqual([]);
});

test('search in the text', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const term = word('keyword');
  const subject = word('Match');
  await putMail(stalwart, stalwart.user, { from: erika, subject, text: `The word ${term} is only in the text.` });
  await putMail(stalwart, stalwart.user, { from: erika, subject: word('Elsewhere'), text: 'It is not here.' });
  // Stalwart indexes new emails after about 1 s.
  await eventually(
    async () => (await findMails(stalwart, stalwart.user, { text: term })).length === 1,
    `index with ${term}`,
  );

  const search = page.getByRole('combobox', { name: 'Search' });
  await search.fill(term);
  await search.press('Enter');
  await expect(page.getByText('Search results').first()).toBeVisible();
  await expect(row(page, subject)).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /Elsewhere/ })).toHaveCount(0);
  expect(await axeViolations(page), 'axe: search results').toEqual([]);
  await row(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
  await expect(page.getByRole('article').getByText(term)).toBeVisible();
});

test('mobile search: a vertical drag closes the keyboard', async ({ browser, instance }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], storageState: need(session, 'session') });
  const page = await newPage(context);
  await page.goto(`${instance.url}/search`);
  await settled(page);
  const field = page.getByRole('textbox', { name: 'Search' });
  // Opening the search focuses the field, the keyboard opens.
  await expect(field).toBeFocused();

  // Touch drag in steps of 2 px, as a finger sends it (`Input.dispatchTouchEvent`).
  const cdp = await context.newCDPSession(page);
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    const steps = Math.max(Math.abs(dx), Math.abs(dy)) / 2;
    for (let i = 1; i <= steps; i++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }],
      });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const at = async (text: string) => {
    const box = await page.getByText(text, { exact: true }).boundingBox();
    if (!box) throw new Error(`${text} not visible`);
    return [box.x + box.width / 2, box.y + box.height / 2] as const;
  };

  // Horizontal: no effect on the focus.
  const [qx, qy] = await at('Quick access');
  await drag(qx, qy, -40, 0);
  await expect(field).toBeFocused();
  // Vertical in "Quick access": the field loses the focus.
  await drag(qx, qy, 0, -40);
  await expect(field).not.toBeFocused();
});
