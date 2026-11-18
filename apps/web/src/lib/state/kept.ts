/**
 * Last known data of a page for the session (Administration › Users, › Mail
 * servers, Account › Security): a reopened page shows it at once and loads
 * again in the background. Only in memory; signing out discards it
 * (`onForget`), and a page opened before that keeps nothing afterwards.
 */
import { onForget } from '#lib/state/forget.ts';

export class Kept<T> {
  #value: T | null = null;
  #gen = 0;
  #changes = 0;
  /** Calls of pages already left that a reopened page waits for (`settled()`). */
  readonly #sending = new Set<Promise<void>>();

  constructor() {
    onForget(() => this.forget());
  }

  /** Kept data; `null` until a page of this session kept some. */
  get value(): T | null {
    return this.#value;
  }

  /** Keeps data for a page opened now; without effect once the session has ended in the meantime. */
  keeper(): (value: T) => void {
    const gen = this.#gen;
    return (value) => {
      if (gen === this.#gen) this.#value = value;
    };
  }

  /**
   * Counts changes of the list, of every page of the session: a load that
   * started before one does not apply, also if a page already left confirms it.
   */
  get changes(): number {
    return this.#changes;
  }

  changed(): void {
    this.#changes++;
  }

  /** Call sent by a page that was left (e.g. a removal on leaving); a reopened page loads only after it. */
  track(call: Promise<unknown>): void {
    const done = call.then(
      () => {},
      () => {},
    );
    this.#sending.add(done);
    void done.then(() => this.#sending.delete(done));
  }

  /** Runs `load` once all calls of left pages are through (also failed ones); without any right away. */
  after<R>(load: () => Promise<R>): Promise<R> {
    if (!this.#sending.size) return load();
    return Promise.all(this.#sending).then(load);
  }

  forget(): void {
    this.#value = null;
    this.#gen++;
    this.#sending.clear();
  }
}
