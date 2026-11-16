/**
 * Flow of the setup page against the setup API: six steps with their checks,
 * then `setup/complete`. The setup token goes along in the header
 * `X-Setup-Token` in steps 2–6; every response can reject it (back to step 1)
 * or report that the setup is already complete (then the page reloads the
 * session and the layout redirects to the sign-in).
 *
 * Where the API reports more than success or an error, the page picks its own
 * texts per reason.
 */
import { ApiError, api, fieldsOf, retryAfter } from '#lib/api.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { csp } from '#lib/csp.ts';
import {
  adminRejected,
  diagText,
  registrationText,
  throttleText,
  type DiagContext,
  type DiagLine,
  type DiagReasons,
  type DiagStatus,
} from '#lib/diagnosis.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { nameError, nameErrorText } from '#lib/name.ts';
import { meetsPolicy, tooLong } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { MAX_DOMAINS, domainsOf, hostOf, httpOther, isDomain, localHttp, normUrl, originOf } from '#lib/url.ts';
import { session } from '#lib/state/session.svelte.ts';
import { waitText } from '#lib/wait.ts';

/** Command in the terminal box of step 1. */
export const LOG_CMD = 'docker logs roedy-mail 2>&1 | grep Setup-Token';

/** Duration of the welcome page until the sign-in (progress bar 2.6 s). */
export const DONE_MS = 2700;

export type Step = 1 | 2 | 3 | 4 | 5 | 6;
export type Field =
  | 'token'
  | 'name'
  | 'email'
  | 'pw'
  | 'pw2'
  | 'srv'
  | 'srvLabel'
  | 'srvDoms'
  | 'pub'
  | 'oaUser'
  | 'oaPw'
  | 'oaCid'
  | 'oaSec'
  | 'sysUser'
  | 'sysPw';

/** `true` marks a field without its own text (password rules as chips). */
export type FieldError = string | true;
/** Errors per field; `oa` sits below the OAuth client. */
export type Errors = { [K in Field | 'oa']?: FieldError | undefined };
export type OaMode = 'auto' | 'manual';
export type { DiagStatus } from '#lib/diagnosis.ts';

/** Values of the page. */
export interface SetupPageValues {
  appVersion: string;
}

/** Response of `setup/servers/test`. */
export interface ProbeReport {
  url: string;
  host: string;
  reach: DiagStatus;
  cors: DiagStatus;
  oauth: DiagStatus;
  /** Reasons per row. */
  reasons?: DiagReasons;
  /** Wait time in seconds if the mail server throttled. */
  retry_after?: number;
}

export interface DiagRow {
  label: string;
  sub: string;
  status: DiagStatus;
  /** Text per result and reason. */
  text: string;
}

/** Failed test of the sending account: icon, title and text per reason. */
export interface SysError {
  icon: IconName;
  title: string;
  text: string;
}

export interface ReviewRow {
  icon: 'ti-user-shield' | 'ti-server' | 'ti-key' | 'ti-world' | 'ti-mail-cog' | 'ti-mail-off';
  label: string;
  value: string;
  muted: boolean;
  step: Step;
  /** Server after "Continue anyway" with notices. */
  warn?: boolean;
}

/** Phase of the page; decides the icon of the tile in the background. */
export type Phase =
  'token' | 'admin' | 'password' | 'server' | 'system' | 'review' | 'loading' | 'error' | 'locked' | 'success';

export interface SetupHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: Field) => void;
  /** Step changed: focus the field. */
  entered?: (step: Step, field?: Field) => void;
  /** Error without a text of its own: error toast (`ui.toasts.error`). */
  error?: (text: string) => void;
  /** Reload the session: after completion signed in to the start page, on `setup_done` to the sign-in. */
  reload?: () => Promise<void>;
}

/** Token input: upper case, pasted `XXXX-XXXX-XXXX` recognised, in groups of four. */
export function formatToken(input: string): string {
  const upper = input.toUpperCase();
  const match = /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(upper);
  const raw = (match ? match[0] : upper).replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return (raw.match(/.{1,4}/g) ?? []).join('-');
}

/**
 * Redirect URI to copy like `servers::redirect_uri` of the backend: origin of
 * the public address + `/oauth/callback` (`https://`, or `http://localhost` for
 * development); without a valid address an example address.
 */
export function redirectOf(pub: string): string {
  const origin = originOf(normUrl(pub));
  return origin ? `${origin}/oauth/callback` : 'https://webmail.example.com/oauth/callback';
}

/**
 * Domain for the suggestions after the test: host without `mail.` etc.;
 * without a dot (or as an IP address) the domain of the email address.
 */
