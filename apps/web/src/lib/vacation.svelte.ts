/**
 * Mail account › Vacation reply: `VacationResponse/get|set` (RFC 8621, 8) with
 * a draft and the bar "Unsaved changes". "From" and "Until" are calendar days
 * in the account's time zone (`tz`), "Until" inclusive: `toDate` is the start
 * of the following day. A failed first load and a server without vacation
 * replies are shown as a card instead of the fields.
 */
import {
  hasAccountCapability,
  MAIL,
  primaryAccount,
  VACATION,
  type JmapClient,
  type PatchObject,
  type SetError,
  type UTCDate,
  type VacationResponse,
} from '@roedy/jmap';
import { SvelteSet } from 'svelte/reactivity';
import { failText, timeZoneOf } from '#lib/errors.ts';
import { LoadFailed, loadErrorText, loadFailureOf, type LoadInput, type LoadValues } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { holdUntil } from '#lib/plan.ts';
import { rules, rulesActive } from '#lib/rules.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { onForget } from '#lib/state/forget.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { toLocalInput, zoneTime } from '#lib/timezone.ts';
import { intlLocale } from '#lib/locale.ts';

const SINGLETON = 'singleton';

export interface VacationApi {
  /** Vacation notice; `null` if the server does not offer it for the account. */
  get(account: string): Promise<VacationResponse | null>;
  /** Changes the vacation notice and returns it afterwards; rejected as `VacationRefused`. */
  set(account: string, patch: PatchObject): Promise<VacationResponse>;
}

/** The server rejected the change (`notUpdated`). */
export class VacationRefused extends Error {
  readonly error: SetError;
  constructor(error: SetError) {
    super(`VacationResponse/set: ${error.type}`);
    this.error = error;
  }
}

function only(list: VacationResponse[]): VacationResponse {
  const v = list.find((x) => x.id === SINGLETON);
  if (!v) throw new Error('VacationResponse/get: no singleton');
  return v;
}

/**
 * `VacationApi` via JMAP: `VacationResponse/set` and `VacationResponse/get` in
 * one request. Without `urn:ietf:params:jmap:vacationresponse` in the session
 * and on the account (RFC 8621, 1.3.3) no `VacationResponse/get` is sent.
 */
export function jmapVacationApi(client: (account: string) => Promise<JmapClient>): VacationApi {
  return {
    async get(account) {
      const c = await client(account);
      const session = await c.session();
      const accountId = primaryAccount(session, MAIL);
      if (!hasAccountCapability(session, accountId, VACATION)) return null;
      return only((await c.call('VacationResponse/get', { accountId, ids: [SINGLETON] })).list);
    },
    async set(account, patch) {
      const c = await client(account);
      const accountId = await c.accountId();
      const batch = c.batch();
      const set = batch.call('VacationResponse/set', { accountId, update: { [SINGLETON]: patch } });
      const get = batch.call('VacationResponse/get', { accountId, ids: [SINGLETON] });
      const res = await batch.send();
      const refused = res.get(set).notUpdated?.[SINGLETON];
      if (refused) throw new VacationRefused(refused);
      return only(res.get(get).list);
    },
  };
}

/** Fields of the page; days as the value of `<input type="date">` ("2026-11-10"), empty if none. */
export interface VacationFields {
  on: boolean;
  from: string;
  to: string;
  subject: string;
  text: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar day of `t` in `tz`. */
export function dayOf(t: number, tz: string): string {
  return toLocalInput(t, tz).slice(0, 10);
}

/** Start of the day `day` in `tz`, with `next` that of the following day; `NaN` without a valid day. */
export function dayStart(day: string, tz: string, next = false): number {
  const v = DAY.exec(day);
  return v ? zoneTime(Number(v[1]), Number(v[2]), Number(v[3]) + (next ? 1 : 0), 0, 0, tz) : NaN;
}

/** `UTCDate` without fractional seconds (RFC 8620, 1.4), the same format as `HOLDUNTIL`. */
export const utcDate: (t: number) => UTCDate = holdUntil;

/** Fields from the server's vacation notice; without a subject the default subject. */
export function vacationFields(v: VacationResponse, tz: string): VacationFields {
  return {
    on: v.isEnabled,
    from: v.fromDate ? dayOf(Date.parse(v.fromDate), tz) : '',
    // "Until" is inclusive: the day before the end; an end at midnight belongs to the previous day.
    to: v.toDate ? dayOf(Date.parse(v.toDate) - 1, tz) : '',
    subject: v.subject ?? m.mail_vacation_subject_default(),
    text: v.textBody ?? '',
  };
}

/**
 * Changes for `VacationResponse/set`, only what changed compared to `base`; it
 * also sends the subject as long as the server has none (otherwise it would
 * pick a different one than the one shown). A changed text clears the HTML
 * version so that the server generates it from the text.
 */
export function vacationPatch(
  before: VacationResponse,
  base: VacationFields,
  f: VacationFields,
  tz: string,
): PatchObject {
  const patch: PatchObject = {};
  if (f.on !== base.on) patch.isEnabled = f.on;
  if (f.from !== base.from) patch.fromDate = f.from ? utcDate(dayStart(f.from, tz)) : null;
  if (f.to !== base.to) patch.toDate = f.to ? utcDate(dayStart(f.to, tz, true)) : null;
  if (f.subject !== base.subject || before.subject === null) patch.subject = f.subject.trim() || null;
  if (f.text !== base.text) {
    patch.textBody = f.text || null;
    if (before.htmlBody !== null) patch.htmlBody = null;
  }
  return patch;
}

const LONG: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };

