/**
 * Height fitting of the setup wizard: on each new size the card starts at
 * level 0 and steps down through the denser levels of its tier until the
 * page (desktop) or the panel (mobile) no longer scrolls. Each step runs
 * after the DOM update and before the browser paints, so only the final
 * level is ever shown; there is no animation between levels.
 *
 * The level only depends on the current size and content, never on the way
 * there: every size change of more than 4 px fits from level 0, and a
 * relayout reads the page's current size. Otherwise a level found on an
 * earlier size (a window that grew, a page loaded hidden) stayed until the
 * next relayout, and changing the language suddenly resized the card.
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

export class SetupFit {
  w = $state(1280);
  h = $state(860);
  two = $state(false);
  level = $state(0);
  mobile = $derived(isMobileWidth(this.w));
  private fitting = false;
  private ready = false;
  /** Size of the last refit decision: small changes are measured against it, not against the previous one. */
  private checked = { w: 0, h: 0 };
  /** Held (a step's inline editor is open): the level stays; a new size or content refits on release. */
  private held = false;
  private pending: { w: number; h: number } | null = null;
  private readonly t: FitTargets;

  constructor(targets: FitTargets) {
    this.t = targets;
  }

  /** Size of the page changed (observer); more than 4 px per axis counts. */
  resize(w: number, h: number): void {
    if (this.held) {
      this.pending = w === this.w && h === this.h && !this.pending ? null : { w, h };
      return;
    }
    const same =
      isMobileWidth(w) === this.mobile &&
      w >= WIDE === this.w >= WIDE &&
      (isMobileWidth(w) || !this.t.columns || twoCol(w, h, this.two) === this.two);
    if (this.ready && same && Math.abs(w - this.checked.w) <= 4 && Math.abs(h - this.checked.h) <= 4) {
      // Too small to refit, but the size stays current.
      this.w = w;
      this.h = h;
      return;
    }
    this.relayout(w, h);
  }

  /**
   * New size, or content changed its height (language, messages, web fonts): from level 0 again. Without a size
   * it takes the page's current one, which may be newer than the last observed size.
   */
  relayout(w?: number, h?: number): void {
    const root = this.t.root();
    w ??= root?.clientWidth || this.w;
    h ??= root?.clientHeight || this.h;
    if (this.held) {
      this.pending = { w, h };
      return;
    }
    this.ready = true;
    this.checked = { w, h };
    this.w = w;
    this.h = h;
    this.two = !isMobileWidth(w) && this.t.columns && twoCol(w, h, this.two);
    this.level = 0;
    if (this.fitting) return;
    this.fitting = true;
    void this.run();
  }

  /**
   * Holds the current level (`true`) or releases it: while held, size and
   * content changes only mark the step for a refit, which runs on release.
   */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    if (on) return;
    const next = this.pending;
    this.pending = null;
    if (next) this.relayout(next.w, next.h);
  }

  /**
   * Observes the page size and the web fonts; returns the cleanup (for `$effect`). A font face that only starts
   * loading after `fonts.ready` (first visit, no cache) refits too: fitted on the fallback fonts, the card would
   * otherwise keep a denser level until the next relayout (such as a change of language).
   */
  observe(root: HTMLElement): () => void {
    const ro = new ResizeObserver(() => this.resize(root.clientWidth, root.clientHeight));
    ro.observe(root);
    this.relayout(root.clientWidth, root.clientHeight);
    let alive = true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const loaded = () => {
      if (alive) this.relayout();
    };
    void fonts?.ready.then(loaded);
    fonts?.addEventListener?.('loadingdone', loaded);
    return () => {
      alive = false;
      ro.disconnect();
      fonts?.removeEventListener?.('loadingdone', loaded);
    };
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        await tick();
        if (!this.overflows()) break;
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
}
