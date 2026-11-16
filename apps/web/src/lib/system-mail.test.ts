import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  changedBody,
  connOf,
  draftOf,
  NO_MAIL,
  precheck,
  reasonText,
  SystemMailPage,
  systemMailValues,
  type MailServer,
  type SystemMail,
  type SystemMailContext,
  type SystemMailInput,
} from './system-mail.svelte.ts';

const ME: Me = {
  id: 'u0',
  username: 'alex',
  email: 'alex@example.com',
  display_name: 'Alex Morgan',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-01T12:00:00Z',
  email_change: null,
  system_mail_configured: true,
};

const SERVERS: MailServer[] = [
  { id: 's1', label: 'VPS 1', url: 'https://mail.s1.test' },
  { id: 's2', label: 'VPS 2', url: 'https://mail.s2.test' },
];

/** A connected sending account, without a secret. */
const MAIL: SystemMail = {
  server_id: 's1',
  auth: 'password',
  user: 'noreply@example.com',
  has_secret: true,
  identity_id: 'i1',
  sender_name: null,
  reply_to: 'support@example.com',
  keep_sent: true,
  status: 'ok',
  reason: null,
  checked_at: '2026-11-05T10:00:00Z',
  identities: [
    { id: 'i1', name: 'Example Inc', email: 'noreply@example.com' },
    { id: 'i2', name: 'Example Support', email: 'support@example.com' },
  ],
};

const NOW = Date.parse('2026-11-05T12:00:00Z');
const input: SystemMailInput = { open: null, hi: null, isMobile: false, now: NOW };
const ctx: SystemMailContext = { scrollTo: vi.fn(), goServers: vi.fn(), show: vi.fn(), mark: vi.fn() };
const values = (p: SystemMailPage) => systemMailValues(p, input, ctx);
const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);

/** Loads the page with this account; further responses for the following steps. */
async function opened(mail: SystemMail, more: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET admin/system-mail': [{ body: mail }],
    'GET admin/servers': [{ body: { servers: SERVERS, redirect_uri: '', system_mail_server: mail.server_id } }],
    'GET auth/me': [{ body: ME }],
    ...more,
  });
  const p = new SystemMailPage();
  await p.load();
  return { p, api };
}

beforeEach(() => {
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.user = null;
  prefs.reset();
  ui.reset();
});

