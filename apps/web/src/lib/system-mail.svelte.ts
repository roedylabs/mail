/**
 * Administration › Email: system mail (without the Templates section, which
 * `#lib/mail-preview.svelte.ts` keeps) against `GET/PUT admin/system-mail`
 * and `POST admin/system-mail/test`: status, connection (server from the
 * registry, sign-in by password or token), sender, sending, test email and
 * the bar "Unsaved changes".
 *
 * Status: "Checking" during a check, "Connected" as long as the draft matches
 * the last successfully checked connection (`good`), "Not set up" without a
 * sending account, "Not checked" after changed credentials (`tested`),
 * otherwise the result of the last check. A stored account without a check
 * (`unchecked`, e.g. from the setup) is checked silently by the page after
 * loading, meanwhile "Checking …"; if that does not work (no response),
 * "Not checked" stays with the text for `unchecked`.
 *
 * The page knows secrets only as input: an empty field keeps the stored
 * secret of the same sign-in method (`has_secret`), it is only sent when
 * entered. Saving takes over the draft immediately and sends it after the
 * toast "Changes saved" expires (`ui.toasts.defer`), only the changed
 * fields; the backend checks a changed connection itself (status "Checking"
 * during the request), afterwards `auth/me` is reloaded
 * (`system_mail_configured` for the notice bar and the users page).
 *
 * Error texts per reason of `mail_failed`: in the status "No connection" and
 * in the error toast of "Send". "Test connection" only reports "Connection
 * failed"; if only the test email fails after a successful sign-in while
 * sending, the status stays, likewise for 429 `rate_limited`, server errors
 * and without a response (only an error toast).
 */
import { api, ApiError, isApiError, retryAfter } from '#lib/api.ts';
import { ago } from '#lib/ago.ts';
import type { SegOption } from '#lib/appearance.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { segOptions, selectValues, type SelectContext, type SelectState, type SelectValues } from '#lib/select.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { hostOf } from '#lib/url.ts';
import { waitText } from '#lib/wait.ts';

export type MailAuth = 'password' | 'token';

/** Identity of the sending account. */
export interface MailIdentity {
  id: string;
  name: string;
  email: string;
}

/** Response of `GET`/`PUT admin/system-mail`. */
export interface SystemMail {
  /** `null` without an account or after its server was deleted. */
  server_id: string | null;
  auth: MailAuth;
  user: string;
  has_secret: boolean;
  identity_id: string | null;
  sender_name: string | null;
  reply_to: string | null;
  keep_sent: boolean;
  status: 'none' | 'unchecked' | 'ok' | 'err';
  reason: string | null;
  /** Missing mailbox for `reason` `no_mailbox`; absent for other reasons. */
  role?: 'drafts' | 'sent';
  checked_at: string | null;
  identities: MailIdentity[];
}

/** Server of the registry for the selection (`admin/servers`). */
export interface MailServer {
  id: string;
  label: string;
  url: string;
}

/** Draft of the form; secrets only as input (empty = keep the stored one). */
export interface MailDraft {
  srv: string;
  auth: MailAuth;
  user: string;
  pass: string;
  token: string;
  name: string;
  replyTo: string;
  keepSent: boolean;
}

export type MailDraftKey = keyof MailDraft;

const DRAFT_KEYS: readonly MailDraftKey[] = ['srv', 'auth', 'user', 'pass', 'token', 'name', 'replyTo', 'keepSent'];

/** Status of the card; `unchecked` only while the silent check cannot run. */
export type MailStatusKey = 'busy' | 'new' | 'unchecked' | 'none' | 'ok' | 'err';

export type MailSection = 'conn' | 'sender' | 'delivery' | 'test' | 'tpl';

/** Select lists of the page: mail server and "Variant" of the templates. */
export type MailPick = 'mailsrv' | 'mvvar';

/** Sections of the tabs. */
const MAIL_TABS: readonly [MailSection, () => string][] = [
  ['conn', () => m.system_mail_tab_conn()],
  ['sender', () => m.system_mail_tab_sender()],
  ['delivery', () => m.system_mail_tab_delivery()],
  ['test', () => m.system_mail_tab_test()],
  ['tpl', () => m.system_mail_tab_tpl()],
];

