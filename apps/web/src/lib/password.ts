/**
 * Password policy shared with the backend (`auth::password`): setup, sign-in
 * ("Set new password"), invitation and Account › Security. Case and character
 * classes follow the Unicode properties `Lowercase` and `Uppercase`, not just
 * ASCII letters.
 */
import { m } from '#lib/paraglide/messages.js';

export type PasswordRuleId = 'len' | 'case' | 'num';

export interface PasswordRule {
  id: PasswordRuleId;
  /** Label of the chip. */
  label: () => string;
  /** Message when the rule is not met (sign-in, Account › Security). */
  error: () => string;
  test: (value: string) => boolean;
}

export const PW_RULES: readonly PasswordRule[] = [
  { id: 'len', label: m.password_rule_len, error: m.password_rule_len_error, test: (v) => v.length >= 10 },
  {
    id: 'case',
    label: m.password_rule_case,
    error: m.password_rule_case_error,
    test: (v) => /\p{Lowercase}/u.test(v) && /\p{Uppercase}/u.test(v),
  },
  {
    id: 'num',
    label: m.password_rule_num,
    error: m.password_rule_num_error,
    test: (v) => /[^\p{Lowercase}\p{Uppercase}]/u.test(v),
  },
];

/** Maximum backend length in bytes (`MAX_PASSWORD`); above it "The password is too long." */
export const MAX_PASSWORD_BYTES = 1024;

export function meetsPolicy(value: string): boolean {
  return PW_RULES.every((rule) => rule.test(value));
}

export function tooLong(value: string): boolean {
  return new TextEncoder().encode(value).length > MAX_PASSWORD_BYTES;
}

/** 0 not set yet, 1 weak, 2 fair, 3 good, 4 strong. */
export type Strength = 0 | 1 | 2 | 3 | 4;

/** Length from which a password that meets all rules counts as strong. */
export const STRONG_LENGTH = 14;

/**
 * Strength for the meter of the setup: the rules met (0–3), plus one for
 * 14 or more characters once all are met; anything typed counts at least as
 * weak.
 */
export function strength(value: string): Strength {
  if (!value) return 0;
  const met = PW_RULES.filter((rule) => rule.test(value)).length;
  return Math.max(1, met + (met === PW_RULES.length && value.length >= STRONG_LENGTH ? 1 : 0)) as Strength;
}
