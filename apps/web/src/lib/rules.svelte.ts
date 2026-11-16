/**
 * Mail account › Rules: the rule
 * model per account from the Sieve script `roedy-mail` (RFC 9661, only with
 * `urn:ietf:params:jmap:sieve`). Changes apply immediately and are saved in
 * order, always the newest state. Values of the page in
 * `#lib/rules-page.svelte.ts`.
 */
import {
  hasAccountCapability,
  MAIL,
  primaryAccount,
  SIEVE,
  SIEVE_TYPE,
  sieveCapability,
  type Id,
  type JmapClient,
  type SetError,
  type SieveScript,
} from '@roedy/jmap';
import { SvelteSet } from 'svelte/reactivity';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { LoadFailed, loadErrorText } from '#lib/mail-account.svelte.ts';
import { limitText } from '#lib/message-view.ts';
import { m } from '#lib/paraglide/messages.js';
import {
  EMPTY_RULES,
  readModel,
  redirectCount,
  SCRIPT_NAME,
  sizeTest,
  storedScript,
  VACATION_SCRIPT,
  type Forward,
  type Rule,
  type RuleSet,
  type SieveTargets,
} from '#lib/sieve/generate.ts';
import { sieveTargets } from '#lib/sieve/targets.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { onForget } from '#lib/state/forget.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { tags } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Active script of the account: our own, the vacation notice (Stalwart), a foreign one or none. */
export type ActiveScript = 'ours' | 'vacation' | 'foreign' | 'none';

/** Scripts of the account from the rules' point of view. */
export interface ScriptStatus {
  /** Id of our own script; `null` while there is none. */
  scriptId: Id | null;
  active: ActiveScript;
  /** Name of the active script if it is not our own. */
  activeName: string | null;
  /** `maxNumberRedirects` of the capability; `null` if not given. */
  maxRedirects: number | null;
  /** `maxSizeScript` of the capability in bytes, for the "too large" message; `null` if not given. */
  maxSize: number | null;
}

/** Server state for an account. */
export interface RulesLoaded extends ScriptStatus {
  model: RuleSet;
  /** Own script without a readable model: the list starts empty, saving overwrites. */
  damaged: boolean;
}

export interface RulesApi {
  /** Rules of the account; `null` if the server offers no Sieve for the account. */
  load(account: string): Promise<RulesLoaded | null>;
  /** Writes the model as a script; activates it unless the vacation notice is active. Rejected as `RulesRefused`. */
  save(account: string, model: RuleSet): Promise<ScriptStatus>;
  /**
   * Activates our own script if there is one and neither it nor the vacation
   * notice is active; a foreign active one only with `replaceForeign`.
   */
  activate(account: string, replaceForeign: boolean): Promise<ScriptStatus>;
}

/** The server rejected the script (`notCreated`/`notUpdated`, e.g. `invalidScript` or `tooLarge`). */
export class RulesRefused extends Error {
  readonly error: SetError;
  constructor(error: SetError) {
    super(`SieveScript/set: ${error.type}`);
    this.error = error;
  }
}

/** Status from the list of scripts (`SieveScript/get`). */
export function scriptStatus(
  list: readonly SieveScript[],
  maxRedirects: number | null,
  maxSize: number | null = null,
): ScriptStatus {
  const ours = list.find((s) => s.name === SCRIPT_NAME) ?? null;
  const act = list.find((s) => s.isActive) ?? null;
  const active: ActiveScript = !act
    ? 'none'
    : act.id === ours?.id
      ? 'ours'
      : act.name === VACATION_SCRIPT
        ? 'vacation'
        : 'foreign';
  return {
    scriptId: ours?.id ?? null,
    active,
    activeName: act && active !== 'ours' ? act.name : null,
    maxRedirects,
    maxSize,
  };
}

/** Targets from the state modules; loads mailboxes and tags if they are missing. */
async function currentTargets(account: string): Promise<SieveTargets> {
  await Promise.all([mailboxes.ensure(account), tags.ensure()]);
  return sieveTargets(account, mailboxes.list(account), tags.list ?? []);
}

/**
 * `RulesApi` via JMAP. Saving re-reads the scripts instead of trusting the
 * loaded state: the vacation notice may have become active in the meantime.
 */
