/**
 * Tabs with the keyboard (pattern "Tabs" of the WAI-ARIA Authoring
 * Practices, horizontal): one tab stop per list on the chosen tab
 * (roving `tabindex`), ← and → switch (wrapping at the end), Home and End
 * jump to the first or last tab. Disabled tabs (`disabled`,
 * `aria-disabled="true"`) are skipped.
 *
 * Selection follows focus via `click()` of the tab, i.e. the same
 * way as with the mouse. Counterpart for radio groups: `#lib/actions/radiogroup.ts`.
 */

function enabled(el: HTMLElement): boolean {
  return !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
}

export function tablist(node: HTMLElement): { destroy: () => void } {
  // Only the own tabs, none of a nested list.
  const tabs = () =>
    [...node.querySelectorAll<HTMLElement>('[role="tab"]')].filter((el) => el.closest('[role="tablist"]') === node);

  function sync(): void {
    const all = tabs();
    const usable = all.filter(enabled);
    const current = usable.find((el) => el.getAttribute('aria-selected') === 'true') ?? usable[0];
    for (const el of all) {
      const tab = el === current ? '0' : '-1';
      if (el.getAttribute('tabindex') !== tab) el.setAttribute('tabindex', tab);
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = (event.target as Element | null)?.closest<HTMLElement>('[role="tab"]');
    if (!from || from.closest('[role="tablist"]') !== node) return;
    const usable = tabs().filter(enabled);
    const count = usable.length;
    if (!count) return;
    const i = usable.indexOf(from);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
        next = usable[(i + 1) % count];
        break;
      case 'ArrowLeft':
        next = usable[i < 0 ? count - 1 : (i - 1 + count) % count];
        break;
      case 'Home':
        next = usable[0];
        break;
      case 'End':
        next = usable[count - 1];
        break;
      default:
        return;
    }
    // Shortcuts of the page should not see the key.
    event.preventDefault();
    event.stopPropagation();
    if (!next) return;
    next.focus();
    if (next.getAttribute('aria-selected') !== 'true') next.click();
  }

  const observer = new MutationObserver(sync);
  observer.observe(node, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-disabled', 'disabled'],
  });
  node.addEventListener('keydown', onkeydown);
  sync();

  return {
    destroy() {
      observer.disconnect();
      node.removeEventListener('keydown', onkeydown);
    },
  };
}
