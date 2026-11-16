/**
 * Connectivity of the app: what requests show, with the browser as a
 * hint, and the offline simulation of the Developer page.
 * `navigator.onLine` alone is not enough: in a network without a default route
 * Chromium permanently reports `false` although backend and mail servers answer.
 * The simulation makes all requests fail as without a network (`appFetch`) and
 * lives only in this tab's memory: stored in `settings`, the app could not even
 * load the settings that end it after reloading.
 */
import { isJmapError } from '@roedy/jmap';
import { m } from '#lib/paraglide/messages.js';
import { devLog } from '#lib/state/devlog.svelte.ts';

/** Interval of the probes while the app is offline (`network.lost`). */
export const PROBE_MS = 10_000;

/** Origin of a request (backend, a mail server); relative addresses count for the page. */
export function originOf(input: RequestInfo | URL): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only read, no state
    return new URL(href, globalThis.location?.href).origin;
  } catch {
    return href;
  }
}

/**
 * A network error (`TypeError` from `fetch`) or a timeout, also
 * the JMAP client's time limit (abort with `unreachable`): the request
 * got no response.
 */
const unanswered = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof DOMException && error.name === 'TimeoutError') ||
  isJmapError(error, 'unreachable');

export class Network {
  /** The browser reports a connection (`navigator.onLine`): only a hint until a request shows something. */
  online = $state(true);
  /** Offline simulation is running. */
  simulated = $state(false);
  /**
   * Outcome of the last request per origin since the browser's last
   * event: `true` answered (also with a server error), `false`
   * without response.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable, every change replaces the map
  reached = $state.raw<ReadonlyMap<string, boolean>>(new Map());
  /**
   * Without connection, as far as known: notice bar "Offline",
   * blocked sending, search in memory. If an origin
   * answers, the connection is there; if all stayed without response last, it is
   * missing. A single mail server without response is thus not offline; the bar
   * reports that per host. Without a request since the last event
   * the browser counts.
   */
  offline = $derived(this.simulated || (this.reached.size ? ![...this.reached.values()].some(Boolean) : !this.online));
  /**
   * Offline, except in the simulation: `pollVisible` then probes more often
   * (`PROBE_MS`), even if only the browser reports offline – in a network without
   * a default route the return would otherwise only come with the next request.
   */
  lost = $derived(!this.simulated && this.offline);

  /** Counts events of the browser and the simulation: outcomes of requests before them no longer count. */
  epoch = 0;

  /** Listeners of `onReturn`. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- listeners, not displayed
  readonly #listeners = new Set<() => void>();

  /** Reports the end of an offline phase, also of the simulation; returns the unsubscribe. */
  onReturn(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Follows the browser's connection and records it in the log.
   * An event forgets the outcomes: afterwards the browser counts until the
   * next request shows something.
   */
  attach(target: Window): () => void {
    const read = () => target.navigator.onLine !== false;
    const update = () => {
      const was = this.offline;
      this.online = read();
      this.epoch++;
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable, replaces the map
      this.reached = new Map();
      devLog.add(this.online ? 'info' : 'warning', this.online ? m.dev_log_back_online() : m.dev_log_connection_lost());
      this.#announce(was);
    };
    this.online = read();
    target.addEventListener('online', update);
    target.addEventListener('offline', update);
    return () => {
      target.removeEventListener('online', update);
      target.removeEventListener('offline', update);
    };
  }

  /**
   * Outcome of a request (`appFetch`); if it changes the connection, it goes into the
   * log. The first response after an offline only according to the browser (network without
   * default route at start) is not a return for the log.
   */
  record(origin: string, answered: boolean): void {
    if (this.reached.get(origin) === answered) return;
    const was = this.offline;
    const known = this.reached.size > 0;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable, replaces the map
    this.reached = new Map([...this.reached, [origin, answered]]);
    if (was !== this.offline && !this.simulated && (!was || known))
      devLog.add(was ? 'info' : 'warning', was ? m.dev_log_back_online() : m.dev_log_connection_lost());
    this.#announce(was);
  }

  /** Start and end of the simulation forget the outcomes like a browser event: they are from before. */
  simulate(on: boolean): void {
    if (on === this.simulated) return;
    const was = this.offline;
    this.simulated = on;
    this.epoch++;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable, replaces the map
    this.reached = new Map();
    devLog.add('warning', on ? m.dev_log_sim_started() : m.dev_log_sim_ended());
    this.#announce(was);
  }

  /** All sources count: if the simulation ends without a network, the connection is not back. */
  #announce(was: boolean): void {
    if (was && !this.offline) for (const listener of this.#listeners) listener();
  }
}

export const network = new Network();

/**
 * Calls `run` every `ms` while the page is visible, on returning to the
 * tab and after an offline phase; while the app is offline
 * (`network.lost`), every `PROBE_MS`, so that the return is noticed soon without a
 * browser event. Returns the cleanup.
 */
export function pollVisible(target: Window, ms: number, visible: () => boolean, run: () => void): () => void {
  const tick = () => {
    if (visible()) run();
  };
  const timer = setInterval(tick, ms);
  const probe = setInterval(() => {
    if (network.lost) tick();
  }, PROBE_MS);
  target.document.addEventListener('visibilitychange', tick);
  const stopReturn = network.onReturn(tick);
  return () => {
    clearInterval(timer);
    clearInterval(probe);
    target.document.removeEventListener('visibilitychange', tick);
    stopReturn();
  };
}

/**
 * `fetch` for backend and JMAP: fails in the simulation as without a network and
 * otherwise reports the outcome to `network`. Aborted by itself says
 * nothing about the connection. An already open stream keeps running in the simulation,
 * but the app fetches its changes with requests that fail here
 * again.
 */
export const appFetch: typeof fetch = (input, init) => {
  if (network.simulated) return Promise.reject(new TypeError('Offline simulation'));
  const run = globalThis.fetch(input, init);
  const origin = originOf(input);
  // If the request ends after a browser event, it says nothing about the new network.
  const epoch = network.epoch;
  void run.then(
    () => {
      if (network.epoch === epoch) network.record(origin, true);
    },
    (error: unknown) => {
      if (network.epoch === epoch && unanswered(error)) network.record(origin, false);
    },
  );
  return run;
};
