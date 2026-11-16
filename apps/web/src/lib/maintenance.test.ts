import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BK_RUNNING_WAIT,
  MT_SAVE_DELAY,
  MaintenancePage,
  maintenanceValues,
  storageSize,
  type Backup,
  type BackupsView,
  type MaintenanceContext,
  type MaintenanceInput,
  type MaintenanceMode,
  type StorageView,
} from '#lib/maintenance.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { push } from '#lib/push.svelte.ts';
import { icons } from '#lib/icons.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DEFAULT = m.login_maint_default();
const MB = 1024 * 1024;
/** Text for a backup that is already running. */
const RUNNING = 'A backup is running right now. Try again in a moment.';

const OLD: Backup = { id: 'b1', at: '2026-11-04T00:30:00Z', size: 200 * MB, auto: true };
const NEW: Backup = { id: 'b2', at: '2026-11-06T09:00:00Z', size: 100 * MB, auto: false };

function view(over: Partial<BackupsView> = {}): BackupsView {
  return { backups: [NEW, OLD], auto: true, every: 'daily', keep: 30, next_at: '2026-11-07T09:00:00Z', ...over };
}
const MODE: MaintenanceMode = { on: false, message: null };
const STORAGE: StorageView = {
  database: 148 * MB,
  assets: 0,
  asset_name: null,
  compacted_at: null,
};
const CTX: MaintenanceContext = { scrollTo: vi.fn() };
const INPUT: MaintenanceInput = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', dateFmt: 'de' };

/** Responses of the first load. */
function routes(extra: Parameters<typeof mockApi>[0] = {}): Parameters<typeof mockApi>[0] {
  return {
    'GET admin/maintenance': [{ body: MODE }],
    'GET admin/backups': [{ body: view() }],
    'GET admin/storage': [{ body: STORAGE }],
    ...extra,
  };
}

async function loaded(extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi(routes(extra));
  const p = new MaintenancePage();
  await p.load();
  return { api, p, v: () => maintenanceValues(p, INPUT, CTX) };
}

function written(api: ReturnType<typeof mockApi>, method = 'PUT') {
  return api.calls.filter((c) => c.method === method);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  session.config = { maintenance: { on: false, message: null } } as PublicConfig;
  prefs.values.gConfirm = true;
});

afterEach(async () => {
  ui.toasts.discard();
  ui.confirmCancel();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  session.config = null;
});

describe('storageSize', () => {
  it('names sizes in KB, MB and GB', () => {
    expect(storageSize(0)).toBe('0 MB');
    expect(storageSize(2048)).toBe('2 KB');
    expect(storageSize(100)).toBe('1 KB');
    expect(storageSize(148 * MB)).toBe('148 MB');
    expect(storageSize(1229 * MB)).toBe('1.2 GB');
  });
});