function domainOf(url: string, email: string): string {
  const host = hostOf(url).replace(/:\d+$/, '');
  const named = host.includes('.') && !/^\d+(\.\d+){3}$/.test(host);
  return named ? host.replace(/^(mail|mx|jmap|stalwart)\./, '') : (email.split('@')[1] ?? '');
}

/**
 * Error in the field "Public URL" before sending: empty, no address
 * or `http://` except on this machine (the backend also accepts `[::1]` there,
 * `normalize_public_url`).
 */
function pubError(raw: string): string | undefined {
  const url = normUrl(raw);
  if (!hostOf(url)) return raw.trim() ? m.setup_addr_invalid() : m.setup_pub_required();
  if (httpOther(url) && !/^\[::1\](:\d+)?$/.test(hostOf(url))) return m.server_http_other();
  return undefined;
}

/** Locks: setup token, registration of the OAuth client, throttled test of the mail server, test of the system mail. */
type LockKind = 'token' | 'oa' | 'srv' | 'sys';

export class SetupFlow {
  step = $state<Step>(1);
  view = $state<'form' | 'done'>('form');
  loading = $state(false);
  err = $state<Errors>({});

  // Step 1
  token = $state('');
  tokErr = $state<'short' | 'invalid' | 'locked' | null>(null);
  /** Attempts until the lock from `remaining`. */
  remaining = $state<number | null>(null);

  // Steps 2 and 3
  name = $state('');
  email = $state('');
  pw = $state('');
  pw2 = $state('');

  // Step 4
  srv = $state('');
  srvLabel = $state('');
  srvDoms = $state('');
  pub = $state('');
  /** Preset via `ROEDY_PUBLIC_URL` (response of `setup/token`). */
  pubLocked = $state(false);
  /** Result of the test; `thr`: the JMAP session was already throttled. */
  srvSt = $state<'busy' | 'ok' | 'warn' | 'err' | 'thr' | null>(null);
  /** Tested address and the public address for it. */
  srvOk = $state('');
  report = $state<ProbeReport | null>(null);
  oaMode = $state<OaMode>('auto');
  oaUser = $state('');
  oaPw = $state('');
  oaCid = $state('');
  oaSec = $state('');
  oaSt = $state<'busy' | 'ok' | 'err' | null>(null);
  /**
   * Registration failed: a reason of `registration_failed`, the own lock
   * (429) or Stalwart throttles with a wait time (`throttled`).
   */
  oaErr = $state<'reg' | 'limit' | 'throttled' | null>(null);
  /** Reason and detail (`detail` for `rejected`) of `registration_failed`. */
  oaReason = $state<string | null>(null);
  oaDetail = $state<string | null>(null);
  /** Client ID of the last registration; its secret lives in the backend. */
  oaRegCid = $state('');
  /** Server and redirect URI that are or were registered for. */
  private oaFor = { srv: '', redirect: '' };
  /** Server that throttles the registration (`throttled`); the lock applies only to it. */
  private oaThrFor = $state('');

  // Step 5
  sysUser = $state('');
  sysPw = $state('');
  sysSt = $state<'busy' | 'ok' | 'err' | 'locked' | null>(null);
  sysOk = $state('');
  sysSkip = $state(false);
  /** Reason of the failed test (`mail_failed` › `reason`). */
  sysReason = $state<string | null>(null);

  /** Locks with countdown (the clock only runs while one applies). */
  readonly locks = new Countdown<LockKind>((kind) => this.freed(kind));
  private doneTimer: ReturnType<typeof setTimeout> | undefined;
  /** Running requests; a change invalidates their response. */
  private srvReq = 0;
  private oaReq = 0;
  private sysReq = 0;

  readonly hooks: SetupHooks;

  constructor(hooks: SetupHooks = {}) {
    this.hooks = hooks;
  }

  // ---- Derivations ----

  locked = $derived(this.locks.active('token'));
  tokLeft = $derived(this.locks.left('token'));
  oaLeft = $derived(this.locks.left('oa'));
  srvLeft = $derived(this.locks.left('srv'));
  sysLeft = $derived(this.locks.left('sys'));

  srvUrl = $derived(normUrl(this.srv));
  srvGood = $derived(this.srvSt === 'ok' && this.srvOk === this.srvUrl);
  /** Test with notices: reachable, but CORS or OAuth client not OK or not checked. */
  srvWarn = $derived(this.srvSt === 'warn' && this.srvOk === this.srvUrl);
  srvPlain = $derived(this.srvGood && localHttp(this.srvUrl));
  sysKey = $derived(`${this.srvOk}\n${this.sysUser.trim()}\n${this.sysPw}`);
  sysGood = $derived(this.sysSt === 'ok' && this.sysOk === this.sysKey);
  redirect = $derived(redirectOf(this.pub));
  /** Host of the public address for diagnosis and overview. */
  pubHost = $derived(hostOf(normUrl(this.pub)));

