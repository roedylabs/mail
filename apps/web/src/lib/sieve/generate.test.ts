import { describe, expect, it } from 'vitest';
import {
  EMPTY_RULES,
  quote,
  readModel,
  redirectCount,
  SCRIPT_NAME,
  sieveScript,
  sizeTest,
  storedScript,
  VACATION_SCRIPT,
  visibleScript,
  type Forward,
  type Rule,
  type RuleSet,
  type SieveTargets,
} from './generate.ts';

const REQUIRE = 'require ["fileinto", "imap4flags", "copy"];';
const MARKER = '# roedy-mail-rules: ';

const FOLDERS: Record<string, string> = { f1: 'Archive/2026', f2: 'Invoices', f3: 'Fi"ling\\old' };
const TAGS: Record<string, string> = { t1: 'Tags/Important', t2: 'Tags/Projects/Alpha' };

const targets: SieveTargets = {
  folder: (id) => FOLDERS[id] ?? null,
  tag: (id) => TAGS[id] ?? null,
};

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Regel',
    on: true,
    match: 'all',
    conds: [['from', 'boss@company.example']],
    acts: [['read', '']],
    ...overrides,
  };
}

function ruleSet(rules: Rule[] = [], forward: Partial<Forward> = {}): RuleSet {
  return { forward: { ...EMPTY_RULES.forward, ...forward }, rules };
}

/** Comment line with an arbitrary model, as another program might leave behind. */
const modelLine = (o: unknown) => MARKER + JSON.stringify(o);

describe('Constants', () => {
  it('name the own script, that of the vacation notice and an empty model', () => {
    expect(SCRIPT_NAME).toBe('roedy-mail');
    expect(VACATION_SCRIPT).toBe('vacation');
    expect(EMPTY_RULES).toEqual({ forward: { on: false, to: '', keep: true }, rules: [] });
  });
});

describe('quote', () => {
  it('escapes backslash and quotation marks (RFC 5228, 2.4.2)', () => {
    expect(quote('Hello')).toBe('"Hello"');
    expect(quote('a\\b"c')).toBe('"a\\\\b\\"c"');
    expect(quote('\\"')).toBe('"\\\\\\""');
    expect(quote('')).toBe('""');
  });
});

describe('sizeTest', () => {
  it('writes whole MB', () => {
    expect(sizeTest('10')).toBe('size :over 10M');
    expect(sizeTest('2,0')).toBe('size :over 2M');
    expect(sizeTest(' 3 ')).toBe('size :over 3M');
  });

  it('writes fractional sizes in KB, also with a comma', () => {
    expect(sizeTest('1,5')).toBe('size :over 1536K');
    expect(sizeTest('1.5')).toBe('size :over 1536K');
    expect(sizeTest('0,25')).toBe('size :over 256K');
    // Very small sizes do not become 0K.
    expect(sizeTest('0,0001')).toBe('size :over 1K');
  });

  it('turns an invalid size into false', () => {
    expect(sizeTest('0')).toBe('false');
    expect(sizeTest('abc')).toBe('false');
    expect(sizeTest('')).toBe('false');
    expect(sizeTest('-2')).toBe('false');
    expect(sizeTest('Infinity')).toBe('false');
    // Sieve has no exponent notation: 1e21 MB would give `1e+21M`.
    expect(sizeTest('1e21')).toBe('false');
  });
});

