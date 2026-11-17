/**
 * Swipe gestures of the message list and the toast, and dragging sheets and
 * dialogs down to close them: actions per direction from the settings,
 * threshold, rubber band, sliding out or springing back.
 *
 * The gestures paint directly on the DOM (offset, clip and colour of the
 * background), not via Svelte state: otherwise every pointer move would change
 * the values of the whole list. One gesture at a time.
 */
import type { Attachment } from 'svelte/attachments';
import type { IconName } from '#lib/icons.ts';
import { hideTooltip } from '#lib/actions/tooltip.ts';
import type { ListKind } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';

/** Action of a swipe direction (all settings values except "No action"). */
export type SwipeKey = 'del' | 'read' | 'star' | 'spam' | 'move';

/** Action behind the row: icon and label of the background, its colours and whether the row slides out. */
export interface SwipeAction {
  key: SwipeKey;
  icon: IconName;
  label: string;
  /** Colour of the background from the threshold on (`c`); before that mixed 30 % into the list background. */
  c: string;
  /** Text colour on the background from the threshold on (`ink`). */
  ink: string;
  /** The row slides out before the action runs (`out`: delete except in the trash, spam). */
  out: boolean;
}

/**
 * Action for the setting `key` (left or right swipe) on a row of the view
 * `kind`, `null` without an action ("No action", unknown value or not possible
 * at this place): read not in trash and scheduled, move not in drafts and
 * scheduled, spam not in sent, drafts, scheduled and trash, in spam "Not
 * spam". Delete everywhere; in scheduled it cancels the sending.
 */
export function swipeAction(key: string, row: { unread: boolean; star: boolean }, kind: ListKind): SwipeAction | null {
  const role = 'role' in kind ? kind.role : null;
  const trash = role === 'trash';
  const scheduled = role === 'scheduled';
  switch (key) {
    case 'del':
      return {
        key: 'del',
        icon: trash ? 'ti-trash-x' : 'ti-trash',
        label: trash ? m.list_purge() : m.list_delete(),
        c: 'var(--danger)',
        // fixed values (text on red per theme, `color-scheme` of the tokens)
        ink: 'light-dark(#fffaf3, #2b0d07)',
        out: !trash,
      };
    case 'read':
      if (trash || scheduled) return null;
      return {
        key: 'read',
        icon: row.unread ? 'ti-mail-opened' : 'ti-mail',
        label: row.unread ? m.list_bulk_read() : m.list_bulk_unread(),
        c: 'var(--acc)',
        ink: 'var(--accink)',
        out: false,
      };
    case 'star':
      return {
        key: 'star',
        icon: row.star ? 'ti-star-off' : 'ti-star',
        label: row.star ? m.list_bulk_unstar() : m.list_star(),
        // fixed values (colour of the star)
        c: '#e3a93a',
        ink: '#2e1f05',
        out: false,
      };
    case 'move':
      if (role === 'drafts' || scheduled) return null;
      return {
        key: 'move',
        icon: 'ti-folder-symlink',
        label: m.list_swipe_move(),
        // fixed values
        c: '#82bbec',
        ink: '#0b2a47',
        out: false,
      };
    case 'spam':
      if (role === 'sent' || role === 'drafts' || scheduled || trash) return null;
      return {
        key: 'spam',
        icon: role === 'spam' ? 'ti-shield-check' : 'ti-alert-octagon',
        label: role === 'spam' ? m.read_not_spam() : m.list_swipe_spam(),
        c: 'var(--ink)',
        ink: 'var(--inkfg)',
        out: true,
      };
    default:
      return null;
  }
}

// --- Gesture maths (without DOM) ---

/** Distance in px from which a movement counts as a gesture (`gDecide` after 8 px). */
export const SLOP = 8;
/** After springing back the toast runs this much longer and then goes as if expired (`gRelease`). */
export const TOAST_BACK_MS = 2400;

/** Rubber band: grows with `d` but stays below `max` (`rubber`). */
export const rubber = (d: number, max: number): number => (max * d) / (d + max);

/** Trigger threshold of the row: 30 % of its width, at most 130 px. */
export const swipeThreshold = (width: number): number => Math.min(width * 0.3, 130);

/**
 * Offset of the row for the movement `dx`: with an action in this direction
 * free up to 85 % of the width, beyond that as a rubber band; without an action
 * only a rubber band.
 */
export function swipeOffset(dx: number, width: number, has: boolean): number {
  const d = Math.abs(dx);
  const lim = width * 0.85;
  const sign = dx < 0 ? -1 : 1;
  if (!has) return sign * rubber(d, 28);
  return sign * (d <= lim ? d : lim + rubber(d - lim, 40));
}

