/**
 * `{@attach scrollbar}`: overlay scrollbar for a vertical scroll area whose native
 * bar is hidden (`.no-scrollbar`). The bar is a sibling right after the area,
 * `aria-hidden` and outside the tab order; keyboard and screen readers keep
 * using the area itself.
 *
 * It shows only while the area overflows and the track is longer than the
 * minimum thumb + 16 px: on hover over the area (desktop), while scrolling and
 * while dragging, and hides `hide` ms later. Hovering the hit zone widens the
 * thumb from `width` to `hot` with track and grip lines; a click in the zone
 * jumps there, dragging the thumb scrolls. While dragging, a pill next to the
 * thumb names the current `h1`/`h2` section if the area has at least two. At the
 * start and end the mouse wheel squashes the thumb, which springs back.
 *
 * Profiles: `desk`, `tab` (touch: wider zone, no hover) and `mob` (no bar).
 */
import type { Attachment } from 'svelte/attachments';
import { untrack } from 'svelte';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export type ScrollbarProfile = 'desk' | 'tab' | 'mob';

export interface ScrollbarConfig {
  /** Width of the hit zone along the right edge. */
  zone: number;
  /** Gap between the thumb's centre column and the right edge (`inset + hot / 2`). */
  inset: number;
  /** Thumb width at rest. */
  width: number;
  /** Thumb width while active. */
  hot: number;
  /** Minimum thumb length. */
  min: number;
  /** Hides this long after the last scroll or drag. */
  hide: number;
}

export const SCROLLBAR: Record<ScrollbarProfile, ScrollbarConfig> = {
  desk: { zone: 20, inset: 6, width: 5, hot: 10, min: 48, hide: 1200 },
  tab: { zone: 30, inset: 6, width: 5, hot: 10, min: 44, hide: 1000 },
  mob: { zone: 26, inset: 5, width: 4, hot: 8, min: 40, hide: 850 },
};

/** Spring of the thumb width. */
const SPRING = 'cubic-bezier(.34,1.45,.64,1)';
/** Spring back after the squash at the start or end. */
const SQUASH_BACK = 'transform 520ms cubic-bezier(.34,1.56,.64,1)';
const ACC = 'var(--acc)';

/** `--fg` at `n` % (thumb, track). */
const mix = (n: number) => `color-mix(in oklab,var(--fg) ${n}%,transparent)`;

export interface ScrollbarEnv {
  profile: () => ScrollbarProfile;
  /** Motion on (setting "Animations" and no reduced motion). */
  motion: () => boolean;
}

interface Geometry {
  W: number;
  H: number;
  /** Track start (inset at the top). */
  yS: number;
  /** Length the thumb runs along. */
  L: number;
  /** Centre column of the thumb from the left. */
  cx: number;
}

function div(style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, style);
  return el;
}

/** Right corner radii of the area, or of an ancestor flush with it (card, popover). */
function radii(c: HTMLElement): [number, number] {
  const cs = getComputedStyle(c);
  let rt = parseFloat(cs.borderTopRightRadius) || 0;
  let rb = parseFloat(cs.borderBottomRightRadius) || 0;
  const cr = c.getBoundingClientRect();
  const tol = 2 * (cr.width / c.offsetWidth || 1);
  for (let a = c.parentElement, n = 0; a && n < 6 && (!rt || !rb); a = a.parentElement, n++) {
    const ar = a.getBoundingClientRect();
    if (ar.right - cr.right > tol) break;
    if (Math.abs(ar.right - cr.right) > tol) continue;
    const as = getComputedStyle(a);
    if (!rt && Math.abs(ar.top - cr.top) <= tol) rt = parseFloat(as.borderTopRightRadius) || 0;
    if (!rb && Math.abs(ar.bottom - cr.bottom) <= tol) rb = parseFloat(as.borderBottomRightRadius) || 0;
  }
  return [rt, rb];
}