describe('sieveScript', () => {
  it('consists only of require for an empty model', () => {
    expect(sieveScript(EMPTY_RULES, targets)).toBe(`${REQUIRE}\n\n`);
  });

  it('forwards with and without a copy', () => {
    expect(sieveScript(ruleSet([], { on: true, to: 'me@private.example', keep: true }), targets)).toBe(
      `${REQUIRE}\n\n# Forwarding\nredirect :copy "me@private.example";`,
    );
    expect(sieveScript(ruleSet([], { on: true, to: 'me@private.example', keep: false }), targets)).toBe(
      `${REQUIRE}\n\n# Forwarding\nredirect "me@private.example";`,
    );
  });

  it('trims the addresses of the forwarding and of the action "forward"', () => {
    const set = ruleSet(
      [
        {
          id: 'r1',
          name: 'Team',
          on: true,
          match: 'all',
          conds: [['to', 'team@']],
          acts: [['fwd', ' boss@company.example ']],
        },
      ],
      { on: true, to: '  me@private.example ', keep: true },
    );
    expect(sieveScript(set, targets)).toContain('redirect :copy "me@private.example";');
    expect(sieveScript(set, targets)).toContain('redirect :copy "boss@company.example";');
    expect(sieveScript(ruleSet([], { on: true, to: '   ' }), targets)).toBe(`${REQUIRE}\n\n`);
    expect(redirectCount(ruleSet([], { on: true, to: '   ' }))).toBe(0);
  });

  it('shares a frozen empty state', () => {
    expect(Object.isFrozen(EMPTY_RULES)).toBe(true);
    expect(Object.isFrozen(EMPTY_RULES.forward)).toBe(true);
    expect(Object.isFrozen(EMPTY_RULES.rules)).toBe(true);
  });

  it('skips a disabled forwarding and one without an address', () => {
    expect(sieveScript(ruleSet([], { on: false, to: 'me@private.example' }), targets)).toBe(`${REQUIRE}\n\n`);
    expect(sieveScript(ruleSet([], { on: true, to: '' }), targets)).toBe(`${REQUIRE}\n\n`);
  });

  it('generates forwarding and rules', () => {
    const set = ruleSet(
      [
        rule({
          name: 'Boss',
          conds: [
            ['from', 'boss@company.example'],
            ['subj', 'Urgent'],
          ],
          acts: [
            ['move', 'f2'],
            ['read', ''],
          ],
        }),
        rule({
          id: 'r2',
          name: 'Newsletter',
          match: 'any',
          conds: [
            ['to', 'news@company.example'],
            ['att', ''],
            ['size', '10'],
          ],
          acts: [
            ['tag', 't1'],
            ['fwd', 'me@private.example'],
            ['del', ''],
          ],
        }),
      ],
      { on: true, to: 'archive@company.example', keep: true },
    );
    expect(sieveScript(set, targets)).toBe(
      [
        REQUIRE,
        '',
        '# Forwarding',
        'redirect :copy "archive@company.example";',
        '',
        '# Boss',
        'if allof (header :contains "from" "boss@company.example", header :contains "subject" "Urgent") {',
        '  fileinto "Invoices";',
        '  addflag "\\\\Seen";',
        '}',
        '',
        '# Newsletter',
        'if anyof (header :contains "to" "news@company.example", header :contains "Content-Type" "multipart/mixed", size :over 10M) {',
        '  fileinto :copy "Tags/Important";',
        '  redirect :copy "me@private.example";',
        '  discard;',
        '}',
      ].join('\n'),
    );
  });

  it('tests a single condition without allof/anyof, and always without a condition', () => {
    const one = sieveScript(ruleSet([rule({ match: 'any', conds: [['subj', 'Invoice']] })]), targets);
    expect(one).toContain('\nif header :contains "subject" "Invoice" {\n');
    expect(one).not.toContain('anyof');
    const att = sieveScript(ruleSet([rule({ conds: [['att', '']] })]), targets);
    expect(att).toContain('\nif header :contains "Content-Type" "multipart/mixed" {\n');
    const none = sieveScript(ruleSet([rule({ conds: [] })]), targets);
    expect(none).toContain('\nif true {\n');
  });

  it('writes a fractional size in KB and an invalid one as false', () => {
    expect(sieveScript(ruleSet([rule({ conds: [['size', '1,5']] })]), targets)).toContain('\nif size :over 1536K {\n');
    expect(sieveScript(ruleSet([rule({ conds: [['size', 'abc']] })]), targets)).toContain('\nif false {\n');
  });

  it('escapes values, folder paths and addresses', () => {
    const script = sieveScript(
      ruleSet([
        rule({
          conds: [['subj', 'He said "Hello" \\o/']],
          acts: [
            ['move', 'f3'],
            ['fwd', 'a"b@company.example'],
          ],
        }),
      ]),
      targets,
    );
    expect(script).toContain('header :contains "subject" "He said \\"Hello\\" \\\\o/"');
    expect(script).toContain('  fileinto "Fi\\"ling\\\\old";');
    expect(script).toContain('  redirect :copy "a\\"b@company.example";');
  });

  it('files into folders with the full path and sets tags as fileinto :copy', () => {
    const script = sieveScript(
      ruleSet([
        rule({
          acts: [
            ['move', 'f1'],
            ['tag', 't2'],
          ],
        }),
      ]),
      targets,
    );
    expect(script).toContain('  fileinto "Archive/2026";\n  fileinto :copy "Tags/Projects/Alpha";\n}');
  });

  it('omits disabled rules and keeps the order', () => {
    const script = sieveScript(
      ruleSet([
        rule({ id: 'a', name: 'First' }),
        rule({ id: 'b', name: 'Off', on: false }),
        rule({ id: 'c', name: 'Third' }),
      ]),
      targets,
    );
    expect(script).not.toContain('# Off');
    expect(script.indexOf('# First')).toBeGreaterThan(0);
    expect(script.indexOf('# Third')).toBeGreaterThan(script.indexOf('# First'));
  });

  it('omits an action without a target and keeps the message without an action', () => {
    const some = sieveScript(
      ruleSet([
        rule({
          acts: [
            ['move', 'deleted'],
            ['read', ''],
          ],
        }),
      ]),
      targets,
    );
    expect(some).toContain('{\n  addflag "\\\\Seen";\n}');
    expect(some).not.toContain('fileinto "');
    expect(some).not.toContain('"?"');
    const none = sieveScript(
      ruleSet([
        rule({
          acts: [
            ['move', 'deleted'],
            ['tag', 'deleted'],
          ],
        }),
      ]),
      targets,
    );
    expect(none).toContain('{\n  keep;\n}');
    expect(sieveScript(ruleSet([rule({ acts: [] })]), targets)).toContain('{\n  keep;\n}');
  });

  it('turns line breaks in the name into spaces so that nothing leaks from the comment into the script', () => {
    const script = sieveScript(ruleSet([rule({ name: 'One\nif true { discard; }\r\nTwo\rThree' })]), targets);
    expect(script).toContain('\n# One if true { discard; } Two Three\nif ');
    expect(script.split('\n').filter((l) => l.startsWith('if true'))).toEqual([]);
    expect(script).not.toContain('\r');
  });
});