  tokErrText = $derived.by(() => {
    if (this.tokErr === 'locked') return m.setup_token_locked_text({ wait: waitText(this.tokLeft) });
    const n = this.remaining;
    const rest = n === null ? '' : ` ${n === 1 ? m.setup_token_remaining_one() : m.setup_token_remaining({ n })}`;
    return m.setup_token_invalid_text() + rest;
  });

  /** Error below "Register client automatically" or the manual client; locks as their own box. */
  oaErrText = $derived.by(() => {
    if (this.oaErr === 'reg') return registrationText(this.oaReason, this.oaDetail, session.appName);
    if (this.oaErr) return '';
    return typeof this.err.oa === 'string' ? this.err.oa : '';
  });

  /** 429 during registration: box "Too many attempts." with a running wait time. */
  oaLocked = $derived(this.oaErr === 'limit' && this.oaLeft > 0);
  oaLockText = $derived(m.limit_text({ wait: waitText(this.oaLeft) }));
  /** Stalwart throttles the registration (`throttled` with `retry_after`): box "Too many requests.", only for this server. */
  oaThr = $derived(this.oaErr === 'throttled' && this.oaLeft > 0 && this.oaThrFor === this.srvUrl);
  oaThrText = $derived(throttleText(session.appName, this.oaLeft));
  /** Remaining time for which "Register client automatically" is locked: lock by Roedy or throttling by this server. */
  oaWait = $derived(this.oaErr !== 'throttled' || this.oaThrFor === this.srvUrl ? this.oaLeft : 0);
  /** Notice at the client secret field: with the client ID of the registration of the same server its secret lives in the backend. */
  oaSecHint = $derived(
    this.oaRegCid && this.oaCid.trim() === this.oaRegCid && this.srvUrl === this.oaFor.srv
      ? m.server_secret_registered()
      : m.setup_csec_hint(),
  );

  /** The JMAP session was already throttled: box "Too many requests.", button locked until expiry. */
  srvThr = $derived(this.srvSt === 'thr' && this.srvLeft > 0);
  srvThrText = $derived(throttleText(session.appName, this.srvLeft, true));
  srvDis = $derived(this.srvSt === 'busy' || this.srvThr);

  /** 429 `auth_locked` when testing the sending account. */
  sysLimitText = $derived(m.setup_sys_lock_text({ app: session.appName, wait: waitText(this.sysLeft) }));

  sysError = $derived.by((): SysError => {
    const reason = this.sysReason ?? '';
    if (reason === 'auth_failed' || reason === 'forbidden')
      return { icon: 'ti-lock-x', title: m.setup_mail_bad_title(), text: m.setup_mail_bad_text() };
    if (reason === 'unreachable')
      return { icon: 'ti-plug-connected-x', title: m.setup_sys_unreachable_title(), text: m.setup_sys_unreachable() };
    if (reason === 'no_identity')
      return { icon: 'ti-id-off', title: m.setup_sys_no_identity_title(), text: m.setup_sys_no_identity() };
    if (reason === 'no_mailbox')
      return { icon: 'ti-folder-off', title: m.setup_sys_no_mailbox_title(), text: m.setup_sys_no_mailbox() };
    return { icon: 'ti-alert-triangle', title: m.setup_sys_other_title(), text: m.setup_sys_other() };
  });

  /** "No connection." with the text of the reason. */
  srvBadText = $derived(
    this.report ? diagText('reach', 'err', 'err', this.report.reasons, this.diagContext()) : m.setup_srv_bad_text(),
  );

  /** Diagnosis rows with notices, like in the administration. */
  diag = $derived.by((): DiagRow[] => {
    const r = this.report;
    const host = hostOf(this.srvOk);
    const pubHost = this.pubHost || 'webmail.example.com';
    const reach = r?.reach ?? 'ok';
    const ctx = this.diagContext();
    const rows: [DiagLine, string, string, DiagStatus][] = [
      ['reach', m.server_diag_jmap(), m.setup_diag_jmap({ host }), reach],
      ['cors', m.server_diag_cors(), m.setup_diag_cors({ host: pubHost }), r?.cors ?? 'ok'],
      [
        'oauth',
        m.server_diag_oauth(),
        this.oaCid ? m.setup_diag_cid({ cid: this.oaCid }) : m.setup_diag_registered(),
        r?.oauth ?? 'ok',
      ],
    ];
    return rows.map(([line, label, sub, status]) => ({
      label,
      sub,
      status,
      text: diagText(line, status, reach, r?.reasons, ctx),
    }));
  });

