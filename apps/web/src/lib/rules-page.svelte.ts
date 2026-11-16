/**
 * Mail account › Rules: values of the page and of the rule editor over the
 * state module `rules`. Every change applies immediately and is saved;
 * success toasts appear only after the response, `rules` reports rejections.
 * Deleting waits, as everywhere, for the end of the toast with "Undo".
 */
import { SvelteSet } from 'svelte/reactivity';
import { copyText } from '#lib/clipboard.svelte.ts';
import type { IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { LoadFailed, loadFailureOf, type LoadInput, type LoadValues } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { forwardError, ruleError, rules, type ActiveScript, type RuleError } from '#lib/rules.svelte.ts';
import {
  redirectCount,
  sieveScript,
  type Action,
  type ActionKind,
  type Cond,
  type CondField,
  type Rule,
  type RuleSet,
} from '#lib/sieve/generate.ts';
import { pickList } from '#lib/select.ts';
import { sieveTargets } from '#lib/sieve/targets.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import { folderTree, mailboxes, type FolderNode } from '#lib/state/mailboxes.svelte.ts';
import { tags, tagTree, type TagNode } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Draft of the rule editor. */
export interface RuleDraft {
  /** `null` = new rule. */
  id: string | null;
  on: boolean;
  name: string;
  match: 'all' | 'any';
  conds: Cond[];
  acts: Action[];
  err: RuleError | null;
  /**
   * Index of the action whose folder or tag picker is open; open only while
   * `ui.menu` is `rulepick`.
   */
  pick: number | null;
}

/** Target of a "Move" or "Add tag" action with depth in the tree. */
export interface RuleTarget {
  id: string;
  name: string;
  depth: number;
}

function flatten(nodes: readonly (FolderNode | TagNode)[], depth = 0, out: RuleTarget[] = []): RuleTarget[] {
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    flatten(n.children, depth + 1, out);
  }
  return out;
}

/** Folders of the account without the sidebar mailboxes and without "Tags". */
export function folderTargets(account: string): RuleTarget[] {
  return flatten(folderTree(mailboxes.list(account)));
}

/** Tags of the app. */
export function tagTargets(): RuleTarget[] {
  return flatten(tagTree(tags.list ?? []));
}

const hiddenKey = (account: string, id: string) => `${account}\n${id}`;

/** New id of a rule; it only lives in the script's model. */
function newId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

/** Page state besides the model: editor, draft of the target address, Sieve script, "Einschalten", deletion. */
export class RulesPage {
  /** Account of the page; a change discards editor and draft. */
  account = $state<string | null>(null);
  editor = $state<RuleDraft | null>(null);
  /** Target address of the forwarding while it is not saved; `null` = the model's. */
  fwdTo = $state<string | null>(null);
  /** "Please enter a valid forwarding address first." at the field. */
  fwdErr = $state(false);
  sieveOpen = $state(false);
  /** "Turn on" is running. */
  activating = $state(false);
  /** Rules whose deletion waits for the end of the toast (account and id). */
  hidden = new SvelteSet<string>();
  /** Highlighted target of the open picker ; `null` = none, the list shows only the chosen one. */
  pickHi = $state<number | null>(null);

  /** Open target picker (index of the action) or `null`. */
  get openPick(): number | null {
    return ui.menu === 'rulepick' ? (this.editor?.pick ?? null) : null;
  }

