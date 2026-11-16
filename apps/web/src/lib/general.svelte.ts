/**
 * Settings › General page: start (`selStart`), behaviour (`tgConfirm`,
 * `undoOpts`, `tgKeys`), swipe gestures (`selSwL`, `selSwR`), data (`doExport`,
 * `clearLocal`) and delete account (`deleteAccount`, `soleAdm`); the tabs
 * `genTabs` jump to the sections. "External content" lives in the page itself
 * (`#lib/mail/remote-content.ts`).
 *
 * - **Export in the browser**: account from `auth/me`, settings and
 *   notifications from `settings` as JSON. The file is created at once, a
 *   "Creating" state is not needed.
 * - **Local data** is what the browser stores for the app: Cache
 *   Storage and IndexedDB (`navigator.storage.estimate()`) and
 *   `localStorage`. The last opened page (`#lib/last-page.ts`) does not
 *   count – it is a setting of the device, not a cache, and would otherwise
 *   always show as "0.1 MB" –, but "Clear" removes it too.
 *   After deleting, `POST settings/local-reset` reports the action only for
 *   the audit log.
 * - **Delete account**: confirmation word, `DELETE auth/me`, on success like
 *   signing out. As the only active administrator (`auth/me` › `sole_admin`)
 *   the button is locked; if the server still answers 409 `last_admin`, the
 *   dialog closes with the error toast and `sole_admin` applies from then on.
 */
