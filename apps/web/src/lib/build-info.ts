import { formatDate } from '#lib/date.ts';

/** Version, commit and date of the build (set in vite/build-info.ts). */
export const buildInfo = {
  version: import.meta.env.ROEDY_VERSION,
  sha: import.meta.env.ROEDY_BUILD_SHA,
  date: new Date(import.meta.env.ROEDY_BUILD_DATE),
} as const;

/** Date like "Released" on the About page: in the date format and time zone of the settings (without `tz` the browser's). */
export function formatBuildDate(date: Date, fmt = 'de', tz?: string): string {
  return formatDate(date.getTime(), fmt, tz);
}
