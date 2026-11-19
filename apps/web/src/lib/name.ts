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
 * Characters of a name: letters of any language with their marks (such as a combining umlaut), spaces,
 * hyphens and apostrophes (`'` and `’`). `normalizeName` already turns control and whitespace characters
 * into single spaces.
 */
const NAME = /^[\p{L}\p{M} '’-]*$/u;

/** Error of a name: other characters or too long, otherwise empty (also for an empty name). */
export function nameError(value: string): '' | 'too_long' | 'invalid' {
  const name = normalizeName(value);
  if (!NAME.test(name)) return 'invalid';
  return [...name].length > MAX_NAME ? 'too_long' : '';
}

/** Text for `nameError`. */
export function nameErrorText(error: 'too_long' | 'invalid'): string {
  return error === 'too_long' ? m.error_name_long() : m.error_name_invalid();
}
