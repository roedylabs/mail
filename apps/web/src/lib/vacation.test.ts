import { MAIL, VACATION, type JmapClient, type Session, type VacationResponse } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { LoadFailed } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import type { Rule } from '#lib/sieve/generate.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  dayOf,
  dayStart,
  utcDate,
  vacationFields,
  vacationPatch,
  vacations,
  Vacations,
  vacationSummary,
  vacationValues,
  jmapVacationApi,
  VacationRefused,
  type VacationApi,
} from './vacation.svelte.ts';
import { rules, type RulesLoaded } from './rules.svelte.ts';

const TZ = 'Europe/Berlin';

function vacation(overrides: Partial<VacationResponse> = {}): VacationResponse {
  return {
    id: 'singleton',
    isEnabled: false,
    fromDate: null,
    toDate: null,
    subject: null,
    textBody: null,
    htmlBody: null,
    ...overrides,
  };
}

const ACCOUNT: MailAccount = {
  id: 'a1',
  email: 'account1@s1.test',
  username: 'account1@s1.test',
  url: 'https://mail.s1.test',
  host: 'mail.s1.test',
  server_id: 's1',
  auth_kind: 'oauth',
  color: 0,
  state: 'ok',
  blocked: false,
  quota_used: null,
  quota_total: null,
  last_check_at: null,
  created_at: '2026-10-27T10:00:00Z',
};

function fakeApi(v: VacationResponse) {
  let current = v;
  return {
    get: vi.fn<VacationApi['get']>(() => Promise.resolve(current)),
    set: vi.fn<VacationApi['set']>((_a, patch) => {
      current = { ...current, ...patch };
      return Promise.resolve(current);
    }),
  };
}

afterEach(() => {
  vacations.reset();
  rules.reset();
  ui.reset();
});

describe('Days in the time zone', () => {
  it('converts days into UTC points in time', () => {
    expect(utcDate(dayStart('2026-11-10', TZ))).toBe('2026-11-09T23:00:00Z');
    expect(utcDate(dayStart('2026-11-10', TZ, true))).toBe('2026-11-10T23:00:00Z');
    expect(utcDate(dayStart('2026-07-01', TZ))).toBe('2026-06-30T22:00:00Z');
    expect(dayStart('', TZ)).toBeNaN();
    expect(dayOf(Date.parse('2026-11-09T23:00:00Z'), TZ)).toBe('2026-11-10');
  });

  it('reads the end day inclusively and falls back to the default subject without a subject', () => {
    const f = vacationFields(
      vacation({ isEnabled: true, fromDate: '2026-11-09T23:00:00Z', toDate: '2026-11-20T23:00:00Z', textBody: 'Away' }),
      TZ,
    );
    expect(f).toEqual({ on: true, from: '2026-11-10', to: '2026-11-20', subject: 'Out of office', text: 'Away' });
    // An end in the middle of the day (another program) belongs to that day.
    expect(vacationFields(vacation({ toDate: '2026-11-20T16:00:00Z' }), TZ).to).toBe('2026-11-20');
    expect(vacationFields(vacation({ subject: '' }), TZ).subject).toBe('');
  });
});

describe('vacationPatch', () => {
  const before = vacation({ subject: 'Out of office', textBody: 'Away' });
  const base = vacationFields(before, TZ);

  it('sends only what changed', () => {
    expect(vacationPatch(before, base, base, TZ)).toEqual({});
    expect(vacationPatch(before, base, { ...base, on: true, to: '2026-11-20' }, TZ)).toEqual({
      isEnabled: true,
      toDate: '2026-11-20T23:00:00Z',
    });
  });

  it('clears days and an empty subject with null', () => {
    const set = vacation({ fromDate: '2026-11-09T23:00:00Z', subject: 'Out of office' });
    const f = vacationFields(set, TZ);
    expect(vacationPatch(set, f, { ...f, from: '', subject: '  ' }, TZ)).toEqual({ fromDate: null, subject: null });
  });

  it('sends the subject as long as the server has none', () => {
    const empty = vacation();
    const f = vacationFields(empty, TZ);
    expect(vacationPatch(empty, f, { ...f, on: true, text: 'Away' }, TZ)).toEqual({
      isEnabled: true,
      subject: 'Out of office',
      textBody: 'Away',
    });
  });

  it('clears the HTML version along with the text', () => {
    const html = vacation({ subject: 'Out of office', textBody: 'Away', htmlBody: '<p>Away</p>' });
    expect(
      vacationPatch(html, vacationFields(html, TZ), { ...vacationFields(html, TZ), text: 'Back soon' }, TZ),
    ).toEqual({
      textBody: 'Back soon',
      htmlBody: null,
    });
  });
});

