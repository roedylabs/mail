import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailPreviewData } from '#lib/mail-preview.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type { SystemMail } from '#lib/system-mail.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
const sections = vi.hoisted(() => ({ scrollToSection: vi.fn() }));
vi.mock('#lib/sections.ts', () => sections);

const ME: Me = {
  id: 'u0',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-20T10:00:00Z',
  email_change: null,
  system_mail_configured: true,
};

const SERVERS = {
  servers: [
    { id: 's1', label: 'VPS 1', url: 'https://mail.s1.test/', domains: ['s1.test'] },
    { id: 's2', label: 'VPS 2', url: 'https://mail.s2.test', domains: [] },
  ],
};

/** Checked sending account, last two hours ago. */
function mail(patch: Partial<SystemMail> = {}): SystemMail {
  return {
    server_id: 's1',
    auth: 'password',
    user: 'noreply@example.com',
    has_secret: true,
    identity_id: 'i1',
    sender_name: null,
    reply_to: null,
    keep_sent: true,
    status: 'ok',
    reason: null,
    checked_at: new Date(Date.now() - 2 * 3600_000 - 60_000).toISOString(),
    identities: [{ id: 'i1', name: 'Example Ltd', email: 'noreply@example.com' }],
    ...patch,
  };
}

/** Preview of the "Invitation" template (`GET admin/system-mail/preview`). */
const PREVIEW: MailPreviewData = {
  subject: 'Invitation to Roedy Mail',
  from: 'Example Ltd <system@example.com>',
  to: 'jamie.smith@example.com',
  body: '<!doctype html><html><head><title>Invitation</title></head><body><p>Hello Jamie</p></body></html>',
};

/** Path of the preview with template and variant; without one the first view (invitation, HTML, light). */
const previewKey = (query = 'template=invite&format=html&theme=light') =>
  `GET admin/system-mail/preview?${query}&lang=en`;

/** Responses of the preview; the page loads it after the account and again when account or identities change. */
const previews = (body: MailPreviewData = PREVIEW, n = 4) => Array.from({ length: n }, () => ({ body }));

// jsdom knows no `blob:` addresses; TemplateFrame creates the preview document as a blob.
Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:preview' });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });

const NONE: SystemMail = {
  server_id: null,
  auth: 'password',
  user: '',
  has_secret: false,
  identity_id: null,
  sender_name: null,
  reply_to: null,
  keep_sent: true,
  status: 'none',
  reason: null,
  checked_at: null,
  identities: [],
};

beforeEach(() => {
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  sections.scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  session.user = null;
  window.dispatchEvent(new Event('resize'));
});

function renderPage(view: SystemMail, routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET admin/system-mail': [{ body: view }],
    'GET admin/servers': [{ body: SERVERS }],
    [previewKey()]: previews(),
    ...routes,
  });
  return { ...render(Page), ...api };
}

const heading2 = (name: string) => screen.getByRole('heading', { level: 2, name });
const status = () => heading2('Status').parentElement as HTMLElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' });
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const hint = 'Available after a successful connection test.';
const templates = () => heading2('Templates').closest('section') as HTMLElement;

