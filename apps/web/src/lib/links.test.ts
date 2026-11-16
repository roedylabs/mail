import { describe, expect, it } from 'vitest';
import { legalLinksOf, linkHref, shortHref } from './links.ts';

describe('linkHref and shortHref', () => {
  it('adds https and allows only http(s)', () => {
    expect(linkHref('example.com/help')).toBe('https://example.com/help');
    expect(linkHref('http://example.com')).toBe('http://example.com/');
    // Without `//` this would mean a path in the app in `href`; the complete address is returned.
    expect(linkHref('https:example.com/imprint')).toBe('https://example.com/imprint');
    expect(linkHref('mailto:a@example.com')).toBeNull();
    expect(linkHref('JavaScript:alert(1)')).toBeNull();
    expect(linkHref('')).toBeNull();
  });

  it('shortens to the host and path', () => {
    expect(shortHref('https://www.example.com/')).toBe('example.com');
    expect(shortHref('example.com/imprint')).toBe('example.com/imprint');
  });
});

describe('legalLinksOf', () => {
  it('takes only checked links of the organisation', () => {
    expect(legalLinksOf({ privacy: 'https://example.com/privacy', imprint: 'javascript:alert(1)' })).toEqual({
      privacy: 'https://example.com/privacy',
      imprint: null,
    });
    expect(legalLinksOf(null)).toEqual({ privacy: null, imprint: null });
  });
});
