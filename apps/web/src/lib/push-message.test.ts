import { describe, expect, it } from 'vitest';
import { parsePush, safePath, START_PATH } from '#lib/push-message.ts';

describe('safePath', () => {
  it('lets app paths through', () => {
    expect(safePath('/settings/notifications')).toBe('/settings/notifications');
    expect(safePath('/start?x=1#y')).toBe('/start?x=1#y');
    expect(safePath('/mailbox/a1/inbox/%09%2F%2Fevil.example')).toBe('/mailbox/a1/inbox/%09%2F%2Fevil.example');
  });

  it('never leads out of the app', () => {
    for (const url of [
      'https://example.test/',
      '//example.test/x',
      'javascript:alert(1)',
      '/\\example.test',
      // The URL parser drops tab and newlines: these would resolve to "https://evil.example/".
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n/evil.example',
      '/\t\\evil.example',
      '/start\u0000',
      '/start\u007f',
      '',
      7,
      null,
    ]) {
      expect(safePath(url)).toBe(START_PATH);
    }
  });
});

describe('parsePush', () => {
  it('reads the backend message', () => {
    const raw = JSON.stringify({
      title: 'New sign-in',
      body: 'Firefox on Linux',
      icon: '/branding/push-icon.png',
      tag: 'n1',
      data: { url: '/account/security' },
    });
    expect(parsePush(raw, 'mail.example.test')).toEqual({
      title: 'New sign-in',
      body: 'Firefox on Linux',
      icon: '/branding/push-icon.png',
      tag: 'n1',
      url: '/account/security',
    });
  });

  it('shows unreadable messages with the fallback title and then opens /start', () => {
    expect(parsePush('not JSON', 'mail.example.test')).toEqual({
      title: 'mail.example.test',
      body: '',
      url: START_PATH,
    });
    expect(parsePush(null, 'mail.example.test').title).toBe('mail.example.test');
    expect(parsePush('[]', 'mail.example.test').url).toBe(START_PATH);
  });

  it('only takes same-origin icons and omits an empty tag', () => {
    const raw = JSON.stringify({ title: 'T', body: 'B', icon: 'https://example.test/i.png', tag: '', data: {} });
    expect(parsePush(raw, 'x')).toEqual({ title: 'T', body: 'B', url: START_PATH });
  });
});
