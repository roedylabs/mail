import { describe, expect, it } from 'vitest';
import { CORE, MAIL, SIEVE } from './core.ts';
import { capabilityOf } from './methods.ts';
import { parseSession } from './session.ts';
import { SIEVE_TYPE, sieveCapability } from './sieve.ts';
import { bodyOf, fakeFetch, jmapResponse, SERVER, sessionJson, testClient } from './testing.ts';

/** Session with `urn:ietf:params:jmap:sieve` on the server and with `account` on account a1. */
function sessionWith(account: Record<string, unknown> | null) {
  const json = sessionJson();
  const accountCapabilities = account ? { [MAIL]: {}, [SIEVE]: account } : { [MAIL]: {} };
  return {
    ...json,
    capabilities: { ...(json.capabilities as object), [SIEVE]: {} },
    accounts: {
      a1: { name: 'user@example.test', isPersonal: true, isReadOnly: false, accountCapabilities },
    },
  };
}

/** Limits as Stalwart v1.0.2 announces them in the session. */
const STALWART = {
  maxSizeScriptName: 512,
  maxSizeScript: 102400,
  maxNumberScripts: 100,
  maxNumberRedirects: 1,
  sieveExtensions: ['fileinto', 'imap4flags', 'copy', 'include', 'mailboxid'],
  implementation: 'Stalwart',
};

describe('sieveCapability', () => {
  it('reads the account limits and extensions', () => {
    expect(sieveCapability(parseSession(sessionWith(STALWART), SERVER), 'a1')).toEqual({
      maxSizeScriptName: 512,
      maxSizeScript: 102400,
      maxNumberScripts: 100,
      maxNumberRedirects: 1,
      sieveExtensions: ['fileinto', 'imap4flags', 'copy', 'include', 'mailboxid'],
    });
  });

  it('returns null and an empty list without the account capability and for an unknown account', () => {
    const none = {
      maxSizeScriptName: null,
      maxSizeScript: null,
      maxNumberScripts: null,
      maxNumberRedirects: null,
      sieveExtensions: [],
    };
    expect(sieveCapability(parseSession(sessionWith(null), SERVER), 'a1')).toEqual(none);
    expect(sieveCapability(parseSession(sessionWith(STALWART), SERVER), 'unknown')).toEqual(none);
    expect(sieveCapability(parseSession(sessionWith({}), SERVER), 'a1')).toEqual(none);
  });

  it('sets invalid limits to null and skips extensions that are not strings', () => {
    const cap = sieveCapability(
      parseSession(
        sessionWith({
          maxSizeScriptName: -1,
          maxSizeScript: '102400',
          maxNumberScripts: null,
          maxNumberRedirects: 0,
          sieveExtensions: ['fileinto', 7, null, 'copy'],
        }),
        SERVER,
      ),
      'a1',
    );
    expect(cap).toEqual({
      maxSizeScriptName: null,
      maxSizeScript: null,
      maxNumberScripts: null,
      // 0 is a valid limit: no redirect allowed.
      maxNumberRedirects: 0,
      sieveExtensions: ['fileinto', 'copy'],
    });
    expect(
      sieveCapability(parseSession(sessionWith({ sieveExtensions: 'fileinto' }), SERVER), 'a1').sieveExtensions,
    ).toEqual([]);
  });
});

describe('SieveScript methods', () => {
  it('belong to urn:ietf:params:jmap:sieve', () => {
    expect(capabilityOf('SieveScript/get')).toBe(SIEVE);
    expect(capabilityOf('SieveScript/set')).toBe(SIEVE);
    expect(capabilityOf('SieveScript/validate')).toBe(SIEVE);
  });

  it('send the capability in using', async () => {
    const server = fakeFetch(
      jmapResponse('s1', ['SieveScript/get', { accountId: 'a1', state: 'x1', list: [], notFound: [] }, 'c0']),
    );
    const client = testClient(server.fetch, { session: sessionWith(STALWART) });
    expect((await client.call('SieveScript/get', { accountId: 'a1' })).list).toEqual([]);
    expect(bodyOf(server.seen[0])).toEqual({
      using: [CORE, SIEVE],
      methodCalls: [['SieveScript/get', { accountId: 'a1' }, 'c0']],
    });
  });

  it('fail without the server capability before a request goes out', async () => {
    const server = fakeFetch();
    const client = testClient(server.fetch);
    await expect(client.call('SieveScript/get', { accountId: 'a1' })).rejects.toMatchObject({ kind: 'unsupported' });
    expect(server.seen).toEqual([]);
  });

  it('use the type application/sieve for the content', () => {
    expect(SIEVE_TYPE).toBe('application/sieve');
  });
});
