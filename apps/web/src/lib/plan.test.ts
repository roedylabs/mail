import { describe, expect, it } from 'vitest';
import {
  holdUntil,
  PLAN_CAP_MS,
  planDuration,
  planEarliest,
  planLimit,
  planPresets,
  planRefusal,
  planWhen,
} from './plan.ts';

const DAY = 86_400_000;
const BERLIN = { tz: 'Europe/Berlin', timeFmt: '24h' } as const;
const at = (iso: string) => Date.parse(iso);

describe('limit of the send time', () => {
  it('takes the smaller of maxDelayedSend and 7 days, 7 days without a value', () => {
    expect(planLimit(2_592_000)).toBe(PLAN_CAP_MS);
    expect(planLimit(null)).toBe(7 * DAY);
    expect(planLimit(86_400)).toBe(DAY);
    expect(planLimit(0)).toBe(0);
  });

  it('names the limit as a duration', () => {
    expect(planDuration(7 * DAY)).toBe('7 days');
    expect(planDuration(DAY)).toBe('1 day');
    expect(planDuration(12 * 3_600_000)).toBe('12 hours');
    expect(planDuration(3_600_000)).toBe('1 hour');
  });

  it('starts at the next full minute after now plus one minute', () => {
    expect(planEarliest(at('2026-11-02T09:00:30Z'))).toBe(at('2026-11-02T09:02:00Z'));
    expect(planEarliest(at('2026-11-02T09:00:00Z'))).toBe(at('2026-11-02T09:01:00Z'));
  });
});

describe('presets in the time zone from Language & region', () => {
  it('offers tomorrow 8 am and 1 pm and Monday 8 am', () => {
    // Wednesday, 4 Nov 2026, 10:00 in Berlin.
    const list = planPresets(at('2026-11-04T09:00:00Z'), 'Europe/Berlin');
    expect(list.map((p) => [p.key, p.label, p.icon, new Date(p.at).toISOString()])).toEqual([
      ['morning', 'Tomorrow morning', 'ti-sunrise', '2026-11-05T07:00:00.000Z'],
      ['afternoon', 'Tomorrow afternoon', 'ti-sun', '2026-11-05T12:00:00.000Z'],
      ['monday', 'Monday morning', 'ti-calendar-week', '2026-11-09T07:00:00.000Z'],
    ]);
  });

  it('omits "Monday morning" on Sundays and takes the next Monday on Mondays', () => {
    expect(planPresets(at('2026-11-08T09:00:00Z'), 'Europe/Berlin').map((p) => p.key)).toEqual([
      'morning',
      'afternoon',
    ]);
    // Monday 7:30: "Monday morning" is 7 days and 30 minutes ahead (above the limit).
    const monday = at('2026-11-09T06:30:00Z');
    const next = planPresets(monday, 'Europe/Berlin').find((p) => p.key === 'monday');
    expect(next?.at).toBe(at('2026-11-16T07:00:00Z'));
    expect((next?.at ?? 0) - monday).toBeGreaterThan(PLAN_CAP_MS);
  });

  it('calculates in the time zone of the settings, not that of the device', () => {
    // 23:30 in Berlin is already the next day in Tokyo.
    const now = at('2026-11-04T22:30:00Z');
    expect(new Date(planPresets(now, 'Asia/Tokyo')[0]?.at ?? 0).toISOString()).toBe('2026-11-05T23:00:00.000Z');
    expect(new Date(planPresets(now, 'Europe/Berlin')[0]?.at ?? 0).toISOString()).toBe('2026-11-05T07:00:00.000Z');
  });

  it('describes times as today, tomorrow or a date', () => {
    const now = at('2026-11-04T09:00:00Z');
    expect(planWhen(at('2026-11-04T15:00:00Z'), now, BERLIN)).toBe('Today, 16:00');
    expect(planWhen(at('2026-11-05T07:00:00Z'), now, BERLIN)).toBe('Tomorrow, 08:00');
    expect(planWhen(at('2026-11-09T07:00:00Z'), now, BERLIN)).toBe('Mon 9 Nov, 08:00');
    expect(planWhen(at('2026-11-05T07:00:00Z'), now, { tz: 'Europe/Berlin', timeFmt: '12h' })).toBe(
      'Tomorrow, 8:00 AM',
    );
  });
});

describe('submission and rejection', () => {
  it('writes HOLDUNTIL per RFC 3339 in UTC without fractional seconds', () => {
    expect(holdUntil(at('2026-11-05T07:00:00.250Z'))).toBe('2026-11-05T07:00:00Z');
  });

  it('recognizes the Stalwart reasons by the text of forbiddenMailFrom', () => {
    const refused = (description: string, type = 'forbiddenMailFrom') => planRefusal({ type, description });
    expect(refused('Server rejected MAIL-FROM: 501 5.5.4 FUTURERELEASE extension has been disabled.')).toBe('ext');
    expect(
      refused(
        'Server rejected MAIL-FROM: 501 5.5.4 Requested release time exceeds maximum of 2026-11-09T09:00:00+00:00.',
      ),
    ).toBe('over');
    expect(refused('Server rejected MAIL-FROM: 501 5.5.4 HOLDUNTIL must be a date and time in the future.')).toBe(
      'past',
    );
    expect(refused('Server rejected MAIL-FROM: 552 5.3.4 Message size exceeds maximum.')).toBeNull();
    expect(refused('FUTURERELEASE extension has been disabled.', 'forbiddenFrom')).toBeNull();
    expect(planRefusal({ type: 'forbiddenMailFrom' })).toBeNull();
  });
});