/**
 * Reasons that concern the connection: if the test email also fails because
 * of them, the check counts as failed. The others concern only
 * the one mail.
 */
const CONNECTION_REASONS: ReadonlySet<string> = new Set([
  'unreachable',
  'auth_failed',
  'auth_locked',
  'forbidden',
  'throttled',
  'foreign_origin',
  'unsupported',
  'no_identity',
  'no_mailbox',
]);

/** Without a sending account: the defaults. */
export const NO_MAIL: SystemMail = {
  server_id: null,
  auth: 'password',
  user: '',
  has_secret: false,
  identity_id: null,
  sender_name: null,
  reply_to: null,
  keep_sent: true,
  status: 'none',
  reason: null,
  checked_at: null,
  identities: [],
};

export function draftOf(mail: SystemMail): MailDraft {
  return {
    srv: mail.server_id ?? '',
    auth: mail.auth,
    user: mail.user,
    pass: '',
    token: '',
    name: mail.sender_name ?? '',
    replyTo: mail.reply_to ?? '',
    keepSent: mail.keep_sent,
  };
}

/** Entered secret of the chosen sign-in method (token trimmed, app password not). */
function secretOf(d: MailDraft): string {
  return d.auth === 'token' ? d.token.trim() : d.pass;
}

/**
 * Connection of the draft: server, sign-in method, user only with password,
 * entered secret (empty = the stored one).
 */
export function connOf(d: MailDraft): string {
  return JSON.stringify([d.srv, d.auth, d.auth === 'password' ? d.user.trim() : '', secretOf(d)]);
}

/** Fields of the connection for `test` and `PUT`. */
function connBody(d: MailDraft): Record<string, unknown> {
  const secret = secretOf(d);
  return {
    server_id: d.srv,
    auth: d.auth,
    // With a token the field is hidden; the backend keeps the stored user.
    ...(d.auth === 'password' && { user: d.user.trim() }),
    ...(secret !== '' && (d.auth === 'token' ? { token: secret } : { app_password: secret })),
  };
}

/** The whole draft for the test email (sender and sending already apply to it). */
function draftBody(d: MailDraft): Record<string, unknown> {
  return {
    ...connBody(d),
    sender_name: d.name.trim() || null,
    reply_to: d.replyTo.trim() || null,
    keep_sent: d.keepSent,
  };
}

/** Only the changed fields for `PUT`; the secret only if entered. */
export function changedBody(d: MailDraft, base: MailDraft): Record<string, unknown> {
  const conn = connBody(d);
  const body: Record<string, unknown> = {};
  if (d.srv !== base.srv) body.server_id = conn.server_id;
  if (d.auth !== base.auth) body.auth = d.auth;
  if ('user' in conn && conn.user !== base.user) body.user = conn.user;
  if ('app_password' in conn) body.app_password = conn.app_password;
  if ('token' in conn) body.token = conn.token;
  if (d.name.trim() !== base.name) body.sender_name = d.name.trim() || null;
  if (d.replyTo.trim() !== base.replyTo) body.reply_to = d.replyTo.trim() || null;
  if (d.keepSent !== base.keepSent) body.keep_sent = d.keepSent;
  return body;
}

/** Fields of the connection; if a `PUT` changes one of them, the backend checks right away. */
const CONNECTION_FIELDS: readonly string[] = ['server_id', 'auth', 'user', 'app_password', 'token'];

function touchesConnection(body: Record<string, unknown>): boolean {
  return CONNECTION_FIELDS.some((k) => k in body);
}

/**
 * Check before the request: without a server "Can’t reach the server",
 * without a token or user and password "Sign-in failed" – a stored secret of
 * the same sign-in method counts.
 */
