/**
 * Values of the Administration › Developer page and the debug bar. The page is a
 * pure browser diagnosis without a backend; the server log level stays
 * `ROEDY_LOG`. The log lives in `#lib/state/devlog.svelte.ts`, the offline
 * simulation in `#lib/state/network.svelte.ts`.
 */
import type { SegOption } from '#lib/appearance.ts';
import { copyText } from '#lib/clipboard.svelte.ts';
import { envRows, envText, layoutOf, type ErrorCode, type ErrorEnv } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import { redactPath } from '#lib/routes.ts';
import { devLog, LOG_LEVELS, type LogEntry, type LogLevel } from '#lib/state/devlog.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export type DevSection = 'diag' | 'log' | 'test' | 'env';

/** Label and colour per level (`LV_C`). */
const LEVELS: Record<LogLevel, { label: () => string; color: string }> = {
  error: { label: m.dev_level_error, color: 'var(--danger)' },
  warning: { label: m.dev_level_warning, color: 'var(--deep)' },
  info: { label: m.dev_level_info, color: 'var(--fg)' },
  debug: { label: m.dev_level_debug, color: 'var(--mfg)' },
};

/** The page shows at most this many rows (`logs.slice(0, 60)`); everything is copied. */
export const LOG_ROWS = 60;

/** Bottom offset of the debug bar (`dbgB`): on mobile above the tab bar. */
const DEBUG_BOTTOM = { mobile: '90px', desktop: '18px' };

const two = (n: number) => String(n).padStart(2, '0');

/** Time of an entry with seconds, in the browser's time. */
function logTime(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Entries up to the chosen level (`devLevel`). */
export function visibleLog(entries: readonly LogEntry[], level: LogLevel): LogEntry[] {
  const limit = LOG_LEVELS.indexOf(level);
  return entries.filter((e) => LOG_LEVELS.indexOf(e.level) <= limit);
}

/** Text of "Copy": per row "time [level] message". */
export function logText(entries: readonly LogEntry[]): string {
  return (
    entries.map((e) => `${logTime(e.t)} [${LEVELS[e.level].label()}] ${e.msg}`).join('\n') || m.dev_log_copy_empty()
  );
}

async function copy(text: string, done: string): Promise<void> {
  if (await copyText(text)) ui.toasts.show(done);
}

export interface DeveloperInput {
  env: ErrorEnv;
  /** Name of the app (`appName`) above the copied environment. */
  appName: string;
}

export interface DeveloperContext {
  scrollTo: (section: DevSection) => void;
  /** Preview of an error page: `/error/[code]`. */
  openError: (code: ErrorCode) => void;
  logout: () => void;
}

export interface DevToggle {
  on: boolean;
  onClick: () => void;
}

export interface DeveloperValues {
  devTabs: { label: string; onClick: () => void }[];
  tgDebug: DevToggle;
  devLevelOpts: SegOption<LogLevel>[];
  tgOffline: DevToggle;
  devLogRows: { id: number; time: string; lv: string; msg: string; color: string }[];
  devLogEmpty: boolean;
  devLogCount: string;
  devLogCopy: () => void;
  devLogClear: () => void;
  errBtns: { code: string; label: string; onClick: () => void }[];
  simExpire: () => void;
  simError: () => void;
  envRows: { k: string; v: string; sep: boolean }[];
  copyEnv: () => void;
}

export function developerValues(input: DeveloperInput, ctx: DeveloperContext): DeveloperValues {
  const level = prefs.values.devLevel;
  const logs = visibleLog(devLog.entries, level);
  const errors: [ErrorCode, string, string][] = [
    ['404', '404', m.dev_err_404()],
    ['403', '403', m.dev_err_403()],
    ['500', '500', m.dev_err_500()],
    ['offline', m.error_offline_kicker(), m.dev_err_offline()],
  ];

  return {
    devTabs: (
      [
        ['diag', m.dev_tab_diag()],
        ['log', m.dev_tab_log()],
        ['test', m.dev_tab_test()],
        ['env', m.dev_tab_env()],
      ] as const
    ).map(([section, label]) => ({ label, onClick: () => ctx.scrollTo(section) })),
    tgDebug: {
      on: prefs.values.devDebug,
      onClick: () => prefs.set({ devDebug: !prefs.values.devDebug }),
    },
    devLevelOpts: LOG_LEVELS.map((value) => ({
      value,
      label: LEVELS[value].label(),
      on: value === level,
      onClick: () => prefs.set({ devLevel: value }),
    })),
    tgOffline: {
      on: network.simulated,
      onClick: () => network.simulate(!network.simulated),
    },
    devLogRows: logs.slice(0, LOG_ROWS).map((e) => ({
      id: e.id,
      time: logTime(e.t),
      lv: LEVELS[e.level].label(),
      msg: e.msg,
      color: LEVELS[e.level].color,
    })),
    devLogEmpty: logs.length === 0,
    devLogCount: logs.length === 1 ? m.dev_log_count_one() : m.dev_log_count({ count: logs.length }),
    devLogCopy: () => void copy(logText(logs), m.dev_log_copied()),
    devLogClear: () => devLog.clear(),
    errBtns: errors.map(([key, code, label]) => ({ code, label, onClick: () => ctx.openError(key) })),
    simExpire: () =>
      ui.ask({
        force: true,
        noCancel: true,
        title: m.dev_expire_title(),
        text: m.dev_expire_text(),
        icon: 'ti-clock-off',
        ok: m.dev_expire_ok(),
        run: ctx.logout,
      }),
    simError: () => {
      devLog.add('error', m.dev_test_error());
      ui.toasts.show(m.dev_error_logged());
    },
    envRows: envRows(input.env).map(([k, v], i) => ({ k, v, sep: i > 0 })),
    copyEnv: () => void copy(envText(input.appName, input.env), m.dev_env_copied()),
  };
}

export interface DebugBarValues {
  dbgText: string;
  dbgB: string;
}

/** Debug bar: layout, window size and view. */
export function debugBarValues(env: ErrorEnv): DebugBarValues {
  return {
    dbgText: `${layoutOf(env)} · ${Math.round(env.width)}×${Math.round(env.height)} · ${redactPath(env.path)}`,
    dbgB: env.mobile ? DEBUG_BOTTOM.mobile : DEBUG_BOTTOM.desktop,
  };
}
