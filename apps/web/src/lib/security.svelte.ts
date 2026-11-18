/**
 * Account › Security against the API: change password (`PUT auth/password`),
 * add and remove authenticator apps (`auth/totp/devices`), new recovery codes
 * (`POST auth/recovery-codes`) and signed-in devices (`auth/sessions`).
 *
 * "Sign out" (a device) and "Sign out all others" wait with undo for the end
 * of the toast (`ui.toasts.defer`); whatever requires password and code goes
 * immediately. App passwords and API keys are not managed here. Errors without
 * a text of their own show the generic error toast.
 *
 * Apps, codes and devices stay for the session (`keptSecurity`): a reopened
 * page shows them at once and loads again in the background; if that fails,
 * they stay with the toast "Couldn’t update the list.".
 */
import { SvelteSet } from 'svelte/reactivity';
import { ago } from '#lib/ago.ts';
import { api, fieldsOf, isApiError, retryAfter } from '#lib/api.ts';
import { copyText } from '#lib/clipboard.svelte.ts';
import { formatDate } from '#lib/date.ts';
import { downloadCodes } from '#lib/download.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { formatOtp } from '#lib/login.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { PW_RULES, tooLong, type PasswordRuleId } from '#lib/password.ts';
import { qrSymbol, type QrSymbol } from '#lib/qr.ts';
import { CODE_LENGTH, reauthError, type ReauthError } from '#lib/reauth.ts';
import { Kept } from '#lib/state/kept.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { Loading, ui } from '#lib/state/ui.svelte.ts';
import { waitText } from '#lib/wait.ts';

export type ListStatus = 'loading' | 'ready' | 'failed';
/** Sections of the page. */
export type Section = 'password' | '2fa' | 'sessions';

/** Authenticator app from `GET auth/totp/devices`. */
export interface TotpDevice {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** State of the recovery codes. */
export interface RecoverySummary {
  total: number;
  unused: number;
  created_at: string;
}

/** Response with devices (`api::mfa::overview`); new codes only when generating. */
export interface MfaOverview {
  devices: TotpDevice[];
  recovery: RecoverySummary | null;
  recovery_codes?: string[] | null;
}

/** Session from `GET auth/sessions`. */
export interface ListedSession {
  id: string;
  current: boolean;
  /** Browser and system, e.g. "Firefox on Linux". */
  device: string;
  device_type: 'desktop' | 'mobile' | 'tablet';
  /** System of the installed app (e.g. "iPhone"), otherwise `null`. */
  app: string | null;
  place: string | null;
  /** Shortened IP address. */
  ip: string | null;
  created_at: string;
  last_seen_at: string;
}

/** Started enrolment (`POST auth/totp/devices/enroll`). */
interface Enrollment {
  id: string;
  /** Base32 without spaces. */
  secret: string;
  uri: string;
}

/** Add or remove an app. */
export type TotpMode = 'setup' | 'off';

/**
 * Characters an app name must not contain, checked before anything is sent:
 * control characters, line and paragraph separators and invisible format
 * characters (soft hyphen, direction marks and overrides, zero width, BOM).
 * The name is checked as typed, so a tab or line break at either end counts
 * too. The server (`api::mfa::check_name`) stays the fallback.
 */
const APP_NAME_BAD = /[\p{Cc}\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

/** Time from the API in ms; now without a valid value. */
function ms(value: string | null | undefined, now: number): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? now : t;
}

/** Apps, codes and devices of the last open page of the session. */
export interface KeptSecurity {
  devices: TotpDevice[];
  recovery: RecoverySummary | null;
  sessions: ListedSession[];
}

export const keptSecurity = new Kept<KeptSecurity>();

export class SecurityPage {
  status = $state<ListStatus>('loading');
  /** Reason the first load failed (text of the card). */
  failure = $state('');
  /** Skeleton only after 150 ms. */
  loading = new Loading();
  devices = $state<TotpDevice[]>([]);
  recovery = $state<RecoverySummary | null>(null);
  sessions = $state<ListedSession[]>([]);
  /** Sessions whose sign-out with undo is pending (hidden). */
  readonly hidden = new SvelteSet<string>();

