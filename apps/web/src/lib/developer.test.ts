import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debugBarValues, developerValues, logText, LOG_ROWS, visibleLog } from '#lib/developer.ts';
import type { ErrorEnv } from '#lib/errors.ts';
import { devLog, type LogEntry } from '#lib/state/devlog.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

const ENV: ErrorEnv = {
  version: '0.7.0',
  build: 'abc1234',
  mobile: false,
  width: 1440.4,
  height: 899.6,
  path: '/admin/developer',
  browser: 'Firefox',
  timeZone: 'Europe/Berlin',
  language: 'de',
  region: 'Germany',
};

function ctx() {
  return { scrollTo: vi.fn(), openError: vi.fn(), logout: vi.fn() };
}

const values = (c = ctx()) => developerValues({ env: ENV, appName: 'Roedy Mail' }, c);

const entry = (level: LogEntry['level'], msg: string, id = 1): LogEntry => ({
  id,
  t: new Date(2026, 10, 6, 9, 5, 7).getTime(),
  level,
  msg,
});

const ALL = [entry('debug', 'd', 4), entry('info', 'i', 3), entry('warning', 'w', 2), entry('error', 'f', 1)];

beforeEach(() => {
  prefs.values.devLevel = 'info';
  prefs.values.devDebug = false;
});

