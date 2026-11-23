/**
 * Flow of the sign-in page against the login API and "Forgot/reset password":
 * password, code of the authenticator app or recovery code, locks with a
 * countdown, "Reset password" with "Email sent" and "Set a new password" from the
 * link in the mail.
 *
 * The routes `/login`, `/password/forgot` and `/password/reset/[token]` show the
 * same page: `route()` opens the matching step, step changes report the route
 * back (`navigate`). Unexpected responses show "Something went wrong".
 */
import { ApiError, NetworkError, api, fieldsOf, isApiError, maintenanceMessage, retryAfter } from '#lib/api.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { PW_RULES, tooLong, type PasswordRuleId } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { session } from '#lib/state/session.svelte.ts';
import { clockText, waitText } from '#lib/wait.ts';

/** Duration from "Hello, ‹name›" to the start page (progress bar of 2.6 s). */
export const DONE_MS = 2700;
/** Lifetime of the intermediate step for the second factor. */
export const STEP_MS = 5 * 60_000;
/** "Resend" after 30 seconds at the earliest. */
export const RESEND_S = 30;

export type View = 'login' | 'otp' | 'backup' | 'forgot' | 'sent' | 'newpw' | 'pwdone' | 'linkbad';
/** Route of the page: `/login`, `/password/forgot` or `/password/reset/[token]`. */
export type LoginRoute = { kind: 'login' } | { kind: 'forgot' } | { kind: 'newpw'; token: string };
export type Field = 'id' | 'pw' | 'otp' | 'bc' | 'fg' | 'np';
/** Icon of the tile in the background (`PHASE_ICON`); `idle` shows the logo. */
export type Phase =
  | 'idle'
  | 'id'
  | 'pw'
  | 'peek'
  | 'loading'
  | 'error'
  | 'locked'
  | 'success'
  | 'otp'
  | 'backup'
  | 'forgot'
  | 'sent'
  | 'newpw'
  | 'pwdone'
  | 'linkbad';

/** Steps of `/password/forgot` (`FG_VIEWS`) and from the link in the mail (`LINK_VIEWS`). */
const FG_VIEWS: readonly View[] = ['forgot', 'sent'];
const LINK_VIEWS: readonly View[] = ['newpw', 'pwdone', 'linkbad'];

/**
 * Values of the page that are not part of the flow (branding, maintenance,
 * theme button, back button).
 */
export interface LoginPageValues {
  fgAuthed: boolean;
  fgBackLabel: string;
  loginArt: boolean;
  loginMaint: boolean;
  loginText: string;
  loginTitle: string;
  maintMsg: string;
  themeDark: boolean;
}

/** User from the sign-in response (`api::auth::user_json`). */
export interface SignedInUser {
  id: string;
  username: string | null;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
}

/** Rule chip below "New password" (`npRules`). */
export interface NpRule {
  id: PasswordRuleId;
  label: string;
  ok: boolean;
  /** Red after an error. */
  bad: boolean;
}

export interface LoginHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: Field) => void;
  /** New step: focus the field. */
  focus?: (field: Field) => void;
  /** A lock of the step ran out: the field may take the focus again (desktop). */
  unlocked?: (field: Field) => void;
  /** The step belongs to another route (`onFgView`, `onPwNewLeave`). */
  navigate?: (to: 'login' | 'forgot') => void;
  /** "Back to ‹app name›" when signed in on `/password/forgot` (`onFgHome`). */
  home?: () => void;
  /**
   * After "Hello, ‹name›": load settings and account, go to the start page
   * (`onLogin`); `false` if the account is not signed in afterwards.
   */
  signedIn?: () => Promise<boolean>;
  /** A session just created no longer applies (page left, "Back to sign-in"): sign out. */
  signOut?: () => void;
  /** Password changed via the link: all sessions have ended, also one in this browser. */
  passwordReset?: () => void;
  /** Errors without their own text: error toast (`ui.toasts.error`). */
  error?: (text: string) => void;
  /** A request got no answer: "No connection" (everything typed stays); without it an error toast. */
  offline?: () => void;
}

/** Locks of the buttons and the countdown of "Resend". */
type LockKind = 'pw' | 'code' | 'np' | 'fg' | 'resend';

