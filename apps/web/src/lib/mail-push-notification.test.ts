import { describe, expect, it } from 'vitest';
import {
  authNotice,
  blindNotice,
  isQuiet,
  mailNotice,
  mailTag,
  MAX_MAILS,
  mergeMails,
  needsEveryNotice,
  openMails,
  type MailContext,
  type MailSummary,
} from '#lib/mail-push-notification.ts';

const CTX: MailContext = { id: 'm 1', email: 'user@example.com', multi: false, silent: false, appName: 'Roedy Mail' };

function mail(id: string, from = 'Anna', subject = 'Hello'): MailSummary {
  return { id, thread: `t-${id}`, from, subject };
}

describe('mailNotice', () => {
  it('shows a mail with sender and subject and leads to its conversation', () => {
    const { title, options } = mailNotice([mail('a')], CTX);
    expect(title).toBe('Anna');
    expect(options).toMatchObject({
      body: 'Hello',
      icon: '/branding/push-icon.png',
      tag: 'mail-m 1',
      renotify: true,
      silent: false,
      data: { url: '/mailbox/m%201/inbox/t-a' },
    });
  });

  it('knows mails without sender and without subject', () => {
    const { title, options } = mailNotice([mail('a', '', '')], CTX);
    expect(title).toBe('Unknown');
    expect(options.body).toBe('(No subject)');
  });

  it('summarizes several mails and leads to the inbox', () => {
    const { title, options } = mailNotice([mail('a'), mail('b', 'Ben')], CTX);
    expect(title).toBe('2 new emails');
    expect(options.body).toBe('From Anna and Ben');
    expect((options.data as { url: string }).url).toBe('/mailbox/m%201/inbox');
  });

  it('names each sender once and counts the rest', () => {
    const body = (...names: string[]) =>
      mailNotice(
        names.map((name, i) => mail(String(i), name)),
        CTX,
      ).options.body;
    expect(body('Anna', 'Anna')).toBe('From Anna');
    expect(body('Anna', 'Ben', 'Cem')).toBe('From Anna, Ben, and one other');
    expect(body('Anna', 'Ben', 'Cem', 'Dora')).toBe('From Anna, Ben, and 2 others');
    expect(body('', '')).toBe('From Unknown');
  });

  it('names the account with several accounts and stays silent during quiet hours', () => {
    const { options } = mailNotice([mail('a')], { ...CTX, multi: true, silent: true });
    expect(options.body).toBe('Hello\nuser@example.com');
    expect(options.silent).toBe(true);
  });
});

describe('blindNotice and authNotice', () => {
  it('shows only the account without fetching', () => {
    expect(blindNotice(CTX)).toMatchObject({
      title: 'New email',
      options: { body: 'user@example.com', tag: 'mail-m 1', data: { url: '/mailbox/m%201/inbox' } },
    });
    expect(blindNotice({ ...CTX, email: '' }).options.body).toBe('Roedy Mail');
  });

  it('leads to the connection, with its own tag and without a repeated sound', () => {
    const { title, options } = authNotice({ ...CTX, silent: true });
    expect(title).toBe('Sign-in required');
    expect(options).toMatchObject({
      body: 'Sign in to user@example.com again.',
      tag: 'mail-auth-m 1',
      silent: true,
      data: { url: '/account/mail-accounts/m%201/connection' },
    });
    expect(options.renotify).toBeUndefined();
  });
});

describe('open notification', () => {
  it('reads only its own data', () => {
    expect(openMails({ mails: [mail('a')] })).toEqual([mail('a')]);
    expect(openMails({ url: '/start' })).toEqual([]);
    expect(openMails(null)).toEqual([]);
  });

  it('puts new ones first, names each mail once and stays limited', () => {
    expect(mergeMails([mail('b')], [mail('a'), mail('b')]).map(({ id }) => id)).toEqual(['b', 'a']);
    const many = Array.from({ length: MAX_MAILS + 5 }, (_, i) => mail(String(i)));
    expect(mergeMails([], many)).toHaveLength(MAX_MAILS);
  });

  it('has one tag per account', () => {
    expect(mailTag('m1')).toBe('mail-m1');
  });
});

describe('isQuiet', () => {
  const quiet = { on: true, from: '22:00', to: '07:00', tz: 'Europe/Berlin' };
  const at = (time: string) => Date.parse(`2026-11-06T${time}:00+01:00`);

  it('calculates in the time zone of the settings, also across midnight', () => {
    expect(isQuiet(quiet, at('23:30'))).toBe(true);
    expect(isQuiet(quiet, at('06:59'))).toBe(true);
    expect(isQuiet(quiet, at('07:00'))).toBe(false);
    expect(isQuiet({ ...quiet, tz: 'America/New_York' }, at('23:30'))).toBe(false);
  });

  it('knows switched-off quiet hours and start = end', () => {
    expect(isQuiet({ ...quiet, on: false }, at('23:30'))).toBe(false);
    expect(isQuiet({ ...quiet, to: '22:00' }, at('23:30'))).toBe(false);
  });
});

describe('needsEveryNotice', () => {
  it('applies to WebKit, not to Chromium or Firefox', () => {
    const webkit = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(needsEveryNotice(`${webkit} Version/18.0 Safari/605.1.15`)).toBe(true);
    expect(needsEveryNotice(`${webkit} CriOS/130.0 Mobile/15E148 Safari/604.1`)).toBe(true);
    expect(needsEveryNotice('Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe(false);
    expect(needsEveryNotice('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe(false);
  });
});