describe('Administration › Email page', () => {
  it('shows heading, description and the skeleton until the first response, without tabs', async () => {
    mockApi({ 'GET admin/system-mail': [() => new Promise(() => {})], 'GET admin/servers': [{ body: SERVERS }] });
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Email');
    expect(view.getByText('Sending system emails via JMAP.')).toBeInTheDocument();
    expect(view.queryByText('Loading data …')).toBeNull();
    expect(await view.findByText('Loading data …')).toBeInTheDocument();
    expect(view.queryByRole('button')).toBeNull();
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows "Connected" with session, account and "Last checked" and the fields', async () => {
    const view = renderPage(mail({ reply_to: 'support@example.com' }));
    expect(await view.findByText('Connected')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Templates' })).toBeInTheDocument();
    for (const title of ['Status', 'Connection', 'Sender', 'Delivery', 'Test email', 'Templates']) {
      expect(heading2(title)).toBeInTheDocument();
    }
    expect(within(status()).getByText('JMAP session with mail.s1.test is active.')).toBeInTheDocument();
    expect(status().querySelector('.status')).toHaveClass('st-ok');
    expect(within(status()).getByText('Session').nextElementSibling).toHaveTextContent(
      'https://mail.s1.test/jmap/session',
    );
    expect(within(status()).getByText('Account').nextElementSibling).toHaveTextContent('noreply@example.com');
    expect(within(status()).getByText('Last checked').nextElementSibling).toHaveTextContent('2 hours ago');

    // Name from the row label and the visible value (WCAG 2.5.3).
    expect(view.getByRole('combobox', { name: 'Mail server VPS 1' })).toHaveTextContent('VPS 1');
    expect(view.getByText('JMAP session via mail.s1.test')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Password' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('textbox', { name: 'Username' })).toHaveValue('noreply@example.com');
    const secret = view.getByLabelText('Password');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('placeholder', '••••••••');
    expect(view.getByRole('textbox', { name: 'Sender name' })).toHaveAttribute('placeholder', 'Example Ltd');
    expect(view.getByRole('textbox', { name: 'Reply-to address' })).toHaveValue('support@example.com');
    expect(view.getByText('Example Ltd <noreply@example.com>')).toBeInTheDocument();
    expect(view.getByRole('switch', { name: 'Save a copy to Sent' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByRole('textbox', { name: 'Recipient' })).toHaveValue('jane@example.com');
    expect(sendButton()).toHaveAttribute('aria-disabled', 'false');
    expect(view.queryByText(hint)).toBeNull();
    expect(bar()).toBeNull();

    // "Show" shows the entered password.
    await fireEvent.click(view.getByRole('button', { name: 'Show' }));
    expect(view.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  it('shows "Not set up" without an account and locks "Send" with a notice', async () => {
    const view = renderPage(NONE);
    expect(await view.findByText('Not set up')).toBeInTheDocument();
    expect(view.queryByText('Session')).toBeNull();
    expect(view.queryByText('Account')).toBeNull();
    expect(view.getByRole('combobox', { name: 'Mail server Choose server' })).toHaveTextContent('Choose server');
    expect(view.getByText('The sending account’s server from the server list')).toBeInTheDocument();
    expect(view.getByLabelText('Password')).toHaveAttribute('placeholder', '');
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    expect(sendButton()).not.toHaveClass('on');
    expect(view.getByText(hint)).toBeInTheDocument();
    await fireEvent.click(sendButton());
    expect(view.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('silently checks an unchecked account after loading', async () => {
    const view = renderPage(mail({ status: 'unchecked', checked_at: null }), {
      'POST admin/system-mail/test': [{ body: { identities: mail().identities } }],
    });
    expect(await view.findByText('Connected')).toBeInTheDocument();
    expect(view.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['admin/system-mail/test', { server_id: 's1', auth: 'password', user: 'noreply@example.com' }],
    ]);
    expect(ui.toast).toBeNull();
    expect(sendButton()).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows "Checking …" during the silent check, "Not checked" without a response', async () => {
    const view = renderPage(mail({ status: 'unchecked', checked_at: null }));
    expect(await view.findByText('Checking …')).toBeInTheDocument();
    expect(await within(status()).findByText('Not checked')).toBeInTheDocument();
    expect(
      within(status()).getByText('The sending account is saved but not checked yet. Test the connection.'),
    ).toBeInTheDocument();
    expect(status().querySelector('.status')).toHaveClass('st-unchecked');
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    expect(ui.toast).toBeNull();
  });

  it('shows "No connection" with the reason and reports a failed test', async () => {
    const view = renderPage(mail({ status: 'err', reason: 'auth_failed' }), {
      'POST admin/system-mail/test': [{ status: 422, body: { error: 'mail_failed', reason: 'unreachable' } }],
    });
    expect(await view.findByText('No connection')).toBeInTheDocument();
    expect(within(status()).getByText('Sign-in failed. The username or password is incorrect.')).toBeInTheDocument();
    expect(status().querySelector('.status')).toHaveClass('st-err');
    expect(view.queryByText('Session')).toBeNull();
    expect(view.getByText(hint)).toBeInTheDocument();

    const test = view.getByRole('button', { name: 'Test connection' });
    expect(test).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(test);
    expect(view.getByRole('button', { name: 'Checking' })).toHaveAttribute('aria-disabled', 'true');
    expect(view.getByText('Checking …')).toBeInTheDocument();
    expect(await within(status()).findByText('Can’t reach the server. Check the address.')).toBeInTheDocument();
    expect(ui.toast).toMatchObject({ text: 'Connection failed', error: true });
  });

  it('names the reason in the toast when sending; if only the mail fails, "Connected" stays', async () => {
    const view = renderPage(mail(), {
      'POST admin/system-mail/test': [
        { status: 502, body: { error: 'mail_failed', reason: 'not_created' } },
        { status: 502, body: { error: 'mail_failed', reason: 'no_identity' } },
      ],
    });
    expect(await view.findByText('Connected')).toBeInTheDocument();
    await fireEvent.click(sendButton());
    await vi.waitFor(() =>
      expect(ui.toast).toMatchObject({
        error: true,
        text: 'The test email to jane@example.com wasn’t sent. Please try again.',
      }),
    );
    expect(within(status()).getByText('Connected')).toBeInTheDocument();
    await fireEvent.click(sendButton());
    const reason = 'The account has no identity for sending. Create an identity for this account in Stalwart.';
    expect(await within(status()).findByText(reason)).toBeInTheDocument();
    expect(ui.toast).toMatchObject({ error: true, text: reason });
  });

  it('shows no username and the "Access token" field in token mode', async () => {
    const view = renderPage(mail({ auth: 'token', user: '' }));
    expect(await view.findByText('Connected')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Token' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.queryByRole('textbox', { name: 'Username' })).toBeNull();
    expect(view.getByLabelText('Access token')).toHaveAttribute('autocomplete', 'off');
    expect(view.getByText('The sending account’s bearer token')).toBeInTheDocument();
    expect(within(status()).getByText('Account').nextElementSibling).toHaveTextContent('Via access token');
  });

  it('switches the sign-in, shows "Not checked" and the bar and discards', async () => {
    const view = renderPage(mail());
    expect(await view.findByText('Connected')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Token' }));
    expect(view.getByText('Not checked')).toBeInTheDocument();
    expect(view.queryByRole('textbox', { name: 'Username' })).toBeNull();
    expect(view.getByLabelText('Access token')).toHaveAttribute('placeholder', '');
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    const region = bar() as HTMLElement;
    expect(within(region).getByText('Unsaved changes')).toBeInTheDocument();
    await fireEvent.click(within(region).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(view.getByText('Connected')).toBeInTheDocument();
  });

  it('shows the bar after an input and the sender preview', async () => {
    const view = renderPage(mail());
    expect(await view.findByText('Connected')).toBeInTheDocument();
    await fireEvent.input(view.getByRole('textbox', { name: 'Sender name' }), {
      target: { value: 'Roedy Mail' },
    });
    expect(view.getByText('Roedy Mail <noreply@example.com>')).toBeInTheDocument();
    expect(bar()).not.toBeNull();
    // Senders do not change the connection: still "Connected".
    expect(view.getByText('Connected')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('switch', { name: 'Save a copy to Sent' }));
    expect(view.getByRole('switch', { name: 'Save a copy to Sent' })).toHaveAttribute('aria-checked', 'false');
  });

  it('selects the mail server in the popover', async () => {
    const view = renderPage(mail());
    expect(await view.findByText('Connected')).toBeInTheDocument();
    const button = view.getByRole('combobox', { name: 'Mail server VPS 1' });
    await fireEvent.click(button);
    expect(ui.menu).toBe('pick');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const list = view.getByRole('listbox', { name: 'Mail server' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['VPS 1 mail.s1.test', 'VPS 2 mail.s2.test']);
    await fireEvent.click(within(list).getByRole('option', { name: /VPS 2/ }));
    expect(view.queryByRole('listbox')).toBeNull();
    expect(button).toHaveTextContent('VPS 2');
    expect(view.getByText('Not checked')).toBeInTheDocument();
    expect(bar()).not.toBeNull();
  });

  it('scrolls to the section via the tabs and leads to the mail servers', async () => {
    const view = renderPage(mail());
    expect(await view.findByText('Connected')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Sender' }));
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('sender');
    expect(animate).toBe(true);
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual([
      'status',
      'conn',
      'sender',
      'delivery',
      'test',
      'tpl',
    ]);
    await fireEvent.click(view.getByRole('button', { name: 'Manage mail servers' }));
    expect(nav.goto).toHaveBeenCalledWith('/admin/mail-servers');
  });

  it('shows send below the field and the selection in the sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage(NONE);
    expect(ui.isMobile).toBe(true);
    expect(await view.findByText('Not set up')).toBeInTheDocument();
    expect(view.getByText(hint)).toBeInTheDocument();
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Mail server Choose server' }));
    expect(ui.menu).toBe('pick');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(ui.pick?.().title).toBe('Mail server');
    expect(ui.pick?.().opts.map((o) => o.label)).toEqual(['VPS 1', 'VPS 2']);
  });

  it('shows the card instead of tabs and sections when the first load fails, and reloads', async () => {
    const view = renderPage(mail(), {
      'GET admin/system-mail': [{ status: 500, body: { error: 'internal' } }, { body: mail() }],
      'GET admin/servers': [{ body: SERVERS }, { body: SERVERS }],
    });
    const card = await view.findByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load the email settings');
    expect(card).toHaveTextContent('That didn’t work. Please try again.');
    expect(view.queryByRole('button', { name: 'Connection' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Connected')).toBeInTheDocument();
  });
});

describe('Administration › Email › Templates page', () => {
  it('loads the invitation as HTML and shows header and iframe', async () => {
    const view = renderPage(mail());
    const frame = await view.findByTitle('Invitation to Roedy Mail');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'blob:preview');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(view.calls.filter((c) => c.path.startsWith('admin/system-mail/preview')).map((c) => c.path)).toEqual([
      'admin/system-mail/preview?template=invite&format=html&theme=light&lang=en',
    ]);

    const sec = templates();
    expect(
      within(sec).getByText(
        'This is how system emails reach recipients. Name, logo, and brand color come from Branding, the footer from the organization details.',
      ),
    ).toBeInTheDocument();
    const tabs = within(sec).getByRole('tablist', { name: 'Templates' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => [t.textContent, t.getAttribute('aria-selected')]),
    ).toEqual([
      ['Invitation', 'true'],
      ['Reset password', 'false'],
      ['Confirm email address', 'false'],
      ['Security notice', 'false'],
      ['Notification digest', 'false'],
      ['System notice', 'false'],
      ['Test email', 'false'],
    ]);
    expect(within(sec).queryByRole('group', { name: 'Variant' })).toBeNull();
    expect(within(sec).queryByRole('combobox', { name: /^Variant / })).toBeNull();
    expect(within(sec).getByText('From').nextElementSibling).toHaveTextContent('Example Ltd <system@example.com>');
    expect(within(sec).getByText('To').nextElementSibling).toHaveTextContent('jamie.smith@example.com');
    expect(within(sec).getByText('Subject').nextElementSibling).toHaveTextContent('Invitation to Roedy Mail');
    expect(within(sec).getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sec).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sec).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(sec.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    expect(sec.querySelector('.tpl-frame')).not.toHaveClass('text');
    expect(sec.querySelector('.tpl-frame')).not.toHaveClass('dark');
    expect(sec.querySelector('.tpl-frame')).not.toHaveClass('dim');
    expect(within(sec).queryByText('Loading preview …')).toBeNull();
    expect(sec.querySelector('.tpl-empty')).toBeNull();
  });

  it('shows header without values, empty frame and pill on the first load', async () => {
    let release = () => {};
    const reply = () =>
      new Promise<{ body: MailPreviewData }>((resolve) => {
        release = () => resolve({ body: PREVIEW });
      });
    const view = renderPage(mail(), { [previewKey()]: [reply] });
    const pill = await view.findByText('Loading preview …');
    const box = templates().querySelector('.tpl-box') as HTMLElement;
    expect(box).toHaveAttribute('aria-busy', 'true');
    expect(within(box).getByText('From').nextElementSibling).toBeNull();
    expect(within(box).getByText('Subject').nextElementSibling).toBeNull();
    expect(box.querySelector('.tpl-empty')).toBeInTheDocument();
    expect(box.querySelector('.tpl-frame')).toBeNull();
    expect(pill).toBeInTheDocument();
    release();
    expect(await view.findByTitle('Invitation to Roedy Mail')).toBeInTheDocument();
    expect(box).toHaveAttribute('aria-busy', 'false');
    expect(within(templates()).queryByText('Loading preview …')).toBeNull();
  });

  it('dims the previous preview on a switch, the choice applies at once', async () => {
    let release = () => {};
    const reply = () =>
      new Promise<{ body: MailPreviewData }>((resolve) => {
        release = () => resolve({ body: { ...PREVIEW, subject: 'Password' } });
      });
    const view = renderPage(mail(), { [previewKey('template=reset&format=html&theme=light')]: [reply] });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('tab', { name: 'Reset password' }));
    expect(within(templates()).getByRole('tab', { name: 'Reset password' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByTitle('Invitation to Roedy Mail')).toBeInTheDocument();
    expect(templates().querySelector('.tpl-frame')).toHaveClass('dim');
    expect(templates().querySelector('.tpl-box')).toHaveAttribute('aria-busy', 'true');
    expect(within(templates()).getByText('Loading preview …')).toBeInTheDocument();
    release();
    expect(await view.findByTitle('Password')).toBeInTheDocument();
    expect(templates().querySelector('.tpl-frame')).not.toHaveClass('dim');
  });

  it('shows "From" without sender as a muted notice', async () => {
    const view = renderPage(mail(), { [previewKey()]: previews({ ...PREVIEW, from: null }) });
    await view.findByTitle('Invitation to Roedy Mail');
    const hintRow = within(templates()).getByText('No sender yet – available after a successful connection test');
    expect(hintRow.closest('.tpl-v')).toHaveClass('from-none');
    expect(hintRow.closest('.tpl-v')?.querySelector('svg')).toBeInTheDocument();
  });

  it('shows the test email as a template of its own without variants', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=test&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'Test-E-Mail of Roedy Mail', to: 'jane@example.com' } },
      ],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('tab', { name: 'Test email' }));
    expect(await view.findByTitle('Test-E-Mail of Roedy Mail')).toBeInTheDocument();
    expect(within(templates()).getByText('To').nextElementSibling).toHaveTextContent('jane@example.com');
    expect(within(templates()).queryByRole('group', { name: 'Variant' })).toBeNull();
    expect(within(templates()).queryByRole('combobox', { name: /^Variant / })).toBeNull();
  });

  it('loads in the dark theme and colours the frame accordingly', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=invite&format=html&theme=dark')]: [{ body: PREVIEW }],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('button', { name: 'Dark' }));
    expect(within(templates()).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    await vi.waitFor(() => expect(templates().querySelector('.tpl-frame')).toHaveClass('dark'));
    expect(view.calls.at(-1)?.path).toBe('admin/system-mail/preview?template=invite&format=html&theme=dark&lang=en');
  });

  it('reloads the preview in the new language after a language switch', async () => {
    const view = renderPage(mail(), {
      'GET admin/system-mail/preview?template=invite&format=html&theme=light&lang=de': [
        { body: { ...PREVIEW, subject: 'Invitation to Roedy Mail (translated)' } },
      ],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    prefs.values.lang = 'de';
    await vi.waitFor(() =>
      expect(view.calls.at(-1)?.path).toBe('admin/system-mail/preview?template=invite&format=html&theme=light&lang=de'),
    );
    expect(await view.findByTitle('Invitation to Roedy Mail (translated)')).toBeInTheDocument();
  });

  it('switches to text, shows the text and no light/dark', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=invite&format=text')]: [
        { body: { ...PREVIEW, body: 'Hello Jamie, you have been invited.' } },
      ],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('button', { name: 'Text' }));
    expect(within(templates()).getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(templates()).queryByRole('button', { name: 'Light' })).toBeNull();
    expect(within(templates()).queryByRole('button', { name: 'Dark' })).toBeNull();
    const text = await within(templates()).findByText('Hello Jamie, you have been invited.');
    expect(text.tagName).toBe('PRE');
    expect(view.queryByTitle('Invitation to Roedy Mail')).toBeNull();
    expect(templates().querySelector('.tpl-frame')).toHaveClass('text');
    expect(view.calls.at(-1)?.path).toBe('admin/system-mail/preview?template=invite&format=text&lang=en');
  });

  it('switches the template with arrow keys, Home and End; the panel names the selected tab', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=reset&format=html&theme=light')]: [{ body: { ...PREVIEW, subject: 'Password' } }],
      [previewKey('template=test&format=html&theme=light')]: [{ body: { ...PREVIEW, subject: 'Test email' } }],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    const tab = (name: string) => within(templates()).getByRole('tab', { name });
    expect(tab('Invitation')).toHaveAttribute('tabindex', '0');
    expect(tab('Reset password')).toHaveAttribute('tabindex', '-1');
    expect(within(templates()).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tpl-tab-invite');
    await fireEvent.keyDown(tab('Invitation'), { key: 'ArrowRight' });
    expect(tab('Reset password')).toHaveAttribute('aria-selected', 'true');
    expect(await view.findByTitle('Password')).toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(tab('Reset password')));
    await fireEvent.keyDown(tab('Reset password'), { key: 'End' });
    expect(tab('Test email')).toHaveAttribute('aria-selected', 'true');
    expect(within(templates()).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tpl-tab-test');
    await fireEvent.keyDown(tab('Test email'), { key: 'ArrowRight' });
    expect(tab('Invitation')).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the two variants as a segment for the system notice', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=system&variant=backup&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'Backup completed' } },
      ],
      [previewKey('template=system&variant=update&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'Update available' } },
      ],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('tab', { name: 'System notice' }));
    expect(within(templates()).getByRole('tab', { name: 'System notice' })).toHaveAttribute('aria-selected', 'true');
    expect(await view.findByTitle('Backup completed')).toBeInTheDocument();
    const group = within(templates()).getByRole('group', { name: 'Variant' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Backup', 'true'],
      ['Update', 'false'],
    ]);
    expect(within(templates()).queryByRole('combobox', { name: /^Variant / })).toBeNull();
    await fireEvent.click(within(group).getByRole('button', { name: 'Update' }));
    expect(await view.findByTitle('Update available')).toBeInTheDocument();
  });

  it('selects the variant from the list for the security notice', async () => {
    const view = renderPage(mail(), {
      [previewKey('template=security&variant=login&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'New sign-in to Roedy Mail' } },
      ],
      [previewKey('template=security&variant=totp_remove_last&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'Last authenticator app removed' } },
      ],
    });
    await view.findByTitle('Invitation to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('tab', { name: 'Security notice' }));
    expect(await view.findByTitle('New sign-in to Roedy Mail')).toBeInTheDocument();
    expect(within(templates()).queryByRole('group', { name: 'Variant' })).toBeNull();
    // Name from the "Variant" prefix and the visible value.
    const button = within(templates()).getByRole('combobox', { name: 'Variant New sign-in' });
    expect(button).toHaveTextContent('Variant New sign-in');
    await fireEvent.click(button);
    expect(ui.menu).toBe('pick');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const list = view.getByRole('listbox', { name: 'Variant' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(16);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await fireEvent.click(within(list).getByRole('option', { name: /^Last app removed/ }));
    expect(view.queryByRole('listbox')).toBeNull();
    expect(button).toHaveTextContent('Variant Last app removed');
    expect(await view.findByTitle('Last authenticator app removed')).toBeInTheDocument();
    expect(view.calls.at(-1)?.path).toBe(
      'admin/system-mail/preview?template=security&variant=totp_remove_last&format=html&theme=light&lang=en',
    );
  });

  it('shows the card when the preview does not load, and reloads', async () => {
    const view = renderPage(mail(), {
      [previewKey()]: [{ status: 500, body: { error: 'internal' } }, ...previews()],
    });
    const card = await view.findByRole('alert');
    expect(within(card).getByText('Couldn’t load the preview')).toBeInTheDocument();
    expect(within(templates()).queryByText('Subject')).toBeNull();
    expect(view.queryByTitle('Invitation to Roedy Mail')).toBeNull();
    await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await view.findByTitle('Invitation to Roedy Mail')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
    expect(within(templates()).getByText('Subject')).toBeInTheDocument();
  });

  it('shows the short description and the variants in the sheet on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage(mail(), {
      [previewKey('template=security&variant=login&format=html&theme=light')]: [
        { body: { ...PREVIEW, subject: 'New sign-in to Roedy Mail' } },
      ],
    });
    expect(ui.isMobile).toBe(true);
    await view.findByTitle('Invitation to Roedy Mail');
    expect(within(templates()).getByText('This is how system emails reach recipients.')).toBeInTheDocument();
    await fireEvent.click(within(templates()).getByRole('tab', { name: 'Security notice' }));
    await view.findByTitle('New sign-in to Roedy Mail');
    await fireEvent.click(within(templates()).getByRole('button', { name: /^Variant / }));
    expect(ui.menu).toBe('pick');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(ui.pick?.().title).toBe('Variant');
    const opts = ui.pick?.().opts ?? [];
    expect(opts).toHaveLength(16);
    expect(opts.slice(0, 3).map((o) => o.label)).toEqual(['New sign-in', 'No location', 'Password changed']);
  });
});
