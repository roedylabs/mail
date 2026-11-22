/**
 * Layout of the setup wizard: width tiers, two-column threshold and the
 * height levels the card steps down through until it fits the window.
 *
 * Tiers (full page width `w`): below 520 px the mobile layout (top bar, the
 * card as a scrolling panel, actions in a bottom bar); 520–999 px "mid", one
 * column in a card of up to 640 px; from 1000 px "wide", two columns in a
 * card of up to 980 px (heading, intro and step overview left; fields and
 * actions right). From 800 px a window lower than 760 px gets two columns
 * too; once in two columns they stay until 40 px above that threshold.
 *
 * Within a tier the height level sets sizes and what shows. Each step has
 * its own tables (it adds its own values to the shared ones below); the
 * done screen has one column only. Touch targets stay ≥ 44 px at every level.
 */

export const MOBILE_MAX = 520;
export const WIDE = 1000;
export const TWO_MIN = 800;
export const TWO_H = 760;
/** Once in two columns, they stay until this much above `TWO_H` (no flipping). */
export const TWO_HYST = 40;
/** Narrow one-column card: smaller side padding below this width. */
const NARROW_CARD = 700;

/** Two columns at width `w` and height `h`; `prev` whether the layout has two columns now. */
export function twoCol(w: number, h: number, prev: boolean): boolean {
  return w >= WIDE || (w >= TWO_MIN && h < TWO_H + (prev ? TWO_HYST : 0));
}

export const isMobileWidth = (w: number): boolean => w < MOBILE_MAX;

/** Desktop height level of a step; `h1` per column count (two columns from 1000 px, otherwise), `pad` per tier (two, mid, mid < 700 px). */
export interface DeskLevel {
  h1: readonly [string, string];
  pad: readonly [string, string, string];
  gap: string;
  gapM: string;
  gapF?: string;
  main: string;
  ctl: string;
  /** Space above the actions (and above the fields in one column). */
  btn: string;
  /** Step overview: space above it and between its rows. */
  list: readonly [string, string];
  /** Gap between the columns from 1000 px. */
  col: string;
  /** Margin of the brand row. */
  stepM: string;
  intro: 'long' | 'short' | 'none';
  pm: string;
  pfs: string;
  root: string;
  /** Space above the fields in one column (default `btn`). */
  fieldsTop?: string;
}

/** Mobile height level of a step. */
export interface MobLevel {
  h1: string;
  gap: string;
  gapM: string;
  gapF?: string;
  cpad: string;
  intro: 'block' | 'none';
  /** Short intro. */
  short?: boolean;
  /** Space above the fields (default `gapM`). */
  fieldsTop?: string;
}

/** Desktop height level of the done screen (one column). */
export interface DoneLevel {
  h1: string;
  pad: string;
  gap: string;
  gapM: string;
  main: string;
  stepM: string;
  pfs: string;
  pm: string;
  root: string;
}

