/**
 * Access token per request via a provider. `TokenSource` keeps the token
 * broker's token (`GET mail-accounts/:id/token`) until shortly before it
 * expires, fetches a new one once on a 401 from the mail server (`refresh`)
 * and, after a 429 from the backend, does not ask again until `Retry-After`.
 */

export interface TokenRequest {
  /** Token the mail server rejected with 401: do not return this one then. */
  rejected?: string;
  signal?: AbortSignal;
}

export interface TokenProvider {
  token(request?: TokenRequest): Promise<string>;
  /** Earliest point in time (ms since 1970) for a new fetch after a lockout, otherwise 0. */
  retryAt?(): number;
}

/** Response of the token broker. */
export interface TokenGrant {
  accessToken: string;
  /** RFC 3339; `null` for access tokens without expiry. */
  expiresAt: string | null;
  /** JMAP session of the last sign-in. */
  session?: unknown;
}

export interface TokenSourceOptions {
  /** Fetches a token; `refresh` when the mail server rejected the previous one. */
  fetch(refresh: boolean): Promise<TokenGrant>;
  /** Wait time in seconds that an error from `fetch` dictates (429 with `Retry-After`), otherwise `undefined`. */
  retryAfter?(error: unknown): number | undefined;
  /** How long before `expiresAt` the token counts as expired (ms); default one minute. */
  margin?: number;
  now?(): number;
}

interface Held {
  grant: TokenGrant;
  /** Expiry minus `margin` in ms. */
  until: number;
}

export class TokenSource implements TokenProvider {
  readonly #options: TokenSourceOptions;
  #held: Held | null = null;
  /** Fetch in progress; `refresh` when it renews. */
  #pending: { promise: Promise<Held>; refresh: boolean } | null = null;
  #pause: { until: number; error: unknown } | null = null;
  /** Counts `clear()`; fetches from before it no longer write anything. */
  #generation = 0;

  constructor(options: TokenSourceOptions) {
    this.#options = options;
  }

  /** Last response of the broker (with `session`), otherwise `null`. */
  get grant(): TokenGrant | null {
    return this.#held?.grant ?? null;
  }

  async token(request: TokenRequest = {}): Promise<string> {
    const { rejected, signal } = request;
    signal?.throwIfAborted();
    for (let again = false; ; again = true) {
      const held = this.#held;
      if (held && held.until > this.#now() && held.grant.accessToken !== rejected) return held.grant.accessToken;
      // If the mail server rejects the currently valid token, or the broker
      // returns an already rejected one again, it has to renew.
      const pending = this.#fetch(again || (held !== null && held.grant.accessToken === rejected));
      const next = await abortable(pending.promise, signal);
      if (next.grant.accessToken !== rejected || pending.refresh) return next.grant.accessToken;
    }
  }

  retryAt(): number {
    const pause = this.#pause;
    return pause && pause.until > this.#now() ? pause.until : 0;
  }

  /** Forgets the token (sign-out, account removed); fetches in progress end with `AbortError`. */
  clear(): void {
    this.#generation++;
    this.#held = null;
    this.#pending = null;
    this.#pause = null;
  }

  /**
   * One fetch at a time; whoever asks meanwhile waits for it. If the caller
   * needs a new token and the running fetch does not renew, `token()` asks
   * again itself with `refresh` afterwards.
   */
  #fetch(refresh: boolean): { promise: Promise<Held>; refresh: boolean } {
    if (this.#pending) return this.#pending;
    const pause = this.#pause;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (pause && pause.until > this.#now()) return { promise: Promise.reject(pause.error), refresh };
    const promise: Promise<Held> = this.#load(refresh, this.#generation).finally(() => {
      if (this.#pending?.promise === promise) this.#pending = null;
    });
    this.#pending = { promise, refresh };
    return this.#pending;
  }

  async #load(refresh: boolean, generation: number): Promise<Held> {
    let grant: TokenGrant;
    try {
      grant = await this.#options.fetch(refresh);
    } catch (error) {
      const seconds = this.#options.retryAfter?.(error);
      if (generation === this.#generation && seconds !== undefined && seconds > 0) {
        this.#pause = { until: this.#now() + seconds * 1000, error };
      }
      throw error;
    }
    if (generation !== this.#generation) throw new DOMException('token discarded', 'AbortError');
    this.#pause = null;
    const expires = grant.expiresAt === null ? Infinity : Date.parse(grant.expiresAt);
    // Unreadable date: treated as expired, but still usable for this request.
    const until = Number.isNaN(expires) ? 0 : expires - (this.#options.margin ?? 60_000);
    const held = { grant, until };
    this.#held = held;
    return held;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/** Waits for `promise`, but aborts with `signal` (the fetch itself keeps running for others). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Whoever aborts no longer waits; nobody here catches a later error.
    promise.catch(() => {});
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // Pass the provider's errors on unchanged (e.g. the web app's `ApiError`).
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}