describe('storedScript and readModel', () => {
  const model = ruleSet(
    [
      rule({
        id: 'r1',
        name: 'Boss "important" \\ \'quoted\'\nsecond line',
        conds: [
          ['from', 'boss@company.example'],
          ['size', '1,5'],
        ],
        acts: [
          ['move', 'f1'],
          ['tag', 't1'],
          ['read', ''],
        ],
      }),
      rule({
        id: 'r2',
        name: 'Aus 🌙',
        on: false,
        match: 'any',
        conds: [['att', '']],
        acts: [
          ['fwd', 'me@private.example'],
          ['del', ''],
        ],
      }),
    ],
    { on: true, to: 'archive@company.example', keep: false },
  );

  it('appends the model as the last line of the script', () => {
    const stored = storedScript(model, targets);
    expect(stored.startsWith(sieveScript(model, targets))).toBe(true);
    expect(stored.endsWith('\n')).toBe(true);
    const last = stored.trimEnd().split('\n').at(-1) ?? '';
    expect(last.startsWith(`${MARKER}{"v":1,`)).toBe(true);
    expect(JSON.parse(last.slice(MARKER.length))).toEqual({ v: 1, ...model });
  });

  it('reads the model back unchanged', () => {
    expect(readModel(storedScript(model, targets))).toEqual(model);
    expect(readModel(storedScript(EMPTY_RULES, targets))).toEqual(EMPTY_RULES);
    // Also with CRLF, as Sieve actually requires.
    expect(readModel(storedScript(model, targets).replace(/\n/g, '\r\n'))).toEqual(model);
  });

  it('reads a model even without the targets that no longer exist', () => {
    const gone = ruleSet([rule({ acts: [['move', 'deleted']] })]);
    expect(readModel(storedScript(gone, targets))).toEqual(gone);
  });

  it('rejects a script without a marker', () => {
    expect(readModel(sieveScript(model, targets))).toBeNull();
    expect(readModel('')).toBeNull();
    expect(readModel('require "fileinto";\nif true { keep; }\n')).toBeNull();
    // Without a space after the colon it is not a marker.
    expect(readModel(`# roedy-mail-rules:${JSON.stringify({ v: 1, ...model })}`)).toBeNull();
  });

  it('rejects broken JSON', () => {
    expect(readModel(`${REQUIRE}\n\n${MARKER}{"v":1,"forward":`)).toBeNull();
    expect(readModel(`${REQUIRE}\n\n${MARKER}`)).toBeNull();
  });

  it('rejects a different or missing version', () => {
    expect(readModel(modelLine({ ...model, v: 2 }))).toBeNull();
    expect(readModel(modelLine({ ...model, v: '1' }))).toBeNull();
    expect(readModel(modelLine(model))).toBeNull();
    expect(readModel(modelLine({ v: 1, ...model }))).toEqual(model);
  });

  it('rejects wrong shapes', () => {
    const ok = { v: 1, ...model };
    const r = model.rules[0]!;
    const bad: unknown[] = [
      null,
      [],
      'Text',
      { ...ok, forward: undefined },
      { ...ok, forward: null },
      { ...ok, forward: { on: 'yes', to: 'a@b.example', keep: true } },
      { ...ok, forward: { on: true, to: 1, keep: true } },
      { ...ok, forward: { on: true, to: 'a@b.example' } },
      { ...ok, rules: {} },
      { ...ok, rules: [null] },
      { ...ok, rules: [{ ...r, id: 1 }] },
      { ...ok, rules: [{ ...r, name: undefined }] },
      { ...ok, rules: [{ ...r, on: 'true' }] },
      { ...ok, rules: [{ ...r, match: 'some' }] },
      { ...ok, rules: [{ ...r, conds: 'from' }] },
      { ...ok, rules: [{ ...r, acts: undefined }] },
      { ...ok, rules: [{ ...r, conds: [['from']] }] },
      { ...ok, rules: [{ ...r, conds: [['from', 'a', 'b']] }] },
      { ...ok, rules: [{ ...r, conds: [['from', 1]] }] },
      { ...ok, rules: [{ ...r, conds: ['from'] }] },
      { ...ok, rules: [{ ...r, acts: [['copy', 'x']] }] },
      { ...ok, rules: [{ ...r, acts: [['move', null]] }] },
    ];
    for (const o of bad) expect(readModel(modelLine(o)), JSON.stringify(o)).toBeNull();
  });

  it('rejects an unknown condition', () => {
    const r = model.rules[0]!;
    expect(readModel(modelLine({ v: 1, ...model, rules: [{ ...r, conds: [['body', 'Invoice']] }] }))).toBeNull();
  });

  it('skips unknown fields', () => {
    const r = model.rules[0]!;
    expect(
      readModel(modelLine({ v: 1, extra: true, forward: { ...model.forward, x: 1 }, rules: [{ ...r, color: 'red' }] })),
    ).toEqual({ forward: model.forward, rules: [r] });
  });

  it('is not confused by a rule whose name itself starts like the marker', () => {
    const fake = { v: 1, forward: { on: true, to: 'stranger@evil.example', keep: false }, rules: [] };
    const tricky = ruleSet([
      rule({ name: `roedy-mail-rules: ${JSON.stringify(fake)}` }),
      rule({ id: 'r2', name: 'Second', conds: [['subj', `x\n${modelLine(fake)}`]] }),
    ]);
    const stored = storedScript(tricky, targets);
    expect(stored.split('\n').filter((l) => l.startsWith(MARKER))).toHaveLength(3);
    expect(readModel(stored)).toEqual(tricky);
  });
});

