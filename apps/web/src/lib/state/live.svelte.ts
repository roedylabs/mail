/**
 * Live sync per mail account: push
 * via `events()` from `@roedy/jmap`; after every connection setup and on
 * every new state it syncs the mailboxes (`mailboxes.sync()`) and the
 * emails (`Email/changes`). The open list then syncs with
 * `Email/queryChanges` and reloads changed conversations, the
 * open conversation reloads when it is affected. Without
 * `eventSourceUrl` or on persistent errors it polls at an interval
 * (polling) and tries push again later. When the connection is back,
 * it syncs immediately and rebuilds the stream (`reconnect`).
 */

import { isJmapError, type EventsOptions, type Id, type JmapClient } from '@roedy/jmap';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { edits } from '#lib/state/edits.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { message } from '#lib/state/message.svelte.ts';
import { scheduled } from '#lib/state/scheduled.svelte.ts';
import { emailChangesOf, threads } from '#lib/state/threads.svelte.ts';

/** Data types of the stream. */
export const LIVE_TYPES = ['Mailbox', 'Email'] as const;
/** This many errors in quick succession, then polling. */
export const PUSH_FAILURES = 3;
/** Errors further apart start the count anew (ms). */
export const FAILURE_WINDOW = 2 * 60_000;
/** Interval of the requests while polling (ms). */
export const POLL_INTERVAL = 60_000;
/** After this long in polling, try push again (ms), unless the server cannot push. */
export const PUSH_RETRY = 5 * 60_000;
/** The sync pill stays at least this long (ms), otherwise it only flashes. */
export const PILL_MIN = 1500;

/** Empty and immutable (report after `reset`). */
const NONE: ReadonlySet<Id> = new Set();

/** Changes to the emails of an account, as lists and conversations need them. */
export interface EmailChange {
  account: string;
  /** The server cannot calculate the changes (`cannotCalculateChanges`): reload. */
  reset: boolean;
  /** Threads of new and changed emails. */
  threads: ReadonlySet<Id>;
  /** Deleted emails. */
  destroyed: ReadonlySet<Id>;
  /** State of the emails after this report; missing after `reset`. */
  state?: string;
}

export type EmailChanges = { reset: true } | { reset: false; state: string; threads: Set<Id>; destroyed: Set<Id> };

/** Access to the mail servers; replaceable in tests. */
export interface LiveApi {
  /** Push stream; fails with `unsupported` without `eventSourceUrl`. */
  events(account: string, options: EventsOptions): Promise<void>;
  /** JMAP account of the emails (key in `StateChange.changed`). */
  accountId(account: string, signal: AbortSignal): Promise<Id>;
  /** Current state of the emails. */
  emailState(account: string, signal: AbortSignal): Promise<string>;
  /** Changes since `since`, with the threads of new and changed emails. */
  emailChanges(account: string, since: string, signal: AbortSignal): Promise<EmailChanges>;
}

/** Whom a sync reaches; replaceable in tests. */
export interface LiveTargets {
  mailboxes(account: string): Promise<void>;
  emails(change: EmailChange): Promise<void>;
  /** The account has answered, with or without changes. */
  reached?(account: string): Promise<void>;
}

export function jmapLiveApi(clientOf: (account: string) => Promise<JmapClient>): LiveApi {
  return {
    async events(account, options) {
      const client = await clientOf(account);
      return client.events(options);
    },

    async accountId(account, signal) {
      return (await clientOf(account)).accountId(undefined, signal);
    },

    async emailState(account, signal) {
      const client = await clientOf(account);
      const accountId = await client.accountId(undefined, signal);
      const b = client.batch();
      const get = b.call('Email/get', { accountId, ids: [], properties: ['id'] });
      return (await b.send(signal)).get(get).state;
    },

    async emailChanges(account, since, signal) {
      return emailChangesOf(await clientOf(account), since, signal);
    },
  };
}

/** Sync of one account. */
interface AccountLive {
  account: string;
  /** Aborts everything: account removed, no longer usable or signed out. */
  stop: AbortController;
  /** Running push stream. */
  push: AbortController | null;
  mode: 'push' | 'poll';
  /** While polling: since when (ms), for the next push attempt. */
  pollSince: number;
  /** `false` if the server cannot push (`unsupported`, `foreignOrigin`). */
  pushable: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  accountId: Id | null;
  /** Known state of the emails; `null` until the first sync. */
  emailState: string | null;
  /** Pending syncs; several triggers during one run result in one more. */
  want: { mailboxes: boolean; emails: boolean };
  running: Promise<void> | null;
  failures: number;
  lastFailure: number;
  /** First sync pending (sync pill). */
  initial: boolean;
}

