/**
 * Flow of the invitation page against the invitation API: `GET invites/:token`
 * → "Welcome" or "Invitation expired", step name and password (rules like
 * `PW_RULES`), step multi-factor with a new secret on every entry
 * (`POST invites/:token/totp`), "Confirm" creates the account (`accept`), step
 * recovery codes, "Activate account" only redirects. Expired invitations:
 * "Request a new invitation" (`request`) → "Request sent".
 *
 * Unexpected responses show "Something went wrong"; locks and maintenance mode
 * work like sign-in.
 */
import { ApiError, api, fieldsOf, isApiError, maintenanceMessage, retryAfter, type FieldDetail } from '#lib/api.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { failText } from '#lib/errors.ts';
import { formatOtp } from '#lib/login.svelte.ts';
import { nameError, nameErrorText, normalizeName } from '#lib/name.ts';
import { PW_RULES, tooLong, type PasswordRuleId } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { qrSymbol, type QrSymbol } from '#lib/qr.ts';
import { clockText, waitText } from '#lib/wait.ts';
import { intlLocale } from '#lib/locale.ts';

/** Duration from "Welcome, ‹first name›" to the start page (bar `inBar` 2.6 s). */
export const DONE_MS = 2700;

export type InviteStep = 1 | 2 | 3 | 4;
/** Form, "Welcome" after "Activate account" or "Request sent". */
export type InviteView = 'form' | 'done' | 'requested';
/** Loading the invitation: 404 shows the error page, other errors 500 or offline with "Try again". */
export type InviteStatus = 'loading' | 'ready' | 'missing' | 'failed';
export type InviteField = 'name' | 'pw' | 'otp';
/** Icon of the tile in the background (`PHASE_ICON`). */
export type InvitePhase =
  'idle' | 'name' | 'pw' | 'peek' | 'mfa' | 'backup' | 'loading' | 'error' | 'success' | 'expired' | 'requested';

/** Response of `GET invites/:token`. */
export interface InviteInfo {
  email: string;
  /** Name from the invitation in display form, otherwise `null`. */
  name: string | null;
  role: 'admin' | 'user';
  /** Inviter; `null` if their account is deleted. */
  inviter: string | null;
  expires_at: string;
  expired: boolean;
}

/** User from the response of `accept` (`api::auth::user_json`). */
export interface AcceptedUser {
  id: string;
  username: string | null;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
}

/** Values of the page that are not part of the flow. */
export interface InvitePageValues {
  /** "Already registered? Sign in" and "Go to sign-in". */
  toLogin: () => void;
}

/** Rule chip below "Set password" (`rules`). */
export interface InviteRule {
  id: PasswordRuleId;
  label: string;
  ok: boolean;
  /** Red after "Continue" while it is not met. */
  bad: boolean;
}

export interface InviteHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: InviteField) => void;
  /** New step: focus the field. */
  focus?: (field: InviteField) => void;
  /**
   * The account exists (`accept`); a previous session of the browser has
   * ended, its state no longer applies. `left`: the page
   * had been left meanwhile (nobody sees the codes), the new session still
   * applies and must be loaded.
   */
  accepted?: (left: boolean) => void;
  /**
   * After "Welcome": load settings and account, go to the start page
   * (`onInviteAccept`); `false` if the account is not signed in afterwards.
   */
  signedIn?: () => Promise<boolean>;
  /** Errors without their own text: error toast (`ui.toasts.error`). */
  error?: (text: string) => void;
}

/** Locks: code (`accept`) and requests to the link (`totp`, `request`). */
type LockKind = 'code' | 'link';

/** Name error (`nmErrText`): empty, too long or with invisible characters. */
function nameText(name: string): string | null {
  if (!normalizeName(name)) return m.invite_name_required();
  const error = nameError(name);
  return error ? nameErrorText(error) : null;
}

/** Initials like `fromInitials`: first letters of the first two words. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Expiry of the invitation like `untilLabel`: "Mon 2 November". */
function untilText(iso: string): string {
  return new Date(iso).toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'long' });
}

