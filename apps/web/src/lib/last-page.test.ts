import { beforeEach, describe, expect, it } from 'vitest';
import { LAST_PAGE_KEY, forgetPage, isEntry, isRememberable, lastPage, rememberPage } from './last-page.ts';

const url = (path: string) => {
  const u = new URL(path, 'https://mail.example.test');
  return { pathname: u.pathname, search: u.search };
};

describe('last-page', () => {
  beforeEach(() => localStorage.clear());

  it('remembers only pages of the shell', () => {
    expect(isRememberable('/mailbox/a1/inbox')).toBe(true);
    expect(isRememberable('/settings/general')).toBe(true);
    expect(isRememberable('/admin/users')).toBe(true);
    for (const path of [
      '/',
      '/start',
      '/no-account',
      '/login',
      '/setup',
      '/error/404',
      '/compose/d1',
      '/oauth/callback',
      '/password/reset/x',
      '/search',
    ])
      expect(isRememberable(path), path).toBe(false);
  });

  it('returns the page only to the account that opened it', () => {
    rememberPage('u1', url('/mailbox/a1/inbox?view=2'));
    expect(lastPage('u1', false)).toBe('/mailbox/a1/inbox?view=2');
    expect(lastPage('u2', false)).toBeNull();
    // Start page and search (search term) do not overwrite the page before.
    rememberPage('u1', url('/start'));
    rememberPage('u1', url('/search?q=invoice'));
    expect(lastPage('u1', false)).toBe('/mailbox/a1/inbox?view=2');
    forgetPage();
    expect(lastPage('u1', false)).toBeNull();
  });

  it('returns administration pages only to administrators', () => {
    rememberPage('u1', url('/admin/users'));
    expect(lastPage('u1', true)).toBe('/admin/users');
    expect(lastPage('u1', false)).toBeNull();
  });

  it('drops addresses of pages that no longer exist', () => {
    // A route or mailbox that does not exist would open the 404 page.
    for (const path of ['/removed/a1/inbox', '/settings/removed', '/mailbox/a1/removed']) {
      localStorage.setItem(LAST_PAGE_KEY, JSON.stringify({ user: 'u1', path }));
      expect(lastPage('u1', true), path).toBeNull();
    }
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify({ user: 'u1', path: '/mailbox/a1/f/m7?view=2' }));
    expect(lastPage('u1', true)).toBe('/mailbox/a1/f/m7?view=2');
  });

  it('discards broken or foreign entries', () => {
    for (const raw of [
      'broken',
      '"text"',
      'null',
      JSON.stringify({ user: 'u1', path: '//evil.test/x' }),
      JSON.stringify({ user: 'u1', path: '/login' }),
      JSON.stringify({ user: 'u1', path: 3 }),
    ]) {
      localStorage.setItem(LAST_PAGE_KEY, raw);
      expect(lastPage('u1', true), raw).toBeNull();
    }
  });

  it('detects the entry, not the logo or the error page', () => {
    expect(isEntry(null)).toBe(true);
    expect(isEntry('/')).toBe(true);
    expect(isEntry('/login')).toBe(true);
    expect(isEntry('/invite/abc')).toBe(true);
    expect(isEntry('/mailbox/a1/inbox')).toBe(false);
    expect(isEntry('/compose/d1')).toBe(false);
    expect(isEntry('/error/500')).toBe(false);
  });
});
