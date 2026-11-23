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
  onclick: () => void;
}

export interface ResultQuiet {
  label: string;
  icon?: IconName;
  onclick: () => void;
}
