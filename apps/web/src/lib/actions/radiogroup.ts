/**
 * Radio groups with the keyboard (pattern "Radio Group" of the WAI-ARIA
 * Authoring Practices): one tab stop per group on the chosen option
 * (roving `tabindex`), ←/↑ and →/↓ switch (wrapping at the end), Home and
 * End jump to the first or last option. Disabled options (`disabled`,
 * `aria-disabled="true"`) are skipped; if all are disabled (accent colour
 * without `userAccent`), the group has no tab stop.
 *
 * Selection happens via `click()` of the option, i.e. the same way as with
 * the mouse. An option that opens a dialog (`data-opens-dialog`, "Custom" accent)
 * only takes the focus; activating it opens the dialog. With `select: false` the arrows only move focus, selection is
 * by Space or Enter – for groups whose choice triggers more than a
 * setting (switching account, language).
 */

export interface RadioGroupOptions {
  /** Arrow keys also select the option (default); `false`: focus only. */
  select?: boolean;
}

function enabled(el: HTMLElement): boolean {
  return !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
}

export function radiogroup(
  node: HTMLElement,
  options: RadioGroupOptions = {},
): { update: (options?: RadioGroupOptions) => void; destroy: () => void } {
  let select = options.select ?? true;

  // Only the own options, none of a nested group.
  const radios = () =>
    [...node.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
      (el) => el.closest('[role="radiogroup"]') === node,
    );

  function sync(): void {
    const all = radios();
    const usable = all.filter(enabled);
    const current = usable.find((el) => el.getAttribute('aria-checked') === 'true') ?? usable[0];
    for (const el of all) {
      const tab = el === current ? '0' : '-1';
      if (el.getAttribute('tabindex') !== tab) el.setAttribute('tabindex', tab);
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = (event.target as Element | null)?.closest<HTMLElement>('[role="radio"]');
    if (!from || from.closest('[role="radiogroup"]') !== node) return;
    const usable = radios().filter(enabled);
    const count = usable.length;
    if (!count) return;
    const i = usable.indexOf(from);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = usable[(i + 1) % count];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
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
    // Shortcuts of the page (↑/↓ in the list) should not see the key either.
    event.preventDefault();
    event.stopPropagation();
    if (!next) return;
    next.focus();
    if (select && next.getAttribute('aria-checked') !== 'true' && !next.hasAttribute('data-opens-dialog')) next.click();
  }

  const observer = new MutationObserver(sync);
  observer.observe(node, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-disabled', 'disabled'],
  });
  node.addEventListener('keydown', onkeydown);
  sync();

  return {
    update(next: RadioGroupOptions = {}) {
      select = next.select ?? true;
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener('keydown', onkeydown);
    },
  };
}
