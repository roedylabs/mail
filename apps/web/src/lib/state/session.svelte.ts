/**
 * State module `session`: public configuration (app name,
 * branding, maintenance, setup) and the signed-in app account. Loads
 * `GET public/config` at start, then `GET auth/me`. Open
 * pages catch up on banner and maintenance mode (`watchConfig`).
 */
import { DEFAULT_ACCENT, PLATES, type AccentName } from '@roedy/tokens';
import { ApiError, api, type ApiOptions } from '#lib/api.ts';
import { applyCacheVersion } from '#lib/client-cache.ts';
import { legalLinksOf } from '#lib/links.ts';
import { mkLogo } from '#lib/logo.ts';
import { mailStores, type MailStore } from '#lib/mail-store.ts';
import { m } from '#lib/paraglide/messages.js';
import { readStartCopy, type StartCopy } from '#lib/start-copy.ts';
import { pollVisible } from '#lib/state/network.svelte.ts';

export type PlateName = keyof typeof PLATES;

/** `branding` from `public/config`: fields of `BRAND0` in the spelling of the admin API. */
export interface Branding {
  kind: string;
  letter: string;
  icon: string;
  image: string | null;
  fit: string;
  plate: PlateName;
  tilt: boolean;
  color: AccentName;
  userAccent: boolean;
  loginTitle: string;
  loginText: string;
  loginArt: boolean;
}

/** Organisation (`ORG_FIELDS`); `null` means "not specified". */
export interface Org {
  name: string | null;
  website: string | null;
  help: string | null;
  email: string | null;
  imprint: string | null;
  privacy: string | null;
  terms: string | null;
  source: string | null;
}

/** Content of the banner (`ANN0`); empty texts mean "not specified". */
export interface BannerContent {
  title: string;
  text: string;
  link: string;
  linkLabel: string;
  tone: string;
  icon: string;
  closable: boolean;
}

/** Own banner from `public/config` while it is on; `revision` for `bannerDismissedRev`. */
export interface PublicBanner extends BannerContent {
  revision: number;
}

/** Update status from `public/config`; `null` means: show nothing. */
export interface PublicUpdate {
  available: boolean;
  latest: string;
}

export interface PublicConfig {
  name: string;
  branding: Branding;
  org: Org;
  banner: PublicBanner | null;
  maintenance: { on: boolean; message: string | null };
  version: string;
  update: PublicUpdate | null;
  setup_required: boolean;
  /** Version of the browsers' cache. */
  client_cache_version: number;
}

/** What open pages reload from `public/config`. */
type LiveConfig = Pick<PublicConfig, 'banner' | 'maintenance'>;

/** Response of `GET auth/me`. */
export interface Me {
  id: string;
  username: string | null;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  mfa_enabled: boolean;
  password_changed_at: string;
  email_change: { email: string; expires_at: string } | null;
  system_mail_configured?: boolean;
  /** Only active administrator (`soleAdm`): locks General › Delete account; `false` for users. */
  sole_admin: boolean;
}

/** Default until the first response (`BRAND0`, like the backend). */
export const BRAND0: Branding = {
  kind: 'standard',
  letter: '',
  icon: 'ti-mountain',
  image: null,
  fit: 'padded',
  plate: 'accent',
  tilt: true,
  color: DEFAULT_ACCENT,
  userAccent: true,
  loginTitle: 'Welcome back',
  loginText: 'Sign in with your account.',
  loginArt: true,
};

/**
 * Heading and text of the sign-in page: the branding's own, otherwise the
 * default in the UI language. The backend returns the
 * default in English (`BRAND0`); if the value equals it, the translation applies.
 */
export function loginTitleOf(branding: Pick<Branding, 'loginTitle'>): string {
  const title = branding.loginTitle.trim();
  return !title || title === BRAND0.loginTitle ? m.branding_login_title_ph() : title;
}

export function loginTextOf(branding: Pick<Branding, 'loginText'>): string {
  return branding.loginText.trim() === BRAND0.loginText ? m.branding_login_text_ph() : branding.loginText;
}

/** Initials: first and last word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '?';
  const last = words.length > 1 ? (words.at(-1) ?? '') : '';
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/** Interval at which visible pages reload `public/config` (like the bell). */
export const CONFIG_POLL_MS = 60_000;
/**
 * Time limit of the reload: a hanging fetch would otherwise hold up every further
 * one, because it is shared, and `refreshUser` waits for it.
 */
export const CONFIG_TIMEOUT_MS = 10_000;
/** With a copy (`#lib/start-copy.ts`) the start waits only this long for the server on a bad network. */
export const START_TIMEOUT_MS = 5000;

