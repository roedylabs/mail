/**
 * Date by date format and time zone of the settings (`dateFmt`, `tz`): wherever
 * a date is shown in digits – authenticator apps under Account › Security,
 * preview and choice in Language & region, short date of the list
 * (`formatShortDate`), "Released" on the About page (`formatBuildDate`). The
 * time zone is the same as in the mails (`tz`, with `tzAuto` the browser's).
 */

const formats = new Map<string, Intl.DateTimeFormat>();

/** Formatter per time zone, cached; an unknown zone counts as the browser's. */
function formatOf(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formats.get(key);
  if (!f) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz || undefined });
    } catch {
      // Unknown time zone (RangeError): local time of the browser.
      f = new Intl.DateTimeFormat('en-US', options);
    }
    formats.set(key, f);
  }
  return f;
}

/** Year, month and day in `tz`; without a valid time zone in the browser's. */
function parts(t: number, tz: string | undefined): { y: string; mo: string; day: string } {
  try {
    const out = formatOf(tz).formatToParts(t);
    const part = (type: Intl.DateTimeFormatPartTypes) => out.find((p) => p.type === type)?.value ?? '';
    return { y: part('year'), mo: part('month'), day: part('day') };
  } catch {
    // Invalid time (RangeError).
    return { y: '', mo: '', day: '' };
  }
}

/** "25.10.2026" (`de`), "2026-10-25" (`iso`) or "10/25/2026" (`us`). */
export function formatDate(t: number, fmt: string, tz?: string): string {
  const { y, mo, day } = parts(t, tz);
  if (fmt === 'iso') return `${y}-${mo}-${day}`;
  if (fmt === 'us') return `${mo}/${day}/${y}`;
  return `${day}.${mo}.${y}`;
}

/**
 * Short date of the list for earlier years: "25.10.24" (`de`) and "10/25/24"
 * (`us`) with a two-digit year, ISO always with the full year ("2024-10-25").
 */
export function formatShortDate(t: number, fmt: string, tz?: string): string {
  const { y, mo, day } = parts(t, tz);
  if (fmt === 'iso') return `${y}-${mo}-${day}`;
  if (fmt === 'us') return `${mo}/${day}/${y.slice(-2)}`;
  return `${day}.${mo}.${y.slice(-2)}`;
}
