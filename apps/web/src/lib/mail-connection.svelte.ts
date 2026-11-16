/**
 * Mail account › Connection: the "Sign in again" part via `mailLogin.re`,
 * the account facts (including the "Mail server" row), "Check connection"
 * via `mailCheck` and "Remove account" with confirmation and undo. The mail
 * account layout shows the header; the app layout leads an unknown account
 * to the list.
 *
 * Signing in again only works with the account's server, without a choice
 * and with its sign-in type; if it is neither in the server list nor are
 * own servers allowed (`blocked`), the page shows `raBlocked` instead of the
 * form. With "Sign-in required" the form with the account's details is
 * there right away; `mailLogin.re` only opens it with the first input or
 * "Continue to sign-in". For a connected account "Sign in again" opens it.
 * Leaving the page closes it – a running step aborts, a sign-in already
 * taken over stays in `accounts`. After returning from the sign-in page
 * (`/oauth/callback`) the step `ret` is already there. After `done` it
 * closes after 1.8 seconds with the toast "Signed in to ‹host›".
 */
import { isApiError } from '#lib/api.ts';
import { mailLogin, freshForm, type FlowState, type LoginFlow, type MailLogin } from '#lib/auth/mail-login.svelte.ts';
import type { LoginForm } from '#lib/auth/stalwart-login.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import type { KeyInput } from '#lib/keys.ts';
import { failText } from '#lib/errors.ts';
import { mailCheck } from '#lib/mail-account.svelte.ts';
import { mailPush } from '#lib/mail-push.svelte.ts';
import { flowValues, reportFailure, serverName, serversAct, type FlowValues } from '#lib/mail-accounts.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Waiting time until closing after `done` of "Sign in again". */
export const RE_DONE_DELAY = 1800;

/**
 * Page that owns the form. When the layout switches between desktop and
 * mobile, the page is recreated at the same address before the old one
 * goes; the old one then no longer closes the form.
 */
const owners = new WeakMap<LoginFlow, MailConnectionPage>();

/** Targets of the page; the route sets them with `goto` and `resolve`. */
export interface MailConnectionNav {
  /** Administration › Mail servers ("Check mail servers"). */
  servers: () => void;
}

export class MailConnectionPage {
  /** ID of the account from the address. */
  readonly id: string;
  readonly nav: MailConnectionNav;
  readonly login: MailLogin;
  /** Access token readable. */
  showToken = $state(false);
  /** Clock for "Try again in …" while `lockUntil` applies. */
  readonly clock = new Countdown<'rate'>();

