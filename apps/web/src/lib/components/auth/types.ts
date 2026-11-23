/**
 * Props shared by the guest pages' shell (`AuthFrame`, `AuthShell`, `AuthResult`).
 */
import type { IconName } from '#lib/icons.ts';

/** Step bars: `total` bars, bar `n` long, bars up to `n` in the accent; `label` names them ("Step 2 of 7"). */
export interface Bars {
  n: number;
  total: number;
  label: string;
}

export interface Primary {
  label: string;
  icon: IconName;
  /** Request running: spinner and `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  /** Greyed out and inert. */
  disabled?: boolean;
  /** Faded (55 %): a press only reaches `onblocked` (the screen shows why). */
  dim?: boolean;
  /** Background and ink instead of the accent's (a colour being chosen). */
  bg?: string | undefined;
  ink?: string | undefined;
  /** Own padding on desktop and in the mobile bottom bar (default: 0 and 0 22px). */
  pad?: { desk: string; mob: string } | undefined;
  /** The label (and the busy label) stays on one line instead of wrapping. */
  nowrap?: boolean | undefined;
}

/** "Back" that slides in left of the primary button while a screen's inline editor is open, and closes it. */
export interface SlideBack {
  open: boolean;
  label: string;
  onclick: () => void;
}

/** "Back" in the ⅓ slot left of the primary button; `ariaLabel` (containing `label`) when it needs a longer name. */
export interface Back {
  label: string;
  ariaLabel?: string;
  /** Faded to 55 % while the primary button is busy (the sign-in's code screens); otherwise only inert. */
  fadeBusy?: boolean;
  onback: () => void;
}

/** Overview of the page family's screens in the left column (two columns only). */
export interface Overview {
  label: string;
  items: string[];
  /** Number of the current screen (from 1). */
  current: number;
}

export interface ResultChips {
  /** Names the list (`<ul aria-label>`); without it the chips are a plain row. */
  label?: string;
  items: { icon: IconName; text: string }[];
  /** Shown at every level (otherwise hidden at the denser ones). */
  always?: boolean;
}

export interface ResultProgress {
  text: string;
  /** Time the bar takes to fill once. */
  ms: number;
  /** Widest the bar gets (px; default 280). */
  width?: number;
}

export interface ResultPrimary {
  label: string;
  icon: IconName;
  /** The icon before the label (back-type actions). */
  iconLeft?: boolean;
  /** Request running: spinner and `busyLabel`, takes no clicks. */
  busy?: boolean | undefined;
  busyLabel?: string | undefined;
  /** Greyed out (a lock runs; the screen says why): takes no clicks. */
  disabled?: boolean | undefined;
  /** Own padding on desktop and in the mobile bottom bar (default: 0 18px and 0 22px). */
  pad?: { desk: string; mob: string } | undefined;
  onclick: () => void;
}

export interface ResultQuiet {
  label: string;
  icon?: IconName;
  /** `button`: a full-width secondary button (desktop on `--surface2`, the mobile bar on `--surface`); default a text button. */
  look?: 'text' | 'button' | undefined;
  onclick: () => void;
}