export function jmapRulesApi(
  client: (account: string) => Promise<JmapClient>,
  targets: (account: string) => Promise<SieveTargets> = currentTargets,
): RulesApi {
  async function scripts(c: JmapClient, accountId: Id): Promise<SieveScript[]> {
    return (await c.call('SieveScript/get', { accountId })).list;
  }
  async function limits(c: JmapClient, accountId: Id): Promise<[number | null, number | null]> {
    const cap = sieveCapability(await c.session(), accountId);
    return [cap.maxNumberRedirects, cap.maxSizeScript];
  }
  return {
    async load(account) {
      const c = await client(account);
      const session = await c.session();
      const accountId = primaryAccount(session, MAIL);
      if (!hasAccountCapability(session, accountId, SIEVE)) return null;
      const list = await scripts(c, accountId);
      const cap = sieveCapability(session, accountId);
      const status = scriptStatus(list, cap.maxNumberRedirects, cap.maxSizeScript);
      const ours = list.find((s) => s.id === status.scriptId);
      if (!ours) return { ...status, model: EMPTY_RULES, damaged: false };
      const blob = await c.download({ accountId, blobId: ours.blobId, type: SIEVE_TYPE, name: `${SCRIPT_NAME}.sieve` });
      const model = readModel(await blob.text());
      return { ...status, model: model ?? EMPTY_RULES, damaged: model === null };
    },
    async save(account, model) {
      const c = await client(account);
      const accountId = await c.accountId();
      const text = storedScript(model, await targets(account));
      const [list, { blobId }] = await Promise.all([scripts(c, accountId), c.upload(accountId, text, SIEVE_TYPE)]);
      const { scriptId, active } = scriptStatus(list, null);
      const batch = c.batch();
      const set = batch.call('SieveScript/set', {
        accountId,
        ...(scriptId ? { update: { [scriptId]: { blobId } } } : { create: { r: { name: SCRIPT_NAME, blobId } } }),
        ...(active === 'vacation' ? {} : { onSuccessActivateScript: scriptId ?? '#r' }),
      });
      const get = batch.call('SieveScript/get', { accountId });
      const res = await batch.send();
      const r = res.get(set);
      const refused = scriptId ? r.notUpdated?.[scriptId] : r.notCreated?.r;
      if (refused) throw new RulesRefused(refused);
      return scriptStatus(res.get(get).list, ...(await limits(c, accountId)));
    },
    async activate(account, replaceForeign) {
      const c = await client(account);
      const session = await c.session();
      const accountId = primaryAccount(session, MAIL);
      const cap = sieveCapability(session, accountId);
      const max = [cap.maxNumberRedirects, cap.maxSizeScript] as const;
      if (!hasAccountCapability(session, accountId, SIEVE)) {
        return { scriptId: null, active: 'none', activeName: null, maxRedirects: max[0], maxSize: max[1] };
      }
      const status = scriptStatus(await scripts(c, accountId), ...max);
      const keep = status.active === 'ours' || status.active === 'vacation' || status.active === 'foreign';
      if (!status.scriptId || (keep && !(status.active === 'foreign' && replaceForeign))) return status;
      const batch = c.batch();
      batch.call('SieveScript/set', { accountId, onSuccessActivateScript: status.scriptId });
      const get = batch.call('SieveScript/get', { accountId });
      return scriptStatus((await batch.send()).get(get).list, ...max);
    },
  };
}

/**
 * Text of a failed save: rejected because the script is too large
 * (`maxSizeScript`), otherwise rejected as invalid, without a response the
 * generic error or offline text.
 */
export function saveErrorText(error: unknown, maxSize: number | null): string {
  if (!(error instanceof RulesRefused)) return failText(error);
  return error.error.type === 'tooLarge' && maxSize !== null
    ? m.rules_too_large({ size: limitText(maxSize) })
    : m.rules_invalid();
}

/** Error of a rule; the page chooses the text. */
export type RuleError = 'name' | 'value' | 'size' | 'address' | 'target';

export function ruleError(rule: Pick<Rule, 'name' | 'conds' | 'acts'>): RuleError | null {
  if (!rule.name.trim()) return 'name';
  if (rule.conds.some(([f, v]) => f !== 'att' && !v.trim())) return 'value';
  if (rule.conds.some(([f, v]) => f === 'size' && sizeTest(v) === 'false')) return 'size';
  if (rule.acts.some(([a, v]) => a === 'fwd' && !isEmail(v.trim()))) return 'address';
  if (rule.acts.some(([a, v]) => (a === 'move' || a === 'tag') && !v)) return 'target';
  return null;
}

/** Turning on forwarding requires a valid target address. */
export function forwardError(forward: Forward): 'address' | null {
  return forward.on && !isEmail(forward.to.trim()) ? 'address' : null;
}

/** State of an account: loaded, without Sieve on the server or first load failed. */
export type RulesState = RulesLoaded | 'unsupported' | LoadFailed;

function isLoaded(v: RulesState | undefined): v is RulesLoaded {
  return typeof v === 'object' && !(v instanceof LoadFailed);
}

export class Rules {
  /** Last known server state per account. */
  values = $state.raw<Record<string, RulesState>>({});
  /** Newest model per account while it is not saved yet. */
  pending = $state.raw<Record<string, RuleSet>>({});
  /** Accounts whose save is currently running. */
  saving = new SvelteSet<string>();
  #gen = 0;
  /** Counts completed writes; a load that started before no longer applies. */
  #writes = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- running fetches, not displayed
  #loads = new Map<string, { load: Promise<void>; writes: number }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- running save, not displayed
  #runs = new Map<string, Promise<boolean>>();
  readonly #api: RulesApi;

  constructor(api: RulesApi = jmapRulesApi((account) => accounts.client(account))) {
    this.#api = api;
  }

