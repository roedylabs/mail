/**
 * Mail account: subpages of an account, the mail account part of the
 * settings navigation (including the mobile start page), account picker,
 * overview and "Check connection" (via `POST mail-accounts/:id/check`).
 * Accounts from `accounts`, default account from `prefs`; the layout sets the targets.
 */
import { MA_COLORS } from '@roedy/tokens';
import { ago } from '#lib/ago.ts';
import { ApiError, isApiError, retryAfter } from '#lib/api.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import type { NavEntry } from '#lib/settings-nav.ts';
import { accounts, colorOf, markedDefaultOf, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { waitText } from '#lib/wait.ts';
import { intlLocale } from '#lib/locale.ts';

/** Subpages of an account (routes `/account/mail-accounts/[id]/<page>`). */
export type MailAccountSlug = 'overview' | 'identities' | 'vacation' | 'connection' | 'rules';

export interface MailAccountPage {
  slug: MailAccountSlug;
  label: string;
  icon: IconName;
  /** Description below the heading. */
  desc: string;
}

/** Subpages in navigation order. */
export function mailAccountPages(): MailAccountPage[] {
  return [
    {
      slug: 'overview',
      label: m.mail_account_overview(),
      icon: 'ti-layout-dashboard',
      desc: m.mail_account_overview_desc(),
    },
    {
      slug: 'identities',
      label: m.mail_account_identities(),
      icon: 'ti-id-badge-2',
      desc: m.mail_account_identities_desc(),
    },
    { slug: 'vacation', label: m.mail_account_vacation(), icon: 'ti-beach', desc: m.mail_account_vacation_desc() },
    {
      slug: 'connection',
      label: m.mail_connection_title(),
      icon: 'ti-plug-connected',
      desc: m.mail_connection_desc(),
    },
    { slug: 'rules', label: m.mail_account_rules(), icon: 'ti-filter', desc: m.mail_account_rules_desc() },
  ];
}

export function mailAccountPageOf(slug: MailAccountSlug): MailAccountPage {
  const pages = mailAccountPages();
  const found = pages.find((p) => p.slug === slug);
  if (!found) throw new Error(`Unknown subpage ${slug}`);
  return found;
}

/** Account and subpage of the address; `/account/mail-accounts/new` belongs to the list. */
export interface MailAccountRoute {
  id: string;
  slug: MailAccountSlug;
}

const ROUTE = /^\/account\/mail-accounts\/([^/]+)\/([^/]+)\/?$/;

export function mailAccountRouteOf(path: string): MailAccountRoute | null {
  const hit = ROUTE.exec(path);
  const [, raw, part] = hit ?? [];
  if (!raw || !part) return null;
  const slug = part as MailAccountSlug;
  if (!mailAccountPages().some((p) => p.slug === slug)) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return { id, slug };
}

/** The same subpage (for any account): on mobile, Start stays when switching accounts. */
export function sameMailAccountPage(a: string | null, b: string): boolean {
  const x = a === null ? null : mailAccountRouteOf(a);
  const y = mailAccountRouteOf(b);
  return x !== null && y !== null && x.slug === y.slug;
}

/** Address of a subpage (without `base`; the layout sets it with `resolve`). */
export function mailAccountPath(id: string, slug: MailAccountSlug): string {
  return `/account/mail-accounts/${encodeURIComponent(id)}/${slug}`;
}

const GIB = 1024 ** 3;

/** Storage in GB (bytes / 1024³) with one decimal; small mailboxes not as "0 GB". */
export function gb(bytes: number): string {
  const n = bytes / GIB;
  const digits = n > 0 && n < 0.1 ? { maximumSignificantDigits: 1 } : { maximumFractionDigits: 1 };
  return m.mail_accounts_gb({ n: n.toLocaleString(intlLocale(), digits) });
}

/** "Connected", "Sign-in required", "Server blocked", "Checking …"; `none` without an account (loading). */
export type StatusKind = 'ok' | 'auth' | 'blocked' | 'busy' | 'none';

export interface AccountStatus {
  kind: StatusKind;
  st: string;
  needsAuth: boolean;
}

export function statusOf(a: MailAccount): AccountStatus {
  const needsAuth = a.state === 'needs_reauth';
  if (mailCheck.busy === a.id) return { kind: 'busy', st: m.mail_accounts_st_busy(), needsAuth };
  // A blocked server takes precedence over "Sign-in required".
  if (a.blocked) return { kind: 'blocked', st: m.mail_accounts_st_blocked(), needsAuth };
  return needsAuth
    ? { kind: 'auth', st: m.mail_accounts_st_auth(), needsAuth }
    : { kind: 'ok', st: m.mail_accounts_st_ok(), needsAuth };
}

/** "Checked … ago" or "Last checked … ago" since the last check, otherwise "Not checked yet". */
export function lastOf(a: MailAccount, now: number): string {
  const checked = a.last_check_at ? Date.parse(a.last_check_at) : NaN;
  if (Number.isNaN(checked)) return m.mail_accounts_never();
  const when = ago(checked, now);
  return a.state === 'needs_reauth'
    ? m.mail_accounts_checked_last({ ago: when })
    : m.mail_accounts_checked({ ago: when });
}

/** Account of the page: address, status, tile in the account's colour. */
export interface CurrentAccount extends AccountStatus {
  email: string;
  /** Initial of the address, "?" without an account. */
  letter: string;
  chip: string;
  chipInk: string;
}

/** Without an account (list loading): empty address, neutral tile. */
export const NO_ACCOUNT: CurrentAccount = {
  kind: 'none',
  st: '',
  needsAuth: false,
  email: '',
  letter: '?',
  chip: 'var(--sunken)',
  chipInk: 'var(--fg)',
};

export function currentOf(a: MailAccount | undefined): CurrentAccount {
  if (!a) return NO_ACCOUNT;
  const { bg, ink } = colorOf(a);
  return { ...statusOf(a), email: a.email, letter: a.email.charAt(0).toUpperCase() || '?', chip: bg, chipInk: ink };
}

/** Account with "Default" (like the list and account switcher). */
function isMarkedDefault(a: MailAccount): boolean {
  return markedDefaultOf(accounts.list, prefs.values.defaultAccount)?.id === a.id;
}

/**
 * Error toast of a failed check; `other` replaces the text for all other
 * errors.
 */
export function checkErrorText(error: unknown, host: string, other = m.mail_account_check_other({ host })): string {
  if (isApiError(error, 429)) return m.error_limit({ wait: waitText(retryAfter(error)) });
  if (!(error instanceof ApiError)) return failText(error, other);
  if (error.status === 409 && error.code === 'needs_reauth') return m.mail_account_check_auth({ host });
  if (error.status === 409 && error.code === 'blocked') return m.mail_account_check_blocked({ host });
  // Reasons of the mail server (`check_failed`) and of the broker (`refresh_failed`).
  const reason = error.status === 502 ? error.body.reason : undefined;
  if (reason === 'unreachable') return m.mail_account_check_unreachable({ host });
  if (reason === 'throttled') return m.mail_account_check_throttled({ host });
  if (reason === 'auth_failed') return m.mail_account_check_auth_failed({ host });
  if (reason === 'forbidden') return m.mail_account_check_forbidden({ host });
  return other;
}

/**
 * Reason when a subpage cannot load its data from the mail server
 * (identities, vacation notice): broker reasons as for the check,
 * otherwise the generic text.
 */
export function loadErrorText(error: unknown, host: string): string {
  return checkErrorText(error, host, m.error_act());
}

/** The first load of a subpage failed; `error` for the reason and buttons of the card. */
export class LoadFailed {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

/** Card "Couldn’t load …". */
export interface LoadFailure {
  /** Reason as for "Check connection". */
  text: string;
  /** "Try again": except with a locked server and "Sign-in required". */
  retry: boolean;
  /** "Sign in again" for `needs_reauth` and `auth_failed`; leads to Connection. */
  reauth: boolean;
  /** "Go to connection" for a locked server (`blocked`). */
  con: boolean;
}

export function loadFailureOf(error: unknown, host: string): LoadFailure {
  const code = error instanceof ApiError && error.status === 409 ? error.code : undefined;
  const authFailed = error instanceof ApiError && error.status === 502 && error.body.reason === 'auth_failed';
  return {
    text: loadErrorText(error, host),
    retry: code !== 'blocked' && code !== 'needs_reauth',
    reauth: code === 'needs_reauth' || authFailed,
    con: code === 'blocked',
  };
}

/** Values of the card with "Try again" (`onRetry`) and the way to Connection (`goCon`). */
export interface LoadValues extends LoadFailure {
  onRetry: () => void;
  goCon: () => void;
}

/** Target of the "Sign in again" and "Go to connection" buttons. */
export interface LoadInput {
  /** Mail account › Connection of the account. */
  connection: (id: string) => void;
}

/**
 * "Check connection": one check at a time, the icon turns two more
 * revolutions per check. Success with a toast, except for the check when
 * opening the overview (`auto`); every error as an error toast by reason.
 */
export class MailCheck {
  busy = $state<string | null>(null);
  rot = $state(0);

  async run(id: string, auto = false): Promise<void> {
    const account = accounts.get(id);
    if (this.busy || !account) return;
    const host = account.host;
    this.busy = id;
    this.rot += 720;
    try {
      await accounts.check(id);
      if (!auto) ui.toasts.show(m.mail_account_check_ok({ host }));
    } catch (error) {
      // Removed (another tab): the list reloads, the page then leads to the list.
      if (isApiError(error, 404)) void accounts.load().catch(() => {});
      ui.toasts.error(checkErrorText(error, host));
    } finally {
      this.busy = null;
    }
  }

  /**
   * Check when opening the overview: only without `last_check_at`,
   * not with "Sign-in required" or a locked server, once per visit
   * (the page calls it once).
   */
  auto(id: string): void {
    const a = accounts.get(id);
    if (a && a.last_check_at === null && a.state !== 'needs_reauth' && !a.blocked) void this.run(id, true);
  }
}

export const mailCheck = new MailCheck();

/** Choose a colour; without a toast, on failure the generic error toast. */
async function chooseColor(id: string, color: number): Promise<void> {
  try {
    await accounts.setColor(id, color);
  } catch (error) {
    if (isApiError(error, 404)) void accounts.load().catch(() => {});
    ui.toasts.error(failText(error));
  }
}

/** "Set as default": `defaultAccount`, toast with undo. */
function makeDefault(a: MailAccount): void {
  const prev = prefs.values.defaultAccount;
  if (prev === a.id) return;
  prefs.set({ defaultAccount: a.id });
  ui.toasts.defer({
    text: m.mail_account_default_done({ email: a.email }),
    revert: () => prefs.set({ defaultAccount: prev }),
  });
}

/** Targets of the account navigation; the layout sets them with `goto` and `resolve`. */
export interface MailAccountTargets {
  /** Subpage of an account (navigation, Start). */
  open: (id: string, slug: MailAccountSlug) => void;
  /** Another account from the account picker, same subpage; on mobile Start stays. */
  switchTo: (id: string, slug: MailAccountSlug) => void;
  /** "Add account": `/account/mail-accounts/new`. */
  add: () => void;
  /** "View all accounts": `/account/mail-accounts`. */
  manage: () => void;
}

/** Account of the account picker. */
export interface PickerAccount {
  id: string;
  email: string;
  host: string;
  letter: string;
  tileBg: string;
  tileInk: string;
  /** "Default" (mobile only). */
  isDef: boolean;
  /** Connected: the check mark on mobile, otherwise "Sign-in required". */
  ok: boolean;
  warn: boolean;
  /** Account of the page. */
  checked: boolean;
  onClick: () => void;
}

/** Account picker: desktop popover above the account switch, mobile content of the sheet. */
export interface AccountPickerValues {
  isMobile: boolean;
  maSwList: PickerAccount[];
  maSwAdd: () => void;
  maSwManage: () => void;
  /** Mobile: close the sheet. */
  closeSheet: () => void;
}

/** Mail account part of the settings navigation and of the mobile start page. */
export interface MailAccountNavValues {
  /** Subpages as navigation entries. */
  maNav: NavEntry[];
  maCur: CurrentAccount;
  /** Account picker open (popover on desktop, the sheet on mobile). */
  maSwOpen: boolean;
  /** Tooltip of the account switch only when collapsed and with the account picker closed. */
  maSwTip: string | undefined;
  toggleMaSw: () => void;
  picker: AccountPickerValues;
}

export interface MailAccountNavInput {
  route: MailAccountRoute;
  isMobile: boolean;
  collapsed: boolean;
  /** `ui.menu === 'masw'`. */
  pickerOpen: boolean;
  togglePicker: () => void;
  closePicker: () => void;
  targets: MailAccountTargets;
}

export function mailAccountNavValues(input: MailAccountNavInput): MailAccountNavValues {
  const { route, targets } = input;
  const list = accounts.list ?? [];
  const cur = currentOf(accounts.get(route.id));
  const maNav = mailAccountPages().map((p): NavEntry => {
    const on = p.slug === route.slug;
    return {
      id: p.slug,
      label: p.label,
      icon: p.icon,
      on,
      fw: on ? 800 : 600,
      tip: input.collapsed ? p.label : undefined,
      onClick: () => targets.open(route.id, p.slug),
    };
  });
  const maSwList = list.map((a): PickerAccount => {
    const { bg, ink } = colorOf(a);
    const warn = a.state === 'needs_reauth';
    return {
      id: a.id,
      email: a.email,
      host: a.host,
      letter: a.email.charAt(0).toUpperCase(),
      tileBg: bg,
      tileInk: ink,
      isDef: isMarkedDefault(a),
      ok: !warn,
      warn,
      checked: a.id === route.id,
      onClick: () => {
        input.closePicker();
        if (a.id !== route.id) targets.switchTo(a.id, route.slug);
      },
    };
  });
  return {
    maNav,
    maCur: cur,
    maSwOpen: input.pickerOpen,
    maSwTip: input.collapsed && !input.pickerOpen && cur.email ? cur.email : undefined,
    toggleMaSw: input.togglePicker,
    picker: {
      isMobile: input.isMobile,
      maSwList,
      maSwAdd: () => {
        input.closePicker();
        targets.add();
      },
      maSwManage: () => {
        input.closePicker();
        targets.manage();
      },
      closeSheet: input.closePicker,
    },
  };
}

/** Colour of the overview. */
export interface ColorOption {
  /** Name of the colour (`aria-label`). */
  name: (typeof MA_COLORS)[number][0];
  base: string;
  ink: string;
  on: boolean;
  onClick: () => void;
}

/** "Storage" row with the bar. */
export interface StorageValues {
  /** "2.4 GB of 10 GB used". */
  quota: string;
  usedT: string;
  totalT: string;
  /** "7.6 GB free". */
  freeT: string;
  /** "24 %". */
  pctT: string;
  pctN: number;
  /** Width of the bar ("24%"). */
  quotaW: string;
  /** Red from 90 %. */
  full: boolean;
}

/** Storage as soon as both values are known. */
export function storageOf(a: Pick<MailAccount, 'quota_used' | 'quota_total'>): StorageValues | null {
  const used = a.quota_used;
  const total = a.quota_total;
  if (used === null || total === null || total <= 0) return null;
  const pct = Math.min(100, Math.round((used / total) * 100));
  return {
    quota: m.mail_account_quota({ used: gb(used), total: gb(total) }),
    usedT: gb(used),
    totalT: gb(total),
    freeT: m.mail_account_free({ size: gb(Math.max(0, total - used)) }),
    pctT: m.mail_account_pct({ n: pct }),
    pctN: pct,
    quotaW: `${pct}%`,
    full: pct >= 90,
  };
}

/**
 * Storage card without values: "No limit" after a check without quota
 * (`noLimit`), otherwise not checked yet – "Checking …" during the check,
 * afterwards "Not checked yet".
 */
export interface StorageNote {
  noLimit: boolean;
  busy: boolean;
  title: string;
  text: string;
}

export function storageNoteOf(a: MailAccount, busy: boolean): StorageNote | null {
  if (storageOf(a)) return null;
  const host = a.host;
  if (a.last_check_at !== null) {
    return {
      noLimit: true,
      busy: false,
      title: m.mail_account_no_limit(),
      text: m.mail_account_no_limit_text({ host }),
    };
  }
  if (busy)
    return { noLimit: false, busy: true, title: m.mail_account_q_busy(), text: m.mail_account_q_busy_text({ host }) };
  return {
    noLimit: false,
    busy: false,
    title: m.mail_account_q_idle(),
    text: a.blocked
      ? m.mail_account_q_idle_blocked({ host })
      : a.state === 'needs_reauth'
        ? m.mail_account_q_idle_auth({ host })
        : m.mail_account_q_idle_text({ host }),
  };
}

/** Values of the overview page. */
export interface OverviewValues extends CurrentAccount {
  last: string;
  /** Line below the status: with a locked server its notice, otherwise `last`. */
  stSub: string;
  /** Server locked: "Go to connection" instead of "Sign in again" or "Check connection". */
  blocked: boolean;
  /** "Sign in again" (`needsAuth`, not with a locked server). */
  reauth: boolean;
  /** "Check connection". */
  okAuth: boolean;
  /** "Last checked … ago" below the storage with a locked server; otherwise empty. */
  asOf: string;
  /** Check of this account running ("Checking"). */
  busy: boolean;
  checkLabel: string;
  /** Rotation of the icon in degrees. */
  rot: number;
  check: () => void;
  /** "Sign in again": Mail account › Connection. */
  goCon: () => void;
  /** With a limit, otherwise `null` and `storageNote`. */
  storage: StorageValues | null;
  storageNote: StorageNote | null;
  colors: ColorOption[];
  isDefault: boolean;
  notDefault: boolean;
  makeDefault: () => void;
}

export interface OverviewInput {
  now?: number;
  /** Mail account › Connection of the account. */
  connection: (id: string) => void;
}

export function overviewValues(a: MailAccount, input: OverviewInput): OverviewValues {
  const cur = currentOf(a);
  const busy = mailCheck.busy === a.id;
  const isDefault = isMarkedDefault(a);
  const now = input.now ?? Date.now();
  const last = lastOf(a, now);
  const checked = a.last_check_at ? Date.parse(a.last_check_at) : NaN;
  return {
    ...cur,
    last,
    stSub: a.blocked ? m.mail_account_check_blocked({ host: a.host }) : last,
    blocked: a.blocked,
    reauth: cur.needsAuth && !a.blocked,
    okAuth: !cur.needsAuth && !a.blocked,
    asOf: a.blocked && !Number.isNaN(checked) ? m.mail_account_as_of({ ago: ago(checked, now) }) : '',
    busy,
    checkLabel: busy ? m.mail_account_checking() : m.mail_account_check(),
    rot: mailCheck.rot,
    check: () => void mailCheck.run(a.id),
    goCon: () => input.connection(a.id),
    storage: storageOf(a),
    storageNote: storageNoteOf(a, busy),
    colors: MA_COLORS.map(([name, base, ink], i) => ({
      name,
      base,
      ink,
      on: i === a.color,
      onClick: () => void chooseColor(a.id, i),
    })),
    isDefault,
    notDefault: !isDefault,
    makeDefault: () => makeDefault(a),
  };
}