export class OverlayScrollbar {
  readonly el: HTMLDivElement;
  readonly thumb: HTMLDivElement;
  readonly pill: HTMLDivElement;
  readonly grip: HTMLDivElement;
  readonly track: HTMLDivElement;
  readonly label: HTMLDivElement;
  readonly zone: HTMLDivElement;
  readonly hit: HTMLDivElement;
  readonly #rail: HTMLDivElement;
  readonly #c: HTMLElement;
  readonly #env: ScrollbarEnv;

  profile: ScrollbarProfile = 'desk';
  /** The bar may show: area overflows and the track is long enough. */
  can = false;
  hover = false;
  zoneHover = false;
  onThumb = false;
  drag = false;
  scrolling = false;
  #narrow = false;
  #hasLabel = false;
  #g: Geometry | null = null;
  /** Thumb length and offset along the track. */
  #tL = 0;
  #s = 0;
  #lbl = '';
  #sq = 0;
  #hideT: ReturnType<typeof setTimeout> | undefined;
  #sqT: ReturnType<typeof setTimeout> | undefined;
  #raf = 0;
  #ro: ResizeObserver | null = null;
  #mo: MutationObserver | null = null;
  #off: (() => void)[] = [];

  constructor(c: HTMLElement, env: ScrollbarEnv) {
    this.#c = c;
    this.#env = env;
    this.el = div({ position: 'absolute', zIndex: '4', pointerEvents: 'none', userSelect: 'none' });
    this.el.setAttribute('aria-hidden', 'true');
    this.el.setAttribute('data-scrollbar', '');
    this.#rail = div({ position: 'absolute', pointerEvents: 'none' });
    this.track = div({ position: 'absolute', inset: '0', borderRadius: '9999px', opacity: '0' });
    this.thumb = div({
      position: 'absolute',
      left: '0',
      right: '0',
      top: '0',
      display: 'flex',
      justifyContent: 'center',
    });
    this.pill = div({ height: '100%', borderRadius: '9999px', opacity: '0', display: 'grid', placeItems: 'center' });
    this.grip = div({
      width: '4px',
      height: '5px',
      opacity: '0',
      background: 'linear-gradient(currentColor 0 1.5px,transparent 1.5px 3.5px,currentColor 3.5px)',
      borderRadius: '1px',
    });
    this.label = div({
      position: 'absolute',
      top: '0',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      padding: '7px 13px',
      borderRadius: '9999px',
      background: 'var(--ink)',
      color: 'var(--inkfg)',
      font: '700 13px/1.2 var(--font-sans)',
      boxShadow: 'var(--sh2)',
      opacity: '0',
      transform: 'translateX(6px)',
    });
    this.zone = div({ position: 'absolute', right: '0', touchAction: 'none', cursor: 'default' });
    this.hit = div({ position: 'absolute', right: '0', top: '0', touchAction: 'none', cursor: 'default' });
    this.pill.append(this.grip);
    this.thumb.append(this.pill);
    this.#rail.append(this.track, this.thumb);
    this.el.append(this.#rail, this.label, this.zone, this.hit);

    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      this.#off.push(() => target.removeEventListener(type, fn, opts));
    };
    on(c, 'mouseenter', () => {
      this.hover = true;
      this.layout();
    });
    on(c, 'mouseleave', () => {
      this.hover = false;
      this.paint();
    });
    on(this.zone, 'mouseenter', () => {
      this.zoneHover = true;
      this.paint();
    });
    on(this.zone, 'mouseleave', () => {
      this.zoneHover = false;
      this.paint();
    });
    on(this.hit, 'mouseenter', () => {
      this.onThumb = true;
      this.paint();
    });
    on(this.hit, 'mouseleave', () => {
      this.onThumb = false;
      this.paint();
    });
    on(c, 'scroll', () => this.#scrolled(), { passive: true });
    on(c, 'wheel', (e) => this.#edge(e.deltaY), { passive: true });
    on(
      this.el,
      'wheel',
      (e) => {
        // Ctrl + wheel stays the browser's zoom.
        if (e.ctrlKey) return;
        e.preventDefault();
        this.#edge(e.deltaY);
        c.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? c.clientHeight : 1);
      },
      { passive: false },
    );
    on(this.el, 'pointerdown', (e) => this.#down(e));

    c.after(this.el);
    if (typeof ResizeObserver !== 'undefined') {
      this.#ro = new ResizeObserver(() => this.#schedule());
      this.#observe();
    }
    if (typeof MutationObserver !== 'undefined') {
      // Content added deeper down can change the overflow without resizing an observed box.
      this.#mo = new MutationObserver((records) => {
        if (records.some((r) => r.target === c)) this.#observe();
        this.#schedule();
      });
      this.#mo.observe(c, { childList: true, subtree: true, characterData: true });
    }
    this.layout();
  }