  review = $derived.by((): ReviewRow[] => {
    const srvHost = hostOf(this.srvOk) || hostOf(this.srvUrl);
    const label = this.srvLabel.trim();
    const cid = this.oaCid.trim();
    const mail = !this.sysSkip && this.sysGood;
    return [
      {
        icon: 'ti-user-shield',
        label: m.setup_review_admin(),
        value: `${this.name.trim()} · ${this.email.trim()}`,
        muted: false,
        step: 2,
      },
      {
        icon: 'ti-server',
        label: m.setup_review_server(),
        value: (label ? `${label} · ` : '') + srvHost,
        muted: false,
        step: 4,
        warn: this.srvWarn,
      },
      {
        icon: 'ti-key',
        label: m.setup_review_oauth(),
        value: cid || m.setup_review_oauth_none(),
        muted: !cid,
        step: 4,
      },
      { icon: 'ti-world', label: m.setup_review_public(), value: this.pubHost, muted: false, step: 4 },
      mail
        ? { icon: 'ti-mail-cog', label: m.setup_review_mail(), value: this.sysUser.trim(), muted: false, step: 5 }
        : {
            icon: 'ti-mail-off',
            label: m.setup_review_mail(),
            value: m.setup_review_mail_none(),
            muted: true,
            step: 5,
          },
    ];
  });

  /** Server of step 5. */
  sysSrv = $derived({
    label: this.srvLabel.trim() || hostOf(this.srvOk || this.srvUrl) || m.setup_mail_server(),
    host: hostOf(this.srvOk || this.srvUrl),
  });

  firstName = $derived(this.name.trim().split(/\s+/)[0] ?? '');

  phase = $derived.by((): Phase => {
    if (this.view === 'done') return 'success';
    if (this.loading || this.srvSt === 'busy' || this.sysSt === 'busy' || this.oaSt === 'busy') return 'loading';
    if (this.locked) return 'locked';
    if (
      (this.step === 1 && this.tokErr === 'invalid') ||
      (this.step === 4 && (this.srvSt === 'err' || this.srvSt === 'warn')) ||
      (this.step === 5 && (this.sysSt === 'err' || this.sysSt === 'locked')) ||
      Object.values(this.err).some(Boolean)
    )
      return 'error';
    return (['token', 'admin', 'password', 'server', 'system', 'review'] as const)[this.step - 1] ?? 'review';
  });

  // ---- Inputs ----

  /** Changes a field and discards what depends on it. */
  edit(field: Exclude<Field, 'token'>, value: string): void {
    this[field] = value;
    const err = { ...this.err, [field]: undefined };
    if (field === 'pw') err.pw2 = undefined;
    this.err = err;
    // The test checks CORS for the public address; a running test no longer applies afterwards.
    if (field === 'srv' || field === 'oaCid' || field === 'pub') this.cancelTest();
    // A registered client belongs to its server (otherwise a client of
    // another server), a running registration also to the redirect URI. A
    // public address changed afterwards is reported by "Test connection"
    // (`redirect_mismatch`).
    if ((field === 'srv' || field === 'pub') && this.oaMode === 'auto') {
      const other = this.srvUrl !== this.oaFor.srv;
      const busy = this.oaSt === 'busy' && (other || this.redirect !== this.oaFor.redirect);
      if (busy || (this.oaSt === 'ok' && other)) this.resetClient();
    }
    if (field === 'oaUser' || field === 'oaPw') {
      if (this.oaErr === 'reg') this.oaErr = null;
      if (this.oaSt === 'err') this.oaSt = null;
    }
    if ((field === 'sysUser' || field === 'sysPw') && this.sysSt !== 'locked') {
      this.sysReq++;
      this.sysSt = null;
    }
  }

  editToken(value: string): void {
    this.token = formatToken(value);
    if (this.tokErr !== 'locked') this.tokErr = null;
  }

  setOaMode(mode: OaMode): void {
    this.oaMode = mode;
    this.err = { ...this.err, oa: undefined, oaCid: undefined };
    if (this.oaErr === 'reg') this.oaErr = null;
    this.cancelTest();
  }

  /** "Redo" after the registration; also aborts a running one. */
  resetClient(): void {
    this.oaReq++;
    this.oaSt = null;
    this.oaCid = '';
    this.oaRegCid = '';
    this.oaFor = { srv: '', redirect: '' };
    this.cancelTest();
  }

  /** "Back"; not while completion is running. */
  back(): void {
    if (this.step > 1 && !this.loading) this.go((this.step - 1) as Step);
  }

