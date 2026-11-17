// Build images pinned by digest (node --test scripts/): every FROM and
// `# syntax=` line in the repository's Dockerfiles names its image with
// @sha256:<digest> (Dependabot keeps tag and digest up to date), and every
// docker/setup-buildx-action in the workflows runs the BuildKit image from
// .github/buildkit/Dockerfile instead of a moby/buildkit tag. A replaced tag on
// a registry can then not slip a different base image or CA bundle into the
// build.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';

const root = join(import.meta.dirname, '..');

/** Image reference with a digest; no build arguments, which a check cannot resolve. */
const PINNED = /^[^\s$@]+@sha256:[0-9a-f]{64}$/;

/** Tracked and new (not ignored) files of the repository. */
function repoFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

/** Dockerfile, Dockerfile.x, x.Dockerfile and the Containerfile names, not x.dockerignore. */
function isDockerfile(path) {
  const name = basename(path);
  return (
    /^(dockerfile|containerfile)(\..+)?$|\.(dockerfile|containerfile)$/i.test(name) && !/\.dockerignore$/i.test(name)
  );
}

/**
 * Problems of a Dockerfile: `# syntax=` and FROM images without a digest.
 * `scratch` and earlier stages (FROM … AS name) need none.
 * @param {string} text
 * @returns {string[]}
 */
function dockerfileProblems(text) {
  const problems = [];
  const stages = new Set();
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    // Instructions (not comments) continue over lines that end with a
    // backslash; reported is the first line.
    let line = raw[i];
    const start = i;
    while (!/^\s*#/.test(line) && line.endsWith('\\') && i + 1 < raw.length) line = `${line.slice(0, -1)} ${raw[++i]}`;
    const syntax = /^\s*#\s*syntax\s*=\s*(\S*)/i.exec(line);
    if (syntax) {
      if (!PINNED.test(syntax[1])) problems.push(`line ${start + 1}: syntax ${syntax[1] || '(empty)'} without digest`);
      continue;
    }
    const from = /^\s*FROM\s+(.*)$/i.exec(line);
    if (!from) continue;
    const words = from[1].trim().split(/\s+/);
    const [image, as, stage] = words.filter((w) => !w.startsWith('--'));
    if (!image) problems.push(`line ${start + 1}: FROM without image`);
    else if (image.toLowerCase() !== 'scratch' && !stages.has(image.toLowerCase()) && !PINNED.test(image)) {
      problems.push(`line ${start + 1}: FROM ${image} without digest`);
    }
    // Only later FROM lines may refer to this stage.
    if (as?.toLowerCase() === 'as' && stage) stages.add(stage.toLowerCase());
  }
  return problems;
}

/**
 * Steps with docker/setup-buildx-action that do not set the BuildKit image via
 * driver-opts (YAML steps by indentation; enough for the workflows here).
 * @param {string} text
 * @returns {string[]}
 */