  /** Close the editor; the target picker with it. */
  #drop(): void {
    this.#closePick();
    this.editor = null;
  }

  /**
   * Close the target picker (`menu: null, selHi: null`); the focus stays on
   * the button. Escape and a click outside only close the menu (layout), then
   * `pick` stays but is no longer open.
   */
  #closePick(): void {
    this.pickHi = null;
    if (this.openPick !== null) ui.closeMenu();
    if (this.editor && this.editor.pick !== null) this.editor = { ...this.editor, pick: null };
  }

  /** Open the page or switch the account: load rules, folders and tags. */
  open(account: string): void {
    if (this.account !== account) {
      this.#drop();
      this.fwdTo = null;
      this.fwdErr = false;
      this.activating = false;
    }
    this.account = account;
    void rules.load(account);
    // Only for the target picker and the summary; if they are missing, the page shows "?", saving reports the error.
    mailboxes.ensure(account).catch(() => undefined);
    tags.ensure().catch(() => undefined);
  }

  /** Leaving the page: discard editor and draft (a deletion with undo keeps running). */
  close(): void {
    this.account = null;
    this.#drop();
    this.fwdTo = null;
    this.fwdErr = false;
  }

  /** Displayed model: without rules whose deletion is still pending. */
  visible(account: string): RuleSet | null {
    const model = rules.model(account);
    if (!model || this.hidden.size === 0) return model;
    const left = model.rules.filter((r) => !this.hidden.has(hiddenKey(account, r.id)));
    return left.length === model.rules.length ? model : { ...model, rules: left };
  }

  #update(change: (model: RuleSet) => RuleSet, ok?: () => string): void {
    const account = this.account;
    if (!account) return;
    void rules.update(account, change).then((saved) => {
      if (saved && ok) ui.toasts.show(ok());
    });
  }

  // Forwarding

  /** "Alle Nachrichten weiterleiten" switch (`tgFwd`): turning on requires a valid address. */
  toggleForward(): void {
    const model = this.account ? rules.model(this.account) : null;
    if (!model) return;
    const f = model.forward;
    const to = (this.fwdTo ?? f.to).trim();
    if (!f.on && forwardError({ ...f, on: true, to })) {
      this.fwdErr = true;
      return;
    }
    this.fwdTo = null;
    this.fwdErr = false;
    const on = !f.on;
    this.#update(
      (s) => ({ ...s, forward: { ...s.forward, on, to } }),
      () => (on ? m.rules_forward_on_toast({ to }) : m.rules_forward_off_toast()),
    );
  }

  /** Input in the "Zieladresse" field (`onFwdTo`): stays a draft until `commitForwardTo` or turning on. */
  setForwardTo(value: string): void {
    this.fwdTo = value;
    this.fwdErr = false;
  }

  /**
   * Leaving the field or Enter (`change`): with forwarding turned on, the
   * new address applies. An invalid one stays a draft with the message at
   * the field, and the previous one keeps applying; forwarding is not turned
   * off, because a click on the switch right afterwards would first turn it
   * off (`change`) and then report the error. When turned off, the address stays a draft until turning on.
   */
  commitForwardTo(): void {
    const model = this.account ? rules.model(this.account) : null;
    if (!model || this.fwdTo === null || !model.forward.on) return;
    const to = this.fwdTo.trim();
    if (to === model.forward.to) {
      this.fwdTo = null;
      return;
    }
    if (forwardError({ ...model.forward, to })) {
      this.fwdErr = true;
      return;
    }
    this.fwdTo = null;
    this.#update(
      (s) => ({ ...s, forward: { ...s.forward, to } }),
      () => m.rules_forward_on_toast({ to }),
    );
  }

  /** "Keep a copy in your mailbox"; disabled without forwarding. */
  toggleKeep(): void {
    const model = this.account ? rules.model(this.account) : null;
    if (!model?.forward.on) return;
    this.#update((s) => ({ ...s, forward: { ...s.forward, keep: !s.forward.keep } }));
  }

  // List

  /** Switch of a rule. */
  toggleRule(id: string): void {
    this.#update((s) => ({ ...s, rules: s.rules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)) }));
  }

  /** Order (`up`, `down`): swaps with the visible neighbouring rule. */
  move(id: string, dir: -1 | 1): void {
    const account = this.account;
    const shown = account ? this.visible(account) : null;
    if (!shown) return;
    const i = shown.rules.findIndex((r) => r.id === id);
    const other = shown.rules[i + dir];
    if (i < 0 || !other) return;
    this.#update((s) => {
      const list = s.rules.slice();
      const a = list.findIndex((r) => r.id === id);
      const b = list.findIndex((r) => r.id === other.id);
      if (a < 0 || b < 0) return s;
      [list[a], list[b]] = [list[b] as Rule, list[a] as Rule];
      return { ...s, rules: list };
    });
  }

  // Editor

  /** "Add rule": sender contains …, move to the first folder. */
  add(): void {
    if (!this.account) return;
    this.editor = {
      id: null,
      on: true,
      name: '',
      match: 'all',
      conds: [['from', '']],
      acts: [['move', this.#defaultValue('move')]],
      err: null,
      pick: null,
    };
  }

  /** "Bearbeiten" on a rule. */
  edit(id: string): void {
    const rule = this.account ? rules.model(this.account)?.rules.find((r) => r.id === id) : undefined;
    if (!rule) return;
    this.editor = {
      id: rule.id,
      on: rule.on,
      name: rule.name,
      match: rule.match,
      conds: rule.conds.map(([f, v]) => [f, v]),
      acts: rule.acts.map(([a, v]) => [a, v]),
      err: null,
      pick: null,
    };
  }

  cancel(): void {
    this.#drop();
  }

  #defaultValue(kind: ActionKind): string {
    if (kind === 'move') return (this.account ? folderTargets(this.account)[0]?.id : undefined) ?? '';
    if (kind === 'tag') return tagTargets()[0]?.id ?? '';
    return '';
  }

  #edit(patch: Partial<RuleDraft>): void {
    if (this.editor) this.editor = { ...this.editor, ...patch, err: null };
  }

  setName(value: string): void {
    this.#edit({ name: value });
  }

  setMatch(match: 'all' | 'any'): void {
    this.#edit({ match });
  }

  /** Field of a condition: size starts at 10 MB, "hat Anhang" without a value, otherwise the value stays. */
  setCondField(j: number, field: CondField): void {
    const e = this.editor;
    if (!e) return;
    this.#edit({
      conds: e.conds.map((c, k) => (k === j ? [field, field === 'size' ? '10' : field === 'att' ? '' : c[1]] : c)),
    });
  }

  setCondValue(j: number, value: string): void {
    const e = this.editor;
    if (e) this.#edit({ conds: e.conds.map((c, k) => (k === j ? [c[0], value] : c)) });
  }

  addCond(): void {
    if (this.editor) this.#edit({ conds: [...this.editor.conds, ['subj', '']] });
  }

  removeCond(j: number): void {
    const e = this.editor;
    if (e && e.conds.length > 1) this.#edit({ conds: e.conds.filter((_, k) => k !== j) });
  }

  /** Kind of an action: folder and tag start with the first target. */
  setActKind(j: number, kind: ActionKind): void {
    const e = this.editor;
    if (!e) return;
    this.#closePick();
    this.#edit({ acts: e.acts.map((a, k) => (k === j ? [kind, this.#defaultValue(kind)] : a)), pick: null });
  }

  /** Value of an action: address or (from the picker) target; closes the picker. */
  setActValue(j: number, value: string): void {
    const e = this.editor;
    if (!e) return;
    this.#closePick();
    this.#edit({ acts: e.acts.map((a, k) => (k === j ? [a[0], value] : a)), pick: null });
  }

  /**
   * Open or close the folder or tag picker of an action: via
   * the shell menu (`ui.menu` `rulepick`), so that Escape and a click outside
   * close it and at most one menu is open.
   */
  togglePick(j: number): void {
    if (!this.editor) return;
    if (this.openPick === j) this.#closePick();
    else this.showPick(j);
  }

  /** Open the picker of an action without a highlight. */
  showPick(j: number): void {
    if (!this.editor) return;
    this.pickHi = null;
    this.#edit({ pick: j });
    ui.menu = 'rulepick';
  }

  /** Close the open picker (Tab, click outside). */
  hidePick(): void {
    this.#closePick();
  }

  /** Highlight a target (`selHi`, arrow keys). */
  markPick(i: number | null): void {
    this.pickHi = i;
  }

  addAct(): void {
    if (this.editor) this.#edit({ acts: [...this.editor.acts, ['read', '']] });
  }

  removeAct(j: number): void {
    const e = this.editor;
    if (!e || e.acts.length <= 1) return;
    this.#closePick();
    this.#edit({ acts: e.acts.filter((_, k) => k !== j), pick: null });
  }

  /** "Speichern" (`rSave`): check, then apply and save; toast after the response. */
  save(): void {
    const e = this.editor;
    if (!e || !this.account) return;
    const err = ruleError(e);
    if (err) {
      this.editor = { ...e, err };
      return;
    }
    const rule: Rule = {
      id: e.id ?? newId(),
      name: e.name.trim(),
      on: e.on,
      match: e.match,
      conds: e.conds.map(([f, v]) => [f, v.trim()]),
      acts: e.acts.map(([a, v]) => [a, v.trim()]),
    };
    this.#drop();
    const known = e.id !== null;
    // Only the list operates the switch of an existing rule; it may have changed since opening.
    this.#update(
      (s) =>
        known && s.rules.some((r) => r.id === rule.id)
          ? { ...s, rules: s.rules.map((r) => (r.id === rule.id ? { ...rule, on: r.on } : r)) }
          : { ...s, rules: [...s.rules, rule] },
      () => (known ? m.rules_saved() : m.rules_added()),
    );
  }

  /** "Delete" in the editor: disappears immediately, saved after the toast (undo). */
  remove(): void {
    const e = this.editor;
    const account = this.account;
    if (!e?.id || !account) return;
    const id = e.id;
    const key = hiddenKey(account, id);
    this.#drop();
    this.hidden.add(key);
    ui.toasts.defer({
      text: m.rules_deleted(),
      revert: () => this.hidden.delete(key),
      // If saving fails, `rules` reports it and the rule comes back with the server state.
      commit: async () => {
        await rules.update(account, (s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) }));
        this.hidden.delete(key);
      },
    });
  }

  // Notices and script

  /** "Turn on": activate our own script, also instead of a foreign one. */
  activate(): void {
    const account = this.account;
    if (!account || this.activating) return;
    this.activating = true;
    void rules.activate(account).then((ok) => {
      if (this.account === account) this.activating = false;
      if (ok) ui.toasts.show(m.rules_on_done());
    });
  }

  toggleSieve(): void {
    this.sieveOpen = !this.sieveOpen;
  }
}