export function precheck(d: MailDraft, saved: SystemMail, servers: readonly MailServer[]): string | null {
  if (!servers.some((s) => s.id === d.srv)) return m.system_mail_err_reach();
  const stored = saved.has_secret && saved.auth === d.auth;
  if (d.auth === 'token') return secretOf(d) || stored ? null : m.system_mail_err_no_token();
  return d.user.trim() && (d.pass || stored) ? null : m.system_mail_err_no_login();
}

/** Details of the reason. */
export interface ReasonContext {
  /** Sign-in by token. */
  tok?: boolean;
  /** `retry_after` in seconds (429 `auth_locked`, `throttled`); without: "later" or "in a few minutes". */
  wait?: number;
  /** Missing mailbox for `no_mailbox` (`drafts`, `sent`). */
  role?: string | null;
  /** Name of the app (`throttled`); without it the one from `public/config`. */
  app?: string;
}

/** Text for the reason of a failed check (the status text). */
export function reasonText(reason: string | null, o: ReasonContext = {}): string {
  const wait = o.wait !== undefined && o.wait > 0 ? waitText(o.wait) : null;
  switch (reason) {
    case 'unreachable':
      return m.system_mail_err_reach();
    case 'auth_failed':
      return o.tok ? m.system_mail_err_auth_token() : m.system_mail_err_auth_password();
    case 'forbidden':
      return m.system_mail_err_forbidden();
    case 'auth_locked':
      return wait ? m.system_mail_err_locked({ wait }) : m.system_mail_err_locked_later();
    case 'throttled': {
      const app = o.app ?? session.appName;
      return wait ? m.system_mail_err_throttled({ app, wait }) : m.system_mail_err_throttled_later({ app });
    }
    case 'no_identity':
      return m.setup_sys_no_identity();
    case 'no_mailbox':
      return o.role === 'sent' ? m.system_mail_err_no_sent() : m.system_mail_err_no_drafts();
    case 'unsupported':
      return m.system_mail_err_unsupported();
    default:
      return m.error_act();
  }
}

/** Text for a rejected check of the draft `d` (`mail_failed` with `reason`, 422 per field). */
function errorText(error: ApiError, d: MailDraft): string {
  const tok = d.auth === 'token';
  if (error.code === 'mail_failed') {
    const reason = typeof error.body.reason === 'string' ? error.body.reason : null;
    const role = typeof error.body.role === 'string' ? error.body.role : null;
    return reasonText(reason, { tok, wait: retryAfter(error, 0), role });
  }
  const fields = fieldsOf(error);
  // Server deleted in the meantime or unknown.
  if (fields.includes('server_id')) return m.system_mail_err_reach();
  // Rejected credentials (format, length): like a rejected sign-in.
  if (fields.some((k) => CONNECTION_FIELDS.includes(k))) return reasonText('auth_failed', { tok });
  return m.error_act();
}

/**
 * Does the rejection say something about the connection (`mail_failed`, 422
 * per field)? Otherwise (429 `rate_limited`, server error, without a response)
 * the status stays, and only an error toast reports it.
 */
const isCheckError = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.code === 'mail_failed' || fieldsOf(error).length > 0);

/** Error toast when the status stays: 429 with wait time, otherwise server error or no connection. */
function toastText(error: unknown): string {
  return isApiError(error, 429) ? m.error_limit({ wait: waitText(retryAfter(error, 60)) }) : failText(error);
}

/** Fields of a 422 `invalid` (`fields.<field>.code`). */
function fieldsOf(error: ApiError): string[] {
  const fields = error.body.fields;
  return error.code === 'invalid' && fields && typeof fields === 'object' ? Object.keys(fields) : [];
}

/** Does the rejection concern the connection (and not only sender, recipient or the one mail)? */
const isConnectionError = (error: unknown): error is ApiError =>
  error instanceof ApiError &&
  (fieldsOf(error).some((k) => CONNECTION_FIELDS.includes(k)) ||
    (error.code === 'mail_failed' &&
      typeof error.body.reason === 'string' &&
      CONNECTION_REASONS.has(error.body.reason)));

