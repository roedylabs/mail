/**
 * Administration › Maintenance against `admin/maintenance`, `admin/storage`
 * and `admin/backups`: maintenance mode with notice, backups with schedule
 * and retention, storage with compaction.
 *
 * Notice and schedule have no save button: changes apply immediately and go
 * out as one `PUT` after a short pause, only one at a time (`Saver`). After a
 * failed save the notice stays in the field, while the schedule falls back to
 * the saved state. The field follows no response, otherwise a cleared field
 * would jump to the default text.
 *
 * Deleting sends `DELETE` only after the toast expires, immediately when
 * leaving the page. Until then the row is only hidden (`#hidden`), so
 * that a response in between does not bring it back. Count and size under
 * "Storage" come from the same list and therefore follow immediately.
 *
 * Errors: "Back up now" reports "The backup failed. …", without a connection
 * the offline text; `backup_running` shows the running button there without
 * a toast and checks again after `BK_RUNNING_WAIT`. Restore and delete report
 * a text per reason (`backup_running`, `backup_invalid`, `backup_newer`,
 * `backup_other_key`), otherwise the generic one. After a restore everything
 * is different: configuration, account, settings and mail accounts reload,
 * and without a session the layout shows the sign-in.
 */
import { SvelteSet } from 'svelte/reactivity';
import { api, API_BASE, ApiError, isApiError, retryAfter } from '#lib/api.ts';
import { ago } from '#lib/ago.ts';
import type { SegOption } from '#lib/appearance.ts';
import { formatDate } from '#lib/date.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { clock, type TimeContext } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { mailPush } from '#lib/mail-push.svelte.ts';
import { push } from '#lib/push.svelte.ts';
import { segOptions } from '#lib/select.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { Loading, ui } from '#lib/state/ui.svelte.ts';
import { whenText } from '#lib/updates.svelte.ts';
import { waitText } from '#lib/wait.ts';
import { intlLocale } from '#lib/locale.ts';

/** Pause until a change to notice or schedule goes out (typing, several switches). */
export const MT_SAVE_DELAY = 400;
/** The button shows "Running …" for this long when a backup is already running (`backup_running`). */
export const BK_RUNNING_WAIT = 5000;

const MODE = 'admin/maintenance';
const BACKUPS = 'admin/backups';
const STORAGE = 'admin/storage';

export type MtSection = 'mode' | 'backups' | 'storage';
export type BkEvery = 'daily' | 'weekly';
export type BkKeep = 7 | 30 | 90;

/** Response of `admin/maintenance`; without `message`, the default text applies. */
export interface MaintenanceMode {
  on: boolean;
  message: string | null;
}

/** Row of the list; `size` in bytes. */
export interface Backup {
  id: string;
  at: string;
  size: number;
  auto: boolean;
}

/** Response of `admin/backups`, of `schedule` and `restore`. */
export interface BackupsView {
  backups: Backup[];
  auto: boolean;
  every: BkEvery;
  keep: BkKeep;
  next_at: string | null;
}

/** Fields of the schedule; a change sends only these. */
export type BkSchedule = Pick<BackupsView, 'auto' | 'every' | 'keep'>;

/**
 * Response of `admin/storage`, sizes in bytes. The page does not use
 * `backups` and `backup_count`, it has the list.
 */
export interface StorageView {
  database: number;
  assets: number;
  asset_name: string | null;
  compacted_at: string | null;
}

const NO_BACKUPS: BackupsView = { backups: [], auto: true, every: 'daily', keep: 30, next_at: null };

const MT_TABS: readonly [MtSection, () => string][] = [
  ['mode', () => m.maintenance_tab_mode()],
  ['backups', () => m.maintenance_tab_backups()],
  ['storage', () => m.maintenance_tab_storage()],
];

const BK_EVERY: Record<BkEvery, () => string> = {
  daily: () => m.updates_every_daily(),
  weekly: () => m.updates_every_weekly(),
};
const BK_EVERY_OPTS: readonly BkEvery[] = ['daily', 'weekly'];
const BK_KEEP: Record<BkKeep, () => string> = {
  7: () => m.maintenance_bk_keep_7(),
  30: () => m.maintenance_bk_keep_30(),
  90: () => m.maintenance_bk_keep_90(),
};
const BK_KEEP_OPTS: readonly BkKeep[] = [7, 30, 90];

