/**
 * Colour of the browser and system bars (`<meta name="theme-color">`): the page's canvas in the current mode, so
 * the status and navigation bar of the installed app blend into the page. The manifest's `theme_color` (the brand
 * accent) only shows while the app starts, together with the splash screen on the accent plate.
 */
import { MODES } from '@roedy/tokens';

export function themeColor(dark: boolean): string {
  return MODES[dark ? 'dark' : 'light']['--cnv'];
}
