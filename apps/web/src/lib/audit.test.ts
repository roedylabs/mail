import { afterEach, describe, expect, it, vi } from 'vitest';
import auditTexts from '../../../../crates/server/src/api/audit/texts.rs?raw';
import {
  AUDIT_SEARCH_DELAY,
  auditGroups,
  auditPath,
  AuditPage,
  auditValues,
  exportName,
  type AuditCounts,
  type AuditEntry,
} from '#lib/audit.svelte.ts';
import { downloadBlob } from '#lib/download.ts';
import { icons } from '#lib/icons.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

vi.mock('#lib/download.ts', () => ({ downloadBlob: vi.fn(() => true) }));

const TIME = { now: Date.parse('2026-11-05T12:00:00Z'), tz: 'Europe/Berlin', timeFmt: '24h' } as const;

function entry(id: number, at: string, over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    at,
    cat: 'login',
    icon: 'ti-login',
    who: 'Max Example',
    act: ' signed in',
    meta: 'Berlin, Germany',
    warn: false,
    ...over,
  };
}

const COUNTS: AuditCounts = { all: 7, login: 2, users: 2, settings: 1, system: 2 };
const FIRST = entry(12, '2026-11-05T09:26:00.000Z');

function data(entries: AuditEntry[] = [FIRST], next: number | null = null, counts: AuditCounts = COUNTS) {
  return { body: { entries, counts, next } };
}

/** Response that only arrives on `release()`. */
function later(answer: { status?: number; body?: unknown }) {
  let release = () => {};
  const reply = () =>
    new Promise<{ status?: number; body?: unknown }>((resolve) => {
      release = () => resolve(answer);
    });
  return { reply, release: () => release() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  ui.toasts.dismiss();
  session.user = null;
});

describe('auditPath', () => {
  it('leaves out empty values', () => {
    expect(auditPath('admin/audit', 'all', '')).toBe('admin/audit');
  });

  it('names filter, search and page', () => {
    expect(auditPath('admin/audit', 'users', 'é & B', 5)).toBe('admin/audit?cat=users&q=%C3%A9%20%26%20B&before=5');
  });
});

describe('exportName', () => {
  it('takes the date in the time zone, not the one in UTC', () => {
    const late = Date.parse('2026-11-05T23:30:00Z');
    expect(exportName(late, 'Europe/Berlin')).toBe('audit-log-2026-11-06.csv');
    expect(exportName(late, 'UTC')).toBe('audit-log-2026-11-05.csv');
  });
});

describe('auditGroups', () => {
  it('builds days in the time zone with “Today”, “Yesterday” and the date', () => {
    const groups = auditGroups(
      [
        entry(4, '2026-11-05T09:26:00.000Z'),
        // Already the 5th in Berlin, still the 4th in UTC.
        entry(3, '2026-11-04T23:30:00.000Z'),
        entry(2, '2026-11-04T08:00:00.000Z'),
        entry(1, '2026-11-02T08:00:00.000Z'),
      ],
      TIME,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Today', [4, 3]],
      ['Yesterday', [2]],
      ['Monday 2 November', [1]],
    ]);
    expect(groups[0]!.rows.map((r) => r.sep)).toEqual([false, true]);
  });

  it('names a day only once, even if the server clock jumped back', () => {
    const groups = auditGroups(
      [
        entry(3, '2026-11-05T09:26:00.000Z'),
        entry(2, '2026-11-04T09:26:00.000Z'),
        entry(1, '2026-11-05T08:00:00.000Z'),
      ],
      TIME,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Today', [3, 1]],
      ['Yesterday', [2]],
    ]);
  });

  it('joins time, category and detail', () => {
    const [row] = auditGroups([FIRST], TIME)[0]!.rows;
    expect(row).toMatchObject({
      who: 'Max Example',
      act: ' signed in',
      cat: 'Sign-in',
      icon: 'ti-login',
      meta: '10:26 · Berlin, Germany',
      mMeta: '10:26 · Sign-in · Berlin, Germany',
      warn: false,
    });
  });

  it('does without a separator when there is no detail', () => {
    const [row] = auditGroups([entry(1, FIRST.at, { meta: '', cat: 'system' })], TIME)[0]!.rows;
    expect(row).toMatchObject({ meta: '10:26', mMeta: '10:26 · System' });
  });

  it('follows the time format of the settings', () => {
    const [row] = auditGroups([FIRST], { ...TIME, timeFmt: '12h' })[0]!.rows;
    expect(row!.meta).toBe('10:26 AM · Berlin, Germany');
  });

  it('replaces an unknown icon', () => {
    const [row] = auditGroups([entry(1, FIRST.at, { icon: 'ti-does-not-exist' })], TIME)[0]!.rows;
    expect(row!.icon).toBe('ti-history');
  });

  it('knows every icon the backend catalogue names', () => {
    const named = [...auditTexts.matchAll(/"(ti-[a-z0-9-]+)"/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(40);
    expect(named.filter((name) => !(name in icons))).toEqual([]);
  });
});

