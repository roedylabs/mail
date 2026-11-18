// Everyday mail: send and receive, HTML mail with blocked images, reply
// quoting a long HTML mail, rejected recipient. The API sets up the instance
// (setup.ts), the sign-in page connects the Stalwart user's account; test data
// comes via JMAP, every test has its own subjects and only depends on the
// session from the first one.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  axeViolations,
  closeAll,
  erika,
  eventually,
  findMails,
  mailboxId,
  need,
  openAs,
  openRow,
  password,
  putMail,
  row,
  waitForMails,
  word,
  type Session,
} from './helpers.ts';
import { readyWithAccount } from './setup.ts';

test.describe.configure({ mode: 'serial' });

let session: Session | undefined;

test.afterEach(async ({ browser }) => {
  expect(await closeAll(browser), 'app errors').toEqual([]);
});

/** 1 × 1 pixel PNG as the response for images from external servers. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Sidebar folder (tab "Mailboxes"). */
function folder(page: Page, name: string | RegExp) {
  return page.getByRole('navigation').getByRole('button', { name });
}

/** Fills in "New email" with recipients, subject and text and sends it. */
async function send(page: Page, to: string[], subject: string, text: string): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: 'New email' }).click();
  await expect(page.getByRole('heading', { name: 'New email', level: 1 })).toBeVisible();
  const field = page.getByRole('combobox', { name: 'To' });
  for (const address of to) {
    await field.fill(address);
    await field.press('Enter');
  }
  await page.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  expect(await axeViolations(page), 'axe: compose').toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('setup via API and connect account', async ({ browser, instance, stalwart }) => {
  const context = await browser.newContext();
  const admin = { name: 'Alex Admin', email: stalwart.admin.email, password: password() };
  await readyWithAccount(context, instance, stalwart, admin, stalwart.user);
  session = await context.storageState();
});

test('send and receive', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const subject = word('Greeting');
  const text = `Hello Alex, ${word('content')}`;
  // To the admin and to oneself: delivery to the outside and back into the own mailbox.
  await send(page, [stalwart.admin.email, stalwart.user.email], subject, text);
  await expect(page.getByText('Message sent', { exact: true })).toBeVisible();

  // Stalwart delivers after HOLDFOR (toast + 5 s).
  const [received] = await waitForMails(stalwart, stalwart.admin, subject, 1);
  expect(received?.from).toEqual([stalwart.user.email]);
  expect(received?.text).toContain(text);

  // It appears in the inbox without reloading (push) and opens.
  await folder(page, /^Inbox/).click();
  await openRow(page, subject);
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
  await expect(page.getByRole('article').getByText(text).first()).toBeVisible();
  expect(await axeViolations(page), 'axe: reading view').toEqual([]);

  // It is in "Sent" too.
  await folder(page, 'Sent').click();
  await expect(row(page, subject)).toBeVisible();
});

