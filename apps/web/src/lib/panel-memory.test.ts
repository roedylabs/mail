import { beforeEach, describe, expect, it } from 'vitest';
import { adminHome, advancedOff, rememberPanelPage, resetPanelMemory, settingsHome } from '#lib/panel-memory.ts';

describe('panel memory', () => {
  beforeEach(() => resetPanelMemory());

  it('starts with "Appearance" and "Users"', () => {
    expect(settingsHome()).toBe('/settings/appearance');
    expect(adminHome(false)).toBe('/admin/users');
  });

  it('keeps the last settings page, account pages included', () => {
    rememberPanelPage('/settings/shortcuts');
    expect(settingsHome()).toBe('/settings/shortcuts');
    for (const page of ['/account/profile', '/account/mail-accounts', '/account/security'] as const) {
      rememberPanelPage(page);
      expect(settingsHome()).toBe(page);
    }
  });

  it('keeps the last administration page apart from the settings', () => {
    rememberPanelPage('/settings/language');
    rememberPanelPage('/admin/audit-log');
    expect(settingsHome()).toBe('/settings/language');
    expect(adminHome(false)).toBe('/admin/audit-log');
    rememberPanelPage('/account/profile');
    expect(adminHome(false)).toBe('/admin/audit-log');
  });

  it('counts "Add email account" as "Email accounts"', () => {
    rememberPanelPage('/account/mail-accounts/new');
    expect(settingsHome()).toBe('/account/mail-accounts');
  });

  it('leaves the page as it was on the subpages of an email account', () => {
    rememberPanelPage('/account/security');
    rememberPanelPage('/account/mail-accounts/a1/overview');
    rememberPanelPage('/account/mail-accounts/a1/rules');
    expect(settingsHome()).toBe('/account/security');
  });

  it('ignores addresses outside the navigation', () => {
    rememberPanelPage('/settings/general');
    rememberPanelPage('/settings/unknown');
    rememberPanelPage('/mailbox/a1/inbox');
    rememberPanelPage('/admin/unknown');
    expect(settingsHome()).toBe('/settings/general');
    expect(adminHome(false)).toBe('/admin/users');
  });

  it('opens "Developer" only with "Advanced settings"', () => {
    rememberPanelPage('/admin/developer');
    expect(adminHome(true)).toBe('/admin/developer');
    expect(adminHome(false)).toBe('/admin/users');
    expect(adminHome(true)).toBe('/admin/users');
  });

  it('forgets "Developer" when "Advanced settings" is switched off', () => {
    rememberPanelPage('/admin/developer');
    advancedOff();
    expect(adminHome(true)).toBe('/admin/users');
    rememberPanelPage('/admin/branding');
    advancedOff();
    expect(adminHome(true)).toBe('/admin/branding');
  });
});