describe('Draft, connection and body', () => {
  it('draft from the stored account without secrets', () => {
    expect(draftOf(MAIL)).toEqual({
      srv: 's1',
      auth: 'password',
      user: 'noreply@example.com',
      pass: '',
      token: '',
      name: '',
      replyTo: 'support@example.com',
      keepSent: true,
    });
    expect(draftOf(NO_MAIL).srv).toBe('');
  });

  it('connection: user only with password, sender does not count', () => {
    const d = draftOf(MAIL);
    expect(connOf({ ...d, name: 'Other' })).toBe(connOf(d));
    expect(connOf({ ...d, user: ' noreply@example.com ' })).toBe(connOf(d));
    expect(connOf({ ...d, pass: 'new' })).not.toBe(connOf(d));
    expect(connOf({ ...d, auth: 'token', user: 'x' })).toBe(connOf({ ...d, auth: 'token', user: 'y' }));
  });

  it('PUT sends only what changed, secrets only when entered', () => {
    const base = draftOf(MAIL);
    expect(changedBody({ ...base, name: '  Roedy  ', replyTo: '' }, base)).toEqual({
      sender_name: 'Roedy',
      reply_to: null,
    });
    expect(changedBody({ ...base, auth: 'token', token: ' tok ' }, base)).toEqual({ auth: 'token', token: 'tok' });
    expect(changedBody({ ...base, pass: ' pw ' }, base)).toEqual({ app_password: ' pw ' });
    expect(changedBody({ ...base, user: ' noreply@example.com ' }, base)).toEqual({});
  });

  it('checks beforehand; a stored secret of the same sign-in method counts', () => {
    const d = draftOf(MAIL);
    expect(precheck(d, MAIL, SERVERS)).toBeNull();
    expect(precheck({ ...d, srv: '' }, MAIL, SERVERS)).toBe('Can’t reach the server. Check the address.');
    expect(precheck({ ...d, srv: 's9' }, MAIL, SERVERS)).toBe('Can’t reach the server. Check the address.');
    expect(precheck({ ...d, user: ' ' }, MAIL, SERVERS)).toBe('Sign-in failed. Enter a username and password.');
    expect(precheck(d, { ...MAIL, has_secret: false }, SERVERS)).toBe('Sign-in failed. Enter a username and password.');
    expect(precheck({ ...d, auth: 'token' }, MAIL, SERVERS)).toBe('Sign-in failed. No token provided.');
    expect(precheck({ ...d, auth: 'token', token: 'tok' }, MAIL, SERVERS)).toBeNull();
  });

  it('texts per reason', () => {
    expect(reasonText('unreachable')).toBe('Can’t reach the server. Check the address.');
    expect(reasonText('auth_failed')).toBe('Sign-in failed. The username or password is incorrect.');
    expect(reasonText('auth_failed', { tok: true })).toBe(
      'Sign-in failed. The access token is incorrect, expired, or revoked.',
    );
    expect(reasonText('forbidden')).toBe(
      'The mail server denies this account access. Check the account’s permissions in Stalwart.',
    );
    expect(reasonText('auth_locked', { wait: 900 })).toBe('Too many failed attempts. Try again in 15 minutes.');
    expect(reasonText('auth_locked')).toBe('Too many failed attempts. Try again later.');
    expect(reasonText('throttled', { app: 'Roedy Mail' })).toBe(
      'The mail server is throttling requests from Roedy Mail. Test again in a few minutes.',
    );
    expect(reasonText('throttled', { app: 'Roedy Mail', wait: 120 })).toBe(
      'The mail server is throttling requests from Roedy Mail. Test again in 2 minutes.',
    );
    expect(reasonText('no_identity')).toBe(
      'The account has no identity for sending. Create an identity for this account in Stalwart.',
    );
    expect(reasonText('no_mailbox', { role: 'drafts' })).toBe(
      'The account has no “Drafts” mailbox. Create it in Stalwart.',
    );
    // Without `role` (status after loading) "Drafts" applies.
    expect(reasonText('no_mailbox')).toBe('The account has no “Drafts” mailbox. Create it in Stalwart.');
    expect(reasonText('no_mailbox', { role: 'sent' })).toBe(
      'The account has no “Sent” mailbox. Create it in Stalwart or turn off “Save a copy to Sent”.',
    );
    expect(reasonText('unsupported')).toBe('The mail server doesn’t allow this account to send via JMAP.');
    for (const other of [
      'foreign_origin',
      'http_status',
      'invalid_response',
      'method_error',
      'request_rejected',
      null,
    ]) {
      expect(reasonText(other)).toBe('That didn’t work. Please try again.');
    }
  });

  it('`throttled` without detail names the app name from `public/config`', () => {
    expect(reasonText('throttled')).toBe(
      `The mail server is throttling requests from ${session.appName}. Test again in a few minutes.`,
    );
  });
});

