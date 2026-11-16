import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLicenseList,
  licenses,
  packageRootOf,
  readCargoAbout,
  readPackage,
  repositoryUrl,
  resolvePackageRoot,
} from './licenses.ts';

describe('packageRootOf', () => {
  it('finds the package in the pnpm store', () => {
    expect(
      packageRootOf('/repo/node_modules/.pnpm/svelte@5.57.2/node_modules/svelte/src/internal/client/index.js'),
    ).toBe('/repo/node_modules/.pnpm/svelte@5.57.2/node_modules/svelte');
  });

  it('detects scoped packages and strips query and \\0', () => {
    expect(packageRootOf('\0/a/node_modules/@sveltejs/kit/src/runtime/client/entry.js?v=1')).toBe(
      '/a/node_modules/@sveltejs/kit',
    );
  });

  it('ignores own code and virtual modules', () => {
    expect(packageRootOf('/repo/apps/web/src/routes/+page.svelte')).toBeUndefined();
    expect(packageRootOf('\0vite/preload-helper.js')).toBeUndefined();
  });
});

describe('resolvePackageRoot', () => {
  it('finds the packages of the bundler runtime (virtual modules \\0vite/…, \\0rolldown/…)', () => {
    const name = (dir: string) =>
      (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }).name;
    expect(name(resolvePackageRoot(['vite']))).toBe('vite');
    expect(name(resolvePackageRoot(['vite', 'rolldown']))).toBe('rolldown');
  });
});

describe('repositoryUrl', () => {
  it('turns shorthands and Git URLs into https URLs', () => {
    expect(repositoryUrl('o/r')).toBe('https://github.com/o/r');
    expect(repositoryUrl('gitlab:o/r')).toBe('https://gitlab.com/o/r');
    expect(repositoryUrl('bitbucket:o/r')).toBe('https://bitbucket.org/o/r');
    expect(repositoryUrl('git@github.com:o/r.git')).toBe('https://github.com/o/r');
    expect(repositoryUrl({ url: 'git+ssh://git@github.com/o/r.git' })).toBe('https://github.com/o/r');
    expect(repositoryUrl({ url: 'ssh://git@gitlab.com/o/r.git' })).toBe('https://gitlab.com/o/r');
    expect(repositoryUrl({ url: 'git://github.com/o/r.git' })).toBe('https://github.com/o/r');
    expect(repositoryUrl(undefined)).toBeUndefined();
  });
});

describe('readPackage', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const fixture = (pkg: object, files: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'roedy-licenses-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  it('reads license, URL and license texts', () => {
    const dir = fixture(
      { name: 'demo', version: '1.2.3', license: 'MIT', repository: { url: 'git+https://github.com/o/demo.git' } },
      { LICENSE: 'MIT License\n\nCopyright (c) Demo\n', 'README.md': 'not a license text' },
    );
    expect(readPackage(dir)).toEqual({
      name: 'demo',
      version: '1.2.3',
      license: 'MIT',
      url: 'https://github.com/o/demo',
      origin: 'web',
      licenseTexts: ['MIT License\n\nCopyright (c) Demo'],
    });
  });

  it('skips private (own) packages', () => {
    expect(readPackage(fixture({ name: '@roedy/tokens', version: '0.0.0', private: true }))).toBeUndefined();
  });

  it('understands shorthands and legacy license fields', () => {
    const pkg = readPackage(
      fixture({
        name: 'legacy',
        version: '1.0.0',
        licenses: [{ type: 'MIT' }, 'Apache-2.0'],
        repository: 'o/legacy',
      }),
    );
    expect(pkg).toMatchObject({ license: 'MIT OR Apache-2.0', url: 'https://github.com/o/legacy', licenseTexts: [] });
  });
});

describe('readCargoAbout', () => {
  it('merges crates with several license texts', () => {
    const crate = {
      name: 'ring',
      version: '0.17.14',
      license: 'Apache-2.0 AND ISC',
      repository: 'https://github.com/briansmith/ring.git',
    };
    const json = JSON.stringify({
      licenses: [
        {
          text: 'Apache text\n',
          used_by: [{ crate }, { crate: { name: 'axum', version: '0.8.9', license: 'MIT', homepage: null } }],
        },
        { text: 'ISC text', used_by: [{ crate }] },
      ],
    });
    expect(readCargoAbout(json)).toEqual([
      {
        name: 'ring',
        version: '0.17.14',
        license: 'Apache-2.0 AND ISC',
        url: 'https://github.com/briansmith/ring',
        origin: 'server',
        licenseTexts: ['Apache text', 'ISC text'],
      },
      { name: 'axum', version: '0.8.9', license: 'MIT', origin: 'server', licenseTexts: ['Apache text'] },
    ]);
  });
});

describe('buildLicenseList', () => {
  it('sorts, removes duplicates and merges identical texts', () => {
    const list = buildLicenseList(
      [
        { name: 'b', version: '1.0.0', license: 'MIT', origin: 'web', licenseTexts: ['MIT'] },
        { name: 'axum', version: '0.8.9', license: 'MIT', origin: 'server', licenseTexts: ['MIT'] },
        { name: 'a', version: '10.0.0', license: 'ISC', origin: 'web', licenseTexts: ['ISC', 'ISC'] },
        { name: 'a', version: '9.0.0', license: 'ISC', origin: 'web', licenseTexts: [] },
        { name: 'b', version: '1.0.0', license: 'MIT', origin: 'web', licenseTexts: ['MIT'] },
      ],
      '2026-10-23T00:00:00.000Z',
    );
    expect(list).toEqual({
      version: 1,
      generated: '2026-10-23T00:00:00.000Z',
      packages: [
        { name: 'axum', version: '0.8.9', license: 'MIT', origin: 'server', texts: [0] },
        { name: 'a', version: '9.0.0', license: 'ISC', origin: 'web', texts: [] },
        { name: 'a', version: '10.0.0', license: 'ISC', origin: 'web', texts: [1] },
        { name: 'b', version: '1.0.0', license: 'MIT', origin: 'web', texts: [0] },
      ],
      texts: ['MIT', 'ISC'],
    });
  });
});

describe('licenses (plugin)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('collects across client and service worker; the last list written names all packages', () => {
    dir = mkdtempSync(join(tmpdir(), 'roedy-licenses-'));
    const pkg = (name: string) => {
      const root = join(dir, 'node_modules', name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
      return join(root, 'index.js');
    };
    const emitted: string[] = [];
    const context = { emitFile: ({ source }: { source: string }) => emitted.push(source), info: () => {} };
    const generateBundle = licenses({ generated: '2026-11-13' }).generateBundle as unknown as (
      this: typeof context,
      output: object,
      bundle: Record<string, { type: 'chunk'; moduleIds: string[] }>,
    ) => void;
    // Order as in the SvelteKit build: first the client, then the service worker into the same outDir
    generateBundle.call(context, {}, { 'app.js': { type: 'chunk', moduleIds: [pkg('client-lib')] } });
    generateBundle.call(context, {}, { 'service-worker.js': { type: 'chunk', moduleIds: [pkg('worker-lib')] } });
    const names = (source: string) =>
      (JSON.parse(source) as { packages: { name: string }[] }).packages.map(({ name }) => name);
    expect(names(emitted[0]!)).toEqual(['client-lib']);
    expect(names(emitted[1]!)).toEqual(['client-lib', 'worker-lib']);
  });
});