  #doneFor: string | null = null;
  #doneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(id: string, nav: MailConnectionNav, login: MailLogin = mailLogin) {
    this.id = id;
    this.nav = nav;
    this.login = login;
  }

  get flow(): LoginFlow {
    return this.login.re;
  }

  /** Account of the page; `undefined` while the list is unknown or it is missing. */
  get account(): MailAccount | undefined {
    return accounts.get(this.id);
  }

  /** Form of this account in `mailLogin.re`, also with a locked server (timer after `done`, error toast). */
  get own(): FlowState | null {
    return this.flow.account === this.id ? this.flow.form : null;
  }

  /**
   * Server not allowed: per the list, or because the attempt
   * found no server anymore with the current server list (`nosrv`; the list
   * then reloads).
   */
  get blocked(): boolean {
    return !!this.account?.blocked || this.own?.err === 'nosrv';
  }

  /** Open form of this account; none with a locked server. */
  get form(): FlowState | null {
    return this.account && !this.blocked ? this.own : null;
  }

  /** Form visible: "Sign-in required" or opened, server allowed. */
  get formShown(): boolean {
    const a = this.account;
    return !!a && !this.blocked && (a.state === 'needs_reauth' || this.form !== null);
  }

  /**
   * The page takes over the form (also one from the return via
   * `/oauth/callback`) and loads the server list for the "Mail server" row
   * if it is unknown or does not know the account's server yet (added to
   * the registry in the meantime).
   */
  start(): void {
    owners.set(this.flow, this);
    const list = this.login.servers;
    const server = this.account?.server_id;
    if (!list || (server && !list.servers.some((s) => s.id === server))) {
      void this.login.loadServers().catch(() => {});
    }
  }

  /**
   * Leaving the page: stop the clocks, close the account's form. A rebuild
   * of the same page (desktop ↔ mobile) takes it over; the page of another
   * account (`{#key}`), which is also created before this one ends, does not.
   */
  dispose(): void {
    clearTimeout(this.#doneTimer);
    this.clock.stop();
    const owner = owners.get(this.flow);
    if (owner !== this && owner?.id === this.id) return;
    if (owner === this) owners.delete(this.flow);
    if (this.flow.account === this.id) this.flow.close();
  }

  /** "Sign in again": form with address, server and sign-in type of the account. */
  open(): void {
    if (!this.#take()) return;
    this.showToken = false;
  }

  /** Changes fields; with "Sign-in required" the first input opens the form ("Show" stays). */
  edit(patch: Partial<LoginForm>): void {
    if (this.form || this.#take()) this.flow.update(patch);
  }

  /** "Continue to sign-in" or "Connect". */
  submit(): void {
    if (!this.formShown) return;
    if (this.form || this.#take()) void this.flow.submit();
  }

  /** Opens the form with the account's details; not with a locked server. */
  #take(): boolean {
    const a = this.account;
    if (!a || this.blocked) return false;
    owners.set(this.flow, this);
    this.flow.open(a);
    return true;
  }

  /** "Cancel" (only for a connected account). */
  cancel(): void {
    this.flow.close();
    this.showToken = false;
  }

  toggleToken(): void {
    this.showToken = !this.showToken;
  }

  /** "Check connection": as in the overview, with a toast. */
  check(): void {
    void mailCheck.run(this.id);
  }

  /**
   * "Remove": confirmation, then the account disappears from the list with
   * undo; `DELETE mail-accounts/:id` only goes out after the toast expires.
   * The app layout then leads to the list.
   */
  remove(): void {
    const a = this.account;
    if (!a) return;
    ui.ask({
      title: m.mail_connection_remove_title({ email: a.email }),
      text: m.mail_connection_remove_text({ app: session.appName, host: a.host }),
      icon: 'ti-mail-off',
      ok: m.mail_connection_remove(),
      danger: true,
      run: () => removeAccount(a),
    });
  }

  /** Enter sends (Escape only closes "New email account"). */
  key(event: KeyInput): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.submit();
  }

  /** Keeps the lock clock running after `rate` (`lockUntil` of `mailLogin.re`), also with the form closed – otherwise `lockLeft` would stall. */
  watchLock(until: number): void {
    const left = (until - Date.now()) / 1000;
    if (left > 0) this.clock.start('rate', left);
  }

  /** Remaining lock time in whole seconds; 0 = free. */
  get lockLeft(): number {
    return Math.max(0, Math.ceil((this.flow.lockUntil - this.clock.now) / 1000));
  }

  /** Close after `done`, once per sign-in. */
  arm(form: FlowState | null): void {
    const id = form?.step === 'done' ? form.done : null;
    if (id === this.#doneFor) return;
    clearTimeout(this.#doneTimer);
    this.#doneFor = id;
    if (id) this.#doneTimer = setTimeout(() => this.finish(), RE_DONE_DELAY);
  }

  /** Form closed, "Show" off, toast "Signed in to ‹host›" – not if the server has been locked in the meantime. */
  finish(): void {
    clearTimeout(this.#doneTimer);
    if (this.own?.step !== 'done') return;
    const blocked = this.blocked;
    this.flow.close();
    this.showToken = false;
    if (!blocked) ui.toasts.show(m.mail_login_signed_in({ host: serverName(this.account?.host ?? '') }));
  }

  /**
   * Errors without a key of their own as an error toast (`reportFailure`);
   * not for 409 `blocked` and 404 – then the reloaded list shows `raBlocked`
   * or the page leads to the list.
   */
  report(form: FlowState | null): void {
    const failure = form?.failure;
    if (isApiError(failure, 409, 'blocked') || isApiError(failure, 404)) return;
    reportFailure(this.flow, form);
  }
}

/** Hide the account, toast "‹address› removed" with undo; if the removal fails, it is back. */
function removeAccount(a: MailAccount): void {
  if (!accounts.hide(a.id)) return;
  ui.toasts.defer({
    text: m.mail_connection_removed({ email: a.email }),
    revert: () => accounts.restore(a.id),
    commit: async (keepalive) => {
      // When closing the page there is not enough time; the next start takes care of it.
      if (!keepalive) await mailPush.disable(a.id);
      await accounts.remove(a.id, keepalive);
    },
    onError: (error) => ui.toasts.error(failText(error)),
  });
}

// Values of the page

/** Row of the facts. */
export interface ConnectionFact {
  k: string;
  v: string;
}

/** Facts, "Check connection" and "Remove account". */
export interface ConnectionValues {
  /** Base URL, user name (not with token), sign-in, with "Advanced" the JMAP session. */
  facts: ConnectionFact[];
  /** "Check connection" or "Checking". */
  checkLabel: string;
  /** Check running. */
  busy: boolean;
  /** Rotation of the icon in degrees. */
  rot: number;
  check: () => void;
  remove: () => void;
}

/** "Sign in again". */
export type ReFlowValues = FlowValues;

export interface MailConnectionValues {
  maC: ConnectionValues;
  /** "Mail server" row: "‹name› · ‹host›" or "‹host› · not in the server list". */
  raServer: string;
  /** Server not (anymore) in the server list: warning icon with tooltip before `raServer`. */
  raServerWarn: boolean;
  ra: ReFlowValues;
  /** "Sign in again" box: sign-in rejected, form opened or server no longer allowed. */
  raShow: boolean;
  /** "Sign-in required": notice `raIntro` above the form. */
  raNeeds: boolean;
  /** "Sign in again" button (connected, form closed, server allowed). */
  raIdle: boolean;
  /** Form opened for a connected account: heading "Sign in again" and "Cancel". */
  raFree: boolean;
  /** Signing in again possible (server allowed). */
  raForm: boolean;
  /** Server neither in the server list nor allowed as an own server: notice instead of the form. */
  raBlocked: boolean;
  raBlockText: string;
  /** "Check mail servers" below the notice, only with `showAdmin`. */
  raBlockAdm: boolean;
  raBlockGo: () => void;
  raStart: () => void;
  raIntro: string;
}

/** Values of "Sign in again": texts always name the account's host. */
function reFlow(p: MailConnectionPage, a: MailAccount, form: FlowState): ReFlowValues {
  const host = a.host;
  const tok = form.auth === 'token';
  return {
    ...flowValues({
      form,
      host,
      domain: a.email.split('@')[1] ?? '',
      email: a.email,
      left: p.lockLeft,
      filled: !tok || !!form.token.trim(),
      showToken: p.showToken,
      act: serversAct(form.err, () => p.nav.servers()),
    }),
    pwHint: m.mail_login_re_pw_hint({ host: serverName(host), email: a.email }),
    onSec: (value) => p.edit({ token: value }),
    onEye: () => p.toggleToken(),
    retText: m.mail_login_ret_re({ app: session.appName }),
    submit: () => p.submit(),
    key: (event) => p.key(event),
    cancel: () => p.cancel(),
    doneTitle: m.mail_login_done_re(),
    doneText: m.mail_login_done_re_text({ host: serverName(host) }),
  };
}

/** Facts of the account; "Username" is the name of the JMAP session. */
function factsOf(a: MailAccount): ConnectionFact[] {
  const tok = a.auth_kind === 'token';
  return [
    { k: m.mail_connection_fact_url(), v: a.url },
    ...(tok ? [] : [{ k: m.mail_connection_fact_user(), v: a.username }]),
    { k: m.mail_connection_fact_auth(), v: tok ? m.mail_connection_auth_token() : m.mail_connection_auth_password() },
    ...(prefs.values.advanced ? [{ k: m.mail_connection_fact_session(), v: `${a.url}/.well-known/jmap` }] : []),
  ];
}

/**
 * "Mail server" row: a locked account and an own server are not in the
 * server list; while the list is not loaded,
 * only the host is there.
 */
function serverRow(p: MailConnectionPage, a: MailAccount): { raServer: string; raServerWarn: boolean } {
  if (a.blocked || a.server_id === null) {
    return { raServer: m.mail_connection_server_unlisted({ host: a.host }), raServerWarn: true };
  }
  const label = p.login.servers?.servers.find((s) => s.id === a.server_id)?.label;
  return { raServer: label ? m.mail_connection_server_listed({ label, host: a.host }) : a.host, raServerWarn: false };
}

/** Values of the page; `null` while the account is unknown. */
export function mailConnectionValues(p: MailConnectionPage): MailConnectionValues | null {
  const a = p.account;
  if (!a) return null;
  const blocked = p.blocked;
  const needs = a.state === 'needs_reauth';
  const own = p.form;
  const mine = own !== null;
  const busy = mailCheck.busy === a.id;
  return {
    maC: {
      facts: factsOf(a),
      checkLabel: busy ? m.mail_account_checking() : m.mail_account_check(),
      busy,
      rot: mailCheck.rot,
      check: () => p.check(),
      remove: () => p.remove(),
    },
    ...serverRow(p, a),
    ra: reFlow(p, a, own ?? freshForm(a)),
    raShow: needs || mine || blocked,
    raNeeds: needs,
    raIdle: !needs && !mine && !blocked,
    raFree: !needs && mine,
    raForm: !blocked,
    raBlocked: blocked,
    raBlockText: m.mail_login_ra_blocked({ host: a.host }),
    raBlockAdm: blocked && session.isAdmin,
    raBlockGo: () => p.nav.servers(),
    raStart: () => p.open(),
    raIntro: m.mail_login_ra_intro({ host: a.host }),
  };
}