function buildxProblems(text) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    // Every list item is a candidate step; `uses:` may be on its first line
    // or on a later one (e.g. after `- name: …`).
    const item = /^(\s*)-\s/.exec(line);
    if (!item) continue;
    const indent = item[1].length;
    const step = [line.slice(indent + 1)];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.search(/\S/) <= indent) break;
      step.push(next);
    }
    if (!step.some((l) => /^\s*uses:\s*['"]?docker\/setup-buildx-action@/.test(l))) continue;
    if (!step.some((l) => /^\s*driver-opts:.*\bimage=\$\{\{\s*steps\.buildkit\.outputs\.image\s*\}\}/.test(l))) {
      problems.push(
        `line ${i + 1}: setup-buildx-action without driver-opts image=\${{ steps.buildkit.outputs.image }}`,
      );
    }
  }
  return problems;
}

describe('dockerfileProblems', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  test('accepts digests, scratch and earlier stages', () => {
    const text = [
      `# syntax=docker/dockerfile:1.20@${digest}`,
      `FROM --platform=$BUILDPLATFORM alpine:3.24@${digest} AS rootfs`,
      `FROM gcr.io/project/image@${digest}`,
      'FROM rootfs AS second',
      'FROM scratch',
      'COPY --from=rootfs / /',
    ].join('\n');
    assert.deepEqual(dockerfileProblems(text), []);
  });

  test('reports tags without digest, unpinned syntax and build arguments', () => {
    const text = [
      '# syntax=docker/dockerfile:1',
      'FROM alpine:3.24',
      'from alpine',
      `FROM \${BASE}@${digest}`,
      'FROM \\',
      '  debian:13 AS build',
      'FROM later-stage',
      `FROM alpine@sha256:${'a'.repeat(63)}`,
    ].join('\n');
    assert.deepEqual(dockerfileProblems(text), [
      'line 1: syntax docker/dockerfile:1 without digest',
      'line 2: FROM alpine:3.24 without digest',
      'line 3: FROM alpine without digest',
      `line 4: FROM \${BASE}@${digest} without digest`,
      'line 5: FROM debian:13 without digest',
      'line 7: FROM later-stage without digest',
      `line 8: FROM alpine@sha256:${'a'.repeat(63)} without digest`,
    ]);
  });

  test('ignores comments that mention syntax, but no FROM after a comment', () => {
    assert.deepEqual(dockerfileProblems('# No `# syntax=` line on purpose\nFROM scratch\n'), []);
    assert.deepEqual(dockerfileProblems('# comment \\\nFROM alpine AS alpine\n'), [
      'line 2: FROM alpine without digest',
    ]);
  });
});

describe('buildxProblems', () => {
  test('requires the pinned BuildKit image', () => {
    const text = [
      'steps:',
      '  - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4',
      '  - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4',
      '    with:',
      '      driver-opts: image=${{ steps.buildkit.outputs.image }}',
      '  - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4',
      '    with:',
      '      driver-opts: image=moby/buildkit:latest',
      '  - name: Builder',
      '    uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4',
      '  - name: Pinned builder',
      '    uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4',
      '    with:',
      '      driver-opts: image=${{ steps.buildkit.outputs.image }}',
      '  - name: Other step',
      '    with:',
      '      driver-opts: image=moby/buildkit:latest',
    ].join('\n');
    assert.deepEqual(buildxProblems(text), [
      'line 2: setup-buildx-action without driver-opts image=${{ steps.buildkit.outputs.image }}',
      'line 6: setup-buildx-action without driver-opts image=${{ steps.buildkit.outputs.image }}',
      'line 9: setup-buildx-action without driver-opts image=${{ steps.buildkit.outputs.image }}',
    ]);
  });
});

describe('repository', () => {
  const files = repoFiles();

  test('every Dockerfile pins its images by digest', () => {
    const dockerfiles = files.filter(isDockerfile);
    assert.ok(dockerfiles.includes('Dockerfile'), 'Dockerfile not found');
    assert.ok(dockerfiles.includes('.github/buildkit/Dockerfile'), '.github/buildkit/Dockerfile not found');
    const problems = dockerfiles.flatMap((f) =>
      dockerfileProblems(readFileSync(join(root, f), 'utf8')).map((p) => `${f} ${p}`),
    );
    assert.deepEqual(problems, []);
  });

  test('the BuildKit file names moby/buildkit by tag and digest', () => {
    const text = readFileSync(join(root, '.github/buildkit/Dockerfile'), 'utf8');
    const from = text.split('\n').filter((l) => l.startsWith('FROM '));
    assert.equal(from.length, 1);
    assert.match(from[0], /^FROM moby\/buildkit:[^@\s]+@sha256:[0-9a-f]{64}$/);
  });

  test('every setup-buildx-action runs the pinned BuildKit image', () => {
    const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    assert.ok(workflows.length > 0, 'no workflows found');
    const problems = workflows.flatMap((f) =>
      buildxProblems(readFileSync(join(root, f), 'utf8')).map((p) => `${f} ${p}`),
    );
    assert.deepEqual(problems, []);
  });
});