const MB = 1024 * 1024;

/** Size as "148 MB", "1.2 GB", "48 KB" or "0 MB" (decimal separator per locale). */
export function storageSize(bytes: number): string {
  const mb = bytes / MB;
  if (mb >= 1024) return `${(mb / 1024).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} GB`;
  if (mb >= 1) return `${Math.round(mb).toLocaleString(intlLocale())} MB`;
  return mb > 0 ? `${Math.max(1, Math.round(mb * 1024))} KB` : '0 MB';
}

/** Without a session or role: reload the account, the layout then shows the sign-in or "Access denied". */
function checkAccess(error: unknown): void {
  if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
}

function errorText(error: unknown, text?: string): string {
  return isApiError(error, 429) ? m.error_limit({ wait: waitText(retryAfter(error)) }) : failText(error, text);
}

/** Reasons of restore and delete with a text of their own. */
const BK_ERRORS: readonly [number, string, () => string][] = [
  [409, 'backup_running', m.maintenance_bk_running],
  [422, 'backup_invalid', m.maintenance_bk_invalid],
  [409, 'backup_newer', m.maintenance_bk_newer],
  [409, 'backup_other_key', m.maintenance_bk_other_key],
];

/** Text of the error toast for restore and delete. */
export function backupErrorText(error: unknown): string {
  for (const [status, code, text] of BK_ERRORS) if (isApiError(error, status, code)) return text();
  return errorText(error);
}

/**
 * Changes without a save button: collects them, sends after a pause and
 * only one request at a time. `send` catches its errors itself.
 */
class Saver<T extends object> {
  readonly #send: (body: Partial<T>) => Promise<void>;
  #pending: Partial<T> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | null = null;

  constructor(send: (body: Partial<T>) => Promise<void>) {
    this.#send = send;
  }

  /** Fields not sent yet. */
  get pending(): Partial<T> {
    return this.#pending;
  }

  set(patch: Partial<T>): void {
    this.#pending = { ...this.#pending, ...patch };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), MT_SAVE_DELAY);
  }

  /** Puts failed fields back: they go out with the next request, newer inputs take precedence. */
  retain(fields: Partial<T>): void {
    this.#pending = { ...fields, ...this.#pending };
  }

  /** Sends what is pending and also waits for a running request. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    while (this.#sending) await this.#sending;
    if (Object.keys(this.#pending).length === 0) return;
    const body = this.#pending;
    this.#pending = {};
    this.#sending = this.#send(body).finally(() => (this.#sending = null));
    await this.#sending;
  }
}

export class MaintenancePage {
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  /** Reason the first load failed. */
  failure = $state('');
  /** Skeleton only after 150 ms. */
  loading = new Loading();

  /** Switch: applies immediately, a failed save reverts it. */
  on = $state(false);
  /** Content of the field. */
  message = $state('');