/** Shared desktop levels of the steps: 0–1 roomy, 2 smaller, 3 short intro, 4–5 compact, 6 without intro. */
export const DESK_LEVELS: readonly DeskLevel[] = [
  {
    h1: ['54px', '44px'],
    pad: ['44px 48px 40px', '40px 40px 36px', '32px 26px 28px'],
    gap: '28px',
    gapM: '24px',
    gapF: '20px',
    main: '40px 0',
    ctl: '56px',
    btn: '32px',
    list: ['34px', '12px'],
    col: '56px',
    stepM: '-8px 0 20px',
    intro: 'long',
    pm: '10px 0 0',
    pfs: '16.5px',
    root: '16px',
  },
  {
    h1: ['48px', '40px'],
    pad: ['36px 42px 32px', '34px 36px 30px', '28px 24px 24px'],
    gap: '22px',
    gapM: '20px',
    gapF: '18px',
    main: '16px 0',
    ctl: '52px',
    btn: '26px',
    list: ['28px', '10px'],
    col: '48px',
    stepM: '-8px 0 18px',
    intro: 'long',
    pm: '10px 0 0',
    pfs: '16px',
    root: '16px',
  },
  {
    h1: ['42px', '36px'],
    pad: ['28px 34px 26px', '28px 32px 26px', '24px 22px 20px'],
    gap: '18px',
    gapM: '16px',
    gapF: '16px',
    main: '6px 0',
    ctl: '48px',
    btn: '20px',
    list: ['22px', '8px'],
    col: '40px',
    stepM: '-8px 0 14px',
    intro: 'long',
    pm: '8px 0 0',
    pfs: '15.5px',
    root: '12px',
  },
  {
    h1: ['36px', '32px'],
    pad: ['22px 28px 20px', '22px 26px 20px', '20px 18px 18px'],
    gap: '14px',
    gapM: '14px',
    gapF: '14px',
    main: '0',
    ctl: '48px',
    btn: '16px',
    list: ['16px', '6px'],
    col: '32px',
    stepM: '-10px 0 10px',
    intro: 'short',
    pm: '6px 0 0',
    pfs: '15px',
    root: '8px',
  },
  {
    h1: ['32px', '30px'],
    pad: ['20px 24px 18px', '20px 22px 18px', '18px 16px 16px'],
    gap: '12px',
    gapM: '12px',
    gapF: '12px',
    main: '0',
    ctl: '44px',
    btn: '14px',
    list: ['14px', '4px'],
    col: '32px',
    stepM: '-10px 0 8px',
    intro: 'short',
    pm: '6px 0 0',
    pfs: '15px',
    root: '8px',
  },
  {
    h1: ['30px', '28px'],
    pad: ['18px 24px 16px', '18px 20px 16px', '16px 16px 14px'],
    gap: '10px',
    gapM: '10px',
    gapF: '10px',
    main: '0',
    ctl: '44px',
    btn: '12px',
    list: ['12px', '4px'],
    col: '32px',
    stepM: '-10px 0 6px',
    intro: 'short',
    pm: '4px 0 0',
    pfs: '14.5px',
    root: '8px',
  },
  {
    h1: ['28px', '26px'],
    pad: ['16px 22px 14px', '16px 20px 14px', '14px 14px 12px'],
    gap: '10px',
    gapM: '10px',
    gapF: '10px',
    main: '0',
    ctl: '44px',
    btn: '10px',
    list: ['12px', '2px'],
    col: '32px',
    stepM: '-6px 0 6px',
    intro: 'none',
    pm: '0',
    pfs: '14.5px',
    root: '8px',
  },
];

/** Shared mobile levels of the steps: smaller, then the short intro, then without intro. */
export const MOB_LEVELS: readonly MobLevel[] = [
  { h1: '30px', gap: '26px', gapM: '20px', gapF: '18px', cpad: '28px 22px 26px', intro: 'block' },
  { h1: '28px', gap: '20px', gapM: '16px', gapF: '16px', cpad: '24px 18px 22px', intro: 'block' },
  { h1: '26px', gap: '16px', gapM: '14px', gapF: '14px', cpad: '20px 16px 18px', intro: 'block', short: true },
  { h1: '24px', gap: '14px', gapM: '12px', gapF: '12px', cpad: '18px 14px 16px', intro: 'none' },
];

/** Desktop levels of the done screen. */
export const DONE_LEVELS: readonly DoneLevel[] = [
  {
    h1: '44px',
    pad: '44px 44px 40px',
    gap: '28px',
    gapM: '22px',
    main: '40px 0',
    stepM: '-8px 0 20px',
    pfs: '16.5px',
    pm: '10px 0 0',
    root: '16px',
  },
  {
    h1: '40px',
    pad: '36px 38px 32px',
    gap: '22px',
    gapM: '18px',
    main: '16px 0',
    stepM: '-8px 0 18px',
    pfs: '16px',
    pm: '10px 0 0',
    root: '16px',
  },
  {
    h1: '36px',
    pad: '28px 30px 26px',
    gap: '18px',
    gapM: '14px',
    main: '6px 0',
    stepM: '-8px 0 14px',
    pfs: '15.5px',
    pm: '8px 0 0',
    root: '12px',
  },
  {
    h1: '30px',
    pad: '20px 24px 18px',
    gap: '14px',
    gapM: '12px',
    main: '0',
    stepM: '-10px 0 8px',
    pfs: '15px',
    pm: '6px 0 0',
    root: '8px',
  },
];

/** Mobile levels of the done screen. */
export const DONE_MOB_LEVELS: readonly MobLevel[] = [
  { h1: '32px', gap: '26px', gapM: '20px', cpad: '28px 22px 26px', intro: 'block' },
  { h1: '30px', gap: '20px', gapM: '16px', cpad: '24px 18px 22px', intro: 'block' },
  { h1: '28px', gap: '16px', gapM: '14px', cpad: '20px 16px 18px', intro: 'block' },
];

export type Tier = 'mob' | 'mid' | 'wide';

/** Layout tier of the shared level table: mobile, one column (narrow below 700 px), two columns (wide from 1000 px). */
export type FitTier = 'mob' | 'narrow' | 'mid' | 'two' | 'wide';

