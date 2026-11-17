/**
 * Local categories of the search: contacts, folders, tags, settings,
 * administration, actions and notifications as candidates for `scoreAll()`
 * in `#lib/search.ts`, plus the folder of a found email (`HitBox`).
 */
import type { Mailbox } from '@roedy/jmap';
import { isIconName, type IconName } from '#lib/icons.ts';
import { avatarOf, initials, messagesText, searchTime, tagColors, type TimeContext } from '#lib/mail-list.ts';
import { roleLabel } from '#lib/mailbox-nav.ts';
import { targetOf } from '#lib/notifications-menu.ts';
import { m } from '#lib/paraglide/messages.js';
import { mailboxPath, ROLE_IDS, type RoleId } from '#lib/routes.ts';
import type { Candidate, HitBox, MailHit, SearchActions } from '#lib/search.ts';
import { panelGroups, type PanelPage, type PanelSection } from '#lib/settings-nav.ts';
import type { Contact } from '#lib/state/contacts.svelte.ts';
import type { AppNotification } from '#lib/state/notifications.svelte.ts';
import { countsOf, folderTree, ROLES, roleMailbox, type Counts, type FolderNode } from '#lib/state/mailboxes.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import type { ListedUser, Role, UserStatus } from '#lib/users.svelte.ts';

export interface SearchItemsInput {
  isAdmin: boolean;
  isMobile: boolean;
  /** Dark theme active (label of the action to switch). */
  dark: boolean;
  /** Advanced settings: the developer page of the administration. */
  advanced: boolean;
  /** Modifier key of the keyboard shortcuts, "⌘" or "Ctrl". */
  mod: string;
  /** Ready mail accounts in the order of the app. */
  accounts: readonly { id: string; email: string }[];
  mailboxes: (account: string) => readonly Mailbox[];
  /** Tag tree across the accounts (`tags.tree`). */
  tags: readonly TagNode[];
  /** Target of a tag: "All accounts" or the active account. */
  tagAccount: string | null;
  contacts: readonly Contact[];
  /** Users of the administration once loaded (administrators only). */
  users: readonly ListedUser[];
  /** Own user ID (omitted from the list). */
  me: string | null;
  actions: SearchActions;
}

/** Search keywords of the mailboxes, not shown; in the interface language. */
const FOLDER_KW: Record<RoleId, () => string> = {
  inbox: m.search_kw_folder_inbox,
  sent: m.search_kw_folder_sent,
  drafts: m.search_kw_folder_drafts,
  scheduled: m.search_kw_folder_scheduled,
  trash: m.search_kw_folder_trash,
  spam: m.search_kw_folder_spam,
};

/** Area of a page in the section index. */
type IdxView = 'account' | 'settings' | 'admin';

interface IdxEntry {
  view: IdxView;
  /** Page (`PanelPage.id`). */
  page: string;
  /** Section `[data-sec]` of the page; `null` = only open the page. */
  sec: string | null;
  label: () => string;
  /** Search keywords, not shown; in the interface language. */
  kw: () => string;
  icon: IconName;
}

/** Section of a page: `[sec, label, kw, icon]`. */
type IdxRow = readonly [sec: string, label: () => string, kw: () => string, icon: IconName];

const onPage = (view: IdxView, page: string, rows: readonly IdxRow[]): IdxEntry[] =>
  rows.map(([sec, label, kw, icon]) => ({ view, page, sec, label, kw, icon }));

/**
 * Section index of the settings and administration pages, with texts from the
 * pages where the wording matches. Every page carries the matching
 * `data-sec` (`search-items.test.ts` checks the sources).
 */
