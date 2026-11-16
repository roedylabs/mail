/**
 * Session log (`devLog`) for Administration ›
 * Developer: start, notices, navigation, browser errors,
 * connection. Lives only in this tab's memory, newest first, and goes
 * nowhere unless someone copies it.
 */
import { untrack } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
import { LOG_LEVELS } from '#lib/settings-choices.ts';
import type { Settings } from '#lib/state/prefs.svelte.ts';

export { LOG_LEVELS };

export type LogLevel = Settings['devLevel'];

/** At most this many entries; older ones drop out (`slice(0, 120)`). */
export const LOG_MAX = 120;

export interface LogEntry {
  id: number;
  /** Timestamp in milliseconds. */
  t: number;
  level: LogLevel;
  msg: string;
}

/** Text for a rejected promise that nobody handled. */
function reasonText(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return typeof reason === 'string' && reason ? reason : m.dev_log_unknown();
}

export class DevLog {
  entries = $state.raw<LogEntry[]>([]);
  #id = 0;

  /** Writes an entry; also from effects, which do not depend on the log because of it. */
  add(level: LogLevel, msg: string): void {
    const entry = { id: ++this.#id, t: Date.now(), level, msg };
    this.entries = [entry, ...untrack(() => this.entries)].slice(0, LOG_MAX);
  }

  clear(): void {
    this.entries = [];
  }

  /** Records browser errors; plus rejected promises. */
  attach(target: Window): () => void {
    const onError = (event: ErrorEvent) => this.add('error', event.message || m.dev_log_unknown());
    const onRejection = (event: PromiseRejectionEvent) => this.add('error', reasonText(event.reason));
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
  }
}

export const devLog = new DevLog();
