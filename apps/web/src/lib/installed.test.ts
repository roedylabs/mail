import { describe, expect, it } from 'vitest';
import { isInstalled } from './installed.ts';

const win = (standalone: boolean | undefined, matches?: boolean) =>
  ({
    navigator: { standalone },
    matchMedia:
      matches === undefined ? undefined : (query: string) => ({ matches: matches && query.includes('standalone') }),
  }) as unknown as Pick<typeof globalThis, 'matchMedia' | 'navigator'>;

describe('isInstalled', () => {
  it('detects the app in a window without a browser bar', () => {
    expect(isInstalled(win(undefined, true))).toBe(true);
  });

  it('detects the app on the iOS home screen', () => {
    expect(isInstalled(win(true, false))).toBe(true);
    expect(isInstalled(win(true))).toBe(true);
  });

  it('does not count the browser tab', () => {
    expect(isInstalled(win(false, false))).toBe(false);
    expect(isInstalled(win(undefined, false))).toBe(false);
  });

  it('does without `matchMedia`', () => {
    expect(isInstalled(win(undefined))).toBe(false);
  });
});
