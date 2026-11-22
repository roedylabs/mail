/**
 * Flow of the setup wizard against the setup API in seven steps: language
 * and appearance, setup token, administrator, password, authenticator app,
 * recovery codes and review, then `setup/complete`. The setup token goes along in the header
 * `X-Setup-Token`; every response can reject it (back to the token step)
 * or report that the setup is already complete (then the page reloads the
 * session and the layout redirects to the sign-in). A request without an
 * answer shows "No connection" (`offline`); everything entered stays.
 *
 * Session of this browser tab (`sessionStorage`, keys `roedy-setup-*`):
 * language, theme, accent, the recently used colours, name and email, and
 * the step to return to on a reload. The setup token, the passwords, the
 * authenticator app's key and the recovery codes live in memory only. A reload on
 * steps 3–7 returns to step 2 with the stored values prefilled; a tab
 * without setup data starts with language System, theme System, accent
 * Apricot.
 *
 * Mail servers and system emails are added afterwards under Administration;
 * the public address comes from `ROEDY_PUBLIC_URL`.
 */
import { ACCENTS, DEFAULT_ACCENT, type AccentName } from '@roedy/tokens';
import { ApiError, NetworkError, api, isApiError, retryAfter } from '#lib/api.ts';
import { PRESETS, customName } from '#lib/color-editor.svelte.ts';
import { isHexColor, parseHex, type HexColor } from '#lib/color.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { formatOtp } from '#lib/login.svelte.ts';
import { initials, limitName, nameError, normalizeName } from '#lib/name.ts';
import { meetsPolicy, tooLong } from '#lib/password.ts';
import { m } from '#lib/paraglide/messages.js';
import { isLocale } from '#lib/paraglide/runtime.js';
import { qrSymbol, type QrSymbol } from '#lib/qr.ts';
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
/** Length of the lock after too many wrong codes from the app, the lock bar is relative to (seconds). */
export const CODE_LOCK_S = 900;

/** Duration of the done screen until the sign-in (its bar fills in 2.6 s). */
export const DONE_MS = 2700;

/** Number of steps (step indicator "Step {n} of 7"). */
export const STEPS = 7;

/**
 * 1 language and appearance, 2 setup token, 3 administrator, 4 password,
 * 5 authenticator app, 6 recovery codes, 7 review.
 */
export type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** First step the wizard shows: language and appearance. */
export const FIRST_STEP: Step = 1;

export type Field = 'token' | 'name' | 'email' | 'pw' | 'pw2';
/**
 * Where focus goes when a step opens: a field, the code field of the
 * authenticator app (`otp`), its "Try again" (`retry`), the checkbox of the
 * recovery codes (`saved`, when it is not ticked), the selected language card
 * (`lang`, step 1) or the step heading.
 */
export type Focus = Field | 'otp' | 'retry' | 'saved' | 'lang' | 'heading';

// ---- Session of this browser tab ----

/** Keys in `sessionStorage` (with the prefix `roedy-setup-`); token and passwords are never stored. */
export type SessionKey = 'lang' | 'dark' | 'accent' | 'accentHex' | 'accRecent' | 'name' | 'email' | 'step';
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

/** Custom accent of the session, `null` without one (a named accent drops it). */
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
    writeSession('accentHex', custom ? patch.accent : null);
  }
}

// ---- Accent colours of the first step ----

/** Recently used colours kept in the session (most recent first). */
export const RECENT_MAX = 12;

/** Recently used colours of the session: valid hex codes only, normalised, without duplicates, at most `RECENT_MAX`. */
export function recentOf(): HexColor[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readSession('accRecent') ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const hexes = raw.map((x) => (typeof x === 'string' ? parseHex(x) : null)).filter((x) => x !== null);
  return hexes.filter((x, i) => hexes.indexOf(x) === i).slice(0, RECENT_MAX);
}

/** `recent` with `hex` in front: moved there if it was in the list already, the oldest dropped beyond `RECENT_MAX`. */
export function withRecent(recent: readonly HexColor[], hex: HexColor): HexColor[] {
  return [hex, ...recent.filter((x) => x !== hex)].slice(0, RECENT_MAX);
}

