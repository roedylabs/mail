/**
 * Confirm email address page (`/confirm-email/[token]`) against
 * `auth/email/check` and `auth/email/confirm`: on load the page only queries
 * the state; the address is only taken over via the button, so that link
 * scanners confirm nothing when opening it. `own_session` picks the variant: if
 * the session belongs to the owner, the button leads to the app or the profile,
 * otherwise to sign-in.
 */
import { api, isApiError, retryAfter } from '#lib/api.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { ERRS, failText, isOffline } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { clockText, waitText } from '#lib/wait.ts';

/** `state` of the responses; `confirmed` only from `confirm`. */
export type LinkState = 'valid' | 'confirmed' | 'already_confirmed' | 'invalid';

interface LinkResponse {
  state: LinkState;
  /** New address, only for a valid or already confirmed link. */
  email?: string;
  own_session: boolean;
}

export type FlowStatus = 'loading' | 'ready' | 'failed';

/** Check failed (`ecCheckErr`): server error, no connection or 429. */
export type CheckFailure = '500' | 'offline' | '429';

export class EmailConfirmFlow {
  status = $state<FlowStatus>('loading');
  /** Reason if the check of the link failed (`ecFail` in the card). */
  failure = $state<CheckFailure>('500');
  /** "Try again" is running ("Checking …"). */
  checking = $state(false);
  /**
   * Lock of "Try again" after 429 (too many unknown links per IP);
   * afterwards the page checks again by itself, otherwise the card would name
   * an expired wait time.
   */
  readonly lock = new Countdown<'check'>(() => void this.load());
  /** State of the link; `null` while the check is running. */
  link = $state<LinkState | null>(null);
  email = $state('');
  /** The session belongs to the owner of the link. */
  own = $state(false);
  busy = $state(false);
  #token = '';
  #seq = 0;

  /** New link: query the state. */
  open(token: string): Promise<void> {
    this.#token = token;
    this.status = 'loading';
    this.link = null;
    this.email = '';
    return this.load();
  }

  /** `check` (also "Try again" of the card); changes nothing on the account. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    if (this.status === 'failed') this.checking = true;
    try {
      const res = await api<LinkResponse>('POST', 'auth/email/check', { token: this.#token });
      if (seq !== this.#seq) return;
      this.#apply(res);
      this.status = 'ready';
    } catch (error) {
      if (seq !== this.#seq) return;
      if (isApiError(error, 429)) {
        this.failure = '429';
        this.lock.start('check', retryAfter(error, 300));
      } else {
        this.failure = isOffline(error) ? 'offline' : '500';
      }
      this.status = 'failed';
    } finally {
      if (seq === this.#seq) this.checking = false;
    }
  }

  /** "Try again" of the card: not during a check or a lock (429). */
  retry(): void {
    if (!this.checking && !this.lock.active('check')) void this.load();
  }

  /** Leaving the page: stop the clock of the lock. */
  dispose(): void {
    this.lock.stop();
  }

  /** "Confirm email address" (`ecConfirm`). */
  async confirm(): Promise<void> {
    if (this.link !== 'valid' || this.busy) return;
    const seq = this.#seq;
    this.busy = true;
    try {
      const res = await api<LinkResponse>('POST', 'auth/email/confirm', { token: this.#token });
      if (seq !== this.#seq) return;
      this.#apply(res);
      // The own session now knows the new address (account menu, profile).
      if (res.state === 'confirmed' && res.own_session) void session.refreshUser().catch(() => {});
    } catch (error) {
      // Error toast; the button stays.
      if (seq === this.#seq) ui.toasts.error(failText(error));
    } finally {
      this.busy = false;
    }
  }

  #apply(res: LinkResponse): void {
    this.link = res.state;
    this.email = res.email ?? '';
    this.own = res.own_session;
  }
}

// Values of the page

export interface EmailConfirmValues {
  /** Link valid: before or after the confirmation. */
  ecValid: boolean;
  ecAlready: boolean;
  ecExpired: boolean;
  ecEmail: string;
  /** Signed in as the owner: button to the app or the profile. */
  ecAuthed: boolean;
  ecGuest: boolean;
  ecBtn: string;
  /** Illustration allowed (branding `loginArt`), from 1000 px width. */
  loginArt: boolean;
  themeDark: boolean;
  /** Theme button (`tgDark`; guests only in the browser). */
  tgDark: { on: boolean; onClick: () => void };
  ecConfirm: () => void;
  ecGo: () => void;
  // Local state of the page
  ecAsk: boolean;
  ecOk: boolean;
  ecDoConfirm: () => void;
  /** Confirmation is running. */
  ecBusy: boolean;
}

export interface EmailConfirmContext {
  dark: boolean;
  toggleDark: () => void;
  /** Target of the button: sign-in, profile or the app (`/`, the layout redirects). */
  go: (to: '/login' | '/account/profile' | '/') => void;
}

export function emailConfirmValues(flow: EmailConfirmFlow, ctx: EmailConfirmContext): EmailConfirmValues {
  const authed = flow.own && session.authed;
  const bad = flow.link === 'invalid';
  const confirm = () => void flow.confirm();
  return {
    ecValid: flow.link === 'valid' || flow.link === 'confirmed',
    ecAlready: flow.link === 'already_confirmed',
    ecExpired: bad,
    ecEmail: flow.email,
    ecAuthed: authed,
    ecGuest: !authed,
    ecBtn: !authed ? m.ec_to_login() : bad ? m.ec_to_profile() : m.ec_to_app({ app: session.appName }),
    loginArt: session.branding.loginArt,
    themeDark: ctx.dark,
    tgDark: { on: ctx.dark, onClick: ctx.toggleDark },
    ecConfirm: confirm,
    ecGo: () => ctx.go(!authed ? '/login' : bad ? '/account/profile' : '/'),
    ecAsk: flow.link === 'valid',
    ecOk: flow.link === 'confirmed',
    ecDoConfirm: confirm,
    ecBusy: flow.busy,
  };
}

/** Card "Check failed" (`ecFail`). */
export interface CheckFailValues {
  icon: IconName;
  title: string;
  text: string;
  retryIcon: IconName;
  retryLabel: string;
  /** Locked after 429 (faded button with a clock). */
  locked: boolean;
  disabled: boolean;
}

export function checkFailValues(flow: EmailConfirmFlow): CheckFailValues {
  const left = flow.lock.left('check');
  const limited = flow.failure === '429';
  const page = flow.failure === '429' ? null : ERRS[flow.failure];
  return {
    icon: limited ? 'ti-hourglass' : (page?.icon ?? 'ti-alert-triangle'),
    title: page ? page.title() : m.ec_limit_title(),
    text: page ? page.text() : m.ec_limit_text({ wait: waitText(left || 1) }),
    retryIcon: flow.checking ? 'ti-loader-2' : left ? 'ti-lock' : 'ti-refresh',
    retryLabel: flow.checking ? m.ec_checking() : left ? m.ec_retry_in({ clock: clockText(left) }) : m.error_retry(),
    locked: left > 0,
    disabled: flow.checking || left > 0,
  };
}
