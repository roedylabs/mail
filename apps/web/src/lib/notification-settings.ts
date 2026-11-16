/**
 * Settings › Notifications page: channels (`nChRows`), topics per channel
 * (`nTopicRows`), new emails per mail account (`mpRows`) and delivery with
 * quiet hours (`nFromSel`, `nToSel`), email digest (`digestOpts`) and sound
 * (`tgSound`); the `notifTabs` tabs jump to the sections.
 *
 * - **Topics team and system** only for administrators (`admin`); for the
 *   security topic, app and email are locked and always active (`lock`),
 *   even if the channel above is off; push can be chosen.
 * - **Push channel** follows the state of this browser (`#lib/push.svelte.ts`):
 *   the description names support and permission. Turning it on only sets
 *   the channel if this browser is already subscribed; with permission it
 *   subscribes silently (`pushOn`), otherwise it opens the push dialog
 *   (`pushDialog`). "Allow in browser" (`askHere`) appears while the channel
 *   is on but this browser is not subscribed. Turning it off also
 *   unsubscribes the subscriptions of the mail accounts on this device
 *   (`mailPushPause`).
 * - **New emails**: one switch per mail account, only for this device
 *   (`#lib/mail-push.svelte.ts`). It requires the active push channel
 *   (`push.status`); otherwise tile and switch are dimmed and disabled, and
 *   `mpNeedRun` turns the channel on like its switch. Sign-in required and a
 *   locked server disable the row and lead to Mail account › Connection;
 *   without a connection nothing is switched.
 * - **Quiet hours**: hold back email and push until their end; start = end
 *   counts as off. The digest comes daily at 07:00 or on Mondays at 07:00 in
 *   the time zone from Language & region; if 07:00 lies within active quiet
 *   hours, at their end. Times follow the time format; a locale-specific
 *   clock suffix is added only in the 24-hour format.
 */
import type { SegOption } from '#lib/appearance.ts';
import type { IconName } from '#lib/icons.ts';
import type { MailPushStatus } from '#lib/mail-push.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import type { PushStatus, PushSupport } from '#lib/push.svelte.ts';
import { segOptions } from '#lib/select.ts';
import { DIGEST_OPTS } from '#lib/settings-choices.ts';
import type { Channels, Settings } from '#lib/state/prefs.svelte.ts';
import { inQuiet, minutesOf } from '#lib/quiet-hours.ts';
import { clockLabel, timePickValues, type TimePickValues } from '#lib/time-picker.ts';
import { zoneName } from '#lib/timezone.ts';

export { DIGEST_OPTS };

/** Sections of the page (`data-sec`, `notifTabs`). */
export type NotifSection = 'channels' | 'topics' | 'mailpush' | 'delivery';

export type ChannelId = keyof Channels;

export type TopicId = 'security' | 'account' | 'team' | 'system' | 'news';

/** Time picker of the quiet hours: start or end. */
export type QuietKey = 'from' | 'to';

/** Notification channel. */
export interface NotifChannel {
  id: ChannelId;
  icon: IconName;
  label: () => string;
  /** Short name on the chip of a topic. */
  short: () => string;
}

/** Notification topic. */
export interface NotifTopic {
  id: TopicId;
  icon: IconName;
  label: () => string;
  desc: () => string;
  /** Only for administrators. */
  admin?: true;
  /** Channels that are always active for the topic. */
  lock?: readonly ChannelId[];
}

export const NOTIF_CH: readonly NotifChannel[] = [
  { id: 'app', icon: 'ti-bell', label: () => m.notif_ch_app(), short: () => m.notif_ch_app_short() },
  { id: 'mail', icon: 'ti-mail', label: () => m.notif_ch_mail(), short: () => m.notif_ch_mail_short() },
  { id: 'push', icon: 'ti-device-mobile', label: () => m.notif_ch_push(), short: () => m.notif_ch_push_short() },
];

