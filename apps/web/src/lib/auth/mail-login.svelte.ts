/**
 * Sign-in to mail accounts as page state: kind `new` for a new account
 * (Account › Mail accounts) and `re` for "Sign in again"
 * (Mail account › Connection) with the steps `cred` (form), `ret` (after
 * returning via `/oauth/callback`: "Completing sign-in at …") and `done`.
 * `#lib/auth/stalwart-login.ts` runs the flow; texts, values, redirect
 * after `done` and toasts belong to the pages.
 */
import { api, isApiError } from '#lib/api.ts';
import {
  FORM0,
  begin,
  browserDeps,
  callbackParams,
  clearPending,
  complete,
  takeReturning,
  type CallbackParams,
  type LoginDeps,
  type LoginError,
  type LoginForm,
  type Outcome,
  type Pending,
  type Purpose,
  type ServerList,
} from '#lib/auth/stalwart-login.ts';
import { localStore } from '#lib/last-page.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';

export type Step = 'cred' | 'ret' | 'done';

/** State of a sign-in form. */
export interface FlowState extends LoginForm {
  step: Step;
  busy: boolean;
  err: LoginError | null;
  /** Signed-in address: for `dup` and `other`, after success the account's. */
  as: string;
  /** Error code of the mail server for `denied`. */
  sErr: string;
  /** `rate` with a wait time: the error disappears with the lock. */
  rl: boolean;
  /** Already connected account for `dup` ("Open account"). */
  dupId: string | null;
  /** Error without its own key; the page shows it with `failText`. */
  failure: unknown;
  /** Created or re-signed-in account (`done`). */
  done: string | null;
}

const STATUS0 = {
  step: 'cred',
  busy: false,
  err: null,
  as: '',
  sErr: '',
  rl: false,
  dupId: null,
  failure: null,
  done: null,
} as const satisfies Omit<FlowState, keyof LoginForm>;

/** Details of an account for "Sign in again": without a choice, an own server as `other`. */
export function formOf(account: MailAccount): LoginForm {
  return {
    email: account.email,
    srv: account.server_id ?? 'other',
    url: account.server_id ? '' : account.url,
    auth: account.auth_kind,
    token: '',
  };
}

/** Freshly opened form: empty or with the details of the account. */
export function freshForm(account?: MailAccount): FlowState {
  return { ...(account ? formOf(account) : FORM0), ...STATUS0 };
}

export class LoginFlow {
  readonly kind: 'new' | 're';
  /** Form state; `null` = closed. */
  form = $state<FlowState | null>(null);
  /** Account for "Sign in again". */
  account = $state<string | null>(null);
  /**
   * Locked until (ms since 1970) after `rate` with a
   * wait time. It applies across closing and opening; the
   * page shows the lock on the button ("Try again in …"), `rl` only
   * whether the message disappears with the lock.
   */
  lockUntil = $state(0);

  readonly #owner: MailLogin;
  /**
   * A later step (close, open, new attempt, sign-out) aborts the
   * running one: no more redirect, its result does not change the
   * form. A created account still goes into `accounts`.
   */
  #run: AbortController | null = null;

  constructor(kind: 'new' | 're', owner: MailLogin) {
    this.kind = kind;
    this.#owner = owner;
  }

  /** Opens the form: empty or with address, server and sign-in method of the account. */
  open(account?: MailAccount): void {
    this.#next();
    this.account = account?.id ?? null;
    this.form = freshForm(account);
  }

  close(): void {
    this.#next();
    this.form = null;
    this.account = null;
  }

  /** Changes fields; a shown error disappears. */
  update(patch: Partial<LoginForm>): void {
    if (this.form) this.form = { ...this.form, ...patch, err: null, failure: null };
  }

