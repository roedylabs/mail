import { describe, expect, it } from 'vitest';
import deJson from '../../messages/de.json';
import enJson from '../../messages/en.json';

/** Texts per language: `en.json` covers `de.json`, with the same placeholders. */
const de: Record<string, string> = deJson;
const en: Record<string, string> = enJson;

/** Keys that may be empty in English: "Uhr" after the time does not exist there. */
const EMPTY_EN = new Set(['time_uhr']);

const placeholders = (text: string): string[] => [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!).sort();

describe('messages', () => {
  it('English has exactly the keys of German, in the same order', () => {
    expect(Object.keys(en)).toEqual(Object.keys(de));
  });

  it('every text has the same placeholders in both languages', () => {
    const differ = Object.keys(de)
      .filter((k) => k !== '$schema')
      .filter((k) => placeholders(de[k]!).join() !== placeholders(en[k] ?? '').join());
    expect(differ).toEqual([]);
  });

  it('no text is empty, none stayed German in English', () => {
    const keys = Object.keys(de).filter((k) => k !== '$schema');
    expect(keys.filter((k) => !de[k]!.trim())).toEqual([]);
    expect(keys.filter((k) => !EMPTY_EN.has(k) && !en[k]?.trim())).toEqual([]);
    // German umlauts, the sharp s and German quotation marks reveal untranslated texts.
    expect(keys.filter((k) => /[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df\u201e]/.test(en[k] ?? ''))).toEqual([]);
  });
});
