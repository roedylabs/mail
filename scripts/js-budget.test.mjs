// Tests of the budget check (node --test scripts/): files of a route from a
// recreated SvelteKit server manifest (entry, layouts with gaps, page), sizes
// after gzip, verdict and errors for a missing route or a changed format. CI
// runs it against the real build.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { gzipSize, measure, report, routeFiles } from './js-budget.mjs';

const MANIFEST = `export const manifest = (() => {
function __memo(fn) { let value; return () => value ??= (value = fn()); }
return {
	app_dir: "_app",
	client: {start:"_app/immutable/entry/start.A.js",app:"_app/immutable/entry/app.B.js",imports:["_app/immutable/entry/start.A.js","_app/immutable/chunks/shared.js","_app/immutable/entry/app.B.js"],stylesheets:[],fonts:[]},
	nodes: [
		__memo(() => import('./nodes/0.js')),
		__memo(() => import('./nodes/1.js')),
		__memo(() => import('./nodes/2.js')),
	],
	routes: [
		{
			id: "/mailbox/[account]/[...path]",
			pattern: /^\\/mailbox\\/([^/]+?)(?:\\/([^]*))?\\/?$/,
			page: { layouts: [0,,], errors: [1,,], leaf: 2 },
			endpoint: null
		},
		{ id: "/api", pattern: /^\\/api$/, page: null, endpoint: {} }
	]
};
})();
`;

/** Node file as from SvelteKit, with an import that would fail when executed. */
const node = (imports, stylesheets = []) =>
  `import * as universal from '../entries/pages/does-not-exist.js';\nexport const index = 0;\nexport const imports = ${JSON.stringify(imports)};\nexport const stylesheets = ${JSON.stringify(stylesheets)};\nexport const fonts = [];\n`;

const FILES = {
  '_app/immutable/entry/start.A.js': 'a'.repeat(4000),
  '_app/immutable/entry/app.B.js': 'export const app = 1;\n'.repeat(50),
  '_app/immutable/chunks/shared.js': 'x',
  '_app/immutable/nodes/0.L.js': 'layout',
  '_app/immutable/nodes/1.E.js': 'error',
  '_app/immutable/nodes/2.P.js': 'page',
  '_app/immutable/chunks/page-only.js': 'page-only',
  '_app/immutable/assets/0.css': 'body{}',
};

let web;

before(async () => {
  web = await mkdtemp(join(tmpdir(), 'js-budget-'));
  const server = join(web, '.svelte-kit', 'output', 'server');
  await mkdir(join(server, 'nodes'), { recursive: true });
  await writeFile(join(server, 'manifest.js'), MANIFEST);
  await writeFile(
    join(server, 'nodes', '0.js'),
    node(['_app/immutable/nodes/0.L.js', '_app/immutable/chunks/shared.js'], ['_app/immutable/assets/0.css']),
  );
  await writeFile(join(server, 'nodes', '1.js'), node(['_app/immutable/nodes/1.E.js']));
  await writeFile(
    join(server, 'nodes', '2.js'),
    node(['_app/immutable/nodes/2.P.js', '_app/immutable/chunks/page-only.js']),
  );
  for (const [file, content] of Object.entries(FILES)) {
    await mkdir(join(web, 'build', file, '..'), { recursive: true });
    await writeFile(join(web, 'build', file), content);
  }
});

after(async () => {
  await rm(web, { recursive: true, force: true });
});

describe('routeFiles', () => {
  test('entry, layout, root error page and page without duplicate files', async () => {
    const { js, css } = await routeFiles(join(web, '.svelte-kit', 'output', 'server'), '/mailbox/[account]/[...path]');
    assert.deepEqual(js.toSorted(), [
      '_app/immutable/chunks/page-only.js',
      '_app/immutable/chunks/shared.js',
      '_app/immutable/entry/app.B.js',
      '_app/immutable/entry/start.A.js',
      '_app/immutable/nodes/0.L.js',
      '_app/immutable/nodes/1.E.js',
      '_app/immutable/nodes/2.P.js',
    ]);
    assert.deepEqual(css, ['_app/immutable/assets/0.css']);
  });

  test('a missing route and a route without a page are errors', async () => {
    const server = join(web, '.svelte-kit', 'output', 'server');
    await assert.rejects(routeFiles(server, '/does-not-exist'), /route \/does-not-exist missing/);
    await assert.rejects(routeFiles(server, '/api'), /has no page/);
  });
});

describe('measure', () => {
  const budget = (maxBytes) => [{ name: 'Mailbox', route: '/mailbox/[account]/[...path]', maxBytes }];

  test('sums raw and after gzip, largest file first', async () => {
    const [r] = await measure(web, budget(300_000));
    const raw = Object.entries(FILES)
      .filter(([f]) => f.endsWith('.js'))
      .reduce((n, [, c]) => n + c.length, 0);
    assert.equal(r.bytes, raw);
    assert.equal(
      r.gzip,
      r.js.reduce((n, f) => n + f.gzip, 0),
    );
    assert.equal(r.js[0].file, '_app/immutable/entry/app.B.js');
    assert.equal(r.js[0].gzip, gzipSize(Buffer.from(FILES['_app/immutable/entry/app.B.js'])));
    assert.ok(r.gzip < r.bytes, 'gzip shrinks the repetitions');
    assert.equal(r.ok, true);
  });

  test('above the budget: not met, visible in the report', async () => {
    const results = await measure(web, budget(50));
    assert.equal(results[0].ok, false);
    const { text, markdown } = report(results);
    assert.match(text, /Mailbox \(\/mailbox\/\[account\]\/\[\.\.\.path\]\): 7 JS files, .* – budget 0\.1 kB: EXCEEDED/);
    assert.match(markdown, /\| `_app\/immutable\/entry\/app\.B\.js` \|/);
  });

  test('no build is an error', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'js-budget-empty-'));
    try {
      await assert.rejects(measure(empty, budget(1)), /manifest\.js/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('a missing file in the build is an error', async () => {
    await rm(join(web, 'build', '_app/immutable/chunks/page-only.js'));
    await assert.rejects(measure(web, budget(1)), /ENOENT/);
  });
});
