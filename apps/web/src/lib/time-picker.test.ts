import { minutesOf } from '#lib/quiet-hours.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanInput,
  clockLabel,
  parseTime,
  stepTime,
  timePickValues,
  type TimeKeyEvent,
  type TimePickContext,
  type TimePickInput,
} from './time-picker.ts';

function input(over: Partial<TimePickInput> = {}): TimePickInput {
  return {
    title: 'Beginn der Ruhezeiten',
    value: '22:00',
    disabled: false,
    h12: false,
    open: false,
    edit: null,
    isMobile: false,
    ...over,
  };
}

function context() {
  return {
    set: vi.fn<TimePickContext['set']>(),
    show: vi.fn<TimePickContext['show']>(),
    edit: vi.fn<TimePickContext['edit']>(),
  } satisfies TimePickContext;
}

function key(k: string, shiftKey = false) {
  return {
    key: k,
    shiftKey,
    preventDefault: vi.fn(),
    blur: vi.fn(),
  } satisfies TimeKeyEvent;
}

describe('clockLabel (clockText)', () => {
  it('shows HH:MM in the 24-hour format', () => {
    expect(clockLabel('07:00', false)).toBe('07:00');
    expect(clockLabel('22:30', false)).toBe('22:30');
    expect(clockLabel('7:5', false)).toBe('07:05');
    expect(clockLabel('', false)).toBe('00:00');
  });

  it('shows AM/PM in the 12-hour format', () => {
    expect(clockLabel('22:00', true)).toBe('10:00 PM');
    expect(clockLabel('07:00', true)).toBe('7:00 AM');
    expect(clockLabel('00:15', true)).toBe('12:15 AM');
    expect(clockLabel('12:00', true)).toBe('12:00 PM');
  });
});

describe('parseTime', () => {
  it('reads times with colon, dot, without separator and hours only', () => {
    expect(parseTime('22:30')).toBe('22:30');
    expect(parseTime('7.5')).toBe('07:05');
    expect(parseTime('2230')).toBe('22:30');
    expect(parseTime('730')).toBe('07:30');
    expect(parseTime('7')).toBe('07:00');
  });

  it('reads AM and PM', () => {
    expect(parseTime('10:30 PM')).toBe('22:30');
    expect(parseTime('10:30 pm')).toBe('22:30');
    expect(parseTime('7a')).toBe('07:00');
    expect(parseTime('12 am')).toBe('00:00');
    expect(parseTime('12:15 p.m.')).toBe('12:15');
  });

  it('rejects invalid times', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('13 PM')).toBeNull();
    expect(parseTime('0 AM')).toBeNull();
    expect(parseTime('12:')).toBeNull();
    expect(parseTime('12345')).toBeNull();
  });
});

describe('stepTime, minutesOf, cleanInput', () => {
  it('shifts across midnight', () => {
    expect(stepTime('22:00', 5)).toBe('22:05');
    expect(stepTime('23:58', 5)).toBe('00:03');
    expect(stepTime('00:02', -5)).toBe('23:57');
    expect(stepTime('00:30', -60)).toBe('23:30');
    expect(minutesOf('07:00')).toBe(420);
  });

  it('keeps only allowed characters', () => {
    expect(cleanInput('22:3x0', false)).toBe('22:30');
    expect(cleanInput('22:300', false)).toBe('22:30');
    expect(cleanInput('10:30 PMx', true)).toBe('10:30 PM');
    expect(cleanInput('10:30 p.m.', true)).toBe('10:30 p.');
  });
});