  // Change password
  pwCur = $state('');
  pwOtp = $state('');
  pwNew = $state('');
  pwConf = $state('');
  pwShowCur = $state(false);
  pwShowNew = $state(false);
  pwErr = $state<string | null>(null);
  pwBusy = $state(false);

  // Add or remove an authenticator app
  totpMode = $state<TotpMode | null>(null);
  totpTarget = $state<string | null>(null);
  enrollment = $state<Enrollment | null>(null);
  tName = $state('');
  tPw = $state('');
  tCode = $state('');
  tErr = $state<string | null>(null);
  /** Name of the app with invisible characters (`name: invalid`). */
  tNameErr = $state<string | null>(null);
  /** Enrolment restarted in another window or expired: "Start over". */
  tStale = $state(false);
  tBusy = $state(false);
  qr = $derived<QrSymbol | null>(this.enrollment ? qrSymbol(this.enrollment.uri) : null);

  // Recovery codes
  /** Codes just generated, shown only once. */
  codes = $state<string[] | null>(null);
  rcForm = $state(false);
  rcPw = $state('');
  rcCode = $state('');
  rcErr = $state<string | null>(null);
  rcBusy = $state(false);

  #seq = 0;
  #enrollSeq = 0;
  #disposed = false;
  /** Reopened with the kept data: the next load reports a failure only as "Couldn’t update the list.". */
  #reopened = false;
  readonly #keep = keptSecurity.keeper();

  constructor() {
    const kept = keptSecurity.value;
    if (!kept) return;
    this.devices = kept.devices;
    this.recovery = kept.recovery;
    this.sessions = kept.sessions;
    this.status = 'ready';
    this.#reopened = true;
  }

  get mfa(): boolean {
    return this.devices.length > 0;
  }

  get pwReady(): boolean {
    return !!(this.pwCur && this.pwNew && this.pwConf && (!this.mfa || this.pwOtp));
  }

  /** Loads apps, codes and sessions; after the first load the page stays as it is on an error. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const reopened = this.#reopened;
    this.#reopened = false;
    const changes = keptSecurity.changes;
    try {
      const [mfa, list] = await this.loading.run(
        Promise.all([
          api<MfaOverview>('GET', 'auth/totp/devices'),
          api<{ sessions: ListedSession[] }>('GET', 'auth/sessions'),
        ]),
      );
      if (seq !== this.#seq || this.#disposed) return;
      // Changed in the meantime (app added or removed, devices signed out): the response is older, so reload.
      if (changes !== keptSecurity.changes) {
        this.#reopened = reopened;
        void this.load();
        return;
      }
      this.devices = mfa.devices;
      this.recovery = mfa.recovery;
      this.sessions = list.sessions;
      this.status = 'ready';
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      if (isApiError(error, 401)) void session.refreshUser().catch(() => {});
      if (this.status !== 'ready') {
        this.failure = isApiError(error, 429) ? m.error_limit({ wait: waitText(retryAfter(error)) }) : failText(error);
        this.status = 'failed';
      } else if (!isApiError(error, 401)) {
        ui.toasts.error(reopened ? m.error_list() : failText(error, m.error_list()));
      }
    }
  }

  /** "Try again" of the card. */
  retry(): void {
    this.status = 'loading';
    void this.load();
  }

  /** Leave the page: keep apps, codes and devices as the server knows them; late responses change nothing any more. */
  dispose(): void {
    if (this.status === 'ready' && !this.#disposed) {
      // As the server knows them: devices whose sign-out with undo is pending stay (it may yet be undone or fail).
      this.#keep($state.snapshot({ devices: this.devices, recovery: this.recovery, sessions: this.sessions }));
    }
    this.#disposed = true;
    this.#enrollSeq++;
  }

  // ---- Change password ----

  setPw(field: 'pwCur' | 'pwNew' | 'pwConf', value: string): void {
    this[field] = value;
    this.pwErr = null;
  }

  setPwOtp(value: string): void {
    this.pwOtp = formatOtp(value);
    this.pwErr = null;
  }

