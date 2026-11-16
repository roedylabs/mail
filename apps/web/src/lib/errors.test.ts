import { describe, expect, it } from 'vitest';
import { JmapError } from '@roedy/jmap';
import { ApiError, NetworkError } from '#lib/api.ts';
import { ERRS, errorCodeOf, errorDetails, failText, isOffline, timeText } from './errors.ts';

describe('errorCodeOf', () => {
  it('maps HTTP statuses to the error pages', () => {
    expect(errorCodeOf(404)).toBe('404');
    expect(errorCodeOf(403)).toBe('403');
    expect(errorCodeOf(500)).toBe('500');
    expect(errorCodeOf(502)).toBe('500');
    expect(errorCodeOf(400)).toBe('500');
  });
});

describe('ERRS', () => {
  it('returns the texts of the error pages', () => {
    expect(ERRS['404'].title()).toBe('Page not found');
    expect(ERRS.offline.text()).toBe('Check your internet connection and try again.');
    expect(ERRS['500'].retry).toBe(true);
  });
});

describe('details of the error page', () => {
  const env = {
    version: '0.1.0',
    build: 'abc1234',
    mobile: false,
    width: 1440,
    height: 900,
    path: '/password/reset/gueltiger-token',
    browser: 'Test Browser',
    timeZone: 'Europe/Berlin',
    language: 'de',
    region: 'Germany',
  };

  it('names environment and view without a token from the mail', () => {
    expect(errorDetails('500', env).split('\n')).toEqual([
      'Error 500',
      'Version: 0.1.0 · Build abc1234',
      'Layout: Desktop',
      'Screen: 1440 × 900 px',
      'View: /password/reset/…',
      'Browser: Test Browser',
      'Time zone: Europe/Berlin',
      'Language: DE · Germany',
    ]);
  });

  it('shows the time in the time zone and format of the account', () => {
    const at = new Date('2026-10-26T18:44:00Z');
    expect(timeText(at, { tzAuto: false, tz: 'Europe/Berlin', timeFmt: '24h' })).toBe('19:44');
    expect(timeText(at, { tzAuto: false, tz: 'America/New_York', timeFmt: '24h' })).toBe('14:44');
    expect(timeText(at, { tzAuto: false, tz: 'America/New_York', timeFmt: '12h' })).toMatch(/^2:44\sPM$/);
  });
});

describe('text of the error toast', () => {
  const answered = new ApiError(500, { error: 'internal' });

  it('counts as offline only without a server response, not for errors in the code', () => {
    expect(isOffline(new NetworkError(new TypeError('Failed to fetch')))).toBe(true);
    expect(isOffline(new JmapError('unreachable'))).toBe(true);
    expect(isOffline(new JmapError('forbidden'))).toBe(false);
    expect(isOffline(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isOffline(undefined)).toBe(false);
    expect(isOffline(answered)).toBe(false);
    expect(isOffline(new ApiError(401, { error: 'unauthorized' }))).toBe(false);
  });

  it('names “No connection” without a connection, otherwise the text of the caller', () => {
    expect(failText(answered)).toBe('That didn’t work. Please try again.');
    expect(failText(answered, 'The list could not be refreshed.')).toBe('The list could not be refreshed.');
    expect(failText(new NetworkError(new TypeError('Failed to fetch')))).toBe('No connection. Please try again.');
    expect(failText(new NetworkError(new TypeError('Failed to fetch')), 'The list could not be refreshed.')).toBe(
      'No connection. Please try again.',
    );
  });
});
