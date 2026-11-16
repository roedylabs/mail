/**
 * Account › Profile against `PATCH auth/me`: display name and user name apply
 * immediately, a new email address in two steps – first the server checks
 * format and availability (`reauth_required`), then with the current password
 * and, with multi-factor, a code; afterwards notice and confirmation link go
 * out (`email_sent`). "Confirmation pending" comes from `auth/me` ›
 * `email_change`, with "Resend link" and "Discard change".
 *
 * Saving goes to the server immediately, without undo: it checks user name and
 * address, and its response decides whether the password prompt follows.
 * "Discard change" waits with undo for the end of the toast
 * (`ui.toasts.defer`). Errors without a text of their own show the error
 * toast.
 */
import { api, fieldsOf, isApiError, retryAfter } from '#lib/api.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import type { KeyInput } from '#lib/keys.ts';
import { formatOtp } from '#lib/login.svelte.ts';
import { nameError, nameErrorText, normalizeName } from '#lib/name.ts';
import { m } from '#lib/paraglide/messages.js';
import { CODE_LENGTH, reauthError } from '#lib/reauth.ts';
import { initialsOf, session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { waitText } from '#lib/wait.ts';

/** Editable rows. */
export type ProfileField = 'login' | 'email';

/** Pending change of the address from `auth/me` or the response. */
export type EmailChange = NonNullable<Me['email_change']>;

/** User like `user_json` of the backend. */
type ProfileUser = Pick<Me, 'id' | 'username' | 'email' | 'display_name' | 'role'>;

/** Response of `PATCH auth/me`. */
interface ProfileResponse {
  status: 'ok' | 'reauth_required' | 'email_sent';
  user: ProfileUser;
  email_change?: EmailChange;
}

/** User name like the backend (`^[a-z0-9][a-z0-9._-]{1,31}$`). */
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export class ProfilePage {
  /** Display name being edited; `null` = reading. */
  nameDraft = $state<string | null>(null);
  /** User name or address being edited. */
  drafts = $state<Partial<Record<ProfileField, string>>>({});
  /** Message below the row. */
  errors = $state<Partial<Record<ProfileField, string>>>({});
  /** New address waits for password and code. */
  ea = $state<{ email: string } | null>(null);
  eaPw = $state('');
  eaOtp = $state('');
  eaShowPw = $state(false);
  eaErr = $state<string | null>(null);
  /** Message after "Resend link". */
  pendErr = $state<string | null>(null);
  saving = $state(false);
  sending = $state(false);
  resending = $state(false);

  get mfa(): boolean {
    return session.user?.mfa_enabled ?? false;
  }

  /** "Send confirmation link" ready: password and, with multi-factor, a code. */
  get eaReady(): boolean {
    return !!this.eaPw && (!this.mfa || !!this.eaOtp);
  }

  /** Unsaved changes (`nameDirty`): an input differs from the account. */
  get dirty(): boolean {
    const user = session.user;
    if (!user) return false;
    const name = this.nameDraft;
    if (name !== null && normalizeName(name) !== user.display_name) return true;
    const current: Record<ProfileField, string> = { login: user.username ?? '', email: user.email };
    return (Object.entries(this.drafts) as [ProfileField, string][]).some(([k, v]) => v.trim() !== current[k]);
  }

  // ---- Display name and rows ----

  editName(): void {
    this.nameDraft = session.user?.display_name ?? '';
  }

  setName(value: string): void {
    this.nameDraft = value;
  }

  /** Leaving the field: empty or unchanged goes back to reading. */
  blurName(): void {
    if (this.nameDraft === null) return;
    const name = normalizeName(this.nameDraft);
    if (!name || name === session.user?.display_name) this.nameDraft = null;
  }

  nameKey(event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.nameDraft = null;
    }
  }

  edit(field: ProfileField): void {
    this.drafts = { ...this.drafts, [field]: this.#current(field) };
  }

  setField(field: ProfileField, value: string): void {
    this.drafts = { ...this.drafts, [field]: value };
    this.#clearError(field);
  }

  blurField(field: ProfileField): void {
    const value = this.drafts[field]?.trim();
    if (value !== undefined && (!value || value === this.#current(field))) this.#drop(field);
  }

  fieldKey(field: ProfileField, event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.#drop(field);
    }
  }

  /** "Discard" of the "Unsaved changes" bar. */
  discardDrafts(): void {
    this.nameDraft = null;
    this.drafts = {};
    this.errors = {};
  }

  // ---- Saving ----

  /**
   * Checks like `saveName` and saves display name and user name; the server
   * checks a new address, then the password prompt follows.
   */
  async save(): Promise<void> {
    const user = session.user;
    if (!user || this.saving) return;
    const body: Record<string, string> = {};
    if (this.nameDraft !== null) {
      const name = normalizeName(this.nameDraft);
      if (!name) {
        ui.toasts.show(m.profile_name_required());
        return;
      }
      // Too long or with invisible characters as when inviting; the profile has no row for it.
      const bad = nameError(name);
      if (bad) {
        ui.toasts.error(nameErrorText(bad));
        return;
      }
      if (name !== user.display_name) body.display_name = name;
    }
    const errors: Partial<Record<ProfileField, string>> = {};
    const login = this.drafts.login?.trim();
    if (login !== undefined) {
      if (!USERNAME.test(login)) errors.login = m.profile_username_invalid();
      else if (login !== (user.username ?? '')) body.username = login;
    }
    const email = this.drafts.email?.trim();
    if (email !== undefined) {
      if (!isEmail(email)) errors.email = m.profile_email_invalid();
      // A different case is also a new address (like the backend).
      else if (email !== user.email) body.email = email;
    }
    if (errors.login || errors.email) {
      this.errors = errors;
      return;
    }
    if (Object.keys(body).length === 0) {
      this.discardDrafts();
      return;
    }
    this.saving = true;
    try {
      // A pending "Discard change" or "Sign out all others" would otherwise discard the new link.
      if (body.email) await ui.toasts.flush();
      const res = await api<ProfileResponse>('PATCH', 'auth/me', body);
      this.#applyUser(res.user);
      this.discardDrafts();
      if (body.display_name !== undefined || body.username !== undefined) ui.toasts.show(m.profile_saved());
      if (res.status === 'reauth_required' && body.email) this.#openAuth(body.email);
    } catch (error) {
      this.#saveFailed(error);
    } finally {
      this.saving = false;
    }
  }

  #saveFailed(error: unknown): void {
    if (isApiError(error, 422, 'email_taken')) {
      this.errors = { ...this.errors, email: m.profile_email_taken() };
      return;
    }
    if (isApiError(error, 422, 'invalid')) {
      const fields = fieldsOf(error);
      const login = fields.username?.code;
      // A taken user name below the row like a taken address; the input stays.
      if (login) {
        this.errors = {
          ...this.errors,
          login: login === 'taken' ? m.profile_username_taken() : m.profile_username_invalid(),
        };
      }
      if (fields.email) this.errors = { ...this.errors, email: m.profile_email_invalid() };
      const name = fields.display_name?.code;
      if (name === 'too_long' || name === 'invalid') ui.toasts.error(nameErrorText(name));
      if (login || fields.email || name === 'too_long' || name === 'invalid') return;
    }
    this.#unexpected(error);
  }

  // ---- Password prompt ----

  setEaPw(value: string): void {
    this.eaPw = value;
    this.eaErr = null;
  }

  setEaOtp(value: string): void {
    this.eaOtp = formatOtp(value);
    this.eaErr = null;
  }

  toggleEaEye(): void {
    this.eaShowPw = !this.eaShowPw;
  }

  eaKey(event: KeyInput): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.sendLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelAuth();
    }
  }

  cancelAuth(): void {
    this.ea = null;
    this.eaPw = '';
    this.eaOtp = '';
    this.eaShowPw = false;
    this.eaErr = null;
  }

  /** "Send confirmation link": the server checks password and code, then both mails go out. */
  async sendLink(): Promise<void> {
    const ea = this.ea;
    if (!ea || this.sending || !this.eaReady) return;
    const mfa = this.mfa;
    if (mfa && this.eaOtp.length !== CODE_LENGTH) {
      this.eaErr = m.reauth_code_short();
      return;
    }
    this.sending = true;
    try {
      await ui.toasts.flush();
      const body = { email: ea.email, password: this.eaPw, ...(mfa ? { code: this.eaOtp } : {}) };
      const res = await api<ProfileResponse>('PATCH', 'auth/me', body);
      this.cancelAuth();
      this.pendErr = null;
      if (res.status === 'email_sent') {
        this.#applyUser(res.user, res.email_change ?? null);
        ui.toasts.show(m.profile_link_sent());
      } else {
        // The address already applies in the meantime (confirmed elsewhere): no link, reload the account.
        this.#applyUser(res.user);
        void session.refreshUser().catch(() => {});
      }
    } catch (error) {
      // Cancelled in the meantime: the message would apply to fields that no longer exist.
      if (this.ea === ea) this.#sendFailed(error, ea.email, mfa);
    } finally {
      this.sending = false;
    }
  }

  #sendFailed(error: unknown, email: string, mfa: boolean): void {
    const reauth = reauthError(error);
    if (reauth) {
      this.eaErr = reauth.text;
      if (reauth.clear === 'password') this.eaPw = '';
      if (reauth.clear === 'code') this.eaOtp = '';
      // Multi-factor turned on in the meantime (another tab): reload the account, then the code field appears.
      if (!mfa && isApiError(error, 422, 'invalid') && fieldsOf(error).code) {
        void session.refreshUser().catch(() => {});
      }
      return;
    }
    if (isApiError(error, 502, 'mail_failed')) {
      // The code is used up; the password stays.
      this.eaErr = mfa ? m.profile_mail_failed_code() : m.profile_mail_failed();
      this.eaOtp = '';
      return;
    }
    if (isApiError(error, 422, 'email_taken')) {
      // As in the first step, in the row: back to entering the address.
      this.cancelAuth();
      this.drafts = { ...this.drafts, email };
      this.errors = { ...this.errors, email: m.profile_email_taken() };
      return;
    }
    if (isApiError(error, 409, 'email_change_discarded')) this.eaOtp = '';
    this.#unexpected(error);
  }

  // ---- Confirmation pending ----

  /** "Resend link": new link with a new 24 hours; if it fails, everything stays. */
  async resend(): Promise<void> {
    if (this.resending) return;
    this.resending = true;
    this.pendErr = null;
    try {
      await ui.toasts.flush();
      const open = await api<EmailChange>('POST', 'auth/me/email/resend');
      const user = session.user;
      if (user) session.user = { ...user, email_change: open };
      ui.toasts.show(m.profile_link_resent());
    } catch (error) {
      if (isApiError(error, 502, 'mail_failed')) {
        this.pendErr =
          error.body.previous_link_valid === true ? m.profile_resend_failed_valid() : m.profile_resend_failed();
      } else if (isApiError(error, 422, 'email_taken')) {
        this.pendErr = m.profile_email_taken();
      } else if (isApiError(error, 429)) {
        // Limit `auth.email.send`.
        this.pendErr = m.error_limit({ wait: waitText(retryAfter(error)) });
      } else if (isApiError(error, 404)) {
        // No pending change anymore (confirmed or discarded elsewhere).
        void session.refreshUser().catch(() => {});
      } else {
        this.#unexpected(error);
      }
    } finally {
      this.resending = false;
    }
  }

  /** "Discard change" with undo: `DELETE auth/me/email` only after the toast expires. */
  discardChange(): void {
    const user = session.user;
    const open = user?.email_change;
    // During "Resend link" its response would set the change right back.
    if (!user || !open || this.resending) return;
    this.pendErr = null;
    session.user = { ...user, email_change: null };
    ui.toasts.defer({
      text: m.profile_discarded(),
      revert: () => {
        const now = session.user;
        if (now?.id === user.id && !now.email_change) session.user = { ...now, email_change: open };
      },
      commit: async (keepalive) => {
        try {
          await api('DELETE', 'auth/me/email', undefined, { keepalive });
        } catch (error) {
          // Already discarded or confirmed: nothing pending anymore.
          if (!isApiError(error, 404)) throw error;
        }
      },
      onError: (error) => {
        // Show the server state; without a session the layout leads to the sign-in.
        void session.refreshUser().catch(() => {});
        if (!isApiError(error, 401)) ui.toasts.error(failText(error, m.error_undo()));
      },
    });
  }

  // ---- internal ----

  #current(field: ProfileField): string {
    const user = session.user;
    return field === 'login' ? (user?.username ?? '') : (user?.email ?? '');
  }

  #drop(field: ProfileField): void {
    const drafts = { ...this.drafts };
    delete drafts[field];
    this.drafts = drafts;
    this.#clearError(field);
  }

  #clearError(field: ProfileField): void {
    if (this.errors[field] === undefined) return;
    const errors = { ...this.errors };
    delete errors[field];
    this.errors = errors;
  }

  #openAuth(email: string): void {
    this.cancelAuth();
    this.ea = { email };
  }

  /** Take over the response with the user (`user_json`); the other fields of `auth/me` stay. */
  #applyUser(user: ProfileUser, emailChange?: EmailChange | null): void {
    const now = session.user;
    if (!now || now.id !== user.id) return;
    session.user = { ...now, ...user, ...(emailChange === undefined ? {} : { email_change: emailChange }) };
  }

  /**
   * Without a text of its own: error toast; a change discarded in the
   * meantime (`email_change_discarded`) with its own text.
   * Without a session the account reloads, the layout then shows the sign-in.
   */
  #unexpected(error: unknown): void {
    const gone = isApiError(error, 409, 'email_change_discarded');
    if (isApiError(error, 401) || gone) void session.refreshUser().catch(() => {});
    if (gone) ui.toasts.error(m.profile_email_gone());
    else if (!isApiError(error, 401)) ui.toasts.error(failText(error));
  }
}

