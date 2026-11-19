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

/** Length from which the setup shows a live counter next to the name's label. */
export const NAME_WARN = 80;

/** Length of a name in characters (code points), as `nameError` and the backend count it. */
export function nameLength(value: string): number {
  return [...value].length;
}

/** A name cut at `MAX_NAME` characters (code points, never half a character). */
export function limitName(value: string): string {
  const chars = [...value];
  return chars.length <= MAX_NAME ? value : chars.slice(0, MAX_NAME).join('');
}

/**
 * An edit of the name field limited like `maxlength`, but in characters:
 * what was typed or pasted is cut so that the name keeps at most `MAX_NAME`
 * (the rest of the name stays as it was). `caret` is the field's caret after
 * the edit (UTF-16 units, the end of the inserted text): everything after it
 * is the unchanged rest. Returns the value and the caret after the kept part
 * of the insertion (`null` when nothing was cut).
 */
export function limitNameEdit(
  before: string,
  after: string,
  caret: number | null = null,
): { value: string; caret: number | null } {
  if (nameLength(after) <= MAX_NAME) return { value: after, caret: null };
  const at = caret ?? after.length;
  const rest = after.slice(at);
  // Without the unchanged rest at the end of the old value: cut at the end.
  if (!before.endsWith(rest)) return { value: limitName(after), caret: null };
  const old = [...before.slice(0, before.length - rest.length)];
  const head = [...after.slice(0, at)];
  let p = 0;
  while (p < old.length && p < head.length && old[p] === head[p]) p++;
  const kept = [...head.slice(0, p), ...head.slice(p).slice(0, Math.max(0, MAX_NAME - p - nameLength(rest)))].join('');
  return { value: limitName(kept + rest), caret: kept.length };
}

/** First letter (with its marks) of the first and the last word, in upper case; empty without a name. */
export function initials(value: string): string {
  const words = normalizeName(value).split(' ').filter(Boolean);
  const first = (word: string | undefined) => /^.\p{M}*/su.exec(word ?? '')?.[0] ?? '';
  if (words.length === 0) return '';
  return (first(words[0]) + (words.length > 1 ? first(words.at(-1)) : '')).toUpperCase();
}
