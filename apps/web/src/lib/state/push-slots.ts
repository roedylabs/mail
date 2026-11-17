/**
 * Slots for push streams per origin. Over HTTP/1.1 browsers open at most six
 * connections per host – for all tabs together – and every push stream keeps
 * one of them open. Without a limit, six accounts on one server block every
 * further request (JMAP, uploads, downloads, sign-in). Over HTTP/2 or HTTP/3
 * all streams share one connection, so there is no limit.
 *
 * The slots are Web Locks: they count across all tabs of the app and are freed
 * when a tab closes. Accounts without a slot poll and take over the next free
 * slot as soon as one opens up.
 */

/** Push streams per origin over HTTP/1.1 (or unknown protocol): half of the six connections. */
export const HTTP1_STREAMS = 3;

/** The part of `LockManager` the slots need; `navigator.locks` or `tabLocks()`. */
export interface Locks {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

export interface PushSlots {
  /**
   * Resolves as soon as the account holds a slot for the origin of `url` (its
   * push stream); it keeps it until `signal` aborts. If no slot is free right away, `onWait` runs first.
   * After `signal` aborts it resolves without a slot (and no longer calls `onWait`).
   */
  acquire(url: string, signal: AbortSignal, onWait: () => void): Promise<void>;
}

/**
 * Whether the browser reaches `origin` multiplexed (HTTP/2, HTTP/3),
 * according to the latest request there in Resource Timing. The protocol is
 * empty for other origins without `Timing-Allow-Origin`: then not.
 */
export function multiplexed(origin: string, entries: readonly PerformanceEntry[] = resourceEntries()): boolean {
  let protocol = '';
  for (const entry of entries) {
    const next = (entry as PerformanceResourceTiming).nextHopProtocol;
    if (next && entry.name.startsWith(`${origin}/`)) protocol = next;
  }
  return protocol === 'h2' || protocol.startsWith('h3');
}

function resourceEntries(): PerformanceEntry[] {
  return typeof performance === 'undefined' ? [] : performance.getEntriesByType('resource');
}

export function pushSlots(
  locks: Locks = globalLocks() ?? tabLocks(),
  isMultiplexed: (origin: string) => boolean = (origin) => multiplexed(origin),
  limit = HTTP1_STREAMS,
): PushSlots {
  return {
    async acquire(url, signal, onWait) {
      const { origin } = new URL(url);
      if (signal.aborted || isMultiplexed(origin)) return;
      const names = Array.from({ length: limit }, (_, i) => `roedy-push ${origin} ${i}`);
      for (const name of names) {
        if (await take(locks, name, signal)) return;
        if (signal.aborted) return;
      }
      onWait();
      await waitAny(locks, names, signal);
    },
  };
}

/** Holds the lock until `signal` aborts; returns immediately when the lock is aborted. */
function hold(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The lock if it is free right now. */
function take(locks: Locks, name: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(lock !== null && !signal.aborted);
        return lock === null ? undefined : hold(signal);
      })
      .catch(() => resolve(false));
  });
}

/** Waits for the first of the locks to become free and holds it; the other requests are dropped. */
function waitAny(locks: Locks, names: readonly string[], signal: AbortSignal): Promise<void> {
  const won = new AbortController();
  const pending = AbortSignal.any([signal, won.signal]);
  return new Promise((resolve) => {
    const done = (): void => {
      won.abort();
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    for (const name of names) {
      locks
        .request(name, { signal: pending }, () => {
          // Granted together with another one, or too late: give it back right away.
          if (won.signal.aborted) return;
          done();
          return hold(signal);
        })
        .catch(() => {});
    }
  });
}

function globalLocks(): Locks | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

/**
 * Locks of this tab only, when the browser has no Web Locks (outside a secure
 * context, tests): exclusive, in the order of the requests.
 */
export function tabLocks(): Locks {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  const release = (name: string): void => {
    const next = queues.get(name)?.shift();
    if (next) next();
    else held.delete(name);
  };
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const grant = (): void => {
          held.add(name);
          void Promise.resolve()
            .then(() => callback(name))
            .then(resolve, reject)
            .finally(() => release(name));
        };
        if (!held.has(name)) {
          grant();
          return;
        }
        if (options.ifAvailable) {
          void Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
          return;
        }
        const { signal } = options;
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        const entry = (): void => {
          signal?.removeEventListener('abort', abort);
          grant();
        };
        const abort = (): void => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          if (signal) reject(abortError(signal));
        };
        queue.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
