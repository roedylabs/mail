import { describe, expect, it } from 'vitest';
import { formatBuildDate } from './build-info.ts';

describe('formatBuildDate', () => {
  it('formats like the About page (DD.MM.YYYY)', () => {
    expect(formatBuildDate(new Date(2026, 9, 4, 12))).toBe('04.10.2026');
  });

  it('follows the date format from Language & region', () => {
    expect(formatBuildDate(new Date(2026, 9, 4, 12), 'iso')).toBe('2026-10-04');
    expect(formatBuildDate(new Date(2026, 9, 4, 12), 'us')).toBe('10/04/2026');
  });
});