describe('vacationSummary', () => {
  it('names period and state', () => {
    const on = { on: true, from: '', to: '' };
    expect(vacationSummary({ ...on, on: false, from: '2026-11-10' })).toBe('Off');
    expect(vacationSummary({ ...on, from: '2026-11-10', to: '2026-11-20' })).toBe(
      'From 10 November 2026 to 20 November 2026',
    );
    expect(vacationSummary({ ...on, to: '2026-11-20' })).toBe('Until 20 November 2026');
    expect(vacationSummary({ ...on, from: '2026-11-10' })).toBe('Starting 10 November 2026');
    expect(vacationSummary(on)).toBe('Until you turn it off');
  });
});

describe('Vacations', () => {
  it('creates a draft with the first edit and discards it', async () => {
    const s = new Vacations(fakeApi(vacation()), () => TZ);
    expect(s.view('a1')).toBeNull();
    await s.load('a1');
    expect(s.view('a1')?.dirty).toBe(false);
    s.set('a1', { on: true });
    expect(s.view('a1')?.fields.on).toBe(true);
    expect(s.view('a1')?.dirty).toBe(true);
    s.set('a1', { on: false });
    expect(s.view('a1')?.dirty).toBe(false);
    s.set('a1', { text: 'Away' });
    expect(s.view('a2')).toBeNull();
    s.discard();
    expect(s.view('a1')?.fields.text).toBe('');
  });

  it('remembers a failed first load without a toast for the card', async () => {
    const api = fakeApi(vacation());
    const error = new Error('broken');
    api.get.mockRejectedValueOnce(error);
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    expect(s.values.a1).toBeInstanceOf(LoadFailed);
    expect((s.values.a1 as LoadFailed).error).toBe(error);
    expect(s.view('a1')).toBeNull();
    expect(ui.toast).toBeNull();
  });

  it('keeps the values on a later failed load and reports it as a toast', async () => {
    const api = fakeApi(vacation({ textBody: 'Away' }));
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    api.get.mockRejectedValueOnce(new ApiError(502, { error: 'refresh_failed', reason: 'unreachable' }));
    await s.load('a1');
    expect(s.view('a1')?.fields.text).toBe('Away');
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('remembers a server without vacation notice', async () => {
    const api = fakeApi(vacation());
    api.get.mockResolvedValueOnce(null);
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    expect(s.values.a1).toBe('unsupported');
    expect(s.view('a1')).toBeNull();
    s.set('a1', { on: true });
    await s.save();
    expect(api.set).not.toHaveBeenCalled();
  });

  it('checks period and message before saving', async () => {
    const api = fakeApi(vacation());
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { from: '2026-11-20', to: '2026-11-10' });
    await s.save();
    expect(ui.toast?.text).toBe('The end date is before the start date');
    s.set('a1', { to: '2026-11-25', on: true, text: '  ' });
    await s.save();
    expect(ui.toast?.text).toBe('Please enter a message');
    expect(api.set).not.toHaveBeenCalled();
    expect(s.view('a1')?.dirty).toBe(true);
  });

  it('saves via VacationResponse/set', async () => {
    const api = fakeApi(vacation());
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { on: true, to: '2026-11-20', text: 'Out of office' });
    const save = s.save();
    expect(s.saving.has('a1')).toBe(true);
    await save;
    expect(api.set).toHaveBeenCalledWith('a1', {
      isEnabled: true,
      toDate: '2026-11-20T23:00:00Z',
      subject: 'Out of office',
      textBody: 'Out of office',
    });
    expect(s.draft).toBeNull();
    expect(s.view('a1')?.fields).toMatchObject({ on: true, to: '2026-11-20', text: 'Out of office' });
    expect(ui.toast?.text).toBe('Vacation reply turned on');
    s.set('a1', { on: false });
    await s.save();
    expect(ui.toast?.text).toBe('Vacation reply saved');
  });

  it('keeps newer server values in unchanged fields on reload', async () => {
    const api = fakeApi(vacation({ subject: 'Out of office', textBody: 'Old' }));
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { to: '2026-11-20' });
    api.get.mockResolvedValueOnce(vacation({ subject: 'Out of office', textBody: 'New' }));
    await s.load('a1');
    expect(s.view('a1')?.fields).toMatchObject({ to: '2026-11-20', text: 'New' });
    await s.save();
    expect(api.set).toHaveBeenCalledWith('a1', { toDate: '2026-11-20T23:00:00Z' });
  });

  it('saves a message only as HTML without text as long as the text stays unchanged', async () => {
    const api = fakeApi(vacation({ isEnabled: true, subject: 'Out of office', htmlBody: '<p>Away</p>' }));
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { to: '2026-11-20' });
    await s.save();
    expect(api.set).toHaveBeenCalledWith('a1', { toDate: '2026-11-20T23:00:00Z' });
    s.set('a1', { text: ' ' });
    await s.save();
    expect(ui.toast?.text).toBe('Please enter a message');
  });

  it('reports a day it cannot read as an error', async () => {
    const api = fakeApi(vacation());
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { to: '20266-11-20' });
    await expect(s.save()).resolves.toBeUndefined();
    expect(api.set).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ error: true });
    expect(s.saving.has('a1')).toBe(false);
  });

  it('shows the skeleton again on the next load after a failed one', async () => {
    const api = fakeApi(vacation());
    api.get.mockRejectedValueOnce(new Error('broken'));
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    const load = s.load('a1');
    expect(s.values.a1).toBeUndefined();
    await load;
    expect(s.view('a1')).not.toBeNull();
  });

  it('changes no fields while saving', async () => {
    const api = fakeApi(vacation());
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { subject: 'Vacation' });
    const save = s.save();
    s.set('a1', { subject: 'Later', on: true });
    expect(s.view('a1')?.fields).toMatchObject({ subject: 'Vacation', on: false });
    await save;
    expect(api.set).toHaveBeenCalledWith('a1', { subject: 'Vacation' });
  });

  it('keeps the draft on an error', async () => {
    const api = fakeApi(vacation());
    api.set.mockRejectedValueOnce(new Error('broken'));
    const s = new Vacations(api, () => TZ);
    await s.load('a1');
    s.set('a1', { subject: 'Vacation' });
    await s.save();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(s.view('a1')?.dirty).toBe(true);
    expect(s.saving.has('a1')).toBe(false);
  });
});