describe('visibleScript', () => {
  const model = ruleSet([rule({ name: 'Boss' })], { on: true, to: 'me@private.example', keep: true });

  it('shows the script without the line with the model', () => {
    const visible = visibleScript(storedScript(model, targets));
    expect(visible).toBe(sieveScript(model, targets));
    expect(visible).not.toContain(MARKER);
  });

  it('shows an empty model as require without trailing blank lines', () => {
    expect(visibleScript(storedScript(EMPTY_RULES, targets))).toBe(REQUIRE);
  });

  it('leaves a script without a marker unchanged', () => {
    const foreign = 'require "fileinto";\r\nif header :contains "subject" "x" {\r\n  fileinto "X";\r\n}\r\n';
    expect(visibleScript(foreign)).toBe(foreign);
  });

  it('removes only the model line, not the comment of a rule with the same beginning', () => {
    const tricky = ruleSet([rule({ name: 'roedy-mail-rules: Fun' })]);
    const visible = visibleScript(storedScript(tricky, targets));
    expect(visible).toBe(sieveScript(tricky, targets));
    expect(visible).toContain(`\n${MARKER}Fun\nif `);
  });
});

describe('redirectCount', () => {
  it('counts the forwarding and "Forward" in enabled rules', () => {
    expect(redirectCount(EMPTY_RULES)).toBe(0);
    expect(redirectCount(ruleSet([], { on: true, to: 'me@private.example' }))).toBe(1);
    expect(redirectCount(ruleSet([], { on: true, to: '' }))).toBe(0);
    expect(redirectCount(ruleSet([], { on: false, to: 'me@private.example' }))).toBe(0);
    const set = ruleSet(
      [
        rule({
          acts: [
            ['fwd', 'a@company.example'],
            ['fwd', 'b@company.example'],
            ['read', ''],
          ],
        }),
        rule({ id: 'r2', on: false, acts: [['fwd', 'c@company.example']] }),
        rule({ id: 'r3', acts: [['move', 'f1']] }),
      ],
      { on: true, to: 'me@private.example' },
    );
    expect(redirectCount(set)).toBe(3);
  });
});
