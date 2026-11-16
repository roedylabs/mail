/**
 * Settings navigation: pages and groups of settings, account and
 * administration, plus the values of the navigation component
 * (`settingsGroups` of the shell).
 */
import type { IconName } from '#lib/icons.ts';
import type { LogoValues } from '#lib/logo.ts';
import type { MailAccountNavValues } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';

/** Area of the navigation: settings with account, or administration. */
export type PanelSection = 'settings' | 'admin';

/** Pages of the navigation. */
export type PanelRoute =
  | '/account/profile'
  | '/account/mail-accounts'
  | '/account/security'
  | '/settings/notifications'
  | '/settings/general'
  | '/settings/appearance'
  | '/settings/language'
  | '/settings/shortcuts'
  | '/settings/about'
  | '/admin/users'
  | '/admin/organization'
  | '/admin/branding'
  | '/admin/banner'
  | '/admin/mail-servers'
  | '/admin/email'
  | '/admin/audit-log'
  | '/admin/updates'
  | '/admin/maintenance'
  | '/admin/developer';

/** Page of the navigation. */
export interface PanelPage {
  /** Stable key of the page (`profile`, `users` …). */
  id: string;
  route: PanelRoute;
  label: string;
  icon: IconName;
  /** Subtitle of the page (on mobile below the heading). */
  desc: string;
}

export interface PanelGroup {
  label: string | null;
  pages: PanelPage[];
  /** Only with "Advanced settings". */
  advanced?: boolean;
}

const page = (id: string, route: PanelRoute, label: string, icon: IconName, desc: string): PanelPage => ({
  id,
  route,
  label,
  icon,
  desc,
});

/** Account pages; they appear in the navigation of the settings. */
function accountPages(): PanelPage[] {
  return [
    page('profile', '/account/profile', m.nav_profile(), 'ti-user', m.nav_profile_desc()),
    page('mail-accounts', '/account/mail-accounts', m.nav_mail_accounts(), 'ti-mail-cog', m.nav_mail_accounts_desc()),
    page('security', '/account/security', m.nav_security(), 'ti-shield', m.nav_security_desc()),
  ];
}

/** Settings: first group "App", then "System". */
function settingsGroups(): PanelGroup[] {
  return [
    {
      label: m.nav_group_app(),
      pages: [
        page('notifications', '/settings/notifications', m.nav_notifications(), 'ti-bell', m.nav_notifications_desc()),
        page('general', '/settings/general', m.nav_general(), 'ti-settings', m.nav_general_desc()),
        page('appearance', '/settings/appearance', m.nav_appearance(), 'ti-palette', m.nav_appearance_desc()),
      ],
    },
    {
      label: m.nav_group_system(),
      pages: [
        page('language', '/settings/language', m.nav_language(), 'ti-language', m.nav_language_desc()),
        page('shortcuts', '/settings/shortcuts', m.nav_shortcuts(), 'ti-keyboard', m.nav_shortcuts_desc()),
        page('about', '/settings/about', m.nav_about(), 'ti-info-circle', m.nav_about_desc()),
      ],
    },
  ];
}

/** Administration and, with "Advanced settings", the advanced group. */
function adminGroups(advanced: boolean): PanelGroup[] {
  const groups: PanelGroup[] = [
    {
      label: null,
      pages: [
        page('users', '/admin/users', m.nav_users(), 'ti-users', m.nav_users_desc()),
        page('organization', '/admin/organization', m.nav_organisation(), 'ti-building', m.nav_organisation_desc()),
        page('branding', '/admin/branding', m.nav_branding(), 'ti-brush', m.nav_branding_desc()),
        page('banner', '/admin/banner', m.nav_banner(), 'ti-speakerphone', m.nav_banner_desc()),
      ],
    },
    {
      label: m.nav_group_system(),
      pages: [
        page('mail-servers', '/admin/mail-servers', m.nav_mailservers(), 'ti-server-2', m.nav_mailservers_desc()),
        page('email', '/admin/email', m.nav_email(), 'ti-mail', m.nav_email_desc()),
        page('audit-log', '/admin/audit-log', m.nav_audit(), 'ti-list-details', m.nav_audit_desc()),
        page('updates', '/admin/updates', m.nav_updates(), 'ti-refresh', m.nav_updates_desc()),
        page('maintenance', '/admin/maintenance', m.nav_maintenance(), 'ti-tool', m.nav_maintenance_desc()),
      ],
    },
  ];
  if (advanced) {
    groups.push({
      label: m.nav_group_advanced(),
      pages: [page('developer', '/admin/developer', m.nav_developer(), 'ti-code', m.nav_developer_desc())],
      advanced: true,
    });
  }
  return groups;
}

