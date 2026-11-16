import { describe, expect, it } from 'vitest';
import { PW_RULES, meetsPolicy, tooLong } from './password.ts';

describe('password policy', () => {
  it('checks the three rules like the backend', () => {
    const failing = (v: string) => PW_RULES.filter((r) => !r.test(v)).map((r) => r.id);
    expect(failing('short')).toEqual(['len', 'case', 'num']);
    expect(failing('onlylowercaseletters')).toEqual(['case', 'num']);
    expect(failing('Gro\u00dfundklein')).toEqual(['num']);
    expect(failing('\u00c4pfel and pears')).toEqual([]);
    // Case and letters are not limited to the Latin alphabet (Greek letters here).
    expect(failing('\u0391\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03b9\u03ba')).toEqual(['num']);
    expect(failing('\u0391\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03b9\u03ba-1')).toEqual([]);
    expect(meetsPolicy('Safe-enough1')).toBe(true);
    expect(PW_RULES.map((r) => r.label())).toEqual([
      'At least 10 characters',
      'Upper- and lowercase letters',
      'A number or special character',
    ]);
    expect(PW_RULES.map((r) => r.error())).toEqual([
      'The new password must be at least 10 characters long.',
      'The new password needs upper- and lowercase letters.',
      'The new password needs a number or special character.',
    ]);
  });

  it('measures the length in bytes like the backend (1024)', () => {
    expect(tooLong('a'.repeat(1024))).toBe(false);
    expect(tooLong('a'.repeat(1025))).toBe(true);
    expect(tooLong('\u00e4'.repeat(513))).toBe(true);
  });
});
