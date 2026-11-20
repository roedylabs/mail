import { describe, expect, it } from 'vitest';
import html from './app.html?raw';

describe('app.html', () => {
  it('lets the on-screen keyboard shrink the layout, so bottom bars stay above it', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    const parts = viewport.split(',').map((part) => part.trim());
    expect(parts).toContain('interactive-widget=resizes-content');
    // Edge to edge: the page colours the navigation bar behind it (layouts keep clear of it via --sab).
    expect(parts).toContain('viewport-fit=cover');
    expect(parts).toContain('width=device-width');
  });
});
