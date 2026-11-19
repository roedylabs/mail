/**
 * Flow of the setup wizard against the setup API in five steps: language
 * and appearance, setup token, administrator, password and review, then
 * `setup/complete`. The setup token goes along in the header
 * `X-Setup-Token`; every response can reject it (back to the token step)
 * or report that the setup is already complete (then the page reloads the
 * session and the layout redirects to the sign-in). A request without an
 * answer shows "No connection" (`offline`); everything entered stays.
 *
 * Session of this browser tab (`sessionStorage`, keys `roedy-setup-*`):
 * language, theme, accent, name and email, and the step to return to on a
 * reload. The setup token and the passwords live in memory only. A reload on
 * steps 3–5 returns to step 2 with the stored values prefilled; a tab
 * without setup data starts with language System, theme System, accent
 * Apricot.
 *
 * Mail servers and system emails are added afterwards under Administration;
 * the public address comes from `ROEDY_PUBLIC_URL`.
 */
import { ACCENTS, DEFAULT_ACCENT, type AccentName } from '@roedy/tokens';
import { ApiError, NetworkError, api, fieldsOf, retryAfter } from '#lib/api.ts';
import { isHexColor, parseHex, type HexColor } from '#lib/color.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { nameError, nameErrorText, normalizeName } from '#lib/name.ts';
import { meetsPolicy, tooLong } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { isLocale } from '#lib/paraglide/runtime.js';
import type { AccentChoice, LangChoice, ModeName } from '#lib/state/prefs.svelte.ts';
import { waitText } from '#lib/wait.ts';

/** Command in the terminal box of the token step. */
export const LOG_CMD = 'docker logs roedy-mail 2>&1 | grep Setup-Token';

/** Duration of the welcome page until the sign-in (progress bar 2.6 s). */
export const DONE_MS = 2700;

/** Number of steps (step indicator "Step {n} of 5"). */
export const STEPS = 5;

/**
 * 1 language and appearance, 2 setup token, 3 administrator, 4 password,
 * 5 review.
 */
export type Step = 1 | 2 | 3 | 4 | 5;
/** First step the wizard shows: language and appearance. */
export const FIRST_STEP: Step = 1;

export type Field = 'token' | 'name' | 'email' | 'pw' | 'pw2';
/**
 * Where focus goes when a step opens: a field, the selected language card
 * (`lang`, step 1) or the step heading.
 */
export type Focus = Field | 'lang' | 'heading';

// ---- Session of this browser tab ----

/** Keys in `sessionStorage` (with the prefix `roedy-setup-`); token and passwords are never stored. */
export type SessionKey = 'lang' | 'dark' | 'accent' | 'accentHex' | 'name' | 'email' | 'step';
export const SESSION_PREFIX = 'roedy-setup-';

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Values whose write failed (storage full or blocked): kept for the life of
 * the page, so the wizard and `setup/complete` still see what was chosen.
 */
let unsaved: Partial<Record<SessionKey, string | null>> = {};

