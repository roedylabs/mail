/**
 * Language of the interface: English (the base language) or German. When signed
 * in, `lang` of the settings (`prefs`) applies; guests get the language last used
 * on this device, otherwise the first matching one of the browser, otherwise
 * English. Paraglide reads the language via `overwriteGetLocale` from `prefs`
 * (see there), so that templates and `$derived` follow a change without a reload.
 *
 * Date and number formats in words follow the language (`intlLocale()`):
 * English uses `en-GB` – day before month ("Tue 10 November") and time zone
 * names like "CET" instead of "GMT+1"; the texts themselves are written in
 * American English. Date format in digits, time and week start stay settings
 * (`#lib/date.ts`, `clock()`).
 */
import { baseLocale, getLocale, isLocale, type Locale } from '#lib/paraglide/runtime.js';

export type Lang = Locale;

/** Key in `localStorage` for the language of the device. */
export const LANG_KEY = 'roedy-lang';

/** Language of the device: remembered, otherwise the first matching one of the browser, otherwise the base language. */
export function deviceLang(): Lang {
  // Without a document (tests under Node, service worker) the base language applies.
  if (!('document' in globalThis)) return baseLocale;
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored && isLocale(stored)) return stored;
  } catch {
    // No storage (private window, blocked): then the browser.
  }
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const base = tag?.toLowerCase().split('-')[0];
    if (base && isLocale(base)) return base;
  }
  return baseLocale;
}

/** Remembers the language of the account for the pages without sign-in on this device. */
export function rememberLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Without storage the browser applies again next time.
  }
}

/** Language tag for `Intl` (date in words, numbers, time zone abbreviations). */
export function intlLocale(lang: Lang = getLocale()): string {
  return lang === 'en' ? 'en-GB' : 'de-DE';
}