/** Limit of the forwardings (`RL_TXT.redir`). */
export function redirectText(max: number): string {
  return max === 1 ? m.rules_redirect_once() : m.rules_redirect_many({ n: max });
}

const COND_TEXT: Record<Exclude<CondField, 'att' | 'size'>, (v: { v: string }) => string> = {
  from: m.rules_cond_from,
  to: m.rules_cond_to,
  subj: m.rules_cond_subj,
};

/** Summary of a rule: "If … and …: …, …". */
export function ruleSummary(rule: Rule, label: (kind: 'move' | 'tag', id: string) => string): string {
  const conds = rule.conds.map(([f, v]) =>
    f === 'att' ? m.rules_cond_att() : f === 'size' ? m.rules_cond_size({ v }) : COND_TEXT[f]({ v }),
  );
  const acts = rule.acts.map(([a, v]) =>
    a === 'move'
      ? m.rules_act_move({ name: label('move', v) })
      : a === 'tag'
        ? m.rules_act_tag({ name: label('tag', v) })
        : a === 'read'
          ? m.rules_act_read()
          : a === 'fwd'
            ? m.rules_act_fwd({ to: v })
            : m.rules_act_del(),
  );
  const join = rule.match === 'any' ? m.rules_lead_or() : m.rules_lead_and();
  return m.rules_sum({ conds: conds.join(` ${join} `), acts: acts.join(', ') });
}