export function readSession(key: SessionKey): string | null {
  if (key in unsaved) return unsaved[key] ?? null;
  try {
    return store()?.getItem(SESSION_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

/** Stores a value; `null` removes it. */
export function writeSession(key: SessionKey, value: string | null): void {
  try {
    const s = store();
    if (s) {
      if (value === null) s.removeItem(SESSION_PREFIX + key);
      else s.setItem(SESSION_PREFIX + key, value);
      delete unsaved[key];
      return;
    }
  } catch {
    // Storage full or blocked: below.
  }
  // The value stays in memory only (lost on a reload).
  unsaved[key] = value;
}

/** Removes all `roedy-setup-*` keys (the done screen, once it has read the first name). */
export function clearSession(): void {
  unsaved = {};
  try {
    const s = store();
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i--) {
      const key = s.key(i);
      if (key?.startsWith(SESSION_PREFIX)) s.removeItem(key);
    }
  } catch {
    // Nothing to remove.
  }
}

/** Language, theme and accent of the first step; stored as the administrator's settings by `setup/complete`. */
export interface SetupChoices {
  lang: LangChoice;
  mode: ModeName;
  accent: AccentChoice;
}

/** Theme in the session: `sys`, `1` (dark) or `0` (light). */
const MODE_KEYS: Record<ModeName, string> = { system: 'sys', dark: '1', light: '0' };

/** Stored choices; a tab without setup data: language System, theme System, accent Apricot. */
export function choicesOf(): SetupChoices {
  const lang = readSession('lang');
  const dark = readSession('dark');
  const accent = readSession('accent');
  const hex = parseHex(readSession('accentHex') ?? '');
  const named = (Object.keys(ACCENTS) as AccentName[]).find((a) => a === accent);
  return {
    lang: lang !== null && isLocale(lang) ? lang : 'system',
    mode: dark === '1' ? 'dark' : dark === '0' ? 'light' : 'system',
    accent: accent === 'custom' && hex ? hex : (named ?? DEFAULT_ACCENT),
  };
}

/** Custom accent of the session (kept while a named accent is chosen), `null` without one. */
export function customHexOf(): HexColor | null {
  return parseHex(readSession('accentHex') ?? '');
}

/** Stores one choice of the first step. */
export function storeChoice(patch: Partial<SetupChoices>): void {
  if (patch.lang !== undefined) writeSession('lang', patch.lang);
  if (patch.mode !== undefined) writeSession('dark', MODE_KEYS[patch.mode]);
  if (patch.accent !== undefined) {
    const custom = isHexColor(patch.accent);
    writeSession('accent', custom ? 'custom' : patch.accent);
    if (custom) writeSession('accentHex', patch.accent);
  }
}

/** Step after a reload: step 1 stays, steps 2–5 return to step 2 (token and password must be entered again). */
export function resumeStep(): Step {
  return Number(readSession('step')) >= 2 ? 2 : FIRST_STEP;
}

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

export interface SetupHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: Field) => void;
  /** Step changed: focus the field or heading (`null`: the focus follows from `fail`). */
  entered?: (step: Step, focus: Focus | null) => void;
  /** Error without a text of its own: error toast (`ui.toasts.error`). */
  error?: (text: string) => void;
  /** A request got no answer: "No connection". */
  offline?: () => void;
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

/** Focus when a step opens: its first field or the selected language card, otherwise its heading. */
const FIRST: Partial<Record<Step, Focus>> = { 1: 'lang', 2: 'token', 3: 'name', 4: 'pw' };

export function focusOf(step: Step): Focus {
  return FIRST[step] ?? 'heading';
}

export class SetupFlow {
  step = $state<Step>(FIRST_STEP);
  view = $state<'form' | 'done'>('form');
  loading = $state(false);
  err = $state<Errors>({});

  // Step 2
  token = $state('');
  tokErr = $state<'short' | 'invalid' | 'locked' | null>(null);
  /** Attempts until the lock from `remaining`. */
  remaining = $state<number | null>(null);

  // Steps 3 and 4
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
    // Reload: back to step 1 or 2 with the stored values.
    this.step = resumeStep();
    this.name = readSession('name') ?? '';
    this.email = readSession('email') ?? '';
    writeSession('step', String(this.step));
  }

  /** Opening the wizard: focus as on entering the step. */
  enter(): void {
    this.hooks.entered?.(this.step, focusOf(this.step));
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
      step: 3,
    },
  ]);

  firstName = $derived(normalizeName(this.name).split(' ')[0] ?? '');

  // ---- Inputs ----

  /** Changes a field and discards its error. */
  edit(field: Exclude<Field, 'token'>, value: string): void {
    this[field] = value;
    if (field === 'name' || field === 'email') writeSession(field, value);
    const err = { ...this.err, [field]: undefined };
    if (field === 'pw') err.pw2 = undefined;
    this.err = err;
  }

  /** Token input; not while it is being checked (completion sends the token the server accepted). */
  editToken(value: string): void {
    if (this.loading) return;
    this.token = formatToken(value);
    if (this.tokErr !== 'locked') this.tokErr = null;
  }

  /** "Back" keeps everything entered; not while a request is running. */
  canBack = $derived(this.step > FIRST_STEP && !this.loading);

  back(): void {
    if (this.canBack) this.go((this.step - 1) as Step);
  }

  /** "Change" in the overview, into the first field of the step; not while completion is running. */
  revisit(step: Step): void {
    if (!this.loading) this.go(step);
  }

  go(step: Step, focus: Focus | null = focusOf(step)): void {
    this.step = step;
    this.loading = false;
    this.err = {};
    writeSession('step', String(step));
    this.hooks.entered?.(step, focus);
  }

  // ---- Steps ----

  /** "Get started" on step 1: nothing is sent, the choices are already in the session. */
  start(): void {
    if (this.step === 1) this.go(2);
  }

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
      this.go(3);
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
    this.go(4);
  }

  submitPw(): void {
    const err: Errors = {};
    if (tooLong(this.pw)) err.pw = m.password_too_long();
    else if (!meetsPolicy(this.pw)) err.pw = true;
    else if (this.pw2 !== this.pw) err.pw2 = this.pw2 ? m.setup_pw2_mismatch() : m.setup_pw2_required();
    if (this.failWith(err, ['pw', 'pw2'])) return;
    this.go(5);
  }

  async finish(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const body = {
      // The same value the check of step 2 saw (a tab from a copied cell becomes a space).
      name: normalizeName(this.name),
      email: this.email.trim(),
      password: this.pw,
      settings: choicesOf(),
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
    if (this.step === 2) this.hooks.entered?.(2, 'token');
  }

  /**
   * Responses every step can get: token wrong or locked (back to the token
   * step), setup already complete (reload, the layout redirects to the
   * sign-in), no answer ("No connection"); everything else as a toast.
   */
  private async rejected(error: unknown): Promise<void> {
    if (error instanceof NetworkError && this.hooks.offline) {
      this.hooks.offline();
      return;
    }
    if (error instanceof ApiError) {
      if (error.code === 'setup_done') {
        await this.hooks.reload?.();
        return;
      }
      if (error.code === 'invalid_token') {
        const remaining = error.body.remaining;
        this.remaining = typeof remaining === 'number' ? remaining : null;
        if (this.step !== 2) this.go(2, null);
        this.tokErr = 'invalid';
        this.hooks.fail?.('token');
        return;
      }
      if (error.status === 429) {
        if (this.step !== 2) this.go(2, null);
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
      name: [3, 'name'],
      email: [3, 'email'],
      password: [4, 'pw'],
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
    this.go(step, null);
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
