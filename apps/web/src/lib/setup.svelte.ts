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
import { ApiError, NetworkError, api, retryAfter } from '#lib/api.ts';
import { customName } from '#lib/color-editor.svelte.ts';
import { isHexColor, parseHex, type HexColor } from '#lib/color.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { initials, limitName, nameError, normalizeName } from '#lib/name.ts';
import { meetsPolicy, tooLong } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { isLocale } from '#lib/paraglide/runtime.js';
import type { IconName } from '#lib/icons.ts';
import type { AccentChoice, LangChoice, ModeName } from '#lib/state/prefs.svelte.ts';

/** Command in the terminal box of the token step. */
export const LOG_CMD = 'docker logs roedy-mail 2>&1 | grep Setup-Token';
/**
 * Log lines under the command: the container's real output, so English
 * whatever the language of the page.
 */
export const LOG_LINES = {
  shell: 'roedy-mail — bash',
  pending: '[setup] Not set up yet',
  prefix: '[setup] ',
  token: 'Setup-Token: ',
  sample: 'XXXX-XXXX-XXXX',
} as const;
/** Length of the token lock the attempt bar is relative to (seconds). */
export const TOKEN_LOCK_S = 30;
/** Failed attempts until the lock. */
export const TOKEN_TRIES = 5;

/** Duration of the done screen until the sign-in (its bar fills in 2.6 s). */
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

/** A row of the summary on step 5: the step it changes, its tile (initials or icon), label, value and an optional second line. */
export interface ReviewRow {
  step: 1 | 3 | 4;
  icon: IconName;
  /** Initials in place of the icon (administrator). */
  ini: string;
  label: string;
  value: string;
  sub: string;
  /** The value is a placeholder (the password): wider letter spacing. */
  masked: boolean;
}

/** Placeholder of the password in the summary: it is never shown. */
export const MASKED_PW = '••••••••••';

/** Names of the named accents. */
export const ACCENT_LABELS: Record<AccentName, () => string> = {
  apricot: m.appearance_accent_apricot,
  sage: m.appearance_accent_sage,
  lavender: m.appearance_accent_lavender,
  sky: m.appearance_accent_sky,
  rose: m.appearance_accent_rose,
};

/**
 * Language and appearance in one line, e.g. "English · Dark · Apricot": the
 * language by its own name (or "System"), the theme, the accent by name, a
 * custom one as its preset name or "Custom #RRGGBB".
 */
export function choicesSummary(c: SetupChoices): string {
  const lang = c.lang === 'de' ? m.region_lang_de() : c.lang === 'en' ? m.region_lang_en() : m.setup_lang_system();
  const mode =
    c.mode === 'dark'
      ? m.appearance_mode_dark()
      : c.mode === 'light'
        ? m.appearance_mode_light()
        : m.appearance_mode_system();
  const accent = isHexColor(c.accent) ? customName(c.accent) : ACCENT_LABELS[c.accent]();
  return `${lang} · ${mode} · ${accent}`;
}

export interface SetupHooks {
  /** Input rejected: shake the card, focus the field. */
  fail?: (field?: Field) => void;
  /** Incomplete step: focus the field, no message. */
  focus?: (field: Field) => void;
  /** Step changed: focus the field or heading (`null`: the focus follows from `fail`). */
  entered?: (step: Step, focus: Focus | null) => void;
  /** Error without a text of its own: error toast (`ui.toasts.error`). */
  error?: (text: string) => void;
  /** A request got no answer: "No connection". */
  offline?: () => void;
  /** Reload the session: on `setup_done` the layout then shows the sign-in. */
  reload?: () => Promise<void>;
  /** After completion (the done screen's bar has filled): load the signed-in session and open Administration › Mail servers. */
  signedIn?: () => Promise<void>;
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

  // Step 2 (the token lives in memory only)
  token = $state('');
  /** Invalid token, locked after too many attempts, or the check failed on the server. */
  tokErr = $state<'invalid' | 'locked' | 'server' | null>(null);
  /** Attempts until the lock from `remaining`. */
  remaining = $state<number | null>(null);
  /** The server accepted the token: coming back to step 2 needs no new check until it is edited. */
  tokOk = $state(false);

  /** Step 5: `setup/complete` failed on the server; shown in place of the note until the next "Finish setup". */
  finishErr = $state(false);

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
  /** All twelve characters entered (Continue is greyed out until then). */
  tokFull = $derived(this.token.replace(/-/g, '').length === 12);

  /**
   * Summary of step 5, one row per step with input: language and appearance,
   * administrator (initials, name, email), password (never shown). Read
   * fresh each time (the choices of step 1 live in the session storage).
   */
  get review(): ReviewRow[] {
    const name = normalizeName(this.name);
    const ini = initials(name);
    return [
      {
        step: 1,
        icon: 'ti-palette',
        ini: '',
        label: m.setup_review_prefs(),
        value: choicesSummary(choicesOf()),
        sub: '',
        masked: false,
      },
      {
        step: 3,
        icon: 'ti-user-shield',
        ini,
        label: m.setup_review_admin(),
        value: name,
        sub: this.email.trim(),
        masked: false,
      },
      {
        step: 4,
        icon: 'ti-lock',
        ini: '',
        label: m.setup_review_pw(),
        value: MASKED_PW,
        sub: m.setup_review_pw_set(),
        masked: true,
      },
    ];
  }

  firstName = $derived(normalizeName(this.name).split(' ')[0] ?? '');

  /** Step 3 complete: a name with allowed characters only and a valid email address (Continue is greyed out until then). */
  adminReady = $derived(!!normalizeName(this.name) && !nameError(this.name) && isEmail(this.email.trim()));