describe('Loading and status', () => {
  it('connected: status, rows, sender and server selection', async () => {
    const { p, api } = await opened(MAIL);
    expect(sent(api.calls)).toEqual(['GET admin/system-mail', 'GET admin/servers']);
    expect(p.status).toBe('ready');
    const v = values(p);
    expect(v.mSt).toMatchObject({ key: 'ok', title: 'Connected', sub: 'JMAP session with mail.s1.test is active.' });
    expect(v.mailOk).toBe(true);
    expect(v.mailRows).toEqual([
      { k: 'Session', v: 'https://mail.s1.test/jmap/session', sep: false },
      { k: 'Account', v: 'noreply@example.com', sep: true },
      { k: 'Last checked', v: '2 hours ago', sep: true },
    ]);
    expect(v.mailFrom).toBe('Example Inc <noreply@example.com>');
    expect(v.mailNamePh).toBe('Example Inc');
    expect(v.selMailSrv.label).toBe('VPS 1');
    expect(v.selMailSrv.opts.map((o) => [o.label, o.sub])).toEqual([
      ['VPS 1', 'mail.s1.test'],
      ['VPS 2', 'mail.s2.test'],
    ]);
    expect(v.mailSrvSub).toBe('JMAP session via mail.s1.test');
    expect(v.mailSecret).toMatchObject({ label: 'Password', value: '', ph: '••••••••', type: 'password' });
    expect(v.mailToVal).toBe('alex@example.com');
    expect(v.mailSendDis).toBe(false);
    expect(v.mailDirty).toBe(false);
    expect(v.mailTabs.map((t) => t.label)).toEqual(['Connection', 'Sender', 'Delivery', 'Test', 'Templates']);
  });

  it('without an account "Not set up"; a chosen server is "Not checked"', async () => {
    const { p } = await opened({ ...NO_MAIL });
    let v = values(p);
    expect(v.mSt).toMatchObject({ key: 'none', title: 'Not set up', icon: 'ti-mail-off' });
    expect(v.selMailSrv.label).toBe('Choose server');
    expect(v.mailSrvSub).toBe('The sending account’s server from the server list');
    expect(v.mailSendDis).toBe(true);
    expect(v.mailFrom).toBe('');
    v.selMailSrv.opts[1]?.onClick();
    v = values(p);
    expect(v.mSt).toMatchObject({ key: 'new', title: 'Not checked' });
    expect(v.mailDirty).toBe(true);
  });

  it('without an account a failed check of the draft shows the reason', async () => {
    const { p } = await opened(
      { ...NO_MAIL },
      { 'POST admin/system-mail/test': [{ status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } }] },
    );
    await p.test();
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: 'Can’t reach the server. Check the address.' });
    p.set('srv', 's1');
    p.set('user', 'noreply@example.com');
    p.set('pass', 'wrong');
    await p.test();
    expect(values(p).mSt).toMatchObject({
      key: 'err',
      sub: 'Sign-in failed. The username or password is incorrect.',
    });
  });

  it('without servers in the registry: selection disabled with a notice', async () => {
    mockApi({
      'GET admin/system-mail': [{ body: NO_MAIL }],
      'GET admin/servers': [{ body: { servers: [] } }],
    });
    const p = new SystemMailPage();
    await p.load();
    const v = values(p);
    expect(v.selMailSrv).toMatchObject({ label: 'No servers added', disabled: true });
    expect(v.mailSrvNone).toBe(true);
    expect(v.mailSrvSub).toBe('Add a mail server first');
  });

  it('a stored error shows the reason', async () => {
    const { p } = await opened({ ...MAIL, status: 'err', reason: 'auth_failed', identities: [] });
    expect(values(p).mSt).toMatchObject({
      key: 'err',
      title: 'No connection',
      sub: 'Sign-in failed. The username or password is incorrect.',
    });
    expect(values(p).mailSendDis).toBe(true);
  });

  it('a stored missing mailbox names `role`, without detail "Drafts"', async () => {
    const sent = await opened({ ...MAIL, status: 'err', reason: 'no_mailbox', role: 'sent', identities: [] });
    expect(values(sent.p).mSt.sub).toBe(
      'The account has no “Sent” mailbox. Create it in Stalwart or turn off “Save a copy to Sent”.',
    );
    const drafts = await opened({ ...MAIL, status: 'err', reason: 'no_mailbox', role: 'drafts', identities: [] });
    expect(values(drafts.p).mSt.sub).toBe('The account has no “Drafts” mailbox. Create it in Stalwart.');
    const unspecified = await opened({ ...MAIL, status: 'err', reason: 'no_mailbox', identities: [] });
    expect(values(unspecified.p).mSt.sub).toBe('The account has no “Drafts” mailbox. Create it in Stalwart.');
  });

  it('PUT with a failed check takes `role` from the response', async () => {
    const { p } = await opened(MAIL, {
      'PUT admin/system-mail': [
        { body: { ...MAIL, status: 'err', reason: 'no_mailbox', role: 'sent', identities: [] } },
      ],
    });
    p.set('pass', 'new');
    void p.save();
    await ui.toasts.flush();
    expect(values(p).mSt).toMatchObject({
      key: 'err',
      sub: 'The account has no “Sent” mailbox. Create it in Stalwart or turn off “Save a copy to Sent”.',
    });
  });

  it('stored error without wait time and per sign-in method', async () => {
    const { p } = await opened({ ...MAIL, status: 'err', reason: 'auth_locked', identities: [] });
    expect(values(p).mSt.sub).toBe('Too many failed attempts. Try again later.');
    const token = await opened({ ...MAIL, auth: 'token', status: 'err', reason: 'auth_failed', identities: [] });
    expect(values(token.p).mSt.sub).toBe('Sign-in failed. The access token is incorrect, expired, or revoked.');
  });

  it('unchecked checks silently with the stored account after loading', async () => {
    const { p, api } = await opened(
      { ...MAIL, status: 'unchecked', checked_at: null, identities: [] },
      { 'POST admin/system-mail/test': [{ body: { identities: MAIL.identities, sent: false } }] },
    );
    // During the silent check "Checking …".
    expect(values(p).mSt).toMatchObject({ key: 'busy', title: 'Checking …' });
    await vi.waitFor(() => expect(p.key).toBe('ok'));
    const call = api.calls.find((c) => c.path === 'admin/system-mail/test');
    expect(call?.body).toEqual({ server_id: 's1', auth: 'password', user: 'noreply@example.com' });
    expect(ui.toast).toBeNull();
    expect(values(p).mailFrom).toBe('Example Inc <noreply@example.com>');
  });

  it('unchecked without a response stays "Not checked" with its own text, without a toast', async () => {
    const { p } = await opened({ ...MAIL, status: 'unchecked', checked_at: null, identities: [] });
    await vi.waitFor(() => expect(p.busy).toBe(false));
    expect(values(p).mSt).toEqual({
      key: 'unchecked',
      icon: 'ti-plug',
      title: 'Not checked',
      sub: 'The sending account is saved but not checked yet. Test the connection.',
    });
    expect(values(p).mailOk).toBe(false);
    expect(ui.toast).toBeNull();
    // A changed draft is again "The credentials have changed …".
    p.set('pass', 'new');
    expect(values(p).mSt.sub).toBe('The credentials have changed. Test the connection.');
  });

  it('unchecked with a server error during the silent check: status stays, error toast', async () => {
    const { p } = await opened(
      { ...MAIL, status: 'unchecked', checked_at: null, identities: [] },
      { 'POST admin/system-mail/test': [{ status: 500, body: { error: 'internal' } }] },
    );
    await vi.waitFor(() => expect(p.busy).toBe(false));
    expect(p.key).toBe('unchecked');
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
  });

  it('stored secret: empty field with placeholder', async () => {
    const { p } = await opened(MAIL);
    expect(values(p).mailSecret).toMatchObject({ value: '', ph: '••••••••' });
    p.set('pass', 'new-1234');
    expect(values(p).mailSecret).toMatchObject({ value: 'new-1234' });
    expect(values(p).mSt.title).toBe('Not checked');
  });

  it('an error while loading shows the error page; 403 reloads the account', async () => {
    const api = mockApi({
      'GET admin/system-mail': [{ status: 403, body: { error: 'forbidden' } }],
      'GET admin/servers': [{ body: { servers: SERVERS } }],
      'GET auth/me': [{ body: { ...ME, role: 'user' } }],
    });
    const p = new SystemMailPage();
    await p.load();
    expect(p.status).toBe('failed');
    expect(p.failure).toBe('500');
    await vi.waitFor(() => expect(session.isAdmin).toBe(false));
    expect(sent(api.calls)).toContain('GET auth/me');
  });
});