describe('loading', () => {
  it('reads all three states, without a notice of its own the default text is in the field', async () => {
    const { p, v } = await loaded();
    expect(p.status).toBe('ready');
    expect(v().maintMsg).toBe(DEFAULT);
    expect(v().maintCustom).toBe(false);
    expect(v().maintStatus).toBe(m.maintenance_status_off());
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2', 'b1']);
    expect(v().mtLoad.ok).toBe(true);
  });

  it('shows the saved notice and the active mode', async () => {
    const { p, v } = await loaded({ 'GET admin/maintenance': [{ body: { on: true, message: 'Until 6 pm' } }] });
    expect(p.on).toBe(true);
    expect(v().maintMsg).toBe('Until 6 pm');
    expect(v().maintCustom).toBe(true);
    expect(v().maintStatus).toBe(m.maintenance_status_on());
    expect(session.config?.maintenance).toEqual({ on: true, message: 'Until 6 pm' });
  });

  it('shows the skeleton only after 150 ms and only on the first load', async () => {
    mockApi(routes({ 'GET admin/storage': [() => new Promise(() => {})] }));
    const p = new MaintenancePage();
    void p.load();
    expect(maintenanceValues(p, INPUT, CTX).skSet).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(maintenanceValues(p, INPUT, CTX).skSet).toBe(true);
  });

  it('shows the card if the first load fails, and loads again', async () => {
    const api = mockApi(
      routes({
        'GET admin/backups': [{ status: 500, body: { error: 'internal' } }, { body: view() }],
        'GET admin/maintenance': [{ body: MODE }, { body: MODE }],
        'GET admin/storage': [{ body: STORAGE }, { body: STORAGE }],
      }),
    );
    const p = new MaintenancePage();
    await p.load();
    const v = maintenanceValues(p, INPUT, CTX);
    expect(v.mtLoad.fail).toBe(true);
    expect(v.mtLoad.text).toBe(m.error_act());
    await p.retry();
    expect(p.status).toBe('ready');
    expect(api.calls).toHaveLength(6);
  });

  it('checks the account after 403', async () => {
    mockApi(routes({ 'GET admin/backups': [{ status: 403, body: { error: 'forbidden' } }] }));
    const refresh = vi.spyOn(session, 'refreshUser').mockResolvedValue();
    await new MaintenancePage().load();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('maintenance mode', () => {
  it('asks before turning on and updates the notice bar', async () => {
    const { api, p, v } = await loaded({
      'PUT admin/maintenance': [{ body: { on: true, message: null } }],
    });
    v().tgMaint.onClick();
    expect(ui.confirm?.title).toBe(m.maintenance_on_title());
    expect(written(api)).toHaveLength(0);
    ui.confirm?.run();
    expect(p.on).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api)[0]?.body).toEqual({ on: true });
    expect(session.config?.maintenance.on).toBe(true);
    expect(ui.toast?.text).toBe(m.maintenance_on_done());
  });

  it('turns off without confirmation', async () => {
    const { api, p, v } = await loaded({
      'GET admin/maintenance': [{ body: { on: true, message: 'Notice' } }],
      'PUT admin/maintenance': [{ body: { on: false, message: 'Notice' } }],
    });
    v().tgMaint.onClick();
    expect(ui.confirm).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api)[0]?.body).toEqual({ on: false });
    expect(p.on).toBe(false);
    expect(session.config?.maintenance).toEqual({ on: false, message: null });
    expect(ui.toast?.text).toBe(m.maintenance_off_done());
  });

  it('reverts the switch if saving fails', async () => {
    const { p, v } = await loaded({ 'PUT admin/maintenance': [{ status: 500, body: { error: 'internal' } }] });
    v().tgMaint.onClick();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.on).toBe(false);
    expect(ui.toast?.error).toBe(true);
    expect(session.config?.maintenance.on).toBe(false);
  });

  it('collects notice inputs into one PUT and does not overwrite the field', async () => {
    const { api, v } = await loaded({
      'PUT admin/maintenance': [{ body: { on: false, message: null } }],
    });
    v().onMaintMsg('B');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY - 1);
    v().onMaintMsg('');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    expect(written(api).map((c) => c.body)).toEqual([{ message: '' }]);
    expect(v().maintMsg).toBe('');
    expect(v().maintCustom).toBe(true);
  });

  it('sends null for the default text', async () => {
    const { api, v } = await loaded({
      'GET admin/maintenance': [{ body: { on: false, message: 'Eigen' } }],
      'PUT admin/maintenance': [{ body: MODE }],
    });
    v().maintReset();
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    expect(written(api)[0]?.body).toEqual({ message: null });
    expect(v().maintMsg).toBe(DEFAULT);
    expect(v().maintCustom).toBe(false);
  });

  it('keeps the notice in the field if saving fails', async () => {
    const { v } = await loaded({ 'PUT admin/maintenance': [{ status: 422, body: { error: 'invalid' } }] });
    v().onMaintMsg('Too long');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    expect(v().maintMsg).toBe('Too long');
    expect(ui.toast?.error).toBe(true);
  });

  it('includes the waiting notice when turning on', async () => {
    const { api, v } = await loaded({
      'PUT admin/maintenance': [{ body: { on: true, message: 'New' } }],
    });
    v().onMaintMsg('New');
    v().tgMaint.onClick();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api).map((c) => c.body)).toEqual([{ message: 'New', on: true }]);
    expect(session.config?.maintenance).toEqual({ on: true, message: 'New' });
  });

  it('resends a notice with the switch after a network error', async () => {
    const { api, v } = await loaded({
      'PUT admin/maintenance': [{ status: 500, body: { error: 'internal' } }, { body: { on: true, message: 'New' } }],
    });
    v().onMaintMsg('New');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    v().tgMaint.onClick();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api).map((c) => c.body)).toEqual([{ message: 'New' }, { message: 'New', on: true }]);
  });

  it('does not resend an invalid notice, the switch stays usable', async () => {
    const { api, v } = await loaded({
      'PUT admin/maintenance': [{ status: 422, body: { error: 'invalid' } }, { body: { on: true, message: null } }],
    });
    v().onMaintMsg('Invalid');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    v().tgMaint.onClick();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api).map((c) => c.body)).toEqual([{ message: 'Invalid' }, { on: true }]);
  });

  it('sends a waiting notice immediately when leaving the page', async () => {
    const { api, p, v } = await loaded({ 'PUT admin/maintenance': [{ body: MODE }] });
    v().onMaintMsg('New');
    p.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api)).toHaveLength(1);
  });
});

