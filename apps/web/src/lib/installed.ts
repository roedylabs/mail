/**
 * Does the web app run as an installed app instead of in a browser tab?
 * `navigator.standalone` only exists on iPhone and iPad; `matchMedia` is missing
 * outside the browser.
 */
export function isInstalled(win: Pick<typeof globalThis, 'matchMedia' | 'navigator'> = globalThis): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches;
}
