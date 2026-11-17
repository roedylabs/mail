import { describe, expect, it } from 'vitest';
import { forgetRegistered } from '#lib/state/forget.ts';
import { Kept } from '#lib/state/kept.ts';

describe('Kept', () => {
  it('keeps the data of the last page until the session ends', () => {
    const kept = new Kept<string[]>();
    expect(kept.value).toBeNull();
    kept.keeper()(['a']);
    kept.keeper()(['b']);
    expect(kept.value).toEqual(['b']);
    forgetRegistered();
    expect(kept.value).toBeNull();
  });

  it('a page opened before the session ended keeps nothing afterwards', () => {
    const kept = new Kept<string>();
    const before = kept.keeper();
    kept.forget();
    before('old');
    expect(kept.value).toBeNull();
    kept.keeper()('new');
    expect(kept.value).toBe('new');
  });
});