const SET_IDX: readonly IdxEntry[] = [
  ...onPage('settings', 'appearance', [
    ['mode', m.appearance_tab_mode, m.search_kw_appearance_tab_mode, 'ti-sun-moon'],
    ['accent', m.appearance_tab_accent, m.search_kw_appearance_tab_accent, 'ti-palette'],
    ['text', m.appearance_font_size, m.search_kw_appearance_font_size, 'ti-text-size'],
    ['text', m.appearance_animations, m.search_kw_appearance_animations, 'ti-sparkles'],
    ['layout', m.appearance_density, m.search_kw_appearance_density, 'ti-layout-rows'],
    ['layout', m.appearance_list, m.search_kw_appearance_list, 'ti-layout-list'],
    ['layout', m.appearance_sidebar, m.search_kw_appearance_sidebar, 'ti-layout-sidebar'],
  ]),
  ...onPage('settings', 'general', [
    ['start', m.general_start_title, m.search_kw_general_start_title, 'ti-home'],
    ['behavior', m.general_confirm, m.search_kw_general_confirm, 'ti-help-circle'],
    ['behavior', m.general_undo, m.search_kw_general_undo, 'ti-arrow-back-up'],
    ['behavior', m.search_idx_keys, m.search_kw_search_idx_keys, 'ti-keyboard'],
    ['swipe', m.general_tab_swipe, m.search_kw_general_tab_swipe, 'ti-hand-finger'],
    ['ext', m.ext_setting, m.search_kw_ext_setting, 'ti-photo-off'],
    ['data', m.general_export_title, m.search_kw_general_export_title, 'ti-download'],
    ['data', m.general_local_title, m.search_kw_general_local_title, 'ti-database-x'],
    ['danger', m.general_tab_danger, m.search_kw_general_tab_danger, 'ti-user-x'],
  ]),
  ...onPage('settings', 'notifications', [
    ['channels', m.search_idx_notif_channels, m.search_kw_search_idx_notif_channels, 'ti-bell'],
    ['topics', m.search_idx_notif_topics, m.search_kw_search_idx_notif_topics, 'ti-list-check'],
    ['mailpush', m.search_idx_mail_push, m.search_kw_search_idx_mail_push, 'ti-mail'],
  ]),
  ...onPage('settings', 'language', [
    ['lang', m.region_tab_lang, m.search_kw_region_tab_lang, 'ti-language'],
    ['region', m.region_country_title, m.search_kw_region_country_title, 'ti-world'],
    ['region', m.region_tz_title, m.search_kw_region_tz_title, 'ti-clock'],
    ['formats', m.region_date_fmt, m.search_kw_region_date_fmt, 'ti-calendar'],
    ['formats', m.region_time_fmt, m.search_kw_region_time_fmt, 'ti-clock-hour-4'],
    ['formats', m.region_week_start, m.search_kw_region_week_start, 'ti-calendar-week'],
    ['formats', m.region_num_fmt, m.search_kw_region_num_fmt, 'ti-123'],
  ]),
  ...onPage('settings', 'about', [
    ['version', m.search_idx_version, m.search_kw_search_idx_version, 'ti-info-circle'],
    ['support', m.about_tab_support, m.search_kw_about_tab_support, 'ti-headset'],
    ['legal', m.about_tab_legal, m.search_kw_about_tab_legal, 'ti-scale'],
    ['licenses', m.about_tab_licenses, m.search_kw_about_tab_licenses, 'ti-license'],
  ]),
  ...onPage('account', 'profile', [['profile', m.search_idx_profile, m.search_kw_search_idx_profile, 'ti-user']]),
  ...onPage('account', 'mail-accounts', [['mail', m.nav_mail_accounts, m.search_kw_nav_mail_accounts, 'ti-mail-cog']]),
  ...onPage('account', 'security', [
    ['password', m.search_idx_password, m.search_kw_search_idx_password, 'ti-key'],
    ['2fa', m.security_mfa_title, m.search_kw_security_mfa_title, 'ti-shield-lock'],
    ['sessions', m.security_sessions_title, m.search_kw_security_sessions_title, 'ti-devices'],
  ]),
  ...onPage('admin', 'organization', [
    ['firm', m.search_idx_org_firm, m.search_kw_search_idx_org_firm, 'ti-building'],
    ['support', m.search_idx_org_support, m.search_kw_search_idx_org_support, 'ti-headset'],
    ['legal', m.search_idx_org_legal, m.search_kw_search_idx_org_legal, 'ti-scale'],
    ['source', m.org_tab_source, m.search_kw_org_tab_source, 'ti-code'],
  ]),
  ...onPage('admin', 'branding', [
    ['name', m.branding_name, m.search_kw_branding_name, 'ti-forms'],
    ['logo', m.branding_tab_logo, m.search_kw_branding_tab_logo, 'ti-photo'],
    ['color', m.branding_tab_color, m.search_kw_branding_tab_color, 'ti-color-swatch'],
    ['login', m.branding_tab_login, m.search_kw_branding_tab_login, 'ti-login'],
  ]),
  ...onPage('admin', 'banner', [
    ['status', m.banner_show, m.search_kw_banner_show, 'ti-speakerphone'],
    ['content', m.search_idx_banner_text, m.search_kw_search_idx_banner_text, 'ti-align-left'],
  ]),
  ...onPage('admin', 'email', [
    ['conn', m.search_idx_mail_conn, m.search_kw_search_idx_mail_conn, 'ti-plug'],
    ['sender', m.search_idx_mail_sender, m.search_kw_search_idx_mail_sender, 'ti-user-share'],
    ['delivery', m.system_mail_tab_delivery, m.search_kw_system_mail_tab_delivery, 'ti-send'],
    ['test', m.search_idx_mail_test, m.search_kw_search_idx_mail_test, 'ti-mail-check'],
    ['tpl', m.search_idx_mail_templates, m.search_kw_search_idx_mail_templates, 'ti-template'],
  ]),
  ...onPage('admin', 'mail-servers', [
    ['list', m.nav_mailservers, m.search_kw_nav_mailservers, 'ti-server-2'],
    ['policy', m.server_own_mobile, m.search_kw_server_own_mobile, 'ti-world-www'],
  ]),
  ...onPage('admin', 'updates', [
    ['status', m.search_idx_update_status, m.search_kw_search_idx_update_status, 'ti-refresh'],
    ['source', m.updates_pat_label, m.search_kw_updates_pat_label, 'ti-brand-github'],
    ['schedule', m.search_idx_update_schedule, m.search_kw_search_idx_update_schedule, 'ti-calendar-time'],
  ]),
  ...onPage('admin', 'maintenance', [
    ['mode', m.maintenance_tab_mode, m.search_kw_maintenance_tab_mode, 'ti-tool'],
    ['backups', m.maintenance_tab_backups, m.search_kw_maintenance_tab_backups, 'ti-database'],
    ['storage', m.maintenance_tab_storage, m.search_kw_maintenance_tab_storage, 'ti-database'],
  ]),
  ...onPage('admin', 'audit-log', [['keep', m.search_idx_audit_keep, m.search_kw_search_idx_audit_keep, 'ti-history']]),
  ...onPage('admin', 'developer', [
    ['diag', m.search_idx_debug, m.search_kw_search_idx_debug, 'ti-bug'],
    ['log', m.search_idx_log_level, m.search_kw_search_idx_log_level, 'ti-list-details'],
    ['test', m.search_idx_error_pages, m.search_kw_search_idx_error_pages, 'ti-alert-triangle'],
    ['env', m.dev_tab_env, m.search_kw_dev_tab_env, 'ti-server'],
  ]),
];

