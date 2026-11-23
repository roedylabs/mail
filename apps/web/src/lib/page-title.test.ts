import { describe, expect, it } from 'vitest';
import { pageTitle, type PageTitleInput } from './page-title.ts';

const at = (path: string, more: Partial<PageTitleInput> = {}) =>
  pageTitle({
    path,
    appName: 'Roedy Mail',
    error: null,
    mailbox: null,
    compose: null,
    loginTitle: 'Welcome back',
    ...more,
  });

describe('pageTitle', () => {
  it('names settings, account and administration after the navigation', () => {
    expect(at('/settings/general')).toBe('General – Roedy Mail');
    expect(at('/account/mail-accounts')).toBe('Email accounts – Roedy Mail');
    expect(at('/account/mail-accounts/new')).toBe('Email accounts – Roedy Mail');
    expect(at('/admin/audit-log')).toBe('Audit log – Roedy Mail');
  });

  it('names the subpage of a mail account before the section', () => {
    expect(at('/account/mail-accounts/a1/overview')).toBe('Overview – Email accounts – Roedy Mail');
  });

  it('names the open mailbox, only the app until it is known', () => {
    expect(at('/mailbox/a1/inbox', { mailbox: 'Inbox' })).toBe('Inbox – Roedy Mail');
    expect(at('/mailbox/a1/inbox')).toBe('Roedy Mail');
  });

  it('names search and compose', () => {
    expect(at('/search')).toBe('Search – Roedy Mail');
    expect(at('/compose/new')).toBe('New email – Roedy Mail');
    expect(at('/compose/new', { compose: 'Reply' })).toBe('Reply – Roedy Mail');
    expect(at('/compose/a1~e1')).toBe('Draft – Roedy Mail');
  });

  it('names guest pages after their heading without doubling the app name', () => {
    expect(at('/login', { loginTitle: 'Hello Team' })).toBe('Hello Team – Roedy Mail');
    expect(at('/password/forgot')).toBe('Reset password – Roedy Mail');
    expect(at('/password/reset/x')).toBe('Set a new password – Roedy Mail');
    expect(at('/setup')).toBe('Set up Roedy Mail');
    expect(at('/setup', { auth: 'Setup token · Setup' })).toBe('Setup token · Setup');
    expect(at('/setup', { auth: 'Setup token · Setup', error: 'offline' })).not.toBe('Setup token · Setup');
    expect(at('/login', { auth: 'Sign in · Roedy Mail' })).toBe('Sign in · Roedy Mail');
    expect(at('/password/forgot', { auth: 'Reset password · Roedy Mail' })).toBe('Reset password · Roedy Mail');
    expect(at('/password/reset/x', { auth: 'New password · Roedy Mail' })).toBe('New password · Roedy Mail');
    expect(at('/invite/x', { auth: 'Invitation · Roedy Mail' })).toBe('Invitation · Roedy Mail');
    // Elsewhere a title left behind does not count.
    expect(at('/no-account', { auth: 'Setup token · Setup' })).toBe('Connect your first email account – Roedy Mail');
    expect(at('/invite/x')).toBe('Welcome to Roedy Mail');
    expect(at('/confirm-email/x')).toBe('Confirm new email address – Roedy Mail');
    expect(at('/no-account')).toBe('Connect your first email account – Roedy Mail');
  });

  it('names error pages after their title, also in place of the page', () => {
    expect(at('/error/403')).toBe('Access denied – Roedy Mail');
    expect(at('/error/unknown')).toBe('Page not found – Roedy Mail');
    expect(at('/admin/users', { error: '403' })).toBe('Access denied – Roedy Mail');
    expect(at('/does-not-exist', { error: '404' })).toBe('Page not found – Roedy Mail');
  });

  it('stays at the app name without a matching heading', () => {
    expect(at('/start')).toBe('Roedy Mail');
    expect(at('/oauth/callback')).toBe('Roedy Mail');
  });
});
