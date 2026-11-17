import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { forgetAccount } from '#lib/state/account.ts';
import { UsersPage, keptUsers, rowsValues, usersValues, type ListedUser } from './users.svelte.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const before = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const ME: Me = {
  id: 'u0',
  username: 'max',
  email: 'max.miller@example.com',
  display_name: 'Max Miller',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: before(100),
  email_change: null,
  system_mail_configured: true,
};

const user = (id: string, name: string, extra: Partial<ListedUser> = {}): ListedUser => ({
  id,
  status: 'active',
  name,
  email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
  role: 'user',
  mfa: false,
  last_seen_at: before(2),
  created_at: before(500),
  ...extra,
});
const invite = (id: string, email: string, extra: Partial<ListedUser> = {}): ListedUser => ({
  id,
  status: 'invited',
  name: null,
  email,
  role: 'user',
  mfa: false,
  created_at: before(1),
  invited_by: { id: 'u0', name: 'Max Miller' },
  mail_sent_at: before(1),
  expires_at: before(-167),
  expired: false,
  ...extra,
});

const USERS: ListedUser[] = [
  user('u0', 'Max Miller', { email: ME.email, role: 'admin', last_seen_at: before(0) }),
  user('u1', 'Anna Baker', { role: 'admin', mfa: true }),
  user('u2', 'Luke Walker', { mfa: true, last_seen_at: before(26) }),
  user('u3', 'Sophie Hamilton', { status: 'locked', last_seen_at: before(120) }),
  invite('i1', 'jane.smith@example.com', { name: 'Jane Smith' }),
  invite('i2', 'paul.long@example.com', { mail_sent_at: null }),
];

const ctx = { editMe: vi.fn(), setupMail: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  session.config = CONFIG;
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  keptUsers.forget();
});

/** Loaded page with the test data. */
async function loaded(routes: Parameters<typeof mockApi>[0] = {}, users = USERS) {
  const api = mockApi({ 'GET users': [{ body: { users } }, { body: { users } }], ...routes });
  const p = new UsersPage();
  await p.load();
  return { p, v: () => usersValues(p, ctx, NOW), ...api };
}

const row = (v: ReturnType<typeof usersValues>, name: string) => {
  const found = v.uRows.find((r) => r.name === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};
const listed = (p: UsersPage, id: string) => p.rows.find((u) => u.id === id);
const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);