/** Search help of the users. */
const USER_KW = m.search_kw_users;

const roleText = (r: Role) => (r === 'admin' ? m.users_role_admin() : m.users_role_user());
const statusText = (s: UserStatus) =>
  s === 'active' ? m.users_status_active() : s === 'invited' ? m.users_status_invited() : m.users_status_locked();

/** Avatar: initials of the name, otherwise the first letter of the address. */
function avatar(name: string, email: string): { text: string; bg: string; ink: string } {
  const [bg, ink] = avatarOf(name || email);
  return { text: initials(name) || email.charAt(0).toUpperCase(), bg, ink };
}

/** Counter in the path of a folder: unread before total, empty without messages. */
function countText(c: Counts): string {
  if (c.unread > 0) return ` · ${m.search_path_unread({ n: c.unread })}`;
  return c.total > 0 ? ` · ${messagesText(c.total)}` : '';
}

function contactItems(input: SearchItemsInput): Candidate[] {
  return input.contacts.map((c) => {
    const label = c.name || c.email;
    return {
      id: c.email.toLowerCase(),
      cat: 'contacts',
      label,
      icon: 'ti-user',
      av: avatar(label, c.email),
      path: c.email + (c.count > 0 ? ` · ${messagesText(c.count)}` : ''),
      extra: c.email,
      run: () => input.actions.searchFrom(c.email),
    };
  });
}

function folderItems(input: SearchItemsInput): Candidate[] {
  const out: Candidate[] = [];
  const go = input.actions.mailbox;
  for (const a of input.accounts) {
    const list = input.mailboxes(a.id);
    for (const role of ROLE_IDS) {
      const box = roleMailbox(list, role);
      if (!box) continue;
      out.push({
        id: `${a.id}/${role}`,
        cat: 'folders',
        label: roleLabel(role),
        icon: ROLES[role].icon,
        path: a.email + countText(countsOf(box)),
        extra: `${a.email} ${FOLDER_KW[role]()}`,
        run: () => go(mailboxPath(a.id, { role })),
      });
    }
    // `folderTree` leaves out the mailboxes of the sidebar and the tag mailboxes.
    const walk = (nodes: readonly FolderNode[], parents: readonly string[]) => {
      for (const f of nodes) {
        out.push({
          id: `${a.id}/f/${f.id}`,
          cat: 'folders',
          label: f.name,
          icon: 'ti-folder',
          path: [a.email, ...parents].join(' › ') + countText(f),
          extra: parents.join(' '),
          run: () => go(mailboxPath(a.id, { folder: f.id })),
        });
        walk(f.children, [...parents, f.name]);
      }
    };
    walk(folderTree(list), []);
  }
  return out;
}

