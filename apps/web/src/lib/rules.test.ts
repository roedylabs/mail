import { MAIL, SIEVE, type JmapClient, type Session, type SieveScript } from '@roedy/jmap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import { LoadFailed } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { EMPTY_RULES, storedScript, type Rule, type RuleSet, type SieveTargets } from '#lib/sieve/generate.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  forwardError,
  jmapRulesApi,
  ruleError,
  rules,
  Rules,
  rulesActive,
  RulesRefused,
  saveErrorText,
  scriptStatus,
  type RulesApi,
  type RulesLoaded,
  type ScriptStatus,
} from './rules.svelte.ts';

const FAIL = 'That didn’t work. Please try again.';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Boss',
    on: true,
    match: 'all',
    conds: [['from', 'boss@company.example']],
    acts: [['read', '']],
    ...overrides,
  };
}

/** Model with rules of the given names. */
function model(...names: string[]): RuleSet {
  return { forward: EMPTY_RULES.forward, rules: names.map((name, i) => rule({ id: `r${i}`, name })) };
}

const STATUS: ScriptStatus = { scriptId: 's1', active: 'ours', activeName: null, maxRedirects: 1, maxSize: null };

function loaded(m: RuleSet = EMPTY_RULES, overrides: Partial<RulesLoaded> = {}): RulesLoaded {
  return { ...STATUS, model: m, damaged: false, ...overrides };
}

