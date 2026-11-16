/** Environment for error reports (`envRows`): Developer page, debug bar and "Copy details" of the error page. */
import { deviceOf } from '#lib/about.ts';
import { buildInfo } from '#lib/build-info.ts';
import { timeZoneOf, type ErrorEnv } from '#lib/errors.ts';
import { regionLabel } from '#lib/language.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** State of this window; inside `$derived` it follows window size and settings. */
export function currentEnv(path: string): ErrorEnv {
  return {
    version: buildInfo.version,
    build: buildInfo.sha || '–',
    mobile: ui.isMobile,
    width: ui.width,
    height: ui.height,
    path,
    browser: deviceOf(navigator.userAgent),
    timeZone: timeZoneOf(prefs.values),
    language: prefs.values.lang,
    // Country name in the interface language, not the stored code.
    region: regionLabel(prefs.values.region),
  };
}
