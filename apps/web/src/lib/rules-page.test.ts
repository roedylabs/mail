import type { Mailbox } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { LoadFailed, loadFailureOf } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { rules, type RuleError, type RulesApi, type RulesLoaded, type ScriptStatus } from '#lib/rules.svelte.ts';
import { EMPTY_RULES, sieveScript, type Forward, type Rule, type RuleSet } from '#lib/sieve/generate.ts';
import { sieveTargets } from '#lib/sieve/targets.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { tags, type Tag } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { UNDO_MS } from '#lib/undo.ts';
import {
  redirectText,
  ruleEditorValues,
  RulesPage,
  ruleSummary,
  rulesValues,
  type RulesInput,
} from './rules-page.svelte.ts';

/** Fake API of the `rules` singleton the page uses. */
const api = vi.hoisted(() => ({
  load: vi.fn<RulesApi['load']>(),
  save: vi.fn<RulesApi['save']>(),
  activate: vi.fn<RulesApi['activate']>(),
}));

vi.mock('#lib/rules.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/rules.svelte.ts')>();
  return { ...mod, rules: new mod.Rules(api) };
});

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

const OTHER: MailAccount = { ...ACCOUNT, id: 'a2' };

function box(id: string, name: string, overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    ...overrides,
  };
}

/** Folder targets: Archive, below it 2026, then Projects; inbox and "Tags" do not count. */
const BOXES = [
  box('in', 'Inbox', { role: 'inbox' }),
  box('m1', 'Archive', { sortOrder: 1 }),
  box('m2', '2026', { parentId: 'm1' }),
  box('m3', 'Projects', { sortOrder: 2 }),
  box('tg', 'Tags', { sortOrder: 3 }),
  box('tw', 'Important', { parentId: 'tg' }),
];

function tag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name, parent_id: null, color: null, position: 0, links: [], created_at: '', ...overrides };
}

const TAGS = [tag('t1', 'Important'), tag('t2', 'Customer', { parent_id: 't1' })];

const STATUS: ScriptStatus = { scriptId: 's1', active: 'ours', activeName: null, maxRedirects: 1, maxSize: null };

function loaded(model: RuleSet, overrides: Partial<RulesLoaded> = {}): RulesLoaded {
  return { ...STATUS, model, damaged: false, ...overrides };
}

function rule(id: string, name: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    name,
    on: true,
    match: 'all',
    conds: [['from', 'boss@example.com']],
    acts: [['read', '']],
    ...overrides,
  };
}

const OFF: Forward = { on: false, to: '', keep: true };
const ON: Forward = { on: true, to: 'me@private.example', keep: true };

function ruleSet(list: Rule[] = [], forward: Forward = OFF): RuleSet {
  return { forward, rules: list };
}

const ABC = ruleSet([rule('r0', 'A'), rule('r1', 'B'), rule('r2', 'C')]);

const input = {
  connection: vi.fn<(id: string) => void>(),
  vacation: vi.fn<(id: string) => void>(),
} satisfies RulesInput;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets running promise chains continue. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Page for a1 with a loaded state. */
async function setup(model: RuleSet = ABC, overrides: Partial<RulesLoaded> = {}): Promise<RulesPage> {
  api.load.mockResolvedValue(loaded(model, overrides));
  const p = new RulesPage();
  p.open('a1');
  await rules.load('a1');
  return p;
}

/** Saved model of the `i`-th call. */
const saved = (i = 0) => api.save.mock.calls[i]?.[1];
const ids = (set: RuleSet | null | undefined) => set?.rules.map((r) => r.id);
const values = (p: RulesPage, a = ACCOUNT) => rulesValues(p, a, input)!;
const editor = (p: RulesPage) => ruleEditorValues(p, ACCOUNT)!;

let boxList: MockInstance<(typeof mailboxes)['list']>;
let boxEnsure: MockInstance<(typeof mailboxes)['ensure']>;
let tagEnsure: MockInstance<(typeof tags)['ensure']>;

beforeEach(() => {
  api.load.mockReset().mockResolvedValue(loaded(EMPTY_RULES));
  api.save.mockReset().mockResolvedValue(STATUS);
  api.activate.mockReset().mockResolvedValue(STATUS);
  input.connection.mockReset();
  input.vacation.mockReset();
  boxEnsure = vi.spyOn(mailboxes, 'ensure').mockResolvedValue();
  boxList = vi.spyOn(mailboxes, 'list').mockImplementation((account) => (account === 'a1' ? BOXES : []));
  tagEnsure = vi.spyOn(tags, 'ensure').mockResolvedValue();
  vi.spyOn(tags, 'list', 'get').mockReturnValue(TAGS);
});