  async changePassword(): Promise<void> {
    if (!this.pwReady || this.pwBusy) return;
    const broken = PW_RULES.find((rule) => !rule.test(this.pwNew));
    if (broken) {
      this.pwErr = broken.error();
      return;
    }
    if (tooLong(this.pwNew)) {
      this.pwErr = m.password_too_long();
      return;
    }
    if (this.pwNew !== this.pwConf) {
      this.pwErr = m.security_pw_mismatch();
      return;
    }
    const mfa = this.mfa;
    if (mfa && this.pwOtp.length !== CODE_LENGTH) {
      this.pwErr = m.reauth_code_short();
      return;
    }
    this.pwBusy = true;
    try {
      const body = { current_password: this.pwCur, new_password: this.pwNew, ...(mfa ? { code: this.pwOtp } : {}) };
      const res = await api<{ password_changed_at: string; sessions_ended: number }>('PUT', 'auth/password', body);
      this.pwCur = this.pwNew = this.pwConf = this.pwOtp = '';
      this.pwShowCur = this.pwShowNew = false;
      this.pwErr = null;
      // All other sessions are ended, open links from mails discarded.
      keptSecurity.changed();
      this.sessions = this.sessions.filter((s) => s.current);
      const user = session.user;
      if (user) session.user = { ...user, password_changed_at: res.password_changed_at, email_change: null };
      ui.toasts.show(res.sessions_ended > 0 ? m.security_pw_done_others() : m.security_pw_done());
    } catch (error) {
      this.#passwordFailed(error);
    } finally {
      this.pwBusy = false;
    }
  }

  #passwordFailed(error: unknown): void {
    const reauth = reauthError(error, false, 'current_password');
    if (reauth) {
      this.pwErr = reauth.text;
      this.#clear(reauth, 'pwCur', 'pwOtp');
      // Multi-factor switched on in the meantime (another tab): reload, then the code field appears.
      if (!this.mfa && isApiError(error, 422, 'invalid') && fieldsOf(error).code) void this.load();
      return;
    }
    if (isApiError(error, 422, 'invalid')) {
      const field = fieldsOf(error).new_password;
      if (field?.code === 'too_long') {
        this.pwErr = m.password_too_long();
        return;
      }
      const rules = Array.isArray(field?.rules) ? (field.rules as PasswordRuleId[]) : [];
      const broken = PW_RULES.find((rule) => rules.includes(rule.id));
      if (broken) {
        this.pwErr = broken.error();
        return;
      }
    }
    this.#unexpected(error);
  }

  // ---- Authenticator apps ----

