import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PREFIX } from './app-shell.ts';
import { CACHE_VERSION_KEY, applyCacheVersion, type ClientCacheEnv } from './client-cache.ts';

function fakeEnv(names = [`${SHELL_PREFIX}1`, 'other']) {
  const refill = vi.fn();
  const remove = vi.fn((name: string) => Promise.resolve(names.includes(name)));
  const dropMail = vi.fn(() => Promise.resolve());
  const env: ClientCacheEnv = {
    storage: () => localStorage,
    caches: () => ({ keys: () => Promise.resolve(names), delete: remove }),
    refill,
    dropMail,
  };
  return { env, refill, remove, dropMail };
}

beforeEach(() => {
  localStorage.clear();
});

describe('applyCacheVersion', () => {
  it('clears the mail store with a new version, not the first time', async () => {
    localStorage.removeItem(CACHE_VERSION_KEY);
    const { env, dropMail } = fakeEnv();
    await applyCacheVersion(3, env);
    expect(dropMail).not.toHaveBeenCalled();
    await applyCacheVersion(3, env);
    expect(dropMail).not.toHaveBeenCalled();
    await applyCacheVersion(4, env);
    expect(dropMail).toHaveBeenCalledTimes(1);
    await applyCacheVersion(5, { ...env, caches: () => null });
    expect(dropMail).toHaveBeenCalledTimes(2);
  });

  it('remembers the version the first time without deleting anything', async () => {
    const { env, remove, refill } = fakeEnv();
    await applyCacheVersion(3, env);
    expect(localStorage.getItem(CACHE_VERSION_KEY)).toBe('3');
    expect(remove).not.toHaveBeenCalled();
    expect(refill).not.toHaveBeenCalled();
  });

  it('keeps the cache for the same version', async () => {
    localStorage.setItem(CACHE_VERSION_KEY, '3');
    const { env, remove } = fakeEnv();
    await applyCacheVersion(3, env);
    expect(remove).not.toHaveBeenCalled();
  });

  it('clears the app shell cache for a new version and has it refilled', async () => {
    localStorage.setItem(CACHE_VERSION_KEY, '3');
    const { env, remove, refill } = fakeEnv();
    await applyCacheVersion(4, env);
    expect(remove.mock.calls).toEqual([[`${SHELL_PREFIX}1`]]);
    expect(refill).toHaveBeenCalledOnce();
    expect(localStorage.getItem(CACHE_VERSION_KEY)).toBe('4');
  });

  it('treats a lower version after a restore as new too', async () => {
    localStorage.setItem(CACHE_VERSION_KEY, '9');
    const { env, remove } = fakeEnv();
    await applyCacheVersion(2, env);
    expect(remove).toHaveBeenCalled();
  });

  it('stays quiet when a store is missing or blocked', async () => {
    const { env } = fakeEnv();
    await expect(applyCacheVersion(1, { ...env, storage: () => null })).resolves.toBeUndefined();
    const blocked = {
      ...env,
      storage: () => {
        throw new Error('blocked');
      },
    };
    await expect(applyCacheVersion(1, blocked)).resolves.toBeUndefined();
    await expect(applyCacheVersion(1, { ...env, caches: () => null })).resolves.toBeUndefined();
  });
});
