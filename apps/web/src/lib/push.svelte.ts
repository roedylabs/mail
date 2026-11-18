/**
 * State module `push`: push notifications on this device, the states of the
 * push dialog (`ask|busy|denied|none|ios|active`) and the service worker.
 *
 * - **Turning on** (`request`): `Notification.requestPermission()` →
 *   `GET push/vapid-public-key` → `pushManager.subscribe` →
 *   `POST push/subscriptions` → `nCh.push` on.
 * - **Active** means: the browser has permission and the push channel is on,
 *   unless this device could not be registered (`missing`).
 * - **Silent registration** (`resume` at start and after every sign-in,
 *   `refresh` on opening Settings › Notifications): subscriptions end with
 *   the session, so a browser with permission and subscription registers
 *   again. With the channel on (for example turned on on another device) a
 *   browser without subscription subscribes, without a toast. If the key no
 *   longer matches (new instance), a new subscription is created. If that
 *   fails (or the browser wants a gesture for it), this device counts as
 *   off (`missing`) until `request` subscribes it.
 * - **Turning off** (`off`): `DELETE push/subscriptions/:id`, then
 *   `unsubscribe()`, then `nCh.push` off – for all devices of the account.
 *   The other browsers keep their subscriptions and register again
 *   silently once the channel is turned on again.
 * - **Test** (`test`): `POST push/test`; 409 `no_subscription` registers the
 *   browser again and tries once more.
 */
import { api, isApiError } from '#lib/api.ts';
import { appWorker } from '#lib/app-worker.ts';
import { failText } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import { browserSubscription } from '#lib/push-keys.ts';
import { BELL_MESSAGE, MAIL_MESSAGE, OPEN_MESSAGE, safePath } from '#lib/push-message.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** States of the push dialog. */
export type PushStatus = 'ask' | 'busy' | 'denied' | 'none' | 'ios' | 'active';

/** Support in the browser: yes, not at all, or iPhone/iPad without the home screen. */
export type PushSupport = 'yes' | 'none' | 'ios';

/** Entry from `GET/POST push/subscriptions`. */
export interface PushSubscriptionEntry {
  id: string;
  endpoint: string;
  device: string;
  created_at: string;
  expires_at: string | null;
  current: boolean;
}

/** What the app needs from the browser; replaceable in tests. */
export interface PushEnv {
  support(): PushSupport;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Registration of the service worker (registers it on the first call). */
  registration(): Promise<ServiceWorkerRegistration>;
}

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

/**
 * Support for web push: service worker, `PushManager` and `Notification`.
 * On iPhone and iPad push exists only as an app on the home screen
 * (`navigator.standalone === false` in the browser).
 */
export function pushSupport(win: Window & typeof globalThis): PushSupport {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const supported = 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;
  if (supported && nav.standalone !== false) return 'yes';
  return isAppleMobile(nav) ? 'ios' : supported ? 'yes' : 'none';
}

const browserEnv: PushEnv = {
  support: () => (typeof window === 'undefined' ? 'none' : pushSupport(window)),
  permission: () => (typeof Notification === 'undefined' ? 'default' : Notification.permission),
  requestPermission: () => Notification.requestPermission(),
  registration: appWorker,
};

export class Push {
  env: PushEnv = browserEnv;
  support = $state<PushSupport>('none');
  permission = $state<NotificationPermission>('default');
  busy = $state(false);
  /** Subscription of this browser as the backend knows it for this session. */
  current = $state<PushSubscriptionEntry | null>(null);

  /**
   * Permission and channel on, but this device has no subscription for this
   * session: the silent registration failed. The channel then shows as off
   * on this device.
   */
  missing = $state(false);

  status: PushStatus = $derived.by(() => {
    if (this.busy) return 'busy';
    if (this.support !== 'yes') return this.support;
    if (this.permission === 'denied') return 'denied';
    return this.permission === 'granted' && prefs.values.nCh.push && !this.missing ? 'active' : 'ask';
  });

  /** Counts `reset()`; responses from an earlier session expire. */
  #generation = 0;

  /** Running silent registration; turning off waits for it so that it cannot subscribe again afterwards. */
  #silentRun: Promise<void> = Promise.resolve();

  /** Re-read support and permission (without the server). */
  readEnv(): void {
    this.support = this.env.support();
    this.permission = this.support === 'yes' ? this.env.permission() : 'default';
  }

  /**
   * Notifications page opened: registers silently (`#silent`, 200 for known
   * endpoints). A POST instead of `GET push/subscriptions`, so that a
   * concurrent registration from `resume()` is not overtaken by an older
   * list. Without permission no service worker is registered.
   */
  async refresh(): Promise<void> {
    this.readEnv();
    if (this.permission !== 'granted') {
      this.current = null;
      this.missing = false;
      return;
    }
    await this.#silent();
  }

  /** After a start with a session and after every sign-in (with loaded settings): registers silently (`#silent`). */
  async resume(): Promise<void> {
    this.readEnv();
    if (this.permission === 'granted') await this.#silent();
  }