  /** The password meets the rules and fits (1024 bytes). */
  pwOk = $derived(meetsPolicy(this.pw) && !tooLong(this.pw));
  /** Step 4 complete: the password is fine and the confirmation equals it (Continue is greyed out until then). */
  pwReady = $derived(this.pwOk && !!this.pw2 && this.pw2 === this.pw);

  // ---- Inputs ----

  /**
   * Changes a field and discards its error. The name is checked while
   * typing: at most 100 characters (pasting is cut off too), invalid
   * characters show their message at once. So is the password's length (over
   * 1024 bytes); a new password discards the mismatch of the confirmation.
   */
  edit(field: Exclude<Field, 'token'>, value: string): void {
    if (field === 'name') value = limitName(value);
    this[field] = value;
    if (field === 'name' || field === 'email') writeSession(field, value);
    const err = { ...this.err, [field]: undefined };
    if (field === 'pw') err.pw2 = undefined;
    if (field === 'name' && nameError(value) === 'invalid') err.name = m.setup_name_invalid_text();
    if (field === 'pw' && tooLong(value)) err.pw = m.setup_pw_too_long();
    this.err = err;
  }

  /**
   * Token input; not while it is being checked (completion sends the token
   * the server accepted). Editing an accepted token makes it unaccepted.
   */
  editToken(value: string): void {
    if (this.loading) return;
    const token = formatToken(value);
    if (token !== this.token) this.tokOk = false;
    this.token = token;
    if (this.tokErr !== 'locked') this.tokErr = null;
  }

  /** The step has "Back" (locked while a request is running). */
  canBack = $derived(this.step > FIRST_STEP);

  /** "Back" keeps everything entered; not while a request is running. */
  back(): void {
    if (this.canBack && !this.loading) this.go((this.step - 1) as Step);
  }

  /**
   * "Change" in the summary: to that step, from where the user walks forward
   * through the following steps again; the accepted token and the passwords
   * stay. Not while completion is running.
   */
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

  /**
   * "Continue" on step 2: checks the token (incomplete: nothing happens, the
   * button is greyed out); an accepted token goes on without a new check.
   * Any answer other than accepted, `invalid_token`, the lock or
   * `setup_done` shows the server error in place; no attempt is used up.
   */
  async submitToken(): Promise<void> {
    if (this.loading || this.locked || !this.tokFull) return;
    if (this.tokOk) {
      this.go(3);
      return;
    }
    this.loading = true;
    this.tokErr = null;
    try {
      await api('POST', 'setup/token', { token: this.token });
      this.remaining = null;
      this.tokOk = true;
      this.go(3);
    } catch (error) {
      this.loading = false;
      await this.rejected(error, () => {
        this.tokErr = 'server';
        this.hooks.fail?.();
      });
    }
  }

  /**
   * "Continue" on step 3 (Enter too while it is greyed out): moves the focus
   * to the first empty field, shows the name's message (with the shake) or
   * moves the focus to an invalid address; no message for the address.
   */
  submitAdmin(): void {
    const name = normalizeName(this.name);
    const email = this.email.trim();
    if (!name || !email) {
      this.hooks.focus?.(name ? 'email' : 'name');
      return;
    }
    const bad = nameError(this.name);
    if (bad) {
      this.failWith({ name: bad === 'invalid' ? m.setup_name_invalid_text() : m.error_name_long() }, ['name']);
      return;
    }
    if (!isEmail(email)) {
      this.hooks.focus?.('email');
      return;
    }
    writeSession('name', this.name.trim());
    writeSession('email', email);
    this.go(4);
  }

  /**
   * "Continue" on step 4 (Enter too while it is greyed out): a filled
   * confirmation that differs shows its message (with the shake); otherwise
   * the focus moves to the field that is missing something, no message.
   */
  submitPw(): void {
    if (this.pwReady) {
      this.go(5);
      return;
    }
    if (this.pwOk && this.pw2) {
      this.failWith({ pw2: m.setup_pw2_mismatch() }, ['pw2']);
      return;
    }
    this.hooks.focus?.(this.pwOk ? 'pw2' : 'pw');
  }

  /**
   * "Finish setup": `setup/complete` with the administrator and the choices
   * of step 1. `201` → the done screen, then the sign-in; no answer → "No
   * connection"; `setup_done` → reload (sign-in); a wrong or locked token →
   * the token step; any other answer → the server error in place of the note
   * (with the shake), until the next "Finish setup".
   */
  async finish(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.finishErr = false;
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
      // Token and password are no longer needed.
      this.pw = this.pw2 = this.token = '';
      this.tokOk = false;
      this.hooks.entered?.(this.step, 'heading');
      this.doneTimer = setTimeout(() => void this.hooks.signedIn?.(), DONE_MS);
    } catch (error) {
      this.loading = false;
      await this.rejected(error, () => {
        this.finishErr = true;
        this.hooks.fail?.();
      });
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
   * sign-in), no answer ("No connection"); everything else `other`, by
   * default as a toast.
   */
  private async rejected(error: unknown, other?: () => void): Promise<void> {
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
        this.tokOk = false;
        if (this.step !== 2) this.go(2, null);
        this.tokErr = 'invalid';
        this.hooks.fail?.('token');
        return;
      }
      if (error.status === 429) {
        if (this.step !== 2) this.go(2, null);
        this.token = '';
        this.tokOk = false;
        this.tokErr = 'locked';
        this.remaining = null;
        this.locks.start('token', retryAfter(error));
        this.hooks.fail?.();
        return;
      }
    }
    if (other) other();
    else this.hooks.error?.(failText(error));
  }
}