  /** "Add authenticator app": new secret from the server, then QR code and key. */
  async addApp(): Promise<void> {
    this.cancelTotp();
    this.totpMode = 'setup';
    const seq = this.#enrollSeq;
    try {
      const res = await api<Enrollment>('POST', 'auth/totp/devices/enroll');
      if (seq === this.#enrollSeq) this.enrollment = res;
    } catch (error) {
      if (seq !== this.#enrollSeq) return;
      this.cancelTotp();
      this.#unexpected(error);
    }
  }

  /** Trash can of an app: ask for password and code to remove it. */
  askRemove(id: string): void {
    this.cancelTotp();
    this.totpMode = 'off';
    this.totpTarget = id;
  }

  /** "Start over" after a replaced enrolment: new secret, name and password stay. */
  restartApp(): void {
    const { tName, tPw } = this;
    void this.addApp();
    this.tName = tName;
    this.tPw = tPw;
  }

  cancelTotp(): void {
    this.#enrollSeq++;
    this.tBusy = false;
    this.totpMode = null;
    this.totpTarget = null;
    this.enrollment = null;
    this.tName = '';
    this.tPw = '';
    this.tCode = '';
    this.tErr = null;
    this.tNameErr = null;
    this.tStale = false;
  }

  setTName(value: string): void {
    this.tName = value;
    this.tNameErr = null;
  }

  setTPw(value: string): void {
    this.tPw = value;
    this.tErr = null;
  }

  setTCode(value: string): void {
    this.tCode = formatOtp(value);
    this.tErr = null;
  }

  totpKey(event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.confirmTotp();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelTotp();
    }
  }

  /** "Add" or "Remove". */
  async confirmTotp(): Promise<void> {
    const mode = this.totpMode;
    if (!mode || this.tBusy) return;
    // The name comes first, before password and code; nothing is sent.
    if (mode === 'setup' && APP_NAME_BAD.test(this.tName)) {
      this.tNameErr = m.error_name_invalid();
      return;
    }
    if (!this.tPw) {
      this.tErr = m.security_password_required();
      return;
    }
    if (this.tCode.length !== CODE_LENGTH) {
      this.tErr = m.security_code_required();
      return;
    }
    if (mode === 'setup') await this.#confirmApp();
    else await this.#removeApp();
  }

  async #confirmApp(): Promise<void> {
    const enrollment = this.enrollment;
    if (!enrollment) return;
    const name = this.tName.trim();
    // Responses only apply to this prompt; closed in the meantime or another one open: fields stay.
    const seq = this.#enrollSeq;
    this.tBusy = true;
    try {
      const res = await api<MfaOverview>('POST', 'auth/totp/devices/confirm', {
        id: enrollment.id,
        ...(name ? { name } : {}),
        password: this.tPw,
        code: this.tCode,
      });
      this.#applyMfa(res);
      const added = res.devices.find((d) => d.id === enrollment.id)?.name ?? name;
      if (seq === this.#enrollSeq) this.cancelTotp();
      // The codes exist only now, with the first device – even if the prompt is closed in the meantime.
      const first = !!res.recovery_codes?.length;
      if (res.recovery_codes?.length) this.#showCodes(res.recovery_codes);
      ui.toasts.show(first ? m.security_mfa_on() : m.security_app_added({ name: added }));
      this.#mfaChanged();
    } catch (error) {
      if (seq !== this.#enrollSeq) return;
      const reauth = reauthError(error, true);
      if (reauth) {
        this.tErr = reauth.text;
        this.#clear(reauth, 'tPw', 'tCode');
        return;
      }
      // Enrolment replaced in the meantime (second tab) or expired: "Start over"; the code is moot.
      if (isApiError(error, 404)) {
        this.tStale = true;
        this.tCode = '';
        return;
      }
      const name = isApiError(error, 422, 'invalid') ? fieldsOf(error).name : undefined;
      if (name) {
        this.tNameErr = name.code === 'too_long' ? m.error_name_long() : m.error_name_invalid();
        return;
      }
      this.#unexpected(error);
    } finally {
      if (seq === this.#enrollSeq) this.tBusy = false;
    }
  }

  async #removeApp(): Promise<void> {
    const id = this.totpTarget;
    const target = this.devices.find((d) => d.id === id);
    if (!id || !target) return;
    const seq = this.#enrollSeq;
    this.tBusy = true;
    try {
      const res = await api<MfaOverview>('DELETE', `auth/totp/devices/${encodeURIComponent(id)}`, {
        password: this.tPw,
        code: this.tCode,
      });
      this.#applyMfa(res);
      if (seq === this.#enrollSeq) this.cancelTotp();
      const last = res.devices.length === 0;
      if (last) {
        // With the last app the codes are dropped; changing the password no longer needs a code.
        this.codes = null;
        this.cancelRegen();
        this.pwOtp = '';
      }
      ui.toasts.show(last ? m.security_mfa_off() : m.security_app_removed({ name: target.name }));
      this.#mfaChanged();
    } catch (error) {
      if (seq !== this.#enrollSeq) return;
      const reauth = reauthError(error);
      if (reauth) {
        this.tErr = reauth.text;
        this.#clear(reauth, 'tPw', 'tCode');
        return;
      }
      if (isApiError(error, 404)) {
        // Already removed (another tab): reload the list.
        this.cancelTotp();
        void this.load();
        return;
      }
      this.#unexpected(error);
    } finally {
      if (seq === this.#enrollSeq) this.tBusy = false;
    }
  }

  async copySecret(): Promise<void> {
    if (this.enrollment && (await copyText(this.enrollment.secret))) ui.toasts.show(m.security_key_copied());
  }

  // ---- Recovery codes ----

  openRegen(): void {
    this.cancelRegen();
    this.rcForm = true;
    this.codes = null;
  }

  cancelRegen(): void {
    this.rcForm = false;
    this.rcPw = '';
    this.rcCode = '';
    this.rcErr = null;
  }

  setRcPw(value: string): void {
    this.rcPw = value;
    this.rcErr = null;
  }

  setRcCode(value: string): void {
    this.rcCode = formatOtp(value);
    this.rcErr = null;
  }

  rcKey(event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.regenerate();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRegen();
    }
  }

  async regenerate(): Promise<void> {
    if (!this.rcForm || this.rcBusy) return;
    if (!this.rcPw) {
      this.rcErr = m.security_password_required();
      return;
    }
    if (this.rcCode.length !== CODE_LENGTH) {
      this.rcErr = m.security_code_required();
      return;
    }
    this.rcBusy = true;
    try {
      const res = await api<MfaOverview>('POST', 'auth/recovery-codes', { password: this.rcPw, code: this.rcCode });
      this.#applyMfa(res);
      this.cancelRegen();
      if (res.recovery_codes?.length) this.#showCodes(res.recovery_codes);
      ui.toasts.show(m.security_rc_new());
    } catch (error) {
      const reauth = reauthError(error);
      if (reauth) {
        this.rcErr = reauth.text;
        this.#clear(reauth, 'rcPw', 'rcCode');
        return;
      }
      if (isApiError(error, 409, 'mfa_disabled')) {
        // The last app was removed in the meantime.
        this.cancelRegen();
        void this.load();
      }
      this.#unexpected(error);
    } finally {
      this.rcBusy = false;
    }
  }

  async copyCodes(): Promise<void> {
    if (this.codes && (await copyText(this.codes.join('\n')))) ui.toasts.show(m.security_rc_copied());
  }

  downloadCodes(): void {
    if (this.codes && downloadCodes(session.appName, session.user?.email ?? '', this.codes)) {
      ui.toasts.show(m.security_rc_downloaded());
    }
  }

  doneCodes(): void {
    this.codes = null;
  }

  // ---- Signed-in devices ----

  /** "Sign out" of a device with undo; the request follows when the toast expires. */
  revoke(id: string): void {
    if (this.hidden.has(id)) return;
    this.hidden.add(id);
    ui.toasts.defer({
      text: m.security_session_ended(),
      revert: () => this.hidden.delete(id),
      commit: async (keepalive) => {
        try {
          await api('DELETE', `auth/sessions/${encodeURIComponent(id)}`, undefined, { keepalive });
        } catch (error) {
          // Already ended or expired.
          if (!isApiError(error, 404)) throw error;
        }
        keptSecurity.changed();
        this.sessions = this.sessions.filter((s) => s.id !== id);
        this.hidden.delete(id);
      },
      onError: (error) => this.#sessionsFailed(error, m.security_session_failed()),
    });
  }

  /** "Sign out all other devices" with undo. */
  revokeOthers(): void {
    const ids = this.sessions.filter((s) => !s.current && !this.hidden.has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    for (const id of ids) this.hidden.add(id);
    ui.toasts.defer({
      text: m.security_others_ended(),
      revert: () => {
        for (const id of ids) this.hidden.delete(id);
      },
      commit: async (keepalive) => {
        await api('POST', 'auth/sessions/revoke-others', undefined, { keepalive });
        keptSecurity.changed();
        this.sessions = this.sessions.filter((s) => s.current);
        for (const id of ids) this.hidden.delete(id);
        // Open links from mails are discarded.
        void session.refreshUser().catch(() => {});
      },
      onError: (error) => this.#sessionsFailed(error, m.security_others_failed()),
    });
  }

  #sessionsFailed(error: unknown, text: string): void {
    this.#unexpected(error, text);
    if (!this.#disposed && !isApiError(error, 401)) void this.load();
  }

  // ---- internal ----

  /** Apps and codes after a change confirmed by the server. */
  #applyMfa(res: MfaOverview): void {
    keptSecurity.changed();
    this.devices = res.devices;
    this.recovery = res.recovery;
  }

  #showCodes(codes: string[]): void {
    this.codes = codes;
    this.rcForm = false;
  }

  /** Update `mfa_enabled` in the account (Account › Profile then asks for the code). */
  #mfaChanged(): void {
    const user = session.user;
    if (user) session.user = { ...user, mfa_enabled: this.mfa };
  }

  #clear<P extends 'pwCur' | 'tPw' | 'rcPw', C extends 'pwOtp' | 'tCode' | 'rcCode'>(
    reauth: ReauthError,
    password: P,
    code: C,
  ): void {
    if (reauth.clear === 'password') this[password] = '';
    if (reauth.clear === 'code') this[code] = '';
  }

  /** Error toast; without a session the account reloads, the layout then shows the sign-in. */
  #unexpected(error: unknown, text: string = m.error_act()): void {
    if (isApiError(error, 401)) void session.refreshUser().catch(() => {});
    else ui.toasts.error(failText(error, text));
  }
}

