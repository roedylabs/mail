/**
 * Colour of the browser and system bars (`<meta name="theme-color">`): the page's canvas in the current mode, so
 * the status bar of the installed app blends into the page. The manifest has no `theme_color`: Chrome on Android
 * would colour the installed app's navigation bar with it, one value for both modes. Without it Chrome draws that
 * bar in its own colour, following the phone's light or dark mode rather than the app's.
 */
import { MODES } from '@roedy/tokens';

export function themeColor(dark: boolean): string {
  return MODES[dark ? 'dark' : 'light']['--cnv'];
}
