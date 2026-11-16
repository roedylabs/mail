import { describe, expect, it } from 'vitest';
import { MAX_NAME, nameError, normalizeName } from './name.ts';

describe('normalizeName', () => {
  it('collapses control characters and repeated spaces into one', () => {
    expect(normalizeName('  John\tDoe \n ')).toBe('John Doe');
    expect(normalizeName('Anna\u0007\u0007Baker')).toBe('Anna Baker');
  });
});

describe('nameError', () => {
  it('accepts normal names, also with accents and umlauts', () => {
    expect(nameError('Jordan Smith')).toBe('');
    expect(nameError('Zo\u00eb M\u00fcller-L\u00fcdenscheidt')).toBe('');
    expect(nameError('')).toBe('');
  });

  it('counts characters instead of bytes and knows the backend maximum length', () => {
    expect(MAX_NAME).toBe(100);
    expect(nameError('a'.repeat(100))).toBe('');
    expect(nameError('a'.repeat(101))).toBe('too_long');
    // 100 characters such as \u00fc are 200 bytes, but 100 characters.
    expect(nameError('\u00fc'.repeat(100))).toBe('');
    // Spaces at the edges do not count.
    expect(nameError(`  ${'a'.repeat(100)}  `)).toBe('');
  });

  it('rejects invisible characters', () => {
    expect(nameError('Jordan\u200BSmith')).toBe('invalid');
    expect(nameError('Jordan\u00ADSmith')).toBe('invalid');
    expect(nameError('Jordan\u202ESmith')).toBe('invalid');
    expect(nameError('Jordan\u2060Smith')).toBe('invalid');
    // Invisible characters take precedence over the length.
    expect(nameError(`${'a'.repeat(101)}\u200B`)).toBe('invalid');
  });

  it('treats U+FEFF and line separators as whitespace (`\\s` in JavaScript)', () => {
    // `normalizeName` turns them into spaces before `nameError` sees them.
    expect(normalizeName('\uFEFFJordan')).toBe('Jordan');
    expect(nameError('\uFEFFJordan')).toBe('');
    expect(nameError('Jordan\u2028Smith')).toBe('');
  });

  it('normalizes control characters instead of rejecting them', () => {
    expect(nameError('Jordan\tSmith')).toBe('');
    expect(nameError('Jordan\u0000Smith')).toBe('');
    // After collapsing, the length of the normalized name applies.
    expect(nameError(`${'a'.repeat(50)}\t\t\t${'b'.repeat(49)}`)).toBe('');
  });
});