/** Stores a colour picked in "More colors" as the most recently used one; returns the new list. */
export function rememberColor(hex: HexColor): HexColor[] {
  const next = withRecent(recentOf(), hex);
  writeSession('accRecent', JSON.stringify(next));
  return next;
}

/** A tile of the accent grid: one of the five accents, a preset or an own hex code. */
export interface ColorTile {
  hex: HexColor;
  /** Set for the five accents (picked as the named accent). */
  accent?: AccentName;
}

const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

/** The named accent whose colour is `hex`, if any. */
export function accentOfHex(hex: HexColor): AccentName | undefined {
  return ACCENT_NAMES.find((a) => ACCENTS[a].base === hex);
}

/** The colour of a choice: a named accent's base, or the hex code itself. */
export function accentHex(accent: AccentChoice): HexColor {
  return isHexColor(accent) ? accent : ACCENTS[accent].base;
}

/**
 * All colours of the accent grid in one order: the recently used ones (most
 * recent first), then the five accents, then the presets, each once. A
 * `current` own colour that is in none of them (a session without its
 * recently used list) follows the recently used ones, ahead of the accents,
 * so it shows in the closed row while picks in "More colors" still lead.
 */
export function colorOrder(recent: readonly HexColor[], current?: AccentChoice): ColorTile[] {
  const tile = (hex: HexColor): ColorTile => {
    const accent = accentOfHex(hex);
    return accent ? { hex, accent } : { hex };
  };
  const base = [...ACCENT_NAMES.map((a) => ACCENTS[a].base), ...PRESETS.map(([, hex]) => hex)];
  const own = current !== undefined && isHexColor(current) && ![...recent, ...base].includes(current) ? [current] : [];
  const all = [...recent, ...own, ...base];
  return all.filter((x, i) => all.indexOf(x) === i).map(tile);
}

/**
 * Tiles of the closed grid with `cols` columns: one row (two or more only
 * where fewer than five columns fit, so the five accents still show), never
 * more than there are colours.
 */
export function closedCount(cols: number, total = Number.POSITIVE_INFINITY): number {
  const c = Math.max(1, Math.floor(cols));
  return Math.min(total, Math.ceil(ACCENT_NAMES.length / c) * c);
}

/**
 * The closed grid: the first `closedCount(cols)` tiles of `order`. If the
 * selected colour (`sel`) is further back (a preset picked in the row before
 * the grid lost a column), it takes the row's last place, so the current
 * accent always shows and the count stays the same.
 */
export function closedTiles(order: readonly ColorTile[], cols: number, sel: HexColor): ColorTile[] {
  const row = order.slice(0, closedCount(cols, order.length));
  const picked = order.find((t) => t.hex === sel);
  if (!picked || row.includes(picked)) return row;
  return [...row.slice(0, -1), picked];
}

/**
 * The open grid ("More colors"): the closed row as it is (its tiles stay
 * put), then the rest of `order`.
 */
export function openTiles(closed: readonly ColorTile[], order: readonly ColorTile[]): ColorTile[] {
  const shown = closed.map((t) => t.hex);
  return [...closed, ...order.filter((t) => !shown.includes(t.hex))];
}

/** Columns of a grid from its computed `grid-template-columns` (resolved tracks in px); 0 while not laid out. */
export function trackCount(template: string): number {
  const tracks = template.trim().split(/\s+/).filter(Boolean);
  return tracks.length && tracks.every((t) => /^[\d.]+px$/.test(t)) ? tracks.length : 0;
}

/**
 * Step after a reload: step 1 stays, steps 2–7 return to step 2 (token and
 * password must be entered again, step 5 asks for a new key).
 */
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

