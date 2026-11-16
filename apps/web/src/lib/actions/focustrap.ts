/**
 * Focus trap for modal dialogs and the mobile sheet (pattern "Dialog
 * (Modal)" of the WAI-ARIA Authoring Practices):
 *
 * - Everything next to the dialog becomes `inert` – not operable and invisible
 *   to screen readers (siblings of the dialog and of all ancestors up to
 *   `body`). What appears next to it later (toast, tooltip, a confirmation
 *   above the dialog) stays operable, as do live regions next to it (an
 *   already visible toast with "Undo", the SvelteKit announcer) and
 *   a backdrop with `data-scrim` that closes on click.
 * - Tab and Shift+Tab run from the last to the first element and back.
 * - If the dialog loses focus because its content changes (mobile
 *   "More actions" → source), focus returns to the dialog.
 * - On close focus jumps to the element that had it before,
 *   unless someone has moved it elsewhere meanwhile.
 *
 * Several open dialogs (level 2 sheet, confirmation above a dialog)
 * form a stack: only the topmost traps focus, everything below is
 * inert; when it closes, the one below applies again. Each component still
 * sets the focus on open itself (field, first entry or the dialog).
 */

interface Trap {
  node: HTMLElement;
  opener: HTMLElement | null;
  observer: MutationObserver;
}

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

/** Never inert: parts of the document without rendering. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
/**
 * Never inert: live regions – a toast lies above the sheet and must stay
 * tappable, announcements should arrive – and a backdrop next to
 * the dialog (`data-scrim`, with the sheet) that closes on click.
 */
const KEEP = '[aria-live], [role="status"], [role="alert"], [data-scrim]';

const stack: Trap[] = [];
/** What the focus trap made inert – never elements that already were (such as `behind` of the sheet). */
let sealed: HTMLElement[] = [];
/**
 * Where the focus last came from (`relatedTarget` of `focusin`, `null` from
 * `body`): the opener, in case a component moves focus into the dialog
 * before the action.
 */
let cameFrom: Element | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => (cameFrom = event.relatedTarget instanceof Element ? event.relatedTarget : null),
    true,
  );
}

/**
 * `inert` via the property like Svelte (`inert={…}`); jsdom does not know it
 * as an attribute, hence no `closest('[inert]')`.
 */
function isInert(el: Element | null, stop?: Element): boolean {
  for (let cur = el; cur && cur !== stop; cur = cur.parentElement) {
    if ((cur as HTMLElement).inert) return true;
  }
  return false;
}

function reachable(el: HTMLElement, root: HTMLElement): boolean {
  return (
    el.tabIndex >= 0 &&
    !el.matches(':disabled') &&
    !el.hidden &&
    !isInert(el, root) &&
    (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }))
  );
}

/** Elements in the dialog reachable by Tab, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => reachable(el, root));
}

function release(): void {
  for (const el of sealed) el.inert = false;
  sealed = [];
}

function seal(node: HTMLElement): void {
  for (let el = node; el !== document.body && el.parentElement; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (sib === el || !(sib instanceof HTMLElement) || SKIP.has(sib.tagName) || sib.inert || sib.matches(KEEP)) {
        continue;
      }
      sib.inert = true;
      sealed.push(sib);
    }
  }
}

/** Position of `el` relative to `ref` in document order (ancestors of `ref` come before). */
function lies(el: Node, ref: Node, side: number): boolean {
  return (ref.compareDocumentPosition(el) & side) !== 0;
}

/**
 * The topmost open dialog: the last one in the document (level 2 sheet and
 * confirmation come after what they lie above), not the most recently
 * mounted – a lower dialog remounts, for example, when switching between
 * desktop and mobile.
 */
function top(): Trap | undefined {
  let best: Trap | undefined;
  for (const trap of stack) {
    if (!best || lies(trap.node, best.node, Node.DOCUMENT_POSITION_FOLLOWING)) best = trap;
  }
  return best;
}

function refresh(): void {
  release();
  const current = top();
  if (current) seal(current.node);
}

function lost(node: HTMLElement): boolean {
  const active = document.activeElement;
  return !active || active === document.body || node.contains(active);
}

/** Tab at the edge of the topmost dialog; on `document` so that it also applies when focus is on `body`. */
function onTab(event: KeyboardEvent): void {
  const current = top();
  if (!current || event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const { node } = current;
  // Only the edges: in the folder tree of the sheet this does not check every element for visibility.
  const candidates = [...node.querySelectorAll<HTMLElement>(TABBABLE)];
  const first = candidates.find((el) => reachable(el, node));
  const last = candidates.findLast((el) => reachable(el, node));
  const active = document.activeElement;
  let next: HTMLElement | undefined;
  if (!first || !last) next = node;
  else if (!active || !node.contains(active)) next = event.shiftKey ? last : first;
  // Also from elements without a tab stop (`tabindex="-1"`, the dialog itself) before the first or after the last.
  else if (event.shiftKey && (active === first || lies(active, first, Node.DOCUMENT_POSITION_PRECEDING))) next = last;
  else if (!event.shiftKey && (active === last || lies(active, last, Node.DOCUMENT_POSITION_FOLLOWING))) next = first;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function restore(trap: Trap): void {
  const { node, opener } = trap;
  // Free for returning: focus still in the dialog, on `body` or only on the dialog below itself
  // (the level 1 sheet focuses itself as soon as it is in front again) – not on a chosen target.
  const free = () => lost(node) || document.activeElement === top()?.node;
  if (!opener || !free()) return;
  const go = () => {
    if (opener.isConnected && !isInert(opener)) opener.focus({ preventScroll: true });
  };
  go();
  // The opener still lies behind a sheet that Svelte releases in a moment (`behind`).
  if (document.activeElement !== opener) queueMicrotask(() => free() && go());
}

export function focustrap(node: HTMLElement): { destroy: () => void } {
  const active = document.activeElement;
  const before = active && node.contains(active) ? cameFrom : active;
  const opener = before instanceof HTMLElement && before !== document.body && !node.contains(before) ? before : null;
  // So that the dialog itself can take focus (content change, nothing focusable inside).
  if (!node.hasAttribute('tabindex')) node.tabIndex = -1;

  const observer = new MutationObserver(() => {
    if (top() !== trap) return;
    const now = document.activeElement;
    if (!now || now === document.body) node.focus({ preventScroll: true });
  });
  const trap: Trap = { node, opener, observer };
  observer.observe(node, { childList: true, subtree: true });

  if (!stack.length) document.addEventListener('keydown', onTab);
  stack.push(trap);
  refresh();

  return {
    destroy() {
      observer.disconnect();
      const i = stack.indexOf(trap);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener('keydown', onTab);
      refresh();
      restore(trap);
    },
  };
}