export class InviteFlow {
  token = $state('');
  status = $state<InviteStatus>('loading');
  /** Loading without a server response (network): error card "offline" instead of 500. */
  offline = $state(false);
  /** "Try again" of the error card is running: the card stays with "Checking …". */
  retrying = $state(false);
  info = $state<InviteInfo | null>(null);
  /** Expired (when loading or `invite_expired` later). */
  expired = $state(false);
  step = $state<InviteStep>(1);
  view = $state<InviteView>('form');

  // Step 2: name and password
  name = $state('');
  pw = $state('');
  nmErr = $state<string | null>(null);
  /** `rules`: rules red; `too_long`: text below the field. */
  pwErr = $state<'rules' | 'too_long' | null>(null);
  /** Rules named by the server (422 `policy`). */
  pwBad = $state<PasswordRuleId[]>([]);
  loading = $state(false);

  // Step 3: multi-factor
  secret = $state('');
  uri = $state('');
  otp = $state('');
  otpErr = $state<'short' | 'invalid' | null>(null);
  otpLoading = $state(false);
  /** 503 `maintenance`: own notice or `null` (then `MAINT_MSG`). */
  maint = $state<{ message: string | null } | null>(null);

  // Step 4: recovery codes
  codes = $state<string[]>([]);
  saved = $state(false);
  savedErr = $state(false);

  // Expired
  reqLoading = $state(false);

  readonly locks = new Countdown<LockKind>((kind) => this.freed(kind));
  readonly hooks: InviteHooks;
  /** Running request; a step change invalidates its response. */
  private req = 0;
  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(hooks: InviteHooks = {}) {
    this.hooks = hooks;
  }

  // ---- Derived values ----

  private codeLeft = $derived(this.locks.left('code'));
  private linkLeft = $derived(this.locks.left('link'));

  /** Inviter for "Invitation from …" and "Request a new one from …." (`inviteFrom`). */
  inviteFrom = $derived(this.info?.inviter ?? m.invite_from_fallback());
  /** The same as the subject ("… invited you", "… has been notified"). */
  inviteFromSubject = $derived(this.info?.inviter ?? m.invite_from_fallback_subject());
  fromInitials = $derived(initials(this.inviteFrom));
  inviteEmail = $derived(this.info?.email ?? '');
  untilLabel = $derived(this.info ? untilText(this.info.expires_at) : '');
  roleName = $derived(this.info?.role === 'admin' ? m.invite_role_admin() : m.invite_role_user());

  form = $derived(!this.expired && this.view === 'form');
  showSteps = $derived(this.form);
  isS1 = $derived(this.step === 1);
  canBack = $derived(this.step === 2 || this.step === 3);
  stepLabel = $derived(m.invite_step({ n: this.step }));
  showS1 = $derived(this.form && this.step === 1);
  showS2 = $derived(this.form && this.step === 2);
  showS3 = $derived(this.form && this.step === 3);
  showS4 = $derived(this.form && this.step === 4);
  showDone = $derived(this.view === 'done');
  showExpired = $derived(this.expired && this.view === 'form');
  showRequested = $derived(this.view === 'requested');
  firstName = $derived(normalizeName(this.name).split(' ')[0] ?? '');

  rules = $derived(
    PW_RULES.map((rule): InviteRule => {
      const ok = rule.test(this.pw) && !this.pwBad.includes(rule.id);
      return { id: rule.id, label: rule.label(), ok, bad: !ok && this.pwErr === 'rules' };
    }),
  );
  pwText = $derived(this.pwErr === 'too_long' ? m.password_too_long() : null);

  qr = $derived<QrSymbol | null>(this.uri ? qrSymbol(this.uri) : null);
  /** Secret in groups of four (`secretLabel`). */
  secretLabel = $derived((this.secret.match(/.{1,4}/g) ?? []).join(' '));
  otpBad = $derived(this.otpErr === 'invalid');
  otpShort = $derived(this.otpErr === 'short');

