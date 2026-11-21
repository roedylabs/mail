/**
 * State module `prefs`: settings of the app account with
 * the names and values the backend stores (`RESET0` holds the defaults).
 *
 * After sign-in `load()` loads `GET settings`. `set()` changes locally at once
 * and sends only the changed fields with the version via `PUT settings`; at
 * most one request runs, further changes collect until then. On
 * 409 `version_conflict` the own change is applied to the supplied state
 * and goes out again. Guests (without `load()`) change only in the browser.
 *
 * `lang` is also the UI language: Paraglide reads it here
 * (`overwriteGetLocale`); guests start with the device language
 * (`deviceLang()`), a new account takes it over on the first load.
 */
import { ACCENTS, type AccentName } from '@roedy/tokens';
import { MediaQuery } from 'svelte/reactivity';
import { ApiError, api, isRecord } from '#lib/api.ts';
import { isHexColor, type HexColor } from '#lib/color.ts';
import { browserLang, deviceLang, type Lang } from '#lib/locale.ts';
import { baseLocale, isLocale, overwriteGetLocale } from '#lib/paraglide/runtime.js';
import {
  DENSITIES,
  DIGEST_OPTS,
  EXT_MODES,
  FONT_SIZES,
  LOG_LEVELS,
  MODES,
  PF_DESIGNS,
  REGIONS,
  START_OPTS,
  TIME_FMTS,
  WEEK_STARTS,
} from '#lib/settings-choices.ts';

export type ModeName = (typeof MODES)[number];
/** Named accent or a custom colour as `#rrggbb` (`#lib/color.ts`). */
export type AccentChoice = AccentName | HexColor;
/** Language setting: a UI language or `system` (follows the browser, `browserLang()`). */
export type LangChoice = Lang | 'system';
export type Channels = { app: boolean; mail: boolean; push: boolean };

export { REGIONS };
export type Region = (typeof REGIONS)[number];

export interface Settings {
  mode: ModeName | null;
  accent: AccentChoice | null;
  greet: boolean | null;
  fontSize: (typeof FONT_SIZES)[number];
  density: (typeof DENSITIES)[number];
  animations: boolean;
  pfDesign: (typeof PF_DESIGNS)[number];
  lang: LangChoice;
  region: Region;
  tzAuto: boolean;
  tz: string;
  dateFmt: string;
  timeFmt: (typeof TIME_FMTS)[number];
  weekStart: (typeof WEEK_STARTS)[number];
  numFmt: string;
  gStart: (typeof START_OPTS)[number];
  gConfirm: boolean;
  gUndo: '3 s' | '5 s' | '10 s';
  gKeys: boolean;
  swL: string;
  swR: string;
  extMode: (typeof EXT_MODES)[number];
  extAllow: string[];
  defaultAccount: string | null;
  nCh: Channels;
  nMx: Record<string, Channels>;
  nQuiet: boolean;
  nFrom: string;
  nTo: string;
  nDigest: (typeof DIGEST_OPTS)[number];
  nSound: boolean;
  devDebug: boolean;
  devLevel: (typeof LOG_LEVELS)[number];
  /** Unused: the offline simulation lives only in memory (`network`); stored, it would lock the app out. */
  devOffline: boolean;
  bannerDismissedRev: number | null;
  advanced: boolean;
}

/** Defaults like the backend without a stored row. */
export const RESET0: Readonly<Settings> = Object.freeze({
  mode: null,
  accent: null,
  greet: null,
  fontSize: 'medium',
  density: 'normal',
  animations: true,
  pfDesign: 'soft',
  lang: 'en',
  region: 'GB',
  tzAuto: true,
  tz: 'Europe/Berlin',
  dateFmt: 'de',
  timeFmt: '24h',
  weekStart: 'monday',
  numFmt: '1,234.56',
  gStart: 'inbox',
  gConfirm: true,
  gUndo: '5 s',
  gKeys: true,
  swL: 'move',
  swR: 'del',
  extMode: 'ask',
  extAllow: [],
  defaultAccount: null,
  nCh: { app: true, mail: true, push: false },
  nMx: {
    security: { app: true, mail: true, push: true },
    account: { app: true, mail: true, push: false },
    team: { app: true, mail: false, push: false },
    system: { app: true, mail: false, push: false },
    news: { app: true, mail: false, push: false },
  },
  nQuiet: false,
  nFrom: '22:00',
  nTo: '07:00',
  nDigest: 'daily',
  nSound: true,
  devDebug: false,
  devLevel: 'info',
  devOffline: false,
  bannerDismissedRev: null,
  advanced: false,
});

