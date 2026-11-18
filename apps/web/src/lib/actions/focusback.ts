/**
 * Keeps keyboard focus in place when a box disappears while it holds the
 * focus, e.g. "Confirmation pending" in the profile after "Discard change":
 * the focus moves to `selector` in the surrounding element instead of falling
 * back to the page.
 */
export function focusback(node: HTMLElement, selector: string): { destroy: () => void } {
  // When the box goes away it is already detached; the surrounding element stays.
  const scope = node.parentElement;
  let inside = false;
  const into = () => (inside = true);
  const out = () => {
    // Removing the box may blur it too; only a focus that really moved counts.
    queueMicrotask(() => {
      if (node.isConnected) inside = node.contains(document.activeElement);
    });
  };
  node.addEventListener('focusin', into);
  node.addEventListener('focusout', out);
  return {
    destroy() {
      node.removeEventListener('focusin', into);
      node.removeEventListener('focusout', out);
      if (!inside || !scope) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        scope.querySelector<HTMLElement>(selector)?.focus();
      });
    },
  };
}
