/**
 * Height fitting of the setup wizard: on each new size the card starts at
 * level 0 and steps down through the denser levels of its tier until the
 * page (desktop) or the panel (mobile) no longer scrolls. Each step runs
 * after the DOM update and before the browser paints, so only the final
 * level is ever shown; there is no animation between levels.
 *
 * A size change only refits when the layout really changes: another tier,
 * the current level no longer fits, or the roomier level would fit again
 * (the room it needed, measured on the last pass). Otherwise the new size
 * simply applies.
 */
import { tick } from 'svelte';
import { isMobileWidth, twoCol, WIDE } from '#lib/setup-layout.ts';

export interface FitTargets {
  /** The page: scrolls on desktop, its size decides the tier. */
  root: () => HTMLElement | undefined;
  /** The card: scrolls on mobile. */
  card: () => HTMLElement | undefined;
  /** Number of levels of the tier at width `w`. */
  levels: (mobile: boolean) => number;
  /** Two columns possible at all (not on the done screen). */
  columns: boolean;
}

/** Room the next roomier level needs when nothing was measured yet. */
const ROOM0 = 90;

export class SetupFit {
  w = $state(1280);
  h = $state(860);
  two = $state(false);
  level = $state(0);
  mobile = $derived(isMobileWidth(this.w));
  private fitting = false;
  private ready = false;
  /** Overflow on the last level that did not fit. */
  private over = 0;
  /** Room the next roomier level needs (measured). */
  private gap: number | null = null;
  private readonly t: FitTargets;

  constructor(targets: FitTargets) {
    this.t = targets;
  }

  /** Size of the page changed (observer); more than 4 px per axis counts. */
  resize(w: number, h: number): void {
    const same =
      isMobileWidth(w) === this.mobile &&
      w >= WIDE === this.w >= WIDE &&
      (isMobileWidth(w) || !this.t.columns || twoCol(w, h, this.two) === this.two);
    if (this.ready && same && Math.abs(w - this.w) <= 4 && Math.abs(h - this.h) <= 4) {
      // Too small to refit, but the size stays current.
      this.w = w;
      this.h = h;
      return;
    }
    if (!this.ready || this.fitting) {
      this.relayout(w, h);
      return;
    }
    const mobNow = this.mobile;
    const mobNext = isMobileWidth(w);
    const twoNext = !mobNext && this.t.columns && twoCol(w, h, this.two);
    const structural = mobNow !== mobNext || (!mobNext && (this.two !== twoNext || this.w >= WIDE !== w >= WIDE));
    const roomier = this.level > 0 && this.freeSpace() >= (this.gap !== null ? this.gap + 6 : ROOM0);
    if (structural || this.overflows() || roomier) this.relayout(w, h);
    else {
      this.w = w;
      this.h = h;
    }
  }

  /** Content changed its height (language, messages, web fonts): from level 0 again. */
  relayout(w = this.w, h = this.h): void {
    this.ready = true;
    this.over = 0;
    this.gap = null;
    this.w = w;
    this.h = h;
    this.two = !isMobileWidth(w) && this.t.columns && twoCol(w, h, this.two);
    this.level = 0;
    if (this.fitting) return;
    this.fitting = true;
    void this.run();
  }

  /** Observes the page size and the web fonts; returns the cleanup (for `$effect`). */
  observe(root: HTMLElement): () => void {
    const ro = new ResizeObserver(() => this.resize(root.clientWidth, root.clientHeight));
    ro.observe(root);
    this.relayout(root.clientWidth, root.clientHeight);
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) this.relayout();
    });
    return () => {
      alive = false;
      ro.disconnect();
    };
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        await tick();
        if (!this.overflows()) {
          if (this.over) this.gap = this.over + this.freeSpace();
          break;
        }
        this.over = this.overAmount();
        if (this.level >= this.t.levels(this.mobile) - 1) break;
        this.level += 1;
      }
    } finally {
      this.fitting = false;
    }
  }

  private scroller(): HTMLElement | undefined {
    return this.mobile ? this.t.card() : this.t.root();
  }

  private overAmount(): number {
    const el = this.scroller();
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  }

  private overflows(): boolean {
    return this.overAmount() > 1;
  }

  /** Free height right now: desktop around the card, mobile below the panel's content. */
  private freeSpace(): number {
    const card = this.t.card();
    if (!card) return 0;
    if (this.mobile) {
      const r = card.getBoundingClientRect();
      let bottom = r.top;
      for (const c of card.children) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
      return card.clientHeight - (bottom - r.top) - (parseFloat(getComputedStyle(card).paddingBottom) || 0);
    }
    const main = card.parentElement;
    if (!main) return 0;
    const cs = getComputedStyle(main);
    return (
      main.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0) - card.offsetHeight
    );
  }
}