  /** Rows whose `DELETE` waits for the toast to expire. */
  #hidden = new SvelteSet<string>();
  /** Saved state; `null` before the first response. */
  view = $state.raw<BackupsView | null>(null);
  /** Unconfirmed changes on top of the saved schedule. */
  edits = $state.raw<Partial<BkSchedule>>({});
  schedule = $derived.by((): BkSchedule => {
    const { auto, every, keep } = this.view ?? NO_BACKUPS;
    return { auto, every, keep, ...this.edits };
  });
  /** List without the rows whose deletion is still pending. */
  backups = $derived((this.view ?? NO_BACKUPS).backups.filter((b) => !this.#hidden.has(b.id)));

  storage = $state.raw<StorageView | null>(null);

  /** Backup or restore running, rotation in degrees. */
  bkBusy = $state(false);
  /** What occupies the button: a backup (also a foreign one, `backup_running`) or a restore. */
  #busyKind: 'backup' | 'restore' | null = null;
  bkRot = $state(0);
  /** Compaction running, rotation in degrees. */
  stBusy = $state(false);
  stRot = $state(0);

  #seq = 0;
  /** Counts changes to `view`: a `#refreshBackups` that no longer sees it expires. */
  #viewGen = 0;
  #disposed = false;
  #switching = false;
  #waiting: ReturnType<typeof setTimeout> | undefined;

  #modeSaver = new Saver<MaintenanceMode>((body) => this.#sendMode(body));
  #scheduleSaver = new Saver<BkSchedule>((body) => this.#sendSchedule(body));

  /** If the first load fails, the page shows the card; a later one keeps the data with an error toast. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    try {
      const [mode, view, storage] = await this.loading.run(
        Promise.all([
          api<MaintenanceMode>('GET', MODE),
          api<BackupsView>('GET', BACKUPS),
          api<StorageView>('GET', STORAGE),
        ]),
      );
      if (seq !== this.#seq || this.#disposed) return;
      this.#adoptMode(mode);
      if (this.#modeSaver.pending.message === undefined) this.message = mode.message ?? m.login_maint_default();
      this.#adoptView(view);
      this.storage = storage;
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

  /** Leaving the page: whatever is waiting goes out immediately, also a deletion. */
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#waiting);
    void this.#modeSaver.flush();
    void this.#scheduleSaver.flush();
    void ui.toasts.flush();
  }

  #adoptView(view: BackupsView): void {
    this.#viewGen++;
    this.view = view;
  }

  /** Saved state: the notice bar follows immediately. */
  #adoptMode(mode: MaintenanceMode): void {
    if (this.#modeSaver.pending.on === undefined) this.on = mode.on;
    session.setMaintenance(mode);
  }