import { api, isApiError } from '#lib/api.ts';
import type { SegOption } from '#lib/appearance.ts';
import { buildInfo } from '#lib/build-info.ts';
import { downloadBlob } from '#lib/download.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { CACHE_VERSION_KEY } from '#lib/client-cache.ts';
import { forgetPage, LAST_PAGE_KEY, localStore } from '#lib/last-page.ts';
import { mailPush, MAIL_PUSH_KEY } from '#lib/mail-push.svelte.ts';
import { editLogs } from '#lib/mail-queue.ts';
import { mailStores } from '#lib/mail-store.ts';
import { m } from '#lib/paraglide/messages.js';
import { segOptions, selectValues, type SelectContext, type SelectState, type SelectValues } from '#lib/select.ts';
import { forgetAccount } from '#lib/state/account.ts';
import { START_OPTS } from '#lib/settings-choices.ts';
import { prefs, type Settings } from '#lib/state/prefs.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';
import { session, type Branding, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { accentOf, modeName } from '#lib/theme.ts';
import { UNDO_MS } from '#lib/undo.ts';
import { intlLocale } from '#lib/locale.ts';

export { START_OPTS };

/** Sections of the page (`data-sec`, `genTabs`). */
export type GeneralSection = 'start' | 'behavior' | 'swipe' | 'ext' | 'data' | 'danger';

/** Select lists of the page. */
export type GeneralSelect = 'start' | 'swL' | 'swR';

/** Actions of the swipe gestures (`SW_OPTS`); `none` = "No action". */
export const SWIPE_OPTS = ['none', 'del', 'read', 'star', 'spam', 'move'] as const;

export const UNDO_OPTS = Object.keys(UNDO_MS) as Settings['gUndo'][];

/** Confirmation word of the API for `DELETE auth/me`, independent of the UI language. */
export const DELETE_CONFIRM = 'delete';

const START_LABELS: Record<(typeof START_OPTS)[number], () => string> = {
  inbox: () => m.general_start_inbox(),
  last: () => m.general_start_last(),
};

const SWIPE_LABELS: Record<(typeof SWIPE_OPTS)[number], () => string> = {
  none: () => m.general_sw_none(),
  del: () => m.general_sw_del(),
  read: () => m.general_sw_read(),
  star: () => m.general_sw_star(),
  spam: () => m.general_sw_spam(),
  move: () => m.general_sw_move(),
};

/** Button with an icon that spins during the action (`ti-loader-2`, label of the action, cursor `progress`). */
export interface BusyButton {
  icon: IconName;
  label: string;
  busy: boolean;
}

export interface GeneralValues {
  genTabs: { label: string; onClick: () => void }[];
  selStart: SelectValues;
  tgConfirm: { on: boolean; onClick: () => void };
  undoOpts: SegOption<Settings['gUndo']>[];
  tgKeys: { on: boolean; onClick: () => void };
  selSwL: SelectValues;
  selSwR: SelectValues;
  exportB: BusyButton;
  localB: BusyButton;
  localSum: string;
  /** `localOp`: faded without local data, "Clear" then does nothing. */
  localDim: boolean;
  /** Only active administrator (`auth/me` › `sole_admin`): notice with "Manage users", button locked. */
  soleAdm: boolean;
  delSub: string;
  /** Tooltip on the locked button, only on desktop. */
  delTip: string | undefined;
  /** `dis` with `soleAdm` (faded, cursor `default`) and while deleting (`busy`, cursor `progress`). */
  delB: { label: string; dis: boolean; busy: boolean };
}

export interface GeneralInput extends SelectState<GeneralSelect> {
  values: Pick<Settings, 'gStart' | 'gConfirm' | 'gUndo' | 'gKeys' | 'swL' | 'swR'>;
  soleAdmin: boolean;
  /** Storage used by the app on the device in bytes; `null` while unknown. */
  localBytes: number | null;
  clearing: boolean;
  deleting: boolean;
}

export interface GeneralContext extends SelectContext<GeneralSelect> {
  set: (patch: Partial<Settings>) => void;
  scrollTo: (section: GeneralSection) => void;
}

const TABS: [GeneralSection, () => string][] = [
  ['start', () => m.general_tab_start()],
  ['behavior', () => m.general_tab_behavior()],
  ['swipe', () => m.general_tab_swipe()],
  ['ext', () => m.general_tab_ext()],
  ['data', () => m.general_tab_data()],
  ['danger', () => m.general_tab_danger()],
];

const MB = 1024 * 1024;

/** "184 MB on this device" or "No local data on this device"; below 10 MB with one decimal, at least 0.1. */
export function localSummary(bytes: number | null): string {
  if (!bytes || bytes <= 0) return m.general_local_none();
  const mb = bytes / MB;
  const size = mb >= 10 ? Math.round(mb) : Math.max(0.1, Math.round(mb * 10) / 10);
  return m.general_local_sum({ size: size.toLocaleString(intlLocale(), { maximumFractionDigits: 1 }) });
}

export function generalValues(input: GeneralInput, ctx: GeneralContext): GeneralValues {
  const { values, soleAdmin, clearing, deleting } = input;
  const swipeOpts = SWIPE_OPTS.map((v) => ({ v, l: SWIPE_LABELS[v]() }));
  const hasLocal = !!input.localBytes && input.localBytes > 0;
  return {
    genTabs: TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    selStart: selectValues(
      'start',
      m.general_start_title(),
      START_OPTS.map((v) => ({ v, l: START_LABELS[v]() })),
      values.gStart,
      (v) => ctx.set({ gStart: v as Settings['gStart'] }),
      false,
      input,
      ctx,
    ),
    tgConfirm: { on: values.gConfirm, onClick: () => ctx.set({ gConfirm: !values.gConfirm }) },
    undoOpts: segOptions(
      UNDO_OPTS,
      values.gUndo,
      (v) => v,
      (gUndo) => ctx.set({ gUndo }),
    ),
    tgKeys: { on: values.gKeys, onClick: () => ctx.set({ gKeys: !values.gKeys }) },
    selSwL: selectValues(
      'swL',
      m.general_swipe_left(),
      swipeOpts,
      values.swL,
      (swL) => ctx.set({ swL }),
      false,
      input,
      ctx,
    ),
    selSwR: selectValues(
      'swR',
      m.general_swipe_right(),
      swipeOpts,
      values.swR,
      (swR) => ctx.set({ swR }),
      false,
      input,
      ctx,
    ),
    exportB: { icon: 'ti-download', label: m.general_export(), busy: false },
    localB: clearing
      ? { icon: 'ti-loader-2', label: m.general_local_busy(), busy: true }
      : { icon: 'ti-eraser', label: m.general_local(), busy: false },
    localSum: localSummary(input.localBytes),
    localDim: !hasLocal && !clearing,
    soleAdm: soleAdmin,
    delSub: soleAdmin ? m.general_delete_sole() : m.general_delete_sub(),
    delTip: soleAdmin && !input.isMobile ? m.general_delete_tip() : undefined,
    delB: {
      label: deleting ? m.general_delete_busy() : m.general_delete(),
      dis: soleAdmin || deleting,
      busy: deleting,
    },
  };
}

export interface ExportInput {
  appName: string;
  version: string;
  now: Date;
  user: Pick<Me, 'display_name' | 'email'>;
  values: Settings;
  brand: Pick<Branding, 'userAccent' | 'color'>;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Export file: name `<app>-export-YYYY-MM-DD.json` (local time) and content. */
export function exportFile(input: ExportInput): { name: string; json: string } {
  const { values: x, now } = input;
  const data = {
    app: input.appName,
    version: input.version,
    exported: now.toISOString(),
    account: { name: input.user.display_name, email: input.user.email },
    settings: {
      mode: modeName(x.mode),
      accent: accentOf(x, input.brand),
      fontSize: x.fontSize,
      density: x.density,
      listDesign: x.pfDesign,
      animations: x.animations,
      language: x.lang,
      region: x.region,
      timeZone: x.tzAuto ? 'auto' : x.tz,
      dateFormat: x.dateFmt,
      timeFormat: x.timeFmt,
      weekStart: x.weekStart,
      numberFormat: x.numFmt,
      startPage: x.gStart,
      confirm: x.gConfirm,
      undo: x.gUndo,
    },
    notifications: {
      channels: x.nCh,
      topics: x.nMx,
      quietHours: x.nQuiet ? { from: x.nFrom, to: x.nTo } : null,
      digest: x.nDigest,
    },
  };
  // Without hyphens at the edges ("***" would otherwise give "-").
  const slug =
    input.appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'app';
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  return { name: `${slug}-export-${date}.json`, json: JSON.stringify(data, null, 2) };
}

/** Keys in `localStorage` that do not count as local data (settings of the device). */
const NOT_COUNTED = new Set([LAST_PAGE_KEY, MAIL_PUSH_KEY, CACHE_VERSION_KEY]);

function webStorageBytes(storage: Storage | null): number {
  if (!storage) return 0;
  let chars = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) ?? '';
    if (!NOT_COUNTED.has(key)) chars += key.length + (storage.getItem(key)?.length ?? 0);
  }
  // UTF-16 as in the browser's storage.
  return chars * 2;
}

