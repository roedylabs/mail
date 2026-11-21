/**
 * Colour of the browser and system bars (`<meta name="theme-color">`): the page's canvas in the current mode, so
 * the status bar of the installed app blends into the page. The manifest's `theme_color` is the page background
 * too (light, and dark under `user_preferences.color_scheme_dark`): Chrome on Android takes the navigation bar's
 * colour from it, fixed at install, so that bar follows the system's mode rather than the app's.
 */
import { MODES } from '@roedy/tokens';

export function themeColor(dark: boolean): string {
  return MODES[dark ? 'dark' : 'light']['--cnv'];
}