  async #sendMode(body: Partial<MaintenanceMode>): Promise<void> {
    const on = body.on;
    try {
      this.#adoptMode(await api<MaintenanceMode>('PUT', MODE, body));
      if (on === true) ui.toasts.show(m.maintenance_on_done());
      else if (on === false) ui.toasts.show(m.maintenance_off_done());
    } catch (error) {
      checkAccess(error);
      if (on !== undefined) this.on = !on;
      // The field keeps showing the text; just do not resend an invalid one, it would otherwise break the switch.
      if (body.message !== undefined && !isApiError(error, 422)) this.#modeSaver.retain({ message: body.message });
      ui.toasts.error(failText(error));
    } finally {
      if (on !== undefined) this.#switching = false;
    }
  }

  #switch(on: boolean): void {
    this.#switching = true;
    this.on = on;
    this.#modeSaver.set({ on });
    void this.#modeSaver.flush();
  }

  /** Switch: turning on with confirmation, turning off immediately. */
  toggle(): void {
    if (this.#switching) return;
    if (this.on) {
      this.#switch(false);
      return;
    }
    ui.ask({
      title: m.maintenance_on_title(),
      text: m.maintenance_on_text(),
      icon: 'ti-tool',
      ok: m.maintenance_on_ok(),
      run: () => this.#switch(true),
    });
  }

  /** Field "Notice for users"; the default text is `null` on the server. */
  setMessage(value: string): void {
    this.message = value;
    this.#modeSaver.set({ message: value === m.login_maint_default() ? null : value });
  }

  /** "Default text". */
  resetMessage(): void {
    this.setMessage(m.login_maint_default());
  }

  async #sendSchedule(body: Partial<BkSchedule>): Promise<void> {
    try {
      this.#adoptView(await api<BackupsView>('PUT', `${BACKUPS}/schedule`, body));
    } catch (error) {
      checkAccess(error);
      ui.toasts.error(failText(error));
    } finally {
      // Only what is still pending stays on top of the saved state.
      this.edits = this.#scheduleSaver.pending;
    }
  }

  /** Change to the schedule: applies immediately, goes out after `MT_SAVE_DELAY`. */
  setSchedule(patch: Partial<BkSchedule>): void {
    this.edits = { ...this.edits, ...patch };
    this.#scheduleSaver.set(patch);
  }

  /** Refresh the list without an error message: `next_at` depends on the last backup. */
  async #refreshBackups(): Promise<void> {
    const gen = this.#viewGen;
    try {
      const view = await api<BackupsView>('GET', BACKUPS);
      if (gen === this.#viewGen && !this.#disposed) this.#adoptView(view);
    } catch {
      // The rows are already correct, only the next date is old.
    }
  }

  /**
   * A backup and a restore exclude each other; whatever is waiting goes out
   * first. `tell`: failed, not merely already done (restore).
   */
  async #run(
    kind: 'backup' | 'restore',
    work: () => Promise<void>,
    failed: (error: unknown) => string = backupErrorText,
  ): Promise<void> {
    const tell = kind === 'restore';
    if (this.bkBusy) {
      // Only a running backup has its own text, a running restore does not.
      if (tell) ui.toasts.error(this.#busyKind === 'backup' ? m.maintenance_bk_running() : m.error_act());
      return;
    }
    this.bkBusy = true;
    this.#busyKind = kind;
    this.bkRot += 720;
    try {
      await Promise.all([ui.toasts.flush(), this.#modeSaver.flush(), this.#scheduleSaver.flush()]);
      await work();
    } catch (error) {
      if (isApiError(error, 409, 'backup_running')) {
        if (tell) ui.toasts.error(m.maintenance_bk_running());
        this.#waitForRun();
        return;
      }
      checkAccess(error);
      ui.toasts.error(failed(error));
      // The file is gone, e.g. due to retention: the row should not stay.
      if (isApiError(error, 404)) await this.#refreshBackups();
    }
    this.bkBusy = false;
    this.#busyKind = null;
  }

  /** `backup_running`: the button keeps running, afterwards the new backup is in the list. */
  #waitForRun(): void {
    if (this.#disposed) return;
    this.bkBusy = true;
    this.#busyKind = 'backup';
    clearTimeout(this.#waiting);
    this.#waiting = setTimeout(() => {
      void this.#refreshBackups().finally(() => {
        this.bkBusy = false;
        this.#busyKind = null;
      });
    }, BK_RUNNING_WAIT);
  }

  /** "Back up now"; if it fails, "The backup failed. …". */
  create(): void {
    void this.#run(
      'backup',
      async () => {
        const row = await api<Backup>('POST', BACKUPS);
        const view = this.view ?? NO_BACKUPS;
        // A response in between may already name the file.
        this.#adoptView({ ...view, backups: [row, ...view.backups.filter((b) => b.id !== row.id)] });
        ui.toasts.show(m.maintenance_bk_created());
        void this.#refreshBackups();
      },
      // Only if the server tried (5xx); otherwise the generic text, offline and 429 as everywhere.
      (error) => (error instanceof ApiError && error.status >= 500 ? m.maintenance_bk_now_fail() : errorText(error)),
    );
  }

  /** "Restore": always with confirmation and word, even if confirmations are turned off. */
  restore(id: string, title: string): void {
    ui.ask({
      force: true,
      title: m.maintenance_bk_restore_title(),
      // With the notice about the sign-out.
      text: `${m.maintenance_bk_restore_text({ at: title })} ${m.maintenance_bk_restore_note()}`,
      icon: 'ti-history',
      ok: m.maintenance_bk_restore_ok(),
      danger: true,
      word: m.maintenance_bk_restore_word(),
      run: () =>
        void this.#run('restore', async () => {
          await api('POST', `${BACKUPS}/${id}/restore`);
          ui.toasts.show(m.maintenance_bk_restored());
          await this.#reloadAll();
        }),
    });
  }

  /** The server is at a different state: reload everything the browser holds from it. */
  async #reloadAll(): Promise<void> {
    await session.load();
    if (!session.authed) return;
    void push.resume();
    // Without the role in the backup the layout shows "Access denied", the page then loads nothing more.
    const page = session.isAdmin ? this.load() : undefined;
    await Promise.all([prefs.load().catch(() => {}), accounts.load().catch(() => {}), page]);
    void mailPush.resume();
  }

  /** Trash can: with undo, `DELETE` only after the toast expires. */
  remove(id: string): void {
    this.#hidden.add(id);
    ui.toasts.defer({
      text: m.maintenance_bk_deleted(),
      revert: () => this.#hidden.delete(id),
      commit: async (keepalive) => {
        try {
          await api('DELETE', `${BACKUPS}/${id}`, undefined, { keepalive });
        } catch (error) {
          // Already gone, e.g. due to retention: the goal is reached.
          if (!isApiError(error, 404)) throw error;
        }
        const view = this.view ?? NO_BACKUPS;
        this.#adoptView({ ...view, backups: view.backups.filter((b) => b.id !== id) });
        this.#hidden.delete(id);
        void this.#refreshBackups();
      },
      onError: (error) => {
        checkAccess(error);
        ui.toasts.error(backupErrorText(error));
        // If our own backup is running, its end frees the button.
        if (isApiError(error, 409, 'backup_running') && !this.bkBusy) this.#waitForRun();
      },
    });
  }

  /** "Compact". */
  compact(): void {
    if (this.stBusy) return;
    ui.ask({
      title: m.maintenance_st_compact_title(),
      text: m.maintenance_st_compact_text(),
      icon: 'ti-arrows-minimize',
      ok: m.maintenance_st_compact_ok(),
      run: () => void this.#compact(),
    });
  }

  async #compact(): Promise<void> {
    if (this.stBusy) return;
    this.stBusy = true;
    this.stRot += 720;
    try {
      this.storage = await api<StorageView>('POST', `${STORAGE}/compact`);
      ui.toasts.show(m.maintenance_st_compacted());
    } catch (error) {
      checkAccess(error);
      ui.toasts.error(errorText(error));
    } finally {
      this.stBusy = false;
    }
  }
}

