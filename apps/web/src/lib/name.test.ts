import { describe, expect, it } from 'vitest';
import { MAX_NAME, initials, limitName, limitNameEdit, nameError, nameLength, normalizeName } from './name.ts';

describe('normalizeName', () => {
  it('collapses control characters and repeated spaces into one', () => {
    expect(normalizeName('  John\tDoe \n ')).toBe('John Doe');
    expect(normalizeName('Anna\u0007\u0007Baker')).toBe('Anna Baker');
  });
});

describe('nameError', () => {
  it('accepts letters of any language with marks, spaces, hyphens and apostrophes', () => {
    expect(nameError('Jordan Smith')).toBe('');
    expect(nameError('M\u00fcller-L\u00fcdenscheidt')).toBe('');
    expect(nameError('Zo\u00eb M\u00fcller-L\u00fcdenscheidt')).toBe('');
    // Decomposed: u with a combining diaeresis.
    expect(nameError('Mu\u0308ller')).toBe('');
    expect(nameError('O\u2019Brien')).toBe('');
    expect(nameError("O'Brien")).toBe('');
    expect(nameError('\u0395\u03bb\u03ad\u03bd\u03b7')).toBe('');
    expect(nameError('\u674e\u5c0f\u9f99')).toBe('');
    expect(nameError('\u0645\u062d\u0645\u062f')).toBe('');
    expect(nameError('')).toBe('');
  });

  it('rejects digits, brackets and other characters', () => {
    expect(nameError('Jordan Smith 2')).toBe('invalid');
    expect(nameError('Jordan (Admin)')).toBe('invalid');
    expect(nameError('Jordan [Admin]')).toBe('invalid');
    expect(nameError('Jordan.Smith')).toBe('invalid');
    expect(nameError('jordan@example.com')).toBe('invalid');
    expect(nameError('Jordan_Smith')).toBe('invalid');
    expect(nameError('Jordan \u{1F642}')).toBe('invalid');
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
    // Other characters take precedence over the length.
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

describe('limitName', () => {
  it('cuts a typed or pasted name at 100 characters', () => {
    expect(limitName('Anna Becker')).toBe('Anna Becker');
    expect(limitName('a'.repeat(100))).toHaveLength(MAX_NAME);
    expect(limitName('a'.repeat(140))).toBe('a'.repeat(100));
  });

  it('counts characters as the name rule does, not UTF-16 units', () => {
    // U+20BB7 is a letter outside the BMP (two UTF-16 units).
    const sixty = '\u{20BB7}'.repeat(60);
    expect(nameLength(sixty)).toBe(60);
    expect(limitName(sixty)).toBe(sixty);
    expect(nameError(sixty)).toBe('');
    expect(limitName('\u{20BB7}'.repeat(101))).toBe('\u{20BB7}'.repeat(100));
  });
});

describe('limitNameEdit', () => {
  it('keeps an edit within the limit as it is', () => {
    expect(limitNameEdit('Anna', 'Anna B')).toEqual({ value: 'Anna B', caret: null });
  });

  it('cuts what is typed or pasted, never the rest of the name', () => {
    const full = 'a'.repeat(98);
    // Pasted at the end: cut to the two characters left.
    expect(limitNameEdit(full, `${full}Becker`, 104)).toEqual({ value: `${full}Be`, caret: 100 });
    // Typed in the middle of a full name: nothing is inserted, the end stays.
    const at = `${'a'.repeat(50)}Z${'a'.repeat(49)}`;
    expect(limitNameEdit(at, `${'a'.repeat(50)}xZ${'a'.repeat(49)}`, 51)).toEqual({ value: at, caret: 50 });
    // Characters outside the BMP count as one.
    const wide = '\u{20BB7}'.repeat(99);
    expect(limitNameEdit(wide, `${wide}\u{20BB7}\u{20BB7}`, 202).value).toBe('\u{20BB7}'.repeat(100));
  });

  it('takes the edit range from the caret, also among repeated characters', () => {
    // 99 × a, "aZ" pasted after the tenth: only the "a" fits.
    const name = 'a'.repeat(99);
    expect(limitNameEdit(name, `${'a'.repeat(10)}aZ${'a'.repeat(89)}`, 12)).toEqual({
      value: 'a'.repeat(100),
      caret: 11,
    });
    // A pasted selection: what replaces it is cut, the rest stays.
    const sel = `${'a'.repeat(90)}bb${'c'.repeat(8)}`;
    expect(limitNameEdit(sel, `${'a'.repeat(90)}xyzxyz${'c'.repeat(8)}`, 96)).toEqual({
      value: `${'a'.repeat(90)}xy${'c'.repeat(8)}`,
      caret: 92,
    });
  });

  it('cuts at the end without a usable caret', () => {
    expect(limitNameEdit('b', 'a'.repeat(120)).value).toBe('a'.repeat(100));
  });
});

describe('initials', () => {
  it('takes the first letter of the first and the last word', () => {
    expect(initials('Anna Becker')).toBe('AB');
    expect(initials('anna maria von becker')).toBe('AB');
    expect(initials('  Anna  ')).toBe('A');
    expect(initials('O’Brien Müller-Lüdenscheidt')).toBe('OM');
    expect(initials('élodie ørsted')).toBe('ÉØ');
  });

  it('keeps combining marks with their letter', () => {
    expect(initials('Ångström Zoë')).toBe('ÅZ');
  });

  it('is empty without a name', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
  });
});
