/**
 * Values of the Settings › Appearance page: colour scheme (`modeCards`),
 * accent colour (`accentOpts`, locked without `userAccent` of the branding),
 * font size, animations, density, mailbox design and sidebar. Changes go
 * through `prefs.set()`; the shell applies the theme at once (`applyTheme()` in
 * `#lib/theme.ts`). The sidebar is `ui.collapsed` and is not saved.
 */
import { ACCENTS, MA_COLORS, MODE_PREV, type AccentName } from '@roedy/tokens';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { DENSITIES, FONT_SIZES, MODES, PF_DESIGNS } from '#lib/settings-choices.ts';
import type { ModeName, Settings } from '#lib/state/prefs.svelte.ts';
import type { Branding } from '#lib/state/session.svelte.ts';
import { accentOf, modeName } from '#lib/theme.ts';

export { DENSITIES, FONT_SIZES, MODES, PF_DESIGNS };

/** Sections of the page (`data-sec`, `tabs`). */
export type AppearanceSection = 'mode' | 'accent' | 'text' | 'layout';

export const SIDEBAR = ['collapsed', 'expanded'] as const;
export type SidebarState = (typeof SIDEBAR)[number];

/** Option of a segmented control. */
export interface SegOption<T extends string> {
  value: T;
  label: string;
  on: boolean;
  onClick: () => void;
}

/** Colour scheme card with a preview in the fixed colours of its mode (`MODE_PREV`). */
export interface ModeCard {
  name: ModeName;
  label: string;
  on: boolean;
  icon: IconName;
  bg: string;
  panel: string;
  line: string;
  inkc: string;
  onClick: () => void;
}

export interface AccentOption {
  name: AccentName;
  label: string;
  base: string;
  ink: string;
  on: boolean;
  onClick: () => void;
}

export interface AppearanceValues {
  tabs: { label: string; onClick: () => void }[];
  modeCards: ModeCard[];
  accentOpts: AccentOption[];
  /** Without `userAccent` the branding sets the accent colour: selection locked (`accOp`, `accPe`). */
  accLocked: boolean;
  fontOpts: SegOption<Settings['fontSize']>[];
  densityOpts: SegOption<Settings['density']>[];
  pfDesignOpts: SegOption<Settings['pfDesign']>[];
  sidebarOpts: SegOption<SidebarState>[];
  tgAnim: { on: boolean; onClick: () => void };
}

export interface AppearanceInput {
  values: Pick<Settings, 'mode' | 'accent' | 'fontSize' | 'density' | 'pfDesign' | 'animations'>;
  brand: Pick<Branding, 'userAccent' | 'color'>;
  /** Sidebar collapsed (`ui.collapsed`). */
  collapsed: boolean;
}

export interface AppearanceContext {
  set: (patch: Partial<Settings>) => void;
  setCollapsed: (collapsed: boolean) => void;
  scrollTo: (section: AppearanceSection) => void;
}

export function modeLabel(mode: ModeName): string {
  return { light: m.appearance_mode_light, dark: m.appearance_mode_dark, system: m.appearance_mode_system }[mode]();
}

/** Name of a colour for accounts and tags (`MA_COLORS`), e.g. as the name of a swatch. */
export function colorLabel(name: (typeof MA_COLORS)[number][0]): string {
  return {
    apricot: m.appearance_accent_apricot,
    sage: m.appearance_accent_sage,
    lilac: m.appearance_color_lilac,
    sky: m.appearance_accent_sky,
    rose: m.appearance_accent_rose,
    honey: m.appearance_color_honey,
  }[name]();
}

export function accentLabel(name: AccentName): string {
  return {
    apricot: m.appearance_accent_apricot,
    sage: m.appearance_accent_sage,
    lavender: m.appearance_accent_lavender,
    sky: m.appearance_accent_sky,
    rose: m.appearance_accent_rose,
  }[name]();
}

const LABELS: Record<Settings['fontSize'] | Settings['density'] | Settings['pfDesign'] | SidebarState, () => string> = {
  small: m.appearance_font_small,
  medium: m.appearance_font_medium,
  large: m.appearance_font_large,
  compact: m.appearance_compact,
  normal: m.appearance_density_normal,
  comfortable: m.appearance_density_comfortable,
  soft: m.appearance_pf_soft,
  collapsed: m.appearance_sidebar_collapsed,
  expanded: m.appearance_sidebar_expanded,
};

function seg<T extends keyof typeof LABELS>(opts: readonly T[], current: T, set: (value: T) => void): SegOption<T>[] {
  return opts.map((value) => ({ value, label: LABELS[value](), on: value === current, onClick: () => set(value) }));
}

export function appearanceValues(input: AppearanceInput, ctx: AppearanceContext): AppearanceValues {
  const { values, brand } = input;
  const mode = modeName(values.mode);
  const accent = accentOf(values, brand);
  const locked = !brand.userAccent;
  return {
    tabs: [
      { label: m.appearance_tab_mode(), onClick: () => ctx.scrollTo('mode') },
      { label: m.appearance_tab_accent(), onClick: () => ctx.scrollTo('accent') },
      { label: m.appearance_tab_text(), onClick: () => ctx.scrollTo('text') },
      { label: m.appearance_tab_layout(), onClick: () => ctx.scrollTo('layout') },
    ],
    modeCards: MODES.map((name) => ({
      name,
      label: modeLabel(name),
      on: name === mode,
      ...MODE_PREV[name],
      onClick: () => ctx.set({ mode: name }),
    })),
    accentOpts: (Object.keys(ACCENTS) as AccentName[]).map((name) => ({
      name,
      label: accentLabel(name),
      ...ACCENTS[name],
      on: name === accent,
      // When locked a click has no effect.
      onClick: () => {
        if (!locked) ctx.set({ accent: name });
      },
    })),
    accLocked: locked,
    fontOpts: seg(FONT_SIZES, values.fontSize, (fontSize) => ctx.set({ fontSize })),
    densityOpts: seg(DENSITIES, values.density, (density) => ctx.set({ density })),
    pfDesignOpts: seg(PF_DESIGNS, values.pfDesign === 'compact' ? 'compact' : 'soft', (pfDesign) =>
      ctx.set({ pfDesign }),
    ),
    sidebarOpts: seg(SIDEBAR, input.collapsed ? 'collapsed' : 'expanded', (v) => ctx.setCollapsed(v === 'collapsed')),
    tgAnim: { on: values.animations, onClick: () => ctx.set({ animations: !values.animations }) },
  };
}