  /**
   * "Continue to sign-in" or "Connect" (`go`): check, then redirect
   * or hand over the access token. After the redirect the form stays
   * in the loading state until the browser leaves the page.
   */
  async submit(now = Date.now()): Promise<void> {
    const form = this.form;
    const purpose = this.#purpose();
    if (!form || !purpose || form.busy || form.step !== 'cred' || this.lockUntil > now) return;
    const signal = this.#next();
    this.form = { ...form, ...STATUS0, busy: true };
    let result: Outcome | { redirect: string };
    try {
      const list = await this.#owner.loadServers();
      signal.throwIfAborted();
      result = await begin(form, purpose, list, accounts.list ?? [], this.#owner.deps(), signal);
    } catch (error) {
      result = { ok: false, error: null, cause: error };
    }
    if ('redirect' in result) return;
    this.#settle(result, signal);
  }

  /** Return via `/oauth/callback`: step `ret` with the details from before the redirect, then the result. */
  async resume(pending: Pending, params: CallbackParams): Promise<void> {
    const signal = this.#next();
    this.account = pending.purpose.kind === 're' ? pending.purpose.account : null;
    this.form = { ...FORM0, ...pending.form, ...STATUS0, step: 'ret' };
    let outcome: Outcome;
    try {
      outcome = await complete(pending, params, this.#owner.deps());
    } catch (error) {
      outcome = { ok: false, error: null, cause: error };
    }
    this.#settle(outcome, signal);
  }

  /** Return without a known attempt (`state` missing or unknown): empty form with `expired`. */
  expire(): void {
    this.#next();
    this.account = null;
    this.form = { ...FORM0, ...STATUS0, err: 'expired' };
  }

  /** "Back" from the sign-in page brings the page back from the back-forward cache: do not stay in the loading state. */
  restore(): void {
    if (!this.form?.busy) return;
    this.#next();
    this.form = { ...this.form, busy: false };
  }

  /** Aborts the running step and starts a new one. */
  #next(): AbortSignal {
    this.#run?.abort();
    this.#run = new AbortController();
    return this.#run.signal;
  }

  #purpose(): Purpose | null {
    if (this.kind === 'new') return { kind: 'new' };
    return this.account ? { kind: 're', account: this.account } : null;
  }

  #settle(outcome: Outcome, signal: AbortSignal): void {
    // The account is already on the server – even if the form is closed by now.
    if (outcome.ok) accounts.put(outcome.account);
    const form = this.form;
    if (!form || signal.aborted) return;
    if (outcome.ok) {
      this.form = { ...form, ...STATUS0, step: 'done', done: outcome.account.id, as: outcome.account.email, token: '' };
      return;
    }
    const { error, wait } = outcome;
    const locked = error === 'rate' && wait !== undefined && wait > 0;
    if (locked) this.lockUntil = this.#owner.deps().now() + wait * 1000;
    this.form = {
      ...form,
      ...STATUS0,
      err: error,
      as: outcome.as ?? '',
      sErr: outcome.code ?? '',
      rl: locked,
      dupId: outcome.account ?? null,
      failure: error ? null : (outcome.cause ?? null),
      ...(error === 'tok' ? { token: '' } : {}),
    };
    // Server blocked meanwhile (`raBlocked`; on re-sign-in also `nosrv`) or account removed: the list shows it.
    if (
      isApiError(outcome.cause, 409, 'blocked') ||
      isApiError(outcome.cause, 404) ||
      (this.kind === 're' && error === 'nosrv')
    ) {
      void accounts.load().catch(() => {});
    }
  }
}

export class MailLogin {
  /** `GET servers`: registry with test status and policy for own servers (server choice of the pages). */
  servers = $state<ServerList | null>(null);
  readonly add: LoginFlow = new LoginFlow('new', this);
  readonly re: LoginFlow = new LoginFlow('re', this);
  readonly deps: () => LoginDeps;

  constructor(deps: () => LoginDeps = browserDeps) {
    this.deps = deps;
  }

  async loadServers(): Promise<ServerList> {
    const list = await api<ServerList>('GET', 'servers');
    this.servers = list;
    return list;
  }

  /**
   * `/oauth/callback`: read the parameters, fetch the attempt for the `state` and
   * start the return. Returns where the route redirects to; without a
   * known attempt the empty "New email account".
   */
  receive(url: URL): Purpose {
    const params = callbackParams(url);
    const deps = this.deps();
    const pending = takeReturning(params.state, deps);
    if (!pending) {
      this.re.close();
      this.add.expire();
      return { kind: 'new' };
    }
    void (pending.purpose.kind === 'new' ? this.add : this.re).resume(pending, params);
    return pending.purpose;
  }

  /** Resets the forms on `pageshow` from the back-forward cache. */
  attach(target: Window): () => void {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      this.add.restore();
      this.re.restore();
    };
    target.addEventListener('pageshow', onShow);
    return () => target.removeEventListener('pageshow', onShow);
  }

  /** Sign-out: close forms, lift locks after `rate` (they belonged to the previous sign-in). */
  reset(): void {
    this.add.close();
    this.re.close();
    this.add.lockUntil = 0;
    this.re.lockUntil = 0;
    this.servers = null;
    const device = localStore();
    if (device) clearPending(device);
  }
}

export const mailLogin = new MailLogin();
