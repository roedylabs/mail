import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseLocale } from '#lib/paraglide/runtime.js';
import { browserLang, deviceLang, intlLocale, LANG_KEY, rememberLang } from './locale.ts';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('deviceLang', () => {
  it('takes the remembered language before the browser one', () => {
    vi.stubGlobal('navigator', { languages: ['de-DE'], language: 'de-DE' });
    rememberLang('en');
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    expect(deviceLang()).toBe('en');
  });

  it('otherwise the first matching one of the browser, otherwise the base language', () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'en-GB', 'de'], language: 'fr-FR' });
    expect(deviceLang()).toBe('en');
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'de-AT', 'en'], language: 'fr-FR' });
    expect(deviceLang()).toBe('de');
    vi.stubGlobal('navigator', { languages: [], language: 'EN-us' });
    expect(deviceLang()).toBe('en');
    vi.stubGlobal('navigator', { languages: ['fr', 'it'], language: 'fr' });
    expect(deviceLang()).toBe(baseLocale);
  });

  it('skips unknown remembered values', () => {
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    localStorage.setItem(LANG_KEY, 'fr');
    expect(deviceLang()).toBe('en');
  });
});

describe('browserLang', () => {
  it('is German for a preferred de*, otherwise English', () => {
    for (const [languages, lang] of [
      [['de-DE', 'en'], 'de'],
      [['DE'], 'de'],
      [['de-CH'], 'de'],
      [['en-US', 'de-DE'], 'en'],
      [['fr-FR', 'de-DE'], 'en'],
      [[], 'en'],
    ] as const) {
      vi.stubGlobal('navigator', { languages, language: languages[0] ?? '' });
      expect(browserLang(), languages.join()).toBe(lang);
    }
  });

  it('"system" forgets the remembered language', () => {
    rememberLang('de');
    rememberLang('system');
    expect(localStorage.getItem(LANG_KEY)).toBeNull();
  });
});

describe('intlLocale', () => {
  it('maps the languages to Intl locales (English with en-GB: day before month, zone names like CET)', () => {
    expect(intlLocale('de')).toBe('de-DE');
    expect(intlLocale('en')).toBe('en-GB');
    const t = Date.UTC(2026, 10, 10, 12);
    expect(new Date(t).toLocaleDateString(intlLocale('en'), { day: 'numeric', month: 'long', timeZone: 'UTC' })).toBe(
      '10 November',
    );
  });
});