  codeLocked = $derived(this.codeLeft > 0);
  codeLockText = $derived(this.codeLeft ? m.limit_text({ wait: waitText(this.codeLeft) }) : '');
  codeLockBtn = $derived(this.codeLeft ? m.login_confirm_locked({ time: clockText(this.codeLeft) }) : '');
  otpReady = $derived(!this.otpLoading && !this.codeLocked);
  otpDis = $derived(this.otpLoading || this.codeLocked);

  linkLocked = $derived(this.linkLeft > 0);
  linkLockText = $derived(this.linkLeft ? m.limit_text({ wait: waitText(this.linkLeft) }) : '');
  /** Locked buttons with a countdown (`s2LockBtn`, `reqLockBtn`); both share the lock of the links. */
  s2LockBtn = $derived(this.linkLeft ? m.invite_next_locked({ time: clockText(this.linkLeft) }) : '');
  reqLockBtn = $derived(this.linkLeft ? m.invite_request_locked({ time: clockText(this.linkLeft) }) : '');

  /** "Confirm that you’ve saved the codes." (`savedErr && !saved`). */
  savedShown = $derived(this.savedErr && !this.saved);

  /** The account exists (codes from `accept`); if the page is left, the new session applies. */
  accepted = $derived(this.codes.length > 0);

  /** A request is running: "Back" waits for the response. */
  busy = $derived(this.loading || this.otpLoading || this.reqLoading);

  /** Icon of the tile like `phase()`; focus and "Show password" come from the page. */
  phase(focus: InviteField | null, showPw: boolean): InvitePhase {
    if (this.view === 'requested') return 'requested';
    if (this.view === 'done') return 'success';
    if (this.busy) return 'loading';
    if (this.expired) return 'expired';
    if (this.step === 2) {
      if (focus === 'pw') return showPw ? 'peek' : 'pw';
      if (focus === 'name') return 'name';
      return this.nmErr || this.pwErr ? 'error' : 'name';
    }
    if (this.step === 3) return this.otpBad ? 'error' : 'mfa';
    if (this.step === 4) return this.savedShown ? 'error' : 'backup';
    return 'idle';
  }

  // ---- Loading ----

  /** New token (page opened): everything back to the start, then load. */
  async open(token: string): Promise<void> {
    this.req++;
    clearTimeout(this.doneTimer);
    this.token = token;
    this.status = 'loading';
    this.retrying = false;
    this.info = null;
    this.expired = false;
    this.step = 1;
    this.view = 'form';
    this.name = '';
    this.clearPassword();
    this.clearMfa();
    this.codes = [];
    this.saved = false;
    this.savedErr = false;
    this.loading = this.reqLoading = false;
    this.locks.clear('code');
    this.locks.clear('link');
    await this.load();
  }

  /**
   * `GET invites/:token`. As "Try again" of the error card the card
   * stays with "Checking …" until the response is there.
   */
  async load(): Promise<void> {
    const req = ++this.req;
    if (this.status !== 'failed') this.status = 'loading';
    this.retrying = this.status === 'failed';
    try {
      const info = await api<InviteInfo>('GET', `invites/${encodeURIComponent(this.token)}`);
      if (req !== this.req) return;
      this.info = info;
      this.expired = info.expired;
      if (!this.name) this.name = info.name ?? '';
      this.status = 'ready';
    } catch (error) {
      if (req !== this.req) return;
      this.status = isApiError(error, 404) ? 'missing' : 'failed';
      this.offline = !(error instanceof ApiError);
    } finally {
      if (req === this.req) this.retrying = false;
    }
  }

  // ---- Step 1 ----

  /** "Accept invitation". */
  accept(): void {
    this.step = 2;
    this.hooks.focus?.('name');
  }

  /** "Back": from 2 to 1, from 3 to 2 (there the next "Continue" gets a new secret). */
  back(): void {
    if (this.busy) return;
    this.req++;
    if (this.step === 2) {
      this.step = 1;
    } else if (this.step === 3) {
      this.clearMfa();
      this.step = 2;
      this.hooks.focus?.('name');
    }
  }

  // ---- Step 2 ----

  editName(value: string): void {
    this.name = value;
    this.nmErr = null;
  }