describe('backups', () => {
  it('builds the rows', async () => {
    const { v } = await loaded();
    const [manual, auto] = v().bkRows;
    expect(manual).toMatchObject({
      title: '06.11.2026, 10:00',
      sub: `100 MB · ${m.maintenance_bk_manual()}`,
      sep: false,
      icon: 'ti-hand-click',
      href: '/api/v1/admin/backups/b2/download',
    });
    expect(auto).toMatchObject({ sub: `200 MB · ${m.maintenance_bk_auto()}`, sep: true, icon: 'ti-clock' });
    expect(v().bkSum).toBe(m.maintenance_bk_last({ ago: m.ago_hours({ n: 3 }) }));
    expect(v().bkNext).toBe(m.maintenance_bk_next({ when: 'tomorrow, 10:00' }));
    expect(v().bkEmpty).toBe(false);
  });

  it('names the empty and the switched-off state', async () => {
    const { v } = await loaded({
      'GET admin/backups': [{ body: view({ backups: [], auto: false, next_at: null }) }],
    });
    expect(v().bkEmpty).toBe(true);
    expect(v().bkSum).toBe(m.maintenance_bk_none());
    expect(v().bkNext).toBe(m.maintenance_bk_off());
    expect(v().stRows[1]).toMatchObject({ sub: m.maintenance_st_backups_none(), size: '0 MB' });
  });

  it('offers the download as a link, the toast announces it', async () => {
    const { v } = await loaded();
    v().bkRows[0]?.onDownload();
    expect(ui.toast?.text).toBe(m.maintenance_bk_download());
  });

  it('creates a backup, the button runs until the response', async () => {
    let answer: (reply: { status: number; body: Backup }) => void = () => {};
    const row: Backup = { id: 'b3', at: '2026-11-06T12:00:00Z', size: MB, auto: false };
    const { v } = await loaded({
      'POST admin/backups': [() => new Promise((resolve) => (answer = resolve))],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkB).toMatchObject({ busy: true, icon: 'ti-loader-2', label: m.maintenance_busy(), rot: 720 });
    v().bkNow();
    answer({ status: 201, body: row });
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkB).toMatchObject({ busy: false, icon: 'ti-database-plus', label: m.maintenance_bk_now() });
    expect(v().bkRows.map((r) => r.id)).toEqual(['b3', 'b2', 'b1']);
    expect(ui.toast?.text).toBe(m.maintenance_bk_created());
  });

  it('updates the next date after backing up', async () => {
    const row: Backup = { id: 'b3', at: '2026-11-06T12:00:00Z', size: MB, auto: false };
    const { api, v } = await loaded({
      'POST admin/backups': [{ status: 201, body: row }],
      'GET admin/backups': [
        { body: view() },
        { body: view({ backups: [row, NEW, OLD], next_at: '2026-11-07T12:00:00Z' }) },
      ],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls.filter((c) => c.path === 'admin/backups' && c.method === 'GET')).toHaveLength(2);
    expect(v().bkNext).toBe(m.maintenance_bk_next({ when: 'tomorrow, 13:00' }));
  });

  it('reports a failed run with its own text', async () => {
    const { v } = await loaded({ 'POST admin/backups': [{ status: 500, body: { error: 'internal' } }] });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({
      text: 'The backup failed. Check the server’s storage space and log.',
      error: true,
    });
    expect(v().bkB.busy).toBe(false);
  });

  it('reports a rejected run (403) with the generic text and checks the account', async () => {
    const { api, v } = await loaded({
      'POST admin/backups': [{ status: 403, body: { error: 'forbidden' } }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    expect(api.calls.some((c) => c.path === 'auth/me')).toBe(true);
    expect(v().bkB.busy).toBe(false);
  });

  it('reports a run with 429 with the waiting time', async () => {
    const { v } = await loaded({
      'POST admin/backups': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: m.error_limit({ wait: '30 seconds' }), error: true });
  });

  it('reports a run without a connection with the offline text', async () => {
    const { v } = await loaded();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: m.error_offline(), error: true });
    expect(v().bkB.busy).toBe(false);
  });

  it('shows the running button on backup_running and checks again afterwards', async () => {
    const { api, v } = await loaded({
      'POST admin/backups': [{ status: 409, body: { error: 'backup_running' } }],
      'GET admin/backups': [{ body: view() }, { body: view() }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toBeNull();
    expect(v().bkB.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(BK_RUNNING_WAIT);
    expect(v().bkB.busy).toBe(false);
    expect(api.calls.filter((c) => c.path === 'admin/backups' && c.method === 'GET')).toHaveLength(2);
  });

  it('names a backup that a response in between already knows only once', async () => {
    const row: Backup = { id: 'b3', at: '2026-11-06T12:00:00Z', size: MB, auto: false };
    let answer: (reply: { status: number; body: Backup }) => void = () => {};
    const { p, v } = await loaded({
      'POST admin/backups': [() => new Promise((resolve) => (answer = resolve))],
      'GET admin/maintenance': [{ body: MODE }, { body: MODE }],
      'GET admin/backups': [
        { body: view() },
        { body: view({ backups: [row, NEW, OLD] }) },
        { body: view({ backups: [row, NEW, OLD] }) },
      ],
      'GET admin/storage': [{ body: STORAGE }, { body: STORAGE }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    await p.load();
    answer({ status: 201, body: row });
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('discards a list that is older than the saved schedule', async () => {
    let answer: (reply: { body: BackupsView }) => void = () => {};
    const { v } = await loaded({
      'DELETE admin/backups/b1': [{ status: 204 }],
      'GET admin/backups': [{ body: view() }, () => new Promise((resolve) => (answer = resolve))],
      'PUT admin/backups/schedule': [{ body: view({ keep: 7 }) }],
    });
    v().bkRows[1]?.onRemove();
    await vi.advanceTimersByTimeAsync(5000);
    v().bkKeepOpts[0]?.onClick();
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    answer({ body: view({ keep: 30 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkKeepOpts[0]?.on).toBe(true);
  });

  it('always asks before restoring, with the word', async () => {
    const { api, v } = await loaded();
    prefs.values.gConfirm = false;
    v().bkRows[1]?.onRestore();
    expect(ui.confirm).toMatchObject({
      title: m.maintenance_bk_restore_title(),
      text:
        'All data will be reset to its state as of 04.11.2026, 01:30. Any later changes will be lost. ' +
        'All devices will be signed out. You’ll stay signed in if your account is active in the backup.',
      word: 'RESTORE',
      danger: true,
      force: true,
    });
    expect(written(api, 'POST')).toHaveLength(0);
  });

  it('reports when the restore fails because of a run', async () => {
    const { v } = await loaded({
      'POST admin/backups/b1/restore': [{ status: 409, body: { error: 'backup_running' } }],
      'GET admin/backups': [{ body: view() }, { body: view() }],
    });
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: RUNNING, error: true });
    expect(v().bkB.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(BK_RUNNING_WAIT);
    expect(v().bkB.busy).toBe(false);
  });

  it('reports when the restore hits the running button', async () => {
    const { api, v } = await loaded({ 'POST admin/backups': [() => new Promise(() => {})] });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: RUNNING, error: true });
    expect(written(api, 'POST').map((c) => c.path)).toEqual(['admin/backups']);
  });

  it('reports a second restore during a running one with the generic text', async () => {
    const { api, v } = await loaded({ 'POST admin/backups/b1/restore': [() => new Promise(() => {})] });
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkB.busy).toBe(true);
    v().bkRows[0]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    expect(written(api, 'POST').map((c) => c.path)).toEqual(['admin/backups/b1/restore']);
  });

  it('reports a restore while a foreign backup is running (backup_running) with the running text', async () => {
    const { v } = await loaded({
      'POST admin/backups': [{ status: 409, body: { error: 'backup_running' } }],
      'GET admin/backups': [{ body: view() }, { body: view() }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkB.busy).toBe(true);
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: RUNNING, error: true });
  });

  it('removes a row whose file is missing on restore', async () => {
    const { v } = await loaded({
      'POST admin/backups/b1/restore': [{ status: 404, body: { error: 'not_found' } }],
      'GET admin/backups': [{ body: view() }, { body: view({ backups: [NEW] }) }],
    });
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2']);
    expect(ui.toast?.error).toBe(true);
  });

  it('does not reload the page after the restore if the role is missing', async () => {
    const { api, v } = await loaded({ 'POST admin/backups/b1/restore': [{ body: view() }] });
    vi.spyOn(session, 'load').mockResolvedValue();
    vi.spyOn(session, 'authed', 'get').mockReturnValue(true);
    vi.spyOn(session, 'isAdmin', 'get').mockReturnValue(false);
    vi.spyOn(prefs, 'load').mockResolvedValue();
    vi.spyOn(accounts, 'load').mockResolvedValue();
    vi.spyOn(push, 'resume').mockResolvedValue();
    const before = api.calls.length;
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls).toHaveLength(before + 1);
    expect(ui.toast?.text).toBe(m.maintenance_bk_restored());
  });

  it('keeps the button running if a deletion fails on its own backup', async () => {
    const { v } = await loaded({
      'POST admin/backups': [() => new Promise(() => {})],
      'DELETE admin/backups/b1': [{ status: 409, body: { error: 'backup_running' } }],
    });
    v().bkNow();
    await vi.advanceTimersByTimeAsync(0);
    v().bkRows[1]?.onRemove();
    await vi.advanceTimersByTimeAsync(5000 + BK_RUNNING_WAIT);
    expect(v().bkB.busy).toBe(true);
  });

  it('reloads everything after the restore', async () => {
    const restored = view({ backups: [OLD] });
    const { v } = await loaded({
      'POST admin/backups/b1/restore': [{ body: restored }],
      'GET admin/maintenance': [{ body: MODE }, { body: { on: true, message: 'Alt' } }],
      'GET admin/backups': [{ body: view() }, { body: restored }],
      'GET admin/storage': [{ body: STORAGE }, { body: { ...STORAGE, database: 90 * MB } }],
    });
    const load = vi.spyOn(session, 'load').mockResolvedValue();
    vi.spyOn(session, 'authed', 'get').mockReturnValue(true);
    vi.spyOn(session, 'isAdmin', 'get').mockReturnValue(true);
    const pref = vi.spyOn(prefs, 'load').mockResolvedValue();
    const list = vi.spyOn(accounts, 'load').mockResolvedValue();
    const resume = vi.spyOn(push, 'resume').mockResolvedValue();
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast?.text).toBe(m.maintenance_bk_restored());
    expect(load).toHaveBeenCalledOnce();
    expect(pref).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(v().bkRows.map((r) => r.id)).toEqual(['b1']);
    expect(v().maintMsg).toBe('Alt');
    expect(v().bkB.busy).toBe(false);
  });

  it('loads nothing more after the restore if the session ended', async () => {
    const { api, v } = await loaded({ 'POST admin/backups/b1/restore': [{ body: view() }] });
    vi.spyOn(session, 'load').mockResolvedValue();
    vi.spyOn(session, 'authed', 'get').mockReturnValue(false);
    const pref = vi.spyOn(prefs, 'load').mockResolvedValue();
    const before = api.calls.length;
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(pref).not.toHaveBeenCalled();
    expect(api.calls).toHaveLength(before + 1);
  });

  it.each([
    [422, 'backup_invalid', 'This backup is corrupted and can’t be restored.'],
    [409, 'backup_newer', 'This backup is from a newer version and can only be restored after an update.'],
    [
      409,
      'backup_other_key',
      'This backup belongs to an instance with a different key (secret.key). Without that key, multi-factor authentication and email accounts would be unusable.',
    ],
    [500, 'internal', 'That didn’t work. Please try again.'],
  ])('reports %i %s on restore with its own text', async (status, code, text) => {
    const { api, v } = await loaded({ 'POST admin/backups/b1/restore': [{ status, body: { error: code } }] });
    const before = api.calls.length;
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text, error: true });
    expect(v().bkB.busy).toBe(false);
    // No reload after a failed restore.
    expect(api.calls).toHaveLength(before + 1);
  });

  it('reports a restore without a connection with the offline text', async () => {
    const { v } = await loaded();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast).toMatchObject({ text: m.error_offline(), error: true });
  });

  it('sends waiting changes before the restore', async () => {
    const { api, v } = await loaded({
      'PUT admin/backups/schedule': [{ body: view({ keep: 7 }) }],
      'POST admin/backups/b1/restore': [{ status: 500, body: { error: 'internal' } }],
    });
    v().bkKeepOpts[0]?.onClick();
    v().bkRows[1]?.onRestore();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    const paths = api.calls.filter((c) => c.method !== 'GET').map((c) => c.path);
    expect(paths).toEqual(['admin/backups/schedule', 'admin/backups/b1/restore']);
  });

  it('deletes only after the toast expires and hides the row immediately', async () => {
    const { api, v } = await loaded({
      'DELETE admin/backups/b1': [{ status: 204 }],
      'GET admin/backups': [{ body: view() }, { body: view({ backups: [NEW] }) }],
    });
    v().bkRows[1]?.onRemove();
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2']);
    expect(v().stRows[1]).toMatchObject({ sub: m.maintenance_st_backups_one(), size: '100 MB' });
    expect(ui.toast).toMatchObject({ text: m.maintenance_bk_deleted(), undo: true });
    expect(written(api, 'DELETE')).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(written(api, 'DELETE')).toHaveLength(1);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2']);
  });

  it('brings the row back with undo, without sending', async () => {
    const { api, v } = await loaded();
    v().bkRows[1]?.onRemove();
    ui.toasts.undo();
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2', 'b1']);
    await vi.runAllTimersAsync();
    expect(written(api, 'DELETE')).toHaveLength(0);
  });

  it('a response in between does not bring the hidden row back', async () => {
    const { p, v } = await loaded({
      'GET admin/maintenance': [{ body: MODE }, { body: MODE }],
      'GET admin/backups': [{ body: view() }, { body: view() }],
      'GET admin/storage': [{ body: STORAGE }, { body: STORAGE }],
    });
    v().bkRows[1]?.onRemove();
    await p.load();
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2']);
  });

  it('reverts the deletion if it fails', async () => {
    const { v } = await loaded({ 'DELETE admin/backups/b1': [{ status: 500, body: { error: 'internal' } }] });
    v().bkRows[1]?.onRemove();
    await vi.advanceTimersByTimeAsync(5000);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2', 'b1']);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });

  it('reverts the deletion on backup_running and shows the button', async () => {
    const { v } = await loaded({
      'DELETE admin/backups/b1': [{ status: 409, body: { error: 'backup_running' } }],
      'GET admin/backups': [{ body: view() }, { body: view() }],
    });
    v().bkRows[1]?.onRemove();
    await vi.advanceTimersByTimeAsync(5000);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2', 'b1']);
    expect(ui.toast).toMatchObject({ text: RUNNING, error: true });
    expect(v().bkB.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(BK_RUNNING_WAIT);
    expect(v().bkB.busy).toBe(false);
  });

  it('takes an already missing file as deleted', async () => {
    const { v } = await loaded({
      'DELETE admin/backups/b1': [{ status: 404, body: { error: 'not_found' } }],
      'GET admin/backups': [{ body: view() }, { body: view({ backups: [NEW] }) }],
    });
    v().bkRows[1]?.onRemove();
    await vi.advanceTimersByTimeAsync(5000);
    expect(v().bkRows.map((r) => r.id)).toEqual(['b2']);
    expect(ui.toast?.error).not.toBe(true);
  });

  it('sends the deletion immediately when leaving the page', async () => {
    const { api, p, v } = await loaded({
      'DELETE admin/backups/b1': [{ status: 204 }],
    });
    v().bkRows[1]?.onRemove();
    p.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(written(api, 'DELETE')).toHaveLength(1);
  });

  it('sends schedule and retention collected, applies immediately', async () => {
    const { api, v } = await loaded({
      'PUT admin/backups/schedule': [{ body: view({ auto: false, keep: 7, next_at: null }) }],
    });
    v().tgBkAuto.onClick();
    v().bkKeepOpts[0]?.onClick();
    expect(v().tgBkAuto.on).toBe(false);
    expect(v().bkKeepOpts[0]?.on).toBe(true);
    expect(v().bkNext).toBe(m.maintenance_bk_off());
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    expect(written(api)[0]?.body).toEqual({ auto: false, keep: 7 });
  });

  it('falls back to the saved schedule with an error toast', async () => {
    const { v } = await loaded({ 'PUT admin/backups/schedule': [{ status: 500, body: { error: 'internal' } }] });
    v().bkEveryOpts[1]?.onClick();
    expect(v().bkEveryOpts[1]?.on).toBe(true);
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    expect(v().bkEveryOpts[0]?.on).toBe(true);
    expect(ui.toast?.error).toBe(true);
  });
});

describe('storage', () => {
  it('names database, backups and logo', async () => {
    const { v } = await loaded();
    expect(v().stRows).toMatchObject([
      { icon: 'ti-database', label: m.maintenance_st_db(), size: '148 MB', sep: false },
      { icon: 'ti-archive', sub: m.maintenance_st_backups_many({ n: 2 }), size: '300 MB', sep: true },
      { icon: 'ti-photo', sub: m.maintenance_st_logo_none(), size: '0 KB', sep: true },
    ]);
    expect(v().stDesc).toBe(m.maintenance_st_desc());
  });

  it('names the custom logo', async () => {
    const { v } = await loaded({
      'GET admin/storage': [{ body: { ...STORAGE, assets: 48 * 1024, asset_name: 'logo.svg' } }],
    });
    expect(v().stRows[2]).toMatchObject({ sub: 'logo.svg', size: '48 KB' });
  });

  it('compacts after confirmation', async () => {
    const { api, v } = await loaded({
      'POST admin/storage/compact': [
        { body: { ...STORAGE, database: 100 * MB, compacted_at: '2026-11-06T12:00:00Z' } },
      ],
    });
    v().stCompact();
    expect(ui.confirm?.title).toBe(m.maintenance_st_compact_title());
    expect(written(api, 'POST')).toHaveLength(0);
    ui.confirm?.run();
    expect(v().stB).toMatchObject({ busy: true, icon: 'ti-loader-2', rot: 720 });
    await vi.advanceTimersByTimeAsync(0);
    expect(v().stB.busy).toBe(false);
    expect(v().stRows[0]?.size).toBe('100 MB');
    expect(v().stDesc).toBe(`${m.maintenance_st_desc()} ${m.maintenance_st_last({ ago: m.ago_now() })}`);
    expect(ui.toast?.text).toBe(m.maintenance_st_compacted());
  });

  it('reports an error while compacting', async () => {
    const { v } = await loaded({ 'POST admin/storage/compact': [{ status: 500, body: { error: 'internal' } }] });
    v().stCompact();
    ui.confirm?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.toast?.error).toBe(true);
    expect(v().stB.busy).toBe(false);
  });
});

describe('tabs and icons', () => {
  it('jumps to the sections', async () => {
    const { v } = await loaded();
    v().mtTabs[1]?.onClick();
    expect(CTX.scrollTo).toHaveBeenCalledWith('backups');
  });

  it('uses only icons from the registry', async () => {
    const { v } = await loaded();
    const all = [...v().bkRows.map((r) => r.icon), ...v().stRows.map((r) => r.icon), v().bkB.icon, v().stB.icon];
    for (const icon of all) expect(icons[icon]).toBeDefined();
  });
});
