/**
 * Toasts and undo as deferred execution. An
 * action with undo changes the display immediately; the call to the server
 * only goes out when the toast expires. "Undo" only reverts the local
 * change – the backend has no soft delete.
 *
 * Whatever cannot wait sends immediately: a new toast (the previous one loses
 * its undo), signing out, and leaving or hiding the page – the last two with
 * `keepalive` so that the request survives closing the tab. Without a
 * connection nothing is sent early: the request would surely fail, and by the
 * time the toast expires the connection is often back.
 *
 * Exception sending: the action already runs on the server, and
 * "Undo" is a second call that can fail (`undoable()`).
 */

/** Shown toast. */
export interface Toast {
  /** Counts up per toast so that a new toast with the same text fades in again. */
  id: number;
  text: string;
  /** Offer "Undo". */
  undo: boolean;
  /** Error toast: warning icon, never "Undo". */
  error: boolean;
}

/** Action with undo; the caller has already made the local change. */
export interface DeferredAction {
  text: string;
  /** Revert the local change: after "Undo" or if sending fails. */
  revert: () => void;
  /** Call to the server; without it the action is purely local. */
  commit?: (keepalive: boolean) => Promise<unknown>;
  /** Sending failed (after `revert`). */
  onError?: (error: unknown) => void;
  /**
   * Only after "Undo" by the user (after `revert`): compensate an action
   * already executed on the server, e.g. delete a created folder again.
   * Signing out (`discard()`) does not call it.
   */
  onUndo?: () => void;
}

/**
 * Action already executed on the server whose "Undo" is a second call
 * (sending with `HOLDFOR`). After the toast expires, on a new
 * toast or on signing out nothing happens any more.
 */
export interface UndoableAction {
  text: string;
  /** "Undo": call to the server. */
  undo: () => Promise<unknown>;
  /** Reverted. */
  onUndone?: () => void;
  /** Reverting failed; the action remains. */
  onError?: (error: unknown) => void;
  /** Display duration if reverting is only possible for less than `gUndo` (sending: `HOLDFOR`). */
  ms?: number;
}

/** Display duration without undo. */
export const TOAST_MS = 3200;

/** Display duration of an error toast (`error()`). */
export const ERROR_TOAST_MS = 4600;

/** Display duration with undo per setting `gUndo` (`UNDO_MS`). */
export const UNDO_MS = { '3 s': 3000, '5 s': 5000, '10 s': 10000 } as const;

export class Toasts {
  readonly #show: (toast: Toast | null) => void;
  readonly #undoMs: () => number;
  #pending: DeferredAction | null = null;
  /** Undo of an action that already ran on the server (`undoable()`). */
  #offer: UndoableAction | null = null;
  /** Actions just being sent (after expiry or early). */
  readonly #sending = new Set<Promise<void>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #id = 0;
  /** Paused by `hold()`: the toast stays until `resume()` lets it continue. */
  #held = false;

  /**
   * @param show shows the toast or hides it (`null`)
   * @param undoMs display duration with undo (from `gUndo`)
   */
  constructor(show: (toast: Toast | null) => void, undoMs: () => number) {
    this.#show = show;
    this.#undoMs = undoMs;
  }

  /** Is a toast with undo running whose action has not gone out yet? */
  get pending(): boolean {
    return this.#pending !== null;
  }

  /** Is this action still waiting in the toast (not sent, not undone)? */
  waiting(action: DeferredAction | null): boolean {
    return action !== null && this.#pending === action;
  }

  /** Notice without undo; a pending action goes out first. */
  show(text: string): void {
    void this.flush();
    this.#open(text, false, TOAST_MS);
  }

  /** Error toast without undo, e.g. when an action fails on the server. */
  error(text: string): void {
    void this.flush();
    this.#open(text, false, ERROR_TOAST_MS, true);
  }

  /** Toast with undo; the call to the server follows when it expires. */
  defer(action: DeferredAction): void {
    void this.flush();
    this.#pending = action;
    this.#open(action.text, true, this.#undoMs());
  }

  /**
   * Toast with undo for an action that already ran on the server; "Undo"
   * calls `undo`. A pending action goes out first.
   */
  undoable(action: UndoableAction): void {
    void this.flush();
    this.#open(action.text, true, Math.min(action.ms ?? Infinity, this.#undoMs()), false, action);
  }

  /** "Undo": revert the local change, send nothing (except the compensation `onUndo`). */
  undo(): void {
    const offer = this.#offer;
    if (offer) {
      this.#close();
      void this.#track(
        offer.undo().then(
          () => offer.onUndone?.(),
          (error: unknown) => offer.onError?.(error),
        ),
      );
      return;
    }
    const action = this.discard();
    action?.onUndo?.();
  }

  /** Discard a pending action like "Undo", but without compensation on the server (signing out); returns it. */
  discard(): DeferredAction | null {
    const action = this.#pending;
    this.#pending = null;
    this.#close();
    action?.revert();
    return action;
  }

  /**
   * Send a pending action immediately; the toast disappears with its undo.
   * Also waits for actions that are already on their way (signing out).
   */
  async flush(keepalive = false): Promise<void> {
    // An offer (`undoable()`) stays with its toast; only a new toast or its end ends it.
    const action = this.#pending;
    if (action) {
      this.#pending = null;
      this.#close();
      void this.#commit(action, keepalive);
    }
    await Promise.all(this.#sending);
  }

  /** Hide the toast, e.g. when a dialog opens; a pending action goes out first. */
  dismiss(): void {
    void this.flush();
    this.#close();
  }

  /** Swiping the toast starts: it stays until the gesture ends (`gStart`). */
  hold(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#held = true;
  }

  /**
   * Toast sprung back: it runs for another `ms` and then goes as if expired,
   * a pending action is sent (`gRelease`). Without a toast nothing.
   */
  resume(ms: number): void {
    if (this.#held) this.#arm(ms);
  }

  /** Sends immediately when leaving and hiding the page; returns the removal of the listeners. */
  attach(target: Window): () => void {
    const now = () => void this.flush(true);
    const hidden = () => {
      if (target.document.visibilityState === 'hidden') now();
    };
    target.addEventListener('pagehide', now);
    target.document.addEventListener('visibilitychange', hidden);
    return () => {
      target.removeEventListener('pagehide', now);
      target.document.removeEventListener('visibilitychange', hidden);
    };
  }

  #open(text: string, undo: boolean, ms: number, error = false, offer: UndoableAction | null = null): void {
    this.#offer = offer;
    clearTimeout(this.#timer);
    this.#show({ id: ++this.#id, text, undo, error });
    this.#arm(ms);
  }

  #arm(ms: number): void {
    clearTimeout(this.#timer);
    this.#held = false;
    this.#timer = setTimeout(() => {
      const action = this.#pending;
      this.#pending = null;
      this.#close();
      if (action) void this.#commit(action, false);
    }, ms);
  }

  #close(): void {
    this.#offer = null;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#held = false;
    this.#show(null);
  }

  #commit(action: DeferredAction, keepalive: boolean): Promise<void> {
    const { commit } = action;
    if (!commit) return Promise.resolve();
    return this.#track(
      (async () => {
        try {
          await commit(keepalive);
        } catch (error) {
          action.revert();
          action.onError?.(error);
        }
      })(),
    );
  }

  /** Running call that `flush()` (signing out) waits for; an error in it does not abort the waiting. */
  #track(sending: Promise<unknown>): Promise<void> {
    const done = sending.then(
      () => {},
      () => {},
    );
    this.#sending.add(done);
    void done.then(() => this.#sending.delete(done));
    return done;
  }
}