/**
 * Saving of this page: is it still waiting in the toast (`deferred` – then it
 * is the pending action of `ui.toasts`) or is the request running
 * (`inflight`)? Loading, checking and sending wait for it, otherwise they would
 * see the old state or the old secret; so does a second save, so that a failed
 * first one does not lose its fields.
 */
let deferred = false;
let inflight: Promise<unknown> | null = null;

const unsettled = (): boolean => deferred || inflight !== null;

async function settle(): Promise<void> {
  if (deferred) {
    await ui.toasts.flush().catch(() => {});
    // Already sent or discarded without the action noticing (e.g. `ui.reset()`).
    deferred = false;
  } else if (inflight) await inflight.catch(() => {});
}

export class SystemMailPage {
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  failure = $state<'offline' | '500'>('500');
  /** Stored state (after `PUT` the response). */
  saved = $state.raw<SystemMail>(NO_MAIL);
  servers = $state.raw<MailServer[]>([]);
  /** Inputs on top of the stored state. */
  edits = $state.raw<Partial<MailDraft>>({});
  base = $derived(draftOf(this.saved));
  draft = $derived<MailDraft>({ ...this.base, ...this.edits });
  dirty = $derived(DRAFT_KEYS.some((k) => this.draft[k] !== this.base[k]));
  conn = $derived(connOf(this.draft));

  /** Connection of the last check and of the last successful one. */
  tested = $state<string | null>(null);
  good = $state<string | null>(null);
  /**
   * Result of the last check with its text; `new` = none yet, `unchecked` =
   * stored but never checked.
   */
  result = $state<'ok' | 'err' | 'new' | 'unchecked'>('new');
  errText = $state('');
  /** "Last checked" in ms. */
  checkedAt = $state<number | null>(null);
  identities = $state.raw<MailIdentity[]>([]);
  /** Running checks: "Test connection" and `PUT` with a new connection. */
  checks = $state(0);
  /** Check running. */
  busy = $derived(this.checks > 0);
  /** Rotation of the icon in degrees. */
  rot = $state(0);
  sending = $state(false);
  /**
   * Counts the state confirmed by the server: loading, response of `PUT`, new
   * identities of a check – not the optimistic save before the `PUT`. The
   * template preview reloads afterwards ("From").
   */
  confirmed = $state(0);
  /** Recipient of the test email; `null` = the own address. */
  to = $state<string | null>(null);
  showSecret = $state(false);

  key = $derived.by((): MailStatusKey => {
    const connNew = this.conn !== this.tested;
    if (this.busy) return 'busy';
    if (this.good !== null && this.conn === this.good) return 'ok';
    // Without an account "Not set up", but not over the result of a check of the draft.
    if (!connNew && this.saved.status === 'none' && this.result === 'new') return 'none';
    return connNew ? 'new' : this.result;
  });

  #seq = 0;
  #disposed = false;

  /** Loads account and servers; with `unchecked` the page then checks silently. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    try {
      // A save from before is still waiting for its toast: send it first, otherwise the page would show the old state.
      if (unsettled()) await settle();
      const [mail, list] = await Promise.all([
        api<SystemMail>('GET', 'admin/system-mail'),
        api<{ servers: MailServer[] }>('GET', 'admin/servers'),
      ]);
      if (seq !== this.#seq || this.#disposed) return;
      this.servers = list.servers.map(({ id, label, url }) => ({ id, label, url }));
      this.identities = mail.identities;
      this.#adopt(mail);
      this.status = 'ready';
      if (mail.status === 'unchecked') void this.test(true);
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows the sign-in or "Access denied".
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
      this.failure = error instanceof ApiError ? '500' : 'offline';
      this.status = 'failed';
    }
  }

  /** "Try again" of the error page. */
  retry(): Promise<void> {
    this.status = 'loading';
    return this.load();
  }

