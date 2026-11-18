/**
 * Last known data of a page for the session (Administration › Users, › Mail
 * servers, Account › Security): a reopened page shows it at once and loads
 * again in the background. Only in memory; signing out discards it
 * (`onForget`), and a page opened before that keeps nothing afterwards.
 */
import { onForget } from '#lib/state/forget.ts';

/** A reopened page waits at most this long for calls of a left page (`after()`), then loads anyway. */
export const KEPT_WAIT_MS = 10_000;

export class Kept<T> {
  #value: T | null = null;
  #gen = 0;
  #changes = 0;
  /** Calls still on their way per page; another page of the same list waits for them (`after()`). */
  readonly #sending = new Map<Promise<void>, object>();

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

  /** Call of `page` on its way (e.g. a removal): a reopened page loads only after it (`after()`). */
  track(call: Promise<unknown>, page: object): void {
    const done = call.then(
      () => {},
      () => {},
    );
    this.#sending.set(done, page);
    void done.then(() => this.#sending.delete(done));
  }

  /**
   * Runs `load` of `page` once the calls of other pages are through (also
   * failed ones), at most `KEPT_WAIT_MS`; without any right away.
   */
  after<R>(page: object, load: () => Promise<R>): Promise<R> {
    const others = [...this.#sending].filter(([, p]) => p !== page).map(([call]) => call);
    if (!others.length) return load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, KEPT_WAIT_MS)));
    return Promise.race([Promise.all(others), deadline]).then(() => {
      clearTimeout(timer);
      return load();
    });
  }

  forget(): void {
    this.#value = null;
    this.#gen++;
    this.#sending.clear();
  }
}
