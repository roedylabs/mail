/**
 * Focus when a field appears: editing in the profile, password prompt. Instead of the attribute `autofocus`, which only
 * applies on page load and surprises screen readers.
 */
export function autofocus(node: HTMLElement, on = true): void {
  if (on) node.focus();
}