  /** "Change" in the overview; not while completion is running. */
  revisit(step: Step): void {
    if (!this.loading) this.go(step);
  }

  go(step: Step, field?: Field): void {
    this.step = step;
    this.loading = false;
    this.err = {};
    this.hooks.entered?.(step, field);
  }

  // ---- Steps ----

  async submitToken(): Promise<void> {
    if (this.loading || this.locked) return;
    if (this.token.replace(/-/g, '').length < 12) {
      this.tokErr = 'short';
      this.hooks.fail?.('token');
      return;
    }
    this.loading = true;
    this.tokErr = null;
    try {
      const res = await api<{ public_url: string | null }>('POST', 'setup/token', { token: this.token });
      this.pubLocked = res.public_url !== null;
      // Preset (`ROEDY_PUBLIC_URL`), otherwise the address of this page.
      if (res.public_url !== null) this.pub = res.public_url;
      else if (!this.pub && /^https?:/.test(location.origin)) this.pub = location.origin;
      this.remaining = null;
      this.go(2, 'name');
    } catch (error) {
      this.loading = false;
      await this.rejected(error);
    }
  }

  submitAdmin(): void {
    const err: Errors = {};
    const nameBad = nameError(this.name);
    if (!this.name.trim()) err.name = m.setup_name_required();
    else if (nameBad) err.name = nameErrorText(nameBad);
    const email = this.email.trim();
    if (!isEmail(email)) err.email = email ? m.setup_email_invalid() : m.setup_email_required();
    if (this.failWith(err, ['name', 'email'])) return;
    this.go(3, 'pw');
  }

  submitPw(): void {
    const err: Errors = {};
    if (tooLong(this.pw)) err.pw = m.password_too_long();
    else if (!meetsPolicy(this.pw)) err.pw = true;
    else if (this.pw2 !== this.pw) err.pw2 = this.pw2 ? m.setup_pw2_mismatch() : m.setup_pw2_required();
    if (this.failWith(err, ['pw', 'pw2'])) return;
    this.go(4, this.srv ? undefined : 'srv');
  }

  /**
   * "Check and continue" or with `goOn` "Continue anyway": the same checks
   * of the fields, then continue if the test was OK or had notices; otherwise
   * test.
   */
  async submitServer(goOn = false): Promise<void> {
    if (this.srvDis) return;
    const url = this.srvUrl;
    const pub = normUrl(this.pub);
    const err: Errors = {};
    if (!hostOf(url)) err.srv = this.srv.trim() ? m.setup_addr_invalid() : m.setup_srv_required();
    else if (httpOther(url)) err.srv = m.server_http_other();
    if (!this.pubLocked) err.pub = pubError(this.pub);
    const doms = domainsOf(this.srvDoms);
    const bad = doms.find((d) => !isDomain(d));
    if (doms.length > MAX_DOMAINS) err.srvDoms = m.server_doms_max({ n: MAX_DOMAINS });
    else if (bad) err.srvDoms = m.setup_dom_invalid({ domain: bad });
    if (this.oaMode === 'manual' && !this.oaCid.trim()) err.oaCid = m.setup_cid_required();
    if (this.oaMode === 'auto' && this.oaSt !== 'ok') err.oa = m.setup_oa_first();
    if (this.failWith(err, ['srv'])) return;
    // Client of the registration, the public address changed since then.
    const regCid = this.oaRegCid && this.oaCid.trim() === this.oaRegCid;
    if (regCid && this.oaFor.redirect && this.oaFor.redirect !== this.redirect) {
      this.failWith(this.redirectMismatch(this.oaFor.redirect), ['oaCid']);
      return;
    }
    if (this.srvGood || (goOn && this.srvWarn)) {
      this.pub = pub;
      this.go(5, this.sysUser ? undefined : 'sysUser');
      return;
    }
    this.srv = url;
    this.pub = pub;
    this.srvSt = 'busy';
    this.err = {};
    const cid = this.oaCid.trim();
    // With a secret the diagnosis checks the sign-in of a confidential client.
    const secret = this.oaMode === 'manual' && this.oaSec.trim() !== '';
    const req = ++this.srvReq;
    try {
      const report = await api<ProbeReport>(
        'POST',
        'setup/servers/test',
        { url, public_url: pub, ...(cid ? { client_id: cid } : {}), ...(secret ? { has_secret: true } : {}) },
        this.withToken(),
      );
      // Changed in the meantime: the result no longer applies.
      if (req !== this.srvReq) return;
      this.report = report;
      // Throttled: the wait time locks the button or sits in the rows of the diagnosis.
      const wait = typeof report.retry_after === 'number' && report.retry_after > 0 ? report.retry_after : 0;
      const throttled = report.reasons?.reach === 'throttled';
      if (wait || throttled) this.locks.start('srv', wait || 30);
      else this.locks.clear('srv');
      if (report.reach !== 'ok') {
        this.srvSt = throttled ? 'thr' : 'err';
        this.srvOk = '';
        this.hooks.fail?.();
        return;
      }
      this.srvOk = url;
      const dom = domainOf(url, this.email);
      if (!this.sysUser && dom) this.sysUser = `noreply@${dom}`;
      if (!this.srvDoms.trim() && dom.includes('.')) this.srvDoms = dom;
      if (report.cors === 'ok' && report.oauth === 'ok') this.srvSt = 'ok';
      else {
        this.srvSt = 'warn';
        this.hooks.fail?.();
      }
    } catch (error) {
      if (req !== this.srvReq) return;
      this.srvSt = null;
      await this.rejected(error, { url: 'srv', public_url: 'pub', client_id: 'oaCid' });
    }
  }

