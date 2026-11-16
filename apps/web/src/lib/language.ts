/**
 * Values of the Settings › Language & region page: language (`langOpts`, German
 * and English), country or region (`selRegion`), time zone (`tgTzAuto`,
 * `selTz`) and formats (`dateOpts`, `timeOpts`, `weekOpts`, `numOpts` with the
 * preview `fmtPreview`). Changes go through `prefs.set()`; English identifiers
 * are stored (countries per ISO 3166-1), the texts from
 * `messages/<language>.json` are shown. The language itself can also be chosen
 * in the account menu (`langSeg`, the same `langChoices()`).
 *
 * With `tzAuto` the zone of the device applies (`tzCur`); `prefs` reports it to
 * the server as `tz` so that the mails show the same time. Region and number
 * format only affect the preview; time, time zone and week start affect list,
 * reading view and mails, the date format everywhere a date is shown in digits
 * (`formatDate()` from `#lib/date.ts`).
 *
 * Country and time zone are select lists: on desktop a popover, on mobile a
 * sheet (`ui.pick`); both hang on the menu `pick`, the page remembers which one
 * is open (`open`).
 */
import type { SegOption } from '#lib/appearance.ts';
import { formatDate } from '#lib/date.ts';
import { clock } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { segOptions as seg, selectValues as select, type SelectValues } from '#lib/select.ts';
import { TIME_FMTS, WEEK_STARTS } from '#lib/settings-choices.ts';
import { REGIONS, displayZone, type Region, type Settings } from '#lib/state/prefs.svelte.ts';
import { ZONES, zoneAbbr, zoneLabel } from '#lib/timezone.ts';

export { TIME_FMTS, WEEK_STARTS };

/** Sections of the page (`data-sec`, `langTabs`). */
export type LanguageSection = 'lang' | 'region' | 'formats';

/** Select lists of the page (`sel:region`, `sel:tz`). */
export type SelectKey = 'region' | 'tz';

export type { SelectValues };

export { REGIONS, type Region };

export const DATE_FMTS = ['de', 'iso', 'us'] as const;

/** Number formats (`NUM_FMTS`) with the example of the preview. */
export const NUM_FMTS: Readonly<Record<string, string>> = {
  '1.234,56': '12.345,67',
  '1,234.56': '12,345.67',
  '1 234,56': '12 345,67',
};

interface Lang {
  id: Settings['lang'];
  code: string;
  /** Name in the language itself ("Deutsch", "English"). */
  name: () => string;
  /** Name in the UI language; only shown if it differs (`sub`). */
  sub: () => string;
}

/** Languages (`LANGS`). */
const LANGS: readonly Lang[] = [
  { id: 'de', code: 'DE', name: m.region_lang_de, sub: m.region_lang_de_sub },
  { id: 'en', code: 'EN', name: m.region_lang_en, sub: m.region_lang_en_sub },
];

/** Language as a card (page) or segment (account menu, `langSeg`). */
export interface LangChoice {
  id: Settings['lang'];
  code: string;
  name: string;
  /** Name in the UI language, empty for the chosen one ("English" – "English"). */
  sub: string;
  on: boolean;
  onClick: () => void;
}

/** Languages with selection; a change applies at once (`prefs.set`), without undo. */
export function langChoices(lang: Settings['lang'], set: (patch: Partial<Settings>) => void): LangChoice[] {
  return LANGS.map((l) => ({
    id: l.id,
    code: l.code,
    name: l.name(),
    sub: l.id === lang ? '' : l.sub(),
    on: l.id === lang,
    onClick: () => {
      if (l.id !== lang) set({ lang: l.id });
    },
  }));
}

const REGION_LABELS: Record<Region, () => string> = {
  DE: m.region_country_de,
  AT: m.region_country_at,
  CH: m.region_country_ch,
  FR: m.region_country_fr,
  IT: m.region_country_it,
  NL: m.region_country_nl,
  ES: m.region_country_es,
  GB: m.region_country_gb,
  US: m.region_country_us,
};

const SEG_LABELS: Record<(typeof TIME_FMTS)[number] | Settings['weekStart'], () => string> = {
  '24h': m.region_time_24,
  '12h': m.region_time_12,
  monday: m.region_week_monday,
  sunday: m.region_week_sunday,
};

