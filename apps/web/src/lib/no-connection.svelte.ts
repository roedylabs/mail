/**
 * "No connection" of the setup wizard: shows on the window's `offline`
 * event and when a request gets no answer. Retries by itself after 5 s,
 * 10 s, 20 s, then every 30 s; an attempt asks the server for the setup
 * status (`probe`) and shows "Checking …" for at least 1.2 s. The first
 * answer closes the message; "Try now" and the `online` event attempt at
 * once. A server error is an answer too: it never shows this message.
 */

/** Waits before the attempts, in seconds; the last one repeats. */
export const NET_WAIT = [5, 10, 20, 30] as const;

/** Shortest "Checking …" of an attempt without an answer (the ring spins). */
export const NET_CHECK_MS = 1200;

/** Longest attempt: a request that hangs counts as no answer, so the retries go on. */
export const NET_PROBE_MS = 10_000;

/** Wait before attempt `n` (0 = the first). */
export function netWait(n: number): number {
  return NET_WAIT[Math.min(Math.max(0, n), NET_WAIT.length - 1)]!;
}

export interface ReconnectHooks {
  /** `true` once the server answers (any status), `false` without an answer; `signal` ends at `NET_PROBE_MS`. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  /** An attempt via "Try now" got no answer: shake the message. */
  stayed?: () => void;
  /** The server answered and the message closed. */
  answered?: () => void;
}

export class Reconnect {
  open = $state(false);
  busy = $state(false);
  /** Attempts without an answer since opening. */
  tries = $state(0);
  /** Time of the next attempt (ms since 1970). */
  due = $state(0);
  /** Clock for the countdown, updated every 250 ms while waiting. */
  now = $state(Date.now());
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly hooks: ReconnectHooks;

  constructor(hooks: ReconnectHooks) {
    this.hooks = hooks;
  }

  /** Length of the current wait in seconds. */
  total = $derived(netWait(this.tries));
  /** Whole seconds until the next attempt (at most the wait). */
  left = $derived(Math.min(this.total, Math.max(0, Math.ceil((this.due - this.now) / 1000))));

  show(): void {
    if (this.open) return;
    this.open = true;
    this.busy = false;
    this.tries = 0;
    this.wait();
  }

  /** Attempts at once ("Try now", `online`); `manual` shakes the message if it stays. */
  async attempt(manual = false): Promise<void> {
    if (!this.open || this.busy) return;
    this.busy = true;
    clearInterval(this.timer);
    const started = Date.now();
    let answered: boolean;
    const ctrl = new AbortController();
    let limit: ReturnType<typeof setTimeout> | undefined;
    try {
      answered = await Promise.race([
        this.hooks.probe(ctrl.signal),
        new Promise<boolean>((resolve) => {
          limit = setTimeout(() => {
            ctrl.abort();
            resolve(false);
          }, NET_PROBE_MS);
        }),
      ]);
    } catch {
      answered = false;
    } finally {
      clearTimeout(limit);
    }
    if (!this.open) return;
    if (answered) {
      this.close();
      this.hooks.answered?.();
      return;
    }
    const rest = NET_CHECK_MS - (Date.now() - started);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    if (!this.open) return;
    this.busy = false;
    this.tries += 1;
    this.wait();
    if (manual) this.hooks.stayed?.();
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.open = false;
    this.busy = false;
  }

  private wait(): void {
    this.now = Date.now();
    this.due = this.now + netWait(this.tries) * 1000;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.now = Date.now();
      if (this.now >= this.due) void this.attempt();
    }, 250);
  }
}