/** `BroadcastChannel` between the tabs: sign-in and sign-out. */
export const TAB_CHANNEL = 'roedy-mail-session';

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';

export class Session {
  config = $state<PublicConfig | null>(null);
  user = $state<Me | null>(null);
  status = $state<SessionStatus>('idle');
  /** Loading failed (`status` `error`): "offline" without a server response, otherwise "500". */
  failure = $state<'offline' | '500' | null>(null);
  /** Started from the copy, the server has not answered yet. */
  fromCopy = $state(false);

  appName = $derived(this.config?.name || m.app_name());
  branding = $derived(this.config?.branding ?? BRAND0);
  logo = $derived(mkLogo(this.branding, this.appName));
  /** Privacy policy and imprint of the organisation for the footers of sign-in, invitation and "Confirm email". */
  legal = $derived(legalLinksOf(this.config?.org));
  authed = $derived(this.user !== null);
  isAdmin = $derived(this.user?.role === 'admin');
  setupRequired = $derived(this.config?.setup_required ?? false);
  userName = $derived(this.user?.display_name ?? '');
  initials = $derived(initialsOf(this.userName));

  /** State last read from the server, see `refreshConfig`. */
  #served: LiveConfig | null = null;
  #refreshing: Promise<void> | null = null;

  /**
   * Loads configuration and account. Without an administrator (`setup_required`) it does
   * not query `auth/me`; 401 means "not signed in". The setup calls
   * it again after finishing. Without a server response the
   * copy applies, if there is one: `restore` takes over its rest before the pages
   * appear, otherwise they would try to load themselves.
   */
  async load(restore?: (copy: StartCopy) => void, signal?: AbortSignal): Promise<void> {
    // Reloading (after the setup or "Try again" on the error page)
    // leaves the page in place until the response is there.
    if (this.status === 'idle') this.status = 'loading';
    const copy = readStartCopy();
    const start = copy ? AbortSignal.timeout(START_TIMEOUT_MS) : undefined;
    // `signal` ends the requests early (the setup's "No connection" attempts); without an answer it counts as offline.
    const both = signal && start ? AbortSignal.any([signal, start]) : (signal ?? start);
    const options: ApiOptions = both ? { signal: both } : {};
    try {
      const config = await api<PublicConfig>('GET', 'public/config', undefined, options);
      // As in `refreshUser`: only the most recent query takes over the account.
      const seq = ++this.#meSeq;
      const user = config.setup_required ? null : await this.fetchMe(options);
      // Both at once, otherwise the layout would redirect in between after half the state on reload.
      this.config = config;
      // Own object: writing via `config` would otherwise change this state too.
      this.#served = { banner: config.banner, maintenance: config.maintenance };
      if (seq === this.#meSeq) this.#settle(user);
      this.status = 'ready';
      this.failure = null;
      this.fromCopy = false;
      void applyCacheVersion(config.client_cache_version);
    } catch (error) {
      // If the app already runs from the copy, it stays until the server answers properly.
      if (this.fromCopy) return;
      if (copy && !(error instanceof ApiError)) {
        this.#start(copy, restore);
        return;
      }
      this.failure = error instanceof ApiError ? '500' : 'offline';
      this.status = 'error';
    }
  }

  /** Storage for mailboxes and lists of the signed-in user. */
  get mailStore(): MailStore | null {
    return this.user ? mailStores.of(this.user.id) : null;
  }

  #start(copy: StartCopy, restore?: (copy: StartCopy) => void): void {
    restore?.(copy);
    this.config = copy.config;
    this.#served = { banner: copy.config.banner, maintenance: copy.config.maintenance };
    this.user = copy.user;
    this.fromCopy = true;
    this.status = 'ready';
    this.failure = null;
  }

  /** Takes over the organisation after saving under Administration › Organisation: About and footers follow immediately. */
  setOrg(org: Org): void {
    if (this.config) this.config.org = org;
  }

  /** Banner after switching on, off or saving under Administration › Banner: the notice bar follows immediately. */
  setBanner(banner: PublicBanner | null): void {
    if (this.config) this.config.banner = banner;
  }

  /** App name and branding after saving under Administration › Branding: logo, colors and sign-in page follow immediately. */
  setBranding(name: string, branding: Branding): void {
    if (!this.config) return;
    this.config.name = name;
    this.config.branding = branding;
  }

  /** Update status after every response under Administration › Updates: About follows immediately. */
  setUpdate(update: PublicUpdate | null): void {
    if (this.config) this.config.update = update;
  }

  /** Maintenance mode after every response under Administration › Maintenance: the notice bar follows immediately. */
  setMaintenance({ on, message }: PublicConfig['maintenance']): void {
    if (this.config) this.config.maintenance = { on, message: on ? message : null };
  }

