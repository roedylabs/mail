/**
 * Mailboxes in the sidebar, account switcher and command palette: which
 * account or whether "All accounts" the sidebar shows (also the target of
 * keys 1–6), its "Mailboxes" rows, the account switch, the account switcher
 * popup and the "Navigation" group of the palette.
 */
import type { Identity } from '@roedy/jmap';
import { m } from '#lib/paraglide/messages.js';
import { ALL_ACCOUNTS, ROLE_IDS, type MailboxLocation, type RoleId } from '#lib/routes.ts';
import {
  fontWeight,
  navItem,
  type AccountSwitch,
  type AccountSwitcherValues,
  type Command,
  type NavItem,
  type SidebarRow,
} from '#lib/shell.ts';
import {
  DEFAULT_ALL,
  defaultAccountOf,
  markedDefaultOf,
  tileOf,
  tilesOf,
  type MailAccount,
} from '#lib/state/accounts.svelte.ts';
import { ROLES, type Counts } from '#lib/state/mailboxes.svelte.ts';

export function roleLabel(role: RoleId): string {
  return {
    inbox: m.mailbox_inbox,
    sent: m.mailbox_sent,
    drafts: m.mailbox_drafts,
    scheduled: m.mailbox_scheduled,
    trash: m.mailbox_trash,
    spam: m.mailbox_spam,
  }[role]();
}

/** What the sidebar shows: one account or "All accounts". */
export interface SidebarScope {
  all: boolean;
  /** Account of the sidebar; `null` in "All accounts" and without an account. */
  account: MailAccount | null;
  /** Account in the address of its mailboxes: account id or `all`; `null` without an account. */
  key: string | null;
}

/**
 * View of the sidebar: "All accounts" with more than one account and
 * `/mailbox/all/…` – without a mailbox in the address or with an unknown
 * account if "All accounts" is the default –, otherwise the account of the
 * address, the default account or the first one.
 */
export function sidebarScope(
  list: readonly MailAccount[] | null,
  defaultId: string | null,
  location: MailboxLocation | null,
): SidebarScope {
  const fromPath = location ? list?.find((a) => a.id === location.account) : undefined;
  const all = location?.account === ALL_ACCOUNTS || (!fromPath && defaultId === DEFAULT_ALL);
  if (all && (list?.length ?? 0) > 1) return { all: true, account: null, key: ALL_ACCOUNTS };
  const account = fromPath ?? defaultAccountOf(list, defaultId);
  return { all: false, account, key: account?.id ?? null };
}

/** Does the address show a mailbox of the view? With only one account, `all` counts as that account. */
export function inScope(scope: SidebarScope, location: MailboxLocation | null): boolean {
  if (!location || scope.key === null) return false;
  return location.account === scope.key || (!scope.all && location.account === ALL_ACCOUNTS);
}

export interface NavRowsInput {
  /** Role of the view if it shows a sidebar mailbox. */
  active: RoleId | null;
  /** Count of the mailbox; `null` while unknown or without a mailbox of this role. */
  counts: (role: RoleId) => Counts | null;
  wide: boolean;
  /** Keyboard shortcuts active: tooltip with the key. */
  keys: boolean;
  open: (role: RoleId) => void;
}

/** "Mailboxes" rows of the sidebar. */
export function navRowsFor(input: NavRowsInput): SidebarRow[] {
  return ROLE_IDS.map((role, i) => {
    const on = input.active === role;
    const label = roleLabel(role);
    const counts = input.counts(role);
    const unread = counts?.unread ?? 0;
    const total = counts?.total ?? 0;
    return {
      id: role,
      label,
      icon: ROLES[role].icon,
      on,
      fw: fontWeight(on),
      shadow: on ? 'var(--sh1)' : 'none',
      hasCnt: total > 0,
      cntU: String(unread),
      cntN: String(total),
      cntLabel: m.mailbox_count({ unread, total }),
      tip: input.wide ? undefined : input.keys ? m.sidebar_row_key({ label, key: i + 1 }) : label,
      onClick: () => input.open(role),
    };
  });
}

