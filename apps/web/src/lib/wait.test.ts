import { describe, expect, it } from 'vitest';
import { clockText, waitText } from './wait.ts';

describe('waitText', () => {
  it('names seconds below one minute, otherwise minutes rounded up', () => {
    expect(waitText(1)).toBe('1 second');
    expect(waitText(30)).toBe('30 seconds');
    expect(waitText(59.2)).toBe('1 minute');
    expect(waitText(60)).toBe('1 minute');
    expect(waitText(61)).toBe('2 minutes');
    expect(waitText(900)).toBe('15 minutes');
  });
});

describe('clockText', () => {
  it('shows minutes and seconds', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(25)).toBe('0:25');
    expect(clockText(299.4)).toBe('5:00');
    expect(clockText(360)).toBe('6:00');
    expect(clockText(899)).toBe('14:59');
  });
});
