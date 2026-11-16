/**
 * Rule model and Sieve script: generation of the script from the rules, plus
 * the comment line that carries the model in the script. Without imports so
 * that `scripts/dev/stalwart.mjs` can load the file directly (check "Sieve").
 */

/** Condition: sender, recipient, subject contains; larger than (MB); has attachment. */
export type CondField = 'from' | 'to' | 'subj' | 'size' | 'att';
/** Action: move (mailbox id), set tag (tag id), mark as read, forward (address), delete. */
export type ActionKind = 'move' | 'tag' | 'read' | 'fwd' | 'del';
export type Cond = [field: CondField, value: string];
export type Action = [kind: ActionKind, value: string];

/** A filter rule of an account. */
export interface Rule {
  id: string;
  name: string;
  on: boolean;
  match: 'all' | 'any';
  conds: Cond[];
  acts: Action[];
}

/** Forwarding of all messages of an account. */
export interface Forward {
  on: boolean;
  to: string;
  /** A copy stays in the mailbox (`redirect :copy`). */
  keep: boolean;
}

export interface RuleSet {
  forward: Forward;
  rules: Rule[];
}

/** Empty state; frozen because all accounts without rules share it. */
export const EMPTY_RULES: RuleSet = Object.freeze({
  forward: Object.freeze({ on: false, to: '', keep: true }),
  rules: Object.freeze<Rule[]>([]) as Rule[],
});

/** Name of the own script per account. */
export const SCRIPT_NAME = 'roedy-mail';
/** Name under which Stalwart keeps the vacation notice as a script. */
export const VACATION_SCRIPT = 'vacation';

const MARKER = '# roedy-mail-rules: ';
const VERSION = 1;
const REQUIRE = 'require ["fileinto", "imap4flags", "copy"];';
const HEADERS = { from: 'from', to: 'to', subj: 'subject' } as const;

/** Full paths of the targets in the account; `null` if the target no longer exists. */
export interface SieveTargets {
  folder(id: string): string | null;
  tag(id: string): string | null;
}

/** Sieve string in quotation marks (RFC 5228, 2.4.2). */
export function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Comment line; a line break would end the comment, so it becomes a space. */
function comment(text: string): string {
  return '# ' + text.replace(/[\r\n]+/g, ' ');
}

/** Size in MB (also with a comma); whole MB as such, otherwise in KB. Without a valid size `false`. */
export function sizeTest(value: string): string {
  const mb = Number.parseFloat(value.replace(',', '.'));
  // Sieve only knows digits (RFC 5228, 2.4.1); whatever does not fit as a whole number in KB would be `1e+21`.
  if (!(mb > 0) || !Number.isSafeInteger(Math.round(mb * 1024))) return 'false';
  return Number.isInteger(mb) ? `size :over ${mb}M` : `size :over ${Math.max(1, Math.round(mb * 1024))}K`;
}

function condTest([field, value]: Cond): string {
  if (field === 'att') return 'header :contains "Content-Type" "multipart/mixed"';
  if (field === 'size') return sizeTest(value);
  return `header :contains ${quote(HEADERS[field])} ${quote(value)}`;
}

/** Command of an action; `null` if its target is missing. */
function actionCommand([kind, value]: Action, targets: SieveTargets): string | null {
  switch (kind) {
    case 'move': {
      const path = targets.folder(value);
      return path === null ? null : `fileinto ${quote(path)};`;
    }
    case 'tag': {
      const path = targets.tag(value);
      return path === null ? null : `fileinto :copy ${quote(path)};`;
    }
    case 'read':
      return 'addflag "\\\\Seen";';
    case 'fwd':
      return `redirect :copy ${quote(value.trim())};`;
    case 'del':
      return 'discard;';
  }
}

