// Fixtures of the E2E suite: the Stalwart of the run from
// `$STALWART_URL`/`$STALWART_CREDENTIALS` (scripts/dev/stalwart.sh run)
// and a fresh Roedy instance per spec file – own data directory, own key,
// binary from `$ROEDY_E2E_BIN` (scripts/e2e.sh). Credentials and tokens appear
// in no output: error messages only give names; for traces and snapshots see
// playwright.config.ts.
import { test as base } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

/** Account on the Stalwart (fields as in the header of scripts/dev/stalwart.mjs). */
export interface MailUser {
  name: string;
  login: string;
  email: string;
  password: string;
  appPassword: string;
  accountId: string;
}

export interface Stalwart {
  /** Base URL: issuer, JMAP, OAuth (http://127.0.0.1:18080). */
  url: string;
  domain: string;
  /** Role admin; the app password may register OAuth clients (DCR). */
  admin: MailUser;
  /** Role user. */
  user: MailUser;
}

export interface Instance {
  /** Base URL of the instance, e.g. http://127.0.0.1:18090. */
  url: string;
  /** Setup token like `roedy-mail setup-token` (only before the setup). */
  setupToken(): Promise<string>;
  /** Memory of the process in KiB from `/proc/<pid>/status`: current (VmRSS) and peak (VmHWM); Linux only. */
  memory(): Promise<{ rssKib: number; peakKib: number }>;
}

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} missing – the suite only runs via scripts/e2e.sh`);
  }
  return value;
}

async function readStalwart(): Promise<Stalwart> {
  const url = required('STALWART_URL');
  const credentials = JSON.parse(await readFile(required('STALWART_CREDENTIALS'), 'utf8')) as Stalwart & {
    version: number;
  };
  if (credentials.version !== 1) {
    throw new Error(`$STALWART_CREDENTIALS has version ${credentials.version}, expected 1`);
  }
  return { url, domain: credentials.domain, admin: credentials.admin, user: credentials.user };
}

/** Port from `$E2E_PORT` (default 18090) plus the worker index. */
function portFor(workerIndex: number): number {
  const raw = process.env.E2E_PORT || '18090';
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1 || base + workerIndex > 65535) {
    throw new Error(`E2E_PORT is not a valid port: ${raw}`);
  }
  return base + workerIndex;
}

/** Environment without inherited `ROEDY_*` variables: the instance only gets its own. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROEDY_')));
}

/** Waits until `/readyz` answers 200, or the process exits or fails to start. */
async function waitReady(url: string, child: ChildProcess, failed: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const err = failed();
    if (err) throw new Error(`roedy-mail cannot be started: ${err.message}`);
    if (child.exitCode !== null) throw new Error(`roedy-mail exited with status ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Not started yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`roedy-mail does not respond at ${url}/readyz`);
}

/** Stops the process with SIGTERM, after 10 s with SIGKILL. */
async function stop(child: ChildProcess): Promise<void> {
  // Without a PID the process never started (spawn error), so no `exit` arrives.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await done;
  clearTimeout(timer);
}

/** Backend log lines with WARN or ERROR (text format of tracing). */
export function problems(log: string): string[] {
  return log.split('\n').filter((line) => /\s(WARN|ERROR)\s/.test(line));
}

/** Running instance with everything needed to stop and check it. */
interface Running extends Instance {
  file: string;
  stop(): Promise<string[]>;
}