// Values of the page

export interface PwFieldValues {
  label: string;
  desc: string;
  /** `autocomplete` attribute. */
  ac: 'current-password' | 'one-time-code' | 'new-password';
  im: 'text' | 'numeric';
  type: 'text' | 'password';
  value: string;
  sep: boolean;
  hasEye: boolean;
  eyeIcon: 'ti-eye' | 'ti-eye-off';
  eyeTip: string;
  onChange: (value: string) => void;
  onEye?: () => void;
}

export interface TfaEntryValues {
  id: string;
  name: string;
  sub: string;
  sep: boolean;
  delLabel: string;
  /** This app is being removed (highlighted background and shadow). */
  selected: boolean;
  onRemove: () => void;
}

export interface SessionValues {
  id: string;
  icon: IconName;
  name: string;
  sub: string;
  current: boolean;
  notCurrent: boolean;
  onRevoke: () => void;
}

export interface SecurityValues {
  /** Skeleton while the first load takes longer than 150 ms. */
  skSet: boolean;
  secTabs: { label: string; onClick: () => void }[];
  /** Single sign-on is not supported; always `false`. */
  secSso: boolean;
  secNotSso: boolean;
  pwDesc: string;
  pwFields: PwFieldValues[];
  pwKey: (event: KeyInput) => void;
  pwMsg: string;
  hasPwMsg: boolean;
  /** "Change password" still disabled (`aria-disabled`). */
  pwDis: boolean;
  pwBusy: boolean;
  pwSubmit: () => void;
  tfaEntries: TfaEntryValues[];
  tfaEmpty: boolean;
  tfaAdd: () => void;
  totpPanel: boolean;
  totpNoPanel: boolean;
  totpSetup: boolean;
  tNameVal: string;
  onTName: (value: string) => void;
  totpIntro: string;
  /** Key in groups of four; empty while it is loading. */
  totpSecret: string;
  totpQr: QrSymbol | null;
  copyTotp: () => void;
  tPwVal: string;
  onTPw: (value: string) => void;
  tCodeVal: string;
  onTCode: (value: string) => void;
  tKey: (event: KeyInput) => void;
  tErr: string;
  hasTErr: boolean;
  tNameErr: string;
  hasTNameErr: boolean;
  tStale: boolean;
  tRestart: () => void;
  totpBusy: boolean;
  totpCancel: () => void;
  totpGo: () => void;
  totpGoLabel: string;
  rcOn: boolean;
  rcOff: boolean;
  rcShow: boolean;
  rcForm: boolean;
  rcNoForm: boolean;
  rcSum: string;
  rcSub: string;
  rcCodes: { code: string; n: string }[];
  rcCopy: () => void;
  rcDownload: () => void;
  rcDone: () => void;
  rcRegen: () => void;
  rcPwVal: string;
  onRcPw: (value: string) => void;
  rcCodeVal: string;
  onRcCode: (value: string) => void;
  rcKey: (event: KeyInput) => void;
  rcErr: string;
  hasRcErr: boolean;
  rcBusy: boolean;
  rcCancel: () => void;
  rcGo: () => void;
  sessList: SessionValues[];
  hasOtherSess: boolean;
  revokeOthers: () => void;
}