function fakeApi(initial: RulesLoaded | null = loaded()) {
  return {
    load: vi.fn<RulesApi['load']>(() => Promise.resolve(initial)),
    save: vi.fn<RulesApi['save']>(() => Promise.resolve(STATUS)),
    activate: vi.fn<RulesApi['activate']>(() => Promise.resolve(STATUS)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets running promise chains continue. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  rules.reset();
  ui.reset();
});

describe('scriptStatus', () => {
  const s = (id: string, name: string | null, isActive = false): SieveScript => ({
    id,
    name,
    blobId: `b-${id}`,
    isActive,
  });

  it('distinguishes own, vacation notice, foreign and no active script', () => {
    expect(scriptStatus([], 1)).toEqual({
      scriptId: null,
      active: 'none',
      activeName: null,
      maxRedirects: 1,
      maxSize: null,
    });
    expect(scriptStatus([s('s1', 'roedy-mail')], null)).toEqual({
      scriptId: 's1',
      active: 'none',
      activeName: null,
      maxRedirects: null,
      maxSize: null,
    });
    expect(scriptStatus([s('f', 'Filter'), s('s1', 'roedy-mail', true)], 1)).toMatchObject({
      scriptId: 's1',
      active: 'ours',
      activeName: null,
    });
    expect(scriptStatus([s('s1', 'roedy-mail'), s('v', 'vacation', true)], 1)).toMatchObject({
      scriptId: 's1',
      active: 'vacation',
      activeName: 'vacation',
    });
    expect(scriptStatus([s('s1', 'roedy-mail'), s('f', 'My filter', true)], 1)).toMatchObject({
      scriptId: 's1',
      active: 'foreign',
      activeName: 'My filter',
    });
    expect(scriptStatus([s('f', null, true)], 1)).toMatchObject({
      scriptId: null,
      active: 'foreign',
      activeName: null,
    });
  });
});

describe('ruleError', () => {
  it('is null for a complete rule', () => {
    expect(ruleError(rule())).toBeNull();
    expect(
      ruleError(
        rule({
          conds: [
            ['att', ''],
            ['size', '1,5'],
          ],
          acts: [
            ['fwd', ' me@private.example '],
            ['move', 'm1'],
            ['tag', 't1'],
          ],
        }),
      ),
    ).toBeNull();
  });

  it('checks name, values, size, address and target', () => {
    expect(ruleError(rule({ name: '  ' }))).toBe('name');
    expect(ruleError(rule({ conds: [['subj', ' ']] }))).toBe('value');
    expect(ruleError(rule({ conds: [['size', '']] }))).toBe('value');
    expect(ruleError(rule({ conds: [['size', '0']] }))).toBe('size');
    expect(ruleError(rule({ conds: [['size', 'abc']] }))).toBe('size');
    // Like `sizeTest`: what the script cannot write as a number does not count.
    expect(ruleError(rule({ conds: [['size', '1e21']] }))).toBe('size');
    expect(ruleError(rule({ acts: [['fwd', 'no-mailbox']] }))).toBe('address');
    expect(ruleError(rule({ acts: [['move', '']] }))).toBe('target');
    expect(ruleError(rule({ acts: [['tag', '']] }))).toBe('target');
    // The first error counts.
    expect(ruleError(rule({ name: '', conds: [['from', '']] }))).toBe('name');
  });
});

describe('forwardError', () => {
  it('requires a valid address only when turned on', () => {
    expect(forwardError({ on: false, to: '', keep: true })).toBeNull();
    expect(forwardError({ on: false, to: 'broken', keep: true })).toBeNull();
    expect(forwardError({ on: true, to: '', keep: true })).toBe('address');
    expect(forwardError({ on: true, to: 'broken', keep: true })).toBe('address');
    expect(forwardError({ on: true, to: ' me@private.example ', keep: false })).toBeNull();
  });
});

describe('saveErrorText', () => {
  it('names the limit for a script that is too large, otherwise the rejection', () => {
    expect(saveErrorText(new RulesRefused({ type: 'tooLarge' }), 4096)).toBe(m.rules_too_large({ size: '4 KB' }));
    expect(saveErrorText(new RulesRefused({ type: 'tooLarge' }), null)).toBe(m.rules_invalid());
    expect(saveErrorText(new RulesRefused({ type: 'invalidScript', description: 'line 3' }), 4096)).toBe(
      m.rules_invalid(),
    );
    expect(saveErrorText(new RulesRefused({ type: 'invalidScript' }), null)).toBe(m.rules_invalid());
  });

  it('reports "Keine Verbindung" without a response, otherwise the generic error', () => {
    expect(saveErrorText(new NetworkError(new TypeError('Failed to fetch')), 4096)).toBe(m.error_offline());
    expect(saveErrorText(new Error('broken'), 4096)).toBe(m.error_act());
    expect(saveErrorText(new Error('broken'), null)).toBe(m.error_act());
  });
});

describe('rulesActive', () => {
  it('applies only to loaded rules with forwarding turned on or an active rule', () => {
    expect(rulesActive('a1')).toBe(false);
    // A pending model does not count without a loaded state.
    rules.pending = { a1: model('Boss') };
    rules.values = { a1: 'unsupported' };
    expect(rulesActive('a1')).toBe(false);
    rules.values = { a1: new LoadFailed(new Error('broken')) };
    expect(rulesActive('a1')).toBe(false);
    rules.pending = {};
    rules.values = { a1: loaded(model()) };
    expect(rulesActive('a1')).toBe(false);
    rules.values = { a1: loaded({ ...model(), rules: [rule({ on: false })] }) };
    expect(rulesActive('a1')).toBe(false);
    rules.values = { a1: loaded(model('Boss')) };
    expect(rulesActive('a1')).toBe(true);
    expect(rulesActive('a2')).toBe(false);
    rules.values = { a1: loaded({ forward: { on: true, to: 'me@private.example', keep: true }, rules: [] }) };
    expect(rulesActive('a1')).toBe(true);
    // The model not yet saved applies.
    rules.pending = { a1: model() };
    expect(rulesActive('a1')).toBe(false);
  });
});

describe('Rules', () => {
  it('loads the rules of an account', async () => {
    const api = fakeApi(loaded(model('Boss')));
    const s = new Rules(api);
    expect(s.model('a1')).toBeNull();
    expect(s.loaded('a1')).toBeNull();
    await s.load('a1');
    expect(api.load).toHaveBeenCalledWith('a1');
    expect(s.model('a1')).toEqual(model('Boss'));
    expect(s.loaded('a1')).toMatchObject({ scriptId: 's1', active: 'ours', damaged: false });
    expect(s.model('a2')).toBeNull();
  });

  it('remembers a server without Sieve', async () => {
    const s = new Rules(fakeApi(null));
    await s.load('a1');
    expect(s.values.a1).toBe('unsupported');
    expect(s.loaded('a1')).toBeNull();
    expect(s.model('a1')).toBeNull();
  });

  it('loads an account only once at a time', async () => {
    const api = fakeApi();
    const s = new Rules(api);
    const first = s.load('a1');
    expect(s.load('a1')).toBe(first);
    await first;
    expect(api.load).toHaveBeenCalledOnce();
  });

  it('remembers a failed first load without a toast and reports a later one as a toast', async () => {
    const api = fakeApi(loaded(model('Boss')));
    api.load.mockRejectedValueOnce(new Error('broken'));
    const s = new Rules(api);
    await s.load('a1');
    expect(s.values.a1).toBeInstanceOf(LoadFailed);
    expect(ui.toast).toBeNull();
    // Retrying shows the skeleton again.
    const again = s.load('a1');
    expect(s.values.a1).toBeUndefined();
    await again;
    expect(s.model('a1')).toEqual(model('Boss'));
    api.load.mockRejectedValueOnce(new Error('broken'));
    await s.load('a1');
    expect(s.model('a1')).toEqual(model('Boss'));
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('does not save if a change leaves the model unchanged', async () => {
    const api = fakeApi(loaded(model('Boss')));
    const s = new Rules(api);
    await s.load('a1');
    await expect(s.update('a1', (m) => m)).resolves.toBe(true);
    expect(api.save).not.toHaveBeenCalled();
    expect(s.pending).toEqual({});
  });

  it('after turning on the vacation notice reloads only an already loaded account', async () => {
    const api = fakeApi(loaded(model('Boss')));
    const s = new Rules(api);
    s.refresh('a1');
    expect(api.load).not.toHaveBeenCalled();
    await s.load('a1');
    api.load.mockResolvedValue(loaded(model('Boss'), { active: 'vacation', activeName: 'vacation' }));
    s.refresh('a1');
    await vi.waitFor(() => expect(s.loaded('a1')).toMatchObject({ active: 'vacation' }));
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it('shows a change immediately and saves it', async () => {
    const api = fakeApi(loaded(model('Boss'), { damaged: true, active: 'foreign', activeName: 'Foreign' }));
    const s = new Rules(api);
    await s.load('a1');
    const save = s.update('a1', (m) => ({ ...m, rules: [...m.rules, rule({ id: 'r9', name: 'New' })] }));
    expect(s.model('a1')?.rules.map((r) => r.name)).toEqual(['Boss', 'New']);
    expect(s.saving.has('a1')).toBe(true);
    await expect(save).resolves.toBe(true);
    expect(api.save).toHaveBeenCalledOnce();
    expect(api.save.mock.calls[0]?.[1].rules.map((r) => r.name)).toEqual(['Boss', 'New']);
    expect(s.pending).toEqual({});
    expect(s.saving.size).toBe(0);
    expect(s.loaded('a1')).toMatchObject({ ...STATUS, damaged: false });
    expect(s.loaded('a1')?.model.rules.map((r) => r.name)).toEqual(['Boss', 'New']);
  });

  it('saves the newest model last on two quick changes', async () => {
    const api = fakeApi(loaded(model()));
    const first = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => first.promise);
    const s = new Rules(api);
    await s.load('a1');
    const one = s.update('a1', () => model('Eins'));
    const two = s.update('a1', (m) => ({ ...m, rules: [...m.rules, rule({ id: 'r9', name: 'Zwei' })] }));
    expect(s.model('a1')).toEqual({
      ...model('Eins'),
      rules: [...model('Eins').rules, rule({ id: 'r9', name: 'Zwei' })],
    });
    expect(api.save).toHaveBeenCalledOnce();
    first.resolve(STATUS);
    await expect(two).resolves.toBe(true);
    await expect(one).resolves.toBe(true);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[0]?.[1]).toEqual(model('Eins'));
    expect(api.save.mock.calls[1]?.[1].rules.map((r) => r.name)).toEqual(['Eins', 'Zwei']);
    expect(s.loaded('a1')?.model.rules.map((r) => r.name)).toEqual(['Eins', 'Zwei']);
    expect(s.pending).toEqual({});
    expect(s.saving.size).toBe(0);
  });

  it('shows the server state again after a save error, with a toast and a new load', async () => {
    const api = fakeApi(loaded(model('Alt')));
    api.save.mockRejectedValueOnce(new Error('broken'));
    const s = new Rules(api);
    await s.load('a1');
    const reload = deferred<RulesLoaded | null>();
    api.load.mockImplementationOnce(() => reload.promise);
    const save = s.update('a1', () => model('New'));
    expect(s.model('a1')).toEqual(model('New'));
    await expect(save).resolves.toBe(false);
    expect(s.model('a1')).toEqual(model('Alt'));
    expect(s.pending).toEqual({});
    expect(s.saving.size).toBe(0);
    expect(ui.toast).toMatchObject({ text: FAIL, error: true });
    // The script may look different by now: reload.
    expect(api.load).toHaveBeenCalledTimes(2);
    reload.resolve(loaded(model('Anderes Programm')));
    await s.load('a1');
    expect(s.model('a1')).toEqual(model('Anderes Programm'));
  });

  it('shows a rejection with its text and the limit of the loaded state', async () => {
    const api = fakeApi(loaded(model('Alt'), { maxSize: 2048 }));
    api.save
      .mockRejectedValueOnce(new RulesRefused({ type: 'tooLarge' }))
      .mockRejectedValueOnce(new RulesRefused({ type: 'invalidScript', description: 'line 3' }));
    const s = new Rules(api);
    await s.load('a1');
    await expect(s.update('a1', () => model('New'))).resolves.toBe(false);
    expect(ui.toast).toMatchObject({ text: m.rules_too_large({ size: '2 KB' }), error: true, undo: false });
    expect(s.model('a1')).toEqual(model('Alt'));
    // Wait for the reload after the error.
    await s.load('a1');
    await expect(s.update('a1', () => model('New'))).resolves.toBe(false);
    expect(ui.toast).toMatchObject({ text: m.rules_invalid(), error: true });
  });

  it('takes maxSize from saving and activating', async () => {
    const api = fakeApi(loaded(model('Alt'), { maxSize: 2048 }));
    api.save.mockResolvedValueOnce({ ...STATUS, maxSize: 4096 });
    api.activate.mockResolvedValueOnce({ ...STATUS, maxSize: 8192 });
    const s = new Rules(api);
    await s.load('a1');
    expect(s.loaded('a1')?.maxSize).toBe(2048);
    await s.update('a1', () => model('New'));
    expect(s.loaded('a1')?.maxSize).toBe(4096);
    await s.activate('a1');
    expect(s.loaded('a1')?.maxSize).toBe(8192);
  });

  it('also discards a change that came during the save on an error', async () => {
    const api = fakeApi(loaded(model('Alt')));
    const first = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => first.promise);
    const s = new Rules(api);
    await s.load('a1');
    const one = s.update('a1', () => model('Eins'));
    const two = s.update('a1', () => model('Zwei'));
    first.reject(new Error('broken'));
    await expect(one).resolves.toBe(false);
    await expect(two).resolves.toBe(false);
    expect(api.save).toHaveBeenCalledOnce();
    expect(s.model('a1')).toEqual(model('Alt'));
  });

  it('changes nothing without a loaded state', async () => {
    const api = fakeApi(null);
    const s = new Rules(api);
    await expect(s.update('a1', () => model('New'))).resolves.toBe(false);
    await s.load('a1');
    await expect(s.update('a1', () => model('New'))).resolves.toBe(false);
    expect(api.save).not.toHaveBeenCalled();
    expect(s.pending).toEqual({});
    expect(s.saving.size).toBe(0);
  });

  it('discards a load that started before a write', async () => {
    const api = fakeApi(loaded(model('Alt')));
    const s = new Rules(api);
    await s.load('a1');
    const stale = deferred<RulesLoaded | null>();
    api.load.mockImplementationOnce(() => stale.promise);
    const load = s.load('a1');
    await s.update('a1', () => model('New'));
    stale.resolve(loaded(model('Alt')));
    await load;
    expect(s.model('a1')).toEqual(model('New'));
    // A load after the write applies again.
    api.load.mockResolvedValueOnce(loaded(model('Later')));
    await s.load('a1');
    expect(s.model('a1')).toEqual(model('Later'));
  });

  it('reloads after a save error, even if an older load is still running', async () => {
    const api = fakeApi(loaded(model('Alt')));
    const s = new Rules(api);
    await s.load('a1');
    const stale = deferred<RulesLoaded | null>();
    api.load.mockImplementationOnce(() => stale.promise);
    const load = s.load('a1');
    const first = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => first.promise).mockRejectedValueOnce(new Error('broken'));
    api.load.mockResolvedValueOnce(loaded(model('Anderes Programm')));
    const one = s.update('a1', () => model('Eins'));
    void s.update('a1', () => model('Zwei'));
    first.resolve(STATUS);
    await expect(one).resolves.toBe(false);
    stale.resolve(loaded(model('Alt')));
    await load;
    await settle();
    // The load that started before the first write does not apply; the new load after the error does.
    expect(api.load).toHaveBeenCalledTimes(3);
    expect(s.model('a1')).toEqual(model('Anderes Programm'));
  });

  it('ignores a running save and load after reset()', async () => {
    const api = fakeApi(loaded(model('Alt')));
    const save = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => save.promise);
    const s = new Rules(api);
    await s.load('a1');
    const run = s.update('a1', () => model('New'));
    s.reset();
    expect(s.saving.size).toBe(0);
    save.resolve(STATUS);
    await expect(run).resolves.toBe(false);
    expect(s.values).toEqual({});
    expect(s.pending).toEqual({});
    expect(s.saving.size).toBe(0);

    const load = deferred<RulesLoaded | null>();
    api.load.mockImplementationOnce(() => load.promise);
    const loading = s.load('a1');
    s.reset();
    load.resolve(loaded(model('Alt')));
    await loading;
    expect(s.values).toEqual({});
    // Afterwards it loads and saves again.
    await s.load('a1');
    await expect(s.update('a1', () => model('Again'))).resolves.toBe(true);
    expect(s.model('a1')).toEqual(model('Again'));
  });

  it('does not report an error after reset()', async () => {
    const api = fakeApi(loaded(model('Alt')));
    const save = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => save.promise);
    const s = new Rules(api);
    await s.load('a1');
    const run = s.update('a1', () => model('New'));
    s.reset();
    save.reject(new Error('broken'));
    await expect(run).resolves.toBe(false);
    expect(ui.toast).toBeNull();
    expect(api.load).toHaveBeenCalledOnce();
  });

  it('counts the forwardings of the displayed model', async () => {
    const s = new Rules(fakeApi(loaded(model('Boss'))));
    expect(s.redirects('a1')).toBe(0);
    await s.load('a1');
    expect(s.redirects('a1')).toBe(0);
    void s.update('a1', (m) => ({
      forward: { on: true, to: 'me@private.example', keep: true },
      rules: [...m.rules, rule({ id: 'r9', acts: [['fwd', 'b@example.com']] })],
    }));
    expect(s.redirects('a1')).toBe(2);
  });

  it('activates our own script and takes over the status', async () => {
    const api = fakeApi(loaded(model('Boss'), { active: 'foreign', activeName: 'Foreign' }));
    const s = new Rules(api);
    await s.load('a1');
    await expect(s.activate('a1')).resolves.toBe(true);
    expect(api.activate).toHaveBeenCalledWith('a1', true);
    expect(s.loaded('a1')).toMatchObject({ active: 'ours', activeName: null, model: model('Boss') });
  });

  it('reports false while the vacation notice runs', async () => {
    const api = fakeApi(loaded(model('Boss'), { active: 'vacation', activeName: 'vacation' }));
    api.activate.mockResolvedValue({ ...STATUS, active: 'vacation', activeName: 'vacation' });
    const s = new Rules(api);
    await s.load('a1');
    await expect(s.activate('a1')).resolves.toBe(false);
    expect(s.loaded('a1')).toMatchObject({ active: 'vacation', model: model('Boss') });
  });

  it('activates only after a running save', async () => {
    const api = fakeApi(loaded(model('Alt'), { active: 'none' }));
    const save = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => save.promise);
    const s = new Rules(api);
    await s.load('a1');
    const run = s.update('a1', () => model('New'));
    const activate = s.activate('a1');
    await settle();
    expect(api.activate).not.toHaveBeenCalled();
    save.resolve({ ...STATUS, active: 'none' });
    await run;
    await expect(activate).resolves.toBe(true);
    expect(api.activate).toHaveBeenCalledOnce();
    expect(s.loaded('a1')).toMatchObject({ active: 'ours', model: model('New') });
  });

  it('reports an activation error as a toast, but not when resuming', async () => {
    const api = fakeApi(loaded(model('Boss'), { active: 'none' }));
    api.activate.mockRejectedValue(new Error('broken'));
    const s = new Rules(api);
    await s.load('a1');
    await expect(s.activate('a1')).resolves.toBe(false);
    expect(ui.toast).toMatchObject({ text: FAIL, error: true });
    ui.reset();
    await expect(s.resume('a1')).resolves.toBeUndefined();
    expect(api.activate).toHaveBeenCalledTimes(2);
    // Only "Einschalten" replaces a foreign script, resuming does not.
    expect(api.activate.mock.calls).toEqual([
      ['a1', true],
      ['a1', false],
    ]);
    expect(ui.toast).toBeNull();
    expect(s.loaded('a1')).toMatchObject({ active: 'none' });
  });
});

