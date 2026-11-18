import { describe, expect, it } from 'vitest';
import { panelScrollKey } from '#lib/panel-scroll.ts';

describe('panelScrollKey', () => {
  it('changes between the list and a page of the same address', () => {
    expect(panelScrollKey('/settings/appearance', true)).not.toBe(panelScrollKey('/settings/appearance', false));
  });

  it('changes between two pages', () => {
    expect(panelScrollKey('/settings/appearance', false)).not.toBe(panelScrollKey('/settings/general', false));
    expect(panelScrollKey('/account/profile', false)).not.toBe(panelScrollKey('/admin/users', false));
  });

  it('changes between "Email accounts" and an email account', () => {
    expect(panelScrollKey('/account/mail-accounts', false)).not.toBe(
      panelScrollKey('/account/mail-accounts/a1/overview', true),
    );
  });

  it('stays within the pages of an email account', () => {
    const overview = panelScrollKey('/account/mail-accounts/a1/overview', false);
    expect(panelScrollKey('/account/mail-accounts/a1/connection', false)).toBe(overview);
    expect(panelScrollKey('/account/mail-accounts/a2/overview', false)).toBe(overview);
    expect(panelScrollKey('/account/mail-accounts/a2/overview', true)).toBe(
      panelScrollKey('/account/mail-accounts/a1/overview', true),
    );
    expect(panelScrollKey('/account/mail-accounts/a1/overview', true)).not.toBe(overview);
  });
});