afterEach(() => {
  rules.reset();
  ui.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RulesPage', () => {
  it('loads rules, folders and tags on opening and discards editor and draft on an account switch', async () => {
    const p = await setup();
    expect(api.load).toHaveBeenCalledWith('a1');
    expect(boxEnsure).toHaveBeenCalledWith('a1');
    expect(tagEnsure).toHaveBeenCalled();
    p.add();
    p.setForwardTo('kaputt');
    p.toggleForward();
    p.activating = true;
    // The same account keeps everything.
    p.open('a1');
    expect(p.editor).not.toBeNull();
    expect([p.account, p.fwdTo, p.fwdErr, p.activating]).toEqual(['a1', 'kaputt', true, true]);
    p.open('a2');
    expect(api.load).toHaveBeenCalledWith('a2');
    expect(boxEnsure).toHaveBeenCalledWith('a2');
    expect([p.account, p.editor, p.fwdTo, p.fwdErr, p.activating]).toEqual(['a2', null, null, false, false]);
  });

  it('discards editor and draft when leaving', async () => {
    const p = await setup();
    p.add();
    p.setForwardTo('kaputt');
    p.toggleForward();
    p.close();
    expect([p.account, p.editor, p.fwdTo, p.fwdErr]).toEqual([null, null, null, false]);
    // Without an account nothing changes the model.
    p.toggleForward();
    p.toggleKeep();
    p.toggleRule('r0');
    p.move('r1', -1);
    p.add();
    p.activate();
    await settle();
    expect(p.editor).toBeNull();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it('requires a valid target address to turn on forwarding', async () => {
    const p = await setup();
    p.toggleForward();
    expect(p.fwdErr).toBe(true);
    expect(values(p).fwdErr).toBe(m.rules_forward_need_address());
    // The error does not show at the other account.
    expect(rulesValues(p, OTHER, input)).toBeNull();
    p.setForwardTo('kaputt');
    expect(p.fwdErr).toBe(false);
    expect(values(p).fwdErr).toBe('');
    values(p).toggleFwd();
    expect(p.fwdErr).toBe(true);
    await settle();
    expect(api.save).not.toHaveBeenCalled();
    expect(rules.model('a1')?.forward).toEqual(OFF);
    expect(ui.toast).toBeNull();
  });

  it('turns forwarding on and off, the toast comes only after saving', async () => {
    const p = await setup();
    const save = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => save.promise);
    p.setForwardTo(' me@private.example ');
    p.toggleForward();
    expect(p.fwdTo).toBeNull();
    expect(p.fwdErr).toBe(false);
    expect(rules.model('a1')?.forward).toEqual(ON);
    expect(values(p)).toMatchObject({ fwdOn: true, fwdTo: 'me@private.example', fwdKeep: true });
    await settle();
    expect(ui.toast).toBeNull();
    save.resolve(STATUS);
    await settle();
    expect(saved()?.forward).toEqual(ON);
    expect(ui.toast).toMatchObject({ text: m.rules_forward_on_toast({ to: 'me@private.example' }), error: false });
    p.toggleForward();
    await settle();
    // The address stays for the next turn-on.
    expect(saved(1)?.forward).toEqual({ ...ON, on: false });
    expect(ui.toast?.text).toBe(m.rules_forward_off_toast());
    expect(values(p)).toMatchObject({ fwdOn: false, fwdTo: 'me@private.example', fwdSum: m.rules_forward_off() });
  });

  it('shows only the error after a failed save, not the success', async () => {
    const p = await setup();
    api.save.mockRejectedValueOnce(new Error('kaputt'));
    p.setForwardTo('me@private.example');
    p.toggleForward();
    await settle();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    expect(rules.model('a1')?.forward).toEqual(OFF);
  });

  it('keeps a target address as a draft with forwarding turned off', async () => {
    const p = await setup();
    // Nothing without input.
    p.commitForwardTo();
    p.setForwardTo('new@private.example');
    values(p).onFwdCommit();
    expect(p.fwdTo).toBe('new@private.example');
    expect(values(p).fwdTo).toBe('new@private.example');
    await settle();
    expect(api.save).not.toHaveBeenCalled();
    // Turning on takes the draft.
    p.toggleForward();
    expect(rules.model('a1')?.forward).toEqual({ ...ON, to: 'new@private.example' });
  });

  it('takes a new address with forwarding turned on, an invalid one stays a draft with a message', async () => {
    const p = await setup(ruleSet([], { ...ON, keep: false }));
    expect(values(p).fwdSum).toBe(m.rules_forward_sum_nokeep({ to: 'me@private.example' }));
    // The same address: nothing to save.
    p.setForwardTo(' me@private.example ');
    p.commitForwardTo();
    expect(p.fwdTo).toBeNull();
    await settle();
    expect(api.save).not.toHaveBeenCalled();

    values(p).onFwdTo('new@private.example');
    expect(values(p).fwdTo).toBe('new@private.example');
    // Until leaving the field the saved address applies.
    expect(values(p).fwdSum).toBe(m.rules_forward_sum_nokeep({ to: 'me@private.example' }));
    p.commitForwardTo();
    expect(p.fwdTo).toBeNull();
    await settle();
    expect(saved()?.forward).toEqual({ on: true, to: 'new@private.example', keep: false });
    expect(ui.toast?.text).toBe(m.rules_forward_on_toast({ to: 'new@private.example' }));

    // Invalid: nothing saved, the previous address keeps applying, the field reports the error.
    p.setForwardTo('kaputt');
    p.commitForwardTo();
    await settle();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(values(p)).toMatchObject({
      fwdOn: true,
      fwdTo: 'kaputt',
      fwdErr: m.rules_forward_need_address(),
      fwdSum: m.rules_forward_sum_nokeep({ to: 'new@private.example' }),
    });
    // The switch afterwards only turns off, without a second message.
    p.toggleForward();
    await settle();
    expect(saved(1)?.forward).toEqual({ on: false, to: 'kaputt', keep: false });
    expect(ui.toast?.text).toBe(m.rules_forward_off_toast());
    expect(values(p)).toMatchObject({ fwdOn: false, fwdTo: 'kaputt', fwdErr: '' });
  });

  it('toggles "Keep a copy in your mailbox" without a toast', async () => {
    const p = await setup(ruleSet([], ON));
    expect(values(p).fwdSum).toBe(m.rules_forward_sum_keep({ to: 'me@private.example' }));
    p.toggleKeep();
    await settle();
    expect(saved()?.forward).toEqual({ ...ON, keep: false });
    expect(ui.toast).toBeNull();
    values(p).toggleKeep();
    await settle();
    expect(saved(1)?.forward).toEqual(ON);
    expect(ui.toast).toBeNull();
  });

  it('leaves "Keep a copy in your mailbox" unchanged without forwarding', async () => {
    const p = await setup(ruleSet([], OFF));
    p.toggleKeep();
    await settle();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('toggles a rule without a toast', async () => {
    const p = await setup();
    values(p).rows[1]!.toggle();
    expect(values(p).rows.map((r) => r.on)).toEqual([true, false, true]);
    await settle();
    expect(saved()?.rules.map((r) => r.on)).toEqual([true, false, true]);
    expect(ui.toast).toBeNull();
  });

  it('swaps with the visible neighbouring rule when moving', async () => {
    const p = await setup();
    p.move('r0', -1);
    p.move('r2', 1);
    p.move('gone', 1);
    await settle();
    expect(api.save).not.toHaveBeenCalled();
    values(p).rows[0]!.down();
    expect(ids(rules.model('a1'))).toEqual(['r1', 'r0', 'r2']);
    await settle();
    expect(ids(saved())).toEqual(['r1', 'r0', 'r2']);
    // r0 waits for the end of the toast; "up" on r2 skips it.
    p.edit('r0');
    p.remove();
    const rows = values(p).rows;
    expect(rows.map(({ id, n, canUp, canDown }) => ({ id, n, canUp, canDown }))).toEqual([
      { id: 'r1', n: '1', canUp: false, canDown: true },
      { id: 'r2', n: '2', canUp: true, canDown: false },
    ]);
    rows[1]!.up();
    expect(ids(rules.model('a1'))).toEqual(['r2', 'r0', 'r1']);
    expect(ids(p.visible('a1'))).toEqual(['r2', 'r1']);
  });

  it('starts "Add rule" with sender and the first folder', async () => {
    const p = new RulesPage();
    p.add();
    expect(p.editor).toBeNull();
    const q = await setup();
    values(q).add();
    expect(q.editor).toEqual({
      id: null,
      on: true,
      name: '',
      match: 'all',
      conds: [['from', '']],
      acts: [['move', 'm1']],
      err: null,
      pick: null,
    });
    boxList.mockReturnValue([]);
    q.add();
    expect(q.editor?.acts).toEqual([['move', '']]);
  });

  it('copies the rule when editing', async () => {
    const r = rule('r0', 'Boss', {
      on: false,
      match: 'any',
      conds: [
        ['from', 'a'],
        ['subj', 'b'],
      ],
      acts: [
        ['tag', 't1'],
        ['fwd', 'x@example.com'],
      ],
    });
    const p = await setup(ruleSet([r]));
    p.edit('gone');
    expect(p.editor).toBeNull();
    values(p).rows[0]!.edit();
    expect(p.editor).toEqual({
      id: 'r0',
      on: false,
      name: 'Boss',
      match: 'any',
      conds: r.conds,
      acts: r.acts,
      err: null,
      pick: null,
    });
    expect(p.editor!.conds).not.toBe(r.conds);
    expect(p.editor!.conds[0]).not.toBe(r.conds[0]);
    expect(p.editor!.acts[0]).not.toBe(r.acts[0]);
    p.setCondValue(0, 'new');
    p.setActValue(0, 't2');
    expect(rules.model('a1')?.rules[0]).toEqual(r);
    expect(values(p).ed).toBe(true);
    p.cancel();
    expect(p.editor).toBeNull();
    expect(values(p).ed).toBe(false);
  });

  it('changes the draft via the setters and clears the error', async () => {
    const p = await setup();
    // Without an editor without effect.
    p.setName('x');
    p.addCond();
    p.addAct();
    p.togglePick(0);
    p.save();
    expect(p.editor).toBeNull();

    p.add();
    p.save();
    expect(p.editor?.err).toBe('name');
    p.setName('Invoices');
    expect(p.editor).toMatchObject({ name: 'Invoices', err: null });
    p.setMatch('any');
    expect(p.editor?.match).toBe('any');

    p.addCond();
    expect(p.editor?.conds).toEqual([
      ['from', ''],
      ['subj', ''],
    ]);
    p.setCondValue(0, 'invoice@');
    p.setCondField(0, 'to');
    expect(p.editor?.conds[0]).toEqual(['to', 'invoice@']);
    p.setCondField(0, 'size');
    expect(p.editor?.conds[0]).toEqual(['size', '10']);
    p.setCondField(0, 'att');
    expect(p.editor?.conds[0]).toEqual(['att', '']);
    p.removeCond(0);
    expect(p.editor?.conds).toEqual([['subj', '']]);
    p.removeCond(0);
    expect(p.editor?.conds).toEqual([['subj', '']]);

    p.addAct();
    expect(p.editor?.acts).toEqual([
      ['move', 'm1'],
      ['read', ''],
    ]);
    p.setActKind(1, 'tag');
    expect(p.editor?.acts[1]).toEqual(['tag', 't1']);
    p.setActKind(1, 'fwd');
    expect(p.editor?.acts[1]).toEqual(['fwd', '']);
    p.setActValue(1, 'me@private.example');
    expect(p.editor?.acts[1]).toEqual(['fwd', 'me@private.example']);
    p.togglePick(0);
    expect(p.editor?.pick).toBe(0);
    p.togglePick(0);
    expect(p.editor?.pick).toBeNull();
    // Choosing a target closes the picker.
    p.togglePick(0);
    p.setActValue(0, 'm3');
    expect(p.editor).toMatchObject({ pick: null, acts: [['move', 'm3'], expect.anything()] as unknown });
    // A new kind starts with the first target and closes the picker.
    p.togglePick(0);
    p.setActKind(0, 'move');
    expect(p.editor?.acts[0]).toEqual(['move', 'm1']);
    expect(p.editor?.pick).toBeNull();
    p.togglePick(0);
    p.removeAct(1);
    expect(p.editor?.acts).toEqual([['move', 'm1']]);
    expect(p.editor?.pick).toBeNull();
    p.removeAct(0);
    expect(p.editor?.acts).toEqual([['move', 'm1']]);
    // A tag without tags stays empty.
    vi.spyOn(tags, 'list', 'get').mockReturnValue([]);
    p.setActKind(0, 'tag');
    expect(p.editor?.acts[0]).toEqual(['tag', '']);
  });

  it('reports every error of a rule with its text and does not save', async () => {
    const p = await setup();
    const cases: [(p: RulesPage) => void, RuleError, string][] = [
      [(e) => e.setName(' '), 'name', m.rules_err_name()],
      [(e) => e.setCondValue(0, ' '), 'value', m.rules_err_value()],
      [
        (e) => {
          e.setCondField(0, 'size');
          e.setCondValue(0, '0');
        },
        'size',
        m.rules_err_size(),
      ],
      [
        (e) => {
          e.setActKind(0, 'fwd');
          e.setActValue(0, 'kaputt');
        },
        'address',
        m.rules_err_address(),
      ],
      [(e) => e.setActValue(0, ''), 'target', m.rules_err_target()],
    ];
    for (const [change, error, text] of cases) {
      p.add();
      p.setName('Rule');
      p.setCondValue(0, 'invoice@');
      change(p);
      editor(p).save();
      expect(p.editor?.err).toBe(error);
      expect(editor(p).err).toBe(text);
    }
    await settle();
    expect(api.save).not.toHaveBeenCalled();
    expect(ui.toast).toBeNull();
  });

  it('saves a new rule trimmed and reports "Rule added" only after the response', async () => {
    const p = await setup(ruleSet([rule('r0', 'A')]));
    const save = deferred<ScriptStatus>();
    api.save.mockImplementationOnce(() => save.promise);
    p.add();
    p.setName(' Invoices ');
    p.setCondValue(0, ' invoice@ ');
    p.addAct();
    p.setActKind(1, 'fwd');
    p.setActValue(1, ' me@private.example ');
    p.save();
    expect(p.editor).toBeNull();
    const added = rules.model('a1')?.rules[1];
    expect(added).toEqual({
      id: expect.any(String) as string,
      name: 'Invoices',
      on: true,
      match: 'all',
      conds: [['from', 'invoice@']],
      acts: [
        ['move', 'm1'],
        ['fwd', 'me@private.example'],
      ],
    });
    expect(added?.id).not.toBe('r0');
    await settle();
    expect(ui.toast).toBeNull();
    save.resolve(STATUS);
    await settle();
    expect(saved()?.rules[1]).toEqual(added);
    expect(ui.toast).toMatchObject({ text: m.rules_added(), error: false });
    // Every new rule gets its own id.
    p.add();
    p.setName('Zweite');
    p.setCondValue(0, 'b');
    p.save();
    expect(new Set(ids(rules.model('a1'))).size).toBe(3);
  });

  it('saves an existing rule in its place with "Rule saved"', async () => {
    const p = await setup();
    p.edit('r1');
    p.setName('New');
    p.save();
    await settle();
    expect(saved()?.rules.map((r) => r.name)).toEqual(['A', 'New', 'C']);
    expect(ui.toast?.text).toBe(m.rules_saved());
    // If it is missing on the server by now, it goes to the end.
    p.edit('r0');
    api.load.mockResolvedValueOnce(loaded(ruleSet([rule('r2', 'C')])));
    await rules.load('a1');
    p.setName('A2');
    p.save();
    await settle();
    expect(saved(1)?.rules.map((r) => r.name)).toEqual(['C', 'A2']);
    expect(ui.toast?.text).toBe(m.rules_saved());
  });

  it('takes the switch of the list when saving in the editor, not the one from opening', async () => {
    const p = await setup();
    p.edit('r1');
    p.toggleRule('r1');
    await settle();
    expect(saved()?.rules.find((r) => r.id === 'r1')?.on).toBe(false);
    p.setName('New');
    p.save();
    await settle();
    expect(saved(1)?.rules.find((r) => r.id === 'r1')).toMatchObject({ name: 'New', on: false });
  });

  it('reports no success after a rejected save of a rule', async () => {
    const p = await setup();
    api.save.mockRejectedValueOnce(new Error('kaputt'));
    p.add();
    p.setName('X');
    p.setCondValue(0, 'a');
    p.save();
    await settle();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    expect(ids(rules.model('a1'))).toEqual(['r0', 'r1', 'r2']);
  });

  it('hides a deleted rule immediately, "Undo" brings it back', async () => {
    const p = await setup();
    // A new rule cannot be deleted.
    p.add();
    p.remove();
    expect(p.editor).not.toBeNull();
    expect(ui.toast).toBeNull();
    p.edit('r1');
    editor(p).del();
    expect(p.editor).toBeNull();
    expect(ids(p.visible('a1'))).toEqual(['r0', 'r2']);
    expect(ids(rules.model('a1'))).toEqual(['r0', 'r1', 'r2']);
    expect(values(p).rows.map((r) => r.n)).toEqual(['1', '2']);
    expect(ui.toast).toMatchObject({ text: m.rules_deleted(), undo: true });
    ui.toasts.undo();
    expect(ids(p.visible('a1'))).toEqual(['r0', 'r1', 'r2']);
    await settle();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('saves the deletion only after the toast expires', async () => {
    vi.useFakeTimers();
    const p = await setup();
    p.edit('r1');
    p.remove();
    await vi.advanceTimersByTimeAsync(UNDO_MS[prefs.values.gUndo] - 1);
    expect(api.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await ui.toasts.flush();
    expect(ids(saved())).toEqual(['r0', 'r2']);
    expect(p.hidden.size).toBe(0);
    expect(ids(p.visible('a1'))).toEqual(['r0', 'r2']);
    expect(ui.toast).toBeNull();
  });

  it('brings the rule back if the deletion fails', async () => {
    const p = await setup();
    api.save.mockRejectedValueOnce(new Error('kaputt'));
    p.edit('r1');
    p.remove();
    await ui.toasts.flush();
    expect(p.hidden.size).toBe(0);
    expect(ids(p.visible('a1'))).toEqual(['r0', 'r1', 'r2']);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });

  it('turns the rules on, with a spinner and a toast after success', async () => {
    const p = await setup(ABC, { active: 'foreign', activeName: 'Mein Filter' });
    const run = deferred<ScriptStatus>();
    api.activate.mockImplementationOnce(() => run.promise);
    values(p).note!.fn();
    expect(p.activating).toBe(true);
    expect(values(p).note).toMatchObject({ busy: true, act: m.rules_on_busy() });
    // A second click starts nothing.
    p.activate();
    await settle();
    expect(api.activate).toHaveBeenCalledExactlyOnceWith('a1', true);
    expect(ui.toast).toBeNull();
    run.resolve(STATUS);
    await settle();
    expect(p.activating).toBe(false);
    expect(ui.toast).toMatchObject({ text: m.rules_on_done(), error: false });
    expect(values(p)).toMatchObject({ st: 'ours', note: null, notes: false });
  });

  it('reports no success if our own script does not become active', async () => {
    const p = await setup(ABC, { active: 'none' });
    api.activate.mockResolvedValueOnce({ ...STATUS, active: 'vacation', activeName: 'vacation' });
    p.activate();
    await settle();
    expect(p.activating).toBe(false);
    expect(ui.toast).toBeNull();
    expect(values(p).st).toBe('vacation');
  });

  it('expands and collapses the Sieve script', async () => {
    const p = await setup();
    expect(values(p)).toMatchObject({ sieveOpen: false, sieveLabel: m.rules_sieve_show() });
    values(p).toggleSieve();
    expect(values(p)).toMatchObject({ sieveOpen: true, sieveLabel: m.rules_sieve_hide() });
    p.toggleSieve();
    expect(values(p).sieveOpen).toBe(false);
  });
});

describe('rulesValues', () => {
  it('is null before loading', () => {
    expect(rulesValues(new RulesPage(), ACCOUNT, input)).toBeNull();
  });

  it('shows the card after a failed first load', async () => {
    const error = new ApiError(502, { error: 'check_failed', reason: 'throttled' });
    api.load.mockRejectedValueOnce(error);
    const p = new RulesPage();
    p.open('a1');
    await rules.load('a1');
    expect(rules.values.a1).toBeInstanceOf(LoadFailed);
    const v = values(p);
    expect(v).toMatchObject({
      loadTitle: m.rules_load_failed(),
      noSieve: false,
      sieveOk: false,
      st: null,
      notes: false,
      note: null,
      dmg: false,
      rows: [],
      empty: false,
      has: false,
      sieve: '',
    });
    expect(v.load).toMatchObject(loadFailureOf(error, 'mail.s1.test'));
    v.load!.goCon();
    expect(input.connection).toHaveBeenCalledWith('a1');
    v.load!.onRetry();
    expect(api.load).toHaveBeenCalledTimes(2);
    // Retrying shows the skeleton again.
    expect(rulesValues(p, ACCOUNT, input)).toBeNull();
    await rules.load('a1');
    expect(values(p).load).toBeNull();
  });

  it('shows the empty state without Sieve on the server', async () => {
    api.load.mockResolvedValue(null);
    const p = new RulesPage();
    p.open('a1');
    await rules.load('a1');
    expect(values(p)).toMatchObject({
      load: null,
      noSieve: true,
      noSieveText: m.rules_no_sieve_text({ host: 'mail.s1.test' }),
      sieveOk: false,
      st: null,
      notes: false,
      note: null,
      fwdOn: false,
      fwdSum: m.rules_forward_off(),
      redirWarn: false,
      rows: [],
      empty: false,
      has: false,
      sieve: '',
    });
  });

  describe('card per active script', () => {
    async function noteOf(model: RuleSet, overrides: Partial<RulesLoaded>) {
      rules.reset();
      const v = values(await setup(model, overrides));
      return { note: v.note, notes: v.notes, st: v.st };
    }
    const FOREIGN = { active: 'foreign', activeName: 'Mein Filter' } as const;

    it('shows no card for our own script', async () => {
      expect(await noteOf(ABC, {})).toEqual({ note: null, notes: false, st: 'ours' });
    });

    it('leads to the vacation notice while it runs, even without own content', async () => {
      for (const model of [ABC, EMPTY_RULES]) {
        const { note, notes } = await noteOf(model, { active: 'vacation', activeName: 'vacation' });
        expect(notes).toBe(true);
        expect(note).toMatchObject({
          kind: 'vacation',
          icon: 'ti-beach',
          warn: false,
          text: m.rules_note_vacation(),
          isGo: true,
          isOn: false,
          act: m.rules_note_vacation_go(),
          busy: false,
        });
        note!.fn();
        expect(input.vacation).toHaveBeenLastCalledWith('a1');
      }
      expect(api.activate).not.toHaveBeenCalled();
    });

    it('offers "Einschalten" for a foreign script only with own content', async () => {
      const own = await noteOf(ABC, FOREIGN);
      expect(own.note).toMatchObject({
        kind: 'foreign',
        icon: 'ti-file-code',
        warn: true,
        text: m.rules_note_foreign({ name: 'Mein Filter' }),
        isGo: false,
        isOn: true,
        act: m.rules_on(),
        busy: false,
      });
      expect(own.st).toBe('foreign');
      const empty = await noteOf(EMPTY_RULES, FOREIGN);
      expect(empty.note).toMatchObject({ kind: 'foreign', isOn: false, act: '' });
      // Forwarding alone counts as own content.
      expect((await noteOf(ruleSet([], ON), FOREIGN)).note).toMatchObject({ isOn: true, act: m.rules_on() });
    });

    it('reports without an active script only with own content', async () => {
      expect((await noteOf(ruleSet([], ON), { active: 'none' })).note).toMatchObject({
        kind: 'none',
        icon: 'ti-filter-pause',
        warn: true,
        text: m.rules_note_none(),
        isGo: false,
        isOn: true,
        act: m.rules_on(),
      });
      expect(await noteOf(EMPTY_RULES, { active: 'none' })).toEqual({ note: null, notes: false, st: 'none' });
    });
  });

  it('reports a damaged script', async () => {
    const p = await setup(EMPTY_RULES, { damaged: true });
    expect(values(p)).toMatchObject({ dmg: true, notes: true, dmgText: m.rules_damaged(), note: null, empty: true });
  });

  it('warns above maxRedirects, not with an open editor', async () => {
    const fwd = rule('r0', 'Forward', { acts: [['fwd', 'b@example.com']] });
    const p = await setup(ruleSet([fwd], ON));
    expect(values(p)).toMatchObject({ redirWarn: true, redirText: m.rules_redirect_once() });
    p.add();
    expect(values(p)).toMatchObject({ redirWarn: false, ed: true });
    p.cancel();
    // A single forwarding stays within the limit.
    p.toggleRule('r0');
    expect(values(p).redirWarn).toBe(false);

    rules.reset();
    const q = await setup(ruleSet([fwd], ON), { maxRedirects: 3 });
    expect(values(q)).toMatchObject({ redirWarn: false, redirText: m.rules_redirect_many({ n: 3 }) });
    rules.reset();
    const r = await setup(ruleSet([fwd], ON), { maxRedirects: null });
    expect(values(r)).toMatchObject({ redirWarn: false, redirText: '' });
  });

  it('lists the rules with summary and order', async () => {
    const list = [
      rule('r0', 'Boss', { acts: [['move', 'm2']] }),
      rule('r1', 'Customer', { on: false, acts: [['tag', 'gone']] }),
    ];
    const p = await setup(ruleSet(list));
    const v = values(p);
    const cond = m.rules_cond_from({ v: 'boss@example.com' });
    expect(
      v.rows.map(({ id, n, name, sum, on, canUp, canDown }) => ({ id, n, name, sum, on, canUp, canDown })),
    ).toEqual([
      {
        id: 'r0',
        n: '1',
        name: 'Boss',
        sum: m.rules_sum({ conds: cond, acts: m.rules_act_move({ name: '2026' }) }),
        on: true,
        canUp: false,
        canDown: true,
      },
      {
        id: 'r1',
        n: '2',
        name: 'Customer',
        // A target that no longer exists.
        sum: m.rules_sum({ conds: cond, acts: m.rules_act_tag({ name: '?' }) }),
        on: false,
        canUp: true,
        canDown: false,
      },
    ]);
    expect(v).toMatchObject({ empty: false, has: true, ed: false, sieveOk: true, st: 'ours' });
  });

  it('is empty without rules, even if the last one waits for deletion', async () => {
    expect(values(await setup(EMPTY_RULES))).toMatchObject({ rows: [], empty: true, has: false });
    rules.reset();
    const p = await setup(ruleSet([rule('r0', 'A')]));
    p.edit('r0');
    p.remove();
    expect(values(p)).toMatchObject({ rows: [], empty: true, has: false });
  });

  it('shows the Sieve script without the line with the model and copies it', async () => {
    const p = await setup(ruleSet([rule('r0', 'Boss'), rule('r1', 'Paused', { on: false })], ON));
    // Collapsed, the script is not built (only when copying).
    expect(values(p).sieve).toBe('');
    p.toggleSieve();
    const v = values(p);
    expect(v.sieve).toBe(sieveScript(rules.model('a1')!, sieveTargets('a1', BOXES, TAGS)));
    expect(v.sieve).toContain('redirect :copy "me@private.example";');
    expect(v.sieve).toContain('# Boss');
    expect(v.sieve).not.toContain('# Paused');
    expect(v.sieve).not.toContain('roedy-mail-rules');

    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    v.copySieve();
    await settle();
    expect(writeText).toHaveBeenCalledWith(v.sieve);
    expect(ui.toast).toMatchObject({ text: m.rules_sieve_copied(), error: false });

    ui.reset();
    writeText.mockRejectedValueOnce(new Error('forbidden'));
    v.copySieve();
    await settle();
    expect(ui.toast).toBeNull();

    // A rule waiting for deletion is not in the script.
    p.edit('r0');
    p.remove();
    expect(values(p).sieve).not.toContain('# Boss');
  });
});

describe('ruleEditorValues', () => {
  it('is null without an editor or for another account', async () => {
    const p = await setup();
    expect(ruleEditorValues(p, ACCOUNT)).toBeNull();
    p.add();
    expect(ruleEditorValues(p, OTHER)).toBeNull();
    expect(ruleEditorValues(p, ACCOUNT)).not.toBeNull();
  });

  it('names title, link and fields of the conditions', async () => {
    const p = await setup();
    p.add();
    let e = editor(p);
    expect(e).toMatchObject({ title: m.rules_new_title(), name: '', err: '', canDel: false });
    expect(e.conds[0]).toMatchObject({ canRm: false, lead: m.rules_lead_if() });
    expect(e.matchOpts.map(({ value, label, on }) => ({ value, label, on }))).toEqual([
      { value: 'all', label: m.rules_match_all(), on: true },
      { value: 'any', label: m.rules_match_any(), on: false },
    ]);
    e.matchOpts[1]!.onClick();
    e.onName('Invoices');
    for (let j = 0; j < 4; j++) editor(p).addC();
    p.setCondField(1, 'to');
    p.setCondField(3, 'size');
    p.setCondField(4, 'att');
    e = editor(p);
    expect(e.name).toBe('Invoices');
    expect(e.matchOpts.map((o) => o.on)).toEqual([false, true]);
    const or = m.rules_lead_or();
    expect(
      e.conds.map(({ f, v, hasV, hasUnit, ph, lead, canRm }) => ({ f, v, hasV, hasUnit, ph, lead, canRm })),
    ).toEqual([
      { f: 'from', v: '', hasV: true, hasUnit: false, ph: m.rules_ph_from(), lead: m.rules_lead_if(), canRm: true },
      { f: 'to', v: '', hasV: true, hasUnit: false, ph: m.rules_ph_to(), lead: or, canRm: true },
      { f: 'subj', v: '', hasV: true, hasUnit: false, ph: m.rules_ph_subj(), lead: or, canRm: true },
      { f: 'size', v: '10', hasV: true, hasUnit: true, ph: '10', lead: or, canRm: true },
      { f: 'att', v: '', hasV: false, hasUnit: false, ph: '', lead: or, canRm: true },
    ]);
    e.matchOpts[0]!.onClick();
    expect(editor(p).conds[1]!.lead).toBe(m.rules_lead_and());
    e.conds[0]!.onF('subj');
    e.conds[0]!.onV('Invoice');
    expect(p.editor?.conds[0]).toEqual(['subj', 'Invoice']);
    e.conds[4]!.rm();
    expect(p.editor?.conds).toHaveLength(4);
  });

  it('shows actions with folder and tag pickers', async () => {
    const p = await setup();
    p.add();
    for (const kind of ['tag', 'fwd', 'read', 'del'] as const) {
      editor(p).addA();
      p.setActKind(p.editor!.acts.length - 1, kind);
    }
    p.setActValue(2, 'me@private.example');
    editor(p).acts[1]!.pickToggle();
    const e = editor(p);
    const view = e.acts.map(({ a, v, isPick, isMail, pickOpen, pickLabel, pickIcon, lead, canRm }) => ({
      a,
      v,
      isPick,
      isMail,
      pickOpen,
      pickLabel,
      pickIcon,
      lead,
      canRm,
    }));
    const then = m.rules_lead_then();
    const and = m.rules_lead_and();
    expect(view).toEqual([
      {
        a: 'move',
        v: 'm1',
        isPick: true,
        isMail: false,
        pickOpen: false,
        pickLabel: 'Archive',
        pickIcon: 'ti-folder',
        lead: then,
        canRm: true,
      },
      {
        a: 'tag',
        v: 't1',
        isPick: true,
        isMail: false,
        pickOpen: true,
        pickLabel: 'Important',
        pickIcon: 'ti-tag',
        lead: and,
        canRm: true,
      },
      {
        a: 'fwd',
        v: 'me@private.example',
        isPick: false,
        isMail: true,
        pickOpen: false,
        pickLabel: '',
        pickIcon: 'ti-folder',
        lead: and,
        canRm: true,
      },
      {
        a: 'read',
        v: '',
        isPick: false,
        isMail: false,
        pickOpen: false,
        pickLabel: '',
        pickIcon: 'ti-folder',
        lead: and,
        canRm: true,
      },
      {
        a: 'del',
        v: '',
        isPick: false,
        isMail: false,
        pickOpen: false,
        pickLabel: '',
        pickIcon: 'ti-folder',
        lead: and,
        canRm: true,
      },
    ]);
    expect(e.acts[0]!.opts.map(({ id, label, depth, on }) => ({ id, label, depth, on }))).toEqual([
      { id: 'm1', label: 'Archive', depth: 0, on: true },
      { id: 'm2', label: '2026', depth: 1, on: false },
      { id: 'm3', label: 'Projects', depth: 0, on: false },
    ]);
    expect(e.acts[1]!.opts.map(({ id, label, depth, on }) => ({ id, label, depth, on }))).toEqual([
      { id: 't1', label: 'Important', depth: 0, on: true },
      { id: 't2', label: 'Customer', depth: 1, on: false },
    ]);
    expect(e.acts[2]!.opts).toEqual([]);

    e.acts[1]!.opts[1]!.onClick();
    expect(p.editor?.acts[1]).toEqual(['tag', 't2']);
    expect(p.editor?.pick).toBeNull();
    // A target that no longer exists.
    e.acts[0]!.onV('gone');
    expect(editor(p).acts[0]!.pickLabel).toBe('?');
    e.acts[0]!.onA('tag');
    expect(p.editor?.acts[0]).toEqual(['tag', 't1']);
    e.acts[4]!.rm();
    expect(p.editor?.acts.map(([a]) => a)).toEqual(['tag', 'tag', 'fwd', 'read']);
    // With one action none can be removed.
    p.add();
    expect(editor(p).acts[0]!.canRm).toBe(false);
  });

  it('gives the target picker the highlighted row for aria-activedescendant', async () => {
    const p = await setup();
    p.add();
    p.setActValue(0, 'm2');
    const pick = () => editor(p).acts[0]!;
    const key = (k: string) => pick().pickKey({ key: k, preventDefault: vi.fn() });
    // Closed, the chosen row; ↓ opens with it and then moves on.
    expect(pick().pickActive).toBe(1);
    key('ArrowDown');
    expect(pick()).toMatchObject({ pickOpen: true, pickActive: 1 });
    key('ArrowDown');
    expect(pick().pickActive).toBe(2);
    expect(pick().opts.map((o) => o.hi)).toEqual([false, false, true]);
  });

  it('runs the target picker via the shell menu, with arrows, Enter, space and Tab', async () => {
    const p = await setup();
    p.add();
    p.setActValue(0, 'm2');
    const pick = () => editor(p).acts[0]!;
    const hi = () => pick().opts.map((o) => o.hi);
    const key = (k: string) => {
      const event = { key: k, preventDefault: vi.fn() };
      pick().pickKey(event);
      return event;
    };
    expect(pick()).toMatchObject({ pickOpen: false, pickAria: 'Folder: 2026', pickTitle: 'Folder' });
    // Arrow down opens with the current target highlighted, then in a circle.
    expect(key('ArrowDown').preventDefault).toHaveBeenCalled();
    expect(ui.menu).toBe('rulepick');
    expect(pick().pickOpen).toBe(true);
    expect(hi()).toEqual([false, true, false]);
    key('ArrowDown');
    expect(hi()).toEqual([false, false, true]);
    key('ArrowDown');
    expect(hi()).toEqual([true, false, false]);
    key('ArrowUp');
    expect(hi()).toEqual([false, false, true]);
    // Enter chooses the highlighted target and closes.
    key('Enter');
    expect(p.editor?.acts[0]).toEqual(['move', 'm3']);
    expect(ui.menu).toBeNull();
    expect(pick()).toMatchObject({ pickOpen: false, pickAria: 'Folder: Projects' });
    expect(hi()).toEqual([false, false, false]);
    // Space: only on release, otherwise its click would open the list again.
    key('ArrowUp');
    key('ArrowUp');
    expect(key(' ').preventDefault).toHaveBeenCalled();
    expect(ui.menu).toBe('rulepick');
    pick().pickKeyUp({ key: ' ', preventDefault: vi.fn() });
    expect(p.editor?.acts[0]).toEqual(['move', 'm2']);
    expect(ui.menu).toBeNull();
    // Tab closes without a choice.
    key('ArrowDown');
    key('Tab');
    expect(ui.menu).toBeNull();
    expect(p.editor?.acts[0]).toEqual(['move', 'm2']);
    // Enter and space without an open list stay at the button (a click opens).
    expect(key('Enter').preventDefault).not.toHaveBeenCalled();
    expect(key(' ').preventDefault).not.toHaveBeenCalled();
    expect(ui.menu).toBeNull();
  });

  it('opens the target picker by click without a highlight; Escape, tapping outside, other menus and cancel close it', async () => {
    const p = await setup();
    p.add();
    p.addAct();
    p.setActKind(1, 'tag');
    const acts = () => editor(p).acts;
    expect(acts()[1]).toMatchObject({ pickAria: 'Tag: Important', pickTitle: 'Tag' });
    acts()[0]!.pickToggle();
    expect(ui.menu).toBe('rulepick');
    expect(acts().map((a) => a.pickOpen)).toEqual([true, false]);
    expect(acts()[0]!.opts.some((o) => o.hi)).toBe(false);
    // At most one picker open.
    acts()[1]!.pickToggle();
    expect(acts().map((a) => a.pickOpen)).toEqual([false, true]);
    // Escape or a click outside close via the layout (`ui.closeMenu()`); the editor stays.
    ui.closeMenu();
    expect(acts().map((a) => a.pickOpen)).toEqual([false, false]);
    expect(p.editor).not.toBeNull();
    // Own menu key: another picker of the shell (`pick`) does not reopen it.
    ui.menu = 'pick';
    expect(acts().map((a) => a.pickOpen)).toEqual([false, false]);
    ui.closeMenu();
    acts()[1]!.pickToggle();
    expect(acts()[1]!.pickOpen).toBe(true);
    acts()[1]!.pickToggle();
    expect(ui.menu).toBeNull();
    // Mobile: tapping outside.
    acts()[0]!.pickToggle();
    editor(p).pickClose();
    expect(ui.menu).toBeNull();
    expect(acts()[0]!.pickOpen).toBe(false);
    // Another menu closes the picker without applying it.
    acts()[0]!.pickToggle();
    ui.menu = 'bell';
    expect(acts()[0]!.pickOpen).toBe(false);
    p.hidePick();
    expect(ui.menu).toBe('bell');
    // Cancel closes the menu along with the editor.
    acts()[0]!.pickToggle();
    expect(ui.menu).toBe('rulepick');
    p.cancel();
    expect(ui.menu).toBeNull();
  });

  it('warns only with "Forward to" in the draft above the limit', async () => {
    const fwd = rule('r0', 'Forward', { acts: [['fwd', 'b@example.com']] });
    const p = await setup(ruleSet([fwd], ON));
    p.add();
    expect(editor(p)).toMatchObject({ redirWarn: false, redirText: m.rules_redirect_once() });
    p.setActKind(0, 'fwd');
    p.setActValue(0, 'c@example.com');
    expect(editor(p).redirWarn).toBe(true);
    p.cancel();
    p.toggleForward();
    // The edited rule counts only once.
    p.edit('r0');
    expect(editor(p).redirWarn).toBe(false);
    p.addAct();
    p.setActKind(1, 'fwd');
    expect(editor(p).redirWarn).toBe(true);
    // Without a limit no warning.
    rules.reset();
    const q = await setup(ruleSet([fwd], ON), { maxRedirects: null });
    q.edit('r0');
    expect(editor(q)).toMatchObject({ redirWarn: false, redirText: '' });
  });

  it('names errors and allows deleting only existing rules', async () => {
    const p = await setup();
    p.add();
    editor(p).save();
    expect(editor(p)).toMatchObject({ err: m.rules_err_name(), canDel: false });
    p.edit('r0');
    expect(editor(p)).toMatchObject({ title: m.rules_edit_title(), name: 'A', canDel: true, err: '' });
    editor(p).cancel();
    expect(p.editor).toBeNull();
    p.edit('r0');
    editor(p).del();
    expect(p.editor).toBeNull();
    expect(ui.toast?.text).toBe(m.rules_deleted());
  });
});

describe('ruleSummary', () => {
  it('summarizes conditions and actions, linked by "All conditions" or "Any condition"', () => {
    const label = vi.fn((kind: 'move' | 'tag', id: string) => `${kind}:${id}`);
    const r = rule('r0', 'X', {
      conds: [
        ['from', 'a'],
        ['to', 'b'],
        ['subj', 'c'],
        ['size', '5'],
        ['att', ''],
      ],
      acts: [
        ['move', 'm1'],
        ['tag', 't1'],
        ['read', ''],
        ['fwd', 'x@example.com'],
        ['del', ''],
      ],
    });
    const conds = [
      m.rules_cond_from({ v: 'a' }),
      m.rules_cond_to({ v: 'b' }),
      m.rules_cond_subj({ v: 'c' }),
      m.rules_cond_size({ v: '5' }),
      m.rules_cond_att(),
    ];
    const acts = [
      m.rules_act_move({ name: 'move:m1' }),
      m.rules_act_tag({ name: 'tag:t1' }),
      m.rules_act_read(),
      m.rules_act_fwd({ to: 'x@example.com' }),
      m.rules_act_del(),
    ].join(', ');
    expect(ruleSummary(r, label)).toBe(m.rules_sum({ conds: conds.join(` ${m.rules_lead_and()} `), acts }));
    expect(ruleSummary({ ...r, match: 'any' }, label)).toBe(
      m.rules_sum({ conds: conds.join(` ${m.rules_lead_or()} `), acts }),
    );
    expect(label.mock.calls.slice(0, 2)).toEqual([
      ['move', 'm1'],
      ['tag', 't1'],
    ]);
  });
});

describe('redirectText', () => {
  it('names the limit once or n times', () => {
    expect(redirectText(1)).toBe(m.rules_redirect_once());
    expect(redirectText(2)).toBe(m.rules_redirect_many({ n: 2 }));
  });
});
