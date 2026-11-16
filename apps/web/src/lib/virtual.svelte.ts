/**
 * Virtual list with runes on top of `@tanstack/virtual-core`:
 * only the visible entries (and `overscan` before and after them) are in the
 * DOM. `@tanstack/svelte-virtual` provides the core as a `svelte/store`; the
 * adapter here keeps the same values as `$state`.
 *
 * Use in a component: `const v = new VirtualList(() => ({ count, … }))`,
 * `{@attach v.scroller}` on the scrolling element, `{@attach v.list}` on the
 * element that contains the entries (`start` counts from its top edge), and
 * `{@attach v.measure}` on every entry with `data-index`.
 */
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from '@tanstack/virtual-core';
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

export interface VirtualOptions {
  count: number;
  /** Estimated height of an entry until it is measured. */
  estimate: (index: number) => number;
  /** Key of an entry; keeps the measurement when entries move. */
  key?: (index: number) => string;
  overscan?: number;
}

/** Frames in which `reveal()` follows up after measuring new entries. */
const REVEAL_FRAMES = 6;

export class VirtualList {
  /** Entries in the DOM, with `start` relative to the top edge of the list. */
  items = $state.raw<VirtualItem[]>([]);
  /** Height of all entries. */
  size = $state(0);

  readonly #v: Virtualizer<HTMLElement, HTMLElement>;
  #scroller: HTMLElement | null = null;
  #list: HTMLElement | null = null;
  #margin = 0;
  #revealFrame = 0;

  constructor(options: () => VirtualOptions) {
    const base = (o: VirtualOptions) => ({
      count: o.count,
      estimateSize: o.estimate,
      getItemKey: o.key ?? ((i: number) => i),
      overscan: o.overscan ?? 6,
      getScrollElement: () => this.#scroller,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      scrollMargin: this.#margin,
      // Measure only in the next frame: otherwise the ResizeObserver callback changes the height of the
      // list right away, and the browser reports "ResizeObserver loop completed with undelivered notifications".
      useAnimationFrameWithResizeObserver: true,
      onChange: () => this.#read(),
    });
    this.#v = new Virtualizer<HTMLElement, HTMLElement>(base(options()));
    $effect.pre(() => {
      const o = options();
      this.#v.setOptions(base(o));
      this.#v._willUpdate();
      this.#read();
    });
  }

  /** Scrolling element (`overflow: auto`). */
  readonly scroller: Attachment<HTMLElement> = (node) => {
    this.#scroller = node;
    const unmount = this.#v._didMount();
    this.#v._willUpdate();
    this.#read();
    // If the user scrolls themselves, `reveal()` stops following up.
    const stop = () => cancelAnimationFrame(this.#revealFrame);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const e of events) node.addEventListener(e, stop, { passive: true });
    return () => {
      unmount();
      stop();
      for (const e of events) node.removeEventListener(e, stop);
      if (this.#scroller === node) this.#scroller = null;
    };
  };

  /** Element with the entries; its distance to the top edge of the scroll area is `scrollMargin`. */
  readonly list: Attachment<HTMLElement> = (node) => {
    this.#list = node;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.#remeasure());
    });
    observer.observe(node);
    if (this.#scroller) observer.observe(this.#scroller);
    // A bar above the list (such as the selection bar) moves it and only changes the height of the parent element.
    if (node.parentElement && node.parentElement !== this.#scroller) observer.observe(node.parentElement);
    this.#remeasure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (this.#list === node) this.#list = null;
    };
  };

  /** Entry with `data-index`; measures its actual height. */
  readonly measure: Attachment<HTMLElement> = (node) => {
    this.#v.measureElement(node);
  };

  /**
   * Make an entry visible: scrolls only if it is
   * closer than `top` to the top edge or `bottom` to the bottom edge of the
   * scroll area, or outside of it. Unmeasured entries first sit at their
   * estimated position; without `smooth` it follows up in the next frames as
   * soon as the new entries are measured (with animation the follow-up would
   * hit the running motion, and nearby entries are measured by then anyway).
   * `target` as a function determines the index anew each time in case the
   * list changes in the meantime (-1: no longer there); if the user scrolls
   * themselves, the follow-up ends.
   */
  reveal(target: number | (() => number), { top = 72, bottom = 24, smooth = false } = {}): void {
    const index = typeof target === 'number' ? () => target : target;
    cancelAnimationFrame(this.#revealFrame);
    this.#scrollTo(index(), top, bottom, smooth);
    if (smooth) return;
    let frames = REVEAL_FRAMES;
    const again = () => {
      this.#scrollTo(index(), top, bottom, false);
      if (--frames > 0) this.#revealFrame = requestAnimationFrame(again);
    };
    this.#revealFrame = requestAnimationFrame(again);
  }

  /**
   * Keeps the entry with the key `key()` visible as soon as the key changes
   * (`pfFocus`): the first time without animation (e.g. after returning from
   * the reading view), afterwards according to `smooth()`. Call when creating
   * the component.
   */
  follow(key: () => string | null, indexOf: (key: string) => number, smooth: () => boolean): void {
    const current = $derived(key());
    let first = true;
    $effect(() => {
      const k = current;
      untrack(() => {
        const animate = !first && smooth();
        first = false;
        if (k) this.reveal(() => indexOf(k), { smooth: animate });
      });
    });
  }

  #scrollTo(index: number, top: number, bottom: number, smooth: boolean): void {
    if (index < 0) return;
    const scroller = this.#scroller;
    // A bar above the list (such as the selection bar) moves it without any size changing.
    this.#remeasure();
    this.#v.getVirtualItems();
    const item = this.#v.measurementsCache[index];
    if (!scroller || !item) return;
    const view = scroller.scrollTop;
    const height = scroller.clientHeight;
    const to =
      item.start - view < top
        ? item.start - top
        : item.end - view > height - bottom
          ? item.end - height + bottom
          : null;
    if (to !== null) scroller.scrollTo({ top: Math.max(0, to), behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Index of the last entry in the DOM, `null` without entries. */
  get last(): number | null {
    return this.items.at(-1)?.index ?? null;
  }

  #remeasure(): void {
    const scroller = this.#scroller;
    const list = this.#list;
    if (!scroller || !list) return;
    const margin = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(margin - this.#margin) < 0.5) return;
    this.#margin = margin;
    // Without `measure()`: the measured heights stay, only the position shifts.
    this.#v.setOptions({ ...this.#v.options, scrollMargin: margin });
    this.#v._willUpdate();
    this.#read();
  }

  #read(): void {
    // Position relative to the list instead of the scroll area.
    const margin = this.#v.options.scrollMargin;
    this.items = this.#v
      .getVirtualItems()
      .map((item) => ({ ...item, start: item.start - margin, end: item.end - margin }));
    this.size = this.#v.getTotalSize();
  }
}
