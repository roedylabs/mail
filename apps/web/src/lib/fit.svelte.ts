/**
 * Fitting the guest pages to the window (setup and sign-in): steps 0–3, smaller
 * until the page fits without scrolling and no word is wider than the card. Each
 * measurement runs after the DOM updates; if a measurement is already running,
 * it measures the new state too.
 */
import { tick } from 'svelte';

export class Fit {
  level = $state(0);
  private running = false;
  private size = { width: -1, height: -1 };
  private readonly root: () => HTMLElement | undefined;
  private readonly card: () => HTMLElement | undefined;

  /** `root` scrolls (the page), `card` contains the steps. */
  constructor(root: () => HTMLElement | undefined, card: () => HTMLElement | undefined) {
    this.root = root;
    this.card = card;
  }

  /** New state (step, error, result): from the start. */
  restart(): void {
    this.level = 0;
    void this.run();
  }

  /** Window changed: only a change of more than 4 px starts over. */
  resize(width: number, height: number): void {
    if (Math.abs(width - this.size.width) <= 4 && Math.abs(height - this.size.height) <= 4) return;
    this.size = { width, height };
    this.restart();
  }

  /** The card has grown (field errors, web fonts): go further down without resetting. */
  grow(): void {
    void this.run();
  }

  /** Observes the card and the loading of web fonts; returns the cleanup (for `$effect`). */
  observe(card: HTMLElement): () => void {
    const observer = new ResizeObserver(() => this.grow());
    observer.observe(card);
    void document.fonts?.ready.then(() => this.grow());
    return () => observer.disconnect();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        await tick();
        const root = this.root();
        if (this.level >= 3 || !root) break;
        const tall = root.scrollHeight > root.clientHeight + 1;
        // Measured on the parts of the card: the fade-in animation of a
        // step (scale) distorts the measures of the card itself.
        const parts = [...(this.card()?.children ?? [])];
        const wide = parts.some((el) => el.scrollWidth > el.clientWidth + 1);
        if (!tall && !wide) break;
        this.level += 1;
      }
    } finally {
      this.running = false;
    }
  }
}
