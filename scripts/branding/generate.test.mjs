// Tests of the branding generator (node --test scripts/): the mark is the one
// the web app draws, and the SVG files in assets/branding are what the
// generator produces (run `just branding` after a change).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BACK, FLAP, FRONT, svgFiles } from './generate.mjs';

const root = join(import.meta.dirname, '../..');
const out = join(root, 'assets/branding');

test('the mark matches the default logo of the web app', () => {
  const logo = readFileSync(join(root, 'apps/web/src/lib/components/Logo.svelte'), 'utf8');
  for (const d of [BACK, FRONT, FLAP]) assert.ok(logo.includes(`d="${d}"`), d);
});

test('the SVG files in assets/branding are up to date', () => {
  const files = svgFiles();
  assert.deepEqual(
    readdirSync(join(out, 'svg')).sort(),
    Object.keys(files)
      .map((file) => file.slice(4))
      .sort(),
  );
  for (const [file, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(out, file), 'utf8'), content, `${file} differs: run \`just branding\``);
  }
});

test('favicon.ico holds the PNG icons in 16, 32, 48 and 256 px', () => {
  const ico = readFileSync(join(out, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [16, 32, 48, 256]);
  const first = ico.readUInt32LE(6 + 12);
  assert.equal(ico.toString('latin1', first + 1, first + 4), 'PNG');
});