/** Day in words, e.g. "10 November 2026". */
function longDay(day: string): string {
  const v = DAY.exec(day);
  return v
    ? new Date(Date.UTC(Number(v[1]), Number(v[2]) - 1, Number(v[3]))).toLocaleDateString(intlLocale(), LONG)
    : day;
}

/** Line below "Reply automatically". */
export function vacationSummary(f: Pick<VacationFields, 'on' | 'from' | 'to'>): string {
  if (!f.on) return m.mail_vacation_off();
  if (f.from && f.to) return m.mail_vacation_range({ from: longDay(f.from), to: longDay(f.to) });
  if (f.to) return m.mail_vacation_until({ to: longDay(f.to) });
  if (f.from) return m.mail_vacation_from({ from: longDay(f.from) });
  return m.mail_vacation_open();
}

/**
 * Draft of an account: only the changed fields; the others follow
 * the last loaded vacation notice – so a reload does not reset newer values.
 */
export interface VacationDraft {
  account: string;
  changes: Partial<VacationFields>;
}

/** Shown fields of an account and whether they differ from the server state. */
export interface VacationView {
  fields: VacationFields;
  dirty: boolean;
}

const KEYS = ['on', 'from', 'to', 'subject', 'text'] as const;

const tzNow = () => timeZoneOf(prefs.values);

/** State of an account: loaded, without vacation notice on the server or first load failed. */
export type VacationState = VacationResponse | 'unsupported' | LoadFailed;

function isLoaded(v: VacationState | undefined): v is VacationResponse {
  return typeof v === 'object' && !(v instanceof LoadFailed);
}

export class Vacations {
  /** Last loaded state per account (`VacationState`). */
  values = $state.raw<Record<string, VacationState>>({});
  draft = $state.raw<VacationDraft | null>(null);
  /** Accounts whose `VacationResponse/set` is currently running. */
  saving = new SvelteSet<string>();
  #gen = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- running fetches, not displayed
  #loads = new Map<string, Promise<void>>();
  readonly #api: VacationApi;
  readonly #tz: () => string;

  constructor(api: VacationApi = jmapVacationApi((account) => accounts.client(account)), tz: () => string = tzNow) {
    this.#api = api;
    this.#tz = tz;
  }