  get #cfg(): ScrollbarConfig {
    return SCROLLBAR[this.profile];
  }

  #observe(): void {
    if (!this.#ro) return;
    this.#ro.disconnect();
    this.#ro.observe(this.#c);
    for (const child of this.#c.children) this.#ro.observe(child);
  }

  #schedule(): void {
    if (typeof requestAnimationFrame === 'undefined') return this.layout();
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame(() => this.layout());
  }

  #hideLater(): void {
    clearTimeout(this.#hideT);
    this.#hideT = setTimeout(() => {
      this.scrolling = false;
      this.paint();
    }, this.#cfg.hide);
  }

  #scrolled(): void {
    this.placeThumb();
    this.scrolling = true;
    this.paint();
    this.#hideLater();
  }

  /** Mouse wheel at the start or end: squash the thumb towards that edge, then spring back. */
  #edge(dy: number): void {
    if (!this.can || this.drag || !dy || !this.#env.motion()) return;
    const c = this.#c;
    const max = c.scrollHeight - c.clientHeight;
    const top = dy < 0 && c.scrollTop <= 0;
    const bottom = dy > 0 && c.scrollTop >= max - 1;
    if (!top && !bottom) return;
    this.#sq = Math.min(0.24, this.#sq + Math.min(Math.abs(dy), 120) / 900);
    const t = this.thumb.style;
    t.transformOrigin = top ? '50% 0' : '50% 100%';
    t.transition = 'transform 90ms ease-out';
    t.transform = `scaleY(${1 - this.#sq})`;
    this.scrolling = true;
    this.paint();
    this.#hideLater();
    clearTimeout(this.#sqT);
    this.#sqT = setTimeout(() => {
      this.#sq = 0;
      t.transition = this.#env.motion() ? SQUASH_BACK : 'none';
      t.transform = 'none';
    }, 110);
  }

  /** Measures the area and places the bar over it. */
  layout(): void {
    const c = this.#c;
    if (!c.isConnected) return;
    if (this.el.parentNode !== c.parentNode) c.after(this.el);
    this.profile = this.#env.profile();
    const cfg = this.#cfg;
    const W = c.offsetWidth;
    const H = c.offsetHeight;
    const [r1, r2] = radii(c);
    const yS = Math.round(Math.max(10, r1 * 0.85));
    const yE = H - Math.round(Math.max(10, r2 * 0.85));
    const RL = Math.max(0, yE - yS);
    const g: Geometry = { W, H, yS, L: Math.max(0, RL - 4), cx: W - cfg.inset - cfg.hot / 2 };
    this.#g = g;
    this.can = this.profile !== 'mob' && c.scrollHeight > c.clientHeight + 1 && g.L > cfg.min + 16;
    this.el.style.display = this.profile === 'mob' ? 'none' : '';
    this.#narrow = W < 160;
    this.#hasLabel = c.querySelectorAll('h1,h2').length >= 2;
    // A popover above its siblings (`z-index`) keeps its bar on top.
    const z = parseInt(getComputedStyle(c).zIndex, 10);
    this.el.style.zIndex = String(Number.isNaN(z) ? 4 : Math.max(4, z + 1));
    Object.assign(this.el.style, {
      left: `${c.offsetLeft}px`,
      top: `${c.offsetTop}px`,
      width: `${W}px`,
      height: `${H}px`,
    });
    Object.assign(this.#rail.style, {
      right: `${cfg.inset - 2}px`,
      width: `${cfg.hot + 4}px`,
      top: `${yS}px`,
      height: `${RL}px`,
    });
    Object.assign(this.zone.style, { top: `${yS - 10}px`, height: `${RL + 20}px`, width: `${cfg.zone}px` });
    this.hit.style.width = `${cfg.zone}px`;
    this.placeThumb();
    this.paint();
  }

  placeThumb(): void {
    const g = this.#g;
    if (!g) return;
    const c = this.#c;
    const ch = c.clientHeight;
    const sh = c.scrollHeight;
    const max = sh - ch;
    this.#tL = Math.min(g.L, Math.max(this.#cfg.min, (g.L * ch) / Math.max(sh, 1)));
    this.#s = max > 0 ? ((g.L - this.#tL) * Math.min(Math.max(c.scrollTop, 0), max)) / max : 0;
    this.thumb.style.top = `${2 + this.#s}px`;
    this.thumb.style.height = `${this.#tL}px`;
    this.hit.style.top = `${g.yS + 2 + this.#s - 10}px`;
    this.hit.style.height = `${this.#tL + 20}px`;
    if (this.drag && this.#hasLabel) this.#placeLabel();
  }

  /** Section pill: the last `h1`/`h2` above 30 % of the view, the last one at the end. */
  #placeLabel(): void {
    const c = this.#c;
    const g = this.#g;
    const hs = [...c.querySelectorAll('h1,h2')];
    if (!hs.length || !g) return;
    const cr = c.getBoundingClientRect();
    const k = cr.height / c.offsetHeight || 1;
    const atEnd = c.scrollTop >= c.scrollHeight - c.clientHeight - 2;
    const line = c.scrollTop + c.clientHeight * 0.3;
    let cur = hs[0] as Element;
    for (const h of hs) if ((h.getBoundingClientRect().top - cr.top) / k + c.scrollTop <= line) cur = h;
    if (atEnd) cur = hs[hs.length - 1] as Element;
    const text = cur.textContent?.trim() ?? '';
    if (text !== this.#lbl) {
      this.#lbl = text;
      this.label.textContent = text;
    }
    const py = g.yS + 2 + this.#s + this.#tL / 2;
    const lh = this.label.offsetHeight || 30;
    this.label.style.right = `${g.W - g.cx + this.#cfg.hot / 2 + 12}px`;
    this.label.style.top = `${Math.min(Math.max(py - lh / 2, 4), Math.max(4, g.H - lh - 4))}px`;
  }

  paint(): void {
    const cfg = this.#cfg;
    const desk = this.profile === 'desk';
    const T = this.#env.motion();
    const zh = this.zoneHover || this.onThumb;
    const vis = this.can && (this.drag || this.scrolling || (desk && (this.hover || zh)));
    const hot = this.can && (this.drag || (desk && zh));
    const p = this.pill.style;
    p.transition = T
      ? `opacity ${vis ? 160 : 420}ms ease, width 320ms ${SPRING}, background-color 200ms ease, box-shadow 240ms ease`
      : 'none';
    p.opacity = vis ? '1' : '0';
    p.width = `${hot ? cfg.hot : cfg.width}px`;
    p.backgroundColor = this.drag ? ACC : hot && this.onThumb ? mix(50) : hot ? mix(36) : desk ? mix(26) : mix(40);
    p.boxShadow = this.drag
      ? `0 0 0 3px color-mix(in oklab,${ACC} 30%,transparent), 0 6px 14px -4px color-mix(in oklab,${ACC} 70%,transparent)`
      : 'none';
    const gs = this.grip.style;
    gs.transition = T ? 'opacity 180ms ease, color 200ms ease' : 'none';
    gs.color = this.drag ? 'var(--accink)' : 'var(--surface)';
    gs.opacity = hot && this.#tL >= 32 ? (this.drag || this.onThumb ? '.85' : '.55') : '0';
    const tr = this.track.style;
    tr.transition = T ? `opacity ${hot ? 200 : 360}ms ease` : 'none';
    tr.backgroundColor = mix(desk ? 6 : 8);
    tr.boxShadow = `inset 0 1px 2px ${mix(8)}`;
    tr.opacity = hot ? '1' : '0';
    const ls = this.label.style;
    const lv = this.drag && this.#hasLabel;
    ls.transition = T ? 'opacity 160ms ease, transform 220ms cubic-bezier(.3,.7,.2,1)' : 'none';
    ls.opacity = lv ? '1' : '0';
    ls.transform = lv ? 'none' : 'translateX(6px)';
    this.zone.style.pointerEvents = this.can && desk && !this.#narrow ? 'auto' : 'none';
    this.hit.style.pointerEvents = this.can && (desk || vis) ? 'auto' : 'none';
  }

  /** Click in the zone jumps there (thumb centred), dragging the thumb scrolls. */
  #down(e: PointerEvent): void {
    const g = this.#g;
    if (!this.can || !g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const c = this.#c;
    const onHit = e.target === this.hit;
    if (!onHit && e.target !== this.zone) return;
    e.preventDefault();
    e.stopPropagation();
    const r = this.el.getBoundingClientRect();
    const k = r.height / this.el.offsetHeight || 1;
    // Track and thumb from the current layout: a resize during the drag replaces both together.
    const geo = () => this.#g ?? g;
    const sAt = (ev: PointerEvent) => Math.min(Math.max((ev.clientY - r.top) / k - geo().yS - 2, 0), geo().L);
    const s0 = sAt(e);
    const off = onHit ? Math.min(Math.max(s0 - this.#s, 0), this.#tL) : this.#tL / 2;
    const go = (sv: number) => {
      const span = Math.max(1, geo().L - this.#tL);
      c.scrollTop = (Math.min(Math.max(sv - off, 0), span) / span) * (c.scrollHeight - c.clientHeight);
    };
    if (!onHit) go(s0);
    const tgt = e.target as HTMLElement;
    try {
      tgt.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone (e.g. synthetic events).
    }
    const move = (ev: PointerEvent) => go(sAt(ev));
    const up = () => {
      this.drag = false;
      tgt.removeEventListener('pointermove', move);
      tgt.removeEventListener('pointerup', up);
      tgt.removeEventListener('pointercancel', up);
      this.scrolling = true;
      this.#hideLater();
      this.paint();
    };
    tgt.addEventListener('pointermove', move);
    tgt.addEventListener('pointerup', up);
    tgt.addEventListener('pointercancel', up);
    this.drag = true;
    clearTimeout(this.#hideT);
    clearTimeout(this.#sqT);
    this.#sq = 0;
    this.thumb.style.transform = 'none';
    if (this.#hasLabel) this.#placeLabel();
    this.paint();
  }

  destroy(): void {
    for (const off of this.#off) off();
    this.#off = [];
    clearTimeout(this.#hideT);
    clearTimeout(this.#sqT);
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.#raf);
    this.#ro?.disconnect();
    this.#mo?.disconnect();
    this.el.remove();
  }
}

/**
 * Profile of the app: no bar in the mobile layout, otherwise desktop; the tablet
 * profile (`tab`) follows once the app detects tablets.
 */
export function scrollbarProfile(): ScrollbarProfile {
  return ui.isMobile ? 'mob' : 'desk';
}

/** `{@attach scrollbar}` on the scroll area; switching between mobile and desktop rebuilds the bar. */
export const scrollbar: Attachment<HTMLElement> = (node) => {
  const profile = scrollbarProfile();
  const bar = untrack(() => new OverlayScrollbar(node, { profile: () => profile, motion: () => prefs.motion }));
  return () => bar.destroy();
};