/**
 * Allowed values of the fields with a fixed choice, from the lists in
 * `settings-choices.ts`. Any other value falls back to the default
 * when settings are taken over.
 */
const CHOICES: { readonly [K in keyof Settings]?: readonly Settings[K][] } = {
  mode: [...MODES, null],
  accent: [...(Object.keys(ACCENTS) as AccentName[]), null],
  fontSize: FONT_SIZES,
  density: DENSITIES,
  pfDesign: PF_DESIGNS,
  region: REGIONS,
  timeFmt: TIME_FMTS,
  weekStart: WEEK_STARTS,
  gStart: START_OPTS,
  extMode: EXT_MODES,
  nDigest: DIGEST_OPTS,
  devLevel: LOG_LEVELS,
};

/** Values beyond `CHOICES` that a field accepts as well. */
const ALSO: { readonly [K in keyof Settings]?: (value: unknown) => boolean } = {
  accent: isHexColor,
};

/** Drops fields with a fixed choice whose value is unknown (they keep the default). */
export function knownSettings(settings: Partial<Settings>): Partial<Settings> {
  const known: Record<string, unknown> = { ...settings };
  for (const [key, allowed] of Object.entries(CHOICES) as [keyof Settings, readonly unknown[]][]) {
    if (key in known && !allowed.includes(known[key]) && !ALSO[key]?.(known[key])) delete known[key];
  }
  return known;
}

/** Response of `GET`/`PUT settings` and body of 409 `version_conflict`. */
export interface StoredSettings {
  version: number;
  settings: Settings;
}

/** Time zone of the browser; `undefined` if it reports no usable one. */
export function browserTimeZone(): string | undefined {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && tz !== 'Etc/Unknown' ? tz : undefined;
}

/**
 * Time zone of the account for display: with `tzAuto` the device's
 * (`browserTimeZone()`; without a usable one the stored one), otherwise `tz`.
 */
export function displayZone(values: Pick<Settings, 'tzAuto' | 'tz'>, deviceTz: string | undefined): string {
  return values.tzAuto ? (deviceTz ?? values.tz) : values.tz;
}

/** Attempts per change on consecutive conflicts (afterwards it counts as failed). */
const MAX_CONFLICTS = 3;

/** Defaults with the device language (guests, before loading, after sign-out). */
function fresh(): Settings {
  return { ...structuredClone(RESET0), lang: deviceLang() };
}

export class Prefs {
  values = $state<Settings>(fresh());
  version = $state(0);
  /** Account settings loaded; before that (and for guests) only local. */
  remote = $state(false);
  /** Loading the account finished, also failed: from here on the values apply (e.g. the default account of the start page). */
  loaded = $state(false);
  /** Language of the browser for `system`; follows its changes (`languagechange`). */
  #browserLang = $state<Lang>(browserLang());

  /** Language of the browser (what `system` shows), e.g. for "Browser: English". */
  get browserLang(): Lang {
    return this.#browserLang;
  }

  /**
   * UI language: own `$derived` so that texts are only recreated on a
   * change, not on every new state of `values`; `system` is the browser's, an
   * unknown value (copy from another version) counts as the base language.
   */
  readonly lang: Lang = $derived(
    this.values.lang === 'system' ? this.#browserLang : isLocale(this.values.lang) ? this.values.lang : baseLocale,
  );
  /** Last error on save; the affected fields are then reset. */
  error = $state<ApiError | Error | null>(null);
  /** System setting "reduce motion" (`prefers-reduced-motion`). */
  #reduceMotion = new MediaQuery('(prefers-reduced-motion: reduce)');

  /** Motion on: setting "Animations" and no reduced motion in the system. */
  get motion(): boolean {
    return this.values.animations && !this.#reduceMotion.current;
  }

  constructor() {
    globalThis.addEventListener?.('languagechange', () => {
      this.#browserLang = browserLang();
    });
  }

  /** Last state confirmed by the server. */
  #confirmed: Settings = fresh();
  /** Changed, but not sent yet. */
  #pending: Partial<Settings> = {};
  /** Currently in flight. */
  #inflight: Partial<Settings> | null = null;
  #idle: Promise<void> = Promise.resolve();
  /** Counts `reset()`; responses from an earlier generation (e.g. before sign-out) expire. */
  #generation = 0;