describe('list', () => {
  it('loads the first page and shows the counts', async () => {
    const api = mockApi({ 'GET admin/audit': [data()] });
    const p = new AuditPage();
    // Until the first response: empty counts, empty frame, no button.
    expect(auditValues(p, TIME)).toMatchObject({
      aFirst: true,
      aEmpty: false,
      aGroups: [],
      aBusyAttr: false,
      aMore: { show: false },
      aLoad: { fail: false },
    });
    expect(auditValues(p, TIME).aPills.map((o) => o.n)).toEqual([null, null, null, null, null]);
    await p.load();
    const v = auditValues(p, TIME);
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit']);
    expect(v).toMatchObject({
      aFirst: false,
      aEmpty: false,
      aBusyAttr: false,
      aMore: { show: false },
      aLoad: { fail: false, text: '' },
    });
    expect(v.aPills.map((o) => [o.key, o.label, o.n, o.on])).toEqual([
      ['all', 'All', 7, true],
      ['login', 'Sign-in', 2, false],
      ['users', 'Users', 2, false],
      ['settings', 'Settings', 1, false],
      ['system', 'System', 2, false],
    ]);
    expect(v.aGroups).toHaveLength(1);
  });

  it('reports the empty state only after the response', async () => {
    mockApi({ 'GET admin/audit': [data([])] });
    const p = new AuditPage();
    await p.load();
    expect(auditValues(p, TIME)).toMatchObject({ aEmpty: true, aFirst: false, aGroups: [] });
  });

  it('keeps the previous list while the filter changes until the new one is there', async () => {
    const answer = later(data([entry(9, FIRST.at, { cat: 'users' })]));
    const api = mockApi({ 'GET admin/audit': [data()], 'GET admin/audit?cat=users': [answer.reply] });
    const p = new AuditPage();
    await p.load();
    const onUsers = auditValues(p, TIME).aPills[2]!.onClick;
    onUsers();
    expect(auditValues(p, TIME)).toMatchObject({ aBusyAttr: true, aFirst: false });
    expect(auditValues(p, TIME).aPills[2]!.on).toBe(true);
    // The previous counts stay until the new list is there.
    expect(auditValues(p, TIME).aPills[2]!.n).toBe(2);
    expect(p.entries.map((e) => e.id)).toEqual([12]);
    answer.release();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    expect(p.entries.map((e) => e.id)).toEqual([9]);
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit', 'admin/audit?cat=users']);
  });

  it('does not reload for the same filter', async () => {
    const api = mockApi({ 'GET admin/audit': [data()] });
    const p = new AuditPage();
    await p.load();
    p.setFilter('all');
    expect(api.calls).toHaveLength(1);
  });

  it('discards the response of a superseded request', async () => {
    const old = later(data([entry(1, FIRST.at)]));
    mockApi({ 'GET admin/audit': [old.reply], 'GET admin/audit?cat=system': [data([entry(2, FIRST.at)])] });
    const p = new AuditPage();
    const first = p.load();
    p.setFilter('system');
    await vi.waitFor(() => expect(p.loading).toBe(false));
    old.release();
    await first;
    expect(p.entries.map((e) => e.id)).toEqual([2]);
    expect(p.loading).toBe(false);
  });

  it('shows a failure with “Try again”', async () => {
    mockApi({ 'GET admin/audit': [{ status: 500 }, data()] });
    const p = new AuditPage();
    await p.load();
    const v = auditValues(p, TIME);
    expect(v.aLoad).toMatchObject({ fail: true, text: 'That didn’t work. Please try again.' });
    expect(v).toMatchObject({ aFirst: false, aEmpty: false, aGroups: [], aMore: { show: false } });
    const retry = p.retry();
    // During the new attempt like the first load.
    expect(auditValues(p, TIME)).toMatchObject({ aLoad: { fail: false }, aFirst: true });
    await retry;
    expect(auditValues(p, TIME)).toMatchObject({ aLoad: { fail: false }, aFirst: false });
  });

  it('leaves the counts empty after a failed change', async () => {
    const api = mockApi({
      'GET admin/audit': [data([FIRST], 12)],
      'GET admin/audit?cat=system': [{ status: 500 }],
    });
    const p = new AuditPage();
    await p.load();
    p.setFilter('system');
    await vi.waitFor(() => expect(p.loading).toBe(false));
    const v = auditValues(p, TIME);
    expect(v.aPills.map((o) => o.n)).toEqual([null, null, null, null, null]);
    expect(v).toMatchObject({ aLoad: { fail: true }, aGroups: [], aEmpty: false, aMore: { show: false } });
    expect(api.calls).toHaveLength(2);
  });

  it('names “No connection” on the card without a connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const p = new AuditPage();
    await p.load();
    await p.loadKeep();
    const v = auditValues(p, TIME);
    expect(v.aLoad).toMatchObject({ fail: true, text: 'No connection. Please try again.' });
    expect(v.aKeepLoad).toMatchObject({
      fail: true,
      box: false,
      text: 'No connection. Please try again.',
    });
  });

  it('reloads the account without a role', async () => {
    const refresh = vi.spyOn(session, 'refreshUser').mockResolvedValue(undefined);
    mockApi({ 'GET admin/audit': [{ status: 403, body: { error: { code: 'forbidden' } } }] });
    const p = new AuditPage();
    await p.load();
    expect(refresh).toHaveBeenCalledOnce();
    refresh.mockRestore();
  });

  it('ignores responses after leaving the page', async () => {
    const answer = later(data());
    mockApi({ 'GET admin/audit': [answer.reply] });
    const p = new AuditPage();
    const loading = p.load();
    p.dispose();
    answer.release();
    await loading;
    expect(p.entries).toEqual([]);
  });
});

