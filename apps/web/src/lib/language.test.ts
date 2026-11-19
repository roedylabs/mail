import { describe, expect, it, vi } from 'vitest';
import { languageValues, type LanguageContext, type LanguageInput } from './language.ts';
import { m } from '#lib/paraglide/messages.js';
import { prefs, RESET0, type Settings } from './state/prefs.svelte.ts';

/** 1 November 2026, 10:00 UTC – 11:00 CET in Berlin. */
const NOW = Date.UTC(2026, 10, 1, 10, 0);

/** Settings with the formats of Germany, independent of the defaults. */
const GERMANY = {
  lang: 'de',
  region: 'DE',
  tzAuto: true,
  tz: 'Europe/Berlin',
  dateFmt: 'de',
  timeFmt: '24h',
  weekStart: 'monday',
  numFmt: '1.234,56',
} satisfies Partial<Settings>;

function setup(patch: Partial<LanguageInput> = {}, values: Partial<LanguageInput['values']> = {}) {
  const ctx = {
    set: vi.fn(),
    scrollTo: vi.fn(),
    show: vi.fn(),
    mark: vi.fn(),
  } satisfies LanguageContext;
  const input: LanguageInput = {
    values: { ...RESET0, ...GERMANY, ...values },
    now: NOW,
    deviceTz: 'Europe/Berlin',
    open: null,
    hi: null,
    isMobile: false,
    ...patch,
  };
  return { ctx, v: languageValues(input, ctx) };
}

const key = (k: string) => ({ key: k, preventDefault: vi.fn() });

