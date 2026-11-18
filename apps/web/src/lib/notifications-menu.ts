/**
 * Notifications popup and the bell in the header: values from the entries of
 * the state module `notifications` and the settings (`nCh.app`, `nMx`).
 *
 * - Visible are entries whose topic is wanted in the app; security always
 *   (`shownInApp`). Channel "In the app" off: `notifOff`, count 0.
 * - First load failed (`failure`, no list yet): `notifFail`, a "Couldn’t load
 *   notifications" card with the reason instead of the placeholder rows,
 *   without count; a running fetch shows the placeholder rows again.
 * - Groups "Today" and "Earlier" by calendar day in the time zone from
 *   Language & region.
 * - Targets (`targetOf`): the backend's path; team opens the row of the
 *   user or invitation (`ui.userOpen`, the list if there is no match),
 *   "Storage almost full" the overview of the mail account (the page
 *   redirects unknown accounts to the list).
 */
import { ago } from '#lib/ago.ts';
import { isIconName, type IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { safePath } from '#lib/push-message.ts';
import type { Channels } from '#lib/state/prefs.svelte.ts';
import { shownInApp, type AppNotification, type NotificationTarget } from '#lib/state/notifications.svelte.ts';
import { zoneDayStart } from '#lib/timezone.ts';

/** Entry in the popup. */
export interface NotifItem {
  id: string;
  icon: IconName;
  title: string;
  text: string;
  hasText: boolean;
  /** "2 hours ago". */
  time: string;
  /** Unread: dot on the tile. */
  dot: boolean;
  fw: 700 | 800;
  tileBg: string;
  tileInk: string;
  /** Open: mark as read and go to the target (without a target the popup stays open). */
  open: () => void;
  /** Enter and space on the row. */
  key: (event: KeyboardEvent) => void;
  /** "Dismiss" (without opening the row). */
  dismiss: (event: MouseEvent) => void;
}

export interface NotifGroup {
  label: string;
  items: NotifItem[];
}

/** Props of `NotificationsMenu`. */
export interface NotifMenuValues {
  isMobile: boolean;
  notifGroups: NotifGroup[];
  /** Until the first response (channel "In the app" on): placeholder rows with `aria-busy`. */
  notifBusy: boolean;
  /** Reload of the shown entries running (`aria-busy` of the list). */
  notifBusyAttr: boolean;
  notifHas: boolean;
  notifEmpty: boolean;
  notifOff: boolean;
  /** First load failed (channel "In the app" on, no fetch running): card instead of the placeholder rows. */
  notifFail: boolean;
  /** Reason on the card: wait time after 429, "No connection", otherwise "That didn’t work". */
  notifFailText: string;
  hasUnread: boolean;
  /** Count in the header: only the number, from 100 "99+". */
  notifNewLabel: string;
  /** Name of the count for screen readers: "‹n› new". */
  notifNewAria: string;
  notifMarkAll: () => void;
  notifEnable: () => void;
  /** "Try again" on the card: reload (placeholder rows until the answer). */
  notifRetry: () => void;
  openNotifSettings: () => void;
}

/** Bell in the header. */
export interface BellValues {
  bellBadge: boolean;
  /** Number at the dot, from 10 "9+". */
  bellBadgeN: string;
  bellLabel: string;
}

export interface NotifMenuInput {
  isMobile: boolean;
  /** Entries; `null` until the first response (then placeholder rows). */
  list: readonly AppNotification[] | null;
  /** A fetch is running: entries already shown stay, marked `aria-busy`, until its response. */
  loading: boolean;
  /** Reason of the failed first load, otherwise `null`. */
  failure: string | null;
  /** Channels (`nCh`) and topics (`nMx`) of the settings. */
  channels: Channels;
  topics: Readonly<Record<string, Channels>>;
  /** Time zone for "Today". */
  tz: string;
  now: number;
}

export interface NotifMenuActions {
  open: (entry: AppNotification) => void;
  dismiss: (id: string) => void;
  markAll: () => void;
  enable: () => void;
  retry: () => void;
  settings: () => void;
}

/** Visible entries and the unread ones among them. */
export function visibleNotifications(input: Pick<NotifMenuInput, 'list' | 'channels' | 'topics'>): {
  visible: AppNotification[];
  unread: number;
} {
  const visible = (input.list ?? []).filter((n) => shownInApp(n.topic, input.topics));
  const unread = input.channels.app ? visible.filter((n) => !n.read_at).length : 0;
  return { visible, unread };
}

/** Bell: dot with number and label. */
export function bellValues(unread: number): BellValues {
  return {
    bellBadge: unread > 0,
    bellBadgeN: unread > 9 ? '9+' : String(unread),
    bellLabel: unread ? m.shell_bell_new({ n: unread }) : m.shell_bell(),
  };
}

function item(n: AppNotification, now: number, actions: NotifMenuActions): NotifItem {
  const read = n.read_at !== null;
  const open = () => actions.open(n);
  return {
    id: n.id,
    icon: isIconName(n.icon) ? n.icon : 'ti-bell',
    title: n.title,
    text: n.text,
    hasText: n.text !== '',
    time: ago(Date.parse(n.created_at), now),
    dot: !read,
    fw: read ? 700 : 800,
    tileBg: read ? 'var(--surface2)' : 'var(--accsoft)',
    tileInk: read ? 'var(--mfg)' : 'var(--deep)',
    open,
    key: (event) => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      open();
    },
    dismiss: (event) => {
      event.stopPropagation();
      actions.dismiss(n.id);
    },
  };
}

export function notifMenuValues(input: NotifMenuInput, actions: NotifMenuActions): NotifMenuValues {
  const { visible, unread } = visibleNotifications(input);
  const today = zoneDayStart(input.now, input.tz);
  const recent: AppNotification[] = [];
  const earlier: AppNotification[] = [];
  for (const n of visible) (zoneDayStart(Date.parse(n.created_at), input.tz) === today ? recent : earlier).push(n);
  const groups: [string, AppNotification[]][] = [
    [m.notif_pop_today(), recent],
    [m.notif_pop_earlier(), earlier],
  ];
  const app = input.channels.app;
  const first = app && input.list === null;
  const fail = first && input.failure !== null && !input.loading;
  return {
    isMobile: input.isMobile,
    notifGroups: groups
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => ({ label, items: items.map((n) => item(n, input.now, actions)) })),
    notifBusy: first && !fail,
    notifBusyAttr: app && input.list !== null && input.loading,
    notifHas: app && visible.length > 0,
    notifEmpty: app && input.list !== null && visible.length === 0,
    notifOff: !app,
    notifFail: fail,
    notifFailText: input.failure ?? '',
    hasUnread: unread > 0,
    notifNewLabel: unread > 99 ? '99+' : String(unread),
    notifNewAria: m.notif_pop_new({ n: unread }),
    notifMarkAll: actions.markAll,
    notifEnable: actions.enable,
    notifRetry: actions.retry,
    openNotifSettings: actions.settings,
  };
}

/** Where an entry leads: app path and possibly the row under Administration › Users. */
export interface TargetRoute {
  path: string;
  /** User or invitation to expand. */
  userOpen: string | null;
}

/** Target of an entry; only app paths. */
export function targetOf(target: NotificationTarget | null): TargetRoute | null {
  if (!target) return null;
  const userOpen = target.view === 'admin' ? (target.user_id ?? target.invitation_id ?? null) : null;
  return { path: safePath(target.path), userOpen };
}
