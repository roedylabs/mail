import { beforeEach, describe, expect, it, vi } from 'vitest';
import { START_COPY_KEY, forgetStartCopy, readStartCopy, saveStartCopy, type StartCopy } from './start-copy.ts';

const COPY = {
  config: { name: 'Roedy Mail' },
  user: { id: 'u1' },
  accounts: [],
  settings: { version: 1, settings: {} },
} as unknown as StartCopy;

beforeEach(() => {
  localStorage.clear();
});

describe('Copy for starting without network', () => {
  it('reads what is stored and forgets it again', () => {
    expect(readStartCopy()).toBeNull();
    saveStartCopy(COPY);
    expect(readStartCopy()).toMatchObject(COPY);
    forgetStartCopy();
    expect(readStartCopy()).toBeNull();
  });

  it('discards unreadable data and copies of another format', () => {
    localStorage.setItem(START_COPY_KEY, '{broken');
    expect(readStartCopy()).toBeNull();
    localStorage.setItem(START_COPY_KEY, JSON.stringify({ ...COPY, format: 0 }));
    expect(readStartCopy()).toBeNull();
    localStorage.setItem(START_COPY_KEY, JSON.stringify({ format: 1, config: {} }));
    expect(readStartCopy()).toBeNull();
  });

  it('skips a full storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => saveStartCopy(COPY)).not.toThrow();
    setItem.mockRestore();
  });
});
