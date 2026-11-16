/**
 * Theme switching: mode, accent, density, font size and animations as
 * attributes on `<html>`, the logo plate of the branding as custom
 * properties.
 */
import { ACCENTS, DEFAULT_ACCENT, PLATES, type AccentName } from '@roedy/tokens';
import type { ModeName, Settings } from '#lib/state/prefs.svelte.ts';
import type { Branding } from '#lib/state/session.svelte.ts';

export interface Theme {
  mode: ModeName;
  accent: AccentName;
  density: Settings['density'];
  fontSize: Settings['fontSize'];
  animations: boolean;
  /** Plate of the logo; `null` = accent colour (default in CSS). */
  logo: readonly [bg: string, ink: string] | null;
  logoTilt: boolean;
}

/** Accent like `accentName()`: own choice only if the branding allows it, otherwise the brand colour. */
export function accentOf(values: Pick<Settings, 'accent'>, brand: Pick<Branding, 'userAccent' | 'color'>): AccentName {
  const name = (brand.userAccent ? values.accent : null) ?? brand.color;
  return Object.hasOwn(ACCENTS, name) ? name : DEFAULT_ACCENT;
}

/** Mode like `modeName()`: `dark` without a choice. */
export function modeName(mode: Settings['mode']): ModeName {
  return mode ?? 'dark';
}

/** Dark like `isDark()`: dark without a choice, with "System" like the operating system. */
export function isDarkMode(mode: Settings['mode'], systemDark: boolean): boolean {
  return mode === 'system' ? systemDark : mode !== 'light';
}

export function themeOf(values: Settings, brand: Branding): Theme {
  return {
    mode: modeName(values.mode),
    accent: accentOf(values, brand),
    density: values.density,
    fontSize: values.fontSize,
    animations: values.animations,
    logo: PLATES[brand.plate] ?? null,
    logoTilt: brand.tilt,
  };
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.mode = theme.mode;
  root.dataset.accent = theme.accent;
  root.dataset.density = theme.density;
  root.dataset.fontSize = theme.fontSize;
  if (theme.animations) delete root.dataset.animations;
  else root.dataset.animations = 'off';
  if (theme.logo) {
    root.style.setProperty('--logo-bg', theme.logo[0]);
    root.style.setProperty('--logo-ink', theme.logo[1]);
  } else {
    root.style.removeProperty('--logo-bg');
    root.style.removeProperty('--logo-ink');
  }
  root.style.setProperty('--logo-tilt', theme.logoTilt ? '1' : '0');
}

/**
 * Error colours of the guest pages (setup and sign-in): fixed values per
 * light/dark, as `style` for the root element.
 */
export function errorTones(dark: boolean): string {
  const soft = `color-mix(in oklab, #f097ad ${dark ? 18 : 24}%, var(--surface))`;
  return `--err: ${dark ? '#e08a9c' : '#d9677e'}; --errfg: ${dark ? '#f5abb9' : '#a3344a'}; --errsoft: ${soft}`;
}