describe('jmapRulesApi', () => {
  const targets: SieveTargets = {
    folder: (id) => (id === 'm1' ? 'Archive/2026' : null),
    tag: (id) => (id === 't1' ? 'Tags/Important' : null),
  };
  const withTargets = () => Promise.resolve(targets);

  const script = (id: string, name: string, isActive = false, blobId = `b-${id}`): SieveScript => ({
    id,
    name,
    blobId,
    isActive,
  });

  function session(sieve: 'account' | 'server' | 'none', extra: Record<string, unknown> = {}): Session {
    const cap = { maxNumberRedirects: 1, sieveExtensions: ['fileinto', 'imap4flags', 'copy'], ...extra };
    const server = sieve === 'none' ? { [MAIL]: {} } : { [MAIL]: {}, [SIEVE]: {} };
    const account = sieve === 'account' ? { [MAIL]: {}, [SIEVE]: cap } : { [MAIL]: {} };
    return {
      capabilities: server,
      accounts: { c: { name: 'account1@s1.test', isPersonal: true, isReadOnly: false, accountCapabilities: account } },
      primaryAccounts: { [MAIL]: 'c' },
    } as unknown as Session;
  }

  interface Options {
    sieve?: 'account' | 'server' | 'none';
    /** Further details of the capability, such as `maxSizeScript`. */
    cap?: Record<string, unknown>;
    /** Scripts before writing. */
    list?: SieveScript[];
    /** Scripts after writing (`SieveScript/get` in the same request). */
    after?: SieveScript[];
    /** Content of the downloaded script. */
    text?: string;
    setResponse?: Record<string, unknown>;
  }

  function fake(o: Options = {}) {
    const calls: [string, unknown][] = [];
    const uploads: unknown[][] = [];
    const downloads: unknown[] = [];
    const c = {
      session: () => Promise.resolve(session(o.sieve ?? 'account', o.cap)),
      accountId: () => Promise.resolve('c'),
      call: (name: string, args: unknown) => {
        calls.push([name, args]);
        return Promise.resolve({ accountId: 'c', state: 'x1', list: o.list ?? [], notFound: [] });
      },
      upload: (accountId: string, data: string, type: string) => {
        uploads.push([accountId, data, type]);
        return Promise.resolve({ accountId, blobId: 'new', type, size: data.length });
      },
      download: (ref: unknown) => {
        downloads.push(ref);
        return Promise.resolve({ text: () => Promise.resolve(o.text ?? '') });
      },
      batch: () => ({
        call: (name: string, args: unknown) => {
          calls.push([name, args]);
          return name;
        },
        send: () =>
          Promise.resolve({
            get: (call: string) =>
              call === 'SieveScript/set' ? (o.setResponse ?? {}) : { list: o.after ?? o.list ?? [] },
          }),
      }),
    };
    return { calls, uploads, downloads, client: () => Promise.resolve(c as unknown as JmapClient) };
  }

  const M: RuleSet = {
    forward: { on: true, to: 'me@private.example', keep: true },
    rules: [
      rule({
        acts: [
          ['move', 'm1'],
          ['tag', 't1'],
        ],
      }),
    ],
  };

  it('returns null without Sieve on the account and does not ask', async () => {
    for (const sieve of ['none', 'server'] as const) {
      const f = fake({ sieve });
      await expect(jmapRulesApi(f.client, withTargets).load('a1')).resolves.toBeNull();
      expect(f.calls).toEqual([]);
      expect(f.downloads).toEqual([]);
    }
  });

  it('starts empty without an own script and reports a foreign active one', async () => {
    const f = fake({ list: [script('f', 'My filter', true)] });
    await expect(jmapRulesApi(f.client, withTargets).load('a1')).resolves.toEqual({
      scriptId: null,
      active: 'foreign',
      activeName: 'My filter',
      maxRedirects: 1,
      maxSize: null,
      model: EMPTY_RULES,
      damaged: false,
    });
    expect(f.calls).toEqual([['SieveScript/get', { accountId: 'c' }]]);
    expect(f.downloads).toEqual([]);
  });

  it('loads the blob of our own script and reads the model from it', async () => {
    const f = fake({
      list: [script('f', 'My filter'), script('s1', 'roedy-mail', true, 'b1')],
      text: storedScript(M, targets),
    });
    await expect(jmapRulesApi(f.client, withTargets).load('a1')).resolves.toEqual({
      scriptId: 's1',
      active: 'ours',
      activeName: null,
      maxRedirects: 1,
      maxSize: null,
      model: M,
      damaged: false,
    });
    expect(f.downloads).toEqual([
      { accountId: 'c', blobId: 'b1', type: 'application/sieve', name: 'roedy-mail.sieve' },
    ]);
  });

  it('starts empty for an own script without a readable model and remembers it', async () => {
    const f = fake({
      list: [script('s1', 'roedy-mail'), script('v', 'vacation', true)],
      text: 'require "fileinto";\nif true { fileinto "X"; }\n',
    });
    await expect(jmapRulesApi(f.client, withTargets).load('a1')).resolves.toMatchObject({
      scriptId: 's1',
      active: 'vacation',
      activeName: 'vacation',
      model: EMPTY_RULES,
      damaged: true,
    });
  });

  it('creates the script on the first save and activates it (RFC 9661)', async () => {
    const f = fake({
      list: [],
      after: [script('s1', 'roedy-mail', true, 'new')],
      setResponse: { created: { r: { id: 's1' } } },
    });
    await expect(jmapRulesApi(f.client, withTargets).save('a1', M)).resolves.toEqual({
      scriptId: 's1',
      active: 'ours',
      activeName: null,
      maxRedirects: 1,
      maxSize: null,
    });
    expect(f.uploads).toEqual([['c', storedScript(M, targets), 'application/sieve']]);
    expect(f.calls).toEqual([
      ['SieveScript/get', { accountId: 'c' }],
      [
        'SieveScript/set',
        { accountId: 'c', create: { r: { name: 'roedy-mail', blobId: 'new' } }, onSuccessActivateScript: '#r' },
      ],
      ['SieveScript/get', { accountId: 'c' }],
    ]);
  });

  it('changes an existing script via blobId and replaces a foreign active one', async () => {
    const f = fake({
      list: [script('s1', 'roedy-mail', false, 'old'), script('f', 'My filter', true)],
      after: [script('s1', 'roedy-mail', true, 'new'), script('f', 'My filter')],
      setResponse: { updated: { s1: null } },
    });
    await expect(jmapRulesApi(f.client, withTargets).save('a1', M)).resolves.toMatchObject({
      scriptId: 's1',
      active: 'ours',
    });
    expect(f.calls[1]).toEqual([
      'SieveScript/set',
      { accountId: 'c', update: { s1: { blobId: 'new' } }, onSuccessActivateScript: 's1' },
    ]);
  });

  it('does not activate while the vacation notice runs', async () => {
    const existing = fake({
      list: [script('s1', 'roedy-mail'), script('v', 'vacation', true)],
      setResponse: { updated: { s1: null } },
    });
    await expect(jmapRulesApi(existing.client, withTargets).save('a1', M)).resolves.toMatchObject({
      scriptId: 's1',
      active: 'vacation',
    });
    expect(existing.calls[1]).toEqual(['SieveScript/set', { accountId: 'c', update: { s1: { blobId: 'new' } } }]);

    const fresh = fake({
      list: [script('v', 'vacation', true)],
      after: [script('s1', 'roedy-mail'), script('v', 'vacation', true)],
      setResponse: { created: { r: { id: 's1' } } },
    });
    await jmapRulesApi(fresh.client, withTargets).save('a1', M);
    expect(fresh.calls[1]).toEqual([
      'SieveScript/set',
      { accountId: 'c', create: { r: { name: 'roedy-mail', blobId: 'new' } } },
    ]);
  });

  it('reports a rejection as RulesRefused', async () => {
    const created = fake({ setResponse: { notCreated: { r: { type: 'invalidScript', description: 'line 3' } } } });
    const error = await jmapRulesApi(created.client, withTargets)
      .save('a1', M)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RulesRefused);
    expect((error as RulesRefused).error).toEqual({ type: 'invalidScript', description: 'line 3' });

    const updated = fake({
      list: [script('s1', 'roedy-mail', true)],
      setResponse: { notUpdated: { s1: { type: 'tooLarge' } } },
    });
    await expect(jmapRulesApi(updated.client, withTargets).save('a1', M)).rejects.toBeInstanceOf(RulesRefused);
  });

  it('activates our own script instead of a foreign one or none', async () => {
    for (const other of [[script('f', 'My filter', true)], []]) {
      const f = fake({
        list: [script('s1', 'roedy-mail'), ...other],
        after: [script('s1', 'roedy-mail', true)],
      });
      await expect(jmapRulesApi(f.client, withTargets).activate('a1', true)).resolves.toEqual({
        scriptId: 's1',
        active: 'ours',
        activeName: null,
        maxRedirects: 1,
        maxSize: null,
      });
      expect(f.calls).toEqual([
        ['SieveScript/get', { accountId: 'c' }],
        ['SieveScript/set', { accountId: 'c', onSuccessActivateScript: 's1' }],
        ['SieveScript/get', { accountId: 'c' }],
      ]);
      expect(f.uploads).toEqual([]);
    }
  });

  it('activates nothing with a running vacation notice, without an own script or if it is already active', async () => {
    const cases: [SieveScript[], ScriptStatus['active']][] = [
      [[script('s1', 'roedy-mail'), script('v', 'vacation', true)], 'vacation'],
      [[script('f', 'My filter', true)], 'foreign'],
      [[], 'none'],
      [[script('s1', 'roedy-mail', true)], 'ours'],
    ];
    for (const [list, active] of cases) {
      const f = fake({ list });
      await expect(jmapRulesApi(f.client, withTargets).activate('a1', true)).resolves.toMatchObject({ active });
      expect(f.calls).toEqual([['SieveScript/get', { accountId: 'c' }]]);
    }
  });

  it('does not replace a foreign active script without replaceForeign (resuming)', async () => {
    const f = fake({ list: [script('s1', 'roedy-mail'), script('f', 'My filter', true)] });
    await expect(jmapRulesApi(f.client, withTargets).activate('a1', false)).resolves.toMatchObject({
      scriptId: 's1',
      active: 'foreign',
      activeName: 'My filter',
    });
    expect(f.calls).toEqual([['SieveScript/get', { accountId: 'c' }]]);
  });

  it('returns maxSizeScript as maxSize when loading, saving and activating', async () => {
    const cap = { maxSizeScript: 4096 };
    const load = fake({ cap, list: [script('f', 'My filter', true)] });
    await expect(jmapRulesApi(load.client, withTargets).load('a1')).resolves.toMatchObject({
      maxRedirects: 1,
      maxSize: 4096,
    });
    const own = fake({ cap, list: [script('s1', 'roedy-mail', true, 'b1')], text: storedScript(M, targets) });
    await expect(jmapRulesApi(own.client, withTargets).load('a1')).resolves.toMatchObject({ model: M, maxSize: 4096 });

    const save = fake({
      cap,
      after: [script('s1', 'roedy-mail', true, 'new')],
      setResponse: { created: { r: { id: 's1' } } },
    });
    await expect(jmapRulesApi(save.client, withTargets).save('a1', M)).resolves.toMatchObject({
      active: 'ours',
      maxSize: 4096,
    });

    const activate = fake({ cap, list: [script('s1', 'roedy-mail')], after: [script('s1', 'roedy-mail', true)] });
    await expect(jmapRulesApi(activate.client, withTargets).activate('a1', true)).resolves.toMatchObject({
      active: 'ours',
      maxSize: 4096,
    });
    // Also without activating anything.
    const keep = fake({ cap, list: [script('s1', 'roedy-mail', true)] });
    await expect(jmapRulesApi(keep.client, withTargets).activate('a1', true)).resolves.toMatchObject({
      active: 'ours',
      maxSize: 4096,
    });
    expect(keep.calls).toHaveLength(1);

    // An invalid limit counts as none.
    const bad = fake({ cap: { maxSizeScript: -1 } });
    await expect(jmapRulesApi(bad.client, withTargets).load('a1')).resolves.toMatchObject({ maxSize: null });
  });

  it('does not ask anything when activating without Sieve on the account', async () => {
    const f = fake({ sieve: 'server', list: [script('s1', 'roedy-mail')] });
    await expect(jmapRulesApi(f.client, withTargets).activate('a1', true)).resolves.toEqual({
      scriptId: null,
      active: 'none',
      activeName: null,
      maxRedirects: null,
      maxSize: null,
    });
    expect(f.calls).toEqual([]);
  });
});
