/**
 * Loads `render.ts` with DOMPurify only for the reading view (JS budget of
 * the mailbox route): the list does not need it. The mailbox
 * page calls `load()` as soon as a conversation is open, and otherwise
 * `preload()`, so that the first email is ready from idle time. Until then
 * `current` is `null`, and `readValues()` returns no document yet for HTML
 * emails (`hb.doc`).
 *
 * If the import fails, the module retries itself (`RETRY_MS`), even without
 * a new call. If all attempts fail although the browser is online, the state
 * counts as stale (tab open across a release, the old chunk is gone): like
 * SvelteKit with a node, it then reloads the page once, with a lock in
 * `sessionStorage` against loops. Not offline – the service worker keeps the
 * chunks of its version, an error there is not a stale state. Only while the
 * reading view needs the renderer (`load()` until `release()`), never because
 * of `preload()` alone. If it stays empty afterwards (lock, offline, without
 * `sessionStorage`), the `online` event starts the attempts over while the
 * need persists.
 */
import type { renderMail } from '#lib/mail/render.ts';

export type RenderMail = typeof renderMail;

/** At the latest then `preload()` loads even without idle time (ms; without `requestIdleCallback` the waiting time). */
export const PRELOAD_TIMEOUT_MS = 3000;
/** Waiting times before the retries after a failed import (ms): first attempt and three more. */
export const RETRY_MS = [1000, 2000, 4000] as const;
/** Time of the last reload because of the renderer (ms since 1970, `sessionStorage`). */
export const RELOAD_KEY = 'roedy-mail.render-reload';
/** No further reload for this long after a reload (ms). */
export const RELOAD_LOCK_MS = 5 * 60_000;

/** Environment; tests replace it. */
export interface RendererDeps {
  /** Dynamic import of `render.ts`. */
  load: () => Promise<{ renderMail: RenderMail }>;
  online: () => boolean;
  /** `sessionStorage`; `null` if the browser refuses it (then no reload). */
  storage: () => Storage | null;
  reload: () => void;
  now: () => number;
  /** Registers `listener` for the `online` event; returns the unregistration. */
  onOnline: (listener: () => void) => () => void;
}

const browserDeps: RendererDeps = {
  load: () => import('#lib/mail/render.ts'),
  online: () => navigator.onLine,
  storage: () => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  },
  reload: () => location.reload(),
  now: () => Date.now(),
  onOnline: (listener) => {
    window.addEventListener('online', listener);
    return () => window.removeEventListener('online', listener);
  },
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MailRenderer {
  /** `renderMail` after loading; reactive so that the reading view recomputes then. */
  current = $state.raw<RenderMail | null>(null);
  readonly #deps: RendererDeps;
  #loading: Promise<RenderMail | null> | null = null;
  #waiting = false;
  /** The reading view waits for the renderer (`load()` until `release()`): only then does a final error reload the page. */
  #needed = false;
  /** Unregistration from `online` after a final error; at most one registration at a time. */
  #offOnline: (() => void) | null = null;

  constructor(deps: RendererDeps = browserDeps) {
    this.#deps = deps;
  }

  /**
   * Loads `render.ts` once, with retries after errors (`RETRY_MS`);
   * `null` if all fail (then the next call starts over).
   */
  load(): Promise<RenderMail | null> {
    if (this.current) return Promise.resolve(this.current);
    this.#needed = true;
    return this.#start();
  }

  /**
   * The reading view no longer needs the renderer (conversation closed, page
   * left): no reload and no new attempt on `online` anymore. A running
   * import and its retries keep filling `current`.
   */
  release(): void {
    this.#needed = false;
    this.#unwatch();
  }

  /** Preloads during idle time (`requestIdleCallback`, otherwise after `PRELOAD_TIMEOUT_MS`). */
  preload(): void {
    if (this.current || this.#loading || this.#waiting) return;
    this.#waiting = true;
    const run = () => {
      this.#waiting = false;
      void this.#start();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: PRELOAD_TIMEOUT_MS });
    else setTimeout(run, PRELOAD_TIMEOUT_MS);
  }

  #start(): Promise<RenderMail | null> {
    this.#loading ??= this.#attempts();
    return this.#loading;
  }

  async #attempts(): Promise<RenderMail | null> {
    for (let i = 0; ; i++) {
      try {
        const { renderMail } = await this.#deps.load();
        this.current = renderMail;
        this.#unwatch();
        return renderMail;
      } catch {
        const delay = RETRY_MS[i];
        if (delay === undefined) break;
        await wait(delay);
      }
    }
    this.#loading = null;
    if (this.#needed) {
      this.#reloadOnce();
      this.#watch();
    }
    return null;
  }

  /** After a final error: with the network back, the attempts start over (only when needed). */
  #watch(): void {
    if (this.#offOnline) return;
    this.#offOnline = this.#deps.onOnline(() => {
      this.#unwatch();
      if (this.#needed && !this.current) void this.#start();
    });
  }

  #unwatch(): void {
    this.#offOnline?.();
    this.#offOnline = null;
  }

  /** Reload like SvelteKit with a missing node: only online and at most once per `RELOAD_LOCK_MS`. */
  #reloadOnce(): void {
    if (!this.#deps.online()) return;
    const storage = this.#deps.storage();
    if (!storage) return;
    const now = this.#deps.now();
    try {
      const last = Number(storage.getItem(RELOAD_KEY));
      if (last > 0 && Math.abs(now - last) < RELOAD_LOCK_MS) return;
      storage.setItem(RELOAD_KEY, String(now));
    } catch {
      return;
    }
    this.#deps.reload();
  }
}

export const mailRenderer = new MailRenderer();