/** Storage used by the app on the device: the browser's estimate plus `localStorage` (not counted there everywhere), without the last opened page. */
export async function deviceBytes(): Promise<number> {
  let usage = 0;
  try {
    usage = (await navigator.storage?.estimate?.())?.usage ?? 0;
  } catch {
    // Without an estimate only what the app stores itself counts.
  }
  try {
    usage += webStorageBytes(localStore());
  } catch {
    // Blocked: nothing to count.
  }
  return usage;
}

/** Deletes what the browser stores for the app: `localStorage`, Cache Storage, IndexedDB. Errors of single stores do not abort. */
export async function clearDeviceData(): Promise<void> {
  // Before deleting: otherwise this tab would fill the store again right away.
  mailStores.pause();
  editLogs.pause();
  try {
    localStore()?.clear();
  } catch {
    // Blocked: nothing stored.
  }
  try {
    if (globalThis.caches) await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  } catch {
    // Without Cache Storage (insecure context): nothing stored.
  }
  try {
    const dbs = (await globalThis.indexedDB?.databases?.()) ?? [];
    // Wait so that the measurement afterwards no longer counts the store; "blocked" (open connection) deletes on close.
    await Promise.all(dbs.flatMap((db) => (db.name ? [deleteDatabase(db.name)] : [])));
  } catch {
    // Without IndexedDB: nothing stored.
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((done) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => done();
  });
}

