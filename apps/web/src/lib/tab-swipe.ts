/**
 * Swiping between the tabs Mailboxes, Folders and Tags: on mobile in the
 * "Mailboxes" sheet, on a tablet in the expanded sidebar.
 *
 * Like the other gestures it paints directly, here via custom properties on
 * the root of segment and panels (`data-g-tabsw`), which the markup reads with
 * its resting values as fallback: `--gdx` (offset of the panels), `--gp{i}o`,
 * `--gp{i}t`, `--gp{i}v` (opacity, scale and visibility of panel `i`),
 * `--gcols`, `--gil`, `--giw` (columns and indicator of the segment),
 * `--gt{i}w`, `--gt{i}o`, `--gt{i}g`, `--gt{i}c` (width, opacity and gap of the
 * label and colour of tab `i`). `--gtd` and `--gte` set duration and curve of
 * all their transitions: 0 ms while dragging, after release the settle.
 */
import { tick } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { canStart, follow, rubber } from '#lib/swipe.ts';

/** Rubber band at the first and last tab. */
export const TAB_RUBBER = 60;
/** Curve of the settle after release. */
export const TAB_EASE = 'cubic-bezier(.2,.8,.2,1)';

/** State of the drag: offset `x` of the panels, the neighbouring tab `next` and the progress `p` (0 to 1) towards it. */
export interface TabDrag {
  x: number;
  next: number;
  /** No tab in this direction (`next` outside): rubber band, `p` stays 0. */
  out: boolean;
  p: number;
}

/**
 * Drag `dx` from tab `index` of `count` across panels `width` px wide: towards
 * a neighbour the panels follow the finger up to one width, beyond the first
 * and last tab as a rubber band.
 */
export function tabDrag(dx: number, index: number, count: number, width: number): TabDrag {
  const next = index + (dx < 0 ? 1 : -1);
  const out = next < 0 || next >= count;
  const x = out ? Math.sign(dx) * rubber(Math.abs(dx), TAB_RUBBER) : Math.max(-width, Math.min(width, dx));
  return { x, next, out, p: out ? 0 : Math.abs(x) / width };
}

/** Weight of tab `i` between the current one (1 − p) and the neighbour (p). */
const weight = (i: number, index: number, d: TabDrag): number => (i === index ? 1 - d.p : i === d.next ? d.p : 0);

/** Opacity and scale of panel `i`: the current one fades to 50 % and shrinks by 3 %, the neighbour comes from 40 % and 97 %. */
export function tabPanel(i: number, index: number, d: TabDrag): { opacity: number; scale: number } {
  if (i === index) return { opacity: 1 - d.p * 0.5, scale: 1 - d.p * 0.03 };
  if (i === d.next) return { opacity: 0.4 + d.p * 0.6, scale: 0.97 + d.p * 0.03 };
  return { opacity: 0, scale: 0.97 };
}

/** Measures of the segment: outer width, padding and gap in px, and the share `fr` of the active column (the others 1). */
export interface SegmentBox {
  width: number;
  pad: number;
  gap: number;
  fr: number;
}

/** Segment during the drag: columns in fr, left edge and width of the indicator in px, and per tab the share of its label (0 to 1). */
export interface SegmentFrame {
  cols: number[];
  left: number;
  width: number;
  labels: number[];
}

/**
 * Segment for the drag `d` from tab `index` of `count`: each column has the
 * share `1 + (fr − 1) · weight`; the indicator moves and grows from the current
 * column to the neighbour, at the ends it gives way by 8 % of the offset
 * against the drag; the labels open and close with the weight.
 */
export function tabSegment(box: SegmentBox, index: number, count: number, d: TabDrag): SegmentFrame {
  const labels = Array.from({ length: count }, (_, i) => weight(i, index, d));
  const cols = labels.map((w) => 1 + (box.fr - 1) * w);
  const total = cols.reduce((a, b) => a + b, 0);
  const avail = box.width - 2 * box.pad - box.gap * (count - 1);
  const widths = cols.map((f) => (avail * f) / total);
  const lefts: number[] = [];
  let at = box.pad;
  for (const w of widths) {
    lefts.push(at);
    at += w + box.gap;
  }
  const j = d.out ? index : d.next;
  const from = lefts[index] ?? 0;
  const to = lefts[j] ?? 0;
  const w0 = widths[index] ?? 0;
  const w1 = widths[j] ?? 0;
  return {
    cols,
    left: from + (to - from) * d.p - (d.out ? d.x * 0.08 : 0),
    width: w0 + (w1 - w0) * d.p,
    labels,
  };
}

/**
 * On release after `dx` with the velocity `vx` in px/ms: does the tab switch
 * (further than 28 % of the width, or flung faster than 0.35 px/ms in the
 * direction of the drag), and how long does the settle take: the rest of the
 * way at the release velocity (at least 0.6 px/ms), 170 to 380 ms.
 */
export function tabRelease(
  dx: number,
  vx: number,
  index: number,
  count: number,
  width: number,
): { go: boolean; next: number; ms: number } {
  const dir = dx < 0 ? 1 : -1;
  const next = index + dir;
  const ok = next >= 0 && next < count;
  const go = ok && (Math.abs(dx) > width * 0.28 || (Math.abs(vx) > 0.35 && Math.sign(-vx) === dir));
  const shown = ok ? Math.min(width, Math.abs(dx)) : rubber(Math.abs(dx), TAB_RUBBER);
  const rest = go ? width - shown : shown;
  return { go, next, ms: Math.round(Math.max(170, Math.min(380, (4 * rest) / Math.max(Math.abs(vx), 0.6)))) };
}