  /**
   * Vacation notice of an account; until then the last loaded one. If the first
   * load fails, the page shows the card, a later one as a toast.
   */
  load(account: string): Promise<void> {
    let load = this.#loads.get(account);
    if (load) return load;
    const gen = this.#gen;
    // After a failed load ("Try again") the skeleton again.
    if (this.values[account] instanceof LoadFailed) {
      const values = { ...this.values };
      delete values[account];
      this.values = values;
    }
    load = this.#api
      .get(account)
      .then(
        (v) => {
          if (gen === this.#gen) this.values = { ...this.values, [account]: v ?? 'unsupported' };
        },
        (error: unknown) => {
          if (gen !== this.#gen) return;
          if (this.values[account] === undefined) this.values = { ...this.values, [account]: new LoadFailed(error) };
          else ui.toasts.error(loadErrorText(error, accounts.get(account)?.host ?? ''));
        },
      )
      .finally(() => {
        if (gen === this.#gen) this.#loads.delete(account);
      });
    this.#loads.set(account, load);
    return load;
  }

  /** Server fields with the changes of the draft; `null` as long as nothing is loaded. */
  view(account: string): VacationView | null {
    const v = this.values[account];
    if (!isLoaded(v)) return null;
    const base = vacationFields(v, this.#tz());
    const changes = this.draft?.account === account ? this.draft.changes : {};
    const fields = { ...base, ...changes };
    return { fields, dirty: KEYS.some((k) => fields[k] !== base[k]) };
  }

  /** Change a field; the first edit creates the draft. No effect while saving. */
  set(account: string, patch: Partial<VacationFields>): void {
    if (this.saving.has(account)) return;
    const changes = this.draft?.account === account ? this.draft.changes : {};
    this.draft = { account, changes: { ...changes, ...patch } };
  }

  discard(): void {
    this.draft = null;
  }

  /** Save: check period and message, then `VacationResponse/set`. */
  async save(): Promise<void> {
    const d = this.draft;
    if (!d || this.saving.has(d.account)) return;
    const before = this.values[d.account];
    if (!isLoaded(before)) return;
    const tz = this.#tz();
    const base = vacationFields(before, tz);
    const f = { ...base, ...d.changes };
    if (f.from && f.to && f.to < f.from) {
      ui.toasts.show(m.mail_vacation_range_invalid());
      return;
    }
    // A message only as HTML (another program) counts as long as the text stays unchanged.
    const html = !!before.htmlBody?.trim() && f.text === base.text;
    if (f.on && !f.text.trim() && !html) {
      ui.toasts.show(m.mail_vacation_text_missing());
      return;
    }
    const gen = this.#gen;
    this.saving.add(d.account);
    try {
      // Throws for a day that `dayStart` cannot read (`RangeError`).
      const next = await this.#api.set(d.account, vacationPatch(before, base, f, tz));
      if (gen !== this.#gen) return;
      this.values = { ...this.values, [d.account]: next };
      if (this.draft === d) this.draft = null;
      ui.toasts.show(f.on ? m.mail_vacation_enabled() : m.mail_vacation_saved());
      // In Stalwart the vacation notice is a Sieve script and displaces the rules.
      if (before.isEnabled && !next.isEnabled) void rules.resume(d.account);
      if (!before.isEnabled && next.isEnabled) rules.refresh(d.account);
    } catch (error) {
      if (gen !== this.#gen) return;
      ui.toasts.error(failText(error));
    } finally {
      if (gen === this.#gen) this.saving.delete(d.account);
    }
  }

  /** Sign-out: discard vacation notices, draft and running fetches. */
  reset(): void {
    this.#gen++;
    this.#loads.clear();
    this.values = {};
    this.draft = null;
    this.saving.clear();
  }
}

export const vacations = new Vacations();
// Sign-out: `forgetAccount()` does not know the module, it only loads with its pages.
onForget(() => vacations.reset());

/** Values of the page; colours, opacity and toggle follow `on`. */
export interface VacationValues extends VacationFields {
  /** First load failed: card instead of the content; otherwise `null`. */
  load: LoadValues | null;
  /** Server without vacation notice: card with `naText` instead of toggle, fields, notice and bar. */
  na: boolean;
  naText: string;
  dirty: boolean;
  /**
   * Saving running: spinner and "Saving …", fields read-only, toggle and
   * "Discard" without effect.
   */
  saving: boolean;
  summary: string;
  /**
   * Notice that rules are paused, below the toggle: account with Sieve and
   * enabled forwarding or an active rule, regardless of the toggle; "Go to
   * rules" (`goRules`).
   */
  rlHint: boolean;
  rlHintText: string;
  rlHintGo: string;
  goRules: () => void;
  onToggle: () => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onSubject: (value: string) => void;
  onText: (value: string) => void;
  discard: () => void;
  save: () => void;
}

const NO_FIELDS: VacationFields = { on: false, from: '', to: '', subject: '', text: '' };

/** Targets of the buttons on the page. */
export interface VacationInput extends LoadInput {
  /** Mail account › rules of the account ("Go to rules"). */
  rules: (id: string) => void;
}

/** Values of the page; `null` as long as nothing is loaded (skeleton). */
export function vacationValues(a: MailAccount, input: VacationInput): VacationValues | null {
  const account = a.id;
  const state = vacations.values[account];
  if (state === undefined) return null;
  const view = vacations.view(account);
  const f = view?.fields ?? NO_FIELDS;
  return {
    ...f,
    load:
      state instanceof LoadFailed
        ? {
            ...loadFailureOf(state.error, a.host),
            onRetry: () => void vacations.load(account),
            goCon: () => input.connection(account),
          }
        : null,
    na: state === 'unsupported',
    naText: m.mail_vacation_na_text({ host: a.host }),
    dirty: view?.dirty ?? false,
    saving: vacations.saving.has(account),
    summary: vacationSummary(f),
    rlHint: !(state instanceof LoadFailed) && state !== 'unsupported' && rulesActive(account),
    rlHintText: m.rules_vacation_hint(),
    rlHintGo: m.rules_vacation_hint_go(),
    goRules: () => input.rules(account),
    onToggle: () => vacations.set(account, { on: !f.on }),
    onFrom: (v) => vacations.set(account, { from: v }),
    onTo: (v) => vacations.set(account, { to: v }),
    onSubject: (v) => vacations.set(account, { subject: v }),
    onText: (v) => vacations.set(account, { text: v }),
    // No effect while saving; leaving the page discards anyway.
    discard: () => {
      if (!vacations.saving.has(account)) vacations.discard();
    },
    save: () => void vacations.save(),
  };
}