/** Button with "Running …"; styled as active and `aria-disabled` when `busy`. */
export interface MtBusyButton {
  busy: boolean;
  icon: IconName;
  label: string;
  rot: number;
}

export interface MtSwitch {
  on: boolean;
  onClick: () => void;
}

export interface BkRow {
  id: string;
  title: string;
  sub: string;
  sep: boolean;
  icon: IconName;
  /** Download link. */
  href: string;
  onDownload: () => void;
  onRestore: () => void;
  onRemove: () => void;
}

/** Like `SegOption`, but with the number of days as value. */
export interface BkKeepOption {
  value: BkKeep;
  label: string;
  on: boolean;
  onClick: () => void;
}

export interface StRow {
  icon: IconName;
  label: string;
  sub: string;
  size: string;
  sep: boolean;
}

export interface MaintenanceValues {
  /** Skeleton while the first response is taking its time. */
  skSet: boolean;
  mtLoad: { ok: boolean; fail: boolean; text: string; onRetry: () => void };
  mtTabs: { label: string; onClick: () => void }[];

  tgMaint: MtSwitch;
  maintStatus: string;
  maintMsg: string;
  onMaintMsg: (value: string) => void;
  maintReset: () => void;
  maintCustom: boolean;

  bkSum: string;
  bkB: MtBusyButton;
  bkNow: () => void;
  bkRows: BkRow[];
  bkEmpty: boolean;
  tgBkAuto: MtSwitch;
  bkEveryOpts: SegOption<BkEvery>[];
  bkKeepOpts: BkKeepOption[];
  bkNext: string;

  stRows: StRow[];
  stB: MtBusyButton;
  stDesc: string;
  stCompact: () => void;
}

export interface MaintenanceInput extends Pick<TimeContext, 'now' | 'tz' | 'timeFmt'> {
  dateFmt: string;
}

export interface MaintenanceContext {
  scrollTo: (section: MtSection) => void;
}

/** "1 backup", "3 backups", "No backups". */
function countText(n: number): string {
  if (n === 0) return m.maintenance_st_backups_none();
  return n === 1 ? m.maintenance_st_backups_one() : m.maintenance_st_backups_many({ n });
}

