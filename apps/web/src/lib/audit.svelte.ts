/**
 * Administration › Audit log against `admin/audit`: search, filters with counts,
 * entries by day, export and retention.
 *
 * Texts, icons and counts come ready-made from the backend; only the days
 * (`aGroups`) are built here, because the backend does not know the time zone of
 * the settings. The search only goes out after a typing pause: in the backend it
 * reads all rows of the retention period on the shared connection. The export is
 * `POST` and loads the file via `fetch`; it is itself logged, so the page reloads
 * afterwards, as it does after a changed retention period, which takes effect at
 * once.
 *
 * Loading: before the first response counts and retention stay empty, an empty
 * frame stands instead of the days (`aFirst`); when filter or search change, the
 * previous list with its counts stays until the response (`aBusyAttr`). If
 * loading fails, each part shows its card (`aLoad`, `aKeepLoad`) with "Try
 * again", the counts are empty; further pages are loaded only by the button
 * below the last day (`aMore`).
 */
import { api, apiBlob, isApiError } from '#lib/api.ts';
import { formatDate } from '#lib/date.ts';
import { downloadBlob } from '#lib/download.ts';
import { failText } from '#lib/errors.ts';
import { isIconName, type IconName } from '#lib/icons.ts';
import { clock, dayLabel, dayNumber, type TimeContext } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export type AuditCat = 'login' | 'users' | 'settings' | 'system';
/** Filter (`aFilter`); `all` = "All". */
export type AuditFilter = 'all' | AuditCat;
export type KeepDays = 30 | 90 | 365;

/** Entry from `GET admin/audit`; `act` follows `who`. */
export interface AuditEntry {
  id: number;
  at: string;
  cat: AuditCat;
  icon: string;
  who: string;
  act: string;
  meta: string;
  warn: boolean;
}

export type AuditCounts = Record<AuditFilter, number>;

interface AuditData {
  entries: AuditEntry[];
  counts: AuditCounts;
  next: number | null;
}

/** Filters in display order: "All", then the categories. */
const FILTERS: readonly [AuditFilter, () => string][] = [
  ['all', m.audit_all],
  ['login', m.audit_cat_login],
  ['users', m.audit_cat_users],
  ['settings', m.audit_cat_settings],
  ['system', m.audit_cat_system],
];

/** Selectable retention periods in days. */
const KEEP: readonly [KeepDays, () => string][] = [
  [30, m.audit_keep_30],
  [90, m.audit_keep_90],
  [365, m.audit_keep_365],
];

/** Retention period in a sentence (`aKeepSum`): "1 year" becomes "one year". */
const KEEP_PERIOD: Record<KeepDays, () => string> = {
  30: m.audit_keep_30,
  90: m.audit_keep_90,
  365: m.audit_keep_year,
};

/** Typing pause of the search in milliseconds; longer than in the mailbox because every search reads all rows. */
export const AUDIT_SEARCH_DELAY = 400;

const LIST = 'admin/audit';
const EXPORT = 'admin/audit/export';
const RETENTION = 'admin/audit/retention';