describe('Test connection', () => {
  it('checks the draft with the entered secret and remembers the connection', async () => {
    const { p, api } = await opened(
      { ...MAIL, status: 'err', reason: 'auth_failed' },
      { 'POST admin/system-mail/test': [{ body: { identities: MAIL.identities.slice(1), sent: false } }] },
    );
    p.set('pass', 'new');
    expect(p.key).toBe('new');
    values(p).mailTest();
    expect(p.key).toBe('busy');
    expect(values(p).mailBtn).toBe('Checking');
    await vi.waitFor(() => expect(p.key).toBe('ok'));
    expect(api.calls.at(-1)?.body).toEqual({
      server_id: 's1',
      auth: 'password',
      user: 'noreply@example.com',
      app_password: 'new',
    });
    expect(ui.toast?.text).toBe('Connection established');
    expect(p.rot).toBe(720);
    // The stored identity is missing in the response: the first one.
    expect(values(p).mailFrom).toBe('Example Support <support@example.com>');
    // The sender does not count towards the connection, another password does.
    p.set('name', 'Roedy');
    expect(p.key).toBe('ok');
    p.set('pass', 'anders');
    expect(p.key).toBe('new');
  });

  it('pre-check without a request: token missing', async () => {
    const { p, api } = await opened(MAIL);
    values(p).mailAuthOpts[1]?.onClick();
    expect(values(p).mailIsPw).toBe(false);
    expect(values(p).mailSecret).toMatchObject({ label: 'Access token', ph: '', ac: 'off' });
    expect(values(p).mailRows[1]?.v).toBe('Via access token');
    await p.test();
    expect(sent(api.calls)).toEqual(['GET admin/system-mail', 'GET admin/servers']);
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: 'Sign-in failed. No token provided.' });
    expect(ui.toast).toMatchObject({ text: 'Connection failed', error: true });
  });

  it('rejected sign-in and lock with wait time; the earlier good connection stays good', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } },
        { status: 429, body: { error: 'mail_failed', reason: 'auth_locked', retry_after: 840 } },
      ],
    });
    p.set('pass', 'wrong');
    await p.test();
    expect(values(p).mSt).toMatchObject({
      key: 'err',
      sub: 'Sign-in failed. The username or password is incorrect.',
    });
    // "Test connection" stays short, the status shows the reason.
    expect(ui.toast).toMatchObject({ text: 'Connection failed', error: true });
    await p.test();
    expect(values(p).mSt.sub).toBe('Too many failed attempts. Try again in 14 minutes.');
    p.set('pass', '');
    expect(p.key).toBe('ok');
  });

  it('every sign-in reason sets the status with its text', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: 'unreachable' }, 'Can’t reach the server. Check the address.'],
      [
        { reason: 'forbidden' },
        'The mail server denies this account access. Check the account’s permissions in Stalwart.',
      ],
      [
        { reason: 'throttled' },
        `The mail server is throttling requests from ${session.appName}. Test again in a few minutes.`,
      ],
      [
        { reason: 'no_identity' },
        'The account has no identity for sending. Create an identity for this account in Stalwart.',
      ],
      [{ reason: 'no_mailbox', role: 'drafts' }, 'The account has no “Drafts” mailbox. Create it in Stalwart.'],
      [{ reason: 'unsupported' }, 'The mail server doesn’t allow this account to send via JMAP.'],
      [{ reason: 'method_error' }, 'That didn’t work. Please try again.'],
    ];
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': cases.map(([body]) => ({ status: 502, body: { error: 'mail_failed', ...body } })),
    });
    for (const [, text] of cases) {
      await p.test();
      expect(values(p).mSt).toMatchObject({ key: 'err', title: 'No connection', sub: text });
      expect(ui.toast).toMatchObject({ text: 'Connection failed', error: true });
    }
  });

  it('token: a rejected sign-in names the access token', async () => {
    const { p } = await opened(
      { ...MAIL, auth: 'token' },
      { 'POST admin/system-mail/test': [{ status: 422, body: { error: 'mail_failed', reason: 'auth_failed' } }] },
    );
    p.set('token', 'expired');
    await p.test();
    expect(values(p).mSt.sub).toBe('Sign-in failed. The access token is incorrect, expired, or revoked.');
  });

  it('without a response the status stays, only an error toast', async () => {
    const { p } = await opened(MAIL);
    p.set('pass', 'new');
    await p.test();
    expect(p.key).toBe('new');
    expect(ui.toast).toMatchObject({ error: true, text: 'No connection. Please try again.' });
  });

  it('server error and 429 keep the status, only an error toast', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { status: 500, body: { error: 'internal' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 60 } },
      ],
    });
    await p.test();
    expect(p.key).toBe('ok');
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
    await p.test();
    expect(p.key).toBe('ok');
    expect(ui.toast).toMatchObject({ error: true, text: 'Too many requests. Try again in 1 minute.' });
  });
});

