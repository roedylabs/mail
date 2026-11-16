#!/usr/bin/env node
// JS budget per route:
// sums up the JavaScript SvelteKit loads on the first visit of a route, after
// gzip, and checks it against the budget. The basis is the build's server
// manifest: the entry (`client.imports`, containing start and app with their
// static imports), per layout and page the node's `imports` – the same lists
// SvelteKit builds the modulepreload links from – and the node of the root
// error page (1), which SvelteKit always loads on start
// (`default_error_loader` in `start()`).
// Dynamic imports (parts loaded only on demand) do not count; what the browser
// really loads is measured by the load test with Lighthouse.
//
//   node scripts/js-budget.mjs [<web-dir>]     (after `pnpm build`)
//
// The default is apps/web: reads .svelte-kit/output/server/ and the files from
// build/. Exit code 1 above the budget or without a build; in CI the summary
// also goes to $GITHUB_STEP_SUMMARY.

import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Budgets in bytes (kB = 1000 bytes as for the image size in release.yml). */
export const BUDGETS = [{ name: 'Mailbox', route: '/mailbox/[account]/[...path]', maxBytes: 300_000 }];

/** Node of the root error page; SvelteKit always assigns 0 (root layout) and 1 this way. */
const ROOT_ERROR_NODE = 1;

/** Size after gzip with the default level (6, like `gzip` and most proxies). */
export function gzipSize(data) {
  return gzipSync(data).length;
}

/** Reads `export const <name> = [...]` from a node file without executing it. */
function listExport(source, name, file) {
  const match = new RegExp(`^export const ${name} = (\\[.*\\]);$`, 'm').exec(source);
  if (!match) throw new Error(`${file}: "export const ${name}" missing – SvelteKit format changed?`);
  return JSON.parse(match[1]);
}

/**
 * JS and CSS files loaded on the first visit of route `id` (paths relative to
 * the build, e.g. `_app/immutable/nodes/3.abc.js`). The node files are only
 * read: importing them would pull in the pages' server build, which is not
 * meant for Node.
 */
export async function routeFiles(serverDir, id) {
  const { manifest } = await import(pathToFileURL(join(serverDir, 'manifest.js')).href);
  // SvelteKit 2 put nodes and routes under `_`; today they are at the top.
  const data = manifest?._ ?? manifest;
  const client = data?.client;
  if (!Array.isArray(client?.imports)) {
    throw new Error('manifest without client.imports – SvelteKit format changed?');
  }
  const route = data.routes.find((r) => r.id === id);
  if (!route) throw new Error(`route ${id} missing from the manifest`);
  if (!route.page) throw new Error(`route ${id} has no page`);
  const js = new Set(client.imports);
  const css = new Set(client.stylesheets ?? []);
  // filter skips gaps in `layouts` (groups without their own layout). Node 1 is
  // the root error page: SvelteKit preloads it with node 0 on start, so that
  // later network errors do not leave the app without an error page.
  const nodes = new Set([ROOT_ERROR_NODE, ...route.page.layouts.filter((i) => i !== undefined), route.page.leaf]);
  for (const index of nodes) {
    const file = join(serverDir, 'nodes', `${index}.js`);
    const source = await readFile(file, 'utf8');
    for (const f of listExport(source, 'imports', file)) js.add(f);
    for (const f of listExport(source, 'stylesheets', file)) css.add(f);
  }
  return { js: [...js], css: [...css] };
}

async function sizes(buildDir, files) {
  const out = [];
  for (const file of files) {
    const data = await readFile(join(buildDir, file));
    out.push({ file, bytes: data.length, gzip: gzipSize(data) });
  }
  return out.sort((a, b) => b.gzip - a.gzip);
}

const sum = (list, key) => list.reduce((n, item) => n + item[key], 0);

/** Measures all budgets for the web directory (`.svelte-kit/output/server`, `build`). */
export async function measure(webDir, budgets = BUDGETS) {
  const serverDir = join(webDir, '.svelte-kit', 'output', 'server');
  const buildDir = join(webDir, 'build');
  const results = [];
  for (const budget of budgets) {
    const files = await routeFiles(serverDir, budget.route);
    const js = await sizes(buildDir, files.js);
    const css = await sizes(buildDir, files.css);
    const gzip = sum(js, 'gzip');
    results.push({ ...budget, js, css, bytes: sum(js, 'bytes'), gzip, ok: gzip <= budget.maxBytes });
  }
  return results;
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

/** Text for the console and Markdown for the CI summary. */
export function report(results) {
  const text = [];
  const md = ['### JS budget (gzip)', ''];
  for (const r of results) {
    const verdict = r.ok ? 'met' : 'EXCEEDED';
    const head = `${r.name} (${r.route}): ${r.js.length} JS files, ${kb(r.bytes)} raw, ${kb(r.gzip)} gz – budget ${kb(r.maxBytes)}: ${verdict}`;
    text.push(head);
    text.push(`  CSS (no budget): ${r.css.length} files, ${kb(sum(r.css, 'gzip'))} gz`);
    for (const f of r.js.slice(0, 5)) text.push(`  ${kb(f.gzip).padStart(9)} gz  ${f.file}`);
    md.push(`**${head}**`, '', '| File | raw | gz |', '|---|---:|---:|');
    for (const f of r.js) md.push(`| \`${f.file}\` | ${kb(f.bytes)} | ${kb(f.gzip)} |`);
    md.push('');
  }
  return { text: text.join('\n'), markdown: md.join('\n') };
}

async function main(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const webDir = resolve(args[0] ?? join(root, 'apps', 'web'));
  let results;
  try {
    results = await measure(webDir);
  } catch (err) {
    console.error(`js-budget: ${err.message} (run \`pnpm build\` first)`);
    process.exit(1);
  }
  const { text, markdown } = report(results);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  for (const r of results.filter((x) => !x.ok)) {
    console.error(`::error::JS of route ${r.route}: ${kb(r.gzip)} gz, budget ${kb(r.maxBytes)}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

if (import.meta.main) await main(process.argv.slice(2));
