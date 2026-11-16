/**
 * Locks with a countdown on the guest pages (429 `rate_limited` with
 * `retry_after`): end per kind and a clock that only runs while a lock applies.
 * `onFree` reports expired locks (release the field, remove the notice). Used by
 * setup, sign-in and the invitation.
 */
import { untrack } from 'svelte';

export class Countdown<K extends string> {
  /** Clock for the remaining times (`left`), updated every 250 ms. */
  now = $state(Date.now());
  private ends = $state<Partial<Record<K, number>>>({});
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly onFree: ((kind: K) => void) | undefined;

  constructor(onFree?: (kind: K) => void) {
    this.onFree = onFree;
  }

  /**
   * Locks `kind` for `seconds` seconds; a running lock is replaced.
   * Reads its state without a dependency – even from within an effect
   * that would otherwise rerun from its own write.
   */
  start(kind: K, seconds: number): void {
    if (this.stopped) return;
    untrack(() => {
      this.now = Date.now();
      this.ends = { ...this.ends, [kind]: this.now + seconds * 1000 };
    });
    this.timer ??= setInterval(() => this.tick(), 250);
  }

  /** Lifts a lock without `onFree`. */
  clear(kind: K): void {
    if (this.ends[kind] === undefined) return;
    const rest = { ...this.ends };
    delete rest[kind];
    this.ends = rest;
  }

  /** Whether `kind` is locked (until `onFree` has reported). */
  active(kind: K): boolean {
    return this.ends[kind] !== undefined;
  }

  /** End of the lock in ms since 1970, otherwise `null`. */
  until(kind: K): number | null {
    return this.ends[kind] ?? null;
  }

  /** Remaining time in whole seconds; 0 = free. */
  left(kind: K): number {
    const end = this.ends[kind];
    return end === undefined ? 0 : Math.max(0, Math.ceil((end - this.now) / 1000));
  }

  /** Stops the clock; afterwards no lock starts any more (page left). */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }

  private tick(): void {
    this.now = Date.now();
    const kinds = Object.keys(this.ends) as K[];
    const freed = kinds.filter((kind) => (this.ends[kind] ?? 0) <= this.now);
    if (freed.length) {
      const rest = { ...this.ends };
      for (const kind of freed) delete rest[kind];
      this.ends = rest;
      for (const kind of freed) this.onFree?.(kind);
    }
    if (Object.keys(this.ends).length === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