function tagItems(input: SearchItemsInput): Candidate[] {
  const account = input.tagAccount;
  if (!account) return [];
  const out: Candidate[] = [];
  const walk = (nodes: readonly TagNode[], parents: readonly string[]) => {
    for (const t of nodes) {
      out.push({
        id: t.id,
        cat: 'tags',
        label: t.name,
        icon: 'ti-tag',
        tile: tagColors(t.color),
        path: (parents.length ? `${parents.join(' › ')} · ` : '') + messagesText(t.total),
        extra: parents.join(' '),
        run: () => input.actions.mailbox(mailboxPath(account, { tag: t.id })),
      });
      walk(t.children, [...parents, t.name]);
    }
  };
  walk(input.tags, []);
  return out;
}

/** Pages of the settings (with account) or administration. */
function pageItems(input: SearchItemsInput, section: PanelSection): Candidate[] {
  const out: Candidate[] = [];
  const cat = section === 'admin' ? 'admin' : 'settings';
  for (const g of panelGroups(section, input.advanced)) {
    // The first group of the settings ("App") has no name in the path.
    const group = g.label === m.nav_group_app() ? null : g.label;
    for (const p of g.pages) {
      if (p.id === 'shortcuts' && input.isMobile) continue;
      const path =
        section === 'admin'
          ? group
            ? m.search_path_admin_group({ group })
            : m.search_cat_admin()
          : p.route.startsWith('/account/')
            ? m.nav_group_account()
            : group
              ? m.search_path_settings_group({ group })
              : m.search_cat_settings();
      out.push({
        id: p.id,
        cat,
        label: p.label,
        icon: p.icon,
        path,
        desc: p.desc,
        extra: p.desc,
        run: () => input.actions.go(p.route),
      });
    }
  }
  return out;
}

/** Sections from the index; without the page (e.g. developer without `advanced`) the entry is omitted. */
function sectionItems(input: SearchItemsInput, section: PanelSection): Candidate[] {
  const pages = new Map<string, PanelPage>(
    panelGroups(section, input.advanced).flatMap((g) => g.pages.map((p) => [p.id, p] as const)),
  );
  const out: Candidate[] = [];
  SET_IDX.forEach((e, i) => {
    if ((e.view === 'admin') !== (section === 'admin')) return;
    const pg = pages.get(e.page);
    if (!pg) return;
    const path =
      e.view === 'admin'
        ? m.search_path_admin_page({ page: pg.label })
        : e.view === 'account'
          ? m.search_path_account_page({ page: pg.label })
          : m.search_path_settings_page({ page: pg.label });
    const sec = e.sec;
    out.push({
      id: `sec/${i}`,
      cat: section === 'admin' ? 'admin' : 'settings',
      label: e.label(),
      icon: e.icon,
      path,
      extra: `${e.kw()} ${pg.label}`,
      run: sec ? () => input.actions.section(pg.route, sec) : () => input.actions.go(pg.route),
    });
  });
  return out;
}

function userItems(input: SearchItemsInput): Candidate[] {
  return input.users
    .filter((u) => u.id !== input.me)
    .map((u) => {
      const label = u.name || u.email;
      const role = roleText(u.role);
      const status = statusText(u.status);
      return {
        id: `user/${u.id}`,
        cat: 'admin',
        label,
        icon: 'ti-user',
        av: avatar(u.name ?? '', u.email),
        path: m.search_path_user({ role, status }),
        extra: `${u.email} ${USER_KW()} ${role} ${status}`,
        run: () => input.actions.openUser(u.id),
      };
    });
}

interface ActionDef {
  id: string;
  label: string;
  icon: IconName;
  /** Search help, no visible texts. */
  kw: string;
  k: string;
  run: () => void;
  /** Desktop only. */
  desk?: boolean;
}