  async registerClient(): Promise<void> {
    if (this.oaSt === 'busy' || this.oaWait > 0) return;
    const url = this.srvUrl;
    const err: Errors = {};
    if (!hostOf(url)) err.srv = m.setup_srv_first();
    else if (httpOther(url)) err.srv = m.server_http_other();
    if (!this.oaUser.trim()) err.oaUser = m.setup_oa_user_required();
    if (!this.oaPw) err.oaPw = m.setup_oa_pw_required();
    // The redirect URI derives from the public address.
    if (!this.pubLocked) err.pub = pubError(this.pub);
    if (this.failWith(err, ['srv'])) return;
    // A still running lock then belongs to the throttling of another server.
    if (this.oaErr === 'throttled') this.locks.clear('oa');
    this.oaSt = 'busy';
    this.oaErr = null;
    this.err = {};
    this.oaFor = { srv: url, redirect: this.redirect };
    const req = ++this.oaReq;
    try {
      const res = await api<{ client_id: string }>(
        'POST',
        'setup/servers/register-client',
        { url, username: this.oaUser.trim(), password: this.oaPw, public_url: normUrl(this.pub) },
        this.withToken(),
      );
      if (req !== this.oaReq) return;
      this.oaSt = 'ok';
      this.oaCid = res.client_id;
      this.oaRegCid = res.client_id;
      this.oaSec = '';
      this.oaUser = '';
      this.oaPw = '';
      this.cancelTest();
    } catch (error) {
      if (req !== this.oaReq) return;
      this.oaSt = 'err';
      if (error instanceof ApiError && error.code === 'registration_failed') {
        const reason = typeof error.body.reason === 'string' ? error.body.reason : null;
        const wait = error.body.retry_after;
        if (reason === 'throttled' && typeof wait === 'number' && wait > 0) {
          // Stalwart throttles (there 429 with `retry_after`): box with wait time, the fields stay.
          this.oaErr = 'throttled';
          this.oaThrFor = url;
          this.locks.start('oa', wait);
        } else {
          // Rejected sign-in: clear the app password (`forbidden` keeps the fields).
          if (adminRejected(reason)) this.oaPw = '';
          this.oaErr = 'reg';
          this.oaReason = reason;
          this.oaDetail = typeof error.body.detail === 'string' ? error.body.detail : null;
        }
        this.hooks.fail?.();
      } else if (error instanceof ApiError && error.status === 429) {
        // Limit of the registration (fail2ban of the mail server); the token lock
        // responds the same, but is much rarer here. The next
        // test then leads to step 1.
        this.oaErr = 'limit';
        this.locks.start('oa', retryAfter(error));
        this.hooks.fail?.();
      } else {
        this.oaSt = null;
        await this.rejected(error, { url: 'srv', username: 'oaUser', password: 'oaPw', public_url: 'pub' });
      }
    }
  }

  async submitSystem(): Promise<void> {
    if (this.sysSt === 'busy' || this.sysSt === 'locked') return;
    const err: Errors = {};
    const user = this.sysUser.trim();
    if (!isEmail(user)) err.sysUser = user ? m.setup_addr_invalid() : m.setup_mail_user_required();
    if (!this.sysPw) err.sysPw = m.setup_mail_pw_required();
    if (this.failWith(err, ['sysUser', 'sysPw'])) return;
    if (this.sysGood) {
      this.sysSkip = false;
      this.go(6);
      return;
    }
    const key = this.sysKey;
    this.sysSt = 'busy';
    this.err = {};
    const req = ++this.sysReq;
    try {
      await api(
        'POST',
        'setup/system-mail/test',
        { url: this.srvOk, user, app_password: this.sysPw },
        this.withToken(),
      );
      if (req !== this.sysReq) return;
      this.sysSt = 'ok';
      this.sysOk = key;
    } catch (error) {
      if (req !== this.sysReq) return;
      if (error instanceof ApiError && error.code === 'mail_failed' && (error.status === 422 || error.status === 502)) {
        // Rejected sign-in (422) or another reason of the mail server (502).
        this.sysSt = 'err';
        this.sysReason = typeof error.body.reason === 'string' ? error.body.reason : null;
        this.hooks.fail?.();
      } else if (error instanceof ApiError && error.code === 'mail_failed' && error.status === 429) {
        this.sysSt = 'locked';
        this.locks.start('sys', retryAfter(error));
        this.hooks.fail?.();
      } else {
        this.sysSt = null;
        await this.rejected(error, { user: 'sysUser', app_password: 'sysPw' });
      }
    }
  }