export const NOTIF_TOPICS: readonly NotifTopic[] = [
  {
    id: 'security',
    icon: 'ti-shield-lock',
    label: () => m.notif_topic_security(),
    desc: () => m.notif_topic_security_desc(),
    lock: ['app', 'mail'],
  },
  { id: 'account', icon: 'ti-user', label: () => m.notif_topic_account(), desc: () => m.notif_topic_account_desc() },
  {
    id: 'team',
    icon: 'ti-users',
    label: () => m.notif_topic_team(),
    desc: () => m.notif_topic_team_desc(),
    admin: true,
  },
  {
    id: 'system',
    icon: 'ti-server',
    label: () => m.notif_topic_system(),
    desc: () => m.notif_topic_system_desc(),
    admin: true,
  },
  { id: 'news', icon: 'ti-sparkles', label: () => m.notif_topic_news(), desc: () => m.notif_topic_news_desc() },
];

/** Time of the digest: daily or on Mondays at 07:00. */
export const DIGEST_AT = '07:00';

const DIGEST_LABELS: Record<Settings['nDigest'], () => string> = {
  instant: () => m.notif_digest_now(),
  daily: () => m.notif_digest_daily(),
  weekly: () => m.notif_digest_weekly(),
};

const TABS: [NotifSection, () => string][] = [
  ['channels', () => m.notif_tab_channels()],
  ['topics', () => m.notif_tab_topics()],
  ['mailpush', () => m.mailpush_title()],
  ['delivery', () => m.notif_tab_delivery()],
];

const NO_CHANNELS: Channels = { app: false, mail: false, push: false };

export interface Toggle {
  on: boolean;
  onClick: () => void;
}

/** Row of a channel; the tile follows `tg.on` (accent colour, rotated). */
export interface ChannelRow {
  id: ChannelId;
  label: string;
  icon: IconName;
  sep: boolean;
  desc: string;
  /** "Allow in browser" below the row (push only). */
  askHere: boolean;
  tg: Toggle;
}

/** Chip of a channel for a topic. */
export interface TopicChip {
  id: ChannelId;
  label: string;
  icon: IconName;
  aria: string;
  /** Active: locked, or channel on and chosen for the topic. */
  on: boolean;
  /** Always active for the topic (lock); no effect on click. */
  lock: boolean;
  /** Channel above switched on; when off, the chip is dimmed and without effect. */
  live: boolean;
  tip: string | undefined;
  onClick: () => void;
}

export interface TopicRow {
  id: TopicId;
  label: string;
  desc: string;
  icon: IconName;
  sep: boolean;
  chips: TopicChip[];
}

/** Row of a mail account under "New emails"; the tile follows `tg.on`. */
export interface MailPushRow {
  id: string;
  email: string;
  sep: boolean;
  desc: string;
  /** Colour of the description; `null` is muted. */
  tone: 'danger' | 'warn' | null;
  /** Push channel not active: tile and switch dimmed. */
  dim: boolean;
  /** Switch without effect (`aria-disabled`). */
  dis: boolean;
  /** Currently switching (`aria-busy`). */
  busy: boolean;
  /** Sign-in required: "Sign in again". */
  hasRe: boolean;
  /** Server locked: "Go to connection". */
  hasCon: boolean;
  goCon: () => void;
  tg: Toggle;
}

export interface NotifValues {
  notifTabs: { label: string; onClick: () => void }[];
  nChRows: ChannelRow[];
  /** "Allow in browser": opens the push dialog. */
  pushRequest: () => void;
  nTopicRows: TopicRow[];
  mpSub: string;
  /** No mail account connected; while the list is loading, neither this nor rows. */
  mpNone: boolean;
  mpNoneText: string;
  mpHasRows: boolean;
  mpRows: MailPushRow[];
  /** Push channel not active on this device: row with button. */
  mpNeed: boolean;
  mpNeedText: string;
  mpNeedBtn: string;
  /** Like the switch of the push channel when turning on. */
  mpNeedRun: () => void;
  /** Push active and quiet hours active (start ≠ end). */
  mpNoteOn: boolean;
  mpNote: string;
  tgQuiet: Toggle;
  nFromSel: TimePickValues;
  nToSel: TimePickValues;
  nH24: boolean;
  quietSum: string;
  /** Quiet hours on, start = end: notice with warning icon in `--warn`. */
  quietSame: boolean;
  quietNote: string;
  quietNoteIcon: IconName;
  /** Quiet hours off: from/to and notice dimmed, fields disabled. */
  quietDim: boolean;
  digestOpts: SegOption<Settings['nDigest']>[];
  digestSum: string;
  /** Email channel off: segment dimmed and disabled. */
  digestDim: boolean;
  delivSub: string;
  tgSound: Toggle;
  /** "In the app" channel off: switch dimmed and without effect. */
  soundDis: boolean;
  /** Tooltip on the disabled switch, desktop only. */
  soundTip: string | undefined;
}

