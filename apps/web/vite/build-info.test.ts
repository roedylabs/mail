import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInfoDefines, resolveBuildInfo } from './build-info.ts';

const rootVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const fakeGit = (answers: Record<string, string>) => (args: string[]) => answers[args[0]!];
const noGit = () => undefined;

describe('resolveBuildInfo', () => {
  it('takes values from the environment (CI, Docker)', () => {
    const info = resolveBuildInfo(
      { ROEDY_VERSION: 'v0.3.0', ROEDY_BUILD_SHA: '7f3c2a1d9e8b', ROEDY_BUILD_DATE: '2026-10-14T08:30:00+02:00' },
      fakeGit({ 'rev-parse': 'ignored' }),
    );
    expect(info).toEqual({ version: '0.3.0', sha: '7f3c2a1', date: '2026-10-14T06:30:00.000Z' });
  });

  it('falls back to package.json and Git', () => {
    const info = resolveBuildInfo({}, fakeGit({ 'rev-parse': 'abc1234', log: '2026-10-23T19:58:23+02:00' }));
    expect(info).toEqual({ version: rootVersion, sha: 'abc1234', date: '2026-10-23T17:58:23.000Z' });
  });

  it('understands SOURCE_DATE_EPOCH', () => {
    expect(resolveBuildInfo({ SOURCE_DATE_EPOCH: '1792713600' }, noGit).date).toBe('2026-10-23T00:00:00.000Z');
  });

  it('leaves the commit empty without Git', () => {
    expect(resolveBuildInfo({ ROEDY_BUILD_DATE: '2026-10-23' }, noGit).sha).toBe('');
  });

  it('fails on an invalid date', () => {
    expect(() => resolveBuildInfo({ ROEDY_BUILD_DATE: 'yesterday' }, noGit)).toThrow('ROEDY_BUILD_DATE');
    expect(() => resolveBuildInfo({ SOURCE_DATE_EPOCH: '1,5' }, noGit)).toThrow('SOURCE_DATE_EPOCH');
    // Milliseconds instead of seconds
    expect(() => resolveBuildInfo({ SOURCE_DATE_EPOCH: '1792713600000' }, noGit)).toThrow('SOURCE_DATE_EPOCH');
  });

  it('warns when only the current time is left', () => {
    const warnings: string[] = [];
    const info = resolveBuildInfo({}, noGit, (message) => warnings.push(message));
    expect(Number.isNaN(Date.parse(info.date))).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe('buildInfoDefines', () => {
  it('returns JSON literals for import.meta.env', () => {
    expect(buildInfoDefines({ version: '0.1.0', sha: '', date: '2026-10-23T00:00:00.000Z' })).toEqual({
      'import.meta.env.ROEDY_VERSION': '"0.1.0"',
      'import.meta.env.ROEDY_BUILD_SHA': '""',
      'import.meta.env.ROEDY_BUILD_DATE': '"2026-10-23T00:00:00.000Z"',
    });
  });
});