describe('List', () => {
  it('loads users and invitations, sorted by name', async () => {
    const { v } = await loaded();
    expect(v().uRows.map((r) => r.name)).toEqual([
      'Anna Baker',
      'Jane Smith',
      'Luke Walker',
      'Max Miller',
      'paul.long@example.com',
      'Sophie Hamilton',
    ]);
    expect(v().uPills.map((o) => [o.label, o.n, o.on])).toEqual([
      ['All', 6, true],
      ['Active', 3, false],
      ['Invited', 2, false],
      ['Suspended', 1, false],
    ]);
    expect(v().uHasRows).toBe(true);
  });

  it('shows the own account with "You", without selection and actions', async () => {
    const { p, v } = await loaded();
    const me = row(v(), 'Max Miller');
    expect(me).toMatchObject({
      isMe: true,
      online: true,
      last: 'Now',
      lastLong: 'Active now',
      ckLabel: 'You can’t select your own account',
      isActive: false,
      notMe: false,
      canMfaReset: false,
    });
    p.toggleSelect('u0');
    expect(p.selected).toEqual([]);
    p.toggleOpen('u0');
    expect(row(v(), 'Max Miller').roles.every((r) => r.dis)).toBe(true);
    row(v(), 'Max Miller').editMe();
    expect(ctx.editMe).toHaveBeenCalled();
  });

  it('describes rows (time, status, multi-factor)', async () => {
    const { v } = await loaded();
    expect(row(v(), 'Anna Baker')).toMatchObject({
      initials: 'AB',
      sub: 'anna.baker@example.com',
      role: 'Administrator',
      roleIcon: 'ti-crown',
      mfa: true,
      canMfaReset: true,
      st: 'Active',
      last: '2 hours ago',
      lastLong: 'Last active 2 hours ago',
    });
    expect(row(v(), 'Luke Walker').last).toBe('26 hours ago');
    expect(row(v(), 'Sophie Hamilton')).toMatchObject({
      st: 'Suspended',
      isLockedSt: true,
      isLocked: true,
      last: 'Last seen 5 days ago',
      canMfaReset: false,
    });
    expect(row(v(), 'paul.long@example.com')).toMatchObject({
      sub: 'Invitation pending',
      initials: 'P',
      isInvited: true,
      sendErr: true,
      hasSendNote: true,
      canResend: true,
      removeLabel: 'Revoke invitation',
      lastLong: 'Invited 1 hour ago',
      sendNote: 'The invitation email couldn’t be sent. Copy the link and share it yourself, or resend the invitation.',
    });
    expect(row(v(), 'Jane Smith')).toMatchObject({ sendErr: false, hasSendNote: false, sendNote: '' });
  });

  it('offers no "Resend" without system mail and explains the invitation', async () => {
    session.user = { ...ME, system_mail_configured: false };
    const { v } = await loaded();
    expect(v().uNoMail).toBe(true);
    expect(row(v(), 'paul.long@example.com')).toMatchObject({
      canResend: false,
      sendNote: 'Without system emails, no invitation is sent. Copy the link and share it yourself.',
    });
  });

  it('marks expired invitations and names the expiry date for valid ones', async () => {
    prefs.values.tzAuto = false;
    prefs.values.tz = 'Europe/Berlin';
    // `expired` of the API only applies on loading: `expires_at` is what counts.
    const old = invite('i3', 'eve.ross@example.com', { name: 'Eve Ross', expires_at: before(5), expired: false });
    const { v } = await loaded({}, [...USERS, old]);
    expect(row(v(), 'Eve Ross')).toMatchObject({
      st: 'Expired',
      expired: true,
      isInvited: true,
      last: 'on 26 October',
      lastLong: 'Expired on 26 October',
      canExtend: true,
      canCopy: false,
      canResend: true,
      hasValid: false,
      validUntil: '',
      hasSendNote: true,
      sendNote:
        'This invitation has expired and the link no longer works. Resend it, or extend it and share the link yourself.',
    });
    expect(row(v(), 'Jane Smith')).toMatchObject({
      st: 'Invited',
      expired: false,
      canExtend: false,
      canCopy: true,
      hasValid: true,
      validUntil: 'Valid until 2 November',
    });
    // Active accounts have neither expiry nor "Extend".
    expect(row(v(), 'Anna Baker')).toMatchObject({
      expired: false,
      canExtend: false,
      canCopy: false,
      hasValid: false,
    });
  });

  it('explains expired invitations without system mail without "Resend"', async () => {
    session.user = { ...ME, system_mail_configured: false };
    const old = invite('i3', 'eve.ross@example.com', { expires_at: before(5), expired: true, mail_sent_at: null });
    const { v } = await loaded({}, [...USERS, old]);
    expect(row(v(), 'eve.ross@example.com')).toMatchObject({
      st: 'Expired',
      canExtend: true,
      canResend: false,
      sendNote: 'This invitation has expired and the link no longer works. Extend it and share the link yourself.',
    });
  });

  it('searches, filters, sorts and resets', async () => {
    const { p, v } = await loaded();
    // Name or address, regardless of case.
    p.setQuery('BAKER');
    expect(v().uRows.map((r) => r.name)).toEqual(['Anna Baker']);
    p.setQuery('long@');
    expect(v().uRows.map((r) => r.name)).toEqual(['paul.long@example.com']);
    expect(v().uPills.map((o) => o.n)).toEqual([1, 0, 1, 0]);
    p.setQuery('xyz');
    expect(v()).toMatchObject({
      uEmpty: true,
      uHasRows: false,
      uEmptyText: 'No results for “xyz”',
      uCanReset: true,
    });
    v().uReset();
    p.setFilter('invited');
    expect(v().uRows.map((r) => r.name)).toEqual(['Jane Smith', 'paul.long@example.com']);
    p.setQuery('Anna');
    expect(v().uEmptyText).toBe('No results for “Anna”');
    p.setQuery('');
    p.rows = p.rows.filter((u) => u.status !== 'invited');
    expect(v()).toMatchObject({ uEmpty: true, uEmptyText: 'No users in this view', uCanReset: true });
    p.rows = USERS;
    p.resetFilter();
    p.sortBy('status');
    expect(v().uRows.map((r) => r.status)).toEqual(['active', 'active', 'active', 'invited', 'invited', 'locked']);
    expect(v().uHdStatus).toMatchObject({ on: true, desc: false, aria: 'Sort by Status' });
    p.sortBy('status');
    expect(v().uHdStatus.desc).toBe(true);
    expect(v().uRows[0]?.status).toBe('locked');
    p.sortBy('role');
    expect(
      v()
        .uRows.slice(0, 2)
        .map((r) => r.role),
    ).toEqual(['Administrator', 'Administrator']);
  });

  it('shows the error page if the first load fails', async () => {
    mockApi({ 'GET users': [{ status: 500, body: { error: 'internal' } }] });
    const p = new UsersPage();
    await p.load();
    expect(p.status).toBe('failed');
    expect(p.failure).toBe('500');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await p.retry();
    expect(p.failure).toBe('offline');
  });

  it('reloads the account without a session instead of only showing the error page', async () => {
    mockApi({
      'GET users': [{ status: 401, body: { error: 'unauthorized' } }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const p = new UsersPage();
    await p.load();
    await vi.waitFor(() => expect(session.authed).toBe(false));
  });

  it('discards outdated responses and loads nothing after leaving', async () => {
    let release: (value: { body: unknown }) => void = () => {};
    mockApi({
      'GET users': [() => new Promise((resolve) => (release = resolve)), { body: { users: USERS.slice(0, 2) } }],
    });
    const p = new UsersPage();
    const first = p.load();
    await p.load();
    release({ body: { users: USERS } });
    await first;
    expect(p.rows).toHaveLength(2);
    p.dispose();
  });
});

describe('Selection', () => {
  it('selects all except the own account and shows matching actions', async () => {
    const { p, v } = await loaded();
    expect(v().uAllCk).toMatchObject({ on: false, label: 'Select all', icon: 'ti-check', vis: 1 });
    p.toggleSelect('u2');
    expect(v()).toMatchObject({ uSelOn: true, uSelOff: false, uSelText: '1 selected', uBulkCanLock: true });
    expect(v().uAllCk).toMatchObject({ on: 'mixed', icon: 'ti-minus' });
    expect(row(v(), 'Luke Walker')).toMatchObject({ sel: true, isSel: true, ckLabel: 'Deselect Luke Walker' });
    v().uAllCk.onClick();
    expect(p.selected).not.toContain('u0');
    expect(v().uAllCk).toMatchObject({ on: true, label: 'Clear selection' });
    expect(v()).toMatchObject({ uBulkCanLock: true, uBulkCanUnlock: true });
    v().uAllCk.onClick();
    expect(p.selected).toEqual([]);
  });

  it('changes the role of the selection with undo (`users/bulk`)', async () => {
    const { p, v, calls } = await loaded({ 'POST users/bulk': [{ body: { changed: ['u2', 'u3'] } }] });
    p.toggleSelect('u2');
    p.toggleSelect('u3');
    p.toggleSelect('u1');
    expect(v().selBulkRole.title).toBe('Role for 3 people');
    v().selBulkRole.toggle();
    expect(ui.menu).toBe('pick');
    expect(v().selBulkRole.opts.map((o) => [o.label, o.on])).toEqual([
      ['Administrator', false],
      ['User', false],
    ]);
    v().selBulkRole.opts[0]?.onClick();
    expect(ui.menu).toBeNull();
    expect(listed(p, 'u2')?.role).toBe('admin');
    expect(ui.toast).toMatchObject({ text: 'Role changed for 2 people', undo: true });
    await ui.toasts.flush();
    expect(calls.at(-1)).toMatchObject({
      path: 'users/bulk',
      body: { action: 'role', ids: ['u2', 'u3'], role: 'admin' },
    });
  });

  it('operates the select list "Change role" with the keyboard', async () => {
    const { p, v } = await loaded();
    p.toggleSelect('u2');
    const key = (k: string) => v().selBulkRole.onKey({ key: k, preventDefault: () => {} });
    key('ArrowDown');
    expect(v().selBulkRole.open).toBe(true);
    expect(v().selBulkRole.opts.map((o) => o.hi)).toEqual([false, true]);
    key('ArrowDown');
    expect(v().selBulkRole.opts[0]?.hi).toBe(true);
    key('Tab');
    expect(v().selBulkRole.open).toBe(false);
    key('ArrowUp');
    key('ArrowUp');
    // Space selects only on release (otherwise its click would open the list again).
    const space = { key: ' ', preventDefault: vi.fn() };
    v().selBulkRole.onKey(space);
    expect(space.preventDefault).toHaveBeenCalled();
    expect(listed(p, 'u2')?.role).toBe('user');
    v().selBulkRole.onKeyUp({ key: ' ', preventDefault: () => {} });
    expect(listed(p, 'u2')?.role).toBe('admin');
    expect(ui.toast?.text).toBe('Role changed');
    expect(v().selBulkRole.open).toBe(false);
  });

  it('locks after confirmation, unlocks and removes the selection', async () => {
    const { p, v, calls } = await loaded({
      'POST users/bulk': [
        { body: { changed: ['u1', 'u2'] } },
        { body: { changed: ['u1'] } },
        { body: { changed: [] } },
      ],
    });
    p.toggleSelect('u1');
    p.toggleSelect('u2');
    v().uBulkLock();
    expect(ui.confirm).toMatchObject({
      title: 'Suspend 2 people?',
      text: 'The selected people will be signed out immediately and can’t sign in again until you reactivate their accounts.',
      ok: 'Suspend',
      danger: true,
    });
    ui.confirmOk();
    expect(listed(p, 'u1')?.status).toBe('locked');
    expect(ui.toast).toMatchObject({ text: '2 people suspended', undo: true });
    await ui.toasts.flush();
    expect(calls.at(-1)?.body).toEqual({ action: 'lock', ids: ['u1', 'u2'] });
    p.selected = ['u1'];
    v().uBulkUnlock();
    expect(ui.toast?.text).toBe('Anna Baker reactivated');
    await ui.toasts.flush();
    expect(calls.at(-1)?.body).toEqual({ action: 'unlock', ids: ['u1'] });
    p.selected = ['u1', 'i2'];
    v().uBulkRemove();
    expect(ui.confirm).toMatchObject({
      title: 'Remove 2 people?',
      text: 'The selected people will lose access to Roedy Mail immediately. Pending invitations are revoked. Content is kept.',
      ok: 'Remove',
    });
    ui.confirmOk();
    // Immediately after confirmation, without undo.
    expect(ui.toast).toMatchObject({ text: '2 people removed', undo: false });
    expect(p.selected).toEqual([]);
    expect(listed(p, 'u1')).toBeUndefined();
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ action: 'remove', ids: ['u1', 'i2'] }));
  });

  it('asks before withdrawing a single invitation and reports it as removed', async () => {
    const { p, v } = await loaded({
      'POST users/bulk': [{ body: { changed: ['i2'] } }, { body: { changed: ['i1'] } }],
    });
    p.toggleSelect('i2');
    v().uBulkRemove();
    expect(ui.confirm).toMatchObject({
      title: 'Revoke invitation?',
      text: 'The link in the invitation to paul.long@example.com will stop working.',
      ok: 'Revoke',
    });
    ui.confirmOk();
    // The selection bar always says "removed", without a name with the address.
    expect(ui.toast?.text).toBe('paul.long@example.com removed');
    p.toggleSelect('i1');
    v().uBulkRemove();
    ui.confirmOk();
    expect(ui.toast?.text).toBe('Jane Smith removed');
  });
});