describe('vacationValues', () => {
  const input = { connection: vi.fn<(id: string) => void>(), rules: vi.fn<(id: string) => void>() };

  beforeEach(() => {
    input.connection.mockClear();
    input.rules.mockClear();
  });

  it('is null before loading and follows the draft', () => {
    expect(vacationValues(ACCOUNT, input)).toBeNull();
    vacations.values = { a1: vacation() };
    let v = vacationValues(ACCOUNT, input)!;
    expect(v).toMatchObject({
      load: null,
      na: false,
      on: false,
      dirty: false,
      summary: 'Off',
      subject: 'Out of office',
    });
    v.onToggle();
    v = vacationValues(ACCOUNT, input)!;
    expect(v).toMatchObject({ on: true, dirty: true, summary: 'Until you turn it off' });
    v.onFrom('2026-11-10');
    v.onSubject('Vacation');
    v.onText('Out of office');
    expect(vacationValues(ACCOUNT, input)).toMatchObject({
      from: '2026-11-10',
      subject: 'Vacation',
      text: 'Out of office',
    });
    vacationValues(ACCOUNT, input)!.discard();
    expect(vacationValues(ACCOUNT, input)!.dirty).toBe(false);
  });

  it('shows the card with buttons by reason after a failed first load', () => {
    vacations.values = { a1: new LoadFailed(new ApiError(502, { error: 'check_failed', reason: 'throttled' })) };
    let v = vacationValues(ACCOUNT, input)!;
    expect(v).toMatchObject({ na: false, dirty: false });
    expect(v.load).toMatchObject({
      text: 'Too many requests to mail.s1.test. Try again in a moment.',
      retry: true,
      reauth: false,
      con: false,
    });
    const load = vi.spyOn(vacations, 'load').mockResolvedValue();
    v.load!.onRetry();
    expect(load).toHaveBeenCalledWith('a1');
    load.mockRestore();
    vacations.values = { a1: new LoadFailed(new ApiError(409, { error: 'needs_reauth' })) };
    v = vacationValues(ACCOUNT, input)!;
    expect(v.load).toMatchObject({
      text: 'Sign-in to mail.s1.test required',
      retry: false,
      reauth: true,
      con: false,
    });
    v.load!.goCon();
    expect(input.connection).toHaveBeenCalledWith('a1');
  });

  it('shows the card instead of the fields without vacation notice on the server', () => {
    vacations.values = { a1: 'unsupported' };
    expect(vacationValues(ACCOUNT, input)).toMatchObject({
      load: null,
      na: true,
      naText: 'mail.s1.test doesn’t offer vacation replies, so automatic replies can’t be set up for this account.',
      dirty: false,
    });
  });

  it('points to resting rules, only with loaded rules with an active rule or forwarding', () => {
    const boss: Rule = {
      id: 'r1',
      name: 'Boss',
      on: true,
      match: 'all',
      conds: [['from', 'boss@example.com']],
      acts: [['read', '']],
    };
    const active: RulesLoaded = {
      scriptId: 's1',
      active: 'ours',
      activeName: null,
      maxRedirects: 1,
      maxSize: null,
      damaged: false,
      model: { forward: { on: false, to: '', keep: true }, rules: [boss] },
    };
    vacations.values = { a1: vacation() };
    expect(vacationValues(ACCOUNT, input)).toMatchObject({
      rlHint: false,
      rlHintText: m.rules_vacation_hint(),
      rlHintGo: m.rules_vacation_hint_go(),
    });
    rules.values = { a1: active };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(true);
    // Regardless of the toggle.
    vacations.values = { a1: vacation({ isEnabled: true }) };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(true);
    rules.values = { a1: { ...active, model: { ...active.model, rules: [{ ...active.model.rules[0]!, on: false }] } } };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(false);
    rules.values = {
      a1: { ...active, model: { forward: { on: true, to: 'me@private.example', keep: true }, rules: [] } },
    };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(true);
    rules.values = { a1: 'unsupported' };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(false);
    rules.values = { a1: new LoadFailed(new Error('broken')) };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(false);
    // No notice without vacation notice on the server or without loaded rules.
    rules.values = { a1: active };
    vacations.values = { a1: 'unsupported' };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(false);
    vacations.values = { a1: new LoadFailed(new Error('broken')) };
    expect(vacationValues(ACCOUNT, input)!.rlHint).toBe(false);
  });

  it('leads with "Go to rules" to the rules page of the account', () => {
    vacations.values = { a1: vacation() };
    vacationValues(ACCOUNT, input)!.goRules();
    expect(input.rules).toHaveBeenCalledExactlyOnceWith('a1');
    expect(input.connection).not.toHaveBeenCalled();
  });

  it('does not discard while saving', () => {
    vacations.values = { a1: vacation() };
    vacationValues(ACCOUNT, input)!.onToggle();
    vacations.saving.add('a1');
    const v = vacationValues(ACCOUNT, input)!;
    expect(v.saving).toBe(true);
    v.discard();
    v.onToggle();
    expect(vacationValues(ACCOUNT, input)).toMatchObject({ dirty: true, on: true });
    vacations.saving.delete('a1');
    vacationValues(ACCOUNT, input)!.discard();
    expect(vacationValues(ACCOUNT, input)!.dirty).toBe(false);
  });
});