describe('more entries', () => {
  it('appends the next page and keeps filter and search', async () => {
    vi.useFakeTimers();
    const api = mockApi({
      'GET admin/audit?cat=users&q=max': [data([FIRST], 12)],
      'GET admin/audit?cat=users&q=max&before=12': [data([entry(5, '2026-11-02T08:00:00.000Z')])],
    });
    const p = new AuditPage();
    p.filter = 'users';
    p.setQuery(' max ');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    expect(auditValues(p, TIME).aMore).toMatchObject({
      show: true,
      busy: false,
      idle: true,
      label: 'Load more entries',
    });
    await p.more();
    expect(api.calls.map((c) => c.path)).toEqual([
      'admin/audit?cat=users&q=max',
      'admin/audit?cat=users&q=max&before=12',
    ]);
    expect(p.entries.map((e) => e.id)).toEqual([12, 5]);
    expect(auditValues(p, TIME).aMore.show).toBe(false);
  });

  it('keeps searching with the text of the shown list, even if the input has changed', async () => {
    vi.useFakeTimers();
    const api = mockApi({
      'GET admin/audit?q=max': [data([FIRST], 12)],
      'GET admin/audit?q=max&before=12': [data([])],
    });
    const p = new AuditPage();
    p.setQuery('max');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    p.setQuery('maxi');
    await p.more();
    expect(api.calls.at(-1)?.path).toBe('admin/audit?q=max&before=12');
  });

  it('does not start twice and not on the last page', async () => {
    const answer = later(data([]));
    const api = mockApi({
      'GET admin/audit': [data([FIRST], 12)],
      'GET admin/audit?before=12': [answer.reply],
    });
    const p = new AuditPage();
    await p.load();
    const more = p.more();
    // While loading more: spinner and "Loading …", the button stays.
    expect(auditValues(p, TIME).aMore).toMatchObject({ show: true, busy: true, idle: false, label: 'Loading …' });
    await p.more();
    answer.release();
    await more;
    await p.more();
    expect(api.calls).toHaveLength(2);
  });

  it('keeps the button while the list reloads; a click then loads nothing more', async () => {
    const answer = later(data());
    const api = mockApi({ 'GET admin/audit': [data([FIRST], 12)], 'GET admin/audit?cat=system': [answer.reply] });
    const p = new AuditPage();
    await p.load();
    p.setFilter('system');
    // The container is `aria-busy`, the button only shows its own loading.
    expect(auditValues(p, TIME)).toMatchObject({ aBusyAttr: true, aMore: { show: true, busy: false } });
    auditValues(p, TIME).aMore.onClick();
    answer.release();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit', 'admin/audit?cat=system']);
  });

  it('discards the page if the selection has changed meanwhile', async () => {
    const answer = later(data([entry(5, FIRST.at)]));
    mockApi({
      'GET admin/audit': [data([FIRST], 12)],
      'GET admin/audit?before=12': [answer.reply],
      'GET admin/audit?cat=system': [data([entry(2, FIRST.at)])],
    });
    const p = new AuditPage();
    await p.load();
    const more = p.more();
    p.setFilter('system');
    await vi.waitFor(() => expect(p.loading).toBe(false));
    answer.release();
    await more;
    expect(p.entries.map((e) => e.id)).toEqual([2]);
    expect(p.loadingMore).toBe(false);
  });

  it('reports a failure as a toast and keeps the list', async () => {
    mockApi({ 'GET admin/audit': [data([FIRST], 12)], 'GET admin/audit?before=12': [{ status: 500 }] });
    const p = new AuditPage();
    await p.load();
    await p.more();
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
    expect(p.entries).toHaveLength(1);
    expect(auditValues(p, TIME)).toMatchObject({ aLoad: { fail: false }, aMore: { show: true, busy: false } });
    expect(auditValues(p, TIME).aPills[0]!.n).toBe(7);
  });
});