export class LiveSync {
  /** Sync pill: the first sync of an account is running. */
  syncing = $state(false);
  readonly #api: LiveApi;
  readonly #targets: LiveTargets;
  // Not reactive: connections and timers are not displayed.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #live = new Map<string, AccountLive>();
  /** Email state of ended accounts until sign-out: after "sign in again" the sync reports what happened in between. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #states = new Map<string, string>();
  #pillAt = 0;
  #pillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    api: LiveApi = jmapLiveApi((account) => accounts.client(account)),
    targets: LiveTargets = {
      // Only sync loaded mailboxes; the sidebar loads the others as soon as they are visible.
      mailboxes: (account) => (mailboxes.of(account)?.status === 'ready' ? mailboxes.sync(account) : Promise.resolve()),
      emails: async (change) => {
        // New email state: also sync "Scheduled", e.g. after scheduling.
        scheduled.touch(change.account);
        await Promise.all([threads.touch(change), message.touch(change)]);
      },
      reached: async (account) => {
        // Do not wait: playback can take time and should not hold up the sync.
        void edits.queue.replay();
        await Promise.all([threads.resume(account), message.resume(account)]);
      },
    },
  ) {
    this.#api = api;
    this.#targets = targets;
  }

  /** Push or polling of the account; `undefined` without sync. */
  mode(account: string): 'push' | 'poll' | undefined {
    return this.#live.get(account)?.mode;
  }

