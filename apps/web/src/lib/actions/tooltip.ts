/**
 * `use:tooltip`: tooltip after 520 ms above the element, at once while one was
 * just visible (450 ms "warm"); by keyboard on focus (`:focus-visible`), on
 * touch devices after a long press (480 ms, then visible for 1.5 s). Click,
 * scrolling and Escape hide it. The text comes as a parameter; without
 * text the element has no tooltip. It is shown by
 * `Tooltip.svelte` in the layout from `ui.tip`.
 */
import type { Action } from 'svelte/action';
import { ui } from '#lib/state/ui.svelte.ts';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** Text, or text with a preferred side (`data-tip-side`, otherwise top). */
export type TooltipParam = string | undefined | { text: string | undefined; side?: TooltipSide };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** State of the tooltip: measure first, then show, then hide. */
export interface TipState {
  text: string;
  side: TooltipSide;
  phase: 'measure' | 'show' | 'hide';
  /** Right after another tooltip: fade in briefly instead of popping up. */
  warm: boolean;
  /** Position of the element in the window. */
  anchor: Rect;
  /** After measuring: position, size and arrow (`x`, `y`, `w`, `h`, `ax`, `ay`). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  ax?: number;
  ay?: number;
}

/** `id` of the tooltip for `aria-describedby`. */
export const TIP_ID = 'sn-tip';

/** Delays in milliseconds: show, "warm" window, long press on touch devices. */
export const TIP_DELAY = 520;
export const TIP_WARM = 450;
export const TIP_LONG_PRESS = 480;
export const TIP_TOUCH_HIDE = 1500;
export const TIP_FADE = 160;

const GAP = 8;
const MARGIN = 8;
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;

/**
 * Position like `tipPlace()`: preferred side, otherwise the opposite one, otherwise
 * bottom or top; kept inside the window, the arrow points at the middle of the element.
 */
export function placeTip(
  a: Rect,
  size: { w: number; h: number },
  view: { w: number; h: number },
  wanted: TooltipSide,
): Required<Pick<TipState, 'side' | 'x' | 'y' | 'ax' | 'ay'>> {
  const { w, h } = size;
  const fits: Record<TooltipSide, boolean> = {
    top: a.y - h - GAP >= MARGIN,
    bottom: a.y + a.h + h + GAP <= view.h - MARGIN,
    right: a.x + a.w + w + GAP <= view.w - MARGIN,
    left: a.x - w - GAP >= MARGIN,
  };
  let side = wanted;
  if (!fits[side]) side = fits[OPPOSITE[side]] ? OPPOSITE[side] : fits.bottom ? 'bottom' : fits.top ? 'top' : side;
  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    x = a.x + a.w / 2 - w / 2;
    y = side === 'top' ? a.y - h - GAP : a.y + a.h + GAP;
  } else {
    y = a.y + a.h / 2 - h / 2;
    x = side === 'left' ? a.x - w - GAP : a.x + a.w + GAP;
  }
  x = Math.round(Math.max(MARGIN, Math.min(x, view.w - w - MARGIN)));
  y = Math.round(Math.max(MARGIN, Math.min(y, view.h - h - MARGIN)));
  const ax = Math.max(12, Math.min(a.x + a.w / 2 - x, w - 12));
  const ay = Math.max(10, Math.min(a.y + a.h / 2 - y, h - 10));
  return { side, x, y, ax, ay };
}

/** Values of the component; `on` only while there is a tooltip. */
export interface TipValues {
  text: string;
  x: number;
  y: number;
  op: number;
  anim: string;
  tr: string;
  origin: string;
  arL: number;
  arT: number;
  pad: string;
}

const KEYFRAME = { top: 'snTipT', bottom: 'snTipB', left: 'snTipL', right: 'snTipR' } as const;

export function tipValues(tip: TipState): TipValues {
  const { side, warm } = tip;
  const placed = tip.phase !== 'measure';
  const hide = tip.phase === 'hide';
  const w = tip.w ?? 0;
  const h = tip.h ?? 0;
  const ax = tip.ax ?? 0;
  const ay = tip.ay ?? 0;
  return {
    text: tip.text,
    x: tip.x ?? 0,
    y: tip.y ?? 0,
    op: placed && !hide ? 1 : 0,
    anim:
      placed && !hide ? (warm ? 'snFade 110ms ease-out' : `${KEYFRAME[side]} 260ms cubic-bezier(.3,1.4,.5,1)`) : 'none',
    tr: hide ? 'opacity 120ms ease' : 'none',
    origin:
      side === 'top'
        ? `${ax}px 100%`
        : side === 'bottom'
          ? `${ax}px 0`
          : side === 'left'
            ? `100% ${ay}px`
            : `0 ${ay}px`,
    arL: side === 'left' ? w - 7 : side === 'right' ? -3 : ax - 5,
    arT: side === 'top' ? h - 7 : side === 'bottom' ? -3 : ay - 5,
    pad: '7px 12px',
  };
}

