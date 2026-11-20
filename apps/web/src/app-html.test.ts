import { describe, expect, it } from 'vitest';
import html from './app.html?raw';

describe('app.html', () => {
  it('lets the on-screen keyboard shrink the layout, so bottom bars stay above it', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    const parts = viewport.split(',').map((part) => part.trim());
    expect(parts).toContain('interactive-widget=resizes-content');
    expect(parts).toContain('width=device-width');
  });
});
