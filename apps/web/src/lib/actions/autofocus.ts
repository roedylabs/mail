/**
 * Options of `autofocus`: `on` as with the plain flag. `scroll: 'minimal'` replaces the browser's scrolling (which
 * centres the caret and can push everything above the field out of view): the scroll area stays where it is and only
 * moves as far as needed to show the field's first line.
 */
export interface AutofocusOptions {
  on?: boolean;
  scroll?: 'browser' | 'minimal';
}

/** Nearest ancestor that scrolls vertically. */
function scrollArea(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * Focus when a field appears: editing in the profile, password prompt. Instead of the attribute `autofocus`, which only
 * applies on page load and surprises screen readers. With `scroll: 'minimal'` (the compose text) heading and fields
 * above the field stay in view on short viewports, while the focused field is never left entirely below the visible area.
 */
export function autofocus(node: HTMLElement, opts: boolean | AutofocusOptions = true): void {
  const { on = true, scroll = 'browser' } = typeof opts === 'boolean' ? { on: opts } : opts;
  if (!on) return;
  if (scroll === 'browser') {
    node.focus();
    return;
  }
  node.focus({ preventScroll: true });
  const area = scrollArea(node);
  if (!area) return;
  const style = getComputedStyle(node);
  const firstLine = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.lineHeight) || 0);
  const below = node.getBoundingClientRect().top + firstLine - area.getBoundingClientRect().bottom;
  if (below > 0) area.scrollTop += Math.ceil(below);
}