/** Groups of an area before filtering. */
export function panelGroups(section: PanelSection, advanced: boolean): PanelGroup[] {
  if (section === 'admin') return adminGroups(advanced);
  return [{ label: m.nav_group_account(), pages: accountPages() }, ...settingsGroups()];
}

export function sectionOf(path: string): PanelSection {
  return path.startsWith('/admin/') ? 'admin' : 'settings';
}

/** First page of the administration, e.g. after switching "Advanced settings" off. */
export const ADMIN_HOME: PanelRoute = '/admin/users';

/**
 * Page for the address, also for subpages (`/account/mail-accounts/new`);
 * "Developer" also without "Advanced settings".
 */
export function pageOf(path: string): PanelPage | null {
  return matchPage(panelGroups(sectionOf(path), true), path);
}

function matchPage(groups: readonly PanelGroup[], path: string): PanelPage | null {
  const pages = groups.flatMap((g) => g.pages);
  return pages.find((p) => path === p.route || path.startsWith(`${p.route}/`)) ?? null;
}

/** Entry of the navigation. */
export interface NavEntry {
  id: string;
  label: string;
  icon: IconName;
  /** Current page: card, tile in the accent colour. */
  on: boolean;
  fw: number;
  /** Tooltip only when collapsed. */
  tip: string | undefined;
  onClick: () => void;
}

export interface NavGroupValues {
  label: string;
  hasLabel: boolean;
  items: NavEntry[];
}

/** Toggle "Advanced settings". */
export interface AdvancedToggle {
  on: boolean;
  onClick: () => void;
}

/** Props of the settings navigation component. */
export interface SettingsNavValues {
  isMobile: boolean;
  appName: string;
  logo: LogoValues;
  /** "Version 0.1.0" below the app name. */
  version: string;
  /** Collapsed: tiles only, labels as tooltip. */
  collapsed: boolean;
  backLabel: string;
  backTip: string | undefined;
  panelBack: () => void;
  /** Heading on mobile. */
  mPanelH: string;
  isAdminView: boolean;
  settingsGroups: NavGroupValues[];
  noSettingsHits: boolean;
  tgAdv: AdvancedToggle;
  /** Email account part: account switch at the bottom instead of app and version, account choice. */
  ma: MailAccountNavValues | null;
}

export interface NavInput {
  path: string;
  isMobile: boolean;
  collapsed: boolean;
  advanced: boolean;
  /** Filter of the entries; the navigation shows no field for it. */
  query?: string;
  open: (page: PanelPage) => void;
}

/**
 * `settingsGroups` of the shell: groups with entries of the area, on mobile
 * without "Keyboard shortcuts", filtered by `query`, empty groups are omitted.
 */
export function navGroupValues(input: NavInput): NavGroupValues[] {
  // All pages of the area once: the current one also under "Developer" without "Advanced settings".
  const all = panelGroups(sectionOf(input.path), true);
  const current = matchPage(all, input.path);
  const q = (input.query ?? '').trim().toLocaleLowerCase(getLocale());
  return all
    .filter((g) => input.advanced || !g.advanced)
    .map((g) => ({
      label: g.label ?? '',
      hasLabel: !!g.label,
      items: g.pages
        .filter((p) => !(input.isMobile && p.id === 'shortcuts'))
        .filter((p) => !q || p.label.toLocaleLowerCase(getLocale()).includes(q))
        .map((p): NavEntry => {
          const on = current?.route === p.route;
          return {
            id: p.id,
            label: p.label,
            icon: p.icon,
            on,
            fw: on ? 800 : 600,
            tip: input.collapsed ? p.label : undefined,
            onClick: () => input.open(p),
          };
        }),
    }))
    .filter((g) => g.items.length > 0);
}
