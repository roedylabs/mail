import { describe, expect, it, vi } from 'vitest';
import {
  accountSwitch,
  accountTitle,
  activeLocation,
  inScope,
  mailboxCommands,
  mobileRows,
  navRowsFor,
  sidebarScope,
  switcherValues,
  type ActiveInput,
} from './mailbox-nav.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';

function account(id: string): MailAccount {
  return {
    id,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    url: 'https://mail.example.com',
    host: 'mail.example.com',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
  };
}

const LIST = [account('a1'), account('a2')];

describe('mailboxes in sidebar and palette', () => {
  it('shows the account of the address, otherwise the default account or the first one', () => {
    const id = (s: ReturnType<typeof sidebarScope>) => s.account?.id;
    expect(id(sidebarScope(LIST, 'a2', { account: 'a1', role: 'inbox', thread: null }))).toBe('a1');
    expect(id(sidebarScope(LIST, 'a2', { account: 'missing', role: 'inbox', thread: null }))).toBe('a2');
    expect(id(sidebarScope(LIST, null, null))).toBe('a1');
    expect(sidebarScope(LIST, 'a2', null)).toMatchObject({ all: false, key: 'a2' });
    expect(sidebarScope(null, 'a1', null)).toEqual({ all: false, account: null, key: null });
  });

  it('shows "All accounts" for /mailbox/all or as default, only with more than one account', () => {
    const all = { all: true, account: null, key: 'all' };
    expect(sidebarScope(LIST, 'a2', { account: 'all', role: 'sent', thread: null })).toEqual(all);
    // Without a mailbox in the address the default "All accounts" applies, with a mailbox the address.
    expect(sidebarScope(LIST, 'all', null)).toEqual(all);
    expect(sidebarScope(LIST, 'all', { account: 'a2', role: 'inbox', thread: null })).toMatchObject({ key: 'a2' });
    // An unknown account in the address (e.g. removed) follows the default.
    expect(sidebarScope(LIST, 'all', { account: 'missing', role: 'inbox', thread: null })).toEqual(all);
    // With one account, `all` shows that account.
    expect(sidebarScope([account('a1')], 'all', { account: 'all', role: 'inbox', thread: null })).toMatchObject({
      all: false,
      key: 'a1',
    });
  });

  it('maps the address to the view; with one account `all` counts as that account', () => {
    const loc = (account: string) => ({ account, role: 'inbox' as const, thread: null });
    const one = sidebarScope(LIST, 'a1', null);
    expect(inScope(one, loc('a1'))).toBe(true);
    expect(inScope(one, loc('a2'))).toBe(false);
    expect(inScope(sidebarScope(LIST, 'all', null), loc('all'))).toBe(true);
    expect(inScope(sidebarScope([account('a1')], null, loc('all')), loc('all'))).toBe(true);
    expect(inScope(one, null)).toBe(false);
    expect(inScope(sidebarScope(null, null, null), loc('all'))).toBe(false);
  });

  describe('active mailbox', () => {
    const sent = { account: 'a2', role: 'sent' as const, thread: null };
    const folder = { account: 'a2', folder: 'f1', thread: 'th1' };
    const tag = { account: 'all', tag: 't1', thread: null };
    const at = (path: string, lastMailbox: ActiveInput['lastMailbox'], results = false): ActiveInput => ({
      path,
      location: null,
      lastMailbox,
      results,
    });

    it('is that of the address', () => {
      const scope = sidebarScope(LIST, 'a1', sent);
      expect(activeLocation(scope, { ...at('/mailbox/a2/sent', null), location: sent })).toEqual(sent);
      // A mailbox of another view is not active.
      expect(activeLocation(sidebarScope(LIST, 'a1', null), { ...at('/mailbox/a2/sent', null), location: sent })).toBe(
        null,
      );
    });

    it('stays the folder, tag or mailbox the user came from while compose is open', () => {
      expect(activeLocation(sidebarScope(LIST, 'a1', sent), at('/compose/new', sent))).toEqual(sent);
      expect(activeLocation(sidebarScope(LIST, 'a1', folder), at('/compose/d1', folder))).toEqual(folder);
      expect(activeLocation(sidebarScope(LIST, 'a1', tag), at('/compose/new', tag))).toEqual(tag);
    });

    it('is the inbox of the view when compose is opened without a previous mailbox', () => {
      expect(activeLocation(sidebarScope(LIST, 'a2', null), at('/compose/new', null))).toEqual({
        account: 'a2',
        role: 'inbox',
        thread: null,
      });
      expect(activeLocation(sidebarScope(LIST, 'all', null), at('/compose/new', null))).toEqual({
        account: 'all',
        role: 'inbox',
        thread: null,
      });
      expect(activeLocation(sidebarScope(null, null, null), at('/compose/new', null))).toBeNull();
    });

    it('stays the folder, tag or mailbox the user came from on the error page, also after the search', () => {
      expect(activeLocation(sidebarScope(LIST, 'a1', sent), { ...at('/nope', sent), error: true })).toEqual(sent);
      expect(activeLocation(sidebarScope(LIST, 'a1', folder), { ...at('/nope', folder), error: true })).toEqual(folder);
      expect(activeLocation(sidebarScope(LIST, 'a1', tag), { ...at('/nope', tag), error: true })).toEqual(tag);
      // The error page closes the search results.
      expect(activeLocation(sidebarScope(LIST, 'a1', sent), { ...at('/nope', sent, true), error: true })).toEqual(sent);
      // "Access denied" in the administration.
      expect(activeLocation(sidebarScope(LIST, 'a1', sent), { ...at('/admin/users', sent), error: true })).toEqual(
        sent,
      );
    });

    it('is the inbox of the view on the error page without a previous mailbox (the start view)', () => {
      expect(activeLocation(sidebarScope(LIST, 'a1', null), { ...at('/nope', null), error: true })).toEqual({
        account: 'a1',
        role: 'inbox',
        thread: null,
      });
      expect(activeLocation(sidebarScope(LIST, 'all', null), { ...at('/nope', null), error: true })).toEqual({
        account: 'all',
        role: 'inbox',
        thread: null,
      });
      expect(activeLocation(sidebarScope(null, null, null), { ...at('/nope', null), error: true })).toBeNull();
    });

    it('is none on other pages and in compose with the search results open', () => {
      const scope = sidebarScope(LIST, 'a1', sent);
      expect(activeLocation(scope, at('/search', sent, true))).toBeNull();
      expect(activeLocation(scope, at('/compose/new', sent, true))).toBeNull();
      expect(activeLocation(scope, at('/compose/new', null, true))).toBeNull();
      expect(activeLocation(scope, at('/settings/general', sent))).toBeNull();
    });
  });

  it('builds the account switch for an account, "All accounts" and without an account', () => {
    const one = sidebarScope(LIST, 'a1', null);
    expect(accountSwitch({ scope: one, count: 2, open: false, wide: true })).toMatchObject({
      email: 'a1@example.com',
      title: 'a1',
      sub: 'a1@example.com',
      letter: 'A',
      isAll: false,
      tip: undefined,
    });
    // Collapsed with tooltip, open without.
    expect(accountSwitch({ scope: one, count: 2, open: false, wide: false }).tip).toBe('a1@example.com');
    expect(accountSwitch({ scope: one, count: 2, open: true, wide: false }).tip).toBeUndefined();
    const all = accountSwitch({ scope: sidebarScope(LIST, 'all', null), count: 2, open: false, wide: false });
    expect(all).toMatchObject({
      email: 'All accounts',
      title: 'All accounts',
      sub: '2 mailboxes',
      letter: '',
      isAll: true,
    });
    expect(all.tip).toBe('All accounts');
    const none = accountSwitch({ scope: sidebarScope([], null, null), count: 0, open: false, wide: true });
    expect(none).toMatchObject({ email: 'Add email account', letter: '+', sub: '' });
    const reauth = sidebarScope([{ ...account('a1'), state: 'needs_reauth' }], null, null);
    expect(accountSwitch({ scope: reauth, count: 1, open: false, wide: true }).warn).toBe(true);
  });

  it('titles the account switch with the identity name, otherwise the part before the @', () => {
    const mine = { name: 'Anna Becker', email: 'a1@example.com' };
    const alias = { name: 'Info', email: 'info@example.com' };
    // The identity with the account's address, otherwise the first one.
    expect(accountTitle('a1@example.com', [alias, mine])).toBe('Anna Becker');
    expect(accountTitle('a1@example.com', [alias])).toBe('Info');
    // Without a name, without identities or before they are loaded: the part before the @.
    expect(accountTitle('a1@example.com', [{ ...mine, name: '' }, alias])).toBe('a1');
    expect(accountTitle('a1@example.com', [])).toBe('a1');
    expect(accountTitle('a1@example.com', null)).toBe('a1');
    // Without a part before the @ the address.
    expect(accountTitle('@example.com', null)).toBe('@example.com');
    const one = sidebarScope(LIST, 'a1', null);
    const sw = accountSwitch({ scope: one, count: 2, open: false, wide: false, identities: [alias, mine] });
    // Only the title follows the identity; address, subline and tooltip stay the address.
    expect(sw).toMatchObject({ title: 'Anna Becker', email: 'a1@example.com', sub: 'a1@example.com' });
    expect(sw.tip).toBe('a1@example.com');
    // "All accounts" stays unchanged.
    const all = sidebarScope(LIST, 'all', null);
    expect(accountSwitch({ scope: all, count: 2, open: false, wide: true, identities: [mine] }).title).toBe(
      'All accounts',
    );
  });

  it('builds the account switcher popup with check mark, default and "All accounts"', () => {
    const pick = vi.fn();
    const input = { list: LIST, defaultId: 'a2', isMobile: false, pick, add: vi.fn(), manage: vi.fn(), close: vi.fn() };
    const v = switcherValues({ ...input, scope: sidebarScope(LIST, 'a2', null) });
    expect(v.acctAll).toMatchObject({ show: true, checked: false, n: '2 mailboxes' });
    expect(v.acctList.map((a) => [a.id, a.checked, a.isDef, a.host])).toEqual([
      ['a1', false, false, 'mail.example.com'],
      ['a2', true, true, 'mail.example.com'],
    ]);
    expect(v.allTiles).toHaveLength(2);
    v.acctList[0]?.onClick();
    v.acctAll.onClick();
    expect(pick.mock.calls).toEqual([['a1'], ['all']]);
    // In "All accounts" no account is checked; the default "All accounts" marks none.
    const all = switcherValues({ ...input, defaultId: 'all', scope: sidebarScope(LIST, 'all', null) });
    expect(all.acctAll.checked).toBe(true);
    expect(all.acctList.some((a) => a.checked || a.isDef)).toBe(false);
    // Without a default account the first one applies; with one account no "All accounts".
    const single = switcherValues({
      ...input,
      list: [account('a1')],
      defaultId: null,
      scope: sidebarScope(LIST, null, null),
    });
    expect(single.acctAll.show).toBe(false);
    expect(single.acctList[0]?.isDef).toBe(true);
    // Default "All accounts" with only one account left: that one is the default.
    const left = switcherValues({
      ...input,
      list: [account('a1')],
      defaultId: 'all',
      scope: sidebarScope(LIST, null, null),
    });
    expect(left.acctList[0]?.isDef).toBe(true);
  });

  it('builds the mailboxes of the sheet without counts', () => {
    const open = vi.fn();
    const rows = mobileRows('sent', open);
    expect(rows.map((r) => [r.label, r.on, r.fw])).toEqual([
      ['Inbox', false, 600],
      ['Sent', true, 800],
      ['Drafts', false, 600],
      ['Scheduled', false, 600],
      ['Trash', false, 600],
      ['Spam', false, 600],
    ]);
    rows[5]?.onClick();
    expect(open).toHaveBeenCalledWith('spam');
  });

  it('builds the "Mailboxes" rows: count only with content, tooltip collapsed with key', () => {
    const open = vi.fn();
    const rows = navRowsFor({
      active: 'sent',
      counts: (role) =>
        role === 'inbox' ? { unread: 4, total: 15 } : role === 'trash' ? { unread: 0, total: 0 } : null,
      wide: false,
      keys: true,
      open,
    });
    expect(rows.map((r) => r.label)).toEqual(['Inbox', 'Sent', 'Drafts', 'Scheduled', 'Trash', 'Spam']);
    expect(rows.map((r) => r.icon)).toEqual([
      'ti-inbox',
      'ti-send',
      'ti-file-pencil',
      'ti-clock',
      'ti-trash',
      'ti-alert-octagon',
    ]);
    expect(rows[0]).toMatchObject({ hasCnt: true, cntU: '4', cntN: '15', cntLabel: '4 unread of 15', on: false });
    expect(rows[0]?.tip).toBe('Inbox (1)');
    expect(rows[1]).toMatchObject({ on: true, fw: 800, shadow: 'var(--sh1)', hasCnt: false });
    expect(rows[4]?.hasCnt).toBe(false);
    rows[5]?.onClick();
    expect(open).toHaveBeenCalledWith('spam');

    const wide = navRowsFor({ active: null, counts: () => null, wide: true, keys: true, open });
    expect(wide[0]?.tip).toBeUndefined();
    const noKeys = navRowsFor({ active: null, counts: () => null, wide: false, keys: false, open });
    expect(noKeys[0]?.tip).toBe('Inbox');
  });

  it('offers the mailboxes of every account in the palette', () => {
    const open = vi.fn();
    const commands = mailboxCommands(LIST, open);
    expect(commands).toHaveLength(12);
    expect(commands[0]).toMatchObject({ g: 'Navigation', label: 'Inbox · a1@example.com', icon: 'ti-inbox' });
    expect(commands[11]?.label).toBe('Spam · a2@example.com');
    expect(commands.some((c) => c.k)).toBe(false);
    commands[7]?.run();
    expect(open).toHaveBeenCalledWith('a2', 'sent');
  });
});