type LoginAnswer = { status: 'ok'; user: SignedInUser } | { status: 'totp_required' };

/** Code of the authenticator app: digits only, at most six. */
export function formatOtp(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}

/** Recovery code: capital letters and digits, `XXXX-XXXX`. */
export function formatRecovery(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export class LoginFlow {
  view = $state<View>('login');
  /** Signed in: "Hello, ‹name›" until the redirect. */
  done = $state(false);
  user = $state<SignedInUser | null>(null);

  // Step password
  ident = $state('');
  pw = $state('');
  remember = $state(true);
  loading = $state(false);
  idErr = $state<string | null>(null);
  pwErr = $state<string | null>(null);
  authErr = $state(false);
  /** 422 `login_expired` in the second step: notice until the next submit. */
  loginExpired = $state(false);
  /** Length of the running sign-in lock in seconds (the lock bar is full at the answer). */
  pwLockTotal = $state(0);
  // Steps code and recovery code
  otp = $state('');
  otpErr = $state<'short' | 'invalid' | 'used' | null>(null);
  otpLoading = $state(false);
  bc = $state('');
  bcErr = $state<'short' | 'invalid' | null>(null);
  bcLoading = $state(false);
  /** Start of the intermediate step (`stepAt`), for the sentence after long locks. */
  stepAt = $state(0);

  // Reset password and email sent
  fgErr = $state<string | null>(null);
  fgLoading = $state(false);
  /** Countdown of "Resend" runs after 429 until `retry_after` (`rsLimit`). */
  rsLimit = $state(false);
  private resending = false;

  // Set a new password
  token = $state('');
  np = $state('');
  npErr = $state<string | null>(null);
  /** Rules named by the server (422 `policy`). */
  npBad = $state<PasswordRuleId[]>([]);
  npLoading = $state(false);
  /** `sessions_ended` of the response. */
  ended = $state(0);

  /** Locks and countdown (the clock only runs while one applies). */
  readonly locks = new Countdown<LockKind>((kind) => this.freed(kind));
  private doneTimer: ReturnType<typeof setTimeout> | undefined;
  /** After "Hello" settings and account are loaded; the page leaves right away. */
  private signingIn = false;
  /** Running request; a step change invalidates its response. */
  private req = 0;

  readonly hooks: LoginHooks;

  constructor(hooks: LoginHooks = {}) {
    this.hooks = hooks;
  }

  // ---- Derived values ----

  private pwLeft = $derived(this.locks.left('pw'));
  private codeLeft = $derived(this.locks.left('code'));
  private npLeft = $derived(this.locks.left('np'));
  private fgLeft = $derived(this.locks.left('fg'));
  private coolLeft = $derived(this.locks.left('resend'));

  pwLocked = $derived(this.pwLeft > 0);
  pwLockText = $derived(this.pwLeft ? m.limit_text({ wait: waitText(this.pwLeft) }) : '');
  /** The lock bar under the password field: seconds left of the lock's length. */
  pwLock = $derived(this.pwLeft ? { left: this.pwLeft, total: Math.max(this.pwLockTotal, this.pwLeft) } : null);

  codeLocked = $derived(this.codeLeft > 0);
  codeLockText = $derived.by(() => {
    if (!this.codeLeft) return '';
    const text = m.limit_text({ wait: waitText(this.codeLeft) });
    // The lock lasts longer than the intermediate step: start over afterwards.
    const after = this.stepAt > 0 && (this.locks.until('code') ?? 0) > this.stepAt + STEP_MS;
    return after ? `${text} ${m.login_code_lock_after()}` : text;
  });
  codeLockBtn = $derived(this.codeLeft ? m.login_confirm_locked({ time: clockText(this.codeLeft) }) : '');
  otpUsed = $derived(this.otpErr === 'used');
  otpReady = $derived(!this.otpLoading && !this.codeLocked);
  otpDis = $derived(this.otpLoading || this.codeLocked);
  bcReady = $derived(!this.bcLoading && !this.codeLocked);
  bcDis = $derived(this.bcLoading || this.codeLocked);

  showNewPw = $derived(this.view === 'newpw');
  showPwDone = $derived(this.view === 'pwdone');
  showLinkBad = $derived(this.view === 'linkbad');
  pwDoneEnded = $derived(this.ended > 0);
  npRules = $derived(
    PW_RULES.map((rule): NpRule => {
      const ok = rule.test(this.np) && !this.npBad.includes(rule.id);
      return { id: rule.id, label: rule.label(), ok, bad: !ok && !!this.npErr };
    }),
  );
  npLocked = $derived(this.npLeft > 0);
  npLockText = $derived(this.npLeft ? m.limit_text({ wait: waitText(this.npLeft) }) : '');
  npLockBtn = $derived(this.npLeft ? m.login_save_locked({ time: clockText(this.npLeft) }) : '');
  npReady = $derived(!this.npLoading && !this.npLocked);
  npDis = $derived(this.npLoading || this.npLocked);

  fgLocked = $derived(this.fgLeft > 0);
  fgLockText = $derived(this.fgLeft ? m.limit_text({ wait: waitText(this.fgLeft) }) : '');
  fgLockBtn = $derived(this.fgLeft ? m.login_send_locked({ time: clockText(this.fgLeft) }) : '');
  fgReady = $derived(!this.fgLoading && !this.fgLocked);
  fgDis = $derived(this.fgLoading || this.fgLocked);

  resendBlocked = $derived(this.coolLeft > 0);
  resendLabel = $derived(
    this.coolLeft > 0 ? m.login_resend_wait({ time: clockText(this.coolLeft) }) : m.login_resend(),
  );
  resendLimited = $derived(this.rsLimit && this.coolLeft > 0);
  resendLimitText = $derived(this.resendLimited ? m.limit_text({ wait: waitText(this.coolLeft) }) : '');

  /**
   * A request is running: changes to another step wait for the
   * response (otherwise it would change something on the server that the page no longer shows).
   */
  busy = $derived(this.loading || this.otpLoading || this.bcLoading || this.fgLoading || this.npLoading);

  /** Identifier in the intermediate step (`otpIdent`, `otpInitial`) and address in "Email sent" (`sentTo`). */
  otpIdent = $derived(this.ident.trim());
  otpInitial = $derived((this.ident.trim()[0] ?? '?').toUpperCase());
  sentTo = $derived(this.ident.trim());

  /**
   * "Hello, ‹name›": first name from the account of the response; without a name, the
   * part of the identifier before the "@".
   */
  greetName = $derived.by(() => {
    const first = this.user?.display_name.trim().split(/\s+/)[0];
    if (first) return first;
    const id = this.ident.trim();
    const local = id.split('@')[0] || id;
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
  });

  /** Icon of the tile like `phase()`; focus and "Show password" come from the page. */
  phase(focus: Field | null, showPw: boolean): Phase {
    const v = this.view;
    if (v === 'sent' || v === 'pwdone' || v === 'linkbad') return v;
    if (v === 'newpw') {
      if (this.npLoading) return 'loading';
      if (this.npLocked) return 'locked';
      if (this.npErr) return 'error';
      return focus === 'np' && showPw ? 'peek' : 'newpw';
    }
    if (v === 'forgot') return this.fgLoading ? 'loading' : this.fgLocked ? 'locked' : 'forgot';
    if (v === 'backup' && !this.done) {
      if (this.bcLoading) return 'loading';
      if (this.codeLocked) return 'locked';
      return this.bcErr === 'invalid' ? 'error' : 'backup';
    }
    if (v === 'otp' && !this.done) {
      if (this.otpLoading) return 'loading';
      if (this.codeLocked) return 'locked';
      return this.otpErr === 'invalid' || this.otpErr === 'used' ? 'error' : 'otp';
    }
    if (this.done) return 'success';
    if (this.loading) return 'loading';
    if (this.pwLocked) return 'locked';
    if (this.authErr && !this.pw) return 'error';
    if (focus === 'pw') return showPw ? 'peek' : 'pw';
    return focus === 'id' ? 'id' : 'idle';
  }

  // ---- Route ----

  /**
   * The route has changed (page opened, back in the browser): open the matching
   * step if it is not open yet.
   */
  route(to: LoginRoute): void {
    // Back in the browser during "Hello": the new session does not apply (like "Back to sign-in").
    if (this.done && !this.leaveDone()) return;
    if (to.kind === 'newpw') {
      if (!LINK_VIEWS.includes(this.view) || to.token !== this.token) this.openNewPw(to.token);
    } else if (to.kind === 'forgot') {
      if (!FG_VIEWS.includes(this.view)) this.openFgDirect();
    } else if (FG_VIEWS.includes(this.view) || LINK_VIEWS.includes(this.view)) {
      this.toLogin();
    }
  }

  // ---- Step password ----

  editIdent(value: string): void {
    this.ident = value;
    this.idErr = null;
  }

  editPw(value: string): void {
    this.pw = value;
    this.pwErr = null;
  }

  toggleRemember(): void {
    this.remember = !this.remember;
  }

  async submit(): Promise<void> {
    if (this.loading || this.pwLocked) return;
    const idErr = this.ident.trim() ? null : m.login_id_required();
    const pwErr = !this.pw ? m.login_pw_required() : tooLong(this.pw) ? m.password_too_long() : null;
    if (idErr || pwErr) {
      this.idErr = idErr;
      this.pwErr = pwErr;
      this.authErr = false;
      this.loginExpired = false;
      this.hooks.fail?.(idErr ? 'id' : 'pw');
      return;
    }
    this.loading = true;
    this.authErr = false;
    this.loginExpired = false;
    const req = ++this.req;
    try {
      const res = await api<LoginAnswer>('POST', 'auth/login', {
        login: this.ident.trim(),
        password: this.pw,
        remember: this.remember,
      });
      if (req !== this.req) {
        // Step left meanwhile: do not leave a created session behind.
        if (res.status === 'ok') this.hooks.signOut?.();
        return;
      }
      this.loading = false;
      if (res.status === 'ok') {
        this.finish(res.user);
        return;
      }
      this.view = 'otp';
      this.otp = '';
      this.otpErr = null;
      this.stepAt = Date.now();
      this.hooks.focus?.('otp');
    } catch (error) {
      if (req !== this.req) return;
      this.loading = false;
      if (isApiError(error, 422, 'invalid_credentials')) {
        // Locked accounts too, deliberately without a difference.
        this.authErr = true;
        this.pw = '';
        this.hooks.fail?.('pw');
      } else if (isApiError(error, 429)) {
        this.pw = '';
        this.pwLockTotal = retryAfter(error);
        this.locks.start('pw', this.pwLockTotal);
        this.hooks.fail?.('pw');
      } else if (isApiError(error, 503, 'maintenance')) {
        this.maintenance(error);
        this.hooks.fail?.('pw');
      } else if (isApiError(error, 422, 'invalid') && fieldsOf(error).password?.code === 'too_long') {
        this.pwErr = m.password_too_long();
        this.hooks.fail?.('pw');
      } else if (isApiError(error, 422, 'invalid') && fieldsOf(error).login?.code === 'too_long') {
        // Over 254 bytes (umlauts count double): such an account does not exist.
        this.authErr = true;
        this.pw = '';
        this.hooks.fail?.('pw');
      } else {
        this.failed(error);
      }
    }
  }

  // ---- Steps code and recovery code ----

  editOtp(value: string): void {
    this.otp = formatOtp(value);
    this.otpErr = null;
    if (this.otp.length === 6) void this.submitOtp();
  }

  async submitOtp(): Promise<void> {
    if (this.otpLoading || this.codeLocked) return;
    if (this.otp.length < 6) {
      this.otpErr = 'short';
      this.hooks.fail?.('otp');
      return;
    }
    this.otpLoading = true;
    this.otpErr = null;
    await this.sendCode('otp', 'auth/totp', this.otp);
  }

  editBc(value: string): void {
    this.bc = formatRecovery(value);
    this.bcErr = null;
    if (this.bc.length === 9) void this.submitBc();
  }

  async submitBc(): Promise<void> {
    if (this.bcLoading || this.codeLocked) return;
    if (this.bc.replace('-', '').length < 8) {
      this.bcErr = 'short';
      this.hooks.fail?.('bc');
      return;
    }
    this.bcLoading = true;
    this.bcErr = null;
    await this.sendCode('bc', 'auth/recovery', this.bc);
  }

  /** "Use a recovery code". */
  useBackup(): void {
    if (!this.busy) this.switchCode('backup');
  }

  /** "Use a code from the app". */
  useApp(): void {
    if (!this.busy) this.switchCode('otp');
  }

  /** "Back to sign-in" from a code step: identifier stays, password empty. */
  leaveOtp(): void {
    if (this.busy) return;
    this.req++;
    this.clearCodes();
    this.view = 'login';
    this.pw = '';
    this.hooks.focus?.('pw');
  }

  // ---- Reset password ----

  /** "Forgot password?": the identifier becomes the address, route `/password/forgot`. */
  openForgot(): void {
    if (this.busy) return;
    this.req++;
    this.view = 'forgot';
    this.fgErr = null;
    this.fgLoading = false;
    this.authErr = false;
    this.loginExpired = false;
    this.idErr = null;
    this.pwErr = null;
    this.hooks.focus?.('fg');
    this.hooks.navigate?.('forgot');
  }

  editEmail(value: string): void {
    this.ident = value;
    this.fgErr = null;
  }

  /** Back from "Reset password" and "Email sent"; when signed in to the start page. */
  fgBack(authed: boolean): void {
    if (this.busy) return;
    if (authed) {
      this.req++;
      this.hooks.home?.();
      return;
    }
    this.backToLogin();
  }

  /** "Back to sign-in" from the steps of the routes `/password/…`. */
  backToLogin(): void {
    if (this.busy) return;
    this.toLogin();
    this.hooks.navigate?.('login');
  }

  async submitForgot(): Promise<void> {
    if (this.fgLoading || this.fgLocked) return;
    const email = this.ident.trim();
    if (!isEmail(email)) {
      this.fgErr = email ? m.login_fg_invalid() : m.login_fg_required();
      this.hooks.fail?.('fg');
      return;
    }
    this.fgLoading = true;
    this.fgErr = null;
    const req = ++this.req;
    try {
      await api('POST', 'auth/password/forgot', { email });
      if (req !== this.req) return;
      this.fgLoading = false;
      this.locks.clear('fg');
      this.view = 'sent';
      this.cool(RESEND_S, false);
    } catch (error) {
      if (req !== this.req) return;
      this.fgLoading = false;
      if (isApiError(error, 429)) {
        // Only the limit per IP address answers like this; the one per address acts silently.
        this.locks.start('fg', retryAfter(error));
        this.hooks.fail?.();
      } else if (isApiError(error, 422, 'invalid')) {
        this.fgErr = m.login_fg_invalid();
        this.hooks.fail?.('fg');
      } else {
        this.failed(error);
      }
    }
  }

  /** "Resend": 30 seconds again, after 429 until `retry_after` with a notice. */
  async resend(): Promise<void> {
    if (this.resendBlocked || this.resending) return;
    this.resending = true;
    try {
      await api('POST', 'auth/password/forgot', { email: this.ident.trim() });
      this.cool(RESEND_S, false);
    } catch (error) {
      if (isApiError(error, 429)) this.cool(retryAfter(error), true);
      else this.failed(error);
    } finally {
      this.resending = false;
    }
  }

  // ---- Set a new password ----

  editNp(value: string): void {
    this.np = value;
    this.npErr = null;
    this.npBad = [];
  }

  /**
   * "Save password" (`POST auth/password/reset/:token`). Only saving
   * checks the link; afterwards nobody is signed in.
   */
  async submitNp(): Promise<void> {
    if (this.npLoading || this.npLocked) return;
    const bad = PW_RULES.find((rule) => !rule.test(this.np));
    if (bad || tooLong(this.np)) {
      this.npErr = bad ? bad.error() : m.password_too_long();
      this.npBad = [];
      this.hooks.fail?.('np');
      return;
    }
    this.npLoading = true;
    this.npErr = null;
    this.npBad = [];
    const req = ++this.req;
    try {
      const res = await api<{ status: 'ok'; sessions_ended: number }>(
        'POST',
        `auth/password/reset/${encodeURIComponent(this.token)}`,
        { password: this.np },
      );
      // Even if the page is elsewhere by now: the sessions have ended.
      this.hooks.passwordReset?.();
      if (req !== this.req) return;
      this.npLoading = false;
      this.view = 'pwdone';
      this.np = '';
      this.ended = res.sessions_ended;
    } catch (error) {
      if (req !== this.req) return;
      this.npLoading = false;
      if (isApiError(error, 422, 'invalid_token')) {
        // Expired, used or replaced, without a difference; the password is discarded.
        this.view = 'linkbad';
        this.np = '';
      } else if (isApiError(error, 429)) {
        this.locks.start('np', retryAfter(error));
        this.hooks.fail?.();
      } else if (isApiError(error, 422, 'invalid') && fieldsOf(error).password) {
        this.npPolicy(fieldsOf(error).password ?? { code: 'policy' });
      } else {
        this.failed(error);
      }
    }
  }

  /** "Go to sign-in" after "Password changed": fields empty. */
  pwDoneLogin(): void {
    this.view = 'login';
    this.ident = '';
    this.pw = '';
    this.idErr = null;
    this.pwErr = null;
    this.authErr = false;
    this.loginExpired = false;
    this.hooks.focus?.('id');
    this.hooks.navigate?.('login');
  }

  /** "Request a new link" after "Link expired or invalid": field empty. */
  reqNewLink(): void {
    this.req++;
    this.view = 'forgot';
    this.ident = '';
    this.np = '';
    this.npErr = null;
    this.npBad = [];
    this.fgErr = null;
    this.fgLoading = false;
    this.hooks.focus?.('fg');
    this.hooks.navigate?.('forgot');
  }

  // ---- Signed in ----

  /**
   * "Back to sign-in" below "Hello, ‹name›": the session already exists,
   * it ends again (otherwise one would be signed in despite the form).
   */
  reset(): void {
    if (!this.leaveDone()) return;
    this.pw = '';
    this.authErr = false;
    this.hooks.focus?.('pw');
  }

  /**
   * When leaving the page: stop clocks and timers, discard responses of
   * running requests (a created session is signed out).
   */
  dispose(): void {
    this.req++;
    this.locks.stop();
    if (this.done && !this.signingIn) this.leaveDone();
    clearTimeout(this.doneTimer);
  }

  // ---- Internal ----

  private finish(user: SignedInUser): void {
    this.loading = this.otpLoading = this.bcLoading = false;
    this.user = user;
    this.done = true;
    this.view = 'login';
    this.pw = '';
    this.clearCodes();
    clearTimeout(this.doneTimer);
    this.doneTimer = setTimeout(() => void this.signIn(), DONE_MS);
  }

  /** After "Hello": load settings and account; if that fails, back to the form with a toast. */
  private async signIn(): Promise<void> {
    this.signingIn = true;
    const ok = (await this.hooks.signedIn?.()) ?? true;
    // Signed in: the page goes to the start page, "Hello" stays until then (also on teardown).
    if (ok) return;
    this.signingIn = false;
    this.done = false;
    this.user = null;
    this.hooks.error?.(m.error_cookie());
    this.hooks.focus?.(this.ident.trim() ? 'pw' : 'id');
  }

  /**
   * Leaves "Hello" and signs out the new session; `false` if account and
   * settings are already being loaded (then the page goes to the start page right away).
   */
  private leaveDone(): boolean {
    if (this.signingIn) return false;
    clearTimeout(this.doneTimer);
    this.done = false;
    this.user = null;
    this.hooks.signOut?.();
    return true;
  }

  private async sendCode(kind: 'otp' | 'bc', path: string, code: string): Promise<void> {
    const req = ++this.req;
    try {
      const res = await api<{ status: 'ok'; user: SignedInUser }>('POST', path, { code });
      if (req !== this.req) {
        // Step left meanwhile: do not leave a created session behind.
        this.hooks.signOut?.();
        return;
      }
      this.finish(res.user);
    } catch (error) {
      if (req !== this.req) return;
      this.codeFailed(kind, error);
    }
  }

  /** Responses of the code steps (`codeRes`): 429 locks both, `code_used` does not count. */
  private codeFailed(kind: 'otp' | 'bc', error: unknown): void {
    this.otpLoading = this.bcLoading = false;
    const field: Field = kind;
    if (isApiError(error, 422, 'login_expired')) {
      this.toLogin();
      this.loginExpired = true;
      this.stepAt = 0;
      return;
    }
    if (isApiError(error, 503, 'maintenance')) {
      this.maintenance(error);
      this.toLogin();
      this.hooks.fail?.('pw');
      return;
    }
    if (isApiError(error, 429)) {
      this.setCode(kind, '', null);
      this.locks.start('code', retryAfter(error));
      this.hooks.fail?.();
      return;
    }
    if (isApiError(error, 422, 'code_used')) {
      this.setCode(kind, '', kind === 'otp' ? 'used' : 'invalid');
      this.hooks.fail?.(field);
      return;
    }
    if (isApiError(error, 422, 'invalid_code')) {
      this.setCode(kind, '', 'invalid');
      this.hooks.fail?.(field);
      return;
    }
    this.failed(error);
  }

  private setCode(kind: 'otp' | 'bc', value: string, err: 'invalid' | 'used' | null): void {
    if (kind === 'otp') {
      this.otp = value;
      this.otpErr = err;
    } else {
      this.bc = value;
      this.bcErr = err === 'used' ? 'invalid' : err;
    }
  }

  private switchCode(view: 'otp' | 'backup'): void {
    this.req++;
    this.clearCodes();
    this.view = view;
    this.hooks.focus?.(view === 'otp' ? 'otp' : 'bc');
  }

  private clearCodes(): void {
    this.otp = '';
    this.otpErr = null;
    this.otpLoading = false;
    this.bc = '';
    this.bcErr = null;
    this.bcLoading = false;
  }

  /** Step password without a route change (back in the browser, expired intermediate step). */
  private toLogin(): void {
    this.req++;
    this.clearCodes();
    if (this.view === 'otp' || this.view === 'backup') this.pw = '';
    this.view = 'login';
    this.fgLoading = false;
    this.fgErr = null;
    this.np = '';
    this.npErr = null;
    this.npBad = [];
    this.npLoading = false;
    this.hooks.focus?.(this.ident.trim() ? 'pw' : 'id');
  }

  /** `/password/forgot` directly (`openFgDirect`): field empty. */
  private openFgDirect(): void {
    this.req++;
    this.view = 'forgot';
    this.ident = '';
    this.fgErr = null;
    this.fgLoading = false;
    this.authErr = false;
    this.loginExpired = false;
    this.idErr = null;
    this.pwErr = null;
    this.loading = false;
    this.done = false;
    this.hooks.focus?.('fg');
  }

  private openNewPw(token: string): void {
    this.req++;
    this.token = token;
    this.view = 'newpw';
    this.np = '';
    this.npErr = null;
    this.npBad = [];
    this.npLoading = false;
    this.done = false;
    this.hooks.focus?.('np');
  }

  /** 422 `invalid` when saving: first named rule (`policy` with `rules`) or "too long". */
  private npPolicy(detail: { code: string; rules?: unknown }): void {
    const ids = Array.isArray(detail.rules) ? detail.rules.filter((r): r is string => typeof r === 'string') : [];
    if (detail.code === 'too_long') {
      this.npErr = m.password_too_long();
      this.npBad = [];
    } else {
      const bad = PW_RULES.find((rule) => ids.includes(rule.id)) ?? PW_RULES[0];
      this.npErr = bad?.error() ?? null;
      this.npBad = PW_RULES.filter((rule) => ids.includes(rule.id)).map((rule) => rule.id);
    }
    this.hooks.fail?.('np');
  }

  /** 503 `maintenance`: the page shows the notice from the session and loses it when maintenance ends. */
  private maintenance(error: ApiError): void {
    session.noteMaintenance(maintenanceMessage(error));
  }

  /** Countdown of "Resend" (`startCool`); after 429 with a notice (`rsLimit`). */
  private cool(seconds: number, limited: boolean): void {
    this.locks.start('resend', seconds);
    this.rsLimit = limited;
  }

  /** Other failures: "No connection" without an answer (the input stays), otherwise the error toast. */
  private failed(error: unknown): void {
    if (error instanceof NetworkError && this.hooks.offline) this.hooks.offline();
    else this.hooks.error?.(failText(error));
  }

  /** A lock has expired: notice gone, the field ready again. */
  private freed(kind: LockKind): void {
    if (kind === 'resend') this.rsLimit = false;
    else if (kind === 'pw' && this.view === 'login' && !this.done) this.hooks.unlocked?.('pw');
    else if (kind === 'code' && this.view === 'otp') this.hooks.focus?.('otp');
    else if (kind === 'code' && this.view === 'backup') this.hooks.focus?.('bc');
  }
}