/** State of the page beyond its lifetime: storage, running deletion. */
export class General {
  localBytes = $state<number | null>(null);
  clearing = $state(false);
  deleting = $state(false);
  /** Counts measurements; only the last one sets the value (a slow one from opening would otherwise overtake the one after deleting). */
  #measuring = 0;

  /** When opening the page: measure storage and reload `auth/me` – `sole_admin` changes as soon as someone appoints another administrator. */
  async open(): Promise<void> {
    await Promise.all([this.measure(), session.refreshUser().catch(() => {})]);
  }

  /** Determine the storage on the device again (when opening the page and after deleting). */
  async measure(): Promise<void> {
    const n = ++this.#measuring;
    const bytes = await deviceBytes();
    if (n === this.#measuring) this.localBytes = bytes;
  }

  doExport(): void {
    const user = session.user;
    if (!user) return;
    const file = exportFile({
      appName: session.appName,
      version: buildInfo.version,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- time of the export, no state
      now: new Date(),
      user,
      values: prefs.values,
      brand: session.branding,
    });
    if (downloadBlob(file.name, new Blob([file.json], { type: 'application/json' })))
      ui.toasts.show(m.general_export_done());
    else ui.toasts.error(m.error_act());
  }

  clearLocal(): void {
    if (!this.localBytes || this.clearing) return;
    ui.ask({
      title: m.general_local_ask_title(),
      text: m.general_local_ask_text(),
      icon: 'ti-eraser',
      ok: m.general_local(),
      danger: true,
      run: () => void this.#clear(),
    });
  }

  async #clear(): Promise<void> {
    this.clearing = true;
    try {
      // Sign out first: without a note in local storage the device no longer knows its entries.
      await mailPush.withdraw();
      await clearDeviceData();
      await mailPush.clearDevice();
      // Only an audit log entry: if it fails (offline, 429), the data is deleted anyway.
      await api('POST', 'settings/local-reset').catch(() => undefined);
      ui.toasts.show(m.general_local_done());
    } finally {
      this.clearing = false;
      await this.measure();
    }
  }

  deleteAccount(): void {
    const user = session.user;
    if (!user || user.sole_admin || this.deleting) return;
    ui.ask({
      force: true,
      title: m.general_delete_title(),
      text: m.general_delete_text({ email: user.email }),
      icon: 'ti-trash',
      ok: m.general_delete(),
      danger: true,
      word: m.general_delete_word(),
      run: () => void this.#delete(),
    });
  }

  async #delete(): Promise<void> {
    this.deleting = true;
    try {
      // Actions still waiting for "Undo" go out first (as when signing out).
      await ui.toasts.flush();
      await api('DELETE', 'auth/me', { confirm: DELETE_CONFIRM });
    } catch (error) {
      this.deleting = false;
      if (isApiError(error, 409, 'last_admin')) {
        // Meanwhile no other administrator is active any more: from now on the notice instead of the button.
        if (session.user) session.user = { ...session.user, sole_admin: true };
        ui.toasts.error(m.general_delete_last());
        return;
      }
      ui.toasts.error(failText(error));
      // Session expired: `auth/me` reports "not signed in", the layout leads to sign-in.
      if (isApiError(error, 401)) void session.refreshUser().catch(() => {});
      return;
    }
    this.deleting = false;
    // Like signing out: the server deleted the cookie, the layout leads to sign-in.
    forgetPage();
    void mailPush.clearDevice();
    forgetAccount();
    search.reset();
  }
}

export const general = new General();