describe('Saving', () => {
  it('takes over immediately, sends only what changed after the toast and takes over the status', async () => {
    const view: SystemMail = { ...MAIL, auth: 'token', checked_at: '2026-11-05T11:59:00Z' };
    const { p, api } = await opened(MAIL, { 'PUT admin/system-mail': [{ body: view }] });
    p.set('auth', 'token');
    p.set('token', ' tok ');
    p.set('name', 'Roedy');
    values(p).mailSave();
    expect(p.dirty).toBe(false);
    expect(p.saved).toMatchObject({ auth: 'token', has_secret: true, sender_name: 'Roedy' });
    expect(values(p).mSt.key).toBe('new');
    expect(ui.toast).toMatchObject({ text: 'Changes saved', undo: true });
    expect(sent(api.calls)).not.toContain('PUT admin/system-mail');

    await ui.toasts.flush();
    // A new token can be another account: without a check the first identity.
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      auth: 'token',
      token: 'tok',
      sender_name: 'Roedy',
      identity_id: null,
    });
    expect(p.key).toBe('ok');
    expect(values(p).mailRows[2]?.v).toBe('1 min ago');
    // auth/me reloaded: `system_mail_configured` for the notice bar and the users page.
    await vi.waitFor(() => expect(sent(api.calls)).toContain('GET auth/me'));
  });

  it('a previously checked connection stays connected after saving', async () => {
    const { p } = await opened(
      { ...NO_MAIL },
      {
        'POST admin/system-mail/test': [{ body: { identities: MAIL.identities, sent: false } }],
        'PUT admin/system-mail': [{ body: MAIL }],
      },
    );
    p.set('srv', 's1');
    p.set('user', 'noreply@example.com');
    p.set('pass', 'secret');
    await p.test();
    expect(p.key).toBe('ok');
    void p.save();
    expect(values(p).mailSecret.value).toBe('');
    expect(p.key).toBe('ok');
    await ui.toasts.flush();
    expect(p.key).toBe('ok');
  });

  it('a new secret invalidates a check with the old one; the check on saving counts', async () => {
    const { p } = await opened(MAIL, {
      'PUT admin/system-mail': [{ body: { ...MAIL, status: 'err', reason: 'unreachable', identities: [] } }],
    });
    p.set('pass', 'new');
    void p.save();
    expect(p.key).toBe('new');
    await ui.toasts.flush();
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: 'Can’t reach the server. Check the address.' });
    expect(ui.toast?.text).toBe('Connection failed');
  });

  it('undo restores state and inputs', async () => {
    const { p, api } = await opened(MAIL);
    p.set('replyTo', '');
    void p.save();
    expect(p.saved.reply_to).toBeNull();
    ui.toasts.undo();
    expect(p.saved.reply_to).toBe('support@example.com');
    expect(p.dirty).toBe(false);
    expect(sent(api.calls)).not.toContain('PUT admin/system-mail');
  });

  it('if sending fails, the inputs with the secret are back', async () => {
    const { p } = await opened(MAIL, {
      'PUT admin/system-mail': [{ status: 422, body: { error: 'invalid', fields: { reply_to: { code: 'invalid' } } } }],
    });
    p.set('replyTo', 'broken');
    p.set('pass', 'new');
    void p.save();
    await ui.toasts.flush();
    await vi.waitFor(() => expect(p.dirty).toBe(true));
    expect(p.saved.reply_to).toBe('support@example.com');
    expect(p.draft).toMatchObject({ replyTo: 'broken', pass: 'new' });
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
  });

  it('a second save waits for the first and does not lose its fields', async () => {
    const { p, api } = await opened(MAIL, {
      'PUT admin/system-mail': [
        { status: 500, body: { error: 'internal' } },
        { body: { ...MAIL, sender_name: 'Roedy', reply_to: null } },
      ],
    });
    p.set('name', 'Roedy');
    void p.save();
    p.set('replyTo', '');
    await p.save();
    await ui.toasts.flush();
    expect(api.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { sender_name: 'Roedy' },
      { sender_name: 'Roedy', reply_to: null },
    ]);
    expect(p.saved).toMatchObject({ sender_name: 'Roedy', reply_to: null });
  });

  it('PUT with a new connection during a running check leaves "Checking" in place', async () => {
    let answer: (a: { body: unknown }) => void = () => {};
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [() => new Promise((resolve) => (answer = resolve))],
      'PUT admin/system-mail': [{ body: MAIL }],
    });
    void p.test();
    expect(p.busy).toBe(true);
    p.set('pass', 'new');
    void p.save();
    await ui.toasts.flush();
    expect(p.busy).toBe(true);
    answer({ body: { identities: MAIL.identities, sent: false } });
    await vi.waitFor(() => expect(p.busy).toBe(false));
  });

  it('discard reverts the inputs', async () => {
    const { p } = await opened(MAIL);
    values(p).mailOn.name('Roedy');
    values(p).tgMailSent.onClick();
    expect(values(p).mailDirty).toBe(true);
    expect(values(p).mailFrom).toBe('Roedy <noreply@example.com>');
    values(p).mailDiscard();
    expect(p.draft).toMatchObject({ name: '', keepSent: true });
  });
});