afterEach(() => {
  devLog.clear();
  network.simulated = false;
  prefs.values.gConfirm = true;
  ui.confirm = null;
  ui.toasts.discard();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('visibleLog', () => {
  it.each([
    ['error', ['f']],
    ['warning', ['w', 'f']],
    ['info', ['i', 'w', 'f']],
    ['debug', ['d', 'i', 'w', 'f']],
  ] as const)('shows only this level and more important ones for %s', (level, msgs) => {
    expect(visibleLog(ALL, level).map((e) => e.msg)).toEqual(msgs);
  });
});

describe('logText', () => {
  it('writes time, level and message per row', () => {
    expect(logText([entry('error', 'Broken'), entry('info', 'Fine')])).toBe(
      '09:05:07 [Error] Broken\n09:05:07 [Info] Fine',
    );
  });

  it('names an empty log “(empty)”', () => {
    expect(logText([])).toBe('(empty)');
  });
});

describe('developerValues', () => {
  it('leads the tabs to their sections', () => {
    const c = ctx();
    const v = values(c);
    expect(v.devTabs.map((t) => t.label)).toEqual(['Diagnostics', 'Log', 'Test', 'Environment']);
    v.devTabs.forEach((t) => t.onClick());
    expect(c.scrollTo.mock.calls.flat()).toEqual(['diag', 'log', 'test', 'env']);
  });

  it('toggles debug mode in the settings', () => {
    const set = vi.spyOn(prefs, 'set').mockImplementation(() => {});
    expect(values().tgDebug.on).toBe(false);
    values().tgDebug.onClick();
    expect(set).toHaveBeenCalledWith({ devDebug: true });
    prefs.values.devDebug = true;
    expect(values().tgDebug.on).toBe(true);
    values().tgDebug.onClick();
    expect(set).toHaveBeenLastCalledWith({ devDebug: false });
  });

  it('chooses the log level in the settings', () => {
    const set = vi.spyOn(prefs, 'set').mockImplementation(() => {});
    const opts = values().devLevelOpts;
    expect(opts.map((o) => [o.label, o.on])).toEqual([
      ['Error', false],
      ['Warning', false],
      ['Info', true],
      ['Debug', false],
    ]);
    opts[0]?.onClick();
    expect(set).toHaveBeenCalledWith({ devLevel: 'error' });
  });

  it('starts and ends the offline simulation', () => {
    expect(values().tgOffline.on).toBe(false);
    values().tgOffline.onClick();
    expect(network.simulated).toBe(true);
    expect(values().tgOffline.on).toBe(true);
    values().tgOffline.onClick();
    expect(network.simulated).toBe(false);
  });

  it('shows the rows of the level with colour and counts them', () => {
    devLog.entries = ALL;
    const v = values();
    expect(v.devLogRows.map((r) => [r.lv, r.msg, r.color])).toEqual([
      ['Info', 'i', 'var(--fg)'],
      ['Warning', 'w', 'var(--deep)'],
      ['Error', 'f', 'var(--danger)'],
    ]);
    expect(v.devLogRows[0]?.time).toBe('09:05:07');
    expect(v.devLogCount).toBe('3 entries in this session');
    expect(v.devLogEmpty).toBe(false);
  });

  it('dims debug', () => {
    devLog.entries = [entry('debug', 'd')];
    prefs.values.devLevel = 'debug';
    expect(values().devLogRows[0]?.color).toBe('var(--mfg)');
  });

  it('uses the singular for one entry and treats none as empty', () => {
    devLog.entries = [entry('error', 'f')];
    expect(values().devLogCount).toBe('1 entry in this session');
    devLog.entries = [entry('debug', 'd')];
    const v = values();
    expect(v.devLogCount).toBe('0 entries in this session');
    expect(v.devLogEmpty).toBe(true);
    expect(v.devLogRows).toEqual([]);
  });

  it('shows at most 60 rows, but counts and copies all', async () => {
    const writeText = vi.fn((text: string) => Promise.resolve(void text));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    devLog.entries = Array.from({ length: LOG_ROWS + 10 }, (_, i) => entry('info', `e${i}`, i));
    const v = values();
    expect(v.devLogRows).toHaveLength(LOG_ROWS);
    expect(v.devLogCount).toBe('70 entries in this session');
    v.devLogCopy();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Log copied'));
    expect(writeText.mock.calls[0]?.[0].split('\n')).toHaveLength(70);
  });

  it('copies only the entries of the chosen level', async () => {
    const writeText = vi.fn((text: string) => Promise.resolve(void text));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    devLog.entries = ALL;
    prefs.values.devLevel = 'error';
    values().devLogCopy();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0]).toBe('09:05:07 [Error] f');
  });

  it('reports nothing if copying fails', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    values().copyEnv();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await Promise.resolve();
    expect(ui.toast?.text).not.toBe('Environment copied');
  });

  it('clears the log', () => {
    devLog.entries = ALL;
    values().devLogClear();
    expect(devLog.entries).toEqual([]);
  });

  it('opens the error pages with their code', () => {
    const c = ctx();
    const buttons = values(c).errBtns;
    expect(buttons.map((b) => [b.code, b.label])).toEqual([
      ['404', 'Not found'],
      ['403', 'Access denied'],
      ['500', 'Server error'],
      ['Offline', 'No connection'],
    ]);
    buttons.forEach((b) => b.onClick());
    expect(c.openError.mock.calls.flat()).toEqual(['404', '403', '500', 'offline']);
  });

  it('asks about the session expiry without cancel, also without `gConfirm`, and then signs out', () => {
    prefs.values.gConfirm = false;
    const c = ctx();
    values(c).simExpire();
    expect(ui.confirm).toMatchObject({
      title: 'Session expired',
      icon: 'ti-clock-off',
      ok: 'Sign in again',
      noCancel: true,
      force: true,
    });
    expect(c.logout).not.toHaveBeenCalled();
    ui.confirmOk();
    expect(c.logout).toHaveBeenCalled();
  });

  it('logs the test error and reports it', () => {
    values().simError();
    expect(ui.toast?.text).toBe('Error logged');
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([
      ['info', 'Notice: Error logged'],
      ['error', 'Test error: unhandled exception'],
    ]);
  });

  it('lists the environment and copies it with the name of the app', async () => {
    const writeText = vi.fn((text: string) => Promise.resolve(void text));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const v = values();
    expect(v.envRows.map((r) => r.k)).toEqual([
      'Version',
      'Layout',
      'Screen',
      'View',
      'Browser',
      'Time zone',
      'Language',
    ]);
    expect(v.envRows.map((r) => r.sep)).toEqual([false, true, true, true, true, true, true]);
    expect(v.envRows[0]?.v).toBe('0.7.0 · Build abc1234');
    expect(v.envRows[2]?.v).toBe('1440 × 900 px');
    expect(v.envRows[6]?.v).toBe('DE · Germany');
    v.copyEnv();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Environment copied'));
    expect(writeText.mock.calls[0]?.[0].split('\n').slice(0, 2)).toEqual([
      'Roedy Mail',
      'Version: 0.7.0 · Build abc1234',
    ]);
  });
});

describe('debugBarValues', () => {
  it('shows layout, window size and view, at the bottom on desktop', () => {
    expect(debugBarValues(ENV)).toEqual({ dbgText: 'Desktop · 1440×900 · /admin/developer', dbgB: '18px' });
  });

  it('sits above the tab bar on mobile', () => {
    expect(debugBarValues({ ...ENV, mobile: true })).toMatchObject({
      dbgText: 'Narrow · 1440×900 · /admin/developer',
      dbgB: '90px',
    });
  });

  it('leaves out a token in the address', () => {
    const { dbgText } = debugBarValues({ ...ENV, path: '/password/reset/secret' });
    expect(dbgText).not.toContain('secret');
    expect(dbgText).toContain('/password/reset/…');
  });
});