  /** Values for the texts of the diagnosis. */
  private diagContext(): DiagContext {
    return {
      origin: this.pubHost || 'webmail.example.com',
      redirect: this.redirect,
      app: session.appName,
      wait: this.srvLeft,
    };
  }

  /** "Continue anyway" after a test with notices: on to step 5, the server counts with notices. */
  goOn(): void {
    if (this.srvWarn) void this.submitServer(true);
  }

  skipSystem(): void {
    this.sysSkip = true;
    this.go(6);
  }

  async finish(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const cid = this.oaCid.trim();
    const secret = this.oaMode === 'manual' ? this.oaSec : '';
    const body = {
      name: this.name.trim(),
      email: this.email.trim(),
      password: this.pw,
      server: {
        label: this.srvLabel.trim(),
        url: this.srvOk,
        domains: domainsOf(this.srvDoms),
        client_id: cid,
        ...(secret ? { client_secret: secret } : {}),
      },
      public_url: normUrl(this.pub),
      ...(!this.sysSkip && this.sysGood
        ? { system_mail: { user: this.sysUser.trim(), app_password: this.sysPw } }
        : {}),
    };
    try {
      await api('POST', 'setup/complete', body, this.withToken());
      // The page dates from the time without a server: the next navigation loads the new CSP.
      csp.stale = true;
      this.loading = false;
      this.view = 'done';
      // The password is no longer needed.
      this.pw = this.pw2 = this.sysPw = this.oaSec = '';
      this.doneTimer = setTimeout(() => void this.hooks.reload?.(), DONE_MS);
    } catch (error) {
      this.loading = false;
      if (error instanceof ApiError && error.code === 'invalid') this.completeInvalid(error);
      else await this.rejected(error);
    }
  }

  /** Stops clocks and timers (when leaving the page). */
  dispose(): void {
    this.locks.stop();
    clearTimeout(this.doneTimer);
  }

  // ---- internal ----

  /** Aborts a running test and discards its result. */
  private cancelTest(): void {
    this.srvReq++;
    this.srvSt = null;
  }

  /**
   * The client was registered for another redirect URI (`redirect_mismatch`):
   * under "Automatic" back to the sign-in, under "Manual" an error at the
   * client ID field.
   */
  private redirectMismatch(uri: string): Errors {
    if (this.oaMode === 'auto') {
      this.resetClient();
      return { oa: m.reg_redirect_mismatch({ app: session.appName }) };
    }
    return { oaCid: m.reg_redirect_mismatch_manual({ uri }) };
  }

  private withToken() {
    return { headers: { 'X-Setup-Token': this.token } };
  }

  /** Sets errors and reports the first field in order; `true` if there were errors. */
  private failWith(err: Errors, order: Field[]): boolean {
    if (!Object.values(err).some(Boolean)) return false;
    this.err = err;
    this.hooks.fail?.(order.find((f) => err[f]));
    return true;
  }

  /** A lock has expired: release the field or message. */
  private freed(kind: LockKind): void {
    if (kind === 'token') {
      this.tokErr = null;
      if (this.step === 1) this.hooks.entered?.(1, 'token');
    } else if (kind === 'oa') {
      if (this.oaErr === 'limit' || this.oaErr === 'throttled') this.oaErr = null;
      if (this.oaSt === 'err') this.oaSt = null;
    } else if (kind === 'srv') {
      if (this.srvSt === 'thr') this.srvSt = null;
    } else if (this.sysSt === 'locked') {
      this.sysSt = null;
    }
  }