  /** "Grant permission" or turning on the push channel. */
  async request(): Promise<void> {
    if (this.busy) return;
    this.readEnv();
    if (this.support !== 'yes') return;
    const generation = this.#generation;
    this.busy = true;
    try {
      const permission = this.permission === 'granted' ? 'granted' : await this.env.requestPermission();
      if (generation !== this.#generation) return;
      this.permission = permission;
      if (permission === 'granted') {
        await this.#subscribe();
        if (generation !== this.#generation) return;
        this.missing = false;
        if (!prefs.values.nCh.push) prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
        ui.toasts.show(m.push_toast_active());
      } else if (permission === 'default') {
        ui.toasts.show(m.push_toast_no_decision());
      }
    } catch (error) {
      if (generation === this.#generation) ui.toasts.error(failText(error));
    } finally {
      if (generation === this.#generation) this.busy = false;
    }
  }

  /** "Check again" for `denied`. */
  retry(): void {
    this.readEnv();
    ui.toasts.show(m.push_toast_rechecked());
  }

  /** "Send test". */
  async test(): Promise<void> {
    try {
      try {
        await api('POST', 'push/test');
      } catch (error) {
        // The subscription ended with an earlier session: register again, then once more.
        if (!isApiError(error, 409, 'no_subscription')) throw error;
        await this.#subscribe();
        await api('POST', 'push/test');
      }
      ui.toasts.show(m.push_toast_test());
    } catch (error) {
      ui.toasts.error(failText(error));
    }
  }

  /** "Turn off on this device": delete this browser's subscription and turn off the channel (for all devices). */
  async off(): Promise<void> {
    const generation = this.#generation;
    try {
      await this.#silentRun;
      const current = this.current;
      if (current) {
        try {
          await api('DELETE', `push/subscriptions/${encodeURIComponent(current.id)}`);
        } catch (error) {
          if (!isApiError(error, 404)) throw error;
        }
      }
      const subscription = await this.#subscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
      if (generation !== this.#generation) return;
      this.current = null;
      this.missing = false;
      if (prefs.values.nCh.push) prefs.set({ nCh: { ...prefs.values.nCh, push: false } });
      ui.toasts.show(m.push_toast_off());
    } catch (error) {
      if (generation === this.#generation) ui.toasts.error(failText(error));
    }
  }

  /** Signed out: discard the account state (the browser's subscription stays for `resume`). */
  reset(): void {
    this.#generation++;
    this.busy = false;
    this.current = null;
    this.missing = false;
  }

  /**
   * Registers this browser for the session without a toast: an existing
   * subscription again, with the channel on also a new one. If that fails
   * and the browser has no registration for this session, this device
   * counts as off (`missing`); errors stay silent.
   */
  #silent(): Promise<void> {
    const run = this.#silentRun.then(() => this.#silentOnce());
    this.#silentRun = run;
    return run;
  }

  async #silentOnce(): Promise<void> {
    const generation = this.#generation;
    try {
      const existing = await this.#subscription();
      if (generation !== this.#generation) return;
      if (!existing && !(prefs.loaded && prefs.values.nCh.push)) {
        this.current = null;
        this.missing = false;
        return;
      }
      await this.#subscribe();
      if (generation === this.#generation) this.missing = false;
    } catch {
      // Without registration no push arrives; the page offers to turn push on again.
      if (generation !== this.#generation) return;
      // A new key replaces the subscription: if the old one is already gone, the entry of this session no longer counts.
      const still = await this.#subscription().catch(() => null);
      if (generation !== this.#generation) return;
      if (!still) this.current = null;
      if (this.current === null) this.missing = true;
    }
  }

  /** Subscription of the browser; `null` without support or service worker. */
  async #subscription(): Promise<PushSubscription | null> {
    if (this.support !== 'yes') return null;
    const registration = await this.env.registration();
    return registration.pushManager.getSubscription();
  }

  /** Registers the browser (existing subscription, otherwise a new one) and remembers the entry. */
  async #subscribe(): Promise<void> {
    const generation = this.#generation;
    const registration = await this.env.registration();
    const { key } = await api<{ key: string }>('GET', 'push/vapid-public-key');
    const subscription = await browserSubscription(registration.pushManager, key);
    const entry = await api<PushSubscriptionEntry>('POST', 'push/subscriptions', subscription.toJSON());
    if (generation === this.#generation) this.current = entry;
  }
}

export const push = new Push();

/**
 * Messages of the service worker to this window, also from registrations
 * that do not control it. Returns the function for unsubscribing.
 */
export function onWorkerMessage(handler: (data: Record<string, unknown>) => void): () => void {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!container) return () => {};
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data && typeof data === 'object') handler(data as Record<string, unknown>);
  };
  container.addEventListener('message', onMessage);
  return () => container.removeEventListener('message', onMessage);
}

/** Click on a notification with the window open: the service worker sends the path, the app opens it via its router. */
export function listenForPushClicks(open: (path: string) => void): () => void {
  return onWorkerMessage(({ type, url }) => {
    if (type === OPEN_MESSAGE) open(safePath(url));
  });
}

/** A push arrived while the app is open: bell and list do not wait for their next fetch. */
export function listenForPushNews(bell: () => void, mail: (accountId: string) => void): () => void {
  return onWorkerMessage(({ type, accountId }) => {
    if (type === BELL_MESSAGE) bell();
    else if (type === MAIL_MESSAGE && typeof accountId === 'string') mail(accountId);
  });
}
