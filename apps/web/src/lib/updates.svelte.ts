/**
 * Administration › Updates against `admin/updates`: status, source with the
 * optional access token, schedule and display.
 *
 * Status in this order: check running, new version, failed, no release, up to
 * date. A found version also applies after a failed check; the reason then
 * sits below the card. A failed check shows no toast, the card
 * names the reason.
 *
 * The repository is public, so checks work without a token; a token only
 * raises GitHub's API rate limit. The page knows the token only as input. If
 * it is added, replaced or removed during "Check now", the backend discards
 * the result of the check; the page then discards the response too, without a
 * toast.
 *
 * Schedule and display have no save button: changes apply immediately and go
 * out as one `PUT` after a short pause, only one at a time, so that a later
 * response does not overwrite newer input; a failed one falls back to the
 * stored state with an error toast.
 *
 * Every response carries the notice from `public/config` › `update` and
 * updates it in the session so that About follows immediately.
 */
import { api, ApiError, fieldsOf, isApiError, retryAfter } from '#lib/api.ts';
import { ago } from '#lib/ago.ts';
import type { SegOption } from '#lib/appearance.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { clock, dayNumber, dtf, type TimeContext } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { segOptions } from '#lib/select.ts';
import { session, type PublicUpdate } from '#lib/state/session.svelte.ts';
import { Loading, ui } from '#lib/state/ui.svelte.ts';
import { timePickValues, type TimePickValues } from '#lib/time-picker.ts';
import { waitText } from '#lib/wait.ts';

/** Repository and image; the backend checks the same repository (`updates::github`). */
export const UP_REPO = 'github.com/roedylabs/mail';
export const UP_IMAGE = 'ghcr.io/roedylabs/mail';

/** Pause until a schedule change goes out (typing the time, several toggles). */
export const UP_SAVE_DELAY = 400;

const UPDATES = 'admin/updates';

export type UpEvery = 'hourly' | 'daily' | 'weekly';
export type UpDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type UpReason = 'token' | 'no_access' | 'rate_limited' | 'unreachable';
export type UpSection = 'status' | 'source' | 'schedule' | 'display';

/** Response of all calls to `admin/updates`. */
export interface UpdatesView {
  version: string;
  latest: string | null;
  available: boolean;
  status: 'ok' | 'err';
  reason: UpReason | null;
  checked_at: string | null;
  next_at: string | null;
  auto: boolean;
  every: UpEvery;
  time: string;
  weekday: UpDay;
  show: boolean;
  pat: { prefix: string; tail: string; saved_at: string } | null;
  update: PublicUpdate | null;
}

/** Fields of schedule and display; a change sends only these. */
export type UpSchedule = Pick<UpdatesView, 'auto' | 'every' | 'time' | 'weekday' | 'show'>;

const NO_UPDATES: UpdatesView = {
  version: '',
  latest: null,
  available: false,
  status: 'ok',
  reason: null,
  checked_at: null,
  next_at: null,
  auto: true,
  every: 'daily',
  time: '03:00',
  weekday: 'monday',
  show: true,
  pat: null,
  update: null,
};

/** Status on a failed check. */
const UP_ERR: Record<UpReason, { icon: IconName; text: () => string }> = {
  token: { icon: 'ti-key-off', text: () => m.updates_err_token() },
  no_access: { icon: 'ti-lock', text: () => m.updates_err_no_access({ repo: UP_REPO }) },
  rate_limited: { icon: 'ti-hourglass', text: () => m.updates_err_rate_limited() },
  unreachable: { icon: 'ti-cloud-off', text: () => m.updates_err_unreachable() },
};

const UP_TABS: readonly [UpSection, () => string][] = [
  ['status', () => m.updates_tab_status()],
  ['source', () => m.updates_tab_source()],
  ['schedule', () => m.updates_tab_schedule()],
  ['display', () => m.updates_tab_display()],
];

const UP_EVERY: Record<UpEvery, () => string> = {
  hourly: () => m.updates_every_hourly(),
  daily: () => m.updates_every_daily(),
  weekly: () => m.updates_every_weekly(),
};
const UP_EVERY_OPTS: readonly UpEvery[] = ['hourly', 'daily', 'weekly'];

