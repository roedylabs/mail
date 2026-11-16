import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { mkLogo } from '#lib/logo.ts';
import type { MailAccountNavValues, PickerAccount } from '#lib/mail-account.svelte.ts';
import { navGroupValues, pageOf, panelGroups, sectionOf, type SettingsNavValues } from '#lib/settings-nav.ts';
import { BRAND0 } from '#lib/state/session.svelte.ts';
import SettingsNav from './SettingsNav.svelte';

function values(path: string, patch: Partial<SettingsNavValues> & { advanced?: boolean } = {}): SettingsNavValues {
  const { advanced = false, ...rest } = patch;
  const isMobile = rest.isMobile ?? false;
  const collapsed = rest.collapsed ?? false;
  return {
    isMobile,
    appName: 'Roedy Mail',
    logo: mkLogo(BRAND0, 'Roedy Mail'),
    version: 'Version 0.1.0',
    collapsed,
    backLabel: 'Back to Roedy Mail',
    backTip: collapsed ? 'Back to Roedy Mail' : undefined,
    panelBack: () => {},
    mPanelH: sectionOf(path) === 'admin' ? 'Administration' : 'Settings',
    isAdminView: sectionOf(path) === 'admin',
    settingsGroups: navGroupValues({ path, isMobile, collapsed, advanced, open: () => {} }),
    noSettingsHits: false,
    tgAdv: { on: advanced, onClick: () => {} },
    ma: null,
    ...rest,
  };
}

function picked(patch: Partial<PickerAccount> = {}): PickerAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    host: 'mail.s1.test',
    letter: 'A',
    tileBg: '#94c48d',
    tileInk: '#13300f',
    isDef: true,
    ok: true,
    warn: false,
    checked: true,
    onClick: () => {},
    ...patch,
  };
}

function mailAccount(patch: Partial<MailAccountNavValues> = {}): MailAccountNavValues {
  return {
    maNav: [],
    maCur: {
      kind: 'auth',
      st: 'Sign-in required',
      needsAuth: true,
      email: 'account1@s1.test',
      letter: 'A',
      chip: '#94c48d',
      chipInk: '#13300f',
    },
    maSwOpen: false,
    maSwTip: undefined,
    toggleMaSw: () => {},
    picker: {
      isMobile: false,
      maSwList: [picked(), picked({ id: 'a2', email: 'max@s2.test', letter: 'M', checked: false, isDef: false })],
      maSwAdd: () => {},
      maSwManage: () => {},
      closeSheet: () => {},
    },
    ...patch,
  };
}