/** The action triggers: beyond the threshold or flung fast (over 0.7 px/ms) in its direction, after at least 48 px. */
export function swipeFires(x: number, vx: number, threshold: number): boolean {
  const sign = x < 0 ? -1 : 1;
  return Math.abs(x) >= threshold || (Math.abs(vx) > 0.7 && Math.sign(vx) === sign && Math.abs(x) > 48);
}

/** Offset of the toast: free sideways and downwards, upwards only as a rubber band. */
export const toastOffset = (dx: number, dy: number): [number, number] => [dx, dy > 0 ? dy : -rubber(-dy, 18)];

/** Opacity of the toast while dragging: fades with the distance, at most to 25 %. */
export const toastOpacity = (dx: number, dy: number): number =>
  1 - Math.min(0.75, Math.hypot(dx, Math.max(0, dy)) / 140);

/** The toast goes: dragged further than 56 px sideways or down, or flung faster than 0.5 px/ms. */
export const toastGone = (dx: number, dy: number, vx: number, vy: number): boolean =>
  Math.hypot(dx, Math.max(0, dy)) > 56 || Math.hypot(vx, Math.max(0, vy)) > 0.5;

/** A sheet closes when dragged further than 30 % of its height and not flung back up, or when flung down faster than 0.5 px/ms. */
export const sheetCloses = (off: number, height: number, vy: number): boolean =>
  (off > height * 0.3 && vy > -0.3) || vy > 0.5;

/** Duration in ms of a sheet sliding out: its height at the release velocity (at least 1.6 px/ms), 150 to 300 ms. */
export const sheetOutMs = (height: number, vy: number): number =>
  Math.round(Math.max(150, Math.min(300, height / Math.max(Math.abs(vy), 1.6))));

/** Velocity in px/ms of a fling after `dt` ms: decays by 0.996 per ms. */
export const flingDecay = (v: number, dt: number): number => v * 0.996 ** dt;

/** Point of the pointer: x, y and time stamp of the event. */
export type TrackPoint = readonly [x: number, y: number, t: number];

/**
 * Velocity in px/ms over the last points, on release at time `at`; null if
 * the pointer was last standing still (90 ms without movement).
 */
export function velocity(points: readonly TrackPoint[], at: number): [number, number] {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b) return [0, 0];
  const dt = b[2] - a[2];
  if (dt <= 0 || at - b[2] >= 90) return [0, 0];
  return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt];
}

// --- Tracking the pointer ---

/** One pointer at a time, and no new gesture while one slides out. */
let tracking = false;
let animating = false;

interface Steps {
  /** After 8 px: does the movement belong to this gesture? Otherwise tracking ends (scrolling stays with the browser). */
  decide: (dx: number, dy: number) => boolean;
  start: () => void;
  /** Movement since the point of decision. */
  move: (dx: number, dy: number) => void;
  /**
   * Released with the velocity in px/ms; `cancelled` if the browser cancelled
   * the gesture (`pointercancel`, e.g. a system gesture): then back without an
   * action.
   */
  end: (vx: number, vy: number, cancelled: boolean) => void;
}

const EDITABLE = 'input,textarea,select,[contenteditable="true"],[draggable="true"]';

