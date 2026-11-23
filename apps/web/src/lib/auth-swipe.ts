/**
 * Swipe back on the guest pages (setup, sign-in, invitation) on mobile:
 * dragging the page to the right from a screen with "Back" moves it along (a rubber band to the left), an arrow chip
 * fades in at the left edge and turns to the accent colour once the gesture
 * would go back. Released at 30 % of the width or flicked (faster than
 * 0.35 px/ms after more than 48 px), the page slides out and "Back" runs;
 * otherwise, and always after `pointercancel`, it springs back. The click that
 * ends a drag never reaches a button.
 */
import type { Attachment } from 'svelte/attachments';
import { rubber } from '#lib/swipe.ts';

export interface AuthSwipe {
  /** Motion on: without it the page jumps instead of sliding. */
  motion: boolean;
  /** "Back" of the step. */
  back: () => void;
}

/** Movement after which the gesture decides on its axis. */
const SLOP = 8;
const SPRING = 'cubic-bezier(.2,1.15,.35,1)';
const OUT = 'cubic-bezier(.3,.6,.4,1)';

/** Goes back on release: past 30 % of the width, or flicked to the right. */
export const swipeGoes = (x: number, vx: number, width: number): boolean => x > width * 0.3 || (vx > 0.35 && x > 48);

/** Progress 0–1 towards going back (the chip's opacity and scale). */
export const swipeProgress = (x: number, width: number): number => Math.min(1, Math.max(0, x) / (width * 0.3));

/**
 * Horizontal velocity in px/ms over the last 100 ms before the release at
 * time `at` (x and time stamp per point; the release point included): a
 * pointer that stood still before letting go has none.
 */
export function releaseVelocity(points: readonly (readonly [number, number])[], at: number): number {
  const window = points.filter((p) => at - p[1] <= 100);
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return 0;
  return (last[0] - first[0]) / Math.max(1, last[1] - first[1]);
}

/** Offset of the page for the movement `dx`: along to the right, a rubber band to the left. */
export const swipeOffset = (dx: number): number => (dx > 0 ? dx : -rubber(-dx, 20));

/**
 * Attachment on the page (`touch-action: pan-y`); the arrow chip is the
 * page's next sibling with `data-auth-chip`. `get` returns `null` while the
 * gesture is off (desktop, a screen without "Back", a request running).
 */
export function authSwipe(get: () => AuthSwipe | null): Attachment<HTMLElement> {
  return (el) => {
    let active = false;
    /** Ends a running gesture (listeners, styles); set while one runs. */
    let abort: (() => void) | null = null;
    /** Slide-out before "Back" runs. */
    let backTimer: ReturnType<typeof setTimeout> | undefined;
    const onDown = (down: PointerEvent) => {
      if (active || (down.pointerType === 'mouse' && down.button !== 0) || !down.isPrimary) return;
      const t = down.target instanceof Element ? down.target : null;
      if (t?.closest('input[type="range"]')) return;
      const o = get();
      if (!o) return;
      const win = el.ownerDocument.defaultView ?? window;
      const chip =
        el.nextElementSibling instanceof HTMLElement && el.nextElementSibling.dataset.authChip !== undefined
          ? el.nextElementSibling
          : null;
      const ms = (n: number) => (o.motion ? n : 0);
      const x0 = down.clientX;
      const y0 = down.clientY;
      const pts: [number, number][] = [[down.clientX, down.timeStamp]];
      let started = false;
      let width = 1;
      let x = 0;
      let armed = false;
      let tr0 = '';
      active = true;

      const reset = () => {
        el.style.transition = tr0;
        el.style.translate = '';
        el.style.boxShadow = '';
        if (chip)
          Object.assign(chip.style, {
            transition: '',
            opacity: '0',
            transform: 'scale(.6)',
            background: '',
            color: '',
          });
      };
      const stop = () => {
        active = false;
        abort = null;
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        win.removeEventListener('pointercancel', onUp);
        el.style.userSelect = '';
        el.style.webkitUserSelect = '';
      };
      const paint = (dx: number) => {
        x = swipeOffset(dx);
        el.style.translate = `${x}px 0`;
        if (!chip) return;
        const p = swipeProgress(x, width);
        chip.style.opacity = String(p);
        chip.style.transform = `translateX(${Math.min(x * 0.35, 28)}px) scale(${0.6 + 0.4 * p})`;
        const now = p >= 1;
        if (now !== armed) {
          armed = now;
          chip.style.background = now ? 'var(--acc)' : '';
          chip.style.color = now ? 'var(--accink)' : '';
        }
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        pts.push([e.clientX, e.timeStamp]);
        if (pts.length > 8) pts.shift();
        const dx = e.clientX - x0;
        const dy = e.clientY - y0;
        if (!started) {
          if (Math.hypot(dx, dy) < SLOP) return;
          if (Math.abs(dx) <= Math.abs(dy) || dx <= 0) {
            stop();
            return;
          }
          started = true;
          try {
            win.getSelection()?.removeAllRanges();
          } catch {
            // No selection to clear.
          }
          el.style.userSelect = 'none';
          el.style.webkitUserSelect = 'none';
          width = el.offsetWidth || 1;
          tr0 = el.style.transition;
          el.style.transition = 'none';
          el.style.boxShadow = 'var(--sh3)';
          if (chip) chip.style.transition = 'none';
        }
        if (e.cancelable) e.preventDefault();
        paint(dx);
      };
      const onUp = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        stop();
        if (!started) return;
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        win.addEventListener('click', swallow, true);
        setTimeout(() => win.removeEventListener('click', swallow, true), 0);
        const cancelled = e.type === 'pointercancel';
        const vx = releaseVelocity([...pts, [e.clientX, e.timeStamp]], e.timeStamp);
        if (!cancelled && swipeGoes(x, vx, width)) {
          const d = ms(Math.round(Math.max(160, Math.min(300, (width - x) / Math.max(vx, 0.8)))));
          el.style.transition = `translate ${d}ms ${OUT}`;
          el.style.translate = `${width}px 0`;
          if (chip) {
            chip.style.transition = `opacity ${d}ms ease`;
            chip.style.opacity = '0';
          }
          backTimer = setTimeout(() => {
            backTimer = undefined;
            get()?.back();
            setTimeout(() => {
              if (el.isConnected) reset();
            }, 400);
          }, d + 30);
        } else {
          const d = ms(380);
          el.style.transition = `translate ${d}ms ${SPRING}`;
          el.style.translate = '0 0';
          if (chip) {
            chip.style.transition = `opacity 200ms ease,transform ${d}ms ${SPRING}`;
            chip.style.opacity = '0';
            chip.style.transform = 'scale(.6)';
          }
          setTimeout(() => {
            if (!active) reset();
          }, d + 30);
        }
      };
      abort = () => {
        stop();
        reset();
      };
      win.addEventListener('pointermove', onMove, { passive: false });
      win.addEventListener('pointerup', onUp);
      win.addEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      // The step is gone (another Back came first): no second Back, no listeners left behind.
      clearTimeout(backTimer);
      abort?.();
    };
  };
}