interface Target {
  text: string | undefined;
  side: TooltipSide;
}

/**
 * The text is already in the name: as `aria-label` or, without one, in the content
 * (e.g. only for screen readers as on the avatar); then no description
 * that repeats it.
 */
function namedBy(el: HTMLElement, text: string): boolean {
  const label = el.getAttribute('aria-label');
  return label === null ? !!el.textContent?.includes(text) : label === text;
}

/** Add or remove `TIP_ID` to/from `aria-describedby`; other descriptions stay. */
function describe(el: HTMLElement, on: boolean): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== TIP_ID);
  if (on) ids.push(TIP_ID);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

function parse(param: TooltipParam): Target {
  return typeof param === 'object' ? { text: param.text, side: param.side ?? 'top' } : { text: param, side: 'top' };
}

/** Controls the one tooltip of the app; elements register via the action. */
class Controller {
  readonly targets = new WeakMap<HTMLElement, Target>();
  /** Element of the visible or measured tooltip. */
  current: HTMLElement | null = null;
  /** Element whose tooltip is about to appear. */
  pending: HTMLElement | null = null;
  /** After a click no tooltip until the pointer leaves the element. */
  suppressed: HTMLElement | null = null;
  hiddenAt = 0;
  longPress: { x: number; y: number } | null = null;
  longPressFired = false;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  #offTimer: ReturnType<typeof setTimeout> | undefined;
  #autoTimer: ReturnType<typeof setTimeout> | undefined;
  #pressTimer: ReturnType<typeof setTimeout> | undefined;
  #listening = 0;

  get warm(): boolean {
    return ui.tip?.phase === 'show' || Date.now() - this.hiddenAt < TIP_WARM;
  }