/** A row of the summary on step 7: the step it changes, its tile (initials or icon), label, value and an optional second line. */
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
  /** Input rejected: shake the card, focus the field (step 5: its code field; step 6: the checkbox). */
  fail?: (field?: Field | 'otp' | 'saved') => void;
  /** Incomplete step: focus the field, no message. */
  focus?: (field: Field) => void;
  /** Step changed: focus the field or heading (`null`: the focus follows from `fail`). */
  entered?: (step: Step, focus: Focus | null) => void;
  /**
   * The same step changed its state (step 5: the key arrived or failed, the lock ended): focus as on entering it, but
   * only while no control has the focus (not after a Tab to Back meanwhile).
   */
  refocus?: (focus: Focus) => void;
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
const FIRST: Partial<Record<Step, Focus>> = { 1: 'lang', 2: 'token', 3: 'name', 4: 'pw', 5: 'otp' };

/** Key of the authenticator app from `setup/totp`, for the email it was requested for. */
export interface TotpKey {
  email: string;
  /** Base32, for manual entry. */
  secret: string;
  /** `otpauth://` URI for the QR code. */
  uri: string;
}

/** The key on step 5: there, being requested (placeholders), or not created (a server error, "Try again"). */
export type KeyStatus = 'ready' | 'loading' | 'failed';