describe('Identity with another account', () => {
  it('checks another account with the first identity and keeps the stored one if it knows it', async () => {
    const { p, api } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ body: { identities: MAIL.identities, sent: false } }],
      'PUT admin/system-mail': [{ body: { ...MAIL, server_id: 's2' } }],
    });
    p.set('srv', 's2');
    await p.test();
    expect(api.calls.at(-1)?.body).toMatchObject({ server_id: 's2', identity_id: null });
    await p.save();
    await ui.toasts.flush();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ server_id: 's2' });
  });

  it('saves the first one (null) without a known identity', async () => {
    const { p, api } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { body: { identities: [{ id: 'x1', name: 'Other', email: 'other@example.org' }] } },
      ],
      'PUT admin/system-mail': [{ body: { ...MAIL, user: 'other@example.com', identity_id: null } }],
    });
    p.set('user', 'other@example.com');
    p.set('pass', 'secret');
    await p.test();
    expect(values(p).mailFrom).toBe('Other <other@example.org>');
    await p.save();
    expect(p.saved.identity_id).toBeNull();
    await ui.toasts.flush();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      user: 'other@example.com',
      app_password: 'secret',
      identity_id: null,
    });
  });

  it('only a new password keeps the identity', async () => {
    const { p, api } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ body: { identities: MAIL.identities } }],
    });
    p.set('pass', 'new');
    await p.test();
    expect(api.calls.at(-1)?.body).not.toHaveProperty('identity_id');
  });
});

