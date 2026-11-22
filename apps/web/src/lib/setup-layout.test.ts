import { describe, expect, it } from 'vitest';
import {
  DESK_LEVELS,
  MOB_LEVELS,
  SHARED_FIT,
  codesRoom,
  doneLook,
  fitTier,
  sharedCardH,
  sharedLevel,
  stepLook,
  twoCol,
} from './setup-layout.ts';

const look = (w: number, two: boolean, level = 0) => stepLook(w, two, level, DESK_LEVELS, MOB_LEVELS);

describe('twoCol', () => {
  it('has two columns from 1000 px, and from 800 px in a low window with hysteresis', () => {
    expect(twoCol(1000, 900, false)).toBe(true);
    expect(twoCol(999, 900, false)).toBe(false);
    expect(twoCol(800, 759, false)).toBe(true);
    expect(twoCol(800, 760, false)).toBe(false);
    // Once in two columns they stay until 40 px above the threshold.
    expect(twoCol(800, 790, true)).toBe(true);
    expect(twoCol(800, 800, true)).toBe(false);
    expect(twoCol(799, 600, true)).toBe(false);
  });
});

describe('stepLook', () => {
  it('takes the step’s own space above the fields in one column', () => {
    const own = stepLook(
      640,
      false,
      0,
      DESK_LEVELS.map((l) => ({ ...l, fieldsTop: l.gap })),
      MOB_LEVELS.map((l) => ({ ...l, fieldsTop: l.gap })),
    );
    expect(own.fieldsTop).toBe('28px');
    expect(
      stepLook(
        390,
        false,
        0,
        DESK_LEVELS,
        MOB_LEVELS.map((l) => ({ ...l, fieldsTop: l.gap })),
      ).fieldsTop,
    ).toBe('26px');
    expect(look(390, false).fieldsTop).toBe('20px');
  });

  it('lays out mobile, one column and two columns', () => {
    const mob = look(390, false);
    expect([mob.tier, mob.cardMaxW, mob.cardPad, mob.h1, mob.rootPad]).toEqual([
      'mob',
      'none',
      '28px 22px 26px',
      '30px',
      '0',
    ]);
    const mid = look(640, false);
    expect([mid.tier, mid.cardMaxW, mid.cardPad, mid.h1, mid.fieldsTop]).toEqual([
      'mid',
      '640px',
      '32px 26px 28px',
      '44px',
      '32px',
    ]);
    expect(look(800, false).cardPad).toBe('40px 40px 36px');
    const wide = look(1280, true);
    // Wide enough that the left column holds "bei Roedy Mail" at the 54 px heading; from level 2 the 980 px suffice.
    expect([wide.tier, wide.cardMaxW, wide.h1, wide.colGap, wide.cols]).toEqual([
      'wide',
      '1138px',
      '54px',
      '56px',
      'minmax(0, 1fr) minmax(0, 1.5fr)',
    ]);
    expect(look(1280, true, 1).cardMaxW).toBe('1008px');
    expect(look(1280, true, 2).cardMaxW).toBe('980px');
    const low = look(900, true);
    expect([low.h1, low.colGap, low.cols]).toEqual(['44px', '32px', 'minmax(0, 1fr) minmax(0, 1.8fr)']);
  });

  it('gets denser per level, the actions under the overview at the two densest two-column levels', () => {
    expect([3, 4, 5, 6].map((l) => look(1280, true, l).btnLeft)).toEqual([false, false, true, true]);
    expect(look(640, false, 6).btnLeft).toBe(false);
    expect([0, 3, 6].map((l) => [look(1280, true, l).intro, look(1280, true, l).introShort])).toEqual([
      [true, false],
      [true, true],
      [false, false],
    ]);
    // Past the last level the last one applies; touch targets stay ≥ 44 px.
    expect(look(1280, true, 99).ctl).toBe('44px');
    expect(look(390, false, 9).intro).toBe(false);
    expect(look(390, false, 2).introShort).toBe(true);
  });

  it('has room for three columns of recovery codes in the wider cards only', () => {
    // One column from 700 px, two columns from 1000 px (not in the low window from 800 px), never on mobile.
    expect([640, 699, 700, 999].map((w) => codesRoom(look(w, false, 6)))).toEqual([false, false, true, true]);
    expect([codesRoom(look(900, true, 6)), codesRoom(look(1000, true, 6))]).toEqual([false, true]);
    expect(codesRoom(look(390, false, 3))).toBe(false);
  });

  it('has one column on the done screen', () => {
    const done = doneLook(1280, 0);
    expect([done.two, done.cardMaxW, done.h1]).toEqual([false, '560px', '44px']);
    expect(doneLook(390, 0).tier).toBe('mob');
  });
});

describe('shared setup level', () => {
  it('needs less room at every denser level', () => {
    for (const { need } of Object.values(SHARED_FIT))
      for (let i = 1; i < need.length; i++) expect(need[i]).toBeLessThanOrEqual(need[i - 1]!);
  });

  it('picks the roomiest level the window allows, the densest when none fits', () => {
    const { need } = SHARED_FIT.wide;
    expect(sharedLevel(1280, need[0]!, true, 7)).toBe(0);
    expect(sharedLevel(1280, need[0]! - 1, true, 7)).toBe(1);
    expect(sharedLevel(1280, 300, true, 7)).toBe(need.length - 1);
  });

  it('never goes past the levels a step has', () => {
    expect(sharedLevel(393, 300, false, 4)).toBe(3);
  });

  it('maps widths to tiers', () => {
    expect([
      fitTier(393, false),
      fitTier(600, false),
      fitTier(800, false),
      fitTier(900, true),
      fitTier(1280, true),
    ]).toEqual(['mob', 'narrow', 'mid', 'two', 'wide']);
  });

  it('gives the desktop card its height, none on mobile', () => {
    expect(sharedCardH(1280, true, 0)).toBe(SHARED_FIT.wide.card[0]);
    expect(sharedCardH(393, false, 0)).toBeNull();
  });
});