// Values of the page

export interface AcctValues {
  name: string;
  initials: string;
  /** Tile of the initials (`chip`/`ink`, the accent colour). */
  chip: string;
  ink: string;
  nameDesc: string;
  /** Display name is read-only. */
  nameLocked: boolean;
  sub: string;
}

export interface AcctRowValues {
  k: string;
  v: string;
  type: 'text' | 'email';
  canEdit: boolean;
  noEdit: boolean;
  read: boolean;
  editing: boolean;
  val: string;
  editLabel: string;
  err: string;
  hasErr: boolean;
  /** New address waits for password and code ("Email" row only). */
  auth: boolean;
  /** Confirmation pending ("Email" row only). */
  pend: boolean;
  pendEmail: string;
  pendErr: string;
  hasPendErr: boolean;
  /** Response pending ("Resend link"). */
  busy: boolean;
  edit: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKey: (event: KeyInput) => void;
  resend: () => void;
  discard: () => void;
}

export interface EaFieldValues {
  label: string;
  desc: string;
  /** `autocomplete`. */
  ac: 'current-password' | 'one-time-code';
  /** `inputmode` (`text`, `numeric`). */
  im: 'text' | 'numeric';
  type: 'text' | 'password';
  value: string;
  focus: boolean;
  hasEye: boolean;
  eyeIcon: 'ti-eye' | 'ti-eye-off';
  eyeTip: string;
  onChange: (value: string) => void;
  onEye?: () => void;
}

