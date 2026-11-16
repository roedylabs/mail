/**
 * Account › Mail accounts: list of the mail accounts (check, colour,
 * storage and removal, "All accounts" and default account) and "New email
 * account" via `mailLogin.add`.
 *
 * The form belongs to the address `/account/mail-accounts/new`: "Add email
 * account" leads there, "Cancel" and Escape back to the list, and leaving
 * the page closes it – a running step aborts, an account already created
 * stays in `accounts`. After returning from the sign-in page
 * (`/oauth/callback`) the step `ret` or `expired` is already there. After
 * `done` it goes to the account overview after two seconds or with "Open
 * now", with the toast "‹address› connected". The error toast shows errors
 * without a key of their own (`failText`).
 */
import { untrack } from 'svelte';
import { isApiError } from '#lib/api.ts';
import { mailLogin, type FlowState, type LoginFlow, type MailLogin } from '#lib/auth/mail-login.svelte.ts';
import {
  serverForEmail,
  targetOf,
  type AuthKind,
  type LoginError,
  type LoginForm,
  type MailServer,
  type ServerList,
} from '#lib/auth/stalwart-login.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { lastOf, statusOf, storageOf, type StatusKind } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { pickList, type SelectValues } from '#lib/select.ts';
import type { AccountTile } from '#lib/shell.ts';
import {
  accounts,
  colorOf,
  DEFAULT_ALL,
  markedDefaultOf,
  tilesOf,
  type MailAccount,
} from '#lib/state/accounts.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { hostOf } from '#lib/url.ts';
import { clockText, waitText } from '#lib/wait.ts';

/** Waiting time until the overview of the new account. */
export const DONE_DELAY = 2000;

/**
 * Page that owns the open form. When the layout switches between desktop
 * and mobile, the page is recreated at the same address before the old one
 * goes; the old one then no longer closes the form.
 */
const owners = new WeakMap<LoginFlow, MailAccountsPage>();
/** Last reported generic error per form (also across a recreated page). */
const reported = new WeakMap<LoginFlow, unknown>();

/** Targets of the page; the routes set them with `goto` and `resolve`. */
export interface MailAccountsNav {
  /** "Add email account": `/account/mail-accounts/new`. */
  add: () => void;
  /** Form closed: `/account/mail-accounts`. */
  list: () => void;
  /** Overview of an account. */
  account: (id: string) => void;
  /** Administration › Mail servers ("Check mail servers"). */
  servers: () => void;
}

export class MailAccountsPage {
  readonly nav: MailAccountsNav;
  /** Page with an open form (`/account/mail-accounts/new`). */
  readonly adding: boolean;
  readonly login: MailLogin;
  /** Highlighted row of the server picker (arrow keys, mouse). */
  srvHi = $state<number | null>(null);
  /** Access token readable. */
  showToken = $state(false);
  /** Clock for "Try again in …" while `lockUntil` applies. */
  readonly clock = new Countdown<'rate'>();