/** Errors of the code field: fewer than six digits, a wrong or used code, or the check failed on the server. */
export type OtpError = 'short' | 'invalid' | 'server';

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

  /** Step 7: `setup/complete` failed on the server; shown in place of the note until the next "Finish setup". */
  finishErr = $state(false);

  // Step 5 (key, code and recovery codes live in memory only)
  /** The last key from `setup/totp`; it belongs to `key.email`. */
  key = $state<TotpKey | null>(null);
  /**
   * `setup/totp`: running (`loading`, for `keyEmail`), failed with an answer (`failed`) or without one (`offline`:
   * asks again once the server answers); `idle` otherwise.
   */
  keyState = $state<'idle' | 'loading' | 'failed' | 'offline'>('idle');
  /** Email of the running or last `setup/totp`. */
  private keyEmail = '';
  /** Code from the app, digits only. */
  otp = $state('');
  otpErr = $state<OtpError | null>(null);
  /** The ten recovery codes of the confirmed key (step 6). */
  codes = $state<string[]>([]);

  // Step 6 (memory only, like the codes)
  /** "I’ve saved the codes in a safe place" is ticked; it belongs to `codes` and goes with them. */
  saved = $state(false);
  /** Continue with the box unticked: the error under it until it is ticked. */
  savedErr = $state(false);

  // Steps 3 and 4
  name = $state('');
  email = $state('');
  pw = $state('');
  pw2 = $state('');

  /** Locks of the setup token and of the codes from the app, with countdown (the clock only runs while one applies). */
  readonly locks = new Countdown<'token' | 'code'>((kind) => this.freed(kind));
  private doneTimer: ReturnType<typeof setTimeout> | undefined;
  /** Requests of `setup/totp`: only the answer of the last one counts. */
  private keyReq = 0;
  /** The running `setup/totp`, settled either way: the next request waits for it. */
  private keyChain: Promise<unknown> = Promise.resolve();

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

  /** The key for the current email, if there is one. */
  keyNow = $derived(this.key && this.key.email === this.email.trim() ? this.key : null);
  keyStatus = $derived<KeyStatus>(this.keyNow ? 'ready' : this.keyState === 'failed' ? 'failed' : 'loading');
  qr = $derived<QrSymbol | null>(this.keyNow ? qrSymbol(this.keyNow.uri) : null);
  /** The key in groups of four. */
  secretLabel = $derived((this.keyNow?.secret.match(/.{1,4}/g) ?? []).join(' '));
  codeLocked = $derived(this.locks.active('code'));
  codeLeft = $derived(this.locks.left('code'));
  /** Code field disabled and Confirm greyed out: locked after too many wrong codes, or no key yet. */
  otpOff = $derived(this.codeLocked || this.keyStatus !== 'ready');

  /**
   * Summary of step 7, one row per step with input: language and appearance,
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
    this.savedErr = false;
    writeSession('step', String(step));
    // Step 5 without its key yet or still locked: the heading until the code field is enabled.
    if (step === 5 && !this.enterMfa() && focus === 'otp') focus = 'heading';
    if (step === 5 && focus === 'otp' && this.otpOff) focus = 'heading';
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

  // ---- Step 5: authenticator app ----

  /**
   * Entering step 5: an empty code field and the key for the current email. A key for another email (changed on step
   * 3 meanwhile) is dropped with its recovery codes and the ticked box of step 6; a new one is requested unless it is
   * already on its way. `true` if the key is there.
   */
  private enterMfa(): boolean {
    this.otp = '';
    this.otpErr = null;
    if (this.keyNow) return true;
    const email = this.email.trim();
    if (this.key) this.dropKey();
    if (this.keyState !== 'loading' || this.keyEmail !== email) void this.requestKey();
    return false;
  }

  /**
   * `setup/totp` for the current email. The key arrives: focus as on entering the step. A server error: "Key not
   * created" with "Try again"; no answer: "No connection", then the step asks again by itself (`online`). Answers
   * after leaving the step are kept (a key) or dropped (an error: entering again asks again).
   *
   * One request at a time: each one replaces the key the server keeps, and two at once could be stored in either
   * order. A request waits for the one before it and is not sent at all once a newer one is waiting; only the answer
   * of the last request counts.
   */
  private async requestKey(): Promise<void> {
    const email = this.email.trim();
    const req = ++this.keyReq;
    this.keyState = 'loading';
    this.keyEmail = email;
    const sent = this.keyChain.then(() =>
      req === this.keyReq
        ? api<{ secret: string; uri: string }>('POST', 'setup/totp', { email }, this.withToken())
        : null,
    );
    this.keyChain = sent.catch(() => undefined);
    try {
      const res = await sent;
      if (req !== this.keyReq || !res) return;
      this.key = { email, secret: res.secret, uri: res.uri };
      this.keyState = 'idle';
      if (this.step === 5) this.hooks.refocus?.(this.otpOff ? 'heading' : 'otp');
    } catch (error) {
      if (req !== this.keyReq) return;
      this.keyState = error instanceof NetworkError ? 'offline' : 'failed';
      if (this.step !== 5) return;
      await this.rejected(error, () => this.hooks.refocus?.('retry'));
    }
  }

  /** "Try again" after the key was not created. */
  retryKey(): void {
    if (this.step === 5 && this.keyStatus === 'failed') void this.requestKey();
  }

  /** The server answers again ("No connection" closed): step 5 asks again for a key that got no answer. */
  online(): void {
    if (this.step === 5 && this.keyState === 'offline' && !this.keyNow) void this.requestKey();
  }

  /**
   * Code input: digits only, at most six (pasted "123 456" works); not while it is being checked. Any edit clears
   * the wrong-code, short-code and server errors; the sixth digit confirms by itself.
   */
  editOtp(value: string): void {
    if (this.loading || this.otpOff) return;
    const otp = formatOtp(value);
    if (otp === this.otp) return;
    this.otp = otp;
    this.otpErr = null;
    if (otp.length === 6) void this.submitOtp();
  }

  /**
   * "Confirm" (or the sixth digit): under six digits "Please enter all 6 digits." with the shake. Otherwise
   * `setup/totp/verify`: `200` keeps the recovery codes and goes on; a wrong or used code clears the field and shows
   * "Invalid code."; `429` locks the field for `retry_after`; no key on the server any more asks for a new one; any
   * other answer keeps the code and shows the server error (not counted towards the lock).
   */
  async submitOtp(): Promise<void> {
    if (this.step !== 5 || this.loading || this.otpOff) return;
    if (this.otp.length < 6) {
      this.otpErr = 'short';
      this.hooks.fail?.('otp');
      return;
    }
    this.loading = true;
    this.otpErr = null;
    const key = this.keyReq;
    try {
      const res = await api<{ recovery_codes: string[] }>(
        'POST',
        'setup/totp/verify',
        { code: this.otp },
        this.withToken(),
      );
      // Left the step meanwhile (its own request reset `loading`), or the code belonged to an older key.
      if (this.step !== 5) return;
      this.loading = false;
      if (key !== this.keyReq) return;
      // The same key brings the same codes again (the box stays as it was); other codes are a box to tick anew.
      if (res.recovery_codes.join('\n') !== this.codes.join('\n')) this.saved = false;
      this.codes = res.recovery_codes;
      this.go(6);
    } catch (error) {
      if (this.step !== 5) return;
      this.loading = false;
      if (key !== this.keyReq) return;
      if (isApiError(error, 422, 'invalid_code') || isApiError(error, 422, 'code_used')) {
        this.otp = '';
        this.otpErr = 'invalid';
        this.hooks.fail?.('otp');
      } else if (isApiError(error, 429)) {
        // The code lock. The token lockout answers with the same body; if that was the cause, the next check after
        // the countdown passes the token check again, and an `invalid_token` then goes through `rejected` as on
        // every step.
        this.otp = '';
        this.locks.start('code', retryAfter(error, CODE_LOCK_S));
        this.hooks.fail?.();
      } else if (isApiError(error, 422, 'totp_required')) {
        // The server has no key any more: a new one to scan.
        this.dropKey();
        this.otp = '';
        void this.requestKey();
      } else {
        await this.rejected(error, () => {
          this.otpErr = 'server';
          this.hooks.fail?.('otp');
        });
      }
    }
  }

  // ---- Step 6: recovery codes ----

  /** The checkbox "I’ve saved the codes in a safe place"; either way it clears the error. */
  toggleSaved(): void {
    if (this.step !== 6) return;
    this.saved = !this.saved;
    this.savedErr = false;
  }

  /**
   * "Continue" on step 6 (Enter too; never greyed out): sends nothing, the codes came with the confirmed code on step
   * 5 and become valid with "Finish setup". Unticked → the error under the checkbox, the shake and the focus on it;
   * ticked → the review.
   */
  submitCodes(): void {
    if (this.step !== 6) return;
    if (!this.saved) {
      this.savedErr = true;
      this.hooks.fail?.('saved');
      return;
    }
    this.go(7);
  }

  /**
   * "Finish setup": `setup/complete` with the administrator and the choices
   * of step 1. `201` → the done screen, then the sign-in; no answer → "No
   * connection"; `setup_done` → reload (sign-in); a wrong or locked token →
   * the token step; no confirmed key for the email (`totp_required`) → step 5
   * with a new key; any other answer → the server error in place of the note
   * (with the shake), until the next "Finish setup".
   *
   * Never without step 6: without recovery codes nothing is sent and step 5
   * opens, without the ticked box step 6 with its error.
   */
  async finish(): Promise<void> {
    if (this.loading) return;
    if (!this.codes.length) {
      this.go(5);
      return;
    }
    if (!this.saved) {
      this.go(6, null);
      this.submitCodes();
      return;
    }
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
      // Token, password, key and recovery codes are no longer needed.
      this.pw = this.pw2 = this.token = this.otp = '';
      this.tokOk = false;
      this.dropKey();
      this.hooks.entered?.(this.step, 'heading');
      this.doneTimer = setTimeout(() => void this.hooks.signedIn?.(), DONE_MS);
    } catch (error) {
      this.loading = false;
      if (isApiError(error, 422, 'totp_required')) {
        // The key the code confirmed is gone (another tab asked for a new one): back to step 5 with a new key.
        this.dropKey();
        this.go(5);
        return;
      }
      await this.rejected(error, () => {
        this.finishErr = true;
        this.hooks.fail?.();
      });
    }
  }

  /** Stops clocks and timers and drops the answers of running key requests (when leaving the page). */
  dispose(): void {
    this.keyReq++;
    this.locks.stop();
    clearTimeout(this.doneTimer);
  }

  // ---- internal ----

  /** Drops the key with its recovery codes and the ticked box (a new key brings new codes to save). */
  private dropKey(): void {
    this.key = null;
    this.codes = [];
    this.saved = false;
    this.savedErr = false;
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

  /** A lock has expired: release the field (focus as on entering its step). */
  private freed(kind: 'token' | 'code'): void {
    if (kind === 'code') {
      if (this.step === 5 && !this.otpOff) this.hooks.refocus?.('otp');
      return;
    }
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
