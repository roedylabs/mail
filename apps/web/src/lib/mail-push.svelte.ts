/**
 * State module `mailPush`: JMAP push for new mail, per
 * mail account one service worker registration, one browser subscription
 * with the mail server's key and one `PushSubscription`; the switches live
 * under Settings › Notifications and apply only to this device.
 *
 * - **Turning on** (`enable`): registration, browser subscription, entry at
 *   the mail server; the service worker confirms it as soon as the
 *   `PushVerification` arrives and reports that here.
 * - **After the start** (`resume`): the same applies to every registration
 *   and every remembered selection; a confirmed entry is only renewed, what
 *   is missing is created anew. Registrations of unknown accounts are
 *   dropped. If that fails, the page shows "Expired" (`expired`).
 * - **Turning off** (`disable`): remove the entry at the mail server, the
 *   subscription and the registration; without the mail server the entry expires by itself.
 * - **Push channel off** (`pause`): the same for all accounts, the selection
 *   stays; `restore` turns them on again as soon as the channel is active here.
 * - **Sign-out, "Clear local data":** `withdraw()` while there are
 *   tokens, then `clearDevice()`.
 * - **Copy for the service worker** (`share`): quiet hours and account
 *   addresses as soon as an account has push (`#lib/mail-push-store.ts`).
 *   It names the app user; `resume` and `share` remove the copy of another
 *   user who signed in before in this browser.
 *
 * The device remembers selection and confirmation in local storage.
 * `PushSubscription/get` shows the confirmation from Stalwart v1.1.0 on
 * (`verificationCode` of a confirmed entry, otherwise `null`); up to v1.0.x
 * it is always `null`, so there only the local record tells.
 */
import { dev } from '$app/env';
import { destroyPushSubscriptions } from '@roedy/jmap';
import { localStore } from '#lib/last-page.ts';
import {
  createEntry,
  destroyEntries,
  isExpired,
  mailPushAccount,
  mailPushScope,
  ownEntries,
  renewIfDue,
  serverKey,
  VERIFIED_MESSAGE,
} from '#lib/mail-push-subscription.ts';
import { mailPushStore, type MailPushCopy, type MailPushStore } from '#lib/mail-push-store.ts';
import { browserSubscription } from '#lib/push-keys.ts';
import { onWorkerMessage, push } from '#lib/push.svelte.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/**
 * State of an account on this device: `pending` and `stopping` while
 * switching; `unsupported` if the mail server lacks keys or `emailPush`;
 * `failed` if turning on failed; `expired` if an account that was turned on
 * could no longer be set up at start.
 */
export type MailPushStatus = 'off' | 'pending' | 'stopping' | 'on' | 'unsupported' | 'failed' | 'expired';

/**
 * Key in `localStorage`: one entry per account turned on, also with the
 * channel off (`pause`); the value is the confirmed subscription
 * (`PushSubscription.id`), otherwise `null`.
 */
export const MAIL_PUSH_KEY = 'roedy.mail-push';

/** Longer than Stalwart's lock for the next confirmation (60 s) plus the way via the push service. */
const VERIFY_WAIT = 90_000;
/** This long turning off and signing out wait for the mail server and push service; whatever is missing then expires by itself. */
const SERVER_WAIT = 3_000;

/** What the module needs from the browser; replaceable in tests. */
export interface MailPushEnv {
  /** Push possible and allowed, the channel not turned off. */
  allowed(): boolean;
  /** Does this device have its subscription for the push channel? If it is missing, someone chose "Turn off on this device". */
  subscribed(): Promise<boolean>;
  /** Registration with an active worker; creates it on the first call. */
  register(scope: string): Promise<ServiceWorkerRegistration>;
  /** All registrations of the app, without creating anything. */
  registrations(): Promise<readonly ServiceWorkerRegistration[]>;
  /** Messages of the service worker (`VERIFIED_MESSAGE`); returns the function for unsubscribing. */
  listen(handler: (accountId: string, subscriptionId: string) => void): () => void;
  /** Runs `task` one at a time across all tabs. */
  exclusive<T>(name: string, task: () => Promise<T>): Promise<T>;
  /** Storage that the service worker reads as well. */
  store: MailPushStore;
  /** ID of the signed-in app user, `null` without a session. */
  user(): string | null;
}