export function fitTier(w: number, two: boolean): FitTier {
  if (isMobileWidth(w)) return 'mob';
  if (two) return w >= WIDE ? 'wide' : 'two';
  return w < NARROW_CARD ? 'narrow' : 'mid';
}

/**
 * One level for all seven steps: per tier the window height each level needs (`need`, px of the page; on mobile of
 * the page around the panel) and the card's height at that level (`card`, desktop). Both are the largest of the
 * steps in the longer language, measured on the real steps at the narrowest width of the tier. Every step starts its
 * fit at the level the window allows, so heading, sizes and card are the same on every step; a step only goes denser
 * on its own when its content still overflows (an error message).
 */
export const SHARED_FIT: Record<FitTier, { need: readonly number[]; card: readonly number[] }> = {
  mob: { need: [964, 916, 730, 640, 484], card: [1156, 814, 766, 580, 490] },
  narrow: { need: [1054, 934, 826, 688, 628, 508, 484], card: [954, 881, 794, 674, 617, 496, 466] },
  mid: { need: [1072, 946, 808, 688, 634, 514, 484], card: [970, 893, 782, 678, 621, 500, 470] },
  two: { need: [9999, 754, 658, 574, 526, 484, 484], card: [611, 703, 629, 563, 513, 427, 427] },
  wide: { need: [868, 754, 658, 574, 526, 484, 484], card: [767, 703, 629, 563, 513, 410, 410] },
};

/**
 * Width the heading's column must hold, in em: "bei Roedy Mail" (7.17 em in Young Serif) with a little room. A column
 * that holds it but not the whole title leaves only the break "Willkommen" / "bei Roedy Mail" (`text-wrap: balance`
 * prefers it anyway). The heading never grows past 1/TITLE_EM of its column (13.7cqi).
 */
export const TITLE_EM = 7.3;

/**
 * Card width from 1000 px (two columns, left : right = 1 : 1.5): wide enough that the left column holds TITLE_EM at
 * the level's heading size, at least 980 px; the window still limits it.
 */
export function wideCardW(L: DeskLevel): number {
  const padX = parseFloat(L.pad[0].split(' ')[1] ?? '0');
  return Math.max(980, Math.ceil(2.5 * TITLE_EM * parseFloat(L.h1[0]) + 2 * padX + parseFloat(L.col)));
}

/** Level all steps share at width `w`, height `h` and column layout `two`; at most `levels - 1`. */
export function sharedLevel(w: number, h: number, two: boolean, levels: number): number {
  const { need } = SHARED_FIT[fitTier(w, two)];
  const i = need.findIndex((n) => h >= n);
  return Math.min(levels - 1, i < 0 ? need.length - 1 : i);
}

/** Desktop card height (px) at `level`: the largest step's, so the card has the same size on every step; `null` on mobile. */
export function sharedCardH(w: number, two: boolean, level: number): number | null {
  if (isMobileWidth(w)) return null;
  const { card } = SHARED_FIT[fitTier(w, two)];
  return card[Math.min(level, card.length - 1)] ?? null;
}

/** Resolved values of the shell at the current size and level. */
export interface Look {
  /** Width of the page the values are for (px). */
  w: number;
  tier: Tier;
  mobile: boolean;
  two: boolean;
  /** From 1000 px (wider column gap, larger heading). */
  full: boolean;
  rootPad: string;
  mainPad: string;
  cardMaxW: string;
  cardPad: string;
  h1: string;
  gapL: string;
  gapM: string;
  gapF: string;
  /** Height of the action buttons (desktop). */
  ctl: string;
  stepM: string;
  intro: boolean;
  introShort: boolean;
  pm: string;
  pfs: string;
  /** Grid columns of the form (two columns: left : right). */
  cols: string;
  colGap: string;
  fieldsTop: string;
  btnTop: string;
  listTop: string;
  listGap: string;
  /** The two densest two-column levels: the action row sits under the step overview. */
  btnLeft: boolean;
}