/** Card per active script. */
export interface RulesNote {
  kind: Exclude<ActiveScript, 'ours'>;
  icon: IconName;
  /** Icon in `--warn` (foreign and no script), otherwise `--mfg`. */
  warn: boolean;
  text: string;
  /** "Zur Abwesenheitsnotiz" button (`isGo`). */
  isGo: boolean;
  /** "Einschalten" button (`isOn`): only with own content. */
  isOn: boolean;
  /** Label of the button; empty without a button. */
  act: string;
  /** "Einschalten" is running: spinner, `aria-busy`. */
  busy: boolean;
  fn: () => void;
}

export interface RuleRow {
  id: string;
  /** Position from 1. */
  n: string;
  name: string;
  sum: string;
  on: boolean;
  canUp: boolean;
  canDown: boolean;
  toggle: () => void;
  up: () => void;
  down: () => void;
  edit: () => void;
}

/** Values of the page; `null` while nothing is loaded (skeleton). */
export interface RulesValues {
  /** First load failed: card (`MailLoadCard`) instead of the content; otherwise `null`. */
  load: LoadValues | null;
  loadTitle: string;
  /** Mail server without Sieve: empty state instead of forwarding and rules. */
  noSieve: boolean;
  noSieveText: string;
  sieveOk: boolean;
  st: ActiveScript | null;
  notes: boolean;
  note: RulesNote | null;
  dmg: boolean;
  dmgText: string;
  fwdOn: boolean;
  fwdTo: string;
  fwdKeep: boolean;
  fwdSum: string;
  fwdErr: string;
  onFwdTo: (value: string) => void;
  /** `change` of the field (leaving, Enter). */
  onFwdCommit: () => void;
  toggleFwd: () => void;
  toggleKeep: () => void;
  redirWarn: boolean;
  redirText: string;
  rows: RuleRow[];
  empty: boolean;
  has: boolean;
  /** Rule editor open; "Add rule" only without it. */
  ed: boolean;
  add: () => void;
  sieve: string;
  sieveOpen: boolean;
  sieveLabel: string;
  toggleSieve: () => void;
  copySieve: () => void;
}