function actionItems(input: SearchItemsInput): Candidate[] {
  const a = input.actions;
  const defs: ActionDef[] = [
    {
      id: 'compose',
      label: m.palette_compose(),
      icon: 'ti-pencil-plus',
      kw: m.search_kw_action_compose(),
      k: 'C',
      run: a.compose,
    },
    {
      id: 'theme',
      label: input.dark ? m.palette_light() : m.palette_dark(),
      icon: input.dark ? 'ti-sun' : 'ti-moon',
      kw: m.search_kw_action_theme(),
      k: '',
      run: a.toggleTheme,
    },
    {
      id: 'sidebar',
      label: m.shortcuts_sidebar(),
      icon: 'ti-layout-sidebar',
      kw: m.search_kw_action_sidebar(),
      k: '[',
      run: a.toggleSidebar,
      desk: true,
    },
    {
      id: 'help',
      label: m.palette_shortcuts(),
      icon: 'ti-keyboard',
      kw: m.search_kw_action_help(),
      k: '?',
      run: a.help,
      desk: true,
    },
    {
      id: 'palette',
      label: m.shortcuts_palette(),
      icon: 'ti-command',
      kw: m.search_kw_action_palette(),
      k: `${input.mod} K`,
      run: a.palette,
      desk: true,
    },
    {
      id: 'account',
      label: m.sidebar_account_add(),
      icon: 'ti-mail-plus',
      kw: m.search_kw_action_account(),
      k: '',
      run: a.addAccount,
    },
    ...(input.isAdmin
      ? [
          {
            id: 'invite',
            label: m.search_action_invite(),
            icon: 'ti-user-plus' as const,
            kw: m.search_kw_action_invite(),
            k: '',
            run: a.invite,
          },
        ]
      : []),
    {
      id: 'logout',
      label: m.account_logout(),
      icon: 'ti-logout',
      kw: m.search_kw_action_logout(),
      k: '',
      run: a.logout,
    },
  ];
  return defs
    .filter((d) => !(d.desk && input.isMobile))
    .map((d) => ({
      id: d.id,
      cat: 'actions',
      label: d.label,
      icon: d.icon,
      path: d.k ? m.search_path_shortcut({ k: d.k }) : m.search_path_action(),
      ...(d.k ? { k: d.k } : {}),
      extra: d.kw,
      run: () => d.run(),
    }));
}

/** Candidates of all local categories in display order. */
export function searchCandidates(input: SearchItemsInput): Candidate[] {
  return [
    ...contactItems(input),
    ...folderItems(input),
    ...tagItems(input),
    ...pageItems(input, 'settings'),
    ...sectionItems(input, 'settings'),
    ...(input.isAdmin ? [...pageItems(input, 'admin'), ...sectionItems(input, 'admin'), ...userItems(input)] : []),
    ...actionItems(input),
  ];
}

/**
 * Notifications of the bell: title and icon from the event catalogue, the
 * text as the path, the time on the right, unread ones bold. The backend lists
 * team and system notifications only for administrators; topics turned off in
 * the app stay findable. A hit marks the notification as read like opening it
 * in the bell (`read`), then leads to the target; unlike the bell it opens the
 * page of the administration without expanding a user.
 */
export function notifItems(
  list: readonly AppNotification[],
  time: TimeContext,
  go: (path: string) => void,
  read: (id: string) => void,
): Candidate[] {
  return list.map((n) => {
    const at = Date.parse(n.created_at);
    const route = targetOf(n.target);
    return {
      id: n.id,
      cat: 'notifs',
      label: n.title,
      icon: isIconName(n.icon) ? n.icon : 'ti-bell',
      path: n.text,
      side: searchTime(at, time),
      unread: n.read_at === null,
      t: at,
      extra: n.text,
      run: () => {
        read(n.id);
        if (route) go(route.path);
      },
    };
  });
}

/** Folder of a found email for path and target: role before custom folder. */
export function hitBox(
  hit: MailHit,
  boxes: readonly Mailbox[],
  /** Tag of a linked mailbox (`tags.byMailbox`): target if the email lies only in one tag. */
  tagOf: (mailbox: string) => { id: string; name: string } | undefined = () => undefined,
): HitBox | null {
  const inHit = boxes.filter((b) => hit.mailboxIds[b.id]);
  for (const role of ROLE_IDS) {
    if (inHit.some((b) => b.role === ROLES[role].role)) return { label: roleLabel(role), role, target: { role } };
  }
  // Custom folders in the order of the tree; without tag mailboxes, which are not folders.
  const own = folderOrder(folderTree(boxes)).find((id) => hit.mailboxIds[id]);
  const box = own ? boxes.find((b) => b.id === own) : undefined;
  if (box) return { label: box.name, role: null, target: { folder: box.id } };
  for (const id of Object.keys(hit.mailboxIds)) {
    const tag = hit.mailboxIds[id] ? tagOf(id) : undefined;
    if (tag) return { label: tag.name, role: null, target: { tag: tag.id } };
  }
  return null;
}

/** IDs of the folder tree in reading order (parents before children). */
function folderOrder(nodes: readonly FolderNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...folderOrder(n.children)]);
}
