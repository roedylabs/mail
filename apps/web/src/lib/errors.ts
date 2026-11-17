/**
 * Error pages and the values of the error page: "Try again" only for 500 and
 * offline, support link with the address of the organisation, details to copy.
 * Plus the text of the error toast when an action fails on the server.
 */
import { isJmapError } from '@roedy/jmap';
import { isApiError, NetworkError, retryAfter } from '#lib/api.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { redactPath } from '#lib/routes.ts';
import { browserTimeZone, displayZone, type Settings } from '#lib/state/prefs.svelte.ts';
import { waitText } from '#lib/wait.ts';

interface ErrorPage {
  icon: IconName;
  kicker: () => string;
  title: () => string;
  text: () => string;
  /** Offer "Try again" */
  retry: boolean;
}

/** Error pages; texts as functions so that they follow the language. */
export const ERRS = {
  '404': {
    icon: 'ti-map-question',
    kicker: m.error_404_kicker,
    title: m.error_404_title,
    text: m.error_404_text,
    retry: false,
  },
  '403': {
    icon: 'ti-lock',
    kicker: m.error_403_kicker,
    title: m.error_403_title,
    text: m.error_403_text,
    retry: false,
  },
  '500': { icon: 'ti-bug', kicker: m.error_500_kicker, title: m.error_500_title, text: m.error_500_text, retry: true },
  offline: {
    icon: 'ti-wifi-off',
    kicker: m.error_offline_kicker,
    title: m.error_offline_title,
    text: m.error_offline_text,
    retry: true,
  },
} as const satisfies Record<string, ErrorPage>;

export type ErrorCode = keyof typeof ERRS;

/** Error page for an HTTP status; everything except 403 and 404 counts as 500. */
export function errorCodeOf(status: number): ErrorCode {
  return status === 404 ? '404' : status === 403 ? '403' : '500';
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERRS, value);
}

/**
 * Without a response from the server (offline, network): `api()` then throws `NetworkError`,
 * the JMAP client `unreachable`; other errors do not count as offline.
 */
export function isOffline(error: unknown): boolean {
  return error instanceof NetworkError || isJmapError(error, 'unreachable');
}

/**
 * Text of the error toast: without a connection "No connection."
 * (`ERR_TXT.offline`), otherwise the text of the caller – "That did not work. …"
 * (`ERR_TXT.act`) if it has none of its own.
 */
export function failText(error: unknown, text: string = m.error_act()): string {
  return isOffline(error) ? m.error_offline() : text;
}

/** Text of a "Couldn’t load …" card: the wait time after 429, "No connection" without a response, otherwise "That didn’t work". */
export function loadFailText(error: unknown): string {
  return isApiError(error, 429) ? m.error_limit({ wait: waitText(retryAfter(error)) }) : failText(error);
}

/** Values of the error page; `isMobile` comes from `ui`. */
export interface ErrorPageValues {
  er: { icon: IconName; kicker: string; title: string; text: string };
  /** Button "Try again" (`bz('errBusy', …)`): spins and shows "Loading" while it runs. */
  errB: { dis: 'true' | 'false'; icon: IconName; label: string; rot: number; cur: string };
  errRetry: boolean;
  errNoRetry: boolean;
  /** "Error 500 · Build 7f3c2a1 · 19:44" */
  errDetail: string;
  errHasSupport: boolean;
  /** `mailto:` to the address of the organisation with the subject "‹kicker› in ‹app name›". */
  errMail: string;
  errRun: () => void;
  errHome: () => void;
  errBack: () => void;
  errCopy: () => void;
}

/** State and environment the values are built from. */
export interface ErrorPageInput {
  code: ErrorCode;
  /** "Try again" is running (`errBusy`) and rotation of the icon in degrees (`errBusyRot`). */
  busy: boolean;
  rot: number;
  appName: string;
  /** Contact of the organisation (`org.email`); without it no support link. */
  supportEmail: string | null;
  build: string;
  /** Time of the display (`timeText`). */
  time: string;
}

export type ErrorPageActions = Pick<ErrorPageValues, 'errRun' | 'errHome' | 'errBack' | 'errCopy'>;

export function errorPageValues(input: ErrorPageInput, actions: ErrorPageActions): ErrorPageValues {
  const page = ERRS[input.code];
  const kicker = page.kicker();
  return {
    er: { icon: page.icon, kicker, title: page.title(), text: page.text() },
    errB: {
      dis: input.busy ? 'true' : 'false',
      icon: input.busy ? 'ti-loader-2' : 'ti-refresh',
      label: input.busy ? m.error_retrying() : m.error_retry(),
      rot: input.rot,
      cur: input.busy ? 'progress' : 'pointer',
    },
    errRetry: page.retry,
    errNoRetry: !page.retry,
    errDetail: m.error_detail({ kicker, build: input.build, time: input.time }),
    errHasSupport: !!input.supportEmail,
    errMail: `mailto:${input.supportEmail ?? ''}?subject=${encodeURIComponent(m.error_mail_subject({ kicker, app: input.appName }))}`,
    ...actions,
  };
}

/** Environment for "Copy details" (`envRows` of the Developer page). */
export interface ErrorEnv {
  version: string;
  build: string;
  mobile: boolean;
  width: number;
  height: number;
  path: string;
  browser: string;
  timeZone: string;
  language: string;
  region: string;
}

type ClockSettings = Pick<Settings, 'tzAuto' | 'tz' | 'timeFmt'>;

/** Time zone of the account: with `tzAuto` the browser's, otherwise `tz` (`displayZone()`). */
export function timeZoneOf(settings: ClockSettings): string {
  return displayZone(settings, browserTimeZone());
}

/** Time in the time zone and 12/24-hour format of the account. */
export function timeText(date: Date, settings: ClockSettings): string {
  const h12 = settings.timeFmt === '12h';
  try {
    return date.toLocaleTimeString(h12 ? 'en-US' : 'en-GB', {
      hour: h12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      hour12: h12,
      timeZone: timeZoneOf(settings),
    });
  } catch {
    // Unknown time zone: the browser's.
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
}

/** Layout name: narrow (mobile) or desktop. */
export function layoutOf(env: Pick<ErrorEnv, 'mobile'>): string {
  return env.mobile ? m.dev_layout_narrow() : m.dev_layout_desktop();
}

/**
 * Rows of the environment (`envRows`, Developer page and "Copy details").
 * A token from a mail in the address is left out (`redactPath`).
 */
export function envRows(env: ErrorEnv): [label: string, value: string][] {
  return [
    [m.dev_env_version(), m.dev_env_version_value({ version: env.version, build: env.build })],
    [m.dev_env_layout(), layoutOf(env)],
    [m.dev_env_screen(), m.dev_env_screen_value({ width: Math.round(env.width), height: Math.round(env.height) })],
    [m.dev_env_view(), redactPath(env.path)],
    [m.dev_env_browser(), env.browser],
    [m.dev_env_timezone(), env.timeZone],
    [m.dev_env_language(), `${env.language.toUpperCase()} · ${env.region}`],
  ];
}

/** Heading, then per row of the environment "label: value" (`copyEnv`, `errCopy`). */
export function envText(title: string, env: ErrorEnv): string {
  return [title, ...envRows(env).map(([k, v]) => `${k}: ${v}`)].join('\n');
}

/** Text of "Copy details": kicker and environment. */
export function errorDetails(code: ErrorCode, env: ErrorEnv): string {
  return envText(ERRS[code].kicker(), env);
}
