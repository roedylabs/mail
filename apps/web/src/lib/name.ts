/** Display names as the backend accepts them (`api::me::check_display_name`): setup, profile, invitation and inviting. */
import { m } from '#lib/paraglide/messages.js';

/** Maximum name length in the backend (`MAX_NAME`). */
export const MAX_NAME = 100;

/**
 * Name as the backend accepts it: control characters (such as a tab from a
 * copied table cell) and repeated spaces collapse into one.
 */
export function normalizeName(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Invisible characters a name must not contain; `normalizeName` already replaces control and whitespace
 * characters (also U+2028/2029, U+FEFF).
 */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u;

/** Error of a name: too long or with invisible characters, otherwise empty. */
export function nameError(value: string): '' | 'too_long' | 'invalid' {
  const name = normalizeName(value);
  if (INVISIBLE.test(name)) return 'invalid';
  return [...name].length > MAX_NAME ? 'too_long' : '';
}

/** Text for `nameError`. */
export function nameErrorText(error: 'too_long' | 'invalid'): string {
  return error === 'too_long' ? m.error_name_long() : m.error_name_invalid();
}