  /** Loads the settings of the signed-in account and reports the time zone if needed. */
  async load(): Promise<void> {
    const generation = this.#generation;
    const guestLang = this.values.lang;
    let stored: StoredSettings;
    try {
      stored = await api<StoredSettings>('GET', 'settings');
    } finally {
      if (generation === this.#generation) this.loaded = true;
    }
    if (generation !== this.#generation) return;
    this.#pending = {};
    this.#accept(stored);
    this.remote = true;
    // Never saved (new account): it keeps the language it signed in with.
    if (stored.version === 0 && guestLang !== this.values.lang) this.set({ lang: guestLang });
    this.reportTimeZone();
  }

  /** Start from the copy (`#lib/start-copy.ts`): state without server; changes go nowhere offline as usual. */
  fromCopy(stored: StoredSettings): void {
    this.#pending = {};
    this.#accept(stored);
    this.remote = true;
    this.loaded = true;
  }

  /** Back to the defaults without server (e.g. after sign-out). */
  reset(): void {
    this.#generation++;
    this.#inflight = null;
    this.#idle = Promise.resolve();
    this.values = fresh();
    this.version = 0;
    this.remote = false;
    this.loaded = false;
    this.error = null;
    this.#confirmed = fresh();
    this.#pending = {};
  }

  /** Changes settings; for signed-in accounts also on the server. */
  set(patch: Partial<Settings>): void {
    Object.assign(this.values, patch);
    if (!this.remote) return;
    this.#pending = { ...this.#pending, ...patch };
    // A running request then takes along what was added in the meantime.
    if (!this.#inflight) this.#idle = this.#flush();
  }

  /** With `tzAuto` report the browser's time zone if it differs. */
  reportTimeZone(tz = browserTimeZone()): void {
    if (this.values.tzAuto && tz && tz !== this.values.tz) this.set({ tz });
  }

  /** Waits until all changes are sent (for tests and before sign-out). */
  async settled(): Promise<void> {
    let idle: Promise<void>;
    do {
      idle = this.#idle;
      await idle;
    } while (idle !== this.#idle);
  }

  async #flush(): Promise<void> {
    if (this.#inflight || Object.keys(this.#pending).length === 0) return;
    const generation = this.#generation;
    const patch = this.#pending;
    this.#inflight = patch;
    this.#pending = {};
    try {
      for (let attempt = 1; ; attempt++) {
        let stored: StoredSettings;
        try {
          stored = await api<StoredSettings>('PUT', 'settings', { version: this.version, settings: patch });
        } catch (error) {
          if (generation !== this.#generation) return;
          const conflict = conflictOf(error);
          if (!conflict) throw error;
          // Newer state (other tab or device): take it over and send the own change on top of it again.
          this.#accept(conflict);
          if (attempt >= MAX_CONFLICTS) throw error;
          continue;
        }
        if (generation !== this.#generation) return;
        this.#accept(stored);
        this.error = null;
        break;
      }
    } catch (error) {
      for (const key of Object.keys(patch) as (keyof Settings)[]) {
        if (!(key in this.#pending)) this.#assign(key, this.#confirmed[key]);
      }
      this.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (generation === this.#generation) this.#inflight = null;
    }
    if (generation === this.#generation && Object.keys(this.#pending).length > 0) await this.#flush();
  }

  /** Takes over a server state; own changes not yet confirmed stay visible. */
  #accept(stored: StoredSettings): void {
    this.#confirmed = { ...fresh(), ...knownSettings(stored.settings) };
    this.version = stored.version;
    this.values = { ...this.#confirmed, ...this.#inflight, ...this.#pending };
  }

  #assign<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.values[key] = value;
  }
}

function conflictOf(error: unknown): StoredSettings | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'version_conflict') return null;
  const { version, settings } = error.body;
  return typeof version === 'number' && isRecord(settings)
    ? { version, settings: settings as unknown as Settings }
    : null;
}

export const prefs = new Prefs();

/**
 * Language the texts render in for one pass of the setup's height fit (the language not chosen), otherwise `null`.
 * Only the texts follow it; `prefs.lang` and everything derived from it stay.
 */
export const fitLang = $state<{ value: Lang | null }>({ value: null });

// UI language from the settings; via `$state` templates and `$derived` follow a change.
overwriteGetLocale(() => fitLang.value ?? prefs.lang);