/** Path of the request; empty values are left out. */
export function auditPath(base: string, filter: AuditFilter, q: string, before: number | null = null): string {
  const query: [string, string][] = [];
  if (filter !== 'all') query.push(['cat', filter]);
  if (q) query.push(['q', q]);
  if (before !== null) query.push(['before', String(before)]);
  return query.length ? `${base}?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : base;
}

/** File name with the date in the time zone (`audit-log-YYYY-MM-DD.csv`); the backend only knows UTC. */
export function exportName(now: number, tz: string): string {
  return m.audit_file_name({ date: formatDate(now, 'iso', tz) });
}

/** Without a session or role: reload the account, the layout then shows sign-in or "Access denied". */
function checkAccess(error: unknown): void {
  if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
}

export class AuditPage {
  /** Search input (`aQ`); the search runs after the typing pause. */
  q = $state('');
  filter = $state<AuditFilter>('all');
  entries = $state.raw<AuditEntry[]>([]);
  /** Counts at the filters; `null` before the first response. */
  counts = $state.raw<AuditCounts | null>(null);
  /** `before` of the next page; `null` on the last one. */
  next = $state<number | null>(null);
  /** A request for the first page is running. */
  loading = $state(false);
  loadingMore = $state(false);
  /** Reason of the last failure; `null` = no error. */
  error = $state<string | null>(null);
  /** Retention period (`aKeep`); `null` while it is not loaded. */
  keep = $state<KeepDays | null>(null);
  keepError = $state<string | null>(null);

  /** Search text of the shown list; the input may already be further. */
  #sent = '';
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #exporting = false;
  #saving = false;
  #disposed = false;

  open(): void {
    void this.load();
    void this.loadKeep();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopTimer();
  }

  #stopTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Loads the first page of the current selection; a later request supersedes a running one. */
  async load(): Promise<void> {
    if (this.#disposed) return;
    this.#stopTimer();
    const seq = ++this.#seq;
    const q = (this.#sent = this.q.trim());
    this.loading = true;
    this.loadingMore = false;
    try {
      const data = await api<AuditData>('GET', auditPath(LIST, this.filter, q));
      if (seq !== this.#seq || this.#disposed) return;
      this.entries = data.entries;
      this.counts = data.counts;
      this.next = data.next;
      this.error = null;
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      checkAccess(error);
      this.error = failText(error);
      // The previous list no longer applies: counts empty, "Try again" starts like the first load.
      this.entries = [];
      this.counts = null;
      this.next = null;
    } finally {
      if (seq === this.#seq && !this.#disposed) this.loading = false;
    }
  }

  /** "Try again": the card disappears while loading (empty frame as at the first load). */
  retry(): Promise<void> {
    this.error = null;
    return this.load();
  }

  /** Appends the next page; if a `load()` comes in between, the response is dropped. */
  async more(): Promise<void> {
    const before = this.next;
    if (before === null || this.loading || this.loadingMore) return;
    const seq = this.#seq;
    this.loadingMore = true;
    try {
      const data = await api<AuditData>('GET', auditPath(LIST, this.filter, this.#sent, before));
      if (seq !== this.#seq || this.#disposed) return;
      this.entries = [...this.entries, ...data.entries];
      this.counts = data.counts;
      this.next = data.next;
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      checkAccess(error);
      ui.toasts.error(failText(error));
    } finally {
      if (seq === this.#seq && !this.#disposed) this.loadingMore = false;
    }
  }

  /** Search input (`onAQ`); spaces at the edges do not change the search. */
  setQuery(value: string): void {
    this.q = value;
    this.#stopTimer();
    if (value.trim() !== this.#sent) this.#timer = setTimeout(() => void this.load(), AUDIT_SEARCH_DELAY);
  }

  /** "Clear search" (`clearAQ`) takes effect at once. */
  clearQuery(): void {
    this.q = '';
    this.#stopTimer();
    if (this.#sent) void this.load();
  }

  setFilter(filter: AuditFilter): void {
    if (filter === this.filter) return;
    this.filter = filter;
    void this.load();
  }

  /**
   * "Export as CSV" (`aExport`). A pending or running search goes
   * first: file and count in the toast apply to the list that is about to show.
   */
  async exportCsv(tz: string): Promise<void> {
    if (this.#exporting) return;
    this.#exporting = true;
    try {
      if (this.#timer !== undefined || this.loading || this.error !== null) await this.load();
      if (this.error !== null) return;
      const n = this.counts?.[this.filter] ?? 0;
      const blob = await apiBlob('POST', auditPath(EXPORT, this.filter, this.#sent));
      if (!downloadBlob(exportName(Date.now(), tz), blob)) ui.toasts.error(m.error_act());
      else ui.toasts.show(n === 1 ? m.audit_exported_one() : m.audit_exported({ n }));
      void this.load();
    } catch (error) {
      checkAccess(error);
      ui.toasts.error(failText(error));
    } finally {
      this.#exporting = false;
    }
  }

  async loadKeep(): Promise<void> {
    if (this.#disposed) return;
    this.keepError = null;
    try {
      const { days } = await api<{ days: KeepDays }>('GET', RETENTION);
      if (!this.#disposed) this.keep = days;
    } catch (error) {
      if (this.#disposed) return;
      checkAccess(error);
      this.keepError = failText(error);
    }
  }

  /**
   * Choose the retention period; it applies at once. Clicks
   * while saving do not count, otherwise the backend could see the last choice
   * before the second-to-last.
   */
  async setKeep(days: KeepDays): Promise<void> {
    const before = this.keep;
    if (before === null || days === before || this.#saving) return;
    this.#saving = true;
    this.keep = days;
    try {
      await api('PUT', RETENTION, { days });
      void this.load();
    } catch (error) {
      this.keep = before;
      checkAccess(error);
      ui.toasts.error(failText(error));
    } finally {
      this.#saving = false;
    }
  }
}

export type AuditTime = Pick<TimeContext, 'now' | 'tz' | 'timeFmt'>;

export interface AuditPill {
  key: AuditFilter;
  label: string;
  /** `null` before the first response. */
  n: number | null;
  on: boolean;
  onClick: () => void;
}

export interface AuditRow {
  id: number;
  icon: IconName;
  who: string;
  act: string;
  /** Name of the category. */
  cat: string;
  meta: string;
  mMeta: string;
  sep: boolean;
  /** Tile in `--danger` (`tileBg`, `tileInk`). */
  warn: boolean;
}

export interface AuditGroup {
  /** Calendar day as a number, key of the list. */
  day: number;
  label: string;
  rows: AuditRow[];
}

export interface AuditKeepOption {
  days: KeepDays;
  label: string;
  on: boolean;
  /** `aria-disabled` until the first response: no selection, clicks have no effect. */
  dis: boolean;
  onClick: () => void;
}

/** Card "Loading failed" of the list (`aLoad`). */
export interface AuditFailure {
  fail: boolean;
  text: string;
  onRetry: () => void;
}

/** Box "Keep entries" or its card (`aKeepLoad`). */
export interface AuditKeepLoad extends AuditFailure {
  /** Box visible: loaded or until the first response. */
  box: boolean;
  /** `aria-busy` of the box until the first response. */
  busy: boolean;
}

/** Button "Load more entries" (`aMore`). */
export interface AuditMore {
  show: boolean;
  /** Loading more is running: ti-loader-2 and "Loading …", `aria-busy`. */
  busy: boolean;
  idle: boolean;
  label: string;
  onClick: () => void;
}

export interface AuditValues {
  aQ: string;
  aHasQ: boolean;
  onAQ: (value: string) => void;
  clearAQ: () => void;
  aExport: () => void;
  aPills: AuditPill[];
  aGroups: AuditGroup[];
  aEmpty: boolean;
  aKeepOpts: AuditKeepOption[];
  aKeepSum: string;
  /** Until the first response (also after "Try again"): empty frame instead of the days. */
  aFirst: boolean;
  /** `aria-busy` on the container of the days while the previous list stays after a change. */
  aBusyAttr: boolean;
  aLoad: AuditFailure;
  aMore: AuditMore;
  aKeepLoad: AuditKeepLoad;
}

/**
 * The days of the list (`aGroups`). The backend sorts by `id`; if the
 * server clock jumps back, a day must still appear only once.
 */
export function auditGroups(entries: readonly AuditEntry[], time: AuditTime): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const e of entries) {
    const at = Date.parse(e.at);
    const day = dayNumber(at, time.tz);
    let group = groups.find((g) => g.day === day);
    if (!group) {
      group = { day, label: dayLabel(at, time), rows: [] };
      groups.push(group);
    }
    const cat = FILTERS.find(([key]) => key === e.cat)?.[1]() ?? e.cat;
    const hour = clock(at, time);
    group.rows.push({
      id: e.id,
      icon: isIconName(e.icon) ? e.icon : 'ti-history',
      who: e.who,
      act: e.act,
      cat,
      meta: e.meta ? `${hour} · ${e.meta}` : hour,
      mMeta: e.meta ? `${hour} · ${cat} · ${e.meta}` : `${hour} · ${cat}`,
      sep: group.rows.length > 0,
      warn: e.warn,
    });
  }
  return groups;
}

export function auditValues(p: AuditPage, time: AuditTime): AuditValues {
  const keep = p.keep;
  const fail = p.error !== null;
  const first = p.counts === null && !fail;
  // Before the first response and after a failure: no counts, no days.
  const off = first || fail;
  const keepFail = p.keepError !== null;
  const more = p.loadingMore;
  return {
    aQ: p.q,
    aHasQ: !!p.q,
    onAQ: (value) => p.setQuery(value),
    clearAQ: () => p.clearQuery(),
    aExport: () => void p.exportCsv(time.tz),
    aPills: FILTERS.map(([key, label]) => ({
      key,
      label: label(),
      n: off ? null : (p.counts?.[key] ?? null),
      on: key === p.filter,
      onClick: () => p.setFilter(key),
    })),
    aGroups: off ? [] : auditGroups(p.entries, time),
    aEmpty: !off && p.entries.length === 0,
    aKeepOpts: KEEP.map(([days, label]) => ({
      days,
      label: label(),
      on: days === keep,
      dis: keep === null,
      onClick: () => void p.setKeep(days),
    })),
    aKeepSum: keep === null ? '' : m.audit_keep_sum({ period: KEEP_PERIOD[keep]() }),
    aFirst: first,
    aBusyAttr: !off && p.loading,
    aLoad: { fail, text: p.error ?? '', onRetry: () => void p.retry() },
    aMore: {
      show: !off && p.next !== null,
      busy: more,
      idle: !more,
      label: more ? m.audit_more_busy() : m.audit_more(),
      onClick: () => void p.more(),
    },
    aKeepLoad: {
      box: !keepFail,
      fail: keepFail,
      busy: keep === null && !keepFail,
      text: p.keepError ?? '',
      onRetry: () => void p.loadKeep(),
    },
  };
}