describe('jmapVacationApi', () => {
  function session(vacation = true): Session {
    const caps = vacation ? { [MAIL]: {}, [VACATION]: {} } : { [MAIL]: {} };
    return {
      capabilities: caps,
      accounts: { c: { name: 'account1@s1.test', isPersonal: true, isReadOnly: false, accountCapabilities: caps } },
      primaryAccounts: { [MAIL]: 'c' },
    } as unknown as Session;
  }

  function client(setResponse: Record<string, unknown>, list: VacationResponse[], vacation = true) {
    const calls: [string, unknown][] = [];
    const c = {
      session: () => Promise.resolve(session(vacation)),
      accountId: () => Promise.resolve('c'),
      call: (name: string, args: unknown) => {
        calls.push([name, args]);
        return Promise.resolve({ list });
      },
      batch: () => ({
        call: (name: string, args: unknown) => {
          calls.push([name, args]);
          return name;
        },
        send: () =>
          Promise.resolve({ get: (call: string) => (call === 'VacationResponse/set' ? setResponse : { list }) }),
      }),
    };
    return { calls, client: () => Promise.resolve(c as unknown as JmapClient) };
  }

  it('reads and changes the object singleton', async () => {
    const { calls, client: c } = client({ updated: { singleton: null } }, [vacation({ isEnabled: true })]);
    expect(await jmapVacationApi(c).get('a1')).toMatchObject({ isEnabled: true });
    expect(await jmapVacationApi(c).set('a1', { isEnabled: true })).toMatchObject({ isEnabled: true });
    expect(calls).toEqual([
      ['VacationResponse/get', { accountId: 'c', ids: ['singleton'] }],
      ['VacationResponse/set', { accountId: 'c', update: { singleton: { isEnabled: true } } }],
      ['VacationResponse/get', { accountId: 'c', ids: ['singleton'] }],
    ]);
  });

  it('does not ask without urn:ietf:params:jmap:vacationresponse and returns null', async () => {
    const { calls, client: c } = client({}, [vacation()], false);
    expect(await jmapVacationApi(c).get('a1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('throws without singleton and on notUpdated', async () => {
    const { client: empty } = client({}, []);
    await expect(jmapVacationApi(empty).get('a1')).rejects.toThrow('singleton');
    const { client: c } = client({ notUpdated: { singleton: { type: 'invalidProperties' } } }, [vacation()]);
    await expect(jmapVacationApi(c).set('a1', { isEnabled: true })).rejects.toBeInstanceOf(VacationRefused);
  });
});

describe('Vacation notice and rules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ON = vacation({ isEnabled: true, subject: 'Out of office', textBody: 'Away' });

  it('re-enables the rules after switching off', async () => {
    const resume = vi.spyOn(rules, 'resume').mockResolvedValue();
    const s = new Vacations(fakeApi(ON), () => TZ);
    await s.load('a1');
    s.set('a1', { on: false });
    await s.save();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith('a1');
  });

  it('leaves the rules alone when switching on and on changes without switching off', async () => {
    const resume = vi.spyOn(rules, 'resume').mockResolvedValue();
    const s = new Vacations(fakeApi(vacation({ subject: 'Out of office', textBody: 'Away' })), () => TZ);
    await s.load('a1');
    s.set('a1', { on: true });
    await s.save();
    s.set('a1', { subject: 'Vacation' });
    await s.save();
    const off = new Vacations(fakeApi(vacation({ subject: 'Out of office' })), () => TZ);
    await off.load('a1');
    off.set('a1', { subject: 'Vacation' });
    await off.save();
    expect(resume).not.toHaveBeenCalled();
  });

  it('tells the rules about switching on so that a loaded state is reloaded', async () => {
    const refresh = vi.spyOn(rules, 'refresh').mockReturnValue();
    const s = new Vacations(fakeApi(vacation({ subject: 'Out of office', textBody: 'Away' })), () => TZ);
    await s.load('a1');
    s.set('a1', { subject: 'Vacation' });
    await s.save();
    expect(refresh).not.toHaveBeenCalled();
    s.set('a1', { on: true });
    await s.save();
    expect(refresh).toHaveBeenCalledExactlyOnceWith('a1');
  });

  it('leaves the rules alone if switching off fails or the server keeps them on', async () => {
    const resume = vi.spyOn(rules, 'resume').mockResolvedValue();
    const failing = fakeApi(ON);
    failing.set.mockRejectedValueOnce(new Error('broken'));
    const s = new Vacations(failing, () => TZ);
    await s.load('a1');
    s.set('a1', { on: false });
    await s.save();
    const ignoring = fakeApi(ON);
    ignoring.set.mockResolvedValueOnce(ON);
    const t = new Vacations(ignoring, () => TZ);
    await t.load('a1');
    t.set('a1', { on: false });
    await t.save();
    expect(resume).not.toHaveBeenCalled();
  });
});