  #doneFor: string | null = null;
  #doneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(nav: MailAccountsNav, adding: boolean, login: MailLogin = mailLogin) {
    this.nav = nav;
    this.adding = adding;
    this.login = login;
  }

  get flow() {
    return this.login.add;
  }

  /** Form of this page; always closed on the list. */
  get form(): FlowState | null {
    return this.adding ? this.flow.form : null;
  }

  /** Page with an open form: takes it over and opens it empty if none is open (after the return a step is already there). */
  start(): void {
    if (!this.adding) return;
    owners.set(this.flow, this);
    if (!this.flow.form) this.flow.open();
  }

  /** "Add email account": from the list to `/new`; there (form closed, e.g. after sign-out) open it. */
  add(): void {
    if (this.adding) this.start();
    else this.nav.add();
  }

  /** Loads the form's server picker; if that fails, "Continue to sign-in" reports the error. */
  load(): void {
    if (this.adding) void this.login.loadServers().catch(() => {});
  }

  /** Leaving the page: stop the clocks; close the form if it still belongs to this page. */
  dispose(): void {
    clearTimeout(this.#doneTimer);
    this.clock.stop();
    if (!this.adding || owners.get(this.flow) !== this) return;
    owners.delete(this.flow);
    this.flow.close();
  }

  /** "Cancel" and Escape: form closed, back to the list. */
  cancel(): void {
    this.flow.close();
    this.showToken = false;
    this.nav.list();
  }

  setAuth(auth: AuthKind): void {
    this.flow.update({ auth });
  }

  /** Server chosen: list closed, error gone. */
  pickServer(srv: string): void {
    this.flow.update({ srv });
    this.srvHi = null;
    if (ui.menu === 'pick') ui.closeMenu();
  }

  toggleServers(): void {
    if (this.flow.form?.busy) return;
    this.srvHi = null;
    ui.toggleMenu('pick');
  }

  toggleToken(): void {
    this.showToken = !this.showToken;
  }

  /** Enter sends, Escape cancels. */
  key(event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.flow.submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
  }

  /** "Open account" for `dup`. */
  openAccount(id: string): void {
    this.flow.close();
    this.nav.account(id);
  }

  /** Keeps the lock clock running after `rate` (`lockUntil` of `mailLogin.add`), only with a form. */
  watchLock(until: number): void {
    const left = (until - Date.now()) / 1000;
    if (this.adding && left > 0) this.clock.start('rate', left);
  }

  /** Remaining lock time in whole seconds; 0 = free. */
  get lockLeft(): number {
    return Math.max(0, Math.ceil((this.flow.lockUntil - this.clock.now) / 1000));
  }

  /** After `done` to the account overview, once per account. */
  arm(form: FlowState | null): void {
    const id = form?.step === 'done' ? form.done : null;
    if (id === this.#doneFor) return;
    clearTimeout(this.#doneTimer);
    this.#doneFor = id;
    if (id) this.#doneTimer = setTimeout(() => this.finish(), DONE_DELAY);
  }

  /** "Open now": form closed, toast, overview of the new account. */
  finish(): void {
    clearTimeout(this.#doneTimer);
    const form = this.flow.form;
    if (form?.step !== 'done' || !form.done) return;
    const id = form.done;
    this.flow.close();
    ui.toasts.show(m.mail_login_connected({ email: form.as }));
    this.nav.account(id);
  }

  /** Errors without a key of their own as an error toast. */
  report(form: FlowState | null): void {
    reportFailure(this.flow, form);
  }
}

/** Errors without a key of their own as an error toast, each once per form; without a session the account reloads (sign-in). */
export function reportFailure(flow: LoginFlow, form: FlowState | null): void {
  const failure = form?.failure ?? null;
  if (failure === null || failure === reported.get(flow)) return;
  reported.set(flow, failure);
  untrack(() => {
    if (isApiError(failure, 401)) void session.refreshUser().catch(() => {});
    else ui.toasts.error(failText(failure));
  });
}

// Values of the page

/** Error box: icon, title, text. */
export interface LoginErrorText {
  icon: IconName;
  title: string;
  text: string;
}

/** Details of the error texts: host (empty without an assigned server), domain, signed-in and entered address, waiting time in seconds. */
export interface LoginErrorInput {
  host: string;
  domain: string;
  as: string;
  email: string;
  wait: number;
}

/** Position of ‹host› in the sentence: at the start, after "for", or elsewhere. */
export type ServerCase = 'subject' | 'for' | 'dative';

/** Host or, without an assigned server, the substitute by position: "The server" or "the server". */
export function serverName(host: string, use: ServerCase = 'dative'): string {
  if (host) return host;
  if (use === 'subject') return m.mail_login_the_server_subject();
  return use === 'for' ? m.mail_login_the_server_for() : m.mail_login_the_server();
}

/** Error box for a key; the page sets the actions ("Open account", "Check mail servers"). */
export function loginErrorText(err: LoginError, input: LoginErrorInput): LoginErrorText {
  const { host } = input;
  switch (err) {
    case 'email':
      return { icon: 'ti-at', title: m.mail_login_err_email_title(), text: m.mail_login_err_email_text() };
    case 'dup':
      return {
        icon: 'ti-mail-check',
        title: m.mail_login_err_dup_title(),
        text: m.mail_login_err_dup_text({ email: input.as, app: session.appName }),
      };
    case 'nosrv':
      return {
        icon: 'ti-server-off',
        title: m.mail_login_err_nosrv_title(),
        text: m.mail_login_err_nosrv_text({ domain: input.domain || m.mail_login_this_domain() }),
      };
    case 'url':
      return { icon: 'ti-link-off', title: m.mail_login_err_url_title(), text: m.mail_login_err_url_text() };
    case 'sec':
      return { icon: 'ti-key', title: m.mail_login_err_sec_title(), text: m.mail_login_err_sec_text() };
    case 'tok':
      return {
        icon: 'ti-lock-x',
        title: m.mail_login_err_tok_title(),
        text: m.mail_login_err_tok_text({ host: serverName(host, 'subject') }),
      };
    case 'reach':
      return {
        icon: 'ti-plug-connected-x',
        title: m.mail_login_err_reach_title(),
        text: m.mail_login_err_reach_text({ host: serverName(host, 'subject') }),
      };
    case 'cors':
      return {
        icon: 'ti-world-off',
        title: m.mail_login_err_cors_title(),
        text: m.mail_login_err_cors_text({ host: serverName(host, 'subject') }),
      };
    case 'oauth':
      return {
        icon: 'ti-key-off',
        title: m.mail_login_err_oauth_title(),
        text: m.mail_login_err_oauth_text({ host: serverName(host, 'for') }),
      };
    case 'expired':
      return { icon: 'ti-clock-x', title: m.mail_login_err_expired_title(), text: m.mail_login_err_expired_text() };
    case 'denied':
      return {
        icon: 'ti-circle-x',
        title: m.mail_login_err_denied_title(),
        text: m.mail_login_err_denied_text({ host: serverName(host, 'subject') }),
      };
    case 'iss':
      return {
        icon: 'ti-shield-x',
        title: m.mail_login_err_iss_title(),
        text: m.mail_login_err_iss_text({ host: serverName(host) }),
      };
    case 'other':
      return {
        icon: 'ti-user-x',
        title: m.mail_login_err_other_title(),
        text: m.mail_login_err_other_text({ host: serverName(host), as: input.as, email: input.email }),
      };
    case 'rate':
      return {
        icon: 'ti-hourglass',
        title: m.mail_login_err_rate_title(),
        text:
          input.wait > 0
            ? m.mail_login_err_rate_wait({ host: serverName(host, 'subject'), wait: waitText(input.wait) })
            : m.mail_login_err_rate_text({ host: serverName(host, 'subject') }),
      };
  }
}

/** Entry of the "Sign-in method" segment. */
export interface AuthOption {
  label: string;
  on: boolean;
  onClick: () => void;
}

/** Server picker: a popover on desktop, in the sheet on mobile (`ui.pick`); disabled while a step is running. */
export type ServerSelect = SelectValues;

/** Values that "New email account" and "Sign in again" share. */
export interface FlowValues {
  /** Form (also while loading and after an error); buttons only in this step. */
  isCred: boolean;
  /** Return via `/oauth/callback`: status line, no fields. */
  isRet: boolean;
  isDone: boolean;
  notDone: boolean;
  /** "Password" sign-in type: redirect to the sign-in page, notice `pwHint`. */
  isPw: boolean;
  /** "Token" sign-in type: "Access token" field. */
  isTok: boolean;
  pwHint: string;
  sec: string;
  onSec: (value: string) => void;
  secType: 'text' | 'password';
  eyeIcon: 'ti-eye' | 'ti-eye-off';
  eyeTip: string;
  onEye: () => void;
  busy: boolean;
  notBusy: boolean;
  busyText: string;
  retTitle: string;
  retText: string;
  hasErr: boolean;
  eIcon: IconName;
  eTitle: string;
  eText: string;
  eHasAct: boolean;
  eAct: string;
  eFn: (() => void) | undefined;
  /** `denied` with the server's error code: "Server message: ‹code›". */
  eHasCode: boolean;
  eCode: string;
  btnLabel: string;
  btnIcon: IconName;
  /** Icon spins (while loading). */
  btnSpin: boolean;
  /** Details complete and not locked. */
  ready: boolean;
  /** Locked after `rate` with a waiting time. */
  locked: boolean;
  /** Button in accent colour (ready or while loading). */
  hot: boolean;
  /** `aria-disabled` of the button. */
  btnDis: boolean;
  submit: () => void;
  key: (event: KeyInput) => void;
  cancel: () => void;
  doneTitle: string;
  doneText: string;
}

/** "New email account". */
export interface AddFlowValues extends FlowValues {
  email: string;
  onEmail: (value: string) => void;
  sel: ServerSelect;
  hint: string;
  hasHint: boolean;
  /** Server for the domain found ("Server: ‹host›"). */
  hintOk: boolean;
  /** No server for the domain. */
  hintWarn: boolean;
  /** "Other server …": "Server address" field. */
  isOther: boolean;
  url: string;
  onUrl: (value: string) => void;
  authOpts: AuthOption[];
  doneGo: () => void;
}

/** Action of the error box ("Open account", "Check mail servers"). */
export interface FlowAct {
  label: string;
  run: () => void;
}

/** What the pages derive differently for the shared values. */
export interface FlowInput {
  form: FlowState;
  /** Host for the texts; empty without an assigned server (only when adding an account, signing in again always names the account's). */
  host: string;
  domain: string;
  /** Entered or saved address. */
  email: string;
  /** Remaining lock time after `rate` in seconds; 0 = free. */
  left: number;
  /** Details complete (without the lock). */
  filled: boolean;
  showToken: boolean;
  act: FlowAct | null;
}

/** Part of the shared values without texts and handlers, which differ per page. */
export type FlowCore = Omit<
  FlowValues,
  'pwHint' | 'onSec' | 'onEye' | 'retText' | 'submit' | 'key' | 'cancel' | 'doneTitle' | 'doneText'
>;

/** "Check mail servers" for `cors` and `oauth`, only with `showAdmin`. */
export function serversAct(err: LoginError | null, run: () => void): FlowAct | null {
  return (err === 'cors' || err === 'oauth') && session.isAdmin ? { label: m.mail_login_check_servers(), run } : null;
}

/** Steps, loading, error box and button of both forms. */
export function flowValues(x: FlowInput): FlowCore {
  const { form, host, left, act } = x;
  const tok = form.auth === 'token';
  const locked = left > 0;
  const tHost = serverName(host);
  const err = form.err;
  const as = form.as || x.email;
  const E = err ? loginErrorText(err, { host, domain: x.domain, as, email: x.email, wait: left }) : null;
  const showE = !!E && !(err === 'rate' && form.rl && !locked);
  const ready = x.filled && !locked;
  return {
    isCred: form.step === 'cred',
    isRet: form.step === 'ret',
    isDone: form.step === 'done',
    notDone: form.step !== 'done',
    isPw: !tok,
    isTok: tok,
    sec: form.token,
    secType: x.showToken ? 'text' : 'password',
    eyeIcon: x.showToken ? 'ti-eye-off' : 'ti-eye',
    eyeTip: x.showToken ? m.mail_login_hide() : m.mail_login_show(),
    busy: form.busy,
    notBusy: !form.busy,
    busyText: tok ? m.mail_login_busy_token() : m.mail_login_busy_open({ host: tHost }),
    retTitle: m.mail_login_ret_title({ host: tHost }),
    hasErr: showE,
    eIcon: E?.icon ?? 'ti-alert-circle',
    eTitle: E?.title ?? '',
    eText: E?.text ?? '',
    eHasAct: showE && !!act,
    eAct: act?.label ?? '',
    eFn: act?.run,
    eHasCode: showE && !!form.sErr,
    eCode: form.sErr,
    btnLabel: form.busy
      ? tok
        ? m.mail_login_btn_connecting()
        : m.mail_login_btn_opening()
      : locked
        ? m.mail_login_btn_locked({ clock: clockText(left) })
        : tok
          ? m.mail_login_btn_connect()
          : m.mail_login_btn_continue(),
    btnIcon: form.busy ? 'ti-loader-2' : locked ? 'ti-lock' : tok ? 'ti-plug-connected' : 'ti-login-2',
    btnSpin: form.busy,
    ready,
    locked,
    hot: ready || form.busy,
    btnDis: !ready || form.busy,
  };
}

/** Row of the list. */
export interface MailAccountRow {
  id: string;
  email: string;
  /** Host, plus the storage as soon as it is known. */
  sub: string;
  /** "Default": default account, otherwise the first (like the account switcher). */
  isDefault: boolean;
  /** Dot and colour of the status: also "Checking …" during "Check connection". */
  kind: StatusKind;
  /** "Connected", "Sign-in required" or "Checking …". */
  st: string;
  needsAuth: boolean;
  /** "Checked … ago", "Last checked … ago" or "Not checked yet". */
  last: string;
  /** Tile in the account's colour. */
  chip: string;
  chipInk: string;
  openAcct: () => void;
}

/** "All accounts" row above the list: with more than one account, selectable as default. */
export interface MailAccountsAll {
  show: boolean;
  isDefault: boolean;
  /** "Set as default": `defaultAccount` = `all`, toast with undo. */
  makeDefault: () => void;
}

export interface MailAccountsValues {
  maAll: MailAccountsAll;
  /** Tiles of the "All accounts" row (the first three accounts). */
  allT: AccountTile[];
  maList: MailAccountRow[];
  /** "No email account connected yet." – only once the list is known. */
  maEmpty: boolean;
  afOpen: boolean;
  afClosed: boolean;
  afStart: () => void;
  /** `null` while the form is closed. */
  af: AddFlowValues | null;
}

export interface MailAccountsInput {
  isMobile: boolean;
  now?: number;
}

function row(p: MailAccountsPage, a: MailAccount, isDefault: boolean, now: number): MailAccountRow {
  const storage = storageOf(a);
  const { kind, st, needsAuth } = statusOf(a);
  const { bg, ink } = colorOf(a);
  return {
    id: a.id,
    email: a.email,
    // Storage only once it is known.
    sub: storage ? `${a.host} · ${m.mail_accounts_quota({ used: storage.usedT, total: storage.totalT })}` : a.host,
    isDefault,
    kind,
    st,
    needsAuth,
    last: lastOf(a, now),
    chip: bg,
    chipInk: ink,
    openAcct: () => p.nav.account(a.id),
  };
}

/** What notice, server picker and texts derive from the form: server list (`null` while unknown), address, domain, server for the domain. */
interface FormContext {
  list: ServerList | null;
  email: string;
  domain: string;
  auto: MailServer | null;
}

function contextOf(p: MailAccountsPage, form: LoginForm): FormContext {
  const list = p.login.servers;
  const email = form.email.trim().toLowerCase();
  return {
    list,
    email,
    domain: email.split('@')[1] ?? '',
    auto: list ? serverForEmail(email, list.servers) : null,
  };
}

function serverSelect(p: MailAccountsPage, form: FlowState, ctx: FormContext, isMobile: boolean): ServerSelect {
  const { list, domain, auto } = ctx;
  const choices = [
    {
      v: 'auto',
      l: m.mail_login_auto(),
      sub: auto
        ? m.mail_login_server_host({ host: auto.host })
        : list && domain.includes('.')
          ? m.mail_login_auto_none({ domain })
          : m.mail_login_auto_desc(),
    },
    ...(list?.servers ?? []).map((s) => ({ v: s.id, l: s.label, sub: s.host })),
    ...(list?.allow_custom_servers ? [{ v: 'other', l: m.mail_login_other(), sub: m.mail_login_other_desc() }] : []),
  ];
  const disabled = form.busy;
  const open = ui.menu === 'pick';
  const current = choices.find((c) => c.v === form.srv);
  return {
    title: m.mail_login_server(),
    // Server of the list not there (anymore); while it is loading, the choice stays empty.
    label: current?.l ?? (form.srv === 'other' ? m.mail_login_other() : list ? m.mail_login_no_server() : ''),
    open: open && !isMobile,
    disabled,
    toggle: () => p.toggleServers(),
    ...pickList({
      opts: choices,
      cur: form.srv,
      open,
      hi: p.srvHi,
      disabled: disabled || isMobile,
      mark: (i) => {
        p.srvHi = i;
      },
      show: () => {
        ui.menu = 'pick';
      },
      hide: () => ui.closeMenu(),
      choose: (v) => p.pickServer(v),
    }),
  };
}

/** Host of the chosen server for the texts; empty if none is assigned. */
function hostFor(form: LoginForm, list: ServerList | null): string {
  const target = list ? targetOf(form, list) : null;
  return target?.server?.host || (form.srv === 'other' ? hostOf(form.url.trim()) : '');
}

function addFlow(p: MailAccountsPage, form: FlowState, isMobile: boolean): AddFlowValues {
  const ctx = contextOf(p, form);
  const { list, email, domain, auto } = ctx;
  const host = hostFor(form, list);
  const tok = form.auth === 'token';
  const isAuto = form.srv === 'auto';
  const hint = isAuto
    ? auto
      ? m.mail_login_server_host({ host: auto.host })
      : list && domain.includes('.')
        ? m.mail_login_hint_none({ domain })
        : ''
    : '';
  const dupId = form.err === 'dup' ? form.dupId : null;
  const act = dupId
    ? { label: m.mail_login_open_account(), run: () => p.openAccount(dupId) }
    : serversAct(form.err, () => p.nav.servers());
  const authOpt = (auth: AuthKind, label: string): AuthOption => ({
    label,
    on: form.auth === auth,
    onClick: () => p.setAuth(auth),
  });
  return {
    ...flowValues({
      form,
      host,
      domain,
      email,
      left: p.lockLeft,
      filled: !!form.email.trim() && (!tok || !!form.token.trim()),
      showToken: p.showToken,
      act,
    }),
    email: form.email,
    onEmail: (value) => p.flow.update({ email: value }),
    sel: serverSelect(p, form, ctx, isMobile),
    hint,
    hasHint: !!hint,
    hintOk: isAuto && !!auto,
    hintWarn: isAuto && !auto && !!hint,
    isOther: form.srv === 'other',
    url: form.url,
    onUrl: (value) => p.flow.update({ url: value }),
    authOpts: [authOpt('oauth', m.mail_login_auth_password()), authOpt('token', m.mail_login_auth_token())],
    pwHint: host ? m.mail_login_pw_hint({ host }) : m.mail_login_pw_hint_none(),
    onSec: (value) => p.flow.update({ token: value }),
    onEye: () => p.toggleToken(),
    retText: m.mail_login_ret_new({ app: session.appName }),
    submit: () => void p.flow.submit(),
    key: (event) => p.key(event),
    cancel: () => p.cancel(),
    doneTitle: m.mail_login_done_new({ email: form.as || email }),
    doneText: m.mail_login_done_new_text(),
    doneGo: () => p.finish(),
  };
}

/** Values of the page; accounts from `accounts`, default account from `prefs`. */
export function mailAccountsValues(p: MailAccountsPage, input: MailAccountsInput): MailAccountsValues {
  const list = accounts.list;
  const defaultId = prefs.values.defaultAccount;
  const def = markedDefaultOf(list, defaultId);
  const now = input.now ?? Date.now();
  const form = p.form;
  return {
    maAll: {
      show: (list?.length ?? 0) > 1,
      isDefault: defaultId === DEFAULT_ALL,
      makeDefault: () => {
        const prev = prefs.values.defaultAccount;
        if (prev === DEFAULT_ALL) return;
        prefs.set({ defaultAccount: DEFAULT_ALL });
        ui.toasts.defer({
          text: m.mail_accounts_all_default_done(),
          revert: () => prefs.set({ defaultAccount: prev }),
        });
      },
    },
    allT: tilesOf(list ?? [], 3),
    maList: (list ?? []).map((a) => row(p, a, a.id === def?.id, now)),
    maEmpty: list?.length === 0,
    afOpen: form !== null,
    afClosed: form === null,
    afStart: () => p.add(),
    af: form ? addFlow(p, form, input.isMobile) : null,
  };
}