test('HTML mail with blocked images', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const loaded: string[] = [];
  await page.context().route('https://images.sample.test/**', async (route) => {
    loaded.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
  const subject = word('Image');
  await putMail(stalwart, stalwart.user, {
    from: erika,
    subject,
    html:
      '<p>Hello <b>Kim</b>,</p><p>attached is the logo:</p>' +
      '<p><img src="https://images.sample.test/logo.png" alt="Logo" width="40" height="40"></p>' +
      '<img src="https://images.sample.test/pixel.gif" alt="" width="1" height="1">',
  });

  await openRow(page, subject);
  const article = page.getByRole('article');
  const body = article.frameLocator('iframe');
  await expect(body.getByText('attached is the logo:')).toBeVisible();
  const notice = article.getByRole('status');
  await expect(notice).toContainText('External content blocked.');
  await expect(notice).toContainText('2 images and tracking pixels from external servers weren’t loaded.');
  expect(loaded, 'images before consent').toEqual([]);
  expect(await axeViolations(page), 'axe: external content blocked').toEqual([]);

  await notice.getByRole('button', { name: 'Load once' }).click();
  await expect(notice).toHaveCount(0);
  await expect(body.getByRole('img', { name: 'Logo' })).toHaveJSProperty('naturalWidth', 1);
  // The tracking pixel may come after the logo, a re-render may load an image twice.
  await expect.poll(() => [...new Set(loaded)].sort()).toEqual(['/logo.png', '/pixel.gif']);
});

test('reply quoting a long HTML mail', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const subject = word('Report');
  const first = word('Start');
  const last = word('End');
  const messageId = `${word('long')}@sample.test`;
  // About 200 KB of HTML: far above the limit for `keepalive` (48 KiB).
  const paragraphs = Array.from(
    { length: 1500 },
    (_, i) => `<p>Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.</p>`,
  );
  await putMail(stalwart, stalwart.user, {
    from: { name: stalwart.admin.name, email: stalwart.admin.email },
    subject,
    html: `<html><body><h1>${first}</h1>${paragraphs.join('\n')}<p>${last}</p></body></html>`,
    messageId,
  });

  await openRow(page, subject);
  await expect(page.getByRole('article').frameLocator('iframe').getByText(last)).toBeAttached();
  await page.getByRole('article').getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = `Thanks, ${word('reply')}`;
  await page.getByPlaceholder(/^Reply to /).fill(reply);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Reply sent', { exact: true })).toBeVisible();
  // Right away, before the sync, the reply stands in the conversation and the reading view is at its end.
  await expect(page.getByRole('article').getByText(reply).first()).toBeVisible();
  await expect.poll(() => scrollGap(page)).toBeLessThan(2);

  // From compose ("Open in editor") the reading view is at the end again on return.
  await page.locator('.rd .scroll').evaluate((el) => (el.scrollTop = 0));
  await page.getByRole('article').getByRole('button', { name: 'Reply', exact: true }).first().click();
  await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
  const second = `Also, ${word('reply')}`;
  await page.getByPlaceholder('Write a message …').fill(second);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await expect(page.getByRole('article').getByText(second).first()).toBeVisible();
  await expect.poll(() => scrollGap(page)).toBeLessThan(2);

  // At the admin: text, header line and the whole original as a "> " quote, in the same thread.
  const answers = await waitForMails(stalwart, stalwart.admin, `Re: ${subject}`, 2);
  const answer = answers.find((a) => a.text.startsWith(reply));
  const lines = need(answer, 'reply').text.split(/\r?\n/);
  expect(lines[0]).toBe(reply);
  expect(lines.some((line) => /^On .+, .+ wrote:$/.test(line))).toBe(true);
  expect(lines).toContain(`> ${first}`);
  expect(lines.filter((line) => /^> Paragraph \d+:/.test(line))).toHaveLength(paragraphs.length);
  expect(lines).toContain(`> ${last}`);
  expect(answer?.inReplyTo).toEqual([messageId]);
  expect(answer?.references).toContain(messageId);
});

/** Distance of the reading view's scroll area from its end. */
function scrollGap(page: Page): Promise<number> {
  return page.locator('.rd .scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test('rejected recipient', async ({ browser, instance, stalwart }) => {
  const page = await openAs(browser, need(session, 'session'), `${instance.url}/start`);
  const subject = word('Rejected');
  // Stalwart v1.0.2 already rejects `.invalid` when creating the submission.
  const nobody = 'nobody@example.invalid';
  await send(page, [nobody], subject, 'This message never arrives.');
  await expect(page.getByText('The message wasn’t sent. Please try again.', { exact: true })).toBeVisible();

  // Compose reopens with the saved state.
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(subject);
  await expect(page.getByRole('main').getByText(nobody)).toBeVisible();
  // Exactly one draft; saving in two steps briefly showed two.
  const drafts = await mailboxId(stalwart, stalwart.user, 'drafts');
  await eventually(async () => {
    const found = await findMails(stalwart, stalwart.user, { subject });
    return found.length === 1 && found[0]!.keywords.includes('$draft') && found[0]!.mailboxIds.join() === drafts;
  }, `one draft "${subject}" in drafts`);
});
