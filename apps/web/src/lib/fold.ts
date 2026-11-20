/**
 * Height animations on measured pixels ("More colors" in setup step 1):
 * a block moves from one height to another (never through `auto` or `fr`,
 * so the end height is exactly the content's and nothing snaps). While it
 * moves it clips with `clip-path`, top and bottom only (or the bottom
 * only), never at the sides, so rings and shadows reaching past the sides
 * stay visible. It ends on the element's own `transitionend`; a timer is
 * only the fallback (no event, e.g. a hidden tab).
 */

/** Duration of every height and slide of the switch. */
export const FOLD_MS = 420;
/** Easing of every height and slide of the switch. */
export const FOLD_EASE = 'cubic-bezier(0.2, 0.9, 0.25, 1)';

export interface FoldOptions {
  /** Duration in ms; 0 (motion off): at once. */
  ms: number;
  /** `bottom`: only the bottom edge clips (the top and the sides stay visible); otherwise top and bottom. */
  clip?: 'bottom';
  /** Stay at `to` (folded away, or cleared later with `unfold`); otherwise back to the natural height. */
  keep?: boolean;
  /** Runs once the height arrived. */
  after?: () => void;
}

/** Fallback beyond the duration, in case no `transitionend` arrives. */
const FALLBACK_MS = 800;
const running = new WeakMap<HTMLElement, () => void>();

/** Moves `el` from `from` to `to` px; a running fold of `el` stops where it is (without its `after`). */
export function fold(el: HTMLElement, from: number, to: number, o: FoldOptions): void {
  running.get(el)?.();
  const clip = o.clip === 'bottom' ? 'inset(-24px -24px 0 -24px)' : 'inset(0 -24px)';
  const end = () => {
    el.style.transition = '';
    el.style.clipPath = o.keep ? clip : '';
    el.style.height = o.keep ? `${to}px` : '';
    o.after?.();
  };
  el.style.transition = 'none';
  el.style.height = `${from}px`;
  el.style.clipPath = clip;
  void el.offsetHeight;
  if (!o.ms || Math.abs(to - from) < 1) {
    end();
    return;
  }
  const stop = () => {
    el.removeEventListener('transitionend', done);
    clearTimeout(timer);
    running.delete(el);
  };
  function done(e?: TransitionEvent) {
    if (e && (e.target !== el || e.propertyName !== 'height')) return;
    stop();
    end();
  }
  el.addEventListener('transitionend', done);
  const timer = setTimeout(done, o.ms + FALLBACK_MS);
  running.set(el, stop);
  el.style.transition = `height ${o.ms}ms ${FOLD_EASE}`;
  el.style.height = `${to}px`;
}

/** Stops a running fold of `el` and clears what folds left on it (its natural height again). */
export function unfold(el: HTMLElement): void {
  running.get(el)?.();
  el.style.transition = '';
  el.style.height = '';
  el.style.clipPath = '';
}