/**
 * Inline style of panel `i` at rest (hidden ones faded out and at 96 %, their
 * visibility switching after the fade), which the tab swipe overrides while
 * dragging.
 */
export const tabPanelStyle = (i: number, p: { hidden: boolean; vis: string; visDelay: string }): string =>
  `visibility: var(--gp${i}v, ${p.vis}); opacity: var(--gp${i}o, ${p.hidden ? 0 : 1}); ` +
  `transform: var(--gp${i}t, ${p.hidden ? 'scale(.96)' : 'none'}); --vis-delay: ${p.visDelay}`;

/** Values of the tab swipe; `null` from `get` turns it off (desktop with a mouse, collapsed sidebar). */
export interface TabSwipe {
  /** Setting "Animations": without it, the tabs switch or come back immediately. */
  animations: boolean;
  /** Index of the active tab. */
  index: number;
  count: number;
  /** Share of the active column in the segment (`data-fr`: 2.4 on mobile, 4 in the sidebar). */
  fr: number;
  /** Desktop layout on a tablet: on the last tab a swipe to the left stays with the other gestures. */
  desk: boolean;
  select: (index: number) => void;
}

/** Custom properties of the drag on the root, without `--gtd` and `--gte`. */
function dragKeys(count: number): string[] {
  const keys = ['--gdx', '--gcols', '--gil', '--giw'];
  for (let i = 0; i < count; i++) {
    keys.push(`--gp${i}o`, `--gp${i}t`, `--gp${i}v`, `--gt${i}w`, `--gt${i}o`, `--gt${i}g`, `--gt${i}c`);
  }
  return keys;
}

/**
 * Tab swipe as an attachment on the panel area (`data-g-tabs`); its ancestor
 * `[data-g-tabsw]` holds the segment (`[role="tablist"]`) and receives the
 * custom properties. Horizontal movement only: vertical movement stays with
 * the browser and the other gestures (scrolling the panels, dragging the sheet
 * down). On release the new tab applies and everything settles from the
 * dragged values to its resting values; otherwise, and always after
 * `pointercancel`, back to the old tab.
 */
export function swipeTabs(get: () => TabSwipe | null): Attachment<HTMLElement> {
  return (el) => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    /** Number of tabs of the last gesture, for the teardown. */
    let tabs = 0;
    const root = el.closest<HTMLElement>('[data-g-tabsw]') ?? el;

    const onDown = (e: PointerEvent) => {
      if (!canStart(e)) return;
      const o = get();
      if (!o) return;
      const { index, count } = o;
      tabs = count;
      let width = 1;
      let box: SegmentBox | null = null;
      let dx = 0;
      const set = (k: string, v: string) => root.style.setProperty(k, v);

      follow(e, {
        decide: (x, y) => {
          if (Math.abs(x) <= Math.abs(y)) return false;
          return !(o.desk && x < 0 && index === count - 1);
        },
        start: () => {
          clearTimeout(clearTimer);
          width = el.offsetWidth || 1;
          const seg = root.querySelector<HTMLElement>('[role="tablist"]');
          if (seg) {
            const cs = getComputedStyle(seg);
            box = {
              width: seg.offsetWidth,
              pad: parseFloat(cs.paddingLeft) || 0,
              gap: parseFloat(cs.columnGap) || 0,
              fr: o.fr,
            };
          }
          set('--gtd', '0ms');
        },
        move: (x) => {
          dx = x;
          const d = tabDrag(x, index, count, width);
          set('--gdx', `${d.x}px`);
          for (let i = 0; i < count; i++) {
            const pn = tabPanel(i, index, d);
            set(`--gp${i}o`, String(pn.opacity));
            set(`--gp${i}t`, `scale(${pn.scale})`);
            set(`--gp${i}v`, 'visible');
          }
          if (!box?.width) return;
          const s = tabSegment(box, index, count, d);
          set('--gcols', s.cols.map((f) => `minmax(0,${f.toFixed(4)}fr)`).join(' '));
          set('--gil', `${s.left}px`);
          set('--giw', `${s.width}px`);
          s.labels.forEach((k, i) => {
            set(`--gt${i}w`, `${120 * k}px`);
            set(`--gt${i}o`, String(k));
            set(`--gt${i}g`, `${7 * k}px`);
            set(`--gt${i}c`, `color-mix(in oklab, var(--fg) ${Math.round(k * 100)}%, var(--mfg))`);
          });
        },
        end: (vx, _vy, cancelled) => {
          const r = tabRelease(dx, cancelled ? 0 : vx, index, count, width);
          const t = o.animations ? r.ms : 0;
          set('--gtd', `${t}ms`);
          set('--gte', TAB_EASE);
          const clear = () => {
            for (const k of dragKeys(count)) root.style.removeProperty(k);
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => {
              root.style.removeProperty('--gtd');
              root.style.removeProperty('--gte');
            }, t + 60);
          };
          // Cancelled by the browser or the system (`pointercancel`): back, even beyond the threshold.
          if (r.go && !cancelled && alive) {
            o.select(r.next);
            void tick().then(clear);
          } else clear();
        },
      });
    };

    el.addEventListener('pointerdown', onDown);
    return () => {
      alive = false;
      el.removeEventListener('pointerdown', onDown);
      clearTimeout(clearTimer);
      for (const k of [...dragKeys(tabs), '--gtd', '--gte']) root.style.removeProperty(k);
    };
  };
}
