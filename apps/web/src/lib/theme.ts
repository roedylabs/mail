/**
 * Theme switching: mode, accent, density, font size and animations as
 * attributes on `<html>`, the logo plate of the branding as custom
 * properties.
 */
import { ACCENTS, DEFAULT_ACCENT, PLATES } from '@roedy/tokens';
import { accentInk, isHexColor } from '#lib/color.ts';
import type { AccentChoice, ModeName, Settings } from '#lib/state/prefs.svelte.ts';
import type { Branding } from '#lib/state/session.svelte.ts';

export interface Theme {
  mode: ModeName;
  /** Named accent or a custom colour (`#rrggbb`). */
  accent: AccentChoice;
  density: Settings['density'];
  fontSize: Settings['fontSize'];
  animations: boolean;
  /** Plate of the logo; `null` = accent colour (default in CSS). */
  logo: readonly [bg: string, ink: string] | null;
  logoTilt: boolean;
}

/**
 * Accent like `accentName()`: own choice (named or custom) only if the branding
 * allows it, otherwise the brand colour.
 */
export function accentOf(
  values: Pick<Settings, 'accent'>,
  brand: Pick<Branding, 'userAccent' | 'color'>,
): AccentChoice {
  const name = (brand.userAccent ? values.accent : null) ?? brand.color;
  return Object.hasOwn(ACCENTS, name) || isHexColor(name) ? name : DEFAULT_ACCENT;
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
  // A custom colour overrides the stylesheet's accent on the element itself, in light and dark alike.
  if (isHexColor(theme.accent)) {
    root.dataset.accent = 'custom';
    root.style.setProperty('--acc', theme.accent);
    root.style.setProperty('--accink', accentInk(theme.accent));
  } else {
    root.dataset.accent = theme.accent;
    root.style.removeProperty('--acc');
    root.style.removeProperty('--accink');
  }
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