/** Values of a step at width `w`, two columns `two` (desktop) and level `level` of the matching table. */
export function stepLook(
  w: number,
  two: boolean,
  level: number,
  desk: readonly DeskLevel[],
  mob: readonly MobLevel[],
): Look {
  if (isMobileWidth(w)) {
    const W = mob[Math.min(level, mob.length - 1)]!;
    return {
      w,
      tier: 'mob',
      mobile: true,
      two: false,
      full: false,
      rootPad: '0',
      mainPad: '0 10px',
      cardMaxW: 'none',
      cardPad: W.cpad,
      h1: W.h1,
      gapL: W.gap,
      gapM: W.gapM,
      gapF: W.gapF ?? '18px',
      ctl: '54px',
      stepM: '0',
      intro: W.intro !== 'none',
      introShort: !!W.short,
      pm: '10px 0 0',
      pfs: '15px',
      cols: 'minmax(0, 1fr)',
      colGap: '0',
      fieldsTop: W.fieldsTop ?? W.gapM,
      btnTop: W.gap,
      listTop: '0',
      listGap: '0',
      btnLeft: false,
    };
  }
  const li = Math.min(level, desk.length - 1);
  const L = desk[li]!;
  const full = w >= WIDE;
  const colGap = two ? (full ? L.col : '32px') : '0';
  return {
    w,
    tier: two ? 'wide' : 'mid',
    mobile: false,
    two,
    full,
    rootPad: L.root,
    mainPad: L.main,
    cardMaxW: two ? (full ? `${wideCardW(L)}px` : '980px') : '640px',
    cardPad: two ? L.pad[0] : w < NARROW_CARD ? L.pad[2] : L.pad[1],
    h1: two && full ? L.h1[0] : L.h1[1],
    gapL: L.gap,
    gapM: L.gapM,
    gapF: L.gapF ?? '20px',
    ctl: L.ctl,
    stepM: L.stepM,
    intro: L.intro !== 'none',
    introShort: L.intro === 'short',
    pm: L.pm,
    pfs: L.pfs,
    cols: two ? (full ? 'minmax(0, 1fr) minmax(0, 1.5fr)' : 'minmax(0, 1fr) minmax(0, 1.8fr)') : 'minmax(0, 1fr)',
    colGap,
    fieldsTop: two ? '0' : (L.fieldsTop ?? L.btn),
    btnTop: L.btn,
    listTop: two ? L.list[0] : '0',
    listGap: two ? L.list[1] : '0',
    btnLeft: two && li >= 5,
  };
}

/**
 * The recovery codes (step 6) have room for three columns: on desktop in the one-column card from 700 px, or in the
 * full two-column card from 1000 px (the step asks for them at its densest level only).
 */
export function codesRoom(look: Look): boolean {
  if (look.mobile) return false;
  return look.two ? look.full : look.w >= NARROW_CARD;
}

/** Side padding (px) of a CSS padding shorthand: "28px 22px 26px" → 22. */
function sidePad(pad: string): number {
  const parts = pad.trim().split(/\s+/);
  return parseFloat(parts[1] ?? parts[0] ?? '0') || 0;
}

/**
 * Columns of the recovery codes (step 6): three where the level asks for them and there is room (`codesRoom`),
 * otherwise two; one on a phone narrower than the layouts of the design (such as 320 px) where two columns would cut
 * the codes. `row` is the width (px) one row needs to show its code in full, `pad` and `gap` those of the codes card.
 */
export function codesCols(look: Look, cols3: boolean, row: number, pad: number, gap: number): 1 | 2 | 3 {
  if (cols3 && codesRoom(look)) return 3;
  if (!look.mobile) return 2;
  const inner = look.w - 2 * sidePad(look.mainPad) - 2 * sidePad(look.cardPad) - 2 * pad;
  return (inner - gap) / 2 >= row ? 2 : 1;
}

/** Values of the done screen: one column in a card of up to 560 px. */
export function doneLook(
  w: number,
  level: number,
  desk: readonly DoneLevel[] = DONE_LEVELS,
  mob: readonly MobLevel[] = DONE_MOB_LEVELS,
): Look {
  if (isMobileWidth(w)) return stepLook(w, false, level, [], mob);
  const L = desk[Math.min(level, desk.length - 1)]!;
  return {
    w,
    tier: 'mid',
    mobile: false,
    two: false,
    full: w >= WIDE,
    rootPad: L.root,
    mainPad: L.main,
    cardMaxW: '560px',
    cardPad: L.pad,
    h1: L.h1,
    gapL: L.gap,
    gapM: L.gapM,
    gapF: L.gapM,
    ctl: '56px',
    stepM: L.stepM,
    intro: true,
    introShort: false,
    pm: L.pm,
    pfs: L.pfs,
    cols: 'minmax(0, 1fr)',
    colGap: '0',
    fieldsTop: '0',
    btnTop: '0',
    listTop: '0',
    listGap: '0',
    btnLeft: false,
  };
}
