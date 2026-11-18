/** Options of `autofocus`: `on` as with the plain flag, `preventScroll` leaves the scroll area where it is. */
export interface AutofocusOptions {
  on?: boolean;
  preventScroll?: boolean;
}

/**
 * Focus when a field appears: editing in the profile, password prompt. Instead of the attribute `autofocus`, which only
 * applies on page load and surprises screen readers. With `preventScroll` the browser does not scroll the field into
 * view (the compose text, so that heading and header fields stay visible on short viewports).
 */
export function autofocus(node: HTMLElement, opts: boolean | AutofocusOptions = true): void {
  const { on = true, preventScroll = false } = typeof opts === 'boolean' ? { on: opts } : opts;
  if (on) node.focus(preventScroll ? { preventScroll } : undefined);
}
