/**
 * "Send later": limit of the send time, presets and times in the time zone
 * from Language & region.
 */
import type { DeliveryStatus, SetError } from '@roedy/jmap';
import type { IconName } from '#lib/icons.ts';
import { clock, dayNumber, type TimeContext } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { zoneParts, zoneTime } from '#lib/timezone.ts';
import { intlLocale } from '#lib/locale.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Stalwart accepts at most 7 days ahead but reports 30. */
export const PLAN_CAP_MS = 7 * DAY;
/** `maxDelayedSend` if the server reports no value. */
export const PLAN_DEFAULT_S = 30 * 86_400;

/** Limit L = min(`maxDelayedSend`, 7 days) in ms; 0 = no scheduled sending. */
export function planLimit(maxDelayedSend: number | null): number {
  return Math.min((maxDelayedSend ?? PLAN_DEFAULT_S) * 1000, PLAN_CAP_MS);
}

/** Limit as a duration: "7 days", "1 day", "12 hours". */
export function planDuration(limit: number): string {
  const days = limit / DAY;
  if (Number.isInteger(days)) return days === 1 ? m.compose_plan_day() : m.compose_plan_days({ count: days });
  const hours = Math.round(limit / HOUR);
  return hours === 1 ? m.compose_plan_hour() : m.compose_plan_hours({ count: hours });
}

/** Earliest time for the field and "Planen": next full minute after now plus one minute. */
export function planEarliest(now: number): number {
  return Math.ceil((now + MINUTE) / MINUTE) * MINUTE;
}

export type PlanPreset = 'morning' | 'afternoon' | 'monday';

/** Preset in the popover with its time. */
export interface PresetTime {
  key: PlanPreset;
  label: string;
  icon: IconName;
  at: number;
}

/**
 * "Tomorrow morning" (8 am), "Tomorrow afternoon" (1 pm) and "Monday
 * morning" (8 am, only if tomorrow is not Monday), each in `tz`.
 */
export function planPresets(now: number, tz: string): PresetTime[] {
  const p = zoneParts(now, tz);
  const at = (days: number, h: number) => zoneTime(p.y, p.mo, p.d + days, h, 0, tz);
  // Monday in 1–7 days; on Mondays the next one.
  const toMonday = (8 - p.wd) % 7 || 7;
  const list: PresetTime[] = [
    { key: 'morning', label: m.compose_plan_morning(), icon: 'ti-sunrise', at: at(1, 8) },
    { key: 'afternoon', label: m.compose_plan_afternoon(), icon: 'ti-sun', at: at(1, 13) },
  ];
  if (toMonday > 1)
    list.push({ key: 'monday', label: m.compose_plan_monday(), icon: 'ti-calendar-week', at: at(toMonday, 8) });
  return list;
}

/** "Heute, 08:00", "Morgen, 13:00" or "Mo., 9. Nov., 08:00" in `tz` (`cmpWhen`). */
export function planWhen(t: number, now: number, time: Pick<TimeContext, 'tz' | 'timeFmt'>): string {
  const k = dayNumber(t, time.tz) - dayNumber(now, time.tz);
  let day: string;
  if (k === 0) day = m.compose_plan_today();
  else if (k === 1) day = m.compose_plan_tomorrow();
  else {
    const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
    try {
      day = new Intl.DateTimeFormat(intlLocale(), { ...options, timeZone: time.tz || undefined }).format(t);
    } catch {
      day = new Intl.DateTimeFormat(intlLocale(), options).format(t);
    }
  }
  return `${day}, ${clock(t, time)}`;
}

/** `HOLDUNTIL` per RFC 3339 in UTC, without fractional seconds. */
export function holdUntil(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Reason the server rejected a time: FUTURERELEASE disabled (`ext`), above the limit (`over`) or not in the
 * future (`past`). Responses of Stalwart v0.16.27
 * (`crates/smtp/src/inbound/mail.rs`): "FUTURERELEASE extension has been
 * disabled.", "Requested release time exceeds maximum of …", "HOLDUNTIL
 * must be a date and time in the future." Other reasons of
 * `forbiddenMailFrom` (such as a message that is too large) do not count.
 */
export function planRefusal(error: SetError): 'ext' | 'over' | 'past' | null {
  if (error.type !== 'forbiddenMailFrom') return null;
  const text = error.description ?? '';
  if (/FUTURERELEASE/i.test(text)) return 'ext';
  if (/\bHOLDUNTIL\b[^.]*\bfuture\b/i.test(text)) return 'past';
  if (/\b(hold|release)\b[^.]*\bexceeds maximum/i.test(text)) return 'over';
  return null;
}

/**
 * No recipient accepted (`deliveryStatus` of a submission): only
 * explicitly rejected ones count; missing details count as
 * accepted, so that a sent message does not come back as a draft.
 */
export function noneAccepted(
  status: Readonly<Record<string, Pick<DeliveryStatus, 'delivered'>>> | null | undefined,
): boolean {
  const states = Object.values(status ?? {});
  return states.length > 0 && states.every((x) => x.delivered === 'no');
}