export interface ProfileValues {
  acct: AcctValues;
  acctNameRead: boolean;
  acctNameEditing: boolean;
  acctNameVal: string;
  acctNameEdit: () => void;
  onNameDraft: (value: string) => void;
  onNameBlur: () => void;
  onAcctNameKey: (event: KeyInput) => void;
  acctRows: AcctRowValues[];
  eaIntro: string;
  eaFields: EaFieldValues[];
  eaKey: (event: KeyInput) => void;
  eaMsg: string;
  hasEaMsg: boolean;
  /** "Send confirmation link" still disabled (`aria-disabled`). */
  eaDis: boolean;
  /** Response pending. */
  eaBusy: boolean;
  eaGo: () => void;
  eaCancel: () => void;
  nameDirty: boolean;
  acctSave: () => void;
  acctDiscard: () => void;
}

function accountsText(n: number): string {
  if (n === 0) return m.profile_no_mail_account();
  return n === 1 ? m.profile_one_mail_account() : m.profile_mail_accounts({ n });
}

/**
 * Values per `acctV` of the shell and `newVals` (change email address).
 * `mailAccounts`: linked mail accounts (`acct.sub`) from `accounts`.
 */
export function profileValues(p: ProfilePage, mailAccounts = 0): ProfileValues {
  const user = session.user;
  const name = user?.display_name ?? '';
  const username = user?.username ?? '';
  const pending = user?.email_change ?? null;
  const rows: [ProfileField | null, string, string][] = [
    ['login', m.profile_username(), username],
    ['email', m.profile_email(), user?.email ?? ''],
    [null, m.profile_login(), m.profile_login_password()],
  ];
  const mfa = p.mfa;
  const pwField: EaFieldValues = {
    label: m.reauth_password_label(),
    desc: m.reauth_password_desc(),
    ac: 'current-password',
    im: 'text',
    type: p.eaShowPw ? 'text' : 'password',
    value: p.eaPw,
    focus: true,
    hasEye: true,
    eyeIcon: p.eaShowPw ? 'ti-eye-off' : 'ti-eye',
    eyeTip: p.eaShowPw ? m.password_hide() : m.password_show(),
    onChange: (value) => p.setEaPw(value),
    onEye: () => p.toggleEaEye(),
  };
  const codeField: EaFieldValues = {
    label: m.reauth_code_label(),
    desc: m.reauth_code_desc(),
    ac: 'one-time-code',
    im: 'numeric',
    type: 'text',
    value: p.eaOtp,
    focus: false,
    hasEye: false,
    eyeIcon: 'ti-eye',
    eyeTip: '',
    onChange: (value) => p.setEaOtp(value),
  };
  return {
    acct: {
      name,
      initials: initialsOf(name),
      chip: 'var(--acc)',
      ink: 'var(--accink)',
      nameDesc: m.profile_name_desc(),
      nameLocked: false,
      sub: [username, accountsText(mailAccounts)].filter(Boolean).join(' · '),
    },
    acctNameRead: p.nameDraft === null,
    acctNameEditing: p.nameDraft !== null,
    acctNameVal: p.nameDraft ?? name,
    acctNameEdit: () => p.editName(),
    onNameDraft: (value) => p.setName(value),
    onNameBlur: () => p.blurName(),
    onAcctNameKey: (event) => p.nameKey(event),
    acctRows: rows.map(([id, k, v]) => {
      const draft = id ? p.drafts[id] : undefined;
      const auth = id === 'email' && p.ea !== null;
      const pend = id === 'email' && pending !== null && !auth;
      const err = (id && p.errors[id]) || '';
      const pendErr = pend ? (p.pendErr ?? '') : '';
      return {
        k,
        v: auth && p.ea ? p.ea.email : v,
        type: id === 'email' ? 'email' : 'text',
        canEdit: id !== null && !auth,
        noEdit: id === null || auth,
        read: draft === undefined,
        editing: draft !== undefined && !auth,
        val: draft ?? v,
        editLabel: m.profile_edit_row({ label: k }),
        err,
        hasErr: !!err,
        auth,
        pend,
        pendEmail: pend && pending ? pending.email : '',
        pendErr,
        hasPendErr: !!pendErr,
        busy: pend && p.resending,
        edit: () => id && p.edit(id),
        onChange: (value: string) => id && p.setField(id, value),
        onBlur: () => id && p.blurField(id),
        onKey: (event: KeyInput) => id && p.fieldKey(id, event),
        resend: () => void p.resend(),
        discard: () => p.discardChange(),
      };
    }),
    eaIntro: mfa ? m.profile_ea_intro_code() : m.profile_ea_intro(),
    eaFields: mfa ? [pwField, codeField] : [pwField],
    eaKey: (event) => p.eaKey(event),
    eaMsg: p.eaErr ?? '',
    hasEaMsg: !!p.eaErr,
    eaDis: !p.eaReady,
    eaBusy: p.sending,
    eaGo: () => void p.sendLink(),
    eaCancel: () => p.cancelAuth(),
    nameDirty: p.dirty,
    acctSave: () => void p.save(),
    acctDiscard: () => p.discardDrafts(),
  };
}
