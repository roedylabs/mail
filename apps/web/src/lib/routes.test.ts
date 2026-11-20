import { describe, expect, it } from 'vitest';
import {
  chromeOf,
  inNoAccountView,
  isAdminPath,
  isSettingsPath,
  isAppPath,
  locationAccounts,
  mailboxParams,
  mailboxPath,
  parseMailboxPath,
  redactPath,
  redirectFor,
} from './routes.ts';

describe('chromeOf', () => {
  it('assigns pages to the shell', () => {
    expect(chromeOf('/login', true)).toBe('bare');
    expect(chromeOf('/setup', false)).toBe('bare');
    expect(chromeOf('/confirm-email/abc', true)).toBe('bare');
    expect(chromeOf('/oauth/callback', true)).toBe('bare');
    expect(chromeOf('/password/forgot', true)).toBe('bare');
    expect(chromeOf('/start', true)).toBe('main');
    expect(chromeOf('/mailbox/all/inbox', true)).toBe('main');
    expect(chromeOf('/error/404', true)).toBe('main');
    expect(chromeOf('/error/404', false)).toBe('bare');
    expect(chromeOf('/settings/appearance', true)).toBe('panel');
    expect(chromeOf('/account/mail-accounts/01J/overview', true)).toBe('panel');
    expect(chromeOf('/admin/users', true)).toBe('panel');
    expect(chromeOf('/logins', true)).toBe('main');
  });

  it('leaves tokens from mails out of addresses', () => {
    expect(redactPath('/invite/secret')).toBe('/invite/…');
    expect(redactPath('/password/reset/secret')).toBe('/password/reset/…');
    expect(redactPath('/confirm-email/secret')).toBe('/confirm-email/…');
    expect(redactPath('/error/500')).toBe('/error/500');
  });

  it('recognizes administration pages', () => {
    expect(isAdminPath('/admin/maintenance')).toBe(true);
    expect(isAdminPath('/account/profile')).toBe(false);
  });

  it('counts the account pages as settings, not those of a single email account', () => {
    expect(isSettingsPath('/settings/appearance')).toBe(true);
    expect(isSettingsPath('/account/profile')).toBe(true);
    expect(isSettingsPath('/account/mail-accounts')).toBe(true);
    expect(isSettingsPath('/account/mail-accounts/new')).toBe(true);
    expect(isSettingsPath('/account/security')).toBe(true);
    expect(isSettingsPath('/account/mail-accounts/a1/overview')).toBe(false);
    expect(isSettingsPath('/admin/users')).toBe(false);
    expect(isSettingsPath('/start')).toBe(false);
  });
});

describe('redirectFor', () => {
  const setup = { setupRequired: true, authed: false };
  const guest = { setupRequired: false, authed: false };
  const user = { setupRequired: false, authed: true };

  it('leads only to setup without an administrator', () => {
    expect(redirectFor('/', setup)).toBe('/setup');
    expect(redirectFor('/login', setup)).toBe('/setup');
    expect(redirectFor('/setup', setup)).toBeNull();
  });

  it('keeps the setup that has just signed in until it opens Administration itself', () => {
    expect(redirectFor('/setup', user)).toBe('/start');
    expect(redirectFor('/setup', { ...user, leavingSetup: true })).toBeNull();
    expect(redirectFor('/login', { ...user, leavingSetup: true })).toBe('/start');
    expect(redirectFor('/setup', { ...guest, leavingSetup: true })).toBe('/login');
  });

  it('keeps guests on guest pages only', () => {
    expect(redirectFor('/', guest)).toBe('/login');
    expect(redirectFor('/setup', guest)).toBe('/login');
    expect(redirectFor('/start', guest)).toBe('/login');
    expect(redirectFor('/login', guest)).toBeNull();
    expect(redirectFor('/invite/abc', guest)).toBeNull();
    expect(redirectFor('/password/reset/abc', guest)).toBeNull();
    expect(redirectFor('/password/forgot', guest)).toBeNull();
    expect(redirectFor('/confirm-email/abc', guest)).toBeNull();
  });

  it('shows guests the 404 page for unknown paths', () => {
    expect(redirectFor('/unknown', guest)).toBeNull();
    expect(redirectFor('/settings/general', guest)).toBe('/login');
    expect(redirectFor('/mailbox/a1/inbox', guest)).toBe('/login');
  });

  it('leads signed-in users to the start page', () => {
    expect(redirectFor('/', user)).toBe('/start');
    expect(redirectFor('/login', user)).toBe('/start');
    expect(redirectFor('/setup', user)).toBe('/start');
    expect(redirectFor('/start', user)).toBeNull();
    expect(redirectFor('/confirm-email/abc', user)).toBeNull();
    expect(redirectFor('/password/forgot', user)).toBeNull();
  });

  it('shows "No account" instead of the start page and mailboxes without a mail account', () => {
    const none = { ...user, mailAccounts: 0 };
    const some = { ...user, mailAccounts: 2 };
    expect(redirectFor('/', none)).toBe('/no-account');
    expect(redirectFor('/login', none)).toBe('/no-account');
    expect(redirectFor('/start', none)).toBe('/no-account');
    expect(redirectFor('/mailbox/all/inbox', none)).toBe('/no-account');
    expect(redirectFor('/no-account', none)).toBeNull();
    expect(redirectFor('/settings/appearance', none)).toBeNull();
    expect(redirectFor('/error/404', none)).toBeNull();
    expect(redirectFor('/no-account', some)).toBe('/start');
    expect(redirectFor('/start', some)).toBeNull();
    // Number still unknown: no redirect
    expect(redirectFor('/start', { ...user, mailAccounts: null })).toBeNull();
    expect(redirectFor('/no-account', user)).toBeNull();
    expect(redirectFor('/no-account', guest)).toBe('/login');
  });

  it('keeps the search and error pages out of the "No account" state', () => {
    expect(inNoAccountView('/no-account')).toBe(true);
    expect(inNoAccountView('/start')).toBe(true);
    expect(inNoAccountView('/mailbox/all/inbox')).toBe(true);
    expect(inNoAccountView('/search')).toBe(false);
    expect(inNoAccountView('/error/404')).toBe(false);
    expect(inNoAccountView('/error/offline')).toBe(false);
  });
});

