/**
 * Sections of a page in the settings area (`data-sec`) and the tabs above
 * them (e.g. the mail servers page): scrolls the content so that the section
 * starts 24 px below its top edge.
 */

/** Scroll to the section `[data-sec="<key>"]` in `root`; instantly without animations. */
export function scrollToSection(root: HTMLElement | undefined, key: string, animate: boolean): void {
  const section = root?.querySelector<HTMLElement>(`[data-sec="${key}"]`);
  // The scrolling content (card or mobile panel) is positioned and therefore the `offsetParent`.
  const container = section?.offsetParent;
  if (!section || !(container instanceof HTMLElement)) return;
  container.scrollTo({ top: Math.max(0, section.offsetTop - 24), behavior: animate ? 'smooth' : 'auto' });
}

/**
 * Section from the search: scroll there and briefly mark it with a border in
 * the accent colour; without animations only scroll.
 */
export function flashSection(root: HTMLElement, key: string, animate: boolean): boolean {
  const el = root.querySelector<HTMLElement>(`[data-sec="${key}"]`);
  if (!el) return false;
  scrollToSection(root, key, animate);
  if (!animate || !el.animate) return true;
  const acc = getComputedStyle(el).getPropertyValue('--acc').trim() || 'currentColor';
  const k = { outlineOffset: '12px', borderRadius: '20px' };
  el.animate(
    [
      { ...k, outline: '2.5px solid transparent' },
      { ...k, outline: `2.5px solid ${acc}`, offset: 0.2 },
      { ...k, outline: `2.5px solid ${acc}`, offset: 0.6 },
      { ...k, outline: '2.5px solid transparent' },
    ],
    { duration: 1800, delay: 300, easing: 'ease-in-out' },
  );
  return true;
}
