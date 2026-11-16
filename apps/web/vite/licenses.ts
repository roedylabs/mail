// Vite plugin: at build time writes `licenses.json` with all third-party packages
// that end up in the browser bundle (from the module graph, not from package.json)
// and – if given – the Rust crates from `cargo about generate --format json`.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

export interface LicensePackage {
  name: string;
  version: string;
  /** SPDX expression as given in the package. */
  license: string;
  url?: string;
  origin: 'web' | 'server';
  /** Indices into `LicenseList.texts`. */
  texts: number[];
}

export interface LicenseList {
  version: 1;
  generated: string;
  packages: LicensePackage[];
  texts: string[];
}

interface CollectedPackage extends Omit<LicensePackage, 'texts'> {
  licenseTexts: string[];
}

const NODE_MODULES = '/node_modules/';
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-.][\w.-]*)?$/i;

/** Bundler runtime code that enters the bundle as a virtual module, with the package's resolution chain. */
const VIRTUAL_MODULES: [prefix: string, chain: string[]][] = [
  ['\0vite/', ['vite']],
  ['\0rolldown/', ['vite', 'rolldown']],
];

/** Fixed sort order regardless of the build machine's locale. */
const collator = new Intl.Collator('en', { numeric: true });

/** Root of a package; with chains like `['vite', 'rolldown']` each link is resolved from the previous one. */
export function resolvePackageRoot(chain: string[], from: string = import.meta.url): string {
  let base = from;
  for (const name of chain) {
    const packageJson = findPackageJSON(name, base);
    if (!packageJson) throw new Error(`package ${name} not found (from ${base})`);
    base = pathToFileURL(realpathSync(packageJson)).href;
  }
  return dirname(fileURLToPath(base));
}

/** Root of the package a module comes from, or `undefined` for own code. */
export function packageRootOf(id: string): string | undefined {
  const path = id.replace(/^\0/, '').split('?')[0]!.replaceAll('\\', '/');
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return undefined;
  const segments = path.slice(at + NODE_MODULES.length).split('/');
  const nameLength = segments[0]?.startsWith('@') ? 2 : 1;
  const name = segments.slice(0, nameLength);
  if (name.length < nameLength || name.some((part) => !part)) return undefined;
  return path.slice(0, at + NODE_MODULES.length) + name.join('/');
}

const SHORTCUT_HOSTS: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** URL from `repository` (shorthands `owner/repo`, `gitlab:owner/repo`, `git@host:owner/repo`, `git+https://…`). */
export function repositoryUrl(repository: unknown): string | undefined {
  const raw = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== 'string') return undefined;
  const shortcut = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (shortcut) return `https://${SHORTCUT_HOSTS[shortcut[1] ?? 'github']}/${shortcut[2]!.replace(/\.git$/, '')}`;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(raw);
  if (scp) return `https://${scp[1]}/${scp[2]!.replace(/\.git$/, '')}`;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/[\w.-]+@/, 'https://')
    .replace(/\.git$/, '');
}

function licenseOf(pkg: Record<string, unknown>): string {
  const { license, licenses } = pkg as { license?: unknown; licenses?: unknown };
  if (typeof license === 'string') return license;
  if (license && typeof license === 'object' && 'type' in license) return String(license.type);
  if (Array.isArray(licenses)) {
    return licenses
      .map((entry: unknown) => (typeof entry === 'string' ? entry : (entry as { type?: unknown } | null)?.type))
      .filter((type): type is string => typeof type === 'string')
      .join(' OR ');
  }
  return 'UNKNOWN';
}

/** Reads name, version, license and license texts of an npm package; own (private) packages yield `undefined`. */
export function readPackage(root: string): CollectedPackage | undefined {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (pkg.private === true) return undefined;
  const licenseTexts = readdirSync(root)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(join(root, file), 'utf8').trim())
    .filter(Boolean);
  const url = typeof pkg.homepage === 'string' ? pkg.homepage : repositoryUrl(pkg.repository);
  return {
    name: String(pkg.name),
    version: String(pkg.version),
    license: licenseOf(pkg),
    ...(url ? { url } : {}),
    origin: 'web',
    licenseTexts,
  };
}