/** Targets of the buttons on the page. */
export interface RulesInput extends LoadInput {
  /** Mail account › vacation notice of the account ("Zur Abwesenheitsnotiz"). */
  vacation: (id: string) => void;
}

function noteOf(
  p: RulesPage,
  account: string,
  st: ActiveScript,
  activeName: string | null,
  own: boolean,
  input: RulesInput,
): RulesNote | null {
  const busy = p.activating;
  const on = {
    isGo: false,
    isOn: own,
    busy,
    act: own ? (busy ? m.rules_on_busy() : m.rules_on()) : '',
    fn: () => p.activate(),
  };
  if (st === 'vacation') {
    return {
      kind: st,
      icon: 'ti-beach',
      warn: false,
      text: m.rules_note_vacation(),
      isGo: true,
      isOn: false,
      act: m.rules_note_vacation_go(),
      busy: false,
      fn: () => input.vacation(account),
    };
  }
  if (st === 'foreign') {
    return {
      kind: st,
      icon: 'ti-file-code',
      warn: true,
      text: m.rules_note_foreign({ name: activeName ?? '' }),
      ...on,
    };
  }
  if (st === 'none' && own) return { kind: st, icon: 'ti-filter-pause', warn: true, text: m.rules_note_none(), ...on };
  return null;
}

const NO_FORWARD = { on: false, to: '', keep: true };

/** Values of the page; `null` while nothing is loaded (skeleton). */
export function rulesValues(p: RulesPage, a: MailAccount, input: RulesInput): RulesValues | null {
  const account = a.id;
  const state = rules.values[account];
  if (state === undefined) return null;
  const loaded = rules.loaded(account);
  const model = p.visible(account);
  const full = rules.model(account);
  const f = model?.forward ?? NO_FORWARD;
  const list = model?.rules ?? [];
  const st = loaded?.active ?? null;
  const own = !!full && (full.rules.length > 0 || full.forward.on);
  const note = loaded && st ? noteOf(p, account, st, loaded.activeName, own, input) : null;
  const dmg = !!loaded?.damaged;
  const max = loaded?.maxRedirects ?? null;
  const editing = p.editor !== null && p.account === account;
  const folders = folderTargets(account);
  const tagList = tagTargets();
  const label = (kind: 'move' | 'tag', id: string) =>
    (kind === 'move' ? folders : tagList).find((t) => t.id === id)?.name ?? '?';
  const fwdTo = p.account === account && p.fwdTo !== null ? p.fwdTo : f.to;
  // Only when expanded or copying: otherwise the script would be rebuilt on every input in the editor.
  const script = () =>
    model ? sieveScript(model, sieveTargets(account, mailboxes.list(account), tags.list ?? [])) : '';
  return {
    load:
      state instanceof LoadFailed
        ? {
            ...loadFailureOf(state.error, a.host),
            onRetry: () => void rules.load(account),
            goCon: () => input.connection(account),
          }
        : null,
    loadTitle: m.rules_load_failed(),
    noSieve: state === 'unsupported',
    noSieveText: m.rules_no_sieve_text({ host: a.host }),
    sieveOk: !!loaded,
    st,
    notes: !!note || dmg,
    note,
    dmg,
    dmgText: m.rules_damaged(),
    fwdOn: f.on,
    fwdTo,
    fwdKeep: f.keep,
    fwdSum: f.on
      ? f.keep
        ? m.rules_forward_sum_keep({ to: f.to })
        : m.rules_forward_sum_nokeep({ to: f.to })
      : m.rules_forward_off(),
    fwdErr: p.account === account && p.fwdErr ? m.rules_forward_need_address() : '',
    onFwdTo: (v) => p.setForwardTo(v),
    onFwdCommit: () => p.commitForwardTo(),
    toggleFwd: () => p.toggleForward(),
    toggleKeep: () => p.toggleKeep(),
    redirWarn: !editing && max !== null && !!model && redirectCount(model) > max,
    redirText: max !== null ? redirectText(max) : '',
    rows: list.map((r, i) => ({
      id: r.id,
      n: String(i + 1),
      name: r.name,
      sum: ruleSummary(r, label),
      on: r.on,
      canUp: i > 0,
      canDown: i < list.length - 1,
      toggle: () => p.toggleRule(r.id),
      up: () => p.move(r.id, -1),
      down: () => p.move(r.id, 1),
      edit: () => p.edit(r.id),
    })),
    empty: !!loaded && list.length === 0,
    has: list.length > 0,
    ed: editing,
    add: () => p.add(),
    sieve: p.sieveOpen ? script() : '',
    sieveOpen: p.sieveOpen,
    sieveLabel: p.sieveOpen ? m.rules_sieve_hide() : m.rules_sieve_show(),
    toggleSieve: () => p.toggleSieve(),
    copySieve: () =>
      void copyText(script()).then((ok) => {
        if (ok) ui.toasts.show(m.rules_sieve_copied());
      }),
  };
}