  /**
   * Responses every step can get: token wrong or locked (back to step 1), setup
   * already complete (reload, the layout redirects to the sign-in), field
   * errors (`fields` → field of the step); everything else as a toast.
   */
  private async rejected(error: unknown, fieldMap: Record<string, Field> = {}): Promise<void> {
    if (error instanceof ApiError) {
      if (error.code === 'setup_done') {
        await this.hooks.reload?.();
        return;
      }
      if (error.code === 'invalid_token') {
        const remaining = error.body.remaining;
        this.remaining = typeof remaining === 'number' ? remaining : null;
        if (this.step !== 1) this.go(1);
        this.tokErr = 'invalid';
        this.hooks.fail?.('token');
        return;
      }
      if (error.status === 429) {
        if (this.step !== 1) this.go(1);
        this.token = '';
        this.tokErr = 'locked';
        this.remaining = null;
        this.locks.start('token', retryAfter(error));
        this.hooks.fail?.();
        return;
      }
      if (error.code === 'invalid') {
        const err: Errors = {};
        for (const [path, { code }] of Object.entries(fieldsOf(error))) {
          const field = fieldMap[path];
          const text = field ? fieldText(field, code) : null;
          if (field && text) err[field] = text;
        }
        const first = Object.keys(err)[0] as Field | undefined;
        if (first) {
          this.err = err;
          this.hooks.fail?.(first);
          return;
        }
      }
    }
    this.hooks.error?.(failText(error));
  }

  /** Field errors of `setup/complete`: to the first affected step with the text of the field. */
  private completeInvalid(error: ApiError): void {
    const targets: Record<string, [Step, Field]> = {
      name: [2, 'name'],
      email: [2, 'email'],
      password: [3, 'pw'],
      'server.url': [4, 'srv'],
      'server.label': [4, 'srvLabel'],
      'server.domains': [4, 'srvDoms'],
      'server.client_id': [4, 'oaCid'],
      'server.client_secret': [4, 'oaSec'],
      public_url: [4, 'pub'],
      'system_mail.user': [5, 'sysUser'],
      'system_mail.app_password': [5, 'sysPw'],
    };
    let step: Step | null = null;
    let first: Field | undefined;
    const err: Errors = {};
    for (const [path, detail] of Object.entries(fieldsOf(error))) {
      const target = targets[path];
      if (!target) continue;
      const [at, field] = target;
      const mismatch = path === 'server.client_id' && detail.code === 'redirect_mismatch';
      let text: FieldError | null;
      if (mismatch) {
        // Public address changed after the registration: register again or
        // at the client ID field with the client's redirect URI.
        const uri =
          typeof detail.redirect_uri === 'string' ? detail.redirect_uri : this.oaFor.redirect || this.redirect;
        const found = this.redirectMismatch(uri);
        if (found.oa) err.oa = found.oa;
        text = found.oaCid ?? null;
      } else if (path === 'password' && detail.code === 'policy') text = true;
      else if (path === 'server.domains' && detail.code === 'invalid' && typeof detail.domain === 'string')
        text = m.setup_dom_invalid({ domain: detail.domain });
      else text = fieldText(field, detail.code);
      if (text) err[field] = text;
      else if (!mismatch) continue;
      if (step === null || at < step) {
        step = at;
        first = text ? field : undefined;
      }
    }
    if (step === null) {
      this.hooks.error?.(failText(error));
      return;
    }
    if (step === 4) this.cancelTest();
    this.go(step);
    this.err = err;
    this.hooks.fail?.(first);
  }
}

/** Text of an API field error; `null` without a matching text. */
function fieldText(field: Field, code: string): FieldError | null {
  const required = code === 'required';
  switch (field) {
    case 'name':
      return required
        ? m.setup_name_required()
        : code === 'too_long'
          ? m.error_name_long()
          : code === 'invalid'
            ? m.error_name_invalid()
            : null;
    case 'email':
      return required ? m.setup_email_required() : m.setup_email_invalid();
    case 'pw':
      return code === 'too_long' ? m.password_too_long() : null;
    case 'srv':
      return required ? m.setup_srv_required() : code === 'invalid' ? m.setup_addr_invalid() : null;
    case 'pub':
      return required ? m.setup_pub_required() : m.setup_addr_invalid();
    case 'oaCid':
      return required ? m.setup_cid_required() : code === 'invalid' || code === 'too_long' ? m.server_cid_bad() : null;
    case 'oaSec':
      return code === 'invalid' || code === 'too_long' ? m.server_secret_bad() : null;
    case 'srvDoms':
      return code === 'too_many' ? m.server_doms_max({ n: MAX_DOMAINS }) : null;
    case 'oaUser':
      return required ? m.setup_oa_user_required() : null;
    case 'oaPw':
      return required ? m.setup_oa_pw_required() : null;
    case 'sysUser':
      return required ? m.setup_mail_user_required() : m.setup_addr_invalid();
    case 'sysPw':
      return required ? m.setup_mail_pw_required() : null;
    default:
      return null;
  }
}