export function regionLabel(region: string): string {
  return Object.hasOwn(REGION_LABELS, region) ? REGION_LABELS[region as Region]() : region;
}

/** Language (`langOpts[]`) as a card with a code. */
export interface LangOption extends LangChoice {
  hasSub: boolean;
}

export interface LanguageValues {
  langTabs: { label: string; onClick: () => void }[];
  langOpts: LangOption[];
  selRegion: SelectValues;
  tgTzAuto: { on: boolean; onClick: () => void };
  selTz: SelectValues;
  fmtPreview: { k: string; v: string }[];
  dateOpts: SegOption<string>[];
  timeOpts: SegOption<Settings['timeFmt']>[];
  weekOpts: SegOption<Settings['weekStart']>[];
  numOpts: SegOption<string>[];
}

export interface LanguageInput {
  values: Pick<Settings, 'lang' | 'region' | 'tzAuto' | 'tz' | 'dateFmt' | 'timeFmt' | 'weekStart' | 'numFmt'>;
  now: number;
  /** Time zone of the device (`browserTimeZone()`); `undefined` if it reports no usable one. */
  deviceTz: string | undefined;
  /** Open select list (only while `ui.menu` is `pick`). */
  open: SelectKey | null;
  /** Highlighted row of the open list (`selHi`); `null` = the chosen one. */
  hi: number | null;
  isMobile: boolean;
}

export interface LanguageContext {
  set: (patch: Partial<Settings>) => void;
  scrollTo: (section: LanguageSection) => void;
  /** Open or close (`null`) a select list; the highlight starts over. */
  show: (key: SelectKey | null) => void;
  /** Highlight a row (`null` = none). */
  mark: (i: number | null) => void;
}

export function languageValues(input: LanguageInput, ctx: LanguageContext): LanguageValues {
  const { values, now } = input;
  const tz = displayZone(values, input.deviceTz);
  // The zone of the device comes first if it is not among the choices (`tzSel`).
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];
  const tzOpts = zones.map((v) => {
    const l = zoneLabel(v);
    const sub = zoneAbbr(v, now);
    return { v, l, tl: sub ? `${l} (${sub})` : l, sub };
  });
  return {
    langTabs: [
      { label: m.region_tab_lang(), onClick: () => ctx.scrollTo('lang') },
      { label: m.region_tab_region(), onClick: () => ctx.scrollTo('region') },
      { label: m.region_tab_formats(), onClick: () => ctx.scrollTo('formats') },
    ],
    langOpts: langChoices(values.lang, ctx.set).map((l) => ({ ...l, hasSub: !!l.sub })),
    selRegion: select(
      'region',
      m.region_country_title(),
      REGIONS.map((v) => ({ v, l: regionLabel(v) })),
      values.region,
      (region) => ctx.set({ region: region as Region }),
      false,
      input,
      ctx,
    ),
    tgTzAuto: {
      on: values.tzAuto,
      // When switching off the zone of the device stays chosen, when switching on it is reported.
      onClick: () => ctx.set({ tzAuto: !values.tzAuto, tz: input.deviceTz ?? values.tz }),
    },
    selTz: select('tz', m.region_tz_title(), tzOpts, tz, (v) => ctx.set({ tz: v }), values.tzAuto, input, ctx),
    fmtPreview: [
      { k: m.region_preview_date(), v: formatDate(now, values.dateFmt, tz) },
      { k: m.region_preview_time(), v: clock(now, { tz, timeFmt: values.timeFmt }) },
      { k: m.region_preview_number(), v: NUM_FMTS[values.numFmt] ?? NUM_FMTS['1.234,56']! },
    ],
    dateOpts: seg(
      DATE_FMTS,
      values.dateFmt,
      (f) => formatDate(now, f, tz),
      (dateFmt) => ctx.set({ dateFmt }),
    ),
    timeOpts: seg(
      TIME_FMTS,
      values.timeFmt,
      (f) => SEG_LABELS[f](),
      (timeFmt) => ctx.set({ timeFmt }),
    ),
    weekOpts: seg(
      WEEK_STARTS,
      values.weekStart,
      (d) => SEG_LABELS[d](),
      (weekStart) => ctx.set({ weekStart }),
    ),
    numOpts: seg(
      Object.keys(NUM_FMTS),
      values.numFmt,
      (f) => f,
      (numFmt) => ctx.set({ numFmt }),
    ),
  };
}
