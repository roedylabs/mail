import '@testing-library/jest-dom/vitest';
import { beforeEach, expect } from 'vitest';
import { network } from '#lib/state/network.svelte.ts';

declare module 'vitest' {
  // The type parameters must match the declaration in vitest.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /**
     * Checks the inline styles as the component sets them. `toHaveStyle` reads
     * the computed style, in which jsdom resolves `var()` and drops values it
     * does not support (e.g. `cqmin`).
     */
    toHaveInlineStyle(expected: Record<string, string>): R;
  }
}

const kebab = (prop: string) => (prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

expect.extend({
  toHaveInlineStyle(received: Element | null, expected: Record<string, string>) {
    const style = (received as HTMLElement | null)?.style;
    const actual = Object.fromEntries(
      Object.keys(expected).map((prop) => [prop, style?.getPropertyValue(kebab(prop)) ?? '']),
    );
    const pass = this.equals(actual, expected);
    return {
      pass,
      actual,
      expected,
      message: () =>
        `expected element ${pass ? 'not ' : ''}to have inline style ${this.utils.printExpected(expected)}, ` +
        `received ${this.utils.printReceived(actual)}`,
    };
  },
});

// The tests check the English texts (device language, `#lib/locale.ts`).
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
}

// jsdom lacks matchMedia; svelte/reactivity/window uses it on load.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

// jsdom lacks ResizeObserver; `bind:clientWidth` needs it (setup page).
if (typeof window !== 'undefined' && typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Unmocked requests fail in Node on relative URLs; their outcome (`appFetch`)
// would otherwise count as "connection lost" in the next test.
beforeEach(() => {
  network.reached = new Map();
});