interface CargoAboutCrate {
  name: string;
  version: string;
  license?: string | null;
  repository?: string | null;
  homepage?: string | null;
}

interface CargoAbout {
  licenses: { text: string; used_by: { crate: CargoAboutCrate }[] }[];
}

/** Rust crates from the JSON output of `cargo about generate --format json`. */
export function readCargoAbout(json: string): CollectedPackage[] {
  const about = JSON.parse(json) as CargoAbout;
  const crates = new Map<string, CollectedPackage>();
  for (const { text, used_by } of about.licenses) {
    for (const { crate } of used_by) {
      const key = `${crate.name}@${crate.version}`;
      const url = crate.repository ?? crate.homepage ?? undefined;
      const entry = crates.get(key) ?? {
        name: crate.name,
        version: crate.version,
        license: crate.license ?? 'UNKNOWN',
        ...(url ? { url: url.replace(/\.git$/, '') } : {}),
        origin: 'server' as const,
        licenseTexts: [],
      };
      entry.licenseTexts.push(text.trim());
      crates.set(key, entry);
    }
  }
  return [...crates.values()];
}

/** Merges packages, removes duplicate texts and sorts stably. */
export function buildLicenseList(packages: CollectedPackage[], generated: string): LicenseList {
  const texts: string[] = [];
  const textIndex = new Map<string, number>();
  const unique = new Map<string, CollectedPackage>();
  for (const pkg of packages) unique.set(`${pkg.origin}:${pkg.name}@${pkg.version}`, pkg);
  const sorted = [...unique.values()].sort(
    (a, b) =>
      collator.compare(a.origin, b.origin) ||
      collator.compare(a.name, b.name) ||
      collator.compare(a.version, b.version),
  );
  return {
    version: 1,
    generated,
    packages: sorted.map(({ licenseTexts, ...pkg }) => ({
      ...pkg,
      texts: [...new Set(licenseTexts)].map((text) => {
        let index = textIndex.get(text);
        if (index === undefined) {
          index = texts.push(text) - 1;
          textIndex.set(text, index);
        }
        return index;
      }),
    })),
    texts,
  };
}

export interface LicensesOptions {
  /** Date for `generated` (the build date, so the build stays reproducible). */
  generated: string;
  /** Path to the output of `cargo about generate --format json`; without it only the web packages. */
  serverLicenses?: string | undefined;
  /**
   * Packages whose code is copied into the bundle without appearing in the module
   * graph (e.g. the runtime Paraglide generates into src/lib/paraglide).
   */
  include?: string[];
}

export function licenses(options: LicensesOptions): Plugin {
  let root = process.cwd();
  // Collected across all build environments: SvelteKit builds the service worker
  // as its own environment (`consumer: 'client'`) into the same `outDir` as the
  // client; each environment rewrites licenses.json, so the last one written
  // must list all packages.
  let roots: Set<string> | undefined;
  return {
    name: 'roedy:licenses',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_output, bundle) {
      roots ??= new Set<string>((options.include ?? []).map((name) => resolvePackageRoot([name])));
      for (const file of Object.values(bundle)) {
        const ids = file.type === 'chunk' ? file.moduleIds : file.originalFileNames;
        for (const id of ids) {
          // Original file names of assets are relative to the Vite root
          const packageRoot = packageRootOf(id);
          if (packageRoot) roots.add(resolve(root, packageRoot));
          const virtual = VIRTUAL_MODULES.find(([prefix]) => id.startsWith(prefix));
          if (virtual) roots.add(resolvePackageRoot(virtual[1]));
        }
      }
      const packages = [...roots].flatMap((packageRoot) => readPackage(packageRoot) ?? []);
      if (options.serverLicenses) {
        packages.push(...readCargoAbout(readFileSync(options.serverLicenses, 'utf8')));
      } else {
        this.info('without Rust crates: ROEDY_SERVER_LICENSES not set (build with license list: just web)');
      }
      this.emitFile({
        type: 'asset',
        fileName: 'licenses.json',
        source: `${JSON.stringify(buildLicenseList(packages, options.generated))}\n`,
      });
    },
  };
}
