/**
 * Flow of the setup page against the setup API: token, administrator,
 * password and review, then `setup/complete`. The setup token goes along in
 * the header `X-Setup-Token`; every response can reject it (back to step 1)
 * or report that the setup is already complete (then the page reloads the
 * session and the layout redirects to the sign-in).
 *
 * Mail servers and system emails are added afterwards under Administration;
 * the public address comes from `ROEDY_PUBLIC_URL`.
 */
import { ApiError, api, fieldsOf, retryAfter } from '#lib/api.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { nameError, nameErrorText, normalizeName } from '#lib/name.ts';
import { meetsPolicy, tooLong } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { waitText } from '#lib/wait.ts';

/** Command in the terminal box of step 1. */
export const LOG_CMD = 'docker logs roedy-mail 2>&1 | grep Setup-Token';

/** Duration of the welcome page until the sign-in (progress bar 2.6 s). */
export const DONE_MS = 2700;

/** Appearance of the new administrator until the wizard asks for it. */
const MODE = 'system';
const ACCENT = 'apricot';

export type Step = 1 | 2 | 3 | 4;
export type Field = 'token' | 'name' | 'email' | 'pw' | 'pw2';
/** Where focus goes when a step opens: a field or, in the overview, its heading. */
export type Focus = Field | 'review';

/** `true` marks a field without its own text (password rules as chips). */
export type FieldError = string | true;
/** Errors per field. */
export type Errors = { [K in Field]?: FieldError | undefined };

/** Values of the page. */
export interface SetupPageValues {
  appVersion: string;
}

export interface ReviewRow {
  icon: 'ti-user-shield';
  label: string;
  value: string;
  step: Step;
}

/** Phase of the page; decides the icon of the tile in the background. */
export type Phase = 'token' | 'admin' | 'password' | 'review' | 'loading' | 'error' | 'locked' | 'success';

export interface SetupHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: Field) => void;
  /** Step changed: focus the field or heading. */
  entered?: (step: Step, focus?: Focus) => void;
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

/** First field per step for "Change" in the overview. */
const FIRST: Partial<Record<Step, Field>> = { 1: 'token', 2: 'name', 3: 'pw' };

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

  /** Lock of the setup token with countdown (the clock only runs while it applies). */
  readonly locks = new Countdown<'token'>(() => this.freed());
  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  readonly hooks: SetupHooks;

  constructor(hooks: SetupHooks = {}) {
    this.hooks = hooks;
  }

  // ---- Derivations ----

  locked = $derived(this.locks.active('token'));
  tokLeft = $derived(this.locks.left('token'));

  tokErrText = $derived.by(() => {
    if (this.tokErr === 'locked') return m.setup_token_locked_text({ wait: waitText(this.tokLeft) });
    const n = this.remaining;
    const rest = n === null ? '' : ` ${n === 1 ? m.setup_token_remaining_one() : m.setup_token_remaining({ n })}`;
    return m.setup_token_invalid_text() + rest;
  });

  review = $derived.by((): ReviewRow[] => [
    {
      icon: 'ti-user-shield',
      label: m.setup_review_admin(),
      value: `${normalizeName(this.name)} · ${this.email.trim()}`,
      step: 2,
    },
  ]);

  firstName = $derived(normalizeName(this.name).split(' ')[0] ?? '');

  phase = $derived.by((): Phase => {
    if (this.view === 'done') return 'success';
    if (this.loading) return 'loading';
    if (this.locked) return 'locked';
    if ((this.step === 1 && this.tokErr === 'invalid') || Object.values(this.err).some(Boolean)) return 'error';
    return (['token', 'admin', 'password', 'review'] as const)[this.step - 1] ?? 'review';
  });

  // ---- Inputs ----

  /** Changes a field and discards its error. */
  edit(field: Exclude<Field, 'token'>, value: string): void {
    this[field] = value;
    const err = { ...this.err, [field]: undefined };
    if (field === 'pw') err.pw2 = undefined;
    this.err = err;
  }

  editToken(value: string): void {
    this.token = formatToken(value);
    if (this.tokErr !== 'locked') this.tokErr = null;
  }

  /** "Back"; not while completion is running. */
  back(): void {
    if (this.step > 1 && !this.loading) this.go((this.step - 1) as Step);
  }

  /** "Change" in the overview, into the first field of the step; not while completion is running. */
  revisit(step: Step): void {
    if (!this.loading) this.go(step, FIRST[step]);
  }

  go(step: Step, focus?: Focus): void {
    this.step = step;
    this.loading = false;
    this.err = {};
    this.hooks.entered?.(step, focus);
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
      await api('POST', 'setup/token', { token: this.token });
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
    this.go(4, 'review');
  }

  async finish(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const body = {
      // The same value the check of step 2 saw (a tab from a copied cell becomes a space).
      name: normalizeName(this.name),
      email: this.email.trim(),
      password: this.pw,
      settings: { lang: getLocale(), mode: MODE, accent: ACCENT },
    };
    try {
      await api('POST', 'setup/complete', body, this.withToken());
      this.loading = false;
      this.view = 'done';
      // The password is no longer needed.
      this.pw = this.pw2 = '';
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

  /** The token lock has expired: release the field. */
  private freed(): void {
    this.tokErr = null;
    if (this.step === 1) this.hooks.entered?.(1, 'token');
  }

  /**
   * Responses every step can get: token wrong or locked (back to step 1), setup
   * already complete (reload, the layout redirects to the sign-in); everything
   * else as a toast.
   */
  private async rejected(error: unknown): Promise<void> {
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
    }
    this.hooks.error?.(failText(error));
  }

  /** Field errors of `setup/complete`: to the first affected step with the text of the field. */
  private completeInvalid(error: ApiError): void {
    const targets: Record<string, [Step, Field]> = {
      name: [2, 'name'],
      email: [2, 'email'],
      password: [3, 'pw'],
    };
    let step: Step | null = null;
    let first: Field | undefined;
    const err: Errors = {};
    for (const [path, detail] of Object.entries(fieldsOf(error))) {
      const target = targets[path];
      if (!target) continue;
      const [at, field] = target;
      const text = path === 'password' && detail.code === 'policy' ? true : fieldText(field, detail.code);
      if (!text) continue;
      err[field] = text;
      if (step === null || at < step) {
        step = at;
        first = field;
      }
    }
    if (step === null) {
      this.hooks.error?.(failText(error));
      return;
    }
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
    default:
      return null;
  }
}