describe('Inviting', () => {
  it('turns separators into chips, checks addresses and locks the name with several', async () => {
    const { p, v } = await loaded();
    v().openInvite();
    expect(v()).toMatchObject({
      inviteOpen: true,
      inviteClosed: false,
      invPh: 'name@example.com',
      invBtn: { dis: true },
    });
    v().onInvEmail('eve.ross@example.com');
    expect(v()).toMatchObject({ invSendLabel: 'Send invitation', invSendShort: 'Send', invBtn: { dis: false } });
    v().onInvEmail('eve.ross@example.com, Eve.Ross@example.com;anna.baker@example.com broken@ x');
    expect(p.invite?.list).toEqual(['eve.ross@example.com', 'anna.baker@example.com', 'broken@']);
    expect(v().invEmail).toBe('x');
    expect(v().invChips.map((c) => [c.label, c.bad, c.tip])).toEqual([
      ['eve.ross@example.com', false, undefined],
      ['anna.baker@example.com', true, 'Already has an account'],
      ['broken@', true, 'Not a valid email address'],
    ]);
    expect(v()).toMatchObject({
      invErr: 'Check 2 addresses. Remove or fix the entries marked in red.',
      hasInvErr: true,
      invBtn: { dis: true },
      invNameDis: true,
      invNamePh: 'Only for a single address',
      invNamePhM: 'Name for a single address only',
      invPh: '',
    });
    v().invChips[2]?.remove();
    expect(v().invErr).toBe('anna.baker@example.com already belongs to an account.');
    v().invChips[1]?.remove();
    v().onInvEmail('broken');
    v().onInvBlur();
    expect(v().invErr).toBe('“broken” isn’t a valid email address.');
    const key = (k: string) => {
      const event = { key: k, preventDefault: vi.fn() };
      v().invKey(event);
      return event;
    };
    expect(key('Backspace').preventDefault).not.toHaveBeenCalled();
    expect(p.invite?.list).toEqual(['eve.ross@example.com']);
    v().onInvEmail('tim.brown@example.com');
    expect(key('Enter').preventDefault).toHaveBeenCalled();
    expect(p.invite?.list).toEqual(['eve.ross@example.com', 'tim.brown@example.com']);
    expect(v()).toMatchObject({ invSendLabel: 'Send 2 invitations', invSendShort: 'Send 2' });
    key('Escape');
    expect(v().inviteOpen).toBe(false);
  });

  it('says "create" instead of "send" without system mail', async () => {
    session.user = { ...ME, system_mail_configured: false };
    const { p, v } = await loaded();
    p.openInvite();
    p.inviteInput('tim.brown@example.com eve.ross@example.com');
    expect(v()).toMatchObject({ invSendLabel: 'Create 2 invitations', invSendShort: 'Create 2' });
    p.removeChip('tim.brown@example.com');
    p.inviteInput('');
    expect(v()).toMatchObject({ invSendLabel: 'Create invitation', invSendShort: 'Create' });
  });

  it('sends addresses, role and name and reports success', async () => {
    const { p, v, calls } = await loaded({
      'POST invites': [
        { status: 201, body: { invites: [{ id: 'n1', email: 'jane@example.com', sent: true }], system_mail: true } },
      ],
    });
    p.openInvite();
    p.inviteInput('jane@example.com');
    p.inviteName('  Smith,\tJane ');
    p.inviteRole('admin');
    p.setFilter('locked');
    await p.sendInvites();
    expect(calls.find((c) => c.path === 'invites')?.body).toEqual({
      emails: ['jane@example.com'],
      role: 'admin',
      name: 'Smith, Jane',
    });
    expect(v()).toMatchObject({ inviteOpen: false, invRes: { show: false } });
    expect(p.filter).toBe('all');
    expect(ui.toast).toMatchObject({ text: 'Invitation sent', undo: false });
    expect(sent(calls).at(-1)).toBe('GET users');
  });

  it('shows the result with "Copy link" if not all mails went out', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const added = [...USERS, invite('n1', 'eve@example.com'), invite('n2', 'nina@example.com', { mail_sent_at: null })];
    const { p, v, calls } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: added } }],
      'POST invites': [
        {
          status: 201,
          body: {
            invites: [
              { id: 'n1', email: 'eve@example.com', sent: true },
              { id: 'n2', email: 'nina@example.com', sent: false },
            ],
            system_mail: true,
          },
        },
      ],
      'GET invites/n2/link': [{ body: { url: '/invite/abc' } }],
      'POST invites/n2/resend': [{ body: { invite: { ...added[7], mail_sent_at: before(0) } } }],
    });
    p.openInvite();
    p.inviteInput('eve@example.com nina@example.com');
    await p.sendInvites();
    expect(v().invRes).toMatchObject({
      show: true,
      off: false,
      icon: 'ti-alert-triangle',
      title: '1 invitation sent, 1 couldn’t be sent',
      text: 'The invitation to this address has been created. Copy the link and share it yourself, or resend the invitation later.',
    });
    expect(v().invRes.rows.map((r) => r.email)).toEqual(['nina@example.com']);
    expect(ui.toast).toBeNull();
    v().invRes.rows[0]?.copy();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/invite/abc`));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Invitation link copied'));
    // After a successful resend the row disappears and with it the result.
    await p.resend(listed(p, 'n2') as ListedUser);
    expect(v().invRes.show).toBe(false);
    expect(sent(calls)).toContain('POST invites/n2/resend');
  });

  it('copies the link within the click gesture via `ClipboardItem` if available', async () => {
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0]?.data['text/plain'];
    });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        data: Record<string, Promise<Blob>>;
        constructor(data: Record<string, Promise<Blob>>) {
          this.data = data;
        }
      },
    );
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write, writeText: vi.fn() } });
    const { p } = await loaded({
      'GET invites/i2/link': [{ body: { url: 'https://mail.example.com/invite/abc' } }],
    });
    await p.copyLink({ id: 'i2' });
    expect(write).toHaveBeenCalledOnce();
    const blob = await write.mock.calls[0]?.[0][0]?.data['text/plain'];
    expect(await blob?.text()).toBe('https://mail.example.com/invite/abc');
    expect(ui.toast?.text).toBe('Invitation link copied');
  });

  it('shows "created" without system mail and reloads `auth/me` if it does not match', async () => {
    const added = [...USERS, invite('n1', 'tim@example.com', { mail_sent_at: null })];
    const { p, v, calls } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: added } }],
      'POST invites': [
        { status: 201, body: { invites: [{ id: 'n1', email: 'tim@example.com', sent: false }], system_mail: false } },
      ],
      'GET auth/me': [{ body: { ...ME, system_mail_configured: false } }],
    });
    p.openInvite();
    p.inviteInput('tim@example.com');
    await p.sendInvites();
    expect(v().invRes).toMatchObject({
      show: true,
      off: true,
      icon: 'ti-mail-off',
      title: 'Invitation created',
      text: 'Without system emails, no invitation is sent. Copy the link and share it yourself.',
    });
    expect(sent(calls)).toContain('GET auth/me');
    await vi.waitFor(() => expect(v().uNoMail).toBe(true));
    v().invRes.close();
    expect(v().invRes.show).toBe(false);
  });

  it('names several failed invitations', async () => {
    const added = [
      ...USERS,
      invite('n1', 'a@example.com', { mail_sent_at: null }),
      invite('n2', 'b@example.com', { mail_sent_at: null }),
    ];
    const { p, v } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: added } }],
      'POST invites': [
        {
          status: 201,
          body: {
            invites: [
              { id: 'n1', email: 'a@example.com', sent: false },
              { id: 'n2', email: 'b@example.com', sent: false },
            ],
            system_mail: true,
          },
        },
      ],
    });
    p.openInvite();
    p.inviteInput('a@example.com b@example.com');
    await p.sendInvites();
    expect(v().invRes).toMatchObject({
      title: '2 invitations couldn’t be sent',
      text: 'The invitations to these addresses have been created. Copy the links and share them yourself, or resend the invitations later.',
    });
  });

  it('marks addresses reported by the server as taken or invalid', async () => {
    const { p, v } = await loaded({
      'POST invites': [
        {
          status: 422,
          body: { error: 'invalid', fields: { 'emails.1': { code: 'taken' }, 'emails.2': { code: 'invalid' } } },
        },
      ],
    });
    p.openInvite();
    p.inviteInput('eve@example.com new@example.com x@example.com');
    await p.sendInvites();
    expect(v().inviteOpen).toBe(true);
    expect(v().invChips.map((c) => c.tip)).toEqual([undefined, 'Already has an account', 'Not a valid email address']);
    expect(v().invErr).toBe('Check 2 addresses. Remove or fix the entries marked in red.');
    expect(ui.toast).toBeNull();
  });

  it('forgets addresses reported by the server with a new form', async () => {
    const { p, v } = await loaded({
      'POST invites': [{ status: 422, body: { error: 'invalid', fields: { 'emails.0': { code: 'taken' } } } }],
    });
    p.openInvite();
    p.inviteInput('new@example.com');
    await p.sendInvites();
    expect(v().invChips[0]?.bad).toBe(true);
    p.closeInvite();
    p.openInvite();
    p.inviteInput('new@example.com ');
    expect(v().invChips[0]?.bad).toBe(false);
  });

  it('reports more than 50 addresses in the form and locks the button without sending', async () => {
    const { p, v, calls } = await loaded();
    p.openInvite();
    p.inviteInput(Array.from({ length: 51 }, (_, i) => `a${String(i)}@example.com`).join(' ') + ' ');
    expect(v()).toMatchObject({
      invErr: 'Up to 50 addresses at a time.',
      hasInvErr: true,
      invBtn: { dis: true },
    });
    await p.sendInvites();
    expect(sent(calls)).not.toContain('POST invites');
    expect(v()).toMatchObject({ inviteOpen: true, invBusy: false });
    // One address fewer: enabled again.
    p.removeChip('a50@example.com');
    expect(v()).toMatchObject({ invErr: '', invBtn: { dis: false } });
  });

  it('reports `emails: too_many` of the server with an error toast without reloading', async () => {
    const { p, v, calls } = await loaded({
      'POST invites': [{ status: 422, body: { error: 'invalid', fields: { emails: { code: 'too_many' } } } }],
    });
    p.openInvite();
    p.inviteInput(Array.from({ length: 50 }, (_, i) => `a${String(i)}@example.com`).join(' '));
    await p.sendInvites();
    expect(ui.toast).toMatchObject({ text: 'Up to 50 addresses at a time.', error: true, undo: false });
    expect(v()).toMatchObject({ inviteOpen: true, invBusy: false });
    expect(sent(calls).filter((c) => c === 'GET users')).toHaveLength(1);
  });

  it('leaves a newly opened form alone when the response of the old one arrives', async () => {
    let release: (value: { status: number; body: unknown }) => void = () => {};
    const { p, v } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: USERS } }, { body: { users: USERS } }],
      'POST invites': [
        () => new Promise((resolve) => (release = resolve)),
        { status: 422, body: { error: 'invalid', fields: { 'emails.0': { code: 'taken' } } } },
      ],
    });
    p.openInvite();
    p.inviteInput('eve@example.com');
    const first = p.sendInvites();
    p.closeInvite();
    p.openInvite();
    p.inviteInput('tim@example.com');
    release({
      status: 201,
      body: { invites: [{ id: 'n1', email: 'eve@example.com', sent: true }], system_mail: true },
    });
    await first;
    expect(v()).toMatchObject({ inviteOpen: true, invEmail: 'tim@example.com' });
    expect(ui.toast?.text).toBe('Invitation sent');
    // If the old form fails, a toast reports it instead of marks in the new one.
    const second = p.sendInvites();
    p.closeInvite();
    p.openInvite();
    await second;
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(v().invChips).toEqual([]);
  });

  it('reports a lock in the form with a running wait time and locks the button', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { p, v, calls } = await loaded({
      'POST invites': [{ status: 429, body: { error: 'rate_limited', retry_after: 70 } }],
    });
    p.openInvite();
    p.inviteInput('eve@example.com');
    await p.sendInvites();
    expect(v()).toMatchObject({
      invErr: 'Too many requests. Try again in 2 minutes.',
      hasInvErr: true,
      invBtn: { dis: true },
    });
    // A change to the addresses does not lift the lock; the wait time runs along.
    p.inviteInput('eve@example.com ');
    vi.advanceTimersByTime(30_000);
    expect(v().invErr).toBe('Too many requests. Try again in 40 seconds.');
    await p.sendInvites();
    expect(sent(calls).filter((c) => c === 'POST invites')).toHaveLength(1);
    vi.advanceTimersByTime(40_000);
    expect(v()).toMatchObject({ invErr: '', hasInvErr: false, invBtn: { dis: false } });
    p.dispose();
  });

  it('reports other errors with an error toast and leaves the form open', async () => {
    const { p, v } = await loaded({ 'POST invites': [{ status: 500, body: { error: 'internal' } }] });
    p.openInvite();
    p.inviteInput('eve@example.com');
    await p.sendInvites();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(v()).toMatchObject({ inviteOpen: true, invBusy: false });
  });

  it('checks length and invisible characters of the name, only with one address', async () => {
    const { p, v, calls } = await loaded();
    p.openInvite();
    p.inviteInput('eve@example.com');
    p.inviteName('E'.repeat(101));
    expect(v()).toMatchObject({ invErr: 'The name is too long.', invBtn: { dis: true } });
    p.inviteName('Eve\u200BRoss');
    expect(v()).toMatchObject({ invErr: 'The name contains invalid characters.', invBtn: { dis: true } });
    await p.sendInvites();
    expect(sent(calls)).not.toContain('POST invites');
    // Control characters (e.g. a tab) become spaces, no error.
    p.inviteName('Eve\tRoss');
    expect(v()).toMatchObject({ invErr: '', invBtn: { dis: false } });
    // With several addresses the name does not apply.
    p.inviteName('E'.repeat(101));
    p.inviteInput('tim@example.com ');
    expect(v().invErr).toBe('');
  });

  it('shows name errors of the server in the form until the name changes', async () => {
    const { p, v } = await loaded({
      'POST invites': [
        { status: 422, body: { error: 'invalid', fields: { name: { code: 'too_long' } } } },
        { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
      ],
    });
    p.openInvite();
    p.inviteInput('eve@example.com');
    p.inviteName('Eve Ross');
    await p.sendInvites();
    expect(v()).toMatchObject({ inviteOpen: true, invErr: 'The name is too long.', invBtn: { dis: true } });
    expect(ui.toast).toBeNull();
    p.inviteName('Eve R.');
    expect(v().invErr).toBe('');
    await p.sendInvites();
    expect(v().invErr).toBe('The name contains invalid characters.');
    expect(ui.toast).toBeNull();
  });
});

describe('Actions per row', () => {
  it('changes the role with undo and sends after expiry (`PATCH users/:id`, `invites/:id`)', async () => {
    const { p, v, calls } = await loaded({
      'PATCH users/u2': [{ body: {} }],
      'PATCH invites/i1': [{ body: {} }],
    });
    p.toggleOpen('u2');
    const cards = row(v(), 'Luke Walker').roles;
    expect(cards.map((c) => [c.label, c.desc, c.on])).toEqual([
      ['Administrator', 'Manages users and settings', false],
      ['User', 'Uses their own email accounts', true],
    ]);
    cards[0]?.onClick();
    expect(listed(p, 'u2')?.role).toBe('admin');
    expect(ui.toast).toMatchObject({ text: 'Role changed', undo: true });
    ui.toasts.undo();
    expect(listed(p, 'u2')?.role).toBe('user');
    cards[0]?.onClick();
    p.toggleOpen('i1');
    row(v(), 'Jane Smith').roles[0]?.onClick();
    await ui.toasts.flush();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body])).toEqual([
      ['users/u2', { role: 'admin' }],
      ['invites/i1', { role: 'admin' }],
    ]);
  });

  it('keeps changes the server does not know yet when reloading', async () => {
    const { p, v, calls } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: USERS } }, { body: { users: USERS } }],
      'POST users/u2/lock': [{ body: {} }],
      'DELETE users/u1': [() => new Promise(() => {})],
    });
    row(v(), 'Luke Walker').lock();
    ui.confirmOk();
    // The toast is still running: after reloading the lock stays visible.
    await p.load();
    expect(listed(p, 'u2')?.status).toBe('locked');
    await ui.toasts.flush();
    expect(sent(calls)).toContain('POST users/u2/lock');
    // Afterwards the server state applies (the mock responds unchanged).
    await p.load();
    expect(listed(p, 'u2')?.status).toBe('active');
    // A removal still on its way does not bring the row back.
    row(v(), 'Anna Baker').remove();
    ui.confirmOk();
    await p.load();
    expect(listed(p, 'u1')).toBeUndefined();
  });

  it('reverts a failed change and reloads', async () => {
    const { p, v, calls } = await loaded({ 'PATCH users/u2': [{ status: 404, body: { error: 'not_found' } }] });
    p.toggleOpen('u2');
    row(v(), 'Luke Walker').roles[0]?.onClick();
    await ui.toasts.flush();
    expect(listed(p, 'u2')?.role).toBe('user');
    expect(ui.toast).toMatchObject({
      text: 'The role wasn’t changed. Please try again.',
      error: true,
      undo: false,
    });
    await vi.waitFor(() => expect(sent(calls).at(-1)).toBe('GET users'));
  });

  it('names what did not work when locking and unlocking fail', async () => {
    const { p, v } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: USERS } }, { body: { users: USERS } }],
      'POST users/u2/lock': [{ status: 500, body: {} }],
      'POST users/u3/unlock': [{ status: 500, body: {} }],
    });
    row(v(), 'Luke Walker').lock();
    ui.confirmOk();
    await ui.toasts.flush();
    expect(listed(p, 'u2')?.status).toBe('active');
    expect(ui.toast).toMatchObject({
      text: 'The account wasn’t suspended. Please try again.',
      error: true,
    });
    row(v(), 'Sophie Hamilton').unlock();
    await ui.toasts.flush();
    expect(listed(p, 'u3')?.status).toBe('locked');
    expect(ui.toast?.text).toBe('The account wasn’t reactivated. Please try again.');
  });

  it('names "No connection" instead of the action text without a connection', async () => {
    // No response for `PATCH users/u2`: `fetch` fails.
    const { p, v } = await loaded({
      'GET users': [{ body: { users: USERS } }, { body: { users: USERS } }],
    });
    p.toggleOpen('u2');
    row(v(), 'Luke Walker').roles[0]?.onClick();
    await ui.toasts.flush();
    expect(listed(p, 'u2')?.role).toBe('user');
    expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
  });

  it('reports a failed reload of the list with an error toast', async () => {
    const { p, v } = await loaded({
      'GET users': [{ body: { users: USERS } }, { status: 500, body: { error: 'internal' } }],
    });
    await p.load();
    expect(p.status).toBe('ready');
    expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
    expect(v().uRows).toHaveLength(6);
  });

  it('locks after confirmation with undo and unlocks', async () => {
    const { p, v, calls } = await loaded({
      'POST users/u2/lock': [{ body: {} }],
      'POST users/u3/unlock': [{ body: {} }],
    });
    row(v(), 'Luke Walker').lock();
    expect(ui.confirm).toMatchObject({
      title: 'Suspend Luke Walker?',
      text: 'Luke Walker will be signed out immediately and can’t sign in until you reactivate the account.',
      icon: 'ti-lock',
      ok: 'Suspend',
    });
    ui.confirmOk();
    expect(listed(p, 'u2')?.status).toBe('locked');
    expect(ui.toast).toMatchObject({ text: 'Luke Walker suspended', undo: true });
    row(v(), 'Sophie Hamilton').unlock();
    expect(ui.toast).toMatchObject({ text: 'Sophie Hamilton reactivated', undo: true });
    await ui.toasts.flush();
    expect(sent(calls).slice(-2)).toEqual(['POST users/u2/lock', 'POST users/u3/unlock']);
  });

  it('removes immediately after confirmation, without undo, and reverts it on an error', async () => {
    const { p, v, calls } = await loaded({
      'DELETE users/u2': [{ status: 204 }],
      'DELETE invites/i2': [{ status: 500, body: { error: 'internal' } }],
    });
    p.toggleOpen('u2');
    row(v(), 'Luke Walker').remove();
    expect(ui.confirm).toMatchObject({
      title: 'Remove Luke Walker?',
      text: 'Luke Walker will lose access to Roedy Mail immediately. Their content is kept.',
      icon: 'ti-user-minus',
      ok: 'Remove',
    });
    ui.confirmOk();
    expect(listed(p, 'u2')).toBeUndefined();
    expect(p.open).toBeNull();
    expect(ui.toast).toMatchObject({ text: 'Luke Walker removed', undo: false });
    row(v(), 'paul.long@example.com').remove();
    expect(ui.confirm?.title).toBe('Revoke invitation?');
    ui.confirmOk();
    expect(ui.toast?.text).toBe('Invitation revoked');
    await vi.waitFor(() => expect(listed(p, 'i2')).toBeDefined());
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(sent(calls)).toEqual(expect.arrayContaining(['DELETE users/u2', 'DELETE invites/i2']));
  });

  it('resets multi-factor immediately after confirmation, without undo', async () => {
    const { p, v, calls } = await loaded({
      'POST users/u2/reset-mfa': [{ body: {} }],
      'POST users/u1/reset-mfa': [{ status: 409, body: { error: 'mfa_disabled' } }],
    });
    row(v(), 'Luke Walker').mfaReset();
    expect(ui.confirm).toMatchObject({
      title: 'Reset multi-factor for Luke Walker?',
      text: 'All authenticator apps and recovery codes of Luke Walker will be removed. Luke Walker will then sign in with just the password and can set up an app again under Account › Security.',
      icon: 'ti-shield-off',
      ok: 'Reset',
      danger: true,
    });
    ui.confirmOk();
    expect(row(v(), 'Luke Walker')).toMatchObject({ mfa: false, canMfaReset: false });
    expect(ui.toast).toMatchObject({ text: 'Multi-factor reset for Luke Walker', undo: false });
    row(v(), 'Anna Baker').mfaReset();
    ui.confirmOk();
    await vi.waitFor(() => expect(listed(p, 'u1')?.mfa).toBe(true));
    expect(sent(calls)).toEqual(expect.arrayContaining(['POST users/u2/reset-mfa', 'POST users/u1/reset-mfa']));
  });

  it('resends an invitation and shows a failed mail in the row', async () => {
    const { p, v } = await loaded({
      'POST invites/i2/resend': [
        { status: 502, body: { error: 'mail_failed' } },
        { status: 429, body: { error: 'rate_limited', retry_after: 30 } },
        { body: { invite: { ...invite('i2', 'paul.long@example.com'), mail_sent_at: before(0) } } },
      ],
    });
    p.toggleOpen('i2');
    await p.resend(listed(p, 'i2') as ListedUser);
    expect(row(v(), 'paul.long@example.com')).toMatchObject({
      hasSendNote: true,
      sendNote: 'The invitation couldn’t be resent. Copy the link and share it yourself, or try again later.',
    });
    await p.resend(listed(p, 'i2') as ListedUser);
    expect(ui.toast?.text).toBe('Too many requests. Try again in 30 seconds.');
    await p.resend(listed(p, 'i2') as ListedUser);
    expect(row(v(), 'paul.long@example.com')).toMatchObject({ sendErr: false, hasSendNote: false });
    expect(ui.toast?.text).toBe('Invitation resent');
    // Expanding another row discards the message (the send failure).
    p.sendFail = 'i2';
    p.toggleOpen('u1');
    expect(p.sendFail).toBeNull();
  });

  it('extends an expired invitation and shows the new row', async () => {
    prefs.values.tzAuto = false;
    prefs.values.tz = 'Europe/Berlin';
    const old = invite('i3', 'eve.ross@example.com', { name: 'Eve Ross', expires_at: before(5), expired: true });
    const renewed = { ...old, expires_at: before(-168), expired: false };
    const { p, v, calls } = await loaded(
      {
        'POST invites/i3/renew': [{ body: { invite: renewed } }, { status: 404, body: { error: 'not_found' } }],
      },
      [...USERS, old],
    );
    const extending = p.extend(listed(p, 'i3') as ListedUser);
    expect(p.busy.has('i3')).toBe(true);
    // A second click while the request is running sends nothing.
    await p.extend(listed(p, 'i3') as ListedUser);
    await extending;
    expect(sent(calls).filter((c) => c === 'POST invites/i3/renew')).toHaveLength(1);
    expect(p.busy.has('i3')).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Invitation extended until 2 November', undo: false, error: false });
    expect(row(v(), 'Eve Ross')).toMatchObject({
      st: 'Invited',
      expired: false,
      canExtend: false,
      canCopy: true,
      hasValid: true,
      validUntil: 'Valid until 2 November',
      hasSendNote: false,
    });
    // Withdrawn in the meantime: error toast and reload the list.
    row(v(), 'Eve Ross').extend();
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(ui.toast?.text).toBe('That didn’t work. Please try again.');
    await vi.waitFor(() => expect(sent(calls).at(-1)).toBe('GET users'));
  });

  it('discards the message of a failed "Resend" after "Extend"', async () => {
    const old = invite('i3', 'eve.ross@example.com', { name: 'Eve Ross', expires_at: before(5), expired: true });
    const { p, v } = await loaded(
      {
        'POST invites/i3/resend': [{ status: 502, body: { error: 'mail_failed' } }],
        'POST invites/i3/renew': [{ body: { invite: { ...old, expires_at: before(-168), expired: false } } }],
      },
      [...USERS, old],
    );
    await p.resend(listed(p, 'i3') as ListedUser);
    expect(p.sendFail).toBe('i3');
    await p.extend(listed(p, 'i3') as ListedUser);
    expect(p.sendFail).toBeNull();
    expect(row(v(), 'Eve Ross').hasSendNote).toBe(false);
  });

  it('shows an invitation as expired as soon as its time is up, without reloading', async () => {
    const soon = invite('i4', 'max.cole@example.com', { name: 'Max Cole', expires_at: before(-1), expired: false });
    const { p } = await loaded({}, [...USERS, soon]);
    const at = (now: number) => rowsValues(p, ctx, now).find((r) => r.name === 'Max Cole');
    expect(at(NOW)).toMatchObject({ expired: false, canCopy: true });
    expect(at(NOW + 2 * 3_600_000)).toMatchObject({ expired: true, canCopy: false, canExtend: true, st: 'Expired' });
  });

  it('reports "Couldn’t copy" if the clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no'))) },
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const { p } = await loaded({ 'GET invites/i2/link': [{ body: { url: '/invite/abc' } }] });
    await p.copyLink({ id: 'i2' });
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(ui.toast).toMatchObject({ text: 'Couldn’t copy.', error: true });
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('reports an error without a session or role and reloads the account', async () => {
    const { v, calls } = await loaded({
      'DELETE users/u2': [{ status: 403, body: { error: 'forbidden' } }],
      'GET auth/me': [{ body: { ...ME, role: 'user' } }],
    });
    row(v(), 'Luke Walker').remove();
    ui.confirmOk();
    await vi.waitFor(() => expect(session.isAdmin).toBe(false));
    // Instead of reloading the list, the layout then shows "Access denied".
    expect(sent(calls).filter((c) => c === 'GET users')).toHaveLength(1);
  });
});

describe('Reopening', () => {
  const offline = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );

  it('shows the list of the last open page at once and replaces it with the new one', async () => {
    const { p } = await loaded();
    p.dispose();
    const later = USERS.filter((u) => u.id !== 'u3');
    mockApi({ 'GET users': [{ body: { users: later } }] });
    const q = new UsersPage();
    expect(q.status).toBe('ready');
    expect(q.rows.map((u) => u.id)).toEqual(USERS.map((u) => u.id));
    await q.load();
    expect(q.rows.map((u) => u.id)).toEqual(later.map((u) => u.id));
  });

  it('keeps the list with the toast "Couldn’t update the list." if loading fails, also without a connection', async () => {
    const { p } = await loaded();
    p.dispose();
    for (const fail of [() => mockApi({ 'GET users': [{ status: 500, body: { error: 'internal' } }] }), offline]) {
      fail();
      const q = new UsersPage();
      await q.load();
      expect(q.status).toBe('ready');
      expect(q.rows).toHaveLength(USERS.length);
      expect(ui.toast).toMatchObject({ text: 'Couldn’t update the list.', error: true });
      ui.reset();
      q.dispose();
    }
  });

  it('a later reload of the open page still reports "No connection" without a connection', async () => {
    const { p } = await loaded();
    p.dispose();
    mockApi({ 'GET users': [{ body: { users: USERS } }] });
    const q = new UsersPage();
    await q.load();
    offline();
    await q.load();
    expect(ui.toast?.text).toBe('No connection. Please try again.');
  });

  it('keeps changes the server confirmed, not those still on their way', async () => {
    const { p } = await loaded({
      'DELETE users/u3': [{ status: 204 }],
      'DELETE users/u2': [() => new Promise(() => {})],
    });
    const row = (id: string) => {
      const u = p.rows.find((x) => x.id === id);
      if (!u) throw new Error(`no ${id}`);
      return u;
    };
    p.remove(row('u3'));
    ui.confirmOk();
    // Response of the server.
    await new Promise((resolve) => setTimeout(resolve, 0));
    p.remove(row('u2'));
    ui.confirmOk();
    expect(p.rows.map((u) => u.id)).not.toContain('u2');
    p.setRole(row('u1'), 'user');
    p.dispose();
    const kept = new UsersPage().rows;
    expect(kept.map((u) => u.id)).not.toContain('u3');
    // Removal still on its way (it may yet fail): the server still knows the user.
    expect(kept.map((u) => u.id)).toContain('u2');
    // Role change with undo not sent yet: the role the server knows.
    expect(kept.find((u) => u.id === 'u1')?.role).toBe('admin');
  });

  it('a reload that started before a confirmed removal does not bring the user back', async () => {
    const { p } = await loaded();
    p.dispose();
    let answer: (reply: { body: { users: ListedUser[] } }) => void = () => {};
    const later = USERS.filter((u) => u.id !== 'u3');
    mockApi({
      'GET users': [() => new Promise((resolve) => (answer = resolve)), { body: { users: later } }],
      'DELETE users/u3': [{ status: 204 }],
    });
    const q = new UsersPage();
    const load = q.load();
    const u3 = q.rows.find((u) => u.id === 'u3');
    if (!u3) throw new Error('no u3');
    q.remove(u3);
    ui.confirmOk();
    // Response of the server.
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer({ body: { users: USERS } });
    await load;
    await vi.waitFor(() => expect(q.rows.map((u) => u.id)).toEqual(later.map((u) => u.id)));
  });

  it('a removal the left page confirms later makes the reopened page load again', async () => {
    let removed: (reply: { status: number }) => void = () => {};
    let answer: (reply: { body: { users: ListedUser[] } }) => void = () => {};
    const later = USERS.filter((u) => u.id !== 'u3');
    const { p } = await loaded({ 'DELETE users/u3': [() => new Promise((resolve) => (removed = resolve))] });
    const u3 = p.rows.find((u) => u.id === 'u3');
    if (!u3) throw new Error('no u3');
    p.remove(u3);
    ui.confirmOk();
    p.dispose();
    mockApi({ 'GET users': [() => new Promise((resolve) => (answer = resolve)), { body: { users: later } }] });
    const q = new UsersPage();
    expect(q.rows.map((u) => u.id)).toContain('u3');
    const load = q.load();
    removed({ status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer({ body: { users: USERS } });
    await load;
    await vi.waitFor(() => expect(q.rows.map((u) => u.id)).toEqual(later.map((u) => u.id)));
  });

  it('an extension the left page confirms later makes the reopened page load again', async () => {
    const old = invite('i3', 'old@example.com', { expires_at: before(1), expired: true });
    const renewed = { ...old, expires_at: before(-168), expired: false };
    let done: (reply: { body: { invite: ListedUser } }) => void = () => {};
    let answer: (reply: { body: { users: ListedUser[] } }) => void = () => {};
    const { p } = await loaded({ 'POST invites/i3/renew': [() => new Promise((resolve) => (done = resolve))] }, [
      ...USERS,
      old,
    ]);
    const extending = p.extend(old);
    p.dispose();
    mockApi({
      'GET users': [() => new Promise((resolve) => (answer = resolve)), { body: { users: [...USERS, renewed] } }],
    });
    const q = new UsersPage();
    const load = q.load();
    done({ body: { invite: renewed } });
    await extending;
    answer({ body: { users: [...USERS, old] } });
    await load;
    await vi.waitFor(() => expect(q.rows.find((u) => u.id === 'i3')?.expired).toBe(false));
  });

  it('signing out discards the list, also of a page left afterwards', async () => {
    const { p } = await loaded();
    p.dispose();
    const { p: open } = await loaded();
    forgetAccount();
    open.dispose();
    const q = new UsersPage();
    expect([q.status, q.rows]).toEqual(['loading', []]);
  });

  it('keeps nothing from a page that has not loaded', () => {
    new UsersPage().dispose();
    expect(new UsersPage().status).toBe('loading');
  });
});