describe('Language & region', () => {
  it('shows the German settings: language, Germany, automatic time zone, formats', () => {
    const { v } = setup();
    expect(v.langTabs.map((t) => t.label)).toEqual(['Language', 'Region', 'Formats']);
    expect(v.langOpts.map((l) => [l.code, l.name, l.sub, l.hasSub, l.on])).toEqual([
      ['DE', m.region_lang_de(), '', false, true],
      ['EN', 'English', 'English', true, false],
    ]);
    expect(v.selRegion).toMatchObject({
      title: 'Country or region',
      label: 'Germany',
      open: false,
      disabled: false,
    });
    expect(v.selRegion.opts).toHaveLength(9);
    expect(v.selRegion.opts[0]).toMatchObject({ label: 'Germany', on: true, fw: 800, hi: true, hasSub: false });
    expect(v.tgTzAuto.on).toBe(true);
    expect(v.selTz).toMatchObject({ title: 'Time zone', label: 'Berlin, Vienna, Zurich (CET)', disabled: true });
    expect(v.selTz.opts.map((o) => o.label)).toEqual([
      'Berlin, Vienna, Zurich',
      'London, Dublin, Lisbon',
      'Athens, Helsinki, Kyiv',
      'New York, Toronto',
      'Los Angeles, Vancouver',
      'Tokyo, Seoul',
    ]);
    expect(v.selTz.opts[0]).toMatchObject({ sub: 'CET', hasSub: true, on: true });
    expect(v.fmtPreview).toEqual([
      { k: 'Date', v: '01.11.2026' },
      { k: 'Time', v: '11:00' },
      { k: 'Number', v: '12.345,67' },
    ]);
    expect(v.dateOpts.map((o) => [o.label, o.on])).toEqual([
      ['01.11.2026', true],
      ['2026-11-01', false],
      ['11/01/2026', false],
    ]);
    expect(v.timeOpts.map((o) => [o.label, o.on])).toEqual([
      ['24-hour', true],
      ['12-hour', false],
    ]);
    expect(v.weekOpts.map((o) => [o.label, o.on])).toEqual([
      ['Monday', true],
      ['Sunday', false],
    ]);
    expect(v.numOpts.map((o) => [o.label, o.on])).toEqual([
      ['1.234,56', true],
      ['1,234.56', false],
      ['1 234,56', false],
    ]);
  });

  it('takes the zone of the device with tzAuto and puts it first if it is not among the choices', () => {
    const { v } = setup({ deviceTz: 'America/Argentina/Buenos_Aires' });
    expect(v.selTz.opts).toHaveLength(7);
    expect(v.selTz.opts[0]).toMatchObject({ label: 'Buenos Aires', on: true });
    expect(v.selTz.label.startsWith('Buenos Aires')).toBe(true);
    // Date and time of the preview in this zone (UTC−3).
    expect(v.fmtPreview[1]?.v).toBe('07:00');
  });

  it('without tzAuto the saved zone applies, the choice is free and saves tz', () => {
    const { v, ctx } = setup({ deviceTz: 'Europe/Berlin' }, { tzAuto: false, tz: 'Asia/Tokyo' });
    expect(v.selTz.disabled).toBe(false);
    expect(v.selTz.label).toBe('Tokyo, Seoul (GMT+9)');
    expect(v.fmtPreview[1]?.v).toBe('19:00');
    v.selTz.opts[1]?.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ tz: 'Europe/London' });
    expect(ctx.show).toHaveBeenCalledWith(null);
  });

  it('the switch keeps the zone of the device when switching off and reports it when switching on', () => {
    const on = setup({ deviceTz: 'Europe/Athens' }, { tz: 'Europe/Athens' });
    on.v.tgTzAuto.onClick();
    expect(on.ctx.set).toHaveBeenCalledWith({ tzAuto: false, tz: 'Europe/Athens' });
    const off = setup({ deviceTz: 'Europe/Athens' }, { tzAuto: false, tz: 'Asia/Tokyo' });
    off.v.tgTzAuto.onClick();
    expect(off.ctx.set).toHaveBeenCalledWith({ tzAuto: true, tz: 'Europe/Athens' });
    // Without a usable zone of the device the saved one stays.
    const none = setup({ deviceTz: undefined }, { tzAuto: false, tz: 'Asia/Tokyo' });
    none.v.tgTzAuto.onClick();
    expect(none.ctx.set).toHaveBeenCalledWith({ tzAuto: true, tz: 'Asia/Tokyo' });
  });

  it('locked (tzAuto) opens the time zone neither by click nor by key', () => {
    const { v, ctx } = setup();
    v.selTz.toggle();
    v.selTz.onKey(key('ArrowDown'));
    expect(ctx.show).not.toHaveBeenCalled();
  });

  it('Country or region: click opens, arrow keys highlight, Enter selects, Tab closes', () => {
    const closed = setup();
    closed.v.selRegion.toggle();
    expect(closed.ctx.show).toHaveBeenCalledWith('region');
    closed.v.selRegion.onKey(key('ArrowDown'));
    expect(closed.ctx.show).toHaveBeenCalledTimes(2);
    expect(closed.ctx.mark).toHaveBeenCalledWith(0);

    const open = setup({ open: 'region', hi: 2 });
    expect(open.v.selRegion.open).toBe(true);
    expect(open.v.selRegion.opts.map((o) => o.hi)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(open.v.selTz.open).toBe(false);
    open.v.selRegion.onKey(key('ArrowUp'));
    expect(open.ctx.mark).toHaveBeenCalledWith(1);
    open.v.selRegion.onKey(key('Enter'));
    expect(open.ctx.set).toHaveBeenCalledWith({ region: 'CH' });
    expect(open.ctx.show).toHaveBeenCalledWith(null);
    open.v.selRegion.onKey(key('Tab'));
    expect(open.ctx.mark).toHaveBeenLastCalledWith(null);
    open.v.selRegion.opts[4]?.hover();
    expect(open.ctx.mark).toHaveBeenLastCalledWith(4);
    open.v.selRegion.toggle();
    expect(open.ctx.show).toHaveBeenLastCalledWith(null);
  });

  it('on mobile the layout shows the sheet: no popover, the button keys do nothing', () => {
    const { v, ctx } = setup({ open: 'region', isMobile: true });
    expect(v.selRegion.open).toBe(false);
    v.selRegion.onKey(key('ArrowDown'));
    v.selRegion.onKey(key('Enter'));
    expect(ctx.mark).not.toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalled();
    v.selRegion.opts[8]?.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ region: 'US' });
    expect(ctx.show).toHaveBeenCalledWith(null);
  });

  it('choose language: English saves `lang`, the chosen one changes nothing', () => {
    const { v, ctx } = setup();
    v.langOpts[0]?.onClick();
    expect(ctx.set).not.toHaveBeenCalled();
    v.langOpts[1]?.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ lang: 'en' });
  });

  it('"system" selects no language card, a click on one replaces it', () => {
    const { v, ctx } = setup({}, { lang: 'system' });
    expect(v.langOpts.filter((l) => l.on)).toEqual([]);
    v.langOpts[0]?.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ lang: 'de' });
  });

  it('in German: texts, name of the other language and zone abbreviations follow the language', () => {
    const de = { locale: 'de' } as const;
    const abbr = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', timeZoneName: 'short' })
      .formatToParts(NOW)
      .find((p) => p.type === 'timeZoneName')?.value;
    prefs.set({ lang: 'de' });
    try {
      const { v } = setup();
      expect(v.langTabs.map((t) => t.label)).toEqual([
        m.region_tab_lang({}, de),
        m.region_tab_region({}, de),
        m.region_tab_formats({}, de),
      ]);
      expect(v.langOpts.map((l) => [l.code, l.name, l.sub, l.on])).toEqual([
        ['DE', m.region_lang_de({}, de), '', true],
        ['EN', m.region_lang_en({}, de), m.region_lang_en_sub({}, de), false],
      ]);
      expect(v.selTz.label).toBe(`${m.region_tz_berlin({}, de)} (${abbr})`);
      expect(v.selRegion.label).toBe(m.region_country_de({}, de));
    } finally {
      prefs.set({ lang: 'en' });
    }
  });

  it('formats: the preview follows the choice, clicks save the chosen values', () => {
    const { v, ctx } = setup({}, { dateFmt: 'us', timeFmt: '12h', numFmt: '1,234.56', weekStart: 'sunday' });
    expect(v.fmtPreview.map((p) => p.v)).toEqual(['11/01/2026', '11:00 AM', '12,345.67']);
    expect(v.dateOpts.find((o) => o.on)?.value).toBe('us');
    v.dateOpts[1]?.onClick();
    v.timeOpts[0]?.onClick();
    v.weekOpts[0]?.onClick();
    v.numOpts[2]?.onClick();
    expect(ctx.set.mock.calls).toEqual([
      [{ dateFmt: 'iso' }],
      [{ timeFmt: '24h' }],
      [{ weekStart: 'monday' }],
      [{ numFmt: '1 234,56' }],
    ]);
  });

  it('tabs scroll to their sections', () => {
    const { v, ctx } = setup();
    v.langTabs.forEach((t) => t.onClick());
    expect(ctx.scrollTo.mock.calls).toEqual([['lang'], ['region'], ['formats']]);
  });
});