export interface RuleCondValues {
  f: CondField;
  v: string;
  /** Value field (not for "hat Anhang"). */
  hasV: boolean;
  /** Size: number with "MB" after it. */
  hasUnit: boolean;
  ph: string;
  lead: string;
  canRm: boolean;
  onF: (field: CondField) => void;
  onV: (value: string) => void;
  rm: () => void;
}

export interface RuleTargetOption {
  id: string;
  label: string;
  depth: number;
  on: boolean;
  /** Highlighted by arrow key (`data-hi`, ring). */
  hi: boolean;
  onClick: () => void;
}

export interface RuleActValues {
  a: ActionKind;
  v: string;
  /** Folder or tag picker. */
  isPick: boolean;
  /** "Weiterleiten an" address field. */
  isMail: boolean;
  pickOpen: boolean;
  pickLabel: string;
  pickIcon: IconName;
  /** Name of the button: "Folder: ‹name›" or "Tag: ‹name›". */
  pickAria: string;
  /** Name of the list: "Folder" or "Tag". */
  pickTitle: string;
  pickToggle: () => void;
  /** Keys on the button: arrows open or move, Enter chooses, Tab closes (`keydown`). */
  pickKey: (event: KeyInput) => void;
  /** Space chooses on release (`keyup`). */
  pickKeyUp: (event: KeyInput) => void;
  /** Highlighted row of the open list, otherwise the chosen one (`aria-activedescendant`). */
  pickActive: number;
  opts: RuleTargetOption[];
  lead: string;
  canRm: boolean;
  onA: (kind: ActionKind) => void;
  onV: (value: string) => void;
  rm: () => void;
}

/** Values of the rule editor; `null` without an open editor. */
export interface RuleEditorValues {
  title: string;
  name: string;
  onName: (value: string) => void;
  matchOpts: { value: 'all' | 'any'; label: string; on: boolean; onClick: () => void }[];
  conds: RuleCondValues[];
  acts: RuleActValues[];
  addC: () => void;
  addA: () => void;
  /** The draft has "Forward to" and exceeds `maxNumberRedirects`. */
  redirWarn: boolean;
  redirText: string;
  err: string;
  save: () => void;
  cancel: () => void;
  canDel: boolean;
  del: () => void;
  /** Close the open target picker (on mobile tapping outside; on desktop the layout closes it). */
  pickClose: () => void;
}

const ERROR_TEXT: Record<RuleError, () => string> = {
  name: m.rules_err_name,
  value: m.rules_err_value,
  size: m.rules_err_size,
  address: m.rules_err_address,
  target: m.rules_err_target,
};