/** Mailboxes in the mobile "Mailboxes" sheet: without counts and tooltips. */
export function mobileRows(active: RoleId | null, open: (role: RoleId) => void): NavItem[] {
  return ROLE_IDS.map((role) => navItem(roleLabel(role), ROLES[role].icon, active === role, () => open(role)));
}

/**
 * Title of the account switch: the name of the identity with the account's
 * address, otherwise of the first identity; without a name (or before the
 * identities are loaded) the part of the address before the @.
 */
export function accountTitle(email: string, identities: readonly Pick<Identity, 'name' | 'email'>[] | null): string {
  const list = identities ?? [];
  const identity = list.find((i) => i.email === email) ?? list[0];
  return identity?.name || email.split('@')[0] || email;
}

/** Account switch of the sidebar and the sheet. */
export function accountSwitch(input: {
  scope: SidebarScope;
  /** Number of accounts (`‹n› mailboxes` in "All accounts"). */
  count: number;
  open: boolean;
  wide: boolean;
  /** Identities of the sidebar's account; `null` while not loaded. */
  identities?: readonly Pick<Identity, 'name' | 'email'>[] | null;
}): AccountSwitch {
  const { scope, open } = input;
  // Tooltip only when collapsed and with the popup closed.
  const tip = (label: string) => (input.wide || open ? undefined : label);
  if (scope.all) {
    const label = m.switcher_all();
    return {
      email: label,
      isAll: true,
      letter: '',
      open,
      sub: m.switcher_mailboxes({ count: input.count }),
      tip: tip(label),
      title: label,
      warn: false,
      tileBg: 'transparent',
      tileInk: 'var(--fg)',
    };
  }
  const account = scope.account;
  if (!account) {
    const label = m.sidebar_account_add();
    return {
      email: label,
      isAll: false,
      letter: '+',
      open,
      sub: '',
      tip: tip(label),
      title: label,
      warn: false,
      tileBg: 'var(--sunken)',
      tileInk: 'var(--fg)',
    };
  }
  const { letter, bg, ink } = tileOf(account);
  return {
    email: account.email,
    isAll: false,
    letter,
    open,
    sub: account.email,
    tip: tip(account.email),
    title: accountTitle(account.email, input.identities ?? null),
    warn: account.state === 'needs_reauth',
    tileBg: bg,
    tileInk: ink,
  };
}

export interface SwitcherInput {
  list: readonly MailAccount[];
  scope: SidebarScope;
  /** `defaultAccount` of the settings (account id, `all` or `null`). */
  defaultId: string | null;
  isMobile: boolean;
  /** Switches to an account (account id) or to "All accounts" (`all`) with the open mailbox. */
  pick: (key: string) => void;
  add: () => void;
  manage: () => void;
  close: () => void;
}

/** Values of the account switcher popup (desktop and mobile). */
export function switcherValues(input: SwitcherInput): AccountSwitcherValues {
  const { list, scope } = input;
  const def = markedDefaultOf(list, input.defaultId);
  return {
    isMobile: input.isMobile,
    acctAll: {
      show: list.length > 1,
      checked: scope.all,
      n: m.switcher_mailboxes({ count: list.length }),
      onClick: () => input.pick(ALL_ACCOUNTS),
    },
    allTiles: tilesOf(list, 4),
    acctList: list.map((a) => {
      const { letter, bg, ink } = tileOf(a);
      return {
        id: a.id,
        email: a.email,
        letter,
        tileBg: bg,
        tileInk: ink,
        warn: a.state === 'needs_reauth',
        host: a.host,
        checked: scope.account?.id === a.id,
        isDef: def?.id === a.id,
        onClick: () => input.pick(a.id),
      };
    }),
    addMailAcct: input.add,
    manageMailAccts: input.manage,
    closeSw: input.close,
  };
}

/** "Navigation" group of the palette: the mailboxes of every account ("Inbox · ‹address›"). */
export function mailboxCommands(
  list: readonly MailAccount[],
  open: (account: string, role: RoleId) => void,
): Command[] {
  const g = m.palette_group_navigation();
  return list.flatMap((account) =>
    ROLE_IDS.map((role) => ({
      g,
      label: m.palette_mailbox({ label: roleLabel(role), email: account.email }),
      icon: ROLES[role].icon,
      run: () => open(account.id, role),
    })),
  );
}
