/**
 * Toast above the bar "Unsaved changes": if the page has such a bar
 * (Organization, Branding, Banner, Administration › Email, Account ›
 * Profile, Email account › Vacation reply), every toast sits 12 px above it
 * instead of at its usual place, on the desktop and on mobile.
 *
 * The distance is measured in one place rather than computed per page from
 * fixed sizes: the bar (`DirtyBar`) registers with
 * `{@attach unsavedBar}`, `toastLift.bottom` is then its distance from the
 * bottom edge of the window plus its height plus 12 px. The toast sits in
 * `.app` (100dvh) or `.layer` (fixed), both end at the bottom edge of the
 * window. It is measured again on size changes of bar, page and window, on
 * scrolling (the bar is `sticky`) and at the end of its fade-in.
 */
import type { Attachment } from 'svelte/attachments';

/** Distance between bar and toast. */
export const TOAST_GAP = 12;

/**
 * Largest distance of the bar from the bottom edge of the window at which it
 * counts as "stuck to the bottom". The fixed layout puts it 16 px
 * below main + 24 px `bottom` = 40 px on the desktop, 10 px more on the tablet
 * (50 px), on mobile 8 px below the panel + 36 px padding + 12 px `bottom` =
 * 56 px, in the vacation page with 16 px `bottom` 60 px. 120 px leaves room for
 * the bottom safe area of some devices (about 34 px) and rounding; if the bar
 * sits higher in the window with short content, the toast stays at its place.
 */
export const BAR_STUCK_MAX = 120;

/**
 * Distance of the toast from the bottom edge for a bar with this rectangle
 * (window coordinates); `null` if it is not fully visible or not stuck to the
 * bottom (then the toast stays at its place).
 */
export function liftOf(rect: Pick<DOMRect, 'top' | 'bottom' | 'height'>, viewport: number): number | null {
  if (rect.height <= 0 || rect.top < 0 || rect.bottom > viewport) return null;
  if (viewport - rect.bottom > BAR_STUCK_MAX) return null;
  return Math.round(viewport - rect.top + TOAST_GAP);
}

const nextFrame = (run: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
};

class ToastLift {
  /** Distance of the toast from the bottom edge in px, `null` without a bar. */
  bottom = $state<number | null>(null);

  #bars = new Set<HTMLElement>();
  #queued = false;
  #observer: ResizeObserver | null = null;
  #schedule = (): void => {
    if (this.#queued) return;
    this.#queued = true;
    nextFrame(() => {
      this.#queued = false;
      this.measure();
    });
  };

  /** Measures all registered bars; the highest one counts. */
  measure(): void {
    let best: number | null = null;
    for (const bar of this.#bars) {
      const lift = liftOf(bar.getBoundingClientRect(), window.innerHeight);
      if (lift !== null && (best === null || lift > best)) best = lift;
    }
    this.bottom = best;
  }

  /** Registers a bar; the return value unregisters it. */
  add(bar: HTMLElement): () => void {
    if (this.#bars.size === 0) this.#listen(true);
    this.#bars.add(bar);
    this.#observer?.observe(bar);
    if (bar.parentElement) this.#observer?.observe(bar.parentElement);
    bar.addEventListener('animationend', this.#schedule);
    this.measure();
    return () => {
      bar.removeEventListener('animationend', this.#schedule);
      this.#bars.delete(bar);
      this.#observer?.unobserve(bar);
      if (bar.parentElement && ![...this.#bars].some((b) => b.parentElement === bar.parentElement))
        this.#observer?.unobserve(bar.parentElement);
      if (this.#bars.size === 0) this.#listen(false);
      this.measure();
    };
  }

  #listen(on: boolean): void {
    if (on) {
      window.addEventListener('resize', this.#schedule);
      window.addEventListener('scroll', this.#schedule, { capture: true, passive: true });
      if (typeof ResizeObserver === 'function') this.#observer = new ResizeObserver(this.#schedule);
      return;
    }
    window.removeEventListener('resize', this.#schedule);
    window.removeEventListener('scroll', this.#schedule, { capture: true });
    this.#observer?.disconnect();
    this.#observer = null;
  }
}

export const toastLift = new ToastLift();

/** On the bar "Unsaved changes": `{@attach unsavedBar}`. */
export const unsavedBar: Attachment<HTMLElement> = (bar) => toastLift.add(bar);