/** State of push in this browser (`#lib/push.svelte.ts`). */
export interface PushInfo {
  support: PushSupport;
  permission: NotificationPermission;
  status: PushStatus;
  /** This browser is subscribed at the backend (`push.current`). */
  subscribed: boolean;
  /** Name of the app for the notice on iPhone and iPad (`session.appName`). */
  appName: string;
}

/** Mail account under "New emails" (`accounts.list`, `mailPush.of`). */
export interface MailPushAccount {
  id: string;
  email: string;
  host: string;
  /** "Sign-in required". */
  auth: boolean;
  blocked: boolean;
  status: MailPushStatus;
}

export interface NotifInput {
  values: Pick<Settings, 'nCh' | 'nMx' | 'nQuiet' | 'nFrom' | 'nTo' | 'nDigest' | 'nSound' | 'timeFmt'>;
  /** Address of the app account for the email channel. */
  email: string;
  isAdmin: boolean;
  push: PushInfo;
  /** Mail accounts; `null` while the list is not loaded. */
  mailAccounts: readonly MailPushAccount[] | null;
  /** No connection (`network.offline`). */
  offline: boolean;
  /** Time zone from Language & region (`displayZone`) and the device's (unknown `undefined`). */
  zone: string;
  device: string | undefined;
  /** Now (ms), for the time zone abbreviation. */
  now: number;
  /** Open time picker. */
  time: QuietKey | null;
  /** Typed text in a time field. */
  edit: { key: QuietKey; text: string } | null;
  isMobile: boolean;
}

export interface NotifContext {
  set: (patch: Partial<Settings>) => void;
  scrollTo: (section: NotifSection) => void;
  /** Subscribe push silently with permission and turn on the channel (`push.request()`). */
  pushOn: () => void;
  /** Open the push dialog. */
  pushDialog: () => void;
  /** Turn on push for a mail account (`mailPush.enable`). */
  mailPushOn: (id: string) => Promise<MailPushStatus>;
  /** Turn off push for a mail account (`mailPush.disable`). */
  mailPushOff: (id: string) => Promise<void>;
  /** Push channel off: unsubscribe this device's subscriptions, the selection stays (`mailPush.pause`). */
  mailPushPause: () => void;
  /** Open Mail account › Connection. */
  goConnection: (id: string) => void;
  /** Error toast. */
  toastError: (text: string) => void;
  /** Open or close the time picker (`null`; also discards the typed text). */
  showTime: (key: QuietKey | null) => void;
  /** Remember or discard (`null`) the typed text of a time field. */
  editTime: (key: QuietKey, text: string | null) => void;
}

/** Description of the push channel: support, otherwise the browser permission. */
export function pushText(push: Pick<PushInfo, 'support' | 'permission' | 'appName'>): string {
  // iPhone/iPad in the browser: push exists as an app on the home screen.
  if (push.support === 'ios') return m.push_ios_text({ app: push.appName });
  if (push.support !== 'yes') return m.notif_perm_unsupported();
  if (push.permission === 'granted') return m.notif_perm_granted();
  return push.permission === 'denied' ? m.notif_perm_denied() : m.notif_perm_default();
}