/** The scope has no page, hence no `navigator.serviceWorker.ready` either. */
function activated(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Service worker without installation'));
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve(registration);
      else if (worker.state === 'redundant') reject(new Error('Service worker not installed'));
    });
  });
}

const browserEnv: MailPushEnv = {
  // Without loaded settings the channel is unknown; the default would otherwise say "off".
  allowed: () =>
    push.env.support() === 'yes' && push.env.permission() === 'granted' && (!prefs.loaded || prefs.values.nCh.push),
  subscribed: async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return (await registration?.pushManager.getSubscription()) != null;
  },
  register: async (scope) => {
    // In development Vite serves the worker as a module.
    const options: RegistrationOptions = { scope, type: dev ? 'module' : 'classic' };
    return activated(await navigator.serviceWorker.register('/service-worker.js', options));
  },
  registrations: async () => {
    const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    return container ? container.getRegistrations() : [];
  },
  listen: (handler) =>
    onWorkerMessage(({ type, accountId, subscriptionId }) => {
      if (type !== VERIFIED_MESSAGE) return;
      if (typeof accountId === 'string' && typeof subscriptionId === 'string') handler(accountId, subscriptionId);
    }),
  exclusive: (name, task) => {
    // Only available in secure contexts; without it, the protection stays within the tab.
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks ? locks.request(name, task) : task();
  },
  store: mailPushStore,
  user: () => session.user?.id ?? null,
};

