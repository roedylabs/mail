import { describe, expect, it } from 'vitest';
import { formatDate, formatShortDate } from './date.ts';

describe('formatDate', () => {
  const t = Date.parse('2026-10-01T20:00:00Z');

  it('writes the date in the chosen format', () => {
    expect(formatDate(t, 'de', 'Europe/Berlin')).toBe('01.10.2026');
    expect(formatDate(t, 'iso', 'Europe/Berlin')).toBe('2026-10-01');
    expect(formatDate(t, 'us', 'Europe/Berlin')).toBe('10/01/2026');
  });

  it('calculates in the time zone of the settings', () => {
    expect(formatDate(t, 'de', 'Asia/Tokyo')).toBe('02.10.2026');
  });

  it('falls back to the browser time zone for an unknown one', () => {
    expect(formatDate(t, 'iso', 'Mars/Olympus')).toMatch(/^2026-10-0[12]$/);
  });
});

describe('formatShortDate', () => {
  const t = Date.parse('2025-12-24T09:00:00Z');

  it('shortens the year in de and us, ISO keeps the full year', () => {
    expect(formatShortDate(t, 'de', 'Europe/Berlin')).toBe('24.12.25');
    expect(formatShortDate(t, 'us', 'Europe/Berlin')).toBe('12/24/25');
    expect(formatShortDate(t, 'iso', 'Europe/Berlin')).toBe('2025-12-24');
  });

  it('returns only the separators instead of an error for an invalid time', () => {
    expect(formatShortDate(NaN, 'iso', 'Europe/Berlin')).toBe('--');
  });
});
