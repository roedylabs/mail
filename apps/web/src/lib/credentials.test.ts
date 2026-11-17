import { describe, expect, it } from 'vitest';
import { credBad } from './credentials.ts';

describe('credBad', () => {
  it('accepts printable values up to 1024 bytes', () => {
    expect(credBad('')).toBe(false);
    expect(credBad('roedy-abc')).toBe(false);
    expect(credBad('a'.repeat(1024))).toBe(false);
    expect(credBad('ä'.repeat(512))).toBe(false);
  });

  it('rejects control characters and more than 1024 bytes', () => {
    expect(credBad('roedy\tabc')).toBe(true);
    expect(credBad('roedy\nabc')).toBe(true);
    expect(credBad('roedy\u007fabc')).toBe(true);
    expect(credBad('roedy\u0085abc')).toBe(true);
    expect(credBad('a'.repeat(1025))).toBe(true);
    expect(credBad('ä'.repeat(513))).toBe(true);
  });
});
