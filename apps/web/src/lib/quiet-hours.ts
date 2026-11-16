/**
 * Quiet hours as HH:MM times. Without DOM, so that the settings page and the
 * service worker use the same rule without the service worker bundling the
 * time picker.
 */

/** Minutes since midnight of an HH:MM time. */
export function minutesOf(value: string): number {
  const [h = 0, mi = 0] = (value || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (mi || 0);
}

/** Is minute `at` within the quiet hours from `from` to `to` (also across midnight)? */
export function inQuiet(at: number, from: string, to: string): boolean {
  const a = minutesOf(from);
  const b = minutesOf(to);
  return a < b ? at >= a && at < b : at >= a || at < b;
}
