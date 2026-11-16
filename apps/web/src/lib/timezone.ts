/**
 * Wall clock in a time zone: "Send later" computes presets, field and limit
 * in the time zone from Language & region (`tz`), not in that of the device.
 * An unknown zone counts as the device's.
 */
import { m } from '#lib/paraglide/messages.js';
import { intlLocale } from '#lib/locale.ts';

/** Date and time of a point in time in `tz`; `wd` 0 = Sunday. */
export interface ZoneParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  wd: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = {
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz || undefined });
    } catch {
      // Unknown time zone (RangeError): the device's.
      f = new Intl.DateTimeFormat('en-US', options);
    }
    formats.set(tz, f);
  }
  return f;
}

/** Time zone of the device (IANA name). */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function zoneParts(t: number, tz: string): ZoneParts {
  const o: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of partsFormat(tz).formatToParts(t)) o[p.type] = p.value;
  return {
    y: Number(o.year),
    mo: Number(o.month),
    d: Number(o.day),
    h: Number(o.hour) % 24,
    mi: Number(o.minute),
    s: Number(o.second),
    wd: WEEKDAYS.indexOf(o.weekday ?? ''),
  };
}

/**
 * Point in time of a wall clock in `tz`; day and month may overflow (`d + 1`).
 * If the time falls into the gap of a clock change, it counts as after the change.
 */
export function zoneTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t: number) => {
    const p = zoneParts(t, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  const o1 = offset(wall);
  const t1 = wall - o1;
  const o2 = offset(t1);
  return o2 === o1 ? t1 : wall - o2;
}

/** Start of the calendar day of `t` in `tz`. */
export function zoneDayStart(t: number, tz: string): number {
  const p = zoneParts(t, tz);
  return zoneTime(p.y, p.mo, p.d, 0, 0, tz);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for `<input type="datetime-local">` in `tz` ("2026-11-02T08:00"). */
export function toLocalInput(t: number, tz: string): string {
  const p = zoneParts(t, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** Point in time from a `datetime-local` value in `tz`; `NaN` if it is none. */
export function fromLocalInput(value: string, tz: string): number {
  const v = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!v) return NaN;
  const [y, mo, d, h, mi] = v.slice(1).map(Number) as [number, number, number, number, number];
  return zoneTime(y, mo, d, h, mi, tz);
}

/** Time zones of Language & region with their names. */
const ZONE_NAMES: Record<string, () => string> = {
  'Europe/Berlin': m.region_tz_berlin,
  'Europe/London': m.region_tz_london,
  'Europe/Athens': m.region_tz_athens,
  'America/New_York': m.region_tz_new_york,
  'America/Los_Angeles': m.region_tz_los_angeles,
  'Asia/Tokyo': m.region_tz_tokyo,
};

/** The time zones of the selection in Language & region, in their order. */
export const ZONES: readonly string[] = Object.keys(ZONE_NAMES);

/** Place of a time zone: "Tokyo, Seoul"; without its own name the place from the IANA name. */
export function zoneLabel(tz: string): string {
  const own = Object.hasOwn(ZONE_NAMES, tz) ? ZONE_NAMES[tz] : undefined;
  return own?.() ?? (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

const abbrFormats = new Map<string, Intl.DateTimeFormat | null>();

/** Abbreviation of a time zone at time `now`: "CET" or "GMT+9"; empty if the zone is unknown. */
export function zoneAbbr(tz: string, now: number): string {
  const locale = intlLocale();
  const key = `${locale}|${tz}`;
  let f = abbrFormats.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' });
    } catch {
      // Unknown time zone: no abbreviation.
      f = null;
    }
    abbrFormats.set(key, f);
  }
  return f?.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * Name of a time zone like in Language & region: "Tokyo, Seoul (GMT+9)"; without its own name the place from the IANA name.
 */
export function zoneName(tz: string, now: number): string {
  const name = zoneLabel(tz);
  const abbr = zoneAbbr(tz, now);
  return abbr ? `${name} (${abbr})` : name;
}