function ruleBlock(rule: Rule, targets: SieveTargets): string {
  const tests = rule.conds.map(condTest);
  const test =
    tests.length > 1 ? `${rule.match === 'any' ? 'anyof' : 'allof'} (${tests.join(', ')})` : (tests[0] ?? 'true');
  const commands = rule.acts.map((a) => actionCommand(a, targets)).filter((c) => c !== null);
  const body = (commands.length ? commands : ['keep;']).map((c) => '  ' + c).join('\n');
  return `${comment(rule.name)}\nif ${test} {\n${body}\n}`;
}

/** Script like `rl.sieve`: forwarding, then the enabled rules in their order. */
export function sieveScript(set: RuleSet, targets: SieveTargets): string {
  const { forward } = set;
  // The page checks the trimmed address (`forwardError`), the field keeps it raw.
  const to = forward.to.trim();
  const parts = [
    ...(forward.on && to ? [`# Forwarding\nredirect${forward.keep ? ' :copy ' : ' '}${quote(to)};`] : []),
    ...set.rules.filter((r) => r.on).map((r) => ruleBlock(r, targets)),
  ];
  return `${REQUIRE}\n\n${parts.join('\n\n')}`;
}

/** Script as stored on the server: `sieveScript` and the model as the last line. */
export function storedScript(set: RuleSet, targets: SieveTargets): string {
  return `${sieveScript(set, targets)}\n\n${MARKER}${JSON.stringify({ v: VERSION, ...set })}\n`;
}

/** Index of the line with the model: the last one starting with the marker; `-1` if none. */
function markerLine(lines: readonly string[]): number {
  return lines.findLastIndex((l) => l.startsWith(MARKER));
}

/** Script without the line with the model, for the "Show Sieve script" view. */
export function visibleScript(text: string): string {
  const lines = text.split(/\r?\n/);
  const at = markerLine(lines);
  return at < 0 ? text : lines.slice(0, at).join('\n').replace(/\n+$/, '');
}

const isString = (v: unknown): v is string => typeof v === 'string';
const CONDS: readonly string[] = ['from', 'to', 'subj', 'size', 'att'];
const ACTIONS: readonly string[] = ['move', 'tag', 'read', 'fwd', 'del'];

function pair<T extends string>(v: unknown, kinds: readonly string[]): [T, string] | null {
  return Array.isArray(v) && v.length === 2 && isString(v[0]) && kinds.includes(v[0]) && isString(v[1])
    ? [v[0] as T, v[1]]
    : null;
}

function ruleOf(v: unknown): Rule | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.name) || typeof r.on !== 'boolean') return null;
  if (r.match !== 'all' && r.match !== 'any') return null;
  if (!Array.isArray(r.conds) || !Array.isArray(r.acts)) return null;
  const conds = r.conds.map((c) => pair<CondField>(c, CONDS));
  const acts = r.acts.map((a) => pair<ActionKind>(a, ACTIONS));
  if (conds.some((c) => c === null) || acts.some((a) => a === null)) return null;
  return { id: r.id, name: r.name, on: r.on, match: r.match, conds: conds as Cond[], acts: acts as Action[] };
}

/** Model from the last line of the script; `null` if it is missing or unreadable. */
export function readModel(text: string): RuleSet | null {
  const lines = text.split(/\r?\n/);
  const at = markerLine(lines);
  if (at < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse((lines[at] ?? '').slice(MARKER.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const f = o.forward as Record<string, unknown> | null | undefined;
  if (o.v !== VERSION || typeof f !== 'object' || f === null || !Array.isArray(o.rules)) return null;
  if (typeof f.on !== 'boolean' || !isString(f.to) || typeof f.keep !== 'boolean') return null;
  const rules = o.rules.map(ruleOf);
  if (rules.some((r) => r === null)) return null;
  return { forward: { on: f.on, to: f.to, keep: f.keep }, rules: rules as Rule[] };
}

/** Forwardings that can apply at the same time (upper bound for `maxNumberRedirects`). */
export function redirectCount(set: RuleSet): number {
  const forward = set.forward.on && set.forward.to.trim() ? 1 : 0;
  return set.rules.filter((r) => r.on).reduce((n, r) => n + r.acts.filter(([a]) => a === 'fwd').length, forward);
}
