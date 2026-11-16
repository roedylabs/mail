// Build info (version, commit, date) for import.meta.env.ROEDY_*.
// Environment variables take precedence because CI and the Docker build run without .git.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface BuildInfo {
  version: string;
  sha: string;
  /** ISO-8601, UTC */
  date: string;
}

type Env = Record<string, string | undefined>;

const repoRoot = new URL('../../../', import.meta.url);

function git(args: string[]): string | undefined {
  try {
    const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isoDate(value: string | number, source: string): string {
  const date = new Date(value);
  // Year 1970–9999 – catches e.g. milliseconds instead of seconds in SOURCE_DATE_EPOCH
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 1970 || year > 9999) throw new Error(`${source}: invalid date "${value}"`);
  return date.toISOString();
}

/**
 * - Version: `ROEDY_VERSION` (a leading `v` is dropped), otherwise `version` from the root package.json.
 * - Commit: `ROEDY_BUILD_SHA` (shortened to 7 characters), otherwise `git rev-parse`, otherwise empty.
 * - Date: `ROEDY_BUILD_DATE`, `SOURCE_DATE_EPOCH` or the date of the last commit –
 *   not the build time, so the same source yields the same files.
 *   Only without all three the current time applies (with a warning).
 */
export function resolveBuildInfo(
  env: Env = process.env,
  readGit: (args: string[]) => string | undefined = git,
  warn: (message: string) => void = console.warn,
): BuildInfo {
  const rootPackage = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as { version: string };
  const version = (env.ROEDY_VERSION || rootPackage.version).replace(/^v/, '');
  const sha = (env.ROEDY_BUILD_SHA || readGit(['rev-parse', '--short=7', 'HEAD']) || '').slice(0, 7);
  let date: string;
  if (env.ROEDY_BUILD_DATE) date = isoDate(env.ROEDY_BUILD_DATE, 'ROEDY_BUILD_DATE');
  else if (env.SOURCE_DATE_EPOCH) {
    const seconds = Number(env.SOURCE_DATE_EPOCH);
    if (!Number.isInteger(seconds)) throw new Error(`SOURCE_DATE_EPOCH: invalid "${env.SOURCE_DATE_EPOCH}"`);
    date = isoDate(seconds * 1000, 'SOURCE_DATE_EPOCH');
  } else {
    const commitDate = readGit(['log', '-1', '--format=%cI']);
    if (commitDate) date = isoDate(commitDate, 'git log');
    else {
      date = new Date().toISOString();
      warn('Build info: neither ROEDY_BUILD_DATE nor SOURCE_DATE_EPOCH nor Git – the date is the current time');
    }
  }
  return { version, sha, date };
}

/** Replacements for `define` in the Vite config. */
export function buildInfoDefines(info: BuildInfo): Record<string, string> {
  return {
    'import.meta.env.ROEDY_VERSION': JSON.stringify(info.version),
    'import.meta.env.ROEDY_BUILD_SHA': JSON.stringify(info.sha),
    'import.meta.env.ROEDY_BUILD_DATE': JSON.stringify(info.date),
  };
}
