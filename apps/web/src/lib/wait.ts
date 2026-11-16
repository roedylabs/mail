/**
 * Wait time of a lockout (`retry_after` in seconds) as text, plus the clock
 * of the locked buttons.
 */
import { m } from '#lib/paraglide/messages.js';

/** Seconds below one minute, otherwise minutes rounded up ("1 second", "15 minutes"). */
export function waitText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return s === 1 ? m.wait_second() : m.wait_seconds({ n: s });
  const minutes = Math.ceil(s / 60);
  return minutes === 1 ? m.wait_minute() : m.wait_minutes({ n: minutes });
}

/** Remaining time as a clock "m:ss" ("Anmelden in 4:59", "Erneut senden in 0:30"). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