describe('search', () => {
  it('sends only after the typing pause and only the last text', async () => {
    vi.useFakeTimers();
    const api = mockApi({ 'GET admin/audit': [data()], 'GET admin/audit?q=ma': [data()] });
    const p = new AuditPage();
    await p.load();
    p.setQuery('m');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY - 1);
    p.setQuery('ma ');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY - 1);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit', 'admin/audit?q=ma']);
    expect(auditValues(p, TIME)).toMatchObject({ aQ: 'ma ', aHasQ: true });
  });

  it('sends nothing when only spaces are added', async () => {
    vi.useFakeTimers();
    const api = mockApi({ 'GET admin/audit': [data()] });
    const p = new AuditPage();
    await p.load();
    p.setQuery('  ');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    expect(api.calls).toHaveLength(1);
    expect(auditValues(p, TIME).aHasQ).toBe(true);
  });

  it('takes a pending search along when the filter changes', async () => {
    vi.useFakeTimers();
    const api = mockApi({ 'GET admin/audit?cat=login&q=ma': [data()] });
    const p = new AuditPage();
    p.setQuery('ma');
    p.setFilter('login');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit?cat=login&q=ma']);
  });

  it('“Clear search” takes effect at once', async () => {
    vi.useFakeTimers();
    const api = mockApi({ 'GET admin/audit?q=ma': [data()], 'GET admin/audit': [data()] });
    const p = new AuditPage();
    p.setQuery('ma');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    p.clearQuery();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls.map((c) => c.path)).toEqual(['admin/audit?q=ma', 'admin/audit']);
    expect(p.q).toBe('');
  });

  it('cancels a pending search when clearing', async () => {
    vi.useFakeTimers();
    const api = mockApi({});
    const p = new AuditPage();
    p.setQuery('ma');
    p.clearQuery();
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    expect(api.calls).toHaveLength(0);
  });

  it('sends nothing more after leaving the page', async () => {
    vi.useFakeTimers();
    const api = mockApi({});
    const p = new AuditPage();
    p.setQuery('ma');
    p.dispose();
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
    expect(api.calls).toHaveLength(0);
  });
});

