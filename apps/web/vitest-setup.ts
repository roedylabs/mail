import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { network } from '#lib/state/network.svelte.ts';

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