describe('Test email', () => {
  it('sends with the draft to the own address', async () => {
    const { p, api } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ body: { identities: MAIL.identities, sent: true } }],
    });
    p.set('name', 'Roedy');
    const v = values(p);
    v.mailSend();
    expect(values(p).mailSendLabel).toBe('Sending …');
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Test email sent to alex@example.com'));
    expect(api.calls.at(-1)?.body).toEqual({
      server_id: 's1',
      auth: 'password',
      user: 'noreply@example.com',
      sender_name: 'Roedy',
      reply_to: 'support@example.com',
      keep_sent: true,
      to: 'alex@example.com',
    });
    expect(values(p).mailSendLabel).toBe('Send');
  });

  it('invalid address, not connected and limit', async () => {
    const { p, api } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ status: 429, body: { error: 'rate_limited', retry_after: 60 } }],
    });
    values(p).onMailTo('no-recipient');
    await p.send();
    expect(ui.toast?.text).toBe('Please enter a valid email address');
    values(p).onMailTo('target@example.com');
    await p.send();
    // Sending limit, the status stays.
    expect(ui.toast).toMatchObject({ error: true, text: 'Too many requests. Try again in 1 minute.' });
    expect(p.key).toBe('ok');
    p.set('pass', 'new');
    expect(values(p).mailSendDis).toBe(true);
    await p.send();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('if only the mail fails, the connection stays good', async () => {
    const reasons = [
      'not_created',
      'method_error',
      'request_rejected',
      'invalid_response',
      'http_status',
      'no_public_url',
    ];
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': reasons.map((reason) => ({ status: 502, body: { error: 'mail_failed', reason } })),
    });
    for (const reason of reasons) {
      await p.send();
      expect(p.key, reason).toBe('ok');
      expect(ui.toast).toMatchObject({
        error: true,
        text: 'The test email to alex@example.com wasn’t sent. Please try again.',
      });
    }
  });

  it('server error and without a response: status stays, general error toast', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ status: 500, body: { error: 'internal' } }],
    });
    await p.send();
    expect(p.key).toBe('ok');
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
    await p.send();
    expect(p.key).toBe('ok');
    expect(ui.toast).toMatchObject({ error: true, text: 'No connection. Please try again.' });
  });

  it('if "Sent" is missing when sending, the status names the mailbox (`role`)', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { status: 502, body: { error: 'mail_failed', reason: 'no_mailbox', role: 'sent' } },
      ],
    });
    await p.send();
    const text = 'The account has no “Sent” mailbox. Create it in Stalwart or turn off “Save a copy to Sent”.';
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: text });
    expect(ui.toast).toMatchObject({ error: true, text });
  });

  it('a lock when sending names the wait time in the status and in the toast', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { status: 429, body: { error: 'mail_failed', reason: 'auth_locked', retry_after: 900 } },
      ],
    });
    await p.send();
    const text = 'Too many failed attempts. Try again in 15 minutes.';
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: text });
    expect(ui.toast).toMatchObject({ error: true, text });
  });

  it('a rejected reply-to address does not concern the connection', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { status: 422, body: { error: 'invalid', fields: { reply_to: { code: 'invalid' } } } },
      ],
    });
    p.set('replyTo', 'broken@');
    await p.send();
    expect(p.key).toBe('ok');
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('if the sign-in fails when sending, the connection is no longer good', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [{ status: 422, body: { error: 'mail_failed', reason: 'forbidden' } }],
    });
    await p.send();
    const text = 'The mail server denies this account access. Check the account’s permissions in Stalwart.';
    expect(values(p).mSt).toMatchObject({ key: 'err', sub: text });
    // "Send" names the reason in the toast (unlike "Test connection").
    expect(ui.toast).toMatchObject({ error: true, text });
    expect(values(p).mailSendDis).toBe(true);
  });
});

describe('Confirmed state for the template preview', () => {
  it('counts loading and the PUT response, not the optimistic save', async () => {
    const { p } = await opened(MAIL, { 'PUT admin/system-mail': [{ body: { ...MAIL, sender_name: 'Roedy' } }] });
    expect(p.confirmed).toBe(1);
    p.set('name', 'Roedy');
    values(p).mailSave();
    expect(p.saved.sender_name).toBe('Roedy');
    expect(p.confirmed).toBe(1);
    await ui.toasts.flush();
    await vi.waitFor(() => expect(p.confirmed).toBe(2));
  });

  it('counts a check only with other identities', async () => {
    const { p } = await opened(MAIL, {
      'POST admin/system-mail/test': [
        { body: { identities: MAIL.identities, sent: false } },
        { body: { identities: MAIL.identities.slice(1), sent: false } },
      ],
    });
    values(p).mailTest();
    await vi.waitFor(() => expect(p.busy).toBe(false));
    expect(p.confirmed).toBe(1);
    values(p).mailTest();
    await vi.waitFor(() => expect(p.busy).toBe(false));
    expect(p.confirmed).toBe(2);
  });
});