  /** Syncs exactly these accounts: starts new ones, ends the rest. */
  retain(ids: readonly string[]): void {
    for (const account of [...this.#live.keys()]) if (!ids.includes(account)) this.#stop(account);
    for (const account of ids) if (!this.#live.has(account)) this.#start(account);
    this.#pill();
  }

  /**
   * Connection back: sync immediately and rebuild the stream.
   * Without this the old one would wait for the next attempt, while
   * polling until `PUSH_RETRY`, or it would hang on a dead connection until the
   * missing `ping`.
   */
  reconnect(): void {
    for (const live of this.#live.values()) {
      if (live.timer) clearTimeout(live.timer);
      live.timer = null;
      live.push?.abort();
      if (!live.pushable) {
        this.#poll(live);
        continue;
      }
      // Like at the start, does not wait for the stream: if it hangs, mail would only come with polling.
      this.#request(live, true, true);
      void this.#push(live);
    }
  }

  /** New mail according to the service worker: sync immediately, the stream follows by itself. */
  refresh(account: string): void {
    const live = this.#live.get(account);
    if (live) this.#request(live, true, true);
  }

  /** Sign-out: end everything. */
  reset(): void {
    this.retain([]);
    this.#states.clear();
    if (this.#pillTimer) clearTimeout(this.#pillTimer);
    this.#pillTimer = null;
    this.syncing = false;
  }

  #start(account: string): void {
    const live: AccountLive = {
      account,
      stop: new AbortController(),
      push: null,
      mode: 'push',
      pollSince: 0,
      pushable: true,
      timer: null,
      accountId: null,
      emailState: this.#states.get(account) ?? null,
      want: { mailboxes: false, emails: false },
      running: null,
      failures: 0,
      lastFailure: 0,
      initial: true,
    };
    this.#live.set(account, live);
    // The first sync does not wait for the stream: if it hangs, the sync pill would otherwise stay until polling.
    this.#request(live, true, true);
    void this.#push(live);
  }

  #stop(account: string): void {
    const live = this.#live.get(account);
    if (!live) return;
    this.#live.delete(account);
    if (live.emailState !== null) this.#states.set(account, live.emailState);
    live.stop.abort();
    live.push?.abort();
    if (live.timer) clearTimeout(live.timer);
  }

  async #push(live: AccountLive): Promise<void> {
    live.mode = 'push';
    live.failures = 0;
    const ctl = new AbortController();
    live.push = ctl;
    try {
      live.accountId ??= await this.#api.accountId(live.account, ctl.signal);
      if (ctl.signal.aborted) return;
      await this.#api.events(live.account, {
        signal: ctl.signal,
        types: LIVE_TYPES,
        onOpen: () => this.#request(live, true, true),
        onState: (change) => {
          live.failures = 0;
          const states = live.accountId ? change.changed[live.accountId] : undefined;
          if (!states) return;
          this.#request(live, 'Mailbox' in states, 'Email' in states && states.Email !== live.emailState);
        },
        onError: () => this.#failed(live, ctl),
      });
    } catch (error) {
      if (ctl.signal.aborted) return;
      // Without push at the server it stays with polling; everything else (token, network) tries push again later.
      if (isJmapError(error, 'unsupported') || isJmapError(error, 'foreignOrigin')) live.pushable = false;
      this.#poll(live);
    }
  }

  /** Stream errors: if they pile up, it switches to polling. */
  #failed(live: AccountLive, ctl: AbortController): void {
    const now = Date.now();
    if (now - live.lastFailure > FAILURE_WINDOW) live.failures = 0;
    live.failures++;
    live.lastFailure = now;
    if (live.failures < PUSH_FAILURES || ctl.signal.aborted) return;
    ctl.abort();
    this.#poll(live);
  }

  #poll(live: AccountLive): void {
    if (live.stop.signal.aborted) return;
    live.mode = 'poll';
    live.push = null;
    live.pollSince = Date.now();
    const tick = () => {
      live.timer = null;
      if (live.stop.signal.aborted) return;
      if (live.pushable && Date.now() - live.pollSince >= PUSH_RETRY) {
        void this.#push(live);
        return;
      }
      this.#request(live, true, true);
      live.timer = setTimeout(tick, POLL_INTERVAL);
    };
    tick();
  }

  /** Triggers a sync; if one is already running, at most one more follows. */
  #request(live: AccountLive, mailboxes: boolean, emails: boolean): void {
    if (live.stop.signal.aborted) return;
    live.want.mailboxes ||= mailboxes;
    live.want.emails ||= emails;
    live.running ??= this.#work(live);
  }

  async #work(live: AccountLive): Promise<void> {
    while ((live.want.mailboxes || live.want.emails) && !live.stop.signal.aborted) {
      const want = live.want;
      live.want = { mailboxes: false, emails: false };
      // A failed sync repeats on the next state, setup or poll.
      await Promise.all([
        want.mailboxes ? this.#targets.mailboxes(live.account).catch(() => {}) : null,
        want.emails ? this.#emails(live).catch(() => {}) : null,
      ]);
    }
    // In the same step as the last check: a trigger after it starts a new run.
    live.running = null;
    if (live.initial) {
      live.initial = false;
      this.#pill();
    }
  }

  async #emails(live: AccountLive): Promise<void> {
    const { account } = live;
    // Signed out or account removed: even a sync in the middle of its steps sends nothing more.
    const { signal } = live.stop;
    if (live.emailState === null) live.emailState = await this.#api.emailState(account, signal);
    else {
      const res = await this.#api.emailChanges(account, live.emailState, signal);
      if (signal.aborted) return;
      if (res.reset) {
        live.emailState = await this.#api.emailState(account, signal);
        if (signal.aborted) return;
        await this.#targets.emails({ account, reset: true, threads: NONE, destroyed: NONE });
      } else {
        live.emailState = res.state;
        if (res.threads.size || res.destroyed.size)
          await this.#targets.emails({
            account,
            reset: false,
            threads: res.threads,
            destroyed: res.destroyed,
            state: res.state,
          });
      }
    }
    if (!signal.aborted) await this.#targets.reached?.(account);
  }

  /** Sync pill: on while a first sync runs, at least `PILL_MIN`. */
  #pill(): void {
    const busy = [...this.#live.values()].some((l) => l.initial);
    if (this.#pillTimer) clearTimeout(this.#pillTimer);
    this.#pillTimer = null;
    if (busy) {
      if (!this.syncing) this.#pillAt = Date.now();
      this.syncing = true;
      return;
    }
    if (!this.syncing) return;
    this.#pillTimer = setTimeout(
      () => {
        this.#pillTimer = null;
        this.syncing = false;
      },
      Math.max(0, this.#pillAt + PILL_MIN - Date.now()),
    );
  }
}

export const live = new LiveSync();