describe('Export', () => {
  it('loads the file via POST, reports the count and then shows the new entry', async () => {
    const api = mockApi({
      'GET admin/audit?cat=users': [
        data([FIRST]),
        data([entry(13, FIRST.at), FIRST], null, { ...COUNTS, all: 8, system: 3 }),
      ],
      'POST admin/audit/export?cat=users': [{ body: 'csv' }],
    });
    const p = new AuditPage();
    p.setFilter('users');
    await vi.waitFor(() => expect(p.counts).not.toBeNull());
    await p.exportCsv('UTC');
    expect(api.calls[1]).toMatchObject({ method: 'POST', headers: { 'X-Requested-With': 'roedy-mail' } });
    const [name, blob] = vi.mocked(downloadBlob).mock.calls[0]!;
    expect(name).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(blob).toBeInstanceOf(Blob);
    expect(ui.toast).toMatchObject({ text: '2 entries exported', error: false });
    await vi.waitFor(() => expect(p.entries).toHaveLength(2));
  });

  it('uses the singular', async () => {
    mockApi({
      'GET admin/audit?cat=settings': [data(), data()],
      'POST admin/audit/export?cat=settings': [{ body: 'csv' }],
    });
    const p = new AuditPage();
    p.setFilter('settings');
    await vi.waitFor(() => expect(p.counts).not.toBeNull());
    await p.exportCsv('UTC');
    expect(ui.toast?.text).toBe('1 entry exported');
  });

  it('waits for a search so that file and count match the list', async () => {
    vi.useFakeTimers();
    const api = mockApi({
      'GET admin/audit': [data()],
      'GET admin/audit?q=ma': [data([FIRST], null, { ...COUNTS, all: 1 }), data()],
      'POST admin/audit/export?q=ma': [{ body: 'csv' }],
    });
    const p = new AuditPage();
    await p.load();
    p.setQuery('ma');
    await p.exportCsv('UTC');
    expect(api.calls.map((c) => `${c.method} ${c.path}`).slice(1, 3)).toEqual([
      'GET admin/audit?q=ma',
      'POST admin/audit/export?q=ma',
    ]);
    expect(ui.toast?.text).toBe('1 entry exported');
    await vi.advanceTimersByTimeAsync(AUDIT_SEARCH_DELAY);
  });

  it('exports nothing if the list cannot be loaded', async () => {
    const api = mockApi({ 'GET admin/audit': [{ status: 500 }, { status: 500 }] });
    const p = new AuditPage();
    await p.load();
    await p.exportCsv('UTC');
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(auditValues(p, TIME).aLoad).not.toBeNull();
  });

  it('reports a failure', async () => {
    mockApi({ 'GET admin/audit': [data()], 'POST admin/audit/export': [{ status: 500 }] });
    const p = new AuditPage();
    await p.load();
    await p.exportCsv('UTC');
    expect(ui.toast).toMatchObject({ error: true });
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('reports a browser that cannot offer the file and shows the export entry', async () => {
    vi.mocked(downloadBlob).mockReturnValueOnce(false);
    const api = mockApi({
      'GET admin/audit': [data(), data([entry(13, FIRST.at), FIRST])],
      'POST admin/audit/export': [{ body: 'csv' }],
    });
    const p = new AuditPage();
    await p.load();
    await p.exportCsv('UTC');
    expect(ui.toast).toMatchObject({ error: true });
    await vi.waitFor(() => expect(p.entries).toHaveLength(2));
    expect(api.calls).toHaveLength(3);
  });

  it('does not start twice', async () => {
    const answer = later({ body: 'csv' });
    const api = mockApi({
      'GET admin/audit': [data(), data()],
      'POST admin/audit/export': [answer.reply],
    });
    const p = new AuditPage();
    await p.load();
    const first = p.exportCsv('UTC');
    await p.exportCsv('UTC');
    answer.release();
    await first;
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('retention', () => {
  it('loads the retention period and names it in the sentence', async () => {
    mockApi({ 'GET admin/audit/retention': [{ body: { days: 365 } }] });
    const p = new AuditPage();
    // Until the first response: no selection, locked, no line, box `aria-busy`.
    const before = auditValues(p, TIME);
    expect(before.aKeepSum).toBe('');
    expect(before.aKeepOpts.map((o) => [o.on, o.dis])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(before.aKeepLoad).toMatchObject({ box: true, busy: true, fail: false });
    await p.loadKeep();
    const v = auditValues(p, TIME);
    expect(v.aKeepOpts.map((o) => [o.days, o.label, o.on, o.dis])).toEqual([
      [30, '30 days', false, false],
      [90, '90 days', false, false],
      [365, '1 year', true, false],
    ]);
    expect(v.aKeepSum).toBe('Entries older than one year are deleted');
    expect(v.aKeepLoad).toMatchObject({ box: true, busy: false, fail: false });
  });

  it('saves at once and reloads the list', async () => {
    const api = mockApi({
      'GET admin/audit/retention': [{ body: { days: 90 } }],
      'PUT admin/audit/retention': [{ body: { days: 30 } }],
      'GET admin/audit': [data()],
    });
    const p = new AuditPage();
    await p.loadKeep();
    await p.setKeep(30);
    expect(api.calls[1]).toMatchObject({ method: 'PUT', body: { days: 30 } });
    expect(auditValues(p, TIME).aKeepSum).toBe('Entries older than 30 days are deleted');
    await vi.waitFor(() => expect(p.counts).not.toBeNull());
  });

  it('reverts the choice on a failure', async () => {
    mockApi({
      'GET admin/audit/retention': [{ body: { days: 90 } }],
      'PUT admin/audit/retention': [{ status: 500 }],
    });
    const p = new AuditPage();
    await p.loadKeep();
    await p.setKeep(30);
    expect(p.keep).toBe(90);
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('sends nothing without a loaded period, for the same value and while saving', async () => {
    const answer = later({ body: { days: 30 } });
    const api = mockApi({
      'GET admin/audit/retention': [{ body: { days: 90 } }],
      'PUT admin/audit/retention': [answer.reply],
      'GET admin/audit': [data()],
    });
    const p = new AuditPage();
    await p.setKeep(30);
    expect(api.calls).toHaveLength(0);
    await p.loadKeep();
    await p.setKeep(90);
    const saving = p.setKeep(30);
    await p.setKeep(365);
    expect(p.keep).toBe(30);
    answer.release();
    await saving;
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('shows a load error with “Try again”', async () => {
    mockApi({ 'GET admin/audit/retention': [{ status: 500 }, { body: { days: 30 } }] });
    const p = new AuditPage();
    await p.loadKeep();
    const failure = auditValues(p, TIME).aKeepLoad;
    expect(failure).toMatchObject({
      box: false,
      fail: true,
      text: 'That didn’t work. Please try again.',
    });
    failure.onRetry();
    // During the new attempt the box again without a selection.
    expect(auditValues(p, TIME).aKeepLoad).toMatchObject({ box: true, busy: true, fail: false });
    await vi.waitFor(() => expect(p.keep).toBe(30));
  });
});