  show(el: HTMLElement, delay: number): void {
    clearTimeout(this.#showTimer);
    this.pending = el;
    const go = () => {
      this.pending = null;
      const target = this.targets.get(el);
      if (!el.isConnected || !target?.text) return;
      if (this.current && this.current !== el) describe(this.current, false);
      this.current = el;
      if (!namedBy(el, target.text)) describe(el, true);
      clearTimeout(this.#offTimer);
      clearTimeout(this.#autoTimer);
      const r = el.getBoundingClientRect();
      ui.tip = {
        text: target.text,
        side: target.side,
        phase: 'measure',
        warm: this.warm,
        anchor: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    };
    if (delay) this.#showTimer = setTimeout(go, delay);
    else go();
  }

  hide(): void {
    clearTimeout(this.#showTimer);
    clearTimeout(this.#autoTimer);
    this.pending = null;
    if (this.current) describe(this.current, false);
    this.current = null;
    const tip = ui.tip;
    if (!tip || tip.phase === 'hide') return;
    this.hiddenAt = Date.now();
    if (tip.phase === 'measure') {
      ui.tip = null;
      return;
    }
    ui.tip = { ...tip, phase: 'hide' };
    clearTimeout(this.#offTimer);
    this.#offTimer = setTimeout(() => {
      if (ui.tip?.phase === 'hide') ui.tip = null;
    }, TIP_FADE);
  }

  /** Text of the element changed: a visible tooltip with the old text disappears. */
  update(el: HTMLElement, target: Target): void {
    const before = this.targets.get(el);
    this.targets.set(el, target);
    if ((el === this.current || el === this.pending) && before?.text !== target.text) this.hide();
  }

  remove(el: HTMLElement): void {
    if (el === this.current || el === this.pending) this.hide();
    if (el === this.suppressed) this.suppressed = null;
    this.targets.delete(el);
  }

  enter(el: HTMLElement, event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    if (el === this.current || el === this.pending || el === this.suppressed) return;
    this.show(el, this.warm ? 0 : TIP_DELAY);
  }

  leave(el: HTMLElement, event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    if (el === this.suppressed) this.suppressed = null;
    if (el === this.current || el === this.pending) this.hide();
  }

  down(el: HTMLElement, event: PointerEvent): void {
    this.longPressFired = false;
    clearTimeout(this.#pressTimer);
    this.longPress = null;
    this.suppressed = el;
    if (ui.tip || this.pending) this.hide();
    // Without text no long press: the click afterwards must go through.
    if (event.pointerType !== 'touch' || !this.targets.get(el)?.text) return;
    this.longPress = { x: event.clientX, y: event.clientY };
    this.#pressTimer = setTimeout(() => {
      this.longPress = null;
      this.longPressFired = true;
      this.show(el, 0);
    }, TIP_LONG_PRESS);
  }

  move(event: PointerEvent): void {
    if (this.longPress && Math.hypot(event.clientX - this.longPress.x, event.clientY - this.longPress.y) > 10) {
      clearTimeout(this.#pressTimer);
      this.longPress = null;
    }
  }

  up(): void {
    clearTimeout(this.#pressTimer);
    this.longPress = null;
    if (this.longPressFired) {
      clearTimeout(this.#autoTimer);
      this.#autoTimer = setTimeout(() => this.hide(), TIP_TOUCH_HIDE);
    }
  }

  /**
   * After a long press releasing triggers no click. Otherwise a click
   * hides it – also by keyboard (Enter, Space), which comes without `pointerdown`.
   */
  click(el: HTMLElement, event: MouseEvent): void {
    if (!this.longPressFired) {
      if (el === this.current || el === this.pending) {
        this.suppressed = el;
        this.hide();
      }
      return;
    }
    this.longPressFired = false;
    event.preventDefault();
    event.stopPropagation();
  }

  contextMenu(event: Event): void {
    if (this.longPress || this.longPressFired) event.preventDefault();
  }

  focus(el: HTMLElement): void {
    if (el === this.current) return;
    let visible = false;
    try {
      visible = el.matches(':focus-visible');
    } catch {
      // older browsers without :focus-visible: no tooltip on focus
    }
    if (visible) this.show(el, 0);
  }

  /**
   * Leaving focus: hide, only after the current event. Chromium
   * also reports `blur` when Svelte removes the focused element while tearing
   * down a block (e.g. "Close" of a dialog after Escape); there
   * `ui.tip` must not change (`state_unsafe_mutation`). If focus moves
   * to an element with a tooltip, its tooltip replaces the old one beforehand.
   */
  blur(el: HTMLElement): void {
    queueMicrotask(() => {
      if (el === this.current || el === this.pending) this.hide();
    });
  }

  readonly onScroll = (): void => {
    if (ui.tip || this.pending) this.hide();
  };

  readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (ui.tip || this.pending)) this.hide();
  };

  /** Scrolling and Escape apply window-wide; registered while an element uses the tooltip. */
  listen(): () => void {
    if (this.#listening++ === 0) {
      window.addEventListener('scroll', this.onScroll, true);
      window.addEventListener('wheel', this.onScroll, { passive: true });
      window.addEventListener('keydown', this.onKey);
    }
    return () => {
      if (--this.#listening > 0) return;
      window.removeEventListener('scroll', this.onScroll, true);
      window.removeEventListener('wheel', this.onScroll);
      window.removeEventListener('keydown', this.onKey);
    };
  }
}

export const tooltips = new Controller();

/** Hides the tooltip (e.g. on sign-out). */
export function hideTooltip(): void {
  tooltips.hide();
}

export const tooltip: Action<HTMLElement, TooltipParam> = (node, param) => {
  tooltips.targets.set(node, parse(param));
  const enter = (e: PointerEvent) => tooltips.enter(node, e);
  const leave = (e: PointerEvent) => tooltips.leave(node, e);
  const down = (e: PointerEvent) => tooltips.down(node, e);
  const move = (e: PointerEvent) => tooltips.move(e);
  const up = () => tooltips.up();
  const click = (e: MouseEvent) => tooltips.click(node, e);
  const menu = (e: Event) => tooltips.contextMenu(e);
  const focus = () => tooltips.focus(node);
  const blur = () => tooltips.blur(node);
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', menu);
  node.addEventListener('focus', focus);
  node.addEventListener('blur', blur);
  const unlisten = tooltips.listen();
  return {
    update(next) {
      tooltips.update(node, parse(next));
    },
    destroy() {
      tooltips.remove(node);
      unlisten();
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', menu);
      node.removeEventListener('focus', focus);
      node.removeEventListener('blur', blur);
    },
  };
};