  /**
   * 503 `maintenance` of a request: maintenance is running, even if
   * `public/config` has not reported it yet. This counts as read
   * state, so that the next fetch notices its end.
   */
  noteMaintenance(message: string | null): void {
    const maintenance = { on: true, message };
    if (this.#served) this.#served = { ...this.#served, maintenance };
    this.setMaintenance(maintenance);
  }

  /**
   * Reloads banner and maintenance mode; a running fetch is
   * shared. Only what has changed at the server since the last read is
   * taken over: own changes are already in the session and may
   * differ from the server until saved (toast with undo). Without a
   * response the last state stays.
   */
  refreshConfig(): Promise<void> {
    this.#refreshing ??= this.#fetchConfig().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #fetchConfig(): Promise<void> {
    if (!this.#served) return;
    try {
      const {
        banner,
        maintenance,
        client_cache_version: cacheVersion,
      } = await api<PublicConfig>('GET', 'public/config', undefined, {
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
      });
      void applyCacheVersion(cacheVersion);
      const before = this.#served;
      this.#served = { banner, maintenance };
      if (!same(banner, before.banner)) this.setBanner(banner);
      if (!same(maintenance, before.maintenance)) this.setMaintenance(maintenance);
    } catch {
      // The next fetch tries again.
    }
  }

  /**
   * `refreshConfig` every `CONFIG_POLL_MS` while the page is visible, on
   * returning to the tab and after an offline phase, also without
   * sign-in: this way the sign-in page shows start and end of maintenance. Returns
   * the cleanup.
   */
  watchConfig(target: Window = window): () => void {
    return pollVisible(
      target,
      CONFIG_POLL_MS,
      () => target.document.visibilityState === 'visible',
      () => void this.refreshConfig(),
    );
  }

  /**
   * Reloads `auth/me`, e.g. after sign-in. If the session ended
   * from outside (e.g. with maintenance mode), the configuration comes first:
   * the sign-in page then shows the notice immediately.
   */
  async refreshUser(): Promise<void> {
    // Only the most recent query counts: an older response (e.g. "signed out" from before sign-in) would otherwise discard the new session.
    const seq = ++this.#meSeq;
    const user = await this.fetchMe();
    if (seq !== this.#meSeq) return;
    if (!user && this.user) await this.refreshConfig();
    if (seq !== this.#meSeq) return;
    this.#settle(user);
  }

  #meSeq = 0;
  #ended: ((next: Me | null) => void) | null = null;
  /** `onEnd` is running: then this tab announces nothing; the others find out themselves or already know. */
  #ending = false;
  /** Channel of `watchTabs`; when sending over it, this tab does not receive its own announcement. */
  #channel: BroadcastChannel | null = null;

  /**
   * Callback when the server reports no account or a different one instead of the signed-in
   * account: the session ended without signing out in this tab (expiry,
   * sign-out in another tab, ended by the administration) or another
   * tab signed in a different account. Runs before `next` applies;
   * `account.ts` discards the account's state there.
   */
  onEnd(handler: (next: Me | null) => void): void {
    this.#ended = handler;
  }

  #settle(user: Me | null): void {
    const before = this.user?.id;
    if (before === undefined || before === user?.id) {
      this.user = user;
      return;
    }
    this.#ending = true;
    try {
      this.#ended?.(user);
    } finally {
      // Even if discarding fails, the server's state applies.
      this.#ending = false;
      this.user = user;
    }
  }

  /** Tells the other tabs of this browser which account is signed in now. */
  announce(): void {
    if (this.#ending || typeof BroadcastChannel === 'undefined') return;
    const own = this.#channel;
    const channel = own ?? new BroadcastChannel(TAB_CHANNEL);
    channel.postMessage(this.user?.id ?? null);
    if (!own) channel.close();
  }

  /**
   * Listens to `announce` of the other tabs: if one names an account other than
   * this tab's, it reloads `auth/me` (then `onEnd` takes effect). The content
   * of the message decides nothing; the server stays authoritative. A tab
   * without sign-in stays as it is (the sign-in loads more than
   * `auth/me`). Returns the cleanup.
   */
  watchTabs(): () => void {
    if (typeof BroadcastChannel === 'undefined') return () => {};
    const channel = new BroadcastChannel(TAB_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.status === 'ready' && this.user && event.data !== this.user.id) void this.refreshUser().catch(() => {});
    };
    this.#channel = channel;
    return () => {
      if (this.#channel === channel) this.#channel = null;
      channel.close();
    };
  }

  private async fetchMe(options: ApiOptions = {}): Promise<Me | null> {
    try {
      return await api<Me>('GET', 'auth/me', undefined, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }
}

export const session = new Session();