  editPw(value: string): void {
    this.pw = value;
    this.pwBad = [];
    // Like `onPw`: the rules stay red until all are met.
    if (this.pwErr === 'too_long' || (this.pwErr === 'rules' && PW_RULES.every((rule) => rule.test(value)))) {
      this.pwErr = null;
    }
  }

  /**
   * "Continue": check name and rules, then fetch the secret for the app
   * (`POST …/totp`). After field errors when confirming the previous secret
   * still applies (the app already has it); only "Back" discards it.
   */
  async submitName(): Promise<void> {
    if (this.loading || this.linkLocked) return;
    const nmErr = nameText(this.name);
    const pwErr = !PW_RULES.every((rule) => rule.test(this.pw)) ? 'rules' : tooLong(this.pw) ? 'too_long' : null;
    if (nmErr || pwErr) {
      this.nmErr = nmErr;
      this.pwErr = pwErr;
      this.pwBad = [];
      this.hooks.fail?.(nmErr ? 'name' : 'pw');
      return;
    }
    if (this.secret) {
      this.step = 3;
      this.hooks.focus?.('otp');
      return;
    }
    this.loading = true;
    const req = ++this.req;
    try {
      const res = await api<{ secret: string; uri: string }>('POST', `invites/${encodeURIComponent(this.token)}/totp`);
      if (req !== this.req) return;
      this.loading = false;
      this.clearMfa();
      this.secret = res.secret;
      this.uri = res.uri;
      this.step = 3;
      this.hooks.focus?.('otp');
    } catch (error) {
      if (req !== this.req) return;
      this.loading = false;
      this.linkFailed(error);
    }
  }

  // ---- Step 3 ----

  editOtp(value: string): void {
    this.otp = formatOtp(value);
    this.otpErr = null;
    if (this.otp.length === 6) void this.submitOtp();
  }

  /** "Confirm": creates the account with app and codes (`POST …/accept`). */
  async submitOtp(): Promise<void> {
    if (this.otpLoading || this.codeLocked) return;
    if (this.otp.length < 6) {
      this.otpErr = 'short';
      this.hooks.fail?.('otp');
      return;
    }
    this.otpLoading = true;
    this.otpErr = null;
    this.maint = null;
    const req = ++this.req;
    try {
      const res = await api<{ user: AcceptedUser; recovery_codes: string[] }>(
        'POST',
        `invites/${encodeURIComponent(this.token)}/accept`,
        { name: normalizeName(this.name), password: this.pw, code: this.otp },
      );
      // The account exists, even if the page is elsewhere by now.
      this.hooks.accepted?.(req !== this.req);
      if (req !== this.req) return;
      this.otpLoading = false;
      this.codes = res.recovery_codes;
      this.clearPassword();
      this.clearMfa();
      this.step = 4;
    } catch (error) {
      if (req !== this.req) return;
      this.otpLoading = false;
      this.acceptFailed(error);
    }
  }

  // ---- Step 4 ----

  toggleSaved(): void {
    this.saved = !this.saved;
    this.savedErr = false;
  }

  /** "Activate account": the account already exists; only "Welcome" and the redirect. */
  finish(): void {
    if (this.view !== 'form') return;
    if (!this.saved) {
      this.savedErr = true;
      this.hooks.fail?.();
      return;
    }
    this.view = 'done';
    clearTimeout(this.doneTimer);
    this.doneTimer = setTimeout(() => void this.signIn(), DONE_MS);
  }

  // ---- Expired ----

  /** "Request a new invitation" (`POST …/request`, always 202). */
  async request(): Promise<void> {
    if (this.reqLoading || this.linkLocked) return;
    this.reqLoading = true;
    const req = ++this.req;
    try {
      await api('POST', `invites/${encodeURIComponent(this.token)}/request`);
      if (req !== this.req) return;
      this.reqLoading = false;
      this.view = 'requested';
    } catch (error) {
      if (req !== this.req) return;
      this.reqLoading = false;
      if (isApiError(error, 422, 'invite_valid')) {
        // Sent again meanwhile: the invitation applies again.
        void this.load();
      } else {
        this.linkFailed(error);
      }
    }
  }