export function maintenanceValues(
  p: MaintenancePage,
  input: MaintenanceInput,
  ctx: MaintenanceContext,
): MaintenanceValues {
  const s = p.schedule;
  const list = p.backups;
  const nextAt = p.view?.next_at;
  const storage = p.storage;
  const last = list.reduce((a, b) => Math.max(a, Date.parse(b.at)), 0);
  const logo = (storage?.assets ?? 0) > 0;

  return {
    skSet: p.status === 'loading' && p.loading.slow,
    mtLoad: {
      ok: p.status === 'ready',
      fail: p.status === 'failed',
      text: p.failure,
      onRetry: () => void p.retry(),
    },
    mtTabs: MT_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),

    tgMaint: { on: p.on, onClick: () => p.toggle() },
    maintStatus: p.on ? m.maintenance_status_on() : m.maintenance_status_off(),
    maintMsg: p.message,
    onMaintMsg: (value) => p.setMessage(value),
    maintReset: () => p.resetMessage(),
    maintCustom: p.message !== m.login_maint_default(),

    bkSum: list.length ? m.maintenance_bk_last({ ago: ago(last, input.now) }) : m.maintenance_bk_none(),
    bkB: {
      busy: p.bkBusy,
      icon: p.bkBusy ? 'ti-loader-2' : 'ti-database-plus',
      label: p.bkBusy ? m.maintenance_busy() : m.maintenance_bk_now(),
      rot: p.bkRot,
    },
    bkNow: () => p.create(),
    bkRows: list.map((b, i) => {
      const at = Date.parse(b.at);
      const title = `${formatDate(at, input.dateFmt, input.tz)}, ${clock(at, input)}`;
      return {
        id: b.id,
        title,
        sub: `${storageSize(b.size)} · ${b.auto ? m.maintenance_bk_auto() : m.maintenance_bk_manual()}`,
        sep: i > 0,
        icon: b.auto ? 'ti-clock' : 'ti-hand-click',
        href: `${API_BASE}/${BACKUPS}/${b.id}/download`,
        onDownload: () => ui.toasts.show(m.maintenance_bk_download()),
        onRestore: () => p.restore(b.id, title),
        onRemove: () => p.remove(b.id),
      };
    }),
    bkEmpty: list.length === 0,
    tgBkAuto: { on: s.auto, onClick: () => p.setSchedule({ auto: !s.auto }) },
    bkEveryOpts: segOptions(
      BK_EVERY_OPTS,
      s.every,
      (v) => BK_EVERY[v](),
      (every) => p.setSchedule({ every }),
    ),
    bkKeepOpts: BK_KEEP_OPTS.map((keep) => ({
      value: keep,
      label: BK_KEEP[keep](),
      on: keep === s.keep,
      onClick: () => p.setSchedule({ keep }),
    })),
    bkNext:
      s.auto && nextAt ? m.maintenance_bk_next({ when: whenText(Date.parse(nextAt), input) }) : m.maintenance_bk_off(),

    stRows: [
      {
        icon: 'ti-database' as const,
        label: m.maintenance_st_db(),
        sub: m.maintenance_st_db_sub(),
        size: storageSize(storage?.database ?? 0),
      },
      {
        icon: 'ti-archive' as const,
        label: m.maintenance_tab_backups(),
        sub: countText(list.length),
        size: storageSize(list.reduce((sum, b) => sum + b.size, 0)),
      },
      {
        icon: 'ti-photo' as const,
        label: m.maintenance_st_logo(),
        sub: logo ? storage?.asset_name || m.maintenance_st_logo_own() : m.maintenance_st_logo_none(),
        size: logo ? storageSize(storage?.assets ?? 0) : '0 KB',
      },
    ].map((row, i) => ({ ...row, sep: i > 0 })),
    stB: {
      busy: p.stBusy,
      icon: p.stBusy ? 'ti-loader-2' : 'ti-arrows-minimize',
      label: p.stBusy ? m.maintenance_busy() : m.maintenance_st_compact(),
      rot: p.stRot,
    },
    stDesc: storage?.compacted_at
      ? `${m.maintenance_st_desc()} ${m.maintenance_st_last({ ago: ago(Date.parse(storage.compacted_at), input.now) })}`
      : m.maintenance_st_desc(),
    stCompact: () => p.compact(),
  };
}