const UP_DAYS: Record<UpDay, () => string> = {
  monday: () => m.updates_day_mo(),
  tuesday: () => m.updates_day_di(),
  wednesday: () => m.updates_day_mi(),
  thursday: () => m.updates_day_do(),
  friday: () => m.updates_day_fr(),
  saturday: () => m.updates_day_sa(),
  sunday: () => m.updates_day_so(),
};
const UP_DAY_OPTS: readonly UpDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export type UpTime = Pick<TimeContext, 'now' | 'tz' | 'timeFmt'>;

/** Next check: "today, 03:00", "tomorrow, 03:00", "Mon 9 Nov, 03:00". */
export function whenText(t: number, time: UpTime): string {
  if (t <= time.now) return m.updates_next_soon();
  const days = dayNumber(t, time.tz) - dayNumber(time.now, time.tz);
  const day =
    days === 0
      ? m.updates_next_today()
      : days === 1
        ? m.updates_next_tomorrow()
        : dtf(time.tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(t);
  return m.updates_next_at({ day, time: clock(t, time) });
}

/** Without a session or role: reload the account, the layout then shows the sign-in or "Access denied". */
function checkAccess(error: unknown): void {
  if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
}

/** Error text of loading and checking (shown on the card, toast after "Check now"). */
function errorText(error: unknown): string {
  return isApiError(error, 429) ? m.error_limit({ wait: waitText(retryAfter(error)) }) : failText(error);
}

/**
 * Field error when saving the token: `invalid` with
 * a red border, `unavailable` and 429 without, because they say nothing about
 * the token. `null`: not a case for the field but an error toast.
 */
function patFail(error: unknown): { text: string; bad: boolean } | null {
  if (isApiError(error, 429)) return { text: errorText(error), bad: false };
  if (!(error instanceof ApiError)) return null;
  const code = fieldsOf(error).pat?.code;
  if (code === 'invalid') return { text: m.updates_pat_invalid({ repo: UP_REPO }), bad: true };
  if (code === 'unavailable') return { text: m.updates_pat_unavailable(), bad: false };
  return null;
}

export class UpdatesPage {
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  /** Reason the first load failed. */
  failure = $state('');
  /** Skeleton only after 150 ms. */
  loading = new Loading();
  /** Stored state; `null` before the first response. */
  view = $state.raw<UpdatesView | null>(null);
  /** Changes not yet confirmed on top of the stored state. */
  edits = $state.raw<Partial<UpSchedule>>({});
  schedule = $derived.by((): UpSchedule => {
    const { auto, every, time, weekday, show } = this.view ?? NO_UPDATES;
    return { auto, every, time, weekday, show, ...this.edits };
  });

  /** Check running and rotation of the icon in degrees. */
  busy = $state(false);
  rot = $state(0);

  /** Replace token, input, show. */
  editing = $state(false);
  input = $state('');
  showToken = $state(false);
  /** Saving running. */
  saving = $state(false);
  /** Message at the field; `tokenBad`: with a red border. */
  tokenErr = $state<string | null>(null);
  tokenBad = $state(false);

  /** Time picker. */
  timeOpen = $state(false);
  timeEdit = $state<string | null>(null);

  #seq = 0;
  #disposed = false;
  /** Counts replaced and removed tokens: an older check has then expired. */
  #tokenGen = 0;
  #pending: Partial<UpSchedule> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending = false;

  /** If the first load fails, the page shows the card; a later one keeps the data with an error toast. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    try {
      const view = await this.loading.run(api<UpdatesView>('GET', UPDATES));
      if (seq !== this.#seq || this.#disposed) return;
      this.#adopt(view);
      this.status = 'ready';
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      checkAccess(error);
      if (this.view) {
        ui.toasts.error(errorText(error));
        return;
      }
      this.failure = errorText(error);
      this.status = 'failed';
    }
  }

  /** "Try again" of the card. */
  retry(): Promise<void> {
    this.status = 'loading';
    return this.load();
  }

  /** Leaving the page: a waiting change still goes out. */
  dispose(): void {
    this.#disposed = true;
    void this.#flush();
  }

  #adopt(view: UpdatesView): void {
    this.view = view;
    session.setUpdate(view.update);
  }

  /** Change to schedule or display: applies immediately, goes out after `UP_SAVE_DELAY`. */
  set(patch: Partial<UpSchedule>): void {
    this.edits = { ...this.edits, ...patch };
    this.#pending = { ...this.#pending, ...patch };
    this.#later();
  }

  #later(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#flush(), this.#disposed ? 0 : UP_SAVE_DELAY);
  }

  async #flush(): Promise<void> {
    clearTimeout(this.#timer);
    if (this.#sending || Object.keys(this.#pending).length === 0) return;
    const body = this.#pending;
    this.#pending = {};
    this.#sending = true;
    try {
      this.#adopt(await api<UpdatesView>('PUT', UPDATES, body));
    } catch (error) {
      checkAccess(error);
      ui.toasts.error(failText(error));
    } finally {
      this.#sending = false;
      // Only what is still pending stays on top of the stored state.
      this.edits = this.#pending;
    }
    if (Object.keys(this.#pending).length > 0) this.#later();
  }

  /** "Check now", with or without a token. */
  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.rot += 720;
    const gen = this.#tokenGen;
    try {
      const view = await api<UpdatesView>('POST', `${UPDATES}/check`);
      if (gen !== this.#tokenGen) return;
      this.#adopt(view);
      if (view.reason !== null) return;
      ui.toasts.show(
        view.available && view.latest ? m.updates_toast_avail({ version: view.latest }) : m.updates_toast_none(),
      );
    } catch (error) {
      if (gen !== this.#tokenGen) return;
      checkAccess(error);
      ui.toasts.error(errorText(error));
    } finally {
      if (gen === this.#tokenGen) this.busy = false;
    }
  }

  /** New token in place: a running check has expired, the input is done. */
  #tokenDone(view: UpdatesView): void {
    this.#tokenGen++;
    this.busy = false;
    this.#adopt(view);
    this.editing = false;
    this.input = '';
    this.showToken = false;
    this.#clearTokenErr();
  }

  #clearTokenErr(): void {
    this.tokenErr = null;
    this.tokenBad = false;
  }

  /** "Verify and save". */
  async saveToken(): Promise<void> {
    const pat = this.input.trim();
    if (!pat || this.saving) return;
    this.saving = true;
    this.#clearTokenErr();
    try {
      this.#tokenDone(await api<UpdatesView>('PUT', UPDATES, { pat }));
      ui.toasts.show(m.updates_pat_saved());
    } catch (error) {
      checkAccess(error);
      const fail = patFail(error);
      if (fail) {
        this.tokenErr = fail.text;
        this.tokenBad = fail.bad;
      } else ui.toasts.error(failText(error));
    } finally {
      this.saving = false;
    }
  }

  /** "Replace" and "Cancel". */
  editToken(on: boolean): void {
    this.editing = on;
    this.input = '';
    this.showToken = false;
    this.#clearTokenErr();
  }

  setInput(value: string): void {
    this.input = value;
    this.#clearTokenErr();
  }

  /** "Remove": without undo, the browser never has the token. */
  removeToken(): void {
    ui.ask({
      title: m.updates_pat_remove_title(),
      text: m.updates_pat_remove_text({ app: session.appName }),
      icon: 'ti-key-off',
      ok: m.updates_pat_remove_ok(),
      danger: true,
      run: () => void this.#removeToken(),
    });
  }

  async #removeToken(): Promise<void> {
    try {
      this.#tokenDone(await api<UpdatesView>('POST', `${UPDATES}/remove-pat`));
      ui.toasts.show(m.updates_pat_removed());
    } catch (error) {
      checkAccess(error);
      ui.toasts.error(failText(error));
    }
  }
}

/** Section "Source": row with link and copy. */
export interface UpSrcRow {
  k: string;
  v: string;
  href: string;
  icon: IconName;
  isLink: boolean;
  noLink: boolean;
  sep: boolean;
  copy: () => Promise<void>;
}

/** Optional access token. */
export interface UpPatValues {
  set: boolean;
  edit: boolean;
  canCancel: boolean;
  masked: string;
  since: string;
  value: string;
  type: 'text' | 'password';
  onChange: (value: string) => void;
  onKey: (event: { key: string }) => void;
  eyeIcon: IconName;
  eyeTip: string;
  onEye: () => void;
  err: string;
  hasErr: boolean;
  /** Red border. */
  invalid: boolean;
  save: () => void;
  saveLbl: string;
  saveIcon: IconName;
  /** Button in the accent colour, also running while saving. */
  saveOn: boolean;
  saveBusy: boolean;
  saveDis: boolean;
  replace: () => void;
  cancel: () => void;
  remove: () => void;
}

/** Values of the page. */
export interface UpdatesValues {
  skSet: boolean;
  upLoad: { ok: boolean; fail: boolean; text: string; onRetry: () => void };
  upTabs: { label: string; onClick: () => void }[];
  upTitle: string;
  upSub: string;
  upIcon: IconName;
  /** Failed: card and tile in the error colours. */
  upBad: boolean;
  upHasWarn: boolean;
  upWarn: string;
  upRows: { k: string; v: string; sep: boolean }[];
  upBusy: boolean;
  upBtn: string;
  upRot: number;
  upCheck: () => void;
  pat: UpPatValues;
  upSrcRows: UpSrcRow[];
  tgUpAuto: { on: boolean; onClick: () => void };
  upEveryOpts: SegOption<UpEvery>[];
  /** Automatic off: selection dimmed and disabled. */
  upEvOff: boolean;
  upHasTime: boolean;
  upHasDay: boolean;
  upDayOpts: SegOption<UpDay>[];
  upTimeSel: TimePickValues;
  upNext: string;
  tgUpShow: { on: boolean; onClick: () => void };
}

export interface UpdatesInput extends UpTime {
  /** Commit of the build for "Installed version". */
  build: string;
  isMobile: boolean;
}

export interface UpdatesContext {
  scrollTo: (section: UpSection) => void;
  copy: (text: string) => Promise<boolean>;
  notify: (text: string) => void;
}

export function updatesValues(p: UpdatesPage, input: UpdatesInput, ctx: UpdatesContext): UpdatesValues {
  const u = p.view ?? NO_UPDATES;
  const s = p.schedule;
  const hasPat = !!u.pat;
  const fail = u.reason ? UP_ERR[u.reason] : null;
  const idle = !p.busy;
  const found = idle && u.available && !!u.latest;
  const bad = idle && !found && !!fail;
  const noRelease = idle && !found && !fail && !u.latest;
  const latest = u.latest ?? '';
  const filled = !!p.input.trim();
  const copyRow = (text: string, done: () => string) => async () => {
    if (await ctx.copy(text)) ctx.notify(done());
  };
  const image = `${UP_IMAGE}:${u.version}`;

  let upTitle: string;
  let upSub: string;
  let upIcon: IconName;
  if (p.busy) {
    upTitle = m.updates_st_busy();
    upSub = m.updates_st_busy_sub();
    upIcon = 'ti-search';
  } else if (found) {
    upTitle = m.updates_st_avail();
    upSub = m.updates_st_avail_sub({ version: latest });
    upIcon = 'ti-cloud-download';
  } else if (bad) {
    upTitle = m.updates_st_failed();
    upSub = fail.text();
    upIcon = fail.icon;
  } else if (noRelease) {
    upTitle = m.updates_st_no_release();
    upSub = m.updates_st_no_release_sub();
    upIcon = 'ti-package-off';
  } else {
    upTitle = m.updates_st_ok();
    upSub = m.updates_st_ok_sub({ version: u.version });
    upIcon = 'ti-circle-check';
  }

  return {
    skSet: p.status === 'loading' && p.loading.slow,
    upLoad: {
      ok: p.status === 'ready',
      fail: p.status === 'failed',
      text: p.failure,
      onRetry: () => void p.retry(),
    },
    upTabs: UP_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    upTitle,
    upSub,
    upIcon,
    upBad: bad,
    upHasWarn: found && !!fail,
    upWarn: found && fail ? m.updates_warn({ reason: fail.text() }) : '',
    upRows: [
      [m.updates_row_installed(), m.updates_row_installed_value({ version: u.version, build: input.build })],
      [m.updates_row_latest(), u.latest ?? m.updates_latest_none()],
      [m.updates_row_checked(), u.checked_at ? ago(Date.parse(u.checked_at), input.now) : m.updates_checked_never()],
    ].map(([k = '', v = ''], i) => ({ k, v, sep: i > 0 })),
    upBusy: p.busy,
    upBtn: p.busy ? m.updates_check_busy() : m.updates_check(),
    upRot: p.rot,
    upCheck: () => void p.check(),
    pat: {
      set: hasPat && !p.editing,
      edit: !hasPat || p.editing,
      canCancel: hasPat && p.editing,
      masked: u.pat ? `${u.pat.prefix}${'•'.repeat(12)}${u.pat.tail}` : '',
      since: u.pat ? m.updates_pat_since({ ago: ago(Date.parse(u.pat.saved_at), input.now) }) : '',
      value: p.input,
      type: p.showToken ? 'text' : 'password',
      onChange: (value) => p.setInput(value),
      onKey: (event) => {
        if (event.key === 'Enter') void p.saveToken();
      },
      eyeIcon: p.showToken ? 'ti-eye-off' : 'ti-eye',
      eyeTip: p.showToken ? m.updates_pat_hide() : m.updates_pat_show(),
      onEye: () => {
        p.showToken = !p.showToken;
      },
      err: p.tokenErr ?? '',
      hasErr: p.tokenErr !== null,
      invalid: p.tokenBad,
      save: () => void p.saveToken(),
      saveLbl: p.saving ? m.updates_pat_saving() : m.updates_pat_save(),
      saveIcon: p.saving ? 'ti-loader-2' : 'ti-check',
      saveOn: filled || p.saving,
      saveBusy: p.saving,
      saveDis: !filled || p.saving,
      replace: () => p.editToken(true),
      cancel: () => p.editToken(false),
      remove: () => p.removeToken(),
    },
    upSrcRows: [
      {
        k: m.updates_src_repo(),
        v: UP_REPO,
        href: `https://${UP_REPO}`,
        icon: 'ti-brand-github',
        isLink: true,
        noLink: false,
        sep: false,
        copy: copyRow(`https://${UP_REPO}`, () => m.updates_repo_copied()),
      },
      {
        k: m.updates_src_image(),
        v: image,
        href: `https://${UP_REPO}/pkgs/container/${UP_IMAGE.split('/').pop()}`,
        icon: 'ti-brand-docker',
        isLink: true,
        noLink: false,
        sep: true,
        copy: copyRow(image, () => m.updates_image_copied()),
      },
    ],
    tgUpAuto: { on: s.auto, onClick: () => p.set({ auto: !s.auto }) },
    upEveryOpts: segOptions(
      UP_EVERY_OPTS,
      s.every,
      (every) => UP_EVERY[every](),
      (every) => p.set({ every }),
    ),
    upEvOff: !s.auto,
    upHasTime: s.every !== 'hourly',
    upHasDay: s.every === 'weekly',
    upDayOpts: segOptions(
      UP_DAY_OPTS,
      s.weekday,
      (day) => UP_DAYS[day](),
      (weekday) => p.set({ weekday }),
    ),
    upTimeSel: timePickValues(
      {
        title: m.updates_time_title(),
        value: s.time,
        disabled: !s.auto,
        h12: input.timeFmt === '12h',
        open: p.timeOpen,
        edit: p.timeEdit,
        isMobile: input.isMobile,
      },
      {
        set: (time) => p.set({ time }),
        show: (open) => {
          p.timeOpen = open;
          if (!open) p.timeEdit = null;
        },
        edit: (text) => {
          p.timeEdit = text;
        },
      },
    ),
    upNext: s.auto && u.next_at ? whenText(Date.parse(u.next_at), input) : m.updates_next_off(),
    tgUpShow: { on: s.show, onClick: () => p.set({ show: !s.show }) },
  };
}