  /** Take over the stored state with its status. */
  #adopt(view: SystemMail): void {
    this.saved = view;
    const k = connOf(draftOf(view));
    this.tested = k;
    this.result = view.status === 'none' ? 'new' : view.status;
    // The stored status knows no wait time; without `role` "Drafts" applies.
    this.errText =
      view.status === 'err' ? reasonText(view.reason, { tok: view.auth === 'token', role: view.role ?? null }) : '';
    if (view.status === 'ok') this.good = k;
    else if (this.good === k) this.good = null;
    this.checkedAt = view.checked_at ? Date.parse(view.checked_at) : this.checkedAt;
    if (view.identities.length > 0) this.identities = view.identities;
    this.confirmed++;
  }

  set<K extends MailDraftKey>(key: K, value: MailDraft[K]): void {
    this.edits = { ...this.edits, [key]: value };
  }

  /** "Discard". */
  discard(): void {
    this.edits = {};
  }

  /**
   * Check failed: status "No connection" with reason and error toast
   * ("Connection failed", or the reason when sending a test email).
   */
  #fail(conn: string, text: string, toast: string = m.system_mail_test_failed()): void {
    this.result = 'err';
    this.errText = text;
    this.tested = conn;
    // If a previously good connection fails, it is no longer "Connected" (`good` becomes null).
    if (this.good === conn) this.good = null;
    this.checkedAt = Date.now();
    ui.toasts.error(toast);
  }

  /** "Test connection"; `quiet` reports only errors. */
  async test(quiet = false): Promise<void> {
    if (this.busy) return;
    // A stored new secret is only in the backend after the toast: send it first (checks itself).
    if (unsettled()) await settle();
    if (this.busy || this.#disposed) return;
    const d = this.draft;
    const conn = connOf(d);
    const local = precheck(d, this.saved, this.servers);
    if (local) {
      this.#fail(conn, local);
      return;
    }
    this.checks++;
    this.rot += 720;
    try {
      const res = await api<{ identities: MailIdentity[] }>('POST', 'admin/system-mail/test', {
        ...connBody(d),
        ...this.#identityOf(d),
      });
      if (this.#disposed) return;
      if (!sameIdentities(this.identities, res.identities)) this.confirmed++;
      this.identities = res.identities;
      this.result = 'ok';
      this.errText = '';
      this.tested = conn;
      this.good = conn;
      this.checkedAt = Date.now();
      if (!quiet) ui.toasts.show(m.system_mail_test_ok());
    } catch (error) {
      if (this.#disposed) return;
      if (isApiError(error, 401) || isApiError(error, 403)) {
        void session.refreshUser().catch(() => {});
        return;
      }
      // Without a response, a server error or 429 nothing is known about the connection: the status stays. The
      // silent check without a connection reports nothing, "Not checked" stays.
      if (!isCheckError(error)) {
        if (!quiet || error instanceof ApiError) ui.toasts.error(toastText(error));
        return;
      }
      this.#fail(conn, errorText(error, d));
    } finally {
      this.checks--;
    }
  }

  /**
   * `identity_id` for checking and saving: another account (server, sign-in
   * method, user or new token) might not know the stored identity, and the
   * page has no selection. It then only applies if the last successful check
   * of this connection returned it, otherwise the first one (`null`).
   */
  #identityOf(d: MailDraft): { identity_id?: null } {
    const id = this.saved.identity_id;
    const b = this.base;
    const same =
      d.srv === b.srv && d.auth === b.auth && (d.auth === 'token' ? secretOf(d) === '' : d.user.trim() === b.user);
    if (id === null || same) return {};
    return this.good === connOf(d) && this.identities.some((i) => i.id === id) ? {} : { identity_id: null };
  }

  /**
   * "Send" in the Test section: test email with the draft as long as it is
   * checked. The backend signs in first for it; if
   * that fails (reasons of the connection), the check counts as failed and the
   * toast names the reason. If only the mail fails afterwards, the status
   * stays ("… wasn’t sent").
   */
  async send(): Promise<void> {
    if (this.key !== 'ok' || this.sending) return;
    const to = (this.to ?? session.user?.email ?? '').trim();
    if (!isEmail(to)) {
      ui.toasts.show(m.system_mail_to_invalid());
      return;
    }
    this.sending = true;
    let d = this.draft;
    try {
      if (unsettled()) await settle();
      d = this.draft;
      if (this.key !== 'ok' || this.#disposed) return;
      await api('POST', 'admin/system-mail/test', { ...draftBody(d), ...this.#identityOf(d), to });
      if (!this.#disposed) ui.toasts.show(m.system_mail_sent({ to }));
    } catch (error) {
      if (this.#disposed) return;
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
      else if (isConnectionError(error)) {
        const text = errorText(error, d);
        this.#fail(connOf(d), text, text);
      } else if (error instanceof ApiError && error.code === 'mail_failed') {
        ui.toasts.error(m.system_mail_send_failed({ to }));
      } else ui.toasts.error(toastText(error));
    } finally {
      this.sending = false;
    }
  }

  /** "Save" with toast and undo. */
  async save(): Promise<void> {
    if (unsettled()) await settle();
    if (!this.dirty || this.#disposed) return;
    const d = this.draft;
    const prev = this.saved;
    const body: Record<string, unknown> = { ...changedBody(d, this.base), ...this.#identityOf(d) };
    const secret = secretOf(d) !== '';
    const next: SystemMail = {
      ...prev,
      server_id: d.srv || null,
      auth: d.auth,
      user: typeof body.user === 'string' ? body.user : prev.user,
      has_secret: secret || (prev.has_secret && prev.auth === d.auth),
      identity_id: 'identity_id' in body ? null : prev.identity_id,
      sender_name: d.name.trim() || null,
      reply_to: d.replyTo.trim() || null,
      keep_sent: d.keepSent,
    };
    // Checks of the draft apply to the empty secret field after saving; with a new secret, checks with the
    // previously stored one no longer apply.
    const before = connOf(d);
    const after = connOf(draftOf(next));
    const rebase = (snap: string | null) => (snap === before ? after : secret && snap === after ? null : snap);
    const snaps = { tested: this.tested, good: this.good };
    this.saved = next;
    this.edits = {};
    this.tested = rebase(snaps.tested);
    this.good = rebase(snaps.good);
    const changed = Object.keys(body).length > 0;
    ui.toasts.defer({
      text: m.system_mail_saved(),
      revert: () => {
        deferred = false;
        // A later save stays.
        if (this.saved !== next) return;
        this.saved = prev;
        this.tested = snaps.tested;
        this.good = snaps.good;
      },
      // Only whitespace changed: nothing to send.
      ...(changed && {
        commit: (keepalive: boolean) => {
          deferred = false;
          const run = this.#put(body, next, keepalive);
          inflight = run;
          const clear = (): void => {
            if (inflight === run) inflight = null;
          };
          run.then(clear, clear);
          return run;
        },
      }),
      onError: (error) => {
        // The unsaved fields (with the entered secret) back as inputs with the bar;
        // later inputs take precedence.
        const back: Partial<MailDraft> = {};
        for (const k of DRAFT_KEYS) if (d[k] !== draftOf(prev)[k]) Object.assign(back, { [k]: d[k] });
        this.edits = { ...back, ...this.edits };
        if (isApiError(error, 401) || isApiError(error, 403)) {
          void session.refreshUser().catch(() => {});
          return;
        }
        // 422 per field: there are no texts per field, so the general error.
        ui.toasts.error(failText(error, m.error_act()));
      },
      // "Undo": the inputs go back to the previous state too.
      onUndo: () => {
        this.edits = {};
      },
    });
    deferred = changed;
  }

  /** `PUT` after the toast; the backend checks a new connection along the way ("Checking …"). */
  async #put(body: Record<string, unknown>, next: SystemMail, keepalive: boolean): Promise<void> {
    const connection = touchesConnection(body);
    const check = connection && !this.#disposed;
    if (check) {
      this.checks++;
      this.rot += 720;
    }
    try {
      const view = await api<SystemMail>('PUT', 'admin/system-mail', body, { keepalive });
      // `system_mail_configured` (notice bar, users page) depends only on the connection.
      if (connection) void session.refreshUser().catch(() => {});
      if (this.#disposed || this.saved !== next) return;
      this.#adopt(view);
      if (check && view.status === 'err') ui.toasts.error(m.system_mail_test_failed());
    } finally {
      if (check) this.checks--;
    }
  }

  dispose(): void {
    this.#disposed = true;
  }
}

/** Card "Status"; colours per `key` in the page. */
export interface MailStatusCard {
  key: MailStatusKey;
  icon: IconName;
  title: string;
  sub: string;
}

export interface MailSecretValues {
  label: string;
  desc: string;
  value: string;
  /** Placeholder while a stored secret of the same sign-in method applies. */
  ph: string;
  type: 'text' | 'password';
  ac: 'off' | 'new-password';
  eyeIcon: IconName;
  eyeTip: string;
  onChange: (value: string) => void;
  onEye: () => void;
}

/** Values of the page (without the template preview). */
export interface SystemMailValues {
  mailTabs: { label: string; onClick: () => void }[];
  mSt: MailStatusCard;
  mailBusy: boolean;
  mailRot: number;
  mailBtn: string;
  mailTest: () => void;
  mailOk: boolean;
  mailNotOk: boolean;
  mailRows: { k: string; v: string; sep: boolean }[];
  mailF: MailDraft;
  mailOn: Record<'user' | 'name' | 'replyTo', (value: string) => void>;
  mailAuthOpts: SegOption<MailAuth>[];
  mailIsPw: boolean;
  mailSecret: MailSecretValues;
  mailNamePh: string;
  mailFrom: string;
  tgMailSent: { on: boolean; onClick: () => void };
  mailToVal: string;
  onMailTo: (value: string) => void;
  mailSendDis: boolean;
  mailSendLabel: string;
  mailSend: () => void;
  mailToKey: (event: { key: string; preventDefault: () => void }) => void;
  mailDirty: boolean;
  mailSave: () => void;
  mailDiscard: () => void;
  selMailSrv: SelectValues;
  mailSrvHas: boolean;
  mailSrvNone: boolean;
  mailSrvSub: string;
  mailSrvGo: () => void;
}

export interface SystemMailInput extends SelectState<MailPick> {
  now?: number;
}

export interface SystemMailContext extends SelectContext<MailPick> {
  scrollTo: (section: MailSection) => void;
  /** "Manage mail servers": Administration › Mail servers. */
  goServers: () => void;
}

/** Equal identities in the same order (the first applies without a choice). */
function sameIdentities(a: readonly MailIdentity[], b: readonly MailIdentity[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => x.id === b[i]?.id && x.name === b[i].name && x.email === b[i].email)
  );
}

/** Sender of the preview: sender name or name of the identity with its address. */
function fromOf(name: string, id: MailIdentity | undefined, user: string): string {
  const shown = name.trim() || id?.name || '';
  const email = id?.email ?? (isEmail(user.trim()) ? user.trim() : '');
  if (!email) return shown;
  return shown ? `${shown} <${email}>` : email;
}

export function systemMailValues(p: SystemMailPage, input: SystemMailInput, ctx: SystemMailContext): SystemMailValues {
  const d = p.draft;
  const token = d.auth === 'token';
  const server = p.servers.find((s) => s.id === d.srv);
  const host = server ? hostOf(server.url) : '';
  const key = p.key;
  const ok = key === 'ok';
  const shownHost = host || m.system_mail_host_fallback();
  const card: Record<MailStatusKey, Omit<MailStatusCard, 'key'>> = {
    busy: { icon: 'ti-search', title: m.system_mail_st_busy(), sub: m.system_mail_st_busy_sub({ host: shownHost }) },
    new: { icon: 'ti-plug', title: m.system_mail_st_new(), sub: m.system_mail_st_new_sub() },
    unchecked: { icon: 'ti-plug', title: m.system_mail_st_new(), sub: m.system_mail_st_unchecked_sub() },
    none: { icon: 'ti-mail-off', title: m.system_mail_st_none(), sub: m.system_mail_st_none_sub() },
    ok: { icon: 'ti-circle-check', title: m.system_mail_st_ok(), sub: m.system_mail_st_ok_sub({ host: shownHost }) },
    err: { icon: 'ti-alert-triangle', title: m.system_mail_st_err(), sub: p.errText },
  };
  const id = p.identities.find((i) => i.id === p.saved.identity_id) ?? p.identities[0];
  const stored = p.saved.has_secret && p.saved.auth === d.auth;
  const toVal = p.to ?? session.user?.email ?? '';
  const canSend = ok && !p.sending;
  const send = () => void p.send();
  const select = selectValues(
    'mailsrv',
    m.system_mail_srv_title(),
    p.servers.map((s) => ({ v: s.id, l: s.label, sub: hostOf(s.url) })),
    d.srv,
    (v) => p.set('srv', v),
    p.servers.length === 0,
    input,
    ctx,
  );
  if (!server) select.label = p.servers.length > 0 ? m.system_mail_srv_choose() : m.system_mail_srv_empty();
  return {
    mailTabs: MAIL_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    mSt: { key, ...card[key] },
    mailBusy: p.busy,
    mailRot: p.rot,
    mailBtn: p.busy ? m.system_mail_test_busy() : m.system_mail_test(),
    mailTest: () => void p.test(),
    mailOk: ok,
    mailNotOk: !ok,
    mailRows: [
      [m.system_mail_row_session(), server ? `${server.url.trim().replace(/\/+$/, '')}/jmap/session` : ''],
      [m.system_mail_row_account(), token ? m.system_mail_row_token() : d.user.trim()],
      [m.system_mail_row_checked(), p.checkedAt === null ? '' : ago(p.checkedAt, input.now)],
    ].map(([k = '', v = ''], i) => ({ k, v, sep: i > 0 })),
    mailF: d,
    mailOn: {
      user: (v) => p.set('user', v),
      name: (v) => p.set('name', v),
      replyTo: (v) => p.set('replyTo', v),
    },
    mailAuthOpts: segOptions<MailAuth>(
      ['password', 'token'],
      d.auth,
      (a) => (a === 'token' ? m.system_mail_auth_token() : m.system_mail_auth_password()),
      (a) => p.set('auth', a),
    ),
    mailIsPw: !token,
    mailSecret: {
      label: token ? m.system_mail_secret_token() : m.system_mail_secret_password(),
      desc: token ? m.system_mail_secret_token_desc() : m.system_mail_secret_password_desc(),
      value: token ? d.token : d.pass,
      ph: stored ? m.system_mail_secret_stored_ph() : '',
      type: p.showSecret ? 'text' : 'password',
      ac: token ? 'off' : 'new-password',
      eyeIcon: p.showSecret ? 'ti-eye-off' : 'ti-eye',
      eyeTip: p.showSecret ? m.system_mail_secret_hide() : m.system_mail_secret_show(),
      onChange: (v) => p.set(token ? 'token' : 'pass', v),
      onEye: () => {
        p.showSecret = !p.showSecret;
      },
    },
    mailNamePh: id?.name ?? '',
    mailFrom: fromOf(d.name, id, d.user),
    tgMailSent: { on: d.keepSent, onClick: () => p.set('keepSent', !p.draft.keepSent) },
    mailToVal: toVal,
    onMailTo: (v) => {
      p.to = v;
    },
    mailSendDis: !canSend,
    mailSendLabel: p.sending ? m.system_mail_sending() : m.system_mail_send(),
    mailSend: send,
    mailToKey: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      send();
    },
    mailDirty: p.dirty,
    mailSave: () => void p.save(),
    mailDiscard: () => p.discard(),
    selMailSrv: select,
    mailSrvHas: p.servers.length > 0,
    mailSrvNone: p.servers.length === 0,
    mailSrvSub: server
      ? m.system_mail_srv_sub({ host })
      : p.servers.length > 0
        ? m.system_mail_srv_sub_pick()
        : m.system_mail_srv_sub_none(),
    mailSrvGo: ctx.goServers,
  };
}