  /** Rules of an account; if the first load fails, the page shows the card, a later one as a toast. */
  load(account: string): Promise<void> {
    const running = this.#loads.get(account);
    // A load from before the last write no longer applies (see below), it needs a new one.
    if (running && running.writes === this.#writes) return running.load;
    const gen = this.#gen;
    const writes = this.#writes;
    if (this.values[account] instanceof LoadFailed) {
      const values = { ...this.values };
      delete values[account];
      this.values = values;
    }
    const load = this.#api
      .load(account)
      .then(
        (v) => {
          if (gen === this.#gen && writes === this.#writes) this.#put(account, v ?? 'unsupported');
        },
        (error: unknown) => {
          if (gen !== this.#gen) return;
          if (this.values[account] === undefined) this.#put(account, new LoadFailed(error));
          else ui.toasts.error(loadErrorText(error, accounts.get(account)?.host ?? ''));
        },
      )
      .finally(() => {
        if (gen === this.#gen && this.#loads.get(account)?.load === load) this.#loads.delete(account);
      });
    this.#loads.set(account, { load, writes });
    return load;
  }

  /** Loaded server state; `null` while nothing is loaded or without Sieve. */
  loaded(account: string): RulesLoaded | null {
    const v = this.values[account];
    return isLoaded(v) ? v : null;
  }

  /** Displayed model: the unsaved one, otherwise the server's. */
  model(account: string): RuleSet | null {
    return this.pending[account] ?? this.loaded(account)?.model ?? null;
  }

  /** Forwardings of the displayed model, for the `maxRedirects` limit. */
  redirects(account: string): number {
    const model = this.model(account);
    return model ? redirectCount(model) : 0;
  }

  /**
   * Changes the model and saves it. The new model applies immediately; if
   * saving fails, the server state applies again (toast). `true` if the
   * newest state is on the server.
   */
  update(account: string, change: (model: RuleSet) => RuleSet): Promise<boolean> {
    const base = this.model(account);
    if (!base) return Promise.resolve(false);
    const next = change(base);
    // Unchanged: nothing to save, a running save still applies.
    if (next === base) return this.#runs.get(account) ?? Promise.resolve(true);
    this.pending = { ...this.pending, [account]: next };
    return this.#flush(account);
  }

  /** Activate our own script ("Turn on"), also instead of a foreign one; not while the vacation notice runs. */
  async activate(account: string): Promise<boolean> {
    return this.#activate(account, false);
  }

  /**
   * After turning off the vacation notice: reactivate the rules only if none
   * is active; errors stay silent.
   */
  async resume(account: string): Promise<void> {
    await this.#activate(account, true);
  }

  /** After turning on the vacation notice: a loaded state is stale, it displaces the rules. */
  refresh(account: string): void {
    if (this.values[account] !== undefined) void this.load(account);
  }

  /** Sign-out: discard states, pending changes and running fetches. */
  reset(): void {
    this.#gen++;
    this.#loads.clear();
    this.#runs.clear();
    this.values = {};
    this.pending = {};
    this.saving.clear();
  }

  #put(account: string, state: RulesState): void {
    this.values = { ...this.values, [account]: state };
  }

  #drop(account: string): void {
    const pending = { ...this.pending };
    delete pending[account];
    this.pending = pending;
  }

  #flush(account: string): Promise<boolean> {
    const running = this.#runs.get(account);
    if (running) return running;
    const gen = this.#gen;
    this.saving.add(account);
    const run = (async () => {
      try {
        for (;;) {
          const want = this.pending[account];
          const before = this.loaded(account);
          if (!want || !before) return true;
          try {
            const status = await this.#api.save(account, want);
            if (gen !== this.#gen) return false;
            this.#writes++;
            this.#put(account, { ...status, model: want, damaged: false });
            if (this.pending[account] === want) this.#drop(account);
          } catch (error) {
            if (gen !== this.#gen) return false;
            this.#drop(account);
            ui.toasts.error(saveErrorText(error, before.maxSize));
            // The script may look different by now (deleted, changed in another program).
            void this.load(account);
            return false;
          }
        }
      } finally {
        if (gen === this.#gen) {
          this.saving.delete(account);
          this.#runs.delete(account);
        }
      }
    })();
    // If the run ends without waiting (nothing loaded), it is already over and must not get stuck.
    if (this.saving.has(account)) this.#runs.set(account, run);
    return run;
  }

  async #activate(account: string, quiet: boolean): Promise<boolean> {
    await this.#runs.get(account);
    const gen = this.#gen;
    try {
      const status = await this.#api.activate(account, !quiet);
      if (gen !== this.#gen) return false;
      const before = this.loaded(account);
      if (before) {
        this.#writes++;
        this.#put(account, { ...before, ...status });
      }
      return status.active === 'ours';
    } catch (error) {
      if (gen === this.#gen && !quiet) ui.toasts.error(failText(error));
      return false;
    }
  }
}

export const rules = new Rules();
// Sign-out: `forgetAccount()` does not know the module, it only loads with its pages.
onForget(() => rules.reset());

/**
 * Notice under vacation: account with Sieve and
 * forwarding turned on or an active rule.
 */
export function rulesActive(account: string): boolean {
  const model = rules.loaded(account) ? rules.model(account) : null;
  return !!model && (model.forward.on || model.rules.some((r) => r.on));
}