/** May a gesture start at this place (`onGDown`)? */
function canStart(e: PointerEvent): boolean {
  if (tracking || animating || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return false;
  return !(e.target instanceof Element && e.target.closest(EDITABLE));
}

/**
 * Swallow the click after a gesture so that the row does not open and no
 * button triggers (`gSup`): the next click, for at most 300 ms – the browser
 * produces the click of a tap after `touchend`, not always in the same tick.
 */
function swallowClick(): void {
  const off = () => {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    off();
  };
  const timer = setTimeout(off, 300);
  window.addEventListener('click', swallow, true);
}

/** Tracks the pointer from `down` across the window until release (`onGDown`, `onGMove`, `onGUp`). */
function follow(down: PointerEvent, steps: Steps): void {
  tracking = true;
  const id = down.pointerId;
  let x0 = down.clientX;
  let y0 = down.clientY;
  let decided = false;
  const points: TrackPoint[] = [[down.clientX, down.clientY, down.timeStamp]];
  const root = document.documentElement.style;

  const stop = () => {
    tracking = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    root.userSelect = '';
    root.webkitUserSelect = '';
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    points.push([e.clientX, e.clientY, e.timeStamp]);
    if (points.length > 6) points.shift();
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (decided) {
      steps.move(dx, dy);
      return;
    }
    if (Math.hypot(dx, dy) < SLOP) return;
    if (!steps.decide(dx, dy)) {
      stop();
      return;
    }
    decided = true;
    x0 = e.clientX;
    y0 = e.clientY;
    // No text selection during the gesture (`gStart`).
    root.userSelect = 'none';
    root.webkitUserSelect = 'none';
    window.getSelection()?.removeAllRanges();
    hideTooltip();
    steps.start();
    steps.move(0, 0);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    stop();
    if (!decided) return;
    swallowClick();
    const cancelled = e.type !== 'pointerup';
    const [vx, vy] = cancelled ? [0, 0] : velocity(points, e.timeStamp);
    steps.end(vx, vy, cancelled);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/** Curves for springing back and sliding out; a sheet slides down with `SHEET_OUT`. */
const SPRING = 'cubic-bezier(.2,1.15,.35,1)';
const ACCEL = 'cubic-bezier(.4,0,1,1)';
const SHEET_OUT = 'cubic-bezier(.3,.6,.4,1)';

/** Runs `fn` after `ms` and blocks new gestures until then (`later`). */
function later(ms: number, fn: () => void): void {
  animating = true;
  setTimeout(() => {
    animating = false;
    fn();
  }, ms);
}

// --- Row ---

/** Values of a swipeable row; `null` without swipe gestures (desktop) or without an action in both directions. */
export interface RowSwipe {
  /** Swipe left: background on the right. */
  left: SwipeAction | null;
  /** Swipe right: background on the left. */
  right: SwipeAction | null;
  /** Background of the list into which the colour is mixed before the threshold (`data-sw-fill`). */
  fill: string;
  /** Setting "Animations": without it, row and background jump immediately. */
  animations: boolean;
  run: (action: SwipeAction) => void;
}

/**
 * Swipe gesture of a row (`data-sw`) as an attachment on its wrapper. The
 * wrapper contains the background `[data-sw-bg]` with two children (on the left
 * the action for swiping right, on the right the one for swiping left;
 * wrapper, background and children via CSS with `opacity: 0`, children with
 * `transform: scale(var(--sws, 1))`) and the row `[data-sw-row]`.
 * `touch-action: pan-y` on the wrapper leaves scrolling to the browser and the
 * horizontal movement to the gesture. `get` reads the values only on touch, so
 * the attachment does not rerun on every change.
 */
export function swipeRow(get: () => RowSwipe | null): Attachment<HTMLElement> {
  return (el) => {
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const onDown = (e: PointerEvent) => {
      if (!canStart(e)) return;
      const o = get();
      const row = el.querySelector<HTMLElement>('[data-sw-row]');
      const bg = el.querySelector<HTMLElement>('[data-sw-bg]');
      if (!o || (!o.left && !o.right) || !row || !bg) return;
      const action = (dir: 'L' | 'R') => (dir === 'L' ? o.left : o.right);
      const ms = (n: number) => (o.animations ? n : 0);
      const sides = [...bg.children] as HTMLElement[];
      let width = 0;
      let threshold = 0;
      let radius = 0;
      let x = 0;
      let dir: 'L' | 'R' | null = null;
      let armed: 'L' | 'R' | null | undefined;

      const reset = () => {
        row.style.transition = '';
        row.style.transform = '';
        bg.style.transition = '';
        bg.style.opacity = '';
        bg.style.background = '';
        bg.style.color = '';
        bg.style.clipPath = '';
        bg.style.removeProperty('--sws');
        for (const s of sides) s.style.opacity = '';
        el.style.overflow = '';
      };

      follow(e, {
        decide: (dx, dy) => Math.abs(dx) > Math.abs(dy) && !!action(dx < 0 ? 'L' : 'R'),
        start: () => {
          clearTimeout(resetTimer);
          width = el.offsetWidth;
          threshold = swipeThreshold(width);
          // Corners of the wrapper (`data-sw-r`) for the clip of the background.
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          el.style.overflow = 'hidden';
          row.style.transition = 'none';
          bg.style.transition = 'background-color 160ms ease, color 160ms ease';
          bg.style.opacity = '1';
        },
        move: (dx) => {
          const d = dx < 0 ? 'L' : 'R';
          const a = action(d);
          x = swipeOffset(dx, width, !!a);
          row.style.transform = `translateX(${x}px)`;
          const cut = `${Math.max(0, width - Math.abs(x) + 5)}px`;
          bg.style.clipPath =
            x >= 0 ? `inset(0 ${cut} 0 0 round ${radius}px)` : `inset(0 0 0 ${cut} round ${radius}px)`;
          const on = a && Math.abs(x) >= threshold ? d : null;
          if (dir !== d) {
            dir = d;
            if (sides[0]) sides[0].style.opacity = d === 'R' && a ? '1' : '0';
            if (sides[1]) sides[1].style.opacity = d === 'L' && a ? '1' : '0';
            armed = undefined;
          }
          if (armed !== on) {
            armed = on;
            bg.style.background = a ? (on ? a.c : `color-mix(in oklab, ${a.c} 30%, ${o.fill})`) : 'transparent';
            bg.style.color = on && a ? a.ink : 'var(--fg)';
            bg.style.setProperty('--sws', on ? '1.1' : '0.92');
          }
        },
        end: (vx, _vy, cancelled) => {
          const a = action(x < 0 ? 'L' : 'R');
          const go = !!a && !cancelled && swipeFires(x, vx, threshold);
          if (a && go && a.out) {
            const t = ms(210);
            bg.style.background = a.c;
            bg.style.color = a.ink;
            bg.style.transition = `clip-path ${t}ms ${ACCEL}`;
            bg.style.clipPath = `inset(0 0 0 0 round ${radius}px)`;
            row.style.transition = `transform ${t}ms ${ACCEL}`;
            row.style.transform = `translateX(${(x < 0 ? -1 : 1) * (width + 24)}px)`;
            // Only after sliding out; if the row stays (e.g. without effect), it comes back.
            later(t, () => {
              // If the list is gone in the meantime (another view), the action is dropped.
              if (alive) o.run(a);
              requestAnimationFrame(() => requestAnimationFrame(reset));
            });
            return;
          }
          const t = ms(380);
          row.style.transition = `transform ${t}ms ${SPRING}`;
          row.style.transform = 'translateX(0px)';
          bg.style.transition = `opacity ${ms(240)}ms ease`;
          bg.style.opacity = '0';
          if (a && go) o.run(a);
          resetTimer = setTimeout(reset, t + 30);
        },
      });
    };

    el.addEventListener('pointerdown', onDown);
    return () => {
      alive = false;
      el.removeEventListener('pointerdown', onDown);
      clearTimeout(resetTimer);
    };
  };
}

// --- Toast ---

/** Values of the swipeable toast. */
export interface ToastSwipe {
  animations: boolean;
  /** Gesture starts: the toast stays until it ends. */
  hold: () => void;
  /** Swiped away: close the toast, send a pending action immediately (`toastFlush`). */
  away: () => void;
  /** Sprung back: the toast runs for another `TOAST_BACK_MS` and then goes as if expired. */
  back: () => void;
}

/**
 * Swiping the toast (`data-g="toast"`, `touch-action: none`) in any direction
 * except up: far or fast enough it flies out, otherwise it springs back. Takes
 * precedence over all other gestures; a short tap on "Undo" stays a
 * click.
 */
export function swipeToast(get: () => ToastSwipe): Attachment<HTMLElement> {
  return (el) => {
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const onDown = (e: PointerEvent) => {
      if (!canStart(e)) return;
      const o = get();
      const ms = (n: number) => (o.animations ? n : 0);
      let dx = 0;
      let dy = 0;
      follow(e, {
        decide: () => true,
        start: () => {
          clearTimeout(resetTimer);
          o.hold();
          el.style.transition = 'none';
        },
        move: (x, y) => {
          dx = x;
          dy = y;
          const [tx, ty] = toastOffset(x, y);
          el.style.translate = `${tx}px ${ty}px`;
          el.style.filter = `opacity(${toastOpacity(x, y)})`;
        },
        end: (vx, vy, cancelled) => {
          if (!cancelled && toastGone(dx, dy, vx, vy)) {
            const t = ms(200);
            const py = Math.max(0, dy);
            const n = Math.max(Math.hypot(dx, py), 1);
            el.style.transition = `translate ${t}ms ease-out, filter ${t}ms ease-out`;
            el.style.translate = `${dx + (dx / n) * 120}px ${py + (py / n) * 120}px`;
            el.style.filter = 'opacity(0)';
            later(t, o.away);
            return;
          }
          const t = ms(380);
          el.style.transition = `translate ${t}ms ${SPRING}, filter ${t}ms ease`;
          el.style.translate = '0 0';
          el.style.filter = 'opacity(1)';
          o.back();
          resetTimer = setTimeout(() => {
            el.style.transition = '';
            el.style.translate = '';
            el.style.filter = '';
          }, t + 30);
        },
      });
    };

    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      clearTimeout(resetTimer);
    };
  };
}

// --- Sheet ---

/** Momentum scrolling after releasing a sheet (`gFling`); a new touch stops it. */
let flingRaf = 0;

/** Scrolls `sc` on with the velocity `v` in px/ms until it stops or reaches the end. */
function fling(sc: HTMLElement, v: number): void {
  cancelAnimationFrame(flingRaf);
  if (Math.abs(v) < 0.05) return;
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(32, now - last);
    last = now;
    v = flingDecay(v, dt);
    const before = sc.scrollTop;
    sc.scrollTop = before + v * dt;
    if (Math.abs(v) > 0.03 && sc.scrollTop !== before) flingRaf = requestAnimationFrame(step);
  };
  flingRaf = requestAnimationFrame(step);
}

/** Nearest element between `from` and `stop` (exclusive) that scrolls vertically (`gScroller`). */
function scroller(from: Element, stop: Element): HTMLElement | null {
  for (let n: Element | null = from; n && n !== stop; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

/** Values of a sheet or dialog that can be dragged down to close it. */
export interface SheetDrag {
  /** Setting "Animations": without it, the sheet closes or comes back immediately. */
  animations: boolean;
  /**
   * Backdrop of the layer: fades while dragging, and the gesture closes the
   * layer with a `mousedown` on it, exactly like a click on the backdrop.
   * Without it the parent element (a dialog inside its backdrop).
   */
  scrim?: HTMLElement | null;
}

/**
 * Dragging a sheet (mobile) or dialog (tablet) down to close it, as an
 * attachment on the panel; `null` from `get` turns it off (desktop with a
 * mouse, a confirmation without "Cancel"). Vertical movement anywhere on the
 * panel except in fields; inside content that is scrolled, the content
 * scrolls first and the panel only follows from `scrollTop ≤ 0` downwards
 * (with a mouse it follows at once and scrolls the content itself).
 * Upwards only as a rubber band, the backdrop fades with the offset. Released
 * far or fast enough, the panel slides out and the layer closes; otherwise it
 * springs back. Content that was scrolled keeps scrolling with momentum.
 */
export function dragSheet(get: () => SheetDrag | null): Attachment<HTMLElement> {
  return (el) => {
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const onDown = (e: PointerEvent) => {
      cancelAnimationFrame(flingRaf);
      if (!canStart(e)) return;
      const o = get();
      if (!o) return;
      const ms = (n: number) => (o.animations ? n : 0);
      const target = e.target instanceof Element ? e.target : el;
      const mouse = e.pointerType === 'mouse';
      let scrim: HTMLElement | null = null;
      let sc: HTMLElement | null = null;
      let st0 = 0;
      let height = 0;
      let off = 0;

      const reset = () => {
        el.style.transition = '';
        el.style.translate = '';
        if (scrim) {
          scrim.style.transition = '';
          scrim.style.opacity = '';
        }
      };

      follow(e, {
        decide: (dx, dy) => {
          if (Math.abs(dx) > Math.abs(dy)) return false;
          sc = scroller(target, el);
          if (!mouse && sc && !(dy > 0 && sc.scrollTop <= 0)) return false;
          st0 = sc ? sc.scrollTop : 0;
          return true;
        },
        start: () => {
          clearTimeout(resetTimer);
          scrim = o.scrim === undefined ? el.parentElement : o.scrim;
          height = el.offsetHeight;
          el.style.transition = 'none';
          if (scrim) scrim.style.transition = 'none';
        },
        move: (_dx, dy) => {
          off = dy;
          if (sc) {
            const want = st0 - dy;
            sc.scrollTop = Math.max(0, want);
            off = want < 0 ? -want : 0;
          }
          el.style.translate = `0 ${off >= 0 ? off : -rubber(-off, 30)}px`;
          if (scrim) scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, off) / height));
        },
        end: (_vx, vy) => {
          if (sc && off <= 0) {
            fling(sc, -vy);
            reset();
            return;
          }
          if (sheetCloses(off, height, vy)) {
            const t = ms(sheetOutMs(height, vy));
            el.style.transition = `translate ${t}ms ${SHEET_OUT}`;
            el.style.translate = `0 ${height + 24}px`;
            if (scrim) {
              scrim.style.transition = `opacity ${t}ms ease`;
              scrim.style.opacity = '0';
            }
            later(t, () => {
              scrim?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              // Still there (the layer refused to close): back into place.
              requestAnimationFrame(() => {
                if (el.isConnected) reset();
              });
            });
            return;
          }
          const t = ms(440);
          el.style.transition = `translate ${t}ms ${SPRING}`;
          el.style.translate = '0 0';
          if (scrim) {
            scrim.style.transition = `opacity ${t}ms ease`;
            scrim.style.opacity = '1';
          }
          resetTimer = setTimeout(reset, t + 30);
        },
      });
    };

    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      clearTimeout(resetTimer);
    };
  };
}