describe('settings navigation', () => {
  it('structures settings and administration into groups and pages', () => {
    expect(panelGroups('settings', false).map((g) => [g.label, g.pages.map((p) => p.label)])).toEqual([
      ['Account', ['Profile', 'Email accounts', 'Security']],
      ['App', ['Notifications', 'General', 'Appearance']],
      ['System', ['Language & region', 'Keyboard shortcuts', 'About']],
    ]);
    expect(panelGroups('admin', false).map((g) => [g.label, g.pages.map((p) => p.id)])).toEqual([
      [null, ['users', 'organization', 'branding', 'banner']],
      ['System', ['mail-servers', 'email', 'audit-log', 'updates', 'maintenance']],
    ]);
    expect(panelGroups('admin', true).at(-1)).toMatchObject({ label: 'Advanced', pages: [{ id: 'developer' }] });
    expect(pageOf('/account/mail-accounts/new')?.id).toBe('mail-accounts');
    expect(pageOf('/admin/developer')?.label).toBe('Developer');
    expect(pageOf('/start')).toBeNull();
  });

  it('marks the current page, on mobile without keyboard shortcuts, with filter', () => {
    const groups = navGroupValues({
      path: '/settings/appearance',
      isMobile: false,
      collapsed: true,
      advanced: false,
      open: () => {},
    });
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.on)).toMatchObject({ label: 'Appearance', fw: 800, tip: 'Appearance' });
    expect(items.filter((i) => i.on)).toHaveLength(1);
    const mobile = navGroupValues({
      path: '/account/profile',
      isMobile: true,
      collapsed: false,
      advanced: false,
      open: () => {},
    });
    expect(mobile.flatMap((g) => g.items.map((i) => i.id))).not.toContain('shortcuts');
    expect(mobile.flatMap((g) => g.items).every((i) => i.tip === undefined)).toBe(true);
    const hits = navGroupValues({
      path: '/account/profile',
      isMobile: false,
      collapsed: false,
      advanced: false,
      query: 'language',
      open: () => {},
    });
    expect(hits.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([['System', ['Language & region']]]);
  });

  it('shows "Back to …", groups, toggle and version on desktop', async () => {
    const open = vi.fn();
    const panelBack = vi.fn();
    const onClick = vi.fn();
    const v = values('/admin/users', { panelBack, tgAdv: { on: false, onClick } });
    v.settingsGroups = navGroupValues({
      path: '/admin/users',
      isMobile: false,
      collapsed: false,
      advanced: false,
      open,
    });
    const view = render(SettingsNav, v);
    expect(view.getByRole('navigation', { name: 'Administration' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
    expect(view.getByText('System')).toBeInTheDocument();
    expect(view.getByText('Version 0.1.0')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Organization' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ route: '/admin/organization' }));
    await fireEvent.click(view.getByRole('button', { name: 'Back to Roedy Mail' }));
    expect(panelBack).toHaveBeenCalled();
    const sw = view.getByRole('switch', { name: 'Advanced settings' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(sw);
    expect(onClick).toHaveBeenCalled();
  });

  it('shows "Advanced settings" only in the administration and only tiles when collapsed', () => {
    const view = render(SettingsNav, values('/settings/appearance', { collapsed: true }));
    expect(view.queryByRole('switch')).toBeNull();
    expect(view.container.querySelector('aside')).toHaveClass('collapsed');
    // When collapsed the entries stay named via `aria-label`; the card is hidden.
    expect(view.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-label', 'Appearance');
    expect(view.container.querySelector('.card')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the list of the area with a heading on mobile', async () => {
    const open = vi.fn();
    const v = values('/admin/users', { isMobile: true, advanced: true });
    v.settingsGroups = navGroupValues({
      path: '/admin/users',
      isMobile: true,
      collapsed: false,
      advanced: true,
      open,
    });
    const view = render(SettingsNav, v);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Administration');
    expect(view.getByText('Advanced')).toBeInTheDocument();
    expect(view.getByText('Roedy Mail · Version 0.1.0')).toBeInTheDocument();
    expect(view.getByRole('switch', { name: 'Advanced settings' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Developer' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'developer' }));
  });

  it('shows the account switch instead of the app card in the email account', async () => {
    const toggleMaSw = vi.fn();
    const view = render(SettingsNav, values('/account/mail-accounts', { ma: mailAccount({ toggleMaSw }) }));
    expect(view.container.querySelector('.card')).toBeNull();
    expect(view.queryByText('Version 0.1.0')).toBeNull();
    // The name contains address and status, as visible (WCAG 2.5.3).
    const sw = view.getByRole('button', {
      name: /^Switch email account\s*account1@s1\.test\s*Sign-in required$/,
    });
    expect(sw).toHaveAttribute('data-pop');
    expect(sw).toHaveAttribute('aria-haspopup', 'menu');
    expect(sw).toHaveAttribute('aria-expanded', 'false');
    expect(sw).not.toHaveClass('open');
    expect(sw).toHaveTextContent('account1@s1.test');
    expect(view.getByText('Sign-in required')).toBeInTheDocument();
    expect(sw.querySelector('.ma-st')).toHaveClass('auth');
    // Red dot on the tile (`maSwWarn`).
    expect(sw.querySelector('.ma-warn')).not.toBeNull();
    expect(view.queryByRole('menu')).toBeNull();
    await fireEvent.click(sw);
    expect(toggleMaSw).toHaveBeenCalled();
  });

  it('shows the popover with the account picker open', async () => {
    const pick = vi.fn();
    const ma = mailAccount({
      maSwOpen: true,
      maCur: { ...mailAccount().maCur, kind: 'ok', st: 'Connected', needsAuth: false },
    });
    ma.picker.maSwList[1]!.onClick = pick;
    const view = render(SettingsNav, values('/account/mail-accounts', { collapsed: true, ma }));
    const sw = view.getByRole('button', { name: /^Switch email account/ });
    expect(sw).toHaveAttribute('aria-expanded', 'true');
    expect(sw).toHaveClass('open');
    expect(sw.querySelector('.ma-warn')).toBeNull();
    const menu = view.getByRole('menu', { name: 'Switch email account' });
    expect(menu).toHaveAttribute('data-pop');
    expect(menu.closest('aside')).toBeNull();
    await fireEvent.click(view.getByRole('menuitemradio', { name: /max@s2\.test/ }));
    expect(pick).toHaveBeenCalled();
  });

  it('shows neither account switch nor account picker in the email account on mobile', () => {
    const view = render(
      SettingsNav,
      values('/account/mail-accounts', { isMobile: true, ma: mailAccount({ maSwOpen: true }) }),
    );
    expect(view.queryByRole('button', { name: /^Switch email account/ })).toBeNull();
    expect(view.queryByRole('menu')).toBeNull();
  });

  it('reports "No results"', () => {
    const view = render(SettingsNav, values('/account/profile', { settingsGroups: [], noSettingsHits: true }));
    expect(view.getByText('No results')).toBeInTheDocument();
  });
});