/** Starts a fresh instance for the spec file `file` (`name` for the log). */
async function start(file: string, name: string, port: number, outputDir: string): Promise<Running> {
  const bin = required('ROEDY_E2E_BIN');
  const url = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'roedy-e2e-'));
  const env = {
    ...cleanEnv(),
    ROEDY_LISTEN: `127.0.0.1:${port}`,
    ROEDY_DATA_DIR: dataDir,
    ROEDY_SECRET_KEY: randomBytes(32).toString('hex'),
    ROEDY_LOG: 'info',
    ROEDY_LOG_FORMAT: 'text',
    NO_COLOR: '1',
    // As in the image (Dockerfile); this way the load test measures its memory.
    MIMALLOC_PURGE_DELAY: '0',
    MIMALLOC_ALLOW_THP: '0',
  };
  // The log stays in test-results/ (in CI as an artifact on failure).
  await mkdir(outputDir, { recursive: true });
  const logPath = join(outputDir, `roedy-${name}.log`);
  const logFile = await open(logPath, 'w');
  const child = spawn(bin, ['serve'], { env, stdio: ['ignore', logFile.fd, logFile.fd] });
  let spawnError: Error | undefined;
  child.once('error', (err) => (spawnError = err));
  const stopAll = async () => {
    await stop(child);
    await logFile.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await waitReady(url, child, () => spawnError);
    const index = await fetch(`${url}/`, { signal: AbortSignal.timeout(2_000) });
    if (!index.ok || !(index.headers.get('content-type') ?? '').startsWith('text/html')) {
      throw new Error(`roedy-mail serves no web app at ${url}/ (${index.status}) – binary without embed-web?`);
    }
  } catch (err) {
    await stopAll();
    throw err;
  }
  return {
    file,
    url,
    async setupToken() {
      const { stdout } = await run(bin, ['setup-token'], { env });
      const token = /Setup-Token: (\S+)/.exec(stdout)?.[1];
      if (!token) throw new Error('roedy-mail setup-token without token');
      return token;
    },
    async memory() {
      const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
      const field = (name: string) => {
        const value = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(status)?.[1];
        if (value === undefined) throw new Error(`${name} missing in /proc/${child.pid}/status`);
        return Number(value);
      };
      return { rssKib: field('VmRSS'), peakKib: field('VmHWM') };
    },
    async stop() {
      await stopAll();
      return problems(await readFile(logPath, 'utf8')).map((line) => `${name}: ${line}`);
    },
  };
}

/**
 * A fresh instance per spec file: the tests of a file share it (the flows
 * build on each other), the next file in the same worker gets a new one. The
 * worker checks the backend log of all instances at the end.
 */
class Instances {
  #current: Running | undefined;
  #problems: string[] = [];

  readonly #port: number;
  readonly #testDir: string;
  readonly #outputDir: string;

  constructor(port: number, testDir: string, outputDir: string) {
    this.#port = port;
    this.#testDir = testDir;
    this.#outputDir = outputDir;
  }

  async for(file: string): Promise<Instance> {
    if (this.#current?.file === file) return this.#current;
    await this.close();
    // Path below e2e/ as name: unique even for equal file names in subfolders.
    const name = relative(this.#testDir, file)
      .replace(/\.spec\.ts$/, '')
      .replaceAll('/', '-');
    this.#current = await start(file, name, this.#port, this.#outputDir);
    return this.#current;
  }

  async close(): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    if (current) this.#problems.push(...(await current.stop()));
  }

  get problems(): string[] {
    return this.#problems;
  }
}

export const test = base.extend<{ instance: Instance }, { stalwart: Stalwart; instances: Instances }>({
  stalwart: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the pattern for fixtures without dependencies.
    async ({}, use) => {
      await use(await readStalwart());
    },
    { scope: 'worker' },
  ],

  instances: [
    // eslint-disable-next-line no-empty-pattern -- as above
    async ({}, use, workerInfo) => {
      const { testDir, outputDir } = workerInfo.project;
      const instances = new Instances(portFor(workerInfo.workerIndex), testDir, outputDir);
      try {
        await use(instances);
      } finally {
        await instances.close();
      }
      if (instances.problems.length > 0) {
        throw new Error(`Backend log with warnings or errors:\n${instances.problems.slice(0, 20).join('\n')}`);
      }
    },
    { scope: 'worker' },
  ],

  instance: async ({ instances }, use, testInfo) => {
    await use(await instances.for(testInfo.file));
  },
});

export { expect } from '@playwright/test';