export interface SecurityContext {
  /** Scroll to the section. */
  scrollTo: (section: Section) => void;
}

const DEVICE_ICON: Record<ListedSession['device_type'], IconName> = {
  desktop: 'ti-device-desktop',
  mobile: 'ti-device-mobile',
  tablet: 'ti-device-tablet',
};

function eye(shown: boolean): Pick<PwFieldValues, 'eyeIcon' | 'eyeTip'> {
  return { eyeIcon: shown ? 'ti-eye-off' : 'ti-eye', eyeTip: shown ? m.password_hide() : m.password_show() };
}

function pwFields(p: SecurityPage): PwFieldValues[] {
  const fields: Omit<PwFieldValues, 'sep'>[] = [
    {
      label: m.reauth_password_label(),
      desc: m.reauth_password_desc(),
      ac: 'current-password',
      im: 'text',
      type: p.pwShowCur ? 'text' : 'password',
      value: p.pwCur,
      hasEye: true,
      ...eye(p.pwShowCur),
      onChange: (value) => p.setPw('pwCur', value),
      onEye: () => (p.pwShowCur = !p.pwShowCur),
    },
  ];
  if (p.mfa) {
    fields.push({
      label: m.reauth_code_label(),
      desc: m.reauth_code_desc(),
      ac: 'one-time-code',
      im: 'numeric',
      type: 'text',
      value: p.pwOtp,
      hasEye: false,
      ...eye(false),
      onChange: (value) => p.setPwOtp(value),
    });
  }
  fields.push(
    {
      label: m.security_new_password(),
      desc: m.security_pw_rule(),
      ac: 'new-password',
      im: 'text',
      type: p.pwShowNew ? 'text' : 'password',
      value: p.pwNew,
      hasEye: true,
      ...eye(p.pwShowNew),
      onChange: (value) => p.setPw('pwNew', value),
      onEye: () => (p.pwShowNew = !p.pwShowNew),
    },
    {
      label: m.security_confirm_password(),
      desc: m.security_confirm_desc(),
      ac: 'new-password',
      im: 'text',
      type: 'password',
      value: p.pwConf,
      hasEye: false,
      ...eye(false),
      onChange: (value) => p.setPw('pwConf', value),
    },
  );
  return fields.map((f, i) => ({ ...f, sep: i > 0 }));
}

