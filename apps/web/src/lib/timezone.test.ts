import { describe, expect, it } from 'vitest';
import { fromLocalInput, toLocalInput, zoneDayStart, zoneName, zoneParts, zoneTime } from './timezone.ts';

const at = (iso: string) => Date.parse(iso);

describe('wall clock in a time zone', () => {
  it('splits a time into date, time of day and weekday of the zone', () => {
    // 2026-11-02 is a Monday.
    expect(zoneParts(at('2026-11-01T23:30:00Z'), 'Europe/Berlin')).toEqual({
      y: 2026,
      mo: 11,
      d: 2,
      h: 0,
      mi: 30,
      s: 0,
      wd: 1,
    });
    expect(zoneParts(at('2026-11-01T23:30:00Z'), 'America/New_York')).toMatchObject({ d: 1, h: 18, wd: 0 });
  });

  it('converts a wall clock into a point in time, also with day overflow', () => {
    expect(zoneTime(2026, 11, 3, 8, 0, 'Europe/Berlin')).toBe(at('2026-11-03T07:00:00Z'));
    expect(zoneTime(2026, 11, 3, 8, 0, 'Asia/Tokyo')).toBe(at('2026-11-02T23:00:00Z'));
    expect(zoneTime(2026, 11, 31, 8, 0, 'Europe/Berlin')).toBe(at('2026-12-01T07:00:00Z'));
  });

  it('follows the clock change: before and after the switch the respective offset applies', () => {
    // Summer time ends on 25 Oct 2026 at 3:00 (MESZ → MEZ).
    expect(zoneTime(2026, 10, 24, 8, 0, 'Europe/Berlin')).toBe(at('2026-10-24T06:00:00Z'));
    expect(zoneTime(2026, 10, 26, 8, 0, 'Europe/Berlin')).toBe(at('2026-10-26T07:00:00Z'));
    // The gap at the start of summer time (29 Mar 2026, 2:00–3:00) counts as after the change.
    const gap = zoneTime(2026, 3, 29, 2, 30, 'Europe/Berlin');
    expect(zoneParts(gap, 'Europe/Berlin')).toMatchObject({ d: 29, h: 3, mi: 30 });
  });

  it('names the start of the calendar day in the zone', () => {
    expect(zoneDayStart(at('2026-11-02T06:15:00Z'), 'Asia/Tokyo')).toBe(at('2026-11-01T15:00:00Z'));
  });

  it('reads and writes datetime-local values in the zone', () => {
    const t = at('2026-11-02T07:00:00Z');
    expect(toLocalInput(t, 'Europe/Berlin')).toBe('2026-11-02T08:00');
    expect(toLocalInput(t, 'Asia/Tokyo')).toBe('2026-11-02T16:00');
    expect(fromLocalInput('2026-11-02T08:00', 'Europe/Berlin')).toBe(t);
    expect(fromLocalInput('2026-11-02T16:00', 'Asia/Tokyo')).toBe(t);
    expect(fromLocalInput('', 'Europe/Berlin')).toBeNaN();
    expect(fromLocalInput('tomorrow', 'Europe/Berlin')).toBeNaN();
  });

  it("uses the device's zone for an unknown zone", () => {
    const t = at('2026-11-02T07:00:00Z');
    expect(zoneParts(t, 'Moon/Base')).toEqual(zoneParts(t, ''));
  });

  it('names time zones like Language & region, otherwise by place', () => {
    const t = at('2026-11-02T07:00:00Z');
    expect(zoneName('Asia/Tokyo', t)).toBe('Tokyo, Seoul (GMT+9)');
    expect(zoneName('Europe/Berlin', t)).toBe('Berlin, Vienna, Zurich (CET)');
    expect(zoneName('America/Argentina/Buenos_Aires', t)).toBe('Buenos Aires (GMT-3)');
    expect(zoneName('Moon/Base', t)).toBe('Base');
    // No hit in Object.prototype.
    expect(zoneName('toString', t)).toBe('toString');
  });
});
