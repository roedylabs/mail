/** Characters a code field (`CodeField`) shows. */
export type CodeFilter = 'digits' | 'alnum';

/** The characters of `value` the boxes show: digits, or A–Z and 0–9 upper-cased; at most `length`. */
export function codeOf(value: string, filter: CodeFilter, length: number): string {
  const chars = filter === 'digits' ? value.replace(/\D/g, '') : value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return chars.slice(0, length);
}