function totpIntro(p: SecurityPage): string {
  if (p.totpMode === 'setup') return m.security_totp_intro_add();
  const name = p.devices.find((d) => d.id === p.totpTarget)?.name ?? '';
  return p.devices.length === 1 ? m.security_totp_intro_remove_last({ name }) : m.security_totp_intro_remove({ name });
}

function sessionSub(s: ListedSession, now: number): string {
  const where = s.place ?? (s.ip ? m.security_session_ip({ ip: s.ip }) : '');
  const when = s.current
    ? m.security_session_now()
    : m.security_session_last({ ago: ago(ms(s.last_seen_at, now), now) });
  return [where, when].filter(Boolean).join(' · ');
}

/** Values of the page. */
export function securityValues(p: SecurityPage, ctx: SecurityContext, now = Date.now()): SecurityValues {
  const { dateFmt: fmt, tz } = prefs.values;
  const changed = session.user?.password_changed_at;
  const sessions = p.sessions.filter((s) => !p.hidden.has(s.id));
  const setup = p.totpMode === 'setup';
  const rc = p.recovery;
  return {
    skSet: p.status === 'loading' && p.loading.slow,
    secTabs: [
      { label: m.security_tab_password(), onClick: () => ctx.scrollTo('password') },
      { label: m.security_tab_mfa(), onClick: () => ctx.scrollTo('2fa') },
      { label: m.security_tab_sessions(), onClick: () => ctx.scrollTo('sessions') },
    ],
    secSso: false,
    secNotSso: true,
    pwDesc: changed ? m.security_pw_changed({ ago: ago(ms(changed, now), now) }) : '',
    pwFields: pwFields(p),
    pwKey: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void p.changePassword();
      }
    },
    pwMsg: p.pwErr ?? '',
    hasPwMsg: !!p.pwErr,
    pwDis: !p.pwReady,
    pwBusy: p.pwBusy,
    pwSubmit: () => void p.changePassword(),
    tfaEntries: p.devices.map((d, i) => {
      const added = m.security_app_added_at({ date: formatDate(ms(d.created_at, now), fmt, tz) });
      const used = d.last_used_at ? m.security_app_used({ ago: ago(ms(d.last_used_at, now), now) }) : '';
      return {
        id: d.id,
        name: d.name,
        sub: [added, used].filter(Boolean).join(' · '),
        sep: i > 0,
        delLabel: m.security_app_remove_label({ name: d.name }),
        selected: p.totpMode === 'off' && p.totpTarget === d.id,
        onRemove: () => p.askRemove(d.id),
      };
    }),
    tfaEmpty: !p.mfa,
    tfaAdd: () => void p.addApp(),
    totpPanel: p.totpMode !== null,
    totpNoPanel: p.totpMode === null,
    totpSetup: setup,
    tNameVal: p.tName,
    onTName: (value) => p.setTName(value),
    totpIntro: p.totpMode ? totpIntro(p) : '',
    totpSecret: (p.enrollment?.secret.match(/.{1,4}/g) ?? []).join(' '),
    totpQr: p.qr,
    copyTotp: () => void p.copySecret(),
    tPwVal: p.tPw,
    onTPw: (value) => p.setTPw(value),
    tCodeVal: p.tCode,
    onTCode: (value) => p.setTCode(value),
    tKey: (event) => p.totpKey(event),
    tErr: p.tErr ?? '',
    hasTErr: !!p.tErr,
    tNameErr: p.tNameErr ?? '',
    hasTNameErr: !!p.tNameErr,
    tStale: p.tStale,
    tRestart: () => p.restartApp(),
    totpBusy: p.tBusy || (setup && !p.enrollment),
    totpCancel: () => p.cancelTotp(),
    totpGo: () => void p.confirmTotp(),
    totpGoLabel: setup ? m.security_add() : m.security_remove(),
    rcOn: p.mfa,
    rcOff: !p.mfa,
    rcShow: p.codes !== null,
    rcForm: p.mfa && p.rcForm,
    rcNoForm: p.mfa && !p.rcForm,
    rcSum: m.security_rc_sum({ unused: rc?.unused ?? 0, total: rc?.total ?? 10 }),
    rcSub: rc ? m.security_rc_sub({ ago: ago(ms(rc.created_at, now), now) }) : '',
    rcCodes: (p.codes ?? []).map((code, i) => ({ code, n: String(i + 1) })),
    rcCopy: () => void p.copyCodes(),
    rcDownload: () => p.downloadCodes(),
    rcDone: () => p.doneCodes(),
    rcRegen: () => p.openRegen(),
    rcPwVal: p.rcPw,
    onRcPw: (value) => p.setRcPw(value),
    rcCodeVal: p.rcCode,
    onRcCode: (value) => p.setRcCode(value),
    rcKey: (event) => p.rcKey(event),
    rcErr: p.rcErr ?? '',
    hasRcErr: !!p.rcErr,
    rcBusy: p.rcBusy,
    rcCancel: () => p.cancelRegen(),
    rcGo: () => void p.regenerate(),
    sessList: sessions.map((s) => ({
      id: s.id,
      icon: DEVICE_ICON[s.device_type] ?? 'ti-device-desktop',
      name: s.app ? m.security_session_app({ app: session.appName, system: s.app }) : s.device,
      sub: sessionSub(s, now),
      current: s.current,
      notCurrent: !s.current,
      onRevoke: () => p.revoke(s.id),
    })),
    hasOtherSess: sessions.some((s) => !s.current),
    revokeOthers: () => p.revokeOthers(),
  };
}
