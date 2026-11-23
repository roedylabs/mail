/**
 * Height fitting of the guest pages (setup, sign-in, invitation): on each
 * new size the card starts at level 0 and steps down through the denser levels of its tier until the
 * page (desktop) or the panel (mobile) no longer scrolls. Each step runs
 * after the DOM update and before the browser paints, so only the final
 * level is ever shown; there is no animation between levels.
 *
 * The level only depends on the current size and content, never on the way
 * there: every size change of more than 4 px fits from level 0, and a
 * relayout reads the page's current size. Otherwise a level found on an
 * earlier size (a window that grew, a page loaded hidden) stayed until the
 * next relayout, and changing the language suddenly resized the card.
 *
 * One exception: on mobile, while a text field has the focus and the page is
 * lower than at the last fit, the on-screen keyboard is open. The level stays
 * and the panel scrolls; a relayout meanwhile waits until the keyboard closes.
 *
 * Both languages show the same texts at the same size: each fit first runs in
 * the other language, then in the chosen one from the level the other one
 * reached, so the level is the denser of the two and switching the language
 * never changes it. Only the texts follow the measuring language (`lang`);
 * every pass ends before the browser paints. While fitting nothing animates
 * (`fitting`, see the shell), so no size still easing from the previous level
 * is measured.
 */
import { tick } from 'svelte';
import type { Lang } from '#lib/locale.ts';
import { isMobileWidth, twoCol, WIDE } from '#lib/auth-layout.ts';

export interface FitTargets {
  /** The page: scrolls on desktop, its size decides the tier. */
  root: () => HTMLElement | undefined;
  /** The card: scrolls on mobile. */
  card: () => HTMLElement | undefined;
  /** Number of levels of the tier at width `w`. */
  levels: (mobile: boolean) => number;
  /** Two columns possible at all (not on the done screen). */
  columns: boolean;
  /**
   * Language the texts render in while measuring: `other()` is the language not chosen, `set` switches the texts
   * to it (`null`: back to the chosen one). Without it the fit measures the chosen language only.
   */
  lang?: { other: () => Lang; set: (lang: Lang | null) => void };
  /**
   * Runs before each measurement: brings values a step measures from the layout (such as the columns of a grid)
   * up to date; `true` if one changed, then the step renders once more before the fit measures.
   */
  sync?: () => boolean;
  /**
   * An on-screen keyboard may be open (a text field has the focus). On mobile a change of the height alone then
   * keeps the level: the keyboard only covers part of the page for a while, the panel scrolls instead.
   */
  keyboard?: () => boolean;
  /** Level a relayout starts from at width `w`, height `h` and column layout `two` (default 0). */
  start?: (w: number, h: number, two: boolean) => number;
}

export class AuthFit {
  w = $state(1280);
  h = $state(860);
  two = $state(false);
  level = $state(0);
  mobile = $derived(isMobileWidth(this.w));
  /** A fit is running: transitions are off (the shell's `data-fitting`). */
  fitting = $state(false);
  /** Counts relayouts: a running fit starts over when it changes. */
  private gen = 0;
  private ready = false;
  /** Size of the last refit decision: small changes are measured against it, not against the previous one. */
  private checked = { w: 0, h: 0 };
  /** Held (a screen's inline editor is open): the level stays; a new size or content refits on release. */
  private held = false;
  private pending: { w: number; h: number } | null = null;
  /** A relayout waits for the on-screen keyboard to close. */
  private deferred = false;
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
    if (this.keyboardOpen(w, h)) {
      // The on-screen keyboard covers the page for a while: the level stays, the panel scrolls.
      this.w = w;
      this.h = h;
      return;
    }
    if (this.deferred) {
      this.relayout(w, h);
      return;
    }
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
    if (this.keyboardOpen(w, h)) {
      // Fitted once the keyboard closes (the next size change).
      this.deferred = true;
      this.w = w;
      this.h = h;
      return;
    }
    this.deferred = false;
    this.ready = true;
    this.checked = { w, h };
    this.w = w;
    this.h = h;
    this.two = !isMobileWidth(w) && this.t.columns && twoCol(w, h, this.two);
    // Without a layout (a hidden page, tests) the size says nothing: from level 0.
    this.level = root?.clientHeight ? (this.t.start?.(w, h, this.two) ?? 0) : 0;
    this.gen += 1;
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
    // Without a layout (a hidden page, tests) there is nothing to measure in the other language.
    const lang = this.t.root()?.clientHeight ? this.t.lang : undefined;
    try {
      for (;;) {
        const gen = this.gen;
        if (lang) {
          lang.set(lang.other());
          await this.climb(gen);
          lang.set(null);
          if (gen !== this.gen) continue;
        }
        await this.climb(gen);
        if (gen === this.gen) break;
      }
    } finally {
      lang?.set(null);
      this.fitting = false;
    }
  }

  /** Steps down from the current level until nothing overflows (or the densest level); stops early on a relayout. */
  private async climb(gen: number): Promise<void> {
    for (;;) {
      await tick();
      if (this.t.sync?.()) await tick();
      if (gen !== this.gen || !this.overflows()) return;
      if (this.level >= this.t.levels(this.mobile) - 1) return;
      this.level += 1;
    }
  }

  /**
   * Mobile, a text field has the focus and the page is lower than at the last fit, as wide: the on-screen keyboard
   * is open. It only covers the page for a while, so the level stays (the fit would go dense for nothing).
   */
  private keyboardOpen(w: number, h: number): boolean {
    return (
      this.ready &&
      this.mobile &&
      isMobileWidth(w) &&
      Math.abs(w - this.checked.w) <= 4 &&
      h < this.checked.h - 4 &&
      !!this.t.keyboard?.()
    );
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
