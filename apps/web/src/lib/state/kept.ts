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

  forget(): void {
    this.#value = null;
    this.#gen++;
  }
}
