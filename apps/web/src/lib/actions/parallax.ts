/**
 * Pointer for the artwork of the guest pages (setup and sign-in): `--px` and `--py` from −1 to 1 on the element while the
 * artwork is visible (`use:parallax={showArt}`), without state.
 */
import type { Action } from 'svelte/action';

export const parallax: Action<HTMLElement, boolean> = (node, on) => {
  let active = false;
  const move = (event: MouseEvent) => {
    const r = node.getBoundingClientRect();
    node.style.setProperty('--px', (((event.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
    node.style.setProperty('--py', (((event.clientY - r.top) / r.height - 0.5) * 2).toFixed(3));
  };
  const leave = () => {
    node.style.setProperty('--px', '0');
    node.style.setProperty('--py', '0');
  };
  function set(next: boolean) {
    if (next === active) return;
    active = next;
    if (next) {
      node.addEventListener('mousemove', move);
      node.addEventListener('mouseleave', leave);
    } else {
      node.removeEventListener('mousemove', move);
      node.removeEventListener('mouseleave', leave);
      leave();
    }
  }
  set(on ?? false);
  return { update: (next: boolean) => set(next), destroy: () => set(false) };
};