describe('timePickValues', () => {
  it('shows value, columns and state in the 24-hour format', () => {
    const v = timePickValues(input(), context());
    expect(v).toMatchObject({
      title: 'Beginn der Ruhezeiten',
      label: '22:00',
      hh: '22',
      mm: '00',
      inputVal: '22:00',
      h24: true,
      open: false,
      disabled: false,
    });
    expect(v.hours).toHaveLength(24);
    expect(v.mins).toHaveLength(60);
    expect(v.hours[0]).toMatchObject({ label: '00', on: false, fw: 600 });
    expect(v.hours[22]).toMatchObject({ label: '22', on: true, fw: 800 });
    expect(v.mins[0]).toMatchObject({ label: '00', on: true, fw: 800 });
    expect(v.mins.filter((c) => c.on)).toHaveLength(1);
  });

  it('shows hours with AM/PM in the 12-hour format', () => {
    const v = timePickValues(input({ h12: true, value: '07:00' }), context());
    expect(v.label).toBe('7:00 AM');
    expect(v.inputVal).toBe('7:00 AM');
    expect(v.h24).toBe(false);
    expect(v.hours.map((c) => c.label).slice(0, 2)).toEqual(['12 AM', '1 AM']);
    expect(v.hours[12]?.label).toBe('12 PM');
    expect(v.hours[23]?.label).toBe('11 PM');
    expect(v.hours[7]?.on).toBe(true);
  });

  it('shows the typed text as long as there is one', () => {
    expect(timePickValues(input({ edit: '22:3' }), context()).inputVal).toBe('22:3');
  });

  it('opens the popover only on the desktop', () => {
    expect(timePickValues(input({ open: true }), context()).open).toBe(true);
    expect(timePickValues(input({ open: true, isMobile: true }), context()).open).toBe(false);
  });

  it('opens and closes via the clock and the focus', () => {
    const ctx = context();
    timePickValues(input(), ctx).toggle();
    expect(ctx.edit).toHaveBeenLastCalledWith(null);
    expect(ctx.show).toHaveBeenLastCalledWith(true);
    timePickValues(input({ open: true }), ctx).toggle();
    expect(ctx.show).toHaveBeenLastCalledWith(false);

    ctx.show.mockClear();
    timePickValues(input(), ctx).onFocus();
    expect(ctx.show).toHaveBeenCalledWith(true);
    ctx.show.mockClear();
    // On mobile only the clock opens the sheet, not the focus.
    timePickValues(input({ isMobile: true }), ctx).onFocus();
    expect(ctx.show).not.toHaveBeenCalled();
    timePickValues(input({ isMobile: true }), ctx).toggle();
    expect(ctx.show).toHaveBeenCalledWith(true);
  });

  it('disabled: neither opening nor input nor arrows', () => {
    const ctx = context();
    const v = timePickValues(input({ disabled: true }), ctx);
    v.toggle();
    v.onFocus();
    expect(v.onInput('23:00')).toBe('23:00');
    v.onKey(key('ArrowUp'));
    expect(ctx.show).not.toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalled();
    expect(ctx.edit).not.toHaveBeenCalled();
  });

  it('applies valid input immediately and remembers the typed text', () => {
    const ctx = context();
    const v = timePickValues(input(), ctx);
    expect(v.onInput('23:1')).toBe('23:1');
    expect(ctx.set).toHaveBeenLastCalledWith('23:01');
    expect(ctx.edit).toHaveBeenLastCalledWith('23:1');
    ctx.set.mockClear();
    expect(v.onInput('2x')).toBe('2');
    expect(ctx.set).toHaveBeenLastCalledWith('02:00');
    ctx.set.mockClear();
    expect(v.onInput('25')).toBe('25');
    expect(ctx.set).not.toHaveBeenCalled();
    expect(ctx.edit).toHaveBeenLastCalledWith('25');
    v.onBlur();
    expect(ctx.edit).toHaveBeenLastCalledWith(null);
  });

  it('reads AM/PM in the 12-hour format', () => {
    const ctx = context();
    timePickValues(input({ h12: true }), ctx).onInput('6:30 pm');
    expect(ctx.set).toHaveBeenLastCalledWith('18:30');
  });

  it('keyboard: arrows ±5 or with ⇧ ±60 minutes, Enter, Escape and Tab close', () => {
    const ctx = context();
    const v = timePickValues(input({ value: '23:58', open: true }), ctx);
    const up = key('ArrowUp');
    v.onKey(up);
    expect(up.preventDefault).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenLastCalledWith('00:03');
    expect(ctx.edit).toHaveBeenLastCalledWith(null);
    v.onKey(key('ArrowDown'));
    expect(ctx.set).toHaveBeenLastCalledWith('23:53');
    v.onKey(key('ArrowUp', true));
    expect(ctx.set).toHaveBeenLastCalledWith('00:58');
    v.onKey(key('ArrowDown', true));
    expect(ctx.set).toHaveBeenLastCalledWith('22:58');
    expect(ctx.show).not.toHaveBeenCalled();

    const enter = key('Enter');
    v.onKey(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(enter.blur).toHaveBeenCalled();
    expect(ctx.show).toHaveBeenLastCalledWith(false);
    const esc = key('Escape');
    v.onKey(esc);
    expect(esc.blur).toHaveBeenCalled();
    expect(esc.preventDefault).not.toHaveBeenCalled();
    ctx.show.mockClear();
    const tab = key('Tab');
    v.onKey(tab);
    expect(ctx.show).toHaveBeenCalledWith(false);
    expect(tab.blur).not.toHaveBeenCalled();
    ctx.show.mockClear();
    v.onKey(key('a'));
    expect(ctx.show).not.toHaveBeenCalled();
  });

  it('hour selects and stays open, minute closes on the desktop', () => {
    const ctx = context();
    const v = timePickValues(input({ open: true }), ctx);
    v.hours[23]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith('23:00');
    expect(ctx.edit).toHaveBeenLastCalledWith(null);
    expect(ctx.show).not.toHaveBeenCalled();
    v.mins[30]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith('22:30');
    expect(ctx.show).toHaveBeenLastCalledWith(false);
  });

  it('minute leaves the sheet open on mobile; "Done" closes', () => {
    const ctx = context();
    const v = timePickValues(input({ isMobile: true, open: true }), ctx);
    v.mins[15]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith('22:15');
    expect(ctx.edit).toHaveBeenLastCalledWith(null);
    expect(ctx.show).not.toHaveBeenCalled();
    v.close();
    expect(ctx.show).toHaveBeenCalledWith(false);
  });
});