describe('mailbox addresses', () => {
  it('builds role, folder and tag addresses and reads them back', () => {
    expect(mailboxPath('a1', { role: 'spam' })).toBe('/mailbox/a1/spam');
    expect(mailboxPath('a1', { folder: 'm/7' })).toBe('/mailbox/a1/f/m%2F7');
    expect(mailboxPath('all', { folder: 'k', owner: 'a2' })).toBe('/mailbox/all/f/a2/k');
    expect(mailboxPath('a1', { tag: 'important' })).toBe('/mailbox/a1/t/important');
    expect(mailboxParams('a 1', { role: 'inbox' })).toEqual({ account: 'a%201', path: 'inbox' });
    // In "All accounts" the folder's account belongs in the address.
    expect(() => mailboxPath('all', { folder: 'k' })).toThrow();

    expect(parseMailboxPath('/mailbox/a1/inbox')).toEqual({ account: 'a1', role: 'inbox', thread: null });
    expect(parseMailboxPath('/mailbox/a1/inbox/t9')).toEqual({ account: 'a1', role: 'inbox', thread: 't9' });
    expect(parseMailboxPath('/mailbox/a1/f/m%2F7')).toEqual({ account: 'a1', folder: 'm/7', thread: null });
    expect(parseMailboxPath('/mailbox/all/f/a2/k/t1')).toEqual({
      account: 'all',
      folder: 'k',
      owner: 'a2',
      thread: 't1',
    });
    expect(parseMailboxPath('/mailbox/a1/t/important')).toEqual({ account: 'a1', tag: 'important', thread: null });
    expect(parseMailboxPath('/mailbox/a2')).toEqual({ account: 'a2', role: 'inbox', thread: null });
  });

  it('knows only sidebar mailboxes, folders and tags', () => {
    expect(parseMailboxPath('/start')).toBeNull();
    expect(parseMailboxPath('/mailbox/a1/archive')).toBeNull();
    expect(parseMailboxPath('/mailbox/a1/f')).toBeNull();
    expect(parseMailboxPath('/mailbox/all/f/k')).toBeNull();
    expect(parseMailboxPath('/mailbox/a1/f/%E0')).toBeNull();
  });
});

describe('locationAccounts', () => {
  const of = (path: string) => locationAccounts(parseMailboxPath(path)!);

  it('names the account of a mailbox', () => {
    expect(of('/mailbox/a1/sent/x1')).toEqual(['a1']);
    expect(of('/mailbox/a1/t/t2')).toEqual(['a1']);
  });

  it('names the folder and message accounts in "All accounts"', () => {
    expect(of('/mailbox/all/inbox')).toEqual([]);
    expect(of('/mailbox/all/t/t2')).toEqual([]);
    expect(of('/mailbox/all/sent/a1%2Fx1')).toEqual(['a1']);
    expect(of('/mailbox/all/f/a1/f9')).toEqual(['a1']);
    expect(of('/mailbox/all/f/a1/f9/a2%2Fx1')).toEqual(['a1', 'a2']);
  });
});

describe('isAppPath', () => {
  /** Every page of the route tree with sample values for its parameters. */
  const pages = Object.keys(import.meta.glob('../routes/**/+page.svelte')).map(
    (file) =>
      file
        .replace(/^\.\.\/routes/, '')
        .replace(/\/\+page\.svelte$/, '')
        .replace(/\/\([^)]+\)/g, '')
        .replace('[...path]', 'f/m7/t1')
        .replace(/\[[^\]]+\]/g, 'x1') || '/',
  );

  it('knows every page of the route tree', () => {
    expect(pages).toContain('/mailbox/x1/f/m7/t1');
    expect(pages.length).toBeGreaterThan(35);
    for (const path of pages) expect(isAppPath(path), path).toBe(true);
    expect(isAppPath('/account/mail-accounts/a1/rules/')).toBe(true);
  });

  it('rejects unknown and incomplete pages', () => {
    for (const path of [
      '/unknown',
      '/mailbox/a1/unknown-folder',
      '/compose',
      '/account/mail-accounts/a1/unknown',
      '/admin/unknown',
      '/settings',
      '/invite',
    ])
      expect(isAppPath(path), path).toBe(false);
  });
});
