// Tests of the sandbox environment (node --test scripts/): scripts/dev/sandbox-env.sh
// must redirect every place npm, pnpm and cargo write to into $TMPDIR –
// including PNPM_HOME, which the profile sets to ~/.local/share/pnpm, read-only
// in the sandbox.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'sandbox-env.sh');
const VARS = [
  'npm_config_cache',
  'COREPACK_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PNPM_HOME',
  'CARGO_HOME',
];

describe('sandbox-env.sh', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'roedy-sandbox-env-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // A pnpm placeholder in PATH, so that the corepack branch does not go online.
  const bin = join(tmp, 'bin');
  const sandboxTmp = join(tmp, 'tmp');
  for (const dir of [bin, sandboxTmp]) mkdirSync(dir);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'pnpm'), 0o755);

  const printf = VARS.map((name) => `"${name}=$${name}"`).join(' ');
  const run = spawnSync(
    'bash',
    ['-c', `. "$1" && printf '%s\\n' ${printf} "_rm_base=\${_rm_base-unset}"`, 'bash', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: sandboxTmp,
        PATH: `${bin}:${process.env.PATH}`,
        PNPM_HOME: join(tmp, 'home', '.local', 'share', 'pnpm'),
        CARGO_HOME: join(tmp, 'home', '.cargo'),
      },
    },
  );
  const env = Object.fromEntries(
    (run.stdout ?? '')
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const base = join(sandboxTmp, 'roedy-mail-dev');

  test('runs without errors', () => {
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.status, 0, run.stderr);
  });

  test('redirects all write locations to $TMPDIR/roedy-mail-dev', () => {
    for (const name of VARS) {
      assert.ok(env[name]?.startsWith(`${base}/`), `${name}=${env[name]}`);
    }
  });

  test('sets PNPM_HOME even if the profile already set it', () => {
    assert.equal(env.PNPM_HOME, join(base, 'pnpm-home'));
    assert.ok(statSync(env.PNPM_HOME).isDirectory());
  });

  test('creates XDG_RUNTIME_DIR with mode 700', () => {
    assert.equal(statSync(env.XDG_RUNTIME_DIR).mode & 0o777, 0o700);
  });

  test('cleans up the helper variable', () => {
    assert.equal(env._rm_base, 'unset');
  });
});