function readChoices(): Record<string, string | null> {
  try {
    const value: unknown = JSON.parse(localStore()?.getItem(MAIL_PUSH_KEY) ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/** Locked storage counts like a missing record: up to Stalwart v1.0.x the next start replaces the entry. */
function writeChoices(next: Record<string, string | null>): void {
  try {
    if (Object.keys(next).length > 0) localStore()?.setItem(MAIL_PUSH_KEY, JSON.stringify(next));
    else localStore()?.removeItem(MAIL_PUSH_KEY);
  } catch {
    // Storage full or locked.
  }
}

/** Account stays selected, the confirmed subscription is in `subscriptionId`. */
function markChosen(accountId: string, subscriptionId: string | null): void {
  writeChoices({ ...readChoices(), [accountId]: subscriptionId });
}

function dropChoice(accountId: string): void {
  const next = readChoices();
  delete next[accountId];
  writeChoices(next);
}

/** Limits the waiting time; the work continues in the background. */
function within(work: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, SERVER_WAIT);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Waits for the confirmation of an entry whose ID only the creation names. */
interface Waiter {
  /** Message of the service worker; it can arrive before the response to `create`. */
  seen(subscriptionId: string): void;
  /** Confirmed within `wait`? */
  until(subscriptionId: string, wait: number): Promise<boolean>;
  /** Aborts the waiting (`false`). */
  stop(): void;
  /** Aborted rather than expired? */
  stopped(): boolean;
}

function newWaiter(): Waiter {
  let resolve: (verified: boolean) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expected: string | null = null;
  let stopped = false;
  const early: string[] = [];
  const answer = new Promise<boolean>((done) => {
    resolve = done;
  });
  return {
    seen(subscriptionId) {
      if (subscriptionId === expected) resolve(true);
      else early.push(subscriptionId);
    },
    until(subscriptionId, wait) {
      expected = subscriptionId;
      if (early.includes(subscriptionId)) resolve(true);
      else timer = setTimeout(() => resolve(false), wait);
      return answer;
    },
    stop() {
      clearTimeout(timer);
      stopped = true;
      resolve(false);
    },
    stopped: () => stopped,
  };
}

export class MailPush {
  env: MailPushEnv = browserEnv;
  /** Waiting time for the confirmation; shorter in tests. */
  verifyWait = VERIFY_WAIT;
  status = $state<Record<string, MailPushStatus>>({});

  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #running = new Map<string, Promise<MailPushStatus>>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #waiters = new Map<string, Waiter>();
  #unlisten: (() => void) | null = null;
  /** Counts `reset()`; responses from an earlier session expire. */
  #generation = 0;
  /** Last stored copy; `share` only writes when something changes. */
  #shared: string | null = null;
  /** App user whose copy (or none) is in the store, as far as this tab knows: written or checked here. */
  #owner: string | null = null;
  /** Deleting this tab's copy after the last push account failed: the next `share` tries again. */
  #unclear = false;
  /** Last `pause`; never rejects. */
  #pausing: Promise<void> = Promise.resolve();

  /** State of an account. */
  of(accountId: string): MailPushStatus {
    return this.status[accountId] ?? 'off';
  }

  /** Turns on push for an account; if it fails, nothing remains. */
  async enable(accountId: string): Promise<MailPushStatus> {
    if (!this.env.allowed()) return 'off';
    const generation = this.#generation;
    const expired = this.of(accountId) === 'expired';
    markChosen(accountId, readChoices()[accountId] ?? null);
    this.#set(accountId, 'pending', generation);
    const status = await this.#ensure(accountId);
    // "Expired" stays, and the next start tries again.
    if (status === 'failed' && expired) {
      this.#set(accountId, 'expired', generation);
      return status;
    }
    const failed = status === 'failed' || status === 'unsupported';
    if (failed && generation === this.#generation) await this.#remove(accountId, status, generation);
    return status;
  }

  /** Turns off push for an account; the mail server may be missing. */
  async disable(accountId: string): Promise<void> {
    const generation = this.#generation;
    this.#set(accountId, 'stopping', generation);
    await this.#remove(accountId, 'off', generation);
  }

  /**
   * After a start with a session and loaded settings: check registrations and
   * selection, renew entries, create missing ones anew. Errors stay silent,
   * the next start tries again.
   */
  async resume(): Promise<void> {
    const user = this.env.user();
    if (user !== null) await this.#dropForeign(user);
    this.#listen();
    try {
      const found = await this.#own();
      const registered = found.map((own) => own.accountId);
      const ids = [...registered, ...Object.keys(readChoices()).filter((id) => !registered.includes(id))];
      if (ids.length === 0) return;
      await accounts.ensure();
      // Unclear does not mean off: an error must not tear down subscriptions.
      const subscribed = await this.env.subscribed().catch(() => true);
      await Promise.all(
        ids.map((id) => this.#check(id, subscribed, found.find((own) => own.accountId === id)?.registration)),
      );
    } catch {
      // Without accounts or a service worker there is nothing to check.
    }
  }

  /** Push channel turned off on this device: unsubscribe everything, also what is being set up; the selection stays. */
  pause(): Promise<void> {
    this.#pausing = this.#pauseAll();
    return this.#pausing;
  }

  async #pauseAll(): Promise<void> {
    const generation = this.#generation;
    const registered = (await this.#own().catch(() => [])).map((own) => own.accountId);
    const building = [...this.#running.keys()].filter((id) => !registered.includes(id));
    await Promise.all(
      [...registered, ...building].map(async (accountId) => {
        await this.#teardown(accountId);
        markChosen(accountId, null);
        this.#set(accountId, 'off', generation);
      }),
    );
  }

  /** Push channel active again: whatever is selected and not running turns on. A running `pause` ends first. */
  async restore(): Promise<void> {
    await this.#pausing;
    await accounts.ensure();
    const ids = Object.keys(readChoices()).filter((id) => this.of(id) === 'off');
    await Promise.all(ids.map((id) => this.#check(id, true)));
  }

  /** Page opened: show servers without push without creating anything. Whoever does not respond stays as is. */
  async inspect(ids: readonly string[]): Promise<void> {
    const generation = this.#generation;
    await Promise.all(
      ids.map(async (id) => {
        try {
          const key = await serverKey(await accounts.client(id));
          const status = this.of(id);
          if (status === 'off' || status === 'unsupported') this.#set(id, key ? 'off' : 'unsupported', generation);
        } catch {
          // Signed out or locked: the page shows that from the account.
        }
      }),
    );
  }

  /**
   * Stores the copy for the service worker while an account has push; otherwise no addresses stay behind –
   * neither this user's nor those of another user who signed in before in this browser.
   */
  share(copy: MailPushCopy): void {
    if (!Object.values(this.status).some((status) => status === 'on' || status === 'pending')) {
      if (this.#shared === null && !this.#unclear) {
        void this.#dropForeign(copy.user);
        return;
      }
      this.#shared = null;
      this.#owner = copy.user;
      this.#unclear = false;
      // Not deleted: the next call deletes again, and whatever is stored is unknown again.
      void this.env.store
        .clear()
        .catch(() => false)
        .then((done) => {
          if (done) return;
          this.#owner = null;
          this.#unclear = true;
        });
      return;
    }
    const text = JSON.stringify(copy);
    if (text === this.#shared) return;
    this.#shared = text;
    this.#owner = copy.user;
    // Without a copy no quiet hours apply and the app is named like its host.
    this.env.store.write(copy).then(
      () => {
        // Replaced: a deletion still pending is no longer needed.
        this.#unclear = false;
      },
      () => {
        this.#shared = null;
        // A copy of another user may still be there: the next call checks again.
        this.#owner = null;
      },
    );
  }

  /** Before signing out: remove entries at the mail servers while there are tokens. Errors stay silent. */
  async withdraw(): Promise<void> {
    const found = await this.#own().catch(() => []);
    await Promise.all(found.map(({ accountId, registration }) => this.#destroyEntries(accountId, registration)));
  }

  /** After signing out or deleting: remove subscriptions and registrations of this device. */
  async clearDevice(): Promise<void> {
    const found = await this.#own().catch(() => []);
    await Promise.all(found.map(({ registration }) => this.#dropLocal(registration)));
    try {
      localStore()?.removeItem(MAIL_PUSH_KEY);
    } catch {
      // Locked: nothing saved.
    }
    await this.env.store.clear().catch(() => {});
    this.#shared = null;
    this.#owner = null;
    this.#unclear = false;
    this.status = {};
  }

  /** Signed out: discard the state; registrations stay for the next sign-in. */
  reset(): void {
    this.#generation++;
    this.#unlisten?.();
    this.#unlisten = null;
    for (const waiter of this.#waiters.values()) waiter.stop();
    this.#waiters.clear();
    this.#running.clear();
    this.#shared = null;
    this.#owner = null;
    this.#unclear = false;
    this.status = {};
  }

  /**
   * Removes the copy of another app user (signed in before in this browser, the copy stays for
   * their notices when the session expires): its addresses, quiet hours and app name must not
   * outlive the change of user. A copy this tab writes in the meantime replaces it anyway.
   */
  async #dropForeign(user: string): Promise<void> {
    if (this.#owner === user || this.#shared !== null) return;
    const generation = this.#generation;
    const stored = await this.env.store.read().catch(() => undefined);
    if (stored === undefined || generation !== this.#generation || this.#shared !== null) return;
    // Only once the foreign copy is gone does this user count as checked; otherwise the next
    // `resume`/`share` tries again.
    if (stored !== null && stored.user !== user && !(await this.env.store.clear().catch(() => false))) return;
    if (generation === this.#generation) this.#owner = user;
  }

  /**
   * Once per session; if the service worker confirms without anyone waiting
   * (`pushsubscriptionchange`), that counts too. Accounts deselected in the
   * meantime stay deselected.
   */
  #listen(): void {
    this.#unlisten ??= this.env.listen((accountId, subscriptionId) => {
      if (accountId in readChoices()) markChosen(accountId, subscriptionId);
      this.#waiters.get(accountId)?.seen(subscriptionId);
    });
  }

  /** Registrations of the mail accounts. */
  async #own(): Promise<{ accountId: string; registration: ServiceWorkerRegistration }[]> {
    const registrations = await this.env.registrations();
    return registrations.flatMap((registration) => {
      const accountId = mailPushAccount(registration.scope);
      return accountId === null ? [] : [{ accountId, registration }];
    });
  }

  #set(accountId: string, status: MailPushStatus, generation: number): void {
    if (generation === this.#generation) this.status = { ...this.status, [accountId]: status };
  }

  /** A selected or registered account at start. */
  async #check(accountId: string, subscribed: boolean, registration?: ServiceWorkerRegistration): Promise<void> {
    // Hidden means: undo is still running.
    if (accounts.isHidden(accountId)) return;
    const generation = this.#generation;
    if (!accounts.get(accountId)) {
      dropChoice(accountId);
      if (registration) await this.#dropLocal(registration);
    } else if (subscribed && this.env.allowed()) {
      markChosen(accountId, readChoices()[accountId] ?? null);
      // Under the scope there is no page whose visit updates the worker.
      void registration?.update().catch(() => undefined);
      const status = await this.#ensure(accountId);
      if (status === 'failed') this.#set(accountId, 'expired', generation);
    } else {
      await this.#teardown(accountId);
      markChosen(accountId, null);
      this.#set(accountId, 'off', generation);
    }
  }

  /** Only once per account at a time, also across tabs: the mail server confirms only one per account. */
  #ensure(accountId: string): Promise<MailPushStatus> {
    const running = this.#running.get(accountId);
    if (running) return running;
    const generation = this.#generation;
    const waiter = newWaiter();
    this.#waiters.set(accountId, waiter);
    const task = this.env
      .exclusive(mailPushScope(accountId), () => this.#build(accountId, generation, waiter))
      .catch((): MailPushStatus => 'failed')
      .then((status) => {
        this.#set(accountId, status, generation);
        return status;
      })
      .finally(() => {
        waiter.stop();
        if (this.#waiters.get(accountId) === waiter) this.#waiters.delete(accountId);
        if (this.#running.get(accountId) === task) this.#running.delete(accountId);
      });
    this.#running.set(accountId, task);
    return task;
  }

  async #build(accountId: string, generation: number, waiter: Waiter): Promise<MailPushStatus> {
    if (!this.env.allowed()) return 'off';
    const client = await accounts.client(accountId);
    const key = await serverKey(client);
    if (!key) return 'unsupported';
    this.#set(accountId, 'pending', generation);
    this.#listen();
    const registration = await this.env.register(mailPushScope(accountId));
    const subscription = await browserSubscription(registration.pushManager, key);
    const entries = await ownEntries(client, subscription.endpoint);
    const recorded = readChoices()[accountId];
    // `get` shows expired entries once more, `set` no longer knows them.
    const usable = entries.filter((entry) => !isExpired(entry));
    // Confirmed per record or, from Stalwart v1.1.0 on, per `verificationCode`; up to v1.0.x it is always `null`.
    const current =
      usable.find((entry) => entry.id === recorded) ?? usable.find((entry) => entry.verificationCode !== null);
    if (current) {
      // Accounts deselected in the meantime stay deselected.
      if (current.id !== recorded && accountId in readChoices()) markChosen(accountId, current.id);
      await renewIfDue(client, current);
      return 'on';
    }
    // Neither record nor code: unclear whether the entry was ever confirmed, replace it. Stalwart only confirms the newest.
    await destroyPushSubscriptions(
      client,
      entries.map((entry) => entry.id),
    );
    const id = await createEntry(client, subscription);
    if (await waiter.until(id, this.verifyWait)) return 'on';
    if (generation === this.#generation) await destroyPushSubscriptions(client, [id]).catch(() => {});
    return waiter.stopped() ? 'off' : 'failed';
  }

  /** Stops a running setup, removes the entry at the mail server and everything on this device. */
  async #teardown(accountId: string): Promise<void> {
    // A running setup must not overwrite the result.
    this.#waiters.get(accountId)?.stop();
    await within(this.#running.get(accountId) ?? Promise.resolve());
    const registration = (await this.#own().catch(() => [])).find((own) => own.accountId === accountId)?.registration;
    if (registration) {
      await this.#destroyEntries(accountId, registration);
      await this.#dropLocal(registration);
    }
  }

  /** In addition, the selection is dropped. */
  async #remove(accountId: string, status: MailPushStatus, generation: number): Promise<void> {
    await this.#teardown(accountId);
    dropChoice(accountId);
    this.#set(accountId, status, generation);
  }

  /** Fails silently: without a browser subscription the entry at the mail server expires by itself. */
  async #destroyEntries(accountId: string, registration: ServiceWorkerRegistration): Promise<void> {
    const work = async () => {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await destroyEntries(await accounts.client(accountId), subscription.endpoint);
    };
    await within(work()).catch(() => undefined);
  }

  /** `unsubscribe()` asks the push service; `unregister()` ends the subscription even without it. */
  async #dropLocal(registration: ServiceWorkerRegistration): Promise<void> {
    const work = async () => {
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
    };
    await within(work()).catch(() => undefined);
    await registration.unregister().catch(() => false);
  }
}

export const mailPush = new MailPush();