const PLACEHOLDER: Record<CondField, () => string> = {
  from: m.rules_ph_from,
  to: m.rules_ph_to,
  subj: m.rules_ph_subj,
  size: () => '10',
  att: () => '',
};

/** Values of the rule editor for the account of the page; `null` without an open editor. */
export function ruleEditorValues(p: RulesPage, a: MailAccount): RuleEditorValues | null {
  const e = p.editor;
  if (!e || p.account !== a.id) return null;
  const account = a.id;
  const folders = folderTargets(account);
  const tagList = tagTargets();
  const model = p.visible(account);
  const max = rules.loaded(account)?.maxRedirects ?? null;
  const draft: Rule = { id: e.id ?? '', name: e.name, on: e.on, match: e.match, conds: e.conds, acts: e.acts };
  const others = (model?.rules ?? []).filter((r) => r.id !== e.id);
  const withDraft: RuleSet = { forward: model?.forward ?? NO_FORWARD, rules: [...others, draft] };
  const hasFwd = e.acts.some(([k]) => k === 'fwd');
  return {
    title: e.id ? m.rules_edit_title() : m.rules_new_title(),
    name: e.name,
    onName: (v) => p.setName(v),
    matchOpts: (['all', 'any'] as const).map((value) => ({
      value,
      label: value === 'all' ? m.rules_match_all() : m.rules_match_any(),
      on: e.match === value,
      onClick: () => p.setMatch(value),
    })),
    conds: e.conds.map(([f, v], j) => ({
      f,
      v,
      hasV: f !== 'att',
      hasUnit: f === 'size',
      ph: PLACEHOLDER[f](),
      lead: j === 0 ? m.rules_lead_if() : e.match === 'any' ? m.rules_lead_or() : m.rules_lead_and(),
      canRm: e.conds.length > 1,
      onF: (field) => p.setCondField(j, field),
      onV: (value) => p.setCondValue(j, value),
      rm: () => p.removeCond(j),
    })),
    acts: e.acts.map(([kind, v], j) => {
      const pick = kind === 'move' || kind === 'tag';
      const targets = kind === 'move' ? folders : kind === 'tag' ? tagList : [];
      const open = pick && p.openPick === j;
      const label = pick ? (targets.find((t) => t.id === v)?.name ?? '?') : '';
      // Target picker like the other pickers of the shell: the focus stays on the button.
      const keys = pickList({
        opts: targets.map((t) => ({ v: t.id, l: t.name })),
        cur: v,
        open,
        hi: p.pickHi,
        disabled: !pick || targets.length === 0,
        mark: (i) => p.markPick(i),
        show: () => p.showPick(j),
        hide: () => p.hidePick(),
        choose: (id) => p.setActValue(j, id),
      });
      return {
        a: kind,
        v,
        isPick: pick,
        isMail: kind === 'fwd',
        pickOpen: open,
        pickLabel: label,
        pickIcon: kind === 'tag' ? 'ti-tag' : 'ti-folder',
        pickAria: kind === 'tag' ? m.rules_pick_tag_aria({ name: label }) : m.rules_pick_folder_aria({ name: label }),
        pickTitle: kind === 'tag' ? m.rules_pick_tag() : m.rules_pick_folder(),
        pickToggle: () => p.togglePick(j),
        pickKey: keys.onKey,
        pickKeyUp: keys.onKeyUp,
        pickActive: keys.active,
        opts: targets.map((t, i) => ({
          id: t.id,
          label: t.name,
          depth: t.depth,
          on: t.id === v,
          hi: open && p.pickHi === i,
          onClick: () => p.setActValue(j, t.id),
        })),
        lead: j === 0 ? m.rules_lead_then() : m.rules_lead_and(),
        canRm: e.acts.length > 1,
        onA: (next) => p.setActKind(j, next),
        onV: (value) => p.setActValue(j, value),
        rm: () => p.removeAct(j),
      };
    }),
    addC: () => p.addCond(),
    addA: () => p.addAct(),
    redirWarn: hasFwd && max !== null && redirectCount(withDraft) > max,
    redirText: max !== null ? redirectText(max) : '',
    err: e.err ? ERROR_TEXT[e.err]() : '',
    save: () => p.save(),
    cancel: () => p.cancel(),
    canDel: e.id !== null,
    del: () => p.remove(),
    pickClose: () => p.hidePick(),
  };
}