  /** When leaving the page: stop clocks and timers, discard responses of running requests. */
  dispose(): void {
    this.req++;
    this.locks.stop();
    clearTimeout(this.doneTimer);
  }

  // ---- Internal ----

  private async signIn(): Promise<void> {
    const ok = (await this.hooks.signedIn?.()) ?? true;
    if (ok) return;
    // The account exists, but the session did not arrive (cookie rejected): back to the codes.
    this.view = 'form';
    this.hooks.error?.(m.error_cookie());
  }

  /** Responses of `totp` and `request`. */
  private linkFailed(error: unknown): void {
    if (isApiError(error, 404)) {
      // Withdrawn or already accepted.
      this.status = 'missing';
    } else if (isApiError(error, 422, 'invite_expired')) {
      this.toExpired();
    } else if (isApiError(error, 429)) {
      this.locks.start('link', retryAfter(error));
      this.hooks.fail?.();
    } else {
      this.hooks.error?.(failText(error));
    }
  }

  /** Responses of `accept`. */
  private acceptFailed(error: unknown): void {
    if (isApiError(error, 422, 'invalid_code') || isApiError(error, 422, 'code_used')) {
      this.otp = '';
      this.otpErr = 'invalid';
      this.hooks.fail?.('otp');
    } else if (isApiError(error, 429)) {
      this.otp = '';
      this.locks.start('code', retryAfter(error));
      this.hooks.fail?.();
    } else if (isApiError(error, 422, 'invite_expired')) {
      this.toExpired();
    } else if (isApiError(error, 404)) {
      this.status = 'missing';
    } else if (isApiError(error, 503, 'maintenance')) {
      // A notice, not a mistake: no shake.
      this.maint = { message: maintenanceMessage(error) };
      this.otp = '';
    } else if (isApiError(error, 422, 'invalid')) {
      this.fieldsFailed(fieldsOf(error));
    } else {
      // Also `totp_required` (secret missing): "Back" and "Continue" give a new one.
      this.hooks.error?.(failText(error));
    }
  }

  /** 422 `invalid` when accepting: name and password → back to step 2, code → "Invalid code." */
  private fieldsFailed(fields: Record<string, FieldDetail>): void {
    const name = fields.name;
    const password = fields.password;
    if (!name && !password) {
      if (fields.code) {
        this.otp = '';
        this.otpErr = 'invalid';
        this.hooks.fail?.('otp');
      } else {
        this.hooks.error?.(m.error_act());
      }
      return;
    }
    this.nmErr =
      name?.code === 'required'
        ? m.invite_name_required()
        : name?.code === 'too_long'
          ? m.error_name_long()
          : name
            ? m.error_name_invalid()
            : null;
    if (password?.code === 'too_long') {
      this.pwErr = 'too_long';
      this.pwBad = [];
    } else if (password) {
      const ids = Array.isArray(password.rules) ? password.rules.filter((r): r is string => typeof r === 'string') : [];
      this.pwErr = 'rules';
      this.pwBad = PW_RULES.filter((rule) => ids.includes(rule.id)).map((rule) => rule.id);
    }
    // The secret stays valid (it is only checked after the fields): no new scan.
    this.otp = '';
    this.otpErr = null;
    this.maint = null;
    this.step = 2;
    this.hooks.fail?.(name ? 'name' : 'pw');
  }

  private toExpired(): void {
    this.req++;
    this.expired = true;
    this.view = 'form';
    this.step = 1;
    this.clearPassword();
    this.clearMfa();
    if (this.info) this.info = { ...this.info, expired: true };
  }

  private clearPassword(): void {
    this.pw = '';
    this.pwErr = null;
    this.pwBad = [];
    this.nmErr = null;
  }

  private clearMfa(): void {
    this.secret = '';
    this.uri = '';
    this.otp = '';
    this.otpErr = null;
    this.otpLoading = false;
    this.maint = null;
  }

  /** A lock has expired: the code field is ready again. */
  private freed(kind: LockKind): void {
    if (kind === 'code' && this.step === 3) this.hooks.focus?.('otp');
  }
}