export function notifValues(input: NotifInput, ctx: NotifContext): NotifValues {
  const { values: x, push, isMobile } = input;
  const chOn = (id: ChannelId) => x.nCh[id];
  const h12 = x.timeFmt === '12h';
  // Locale-specific clock suffix only in the 24-hour format.
  const clk = (v: string) => (h12 ? clockLabel(v, true) : m.notif_clock({ time: clockLabel(v, false) }));

  const pushEnable = () => {
    // This browser is already subscribed: only turn on the channel.
    if (push.subscribed) ctx.set({ nCh: { ...x.nCh, push: true } });
    else if (push.support === 'yes' && push.permission === 'granted') ctx.pushOn();
    else ctx.pushDialog();
  };

  const channelRow = (ch: NotifChannel, i: number): ChannelRow => {
    const on = chOn(ch.id);
    let desc: string;
    if (ch.id === 'push') desc = pushText(push);
    else if (ch.id === 'mail')
      desc = on ? m.notif_ch_mail_desc({ email: input.email }) : m.notif_ch_mail_desc_off({ email: input.email });
    else desc = m.notif_ch_app_desc();
    return {
      id: ch.id,
      label: ch.label(),
      icon: ch.icon,
      sep: i > 0,
      desc,
      askHere: ch.id === 'push' && on && push.status === 'ask',
      tg: {
        on,
        onClick: () => {
          if (ch.id === 'push' && !on) {
            pushEnable();
            return;
          }
          ctx.set({ nCh: { ...x.nCh, [ch.id]: !on } });
          if (ch.id === 'push') ctx.mailPushPause();
        },
      },
    };
  };

  const topicRow = (t: NotifTopic, i: number): TopicRow => {
    const mx = x.nMx[t.id] ?? NO_CHANNELS;
    return {
      id: t.id,
      label: t.label(),
      desc: t.desc(),
      icon: t.icon,
      sep: i > 0,
      chips: NOTIF_CH.map((ch) => {
        // Locked channels (security: app and email) stay active even if the channel above is off.
        const lock = t.lock?.includes(ch.id) ?? false;
        const live = chOn(ch.id);
        return {
          id: ch.id,
          label: ch.short(),
          icon: ch.icon,
          aria: m.notif_chip_aria({ topic: t.label(), channel: ch.label() }),
          on: lock || (live && mx[ch.id]),
          lock,
          live,
          tip: lock ? m.notif_chip_locked() : live ? undefined : m.notif_chip_off({ channel: ch.label() }),
          onClick: () => {
            if (!lock && live) ctx.set({ nMx: { ...x.nMx, [t.id]: { ...mx, [ch.id]: !mx[ch.id] } } });
          },
        };
      }),
    };
  };

  const ready = push.status === 'active';

  const mailPushRow = (a: MailPushAccount, i: number): MailPushRow => {
    const bl = a.blocked;
    const auth = !bl && a.auth;
    const busy = a.status === 'pending' || a.status === 'stopping';
    const unsupported = a.status === 'unsupported';
    const expired = a.status === 'expired';
    // When turning off, the switch stays on until the response arrives.
    const on = ready && (a.status === 'on' || a.status === 'stopping') && !bl && !auth;
    const dis = !ready || bl || auth || unsupported || busy;
    let desc: string;
    if (busy) desc = a.status === 'pending' ? m.mailpush_busy_on() : m.mailpush_busy_off();
    else if (bl) desc = m.mail_account_check_blocked({ host: a.host });
    else if (auth) desc = m.mailpush_auth_text({ email: a.email });
    else if (unsupported) desc = m.mailpush_no_push({ host: a.host });
    else if (expired) desc = m.mailpush_expired();
    else desc = on ? m.mailpush_on() : m.mailpush_off();
    // The toast reports the failure; the row's switch springs back.
    const fail = () => ctx.toastError(on ? m.mailpush_fail_off() : m.mailpush_fail_on());
    return {
      id: a.id,
      email: a.email,
      sep: i > 0,
      desc,
      tone: bl || auth ? 'danger' : expired ? 'warn' : null,
      dim: !ready,
      dis,
      busy,
      hasRe: auth,
      hasCon: bl,
      goCon: () => ctx.goConnection(a.id),
      tg: {
        on,
        onClick: () => {
          if (dis) return;
          if (input.offline) ctx.toastError(m.error_offline());
          else if (on) ctx.mailPushOff(a.id).catch(fail);
          else
            ctx.mailPushOn(a.id).then((status) => {
              // The row itself shows that the server has no push support.
              if (status === 'failed') fail();
            }, fail);
        },
      },
    };
  };

  const mailAccounts = input.mailAccounts ?? [];
  const same = x.nFrom === x.nTo;
  const quietSame = x.nQuiet && same;
  // Digest at 07:00, within active quiet hours at their end.
  const late = x.nQuiet && !same && inQuiet(minutesOf(DIGEST_AT), x.nFrom, x.nTo);
  const time = clk(late ? x.nTo : DIGEST_AT);
  let digestSum: string;
  if (!chOn('mail')) digestSum = m.notif_digest_off();
  // Immediately with active quiet hours: held-back emails individually at the end.
  else if (x.nDigest === 'instant')
    digestSum = x.nQuiet && !same ? m.notif_digest_sum_now_quiet() : m.notif_digest_sum_now();
  else if (x.nDigest === 'daily')
    digestSum = late ? m.notif_digest_sum_day_late({ time }) : m.notif_digest_sum_morning({ time });
  else digestSum = late ? m.notif_digest_sum_monday_late({ time }) : m.notif_digest_sum_monday({ time });

  const quietTime = (key: QuietKey, title: string, value: string, set: (v: string) => void) =>
    timePickValues(
      {
        title,
        value,
        disabled: !x.nQuiet,
        h12,
        open: input.time === key,
        edit: input.edit?.key === key ? input.edit.text : null,
        isMobile,
      },
      {
        set,
        show: (open) => ctx.showTime(open ? key : null),
        edit: (text) => ctx.editTime(key, text),
      },
    );

  const otherZone = !!input.device && input.zone !== input.device;

  return {
    notifTabs: TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    nChRows: NOTIF_CH.map(channelRow),
    pushRequest: () => ctx.pushDialog(),
    nTopicRows: NOTIF_TOPICS.filter((t) => input.isAdmin || !t.admin).map(topicRow),
    mpSub: m.mailpush_sub(),
    mpNone: input.mailAccounts?.length === 0,
    mpNoneText: m.mailpush_none(),
    mpHasRows: mailAccounts.length > 0,
    mpRows: mailAccounts.map(mailPushRow),
    mpNeed: mailAccounts.length > 0 && !ready,
    mpNeedText: m.mailpush_need(),
    mpNeedBtn: m.mailpush_need_btn(),
    mpNeedRun: pushEnable,
    mpNoteOn: ready && x.nQuiet && !same,
    mpNote: m.mailpush_quiet(),
    tgQuiet: { on: x.nQuiet, onClick: () => ctx.set({ nQuiet: !x.nQuiet }) },
    nFromSel: quietTime('from', m.notif_quiet_from_title(), x.nFrom, (nFrom) => ctx.set({ nFrom })),
    nToSel: quietTime('to', m.notif_quiet_to_title(), x.nTo, (nTo) => ctx.set({ nTo })),
    nH24: !h12,
    quietSum: !x.nQuiet
      ? m.notif_quiet_off()
      : same
        ? m.notif_quiet_same()
        : m.notif_quiet_on({ from: clockLabel(x.nFrom, h12), to: clk(x.nTo) }),
    quietSame,
    quietNote: quietSame ? m.notif_quiet_note_same() : m.notif_quiet_note(),
    quietNoteIcon: quietSame ? 'ti-alert-circle' : 'ti-info-circle',
    quietDim: !x.nQuiet,
    digestOpts: segOptions(
      DIGEST_OPTS,
      x.nDigest,
      (v) => DIGEST_LABELS[v](),
      (nDigest) => ctx.set({ nDigest }),
    ),
    digestSum,
    digestDim: !chOn('mail'),
    delivSub: otherZone ? m.notif_deliv_desc_tz({ name: zoneName(input.zone, input.now) }) : m.notif_deliv_desc(),
    tgSound: {
      on: x.nSound,
      onClick: () => {
        if (chOn('app')) ctx.set({ nSound: !x.nSound });
      },
    },
    soundDis: !chOn('app'),
    soundTip: chOn('app') || isMobile ? undefined : m.notif_sound_tip(),
  };
}
