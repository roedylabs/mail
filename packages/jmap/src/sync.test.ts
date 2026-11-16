import { describe, expect, it } from 'vitest';
import { applyQueryChanges, changes, queryChanges } from './sync.ts';
import { bodyOf, fakeFetch, jmapResponse, testClient } from './testing.ts';

const page = (
  oldState: string,
  newState: string,
  more: boolean,
  ids: { c?: string[]; u?: string[]; d?: string[] },
) => ({
  accountId: 'a1',
  oldState,
  newState,
  hasMoreChanges: more,
  created: ids.c ?? [],
  updated: ids.u ?? [],
  destroyed: ids.d ?? [],
});

describe('changes', () => {
  it('combines several pages', async () => {
    const server = fakeFetch(
      jmapResponse('s1', ['Email/changes', page('e1', 'e2', true, { c: ['n1', 'n2'], u: ['u1', 'u2'] }), 'c0']),
      jmapResponse('s1', ['Email/changes', page('e2', 'e3', false, { u: ['n1', 'u3'], d: ['n2', 'u2', 'x1'] }), 'c1']),
    );
    const result = await changes(testClient(server.fetch), 'Email', {
      accountId: 'a1',
      sinceState: 'e1',
      maxChanges: 50,
    });

    expect(result).toEqual({
      reset: false,
      oldState: 'e1',
      newState: 'e3',
      created: ['n1'],
      updated: ['u1', 'u3'],
      destroyed: ['u2', 'x1'],
      updatedProperties: null,
      objects: new Map(),
    });
    expect(server.seen.map((s) => bodyOf(s))).toMatchObject([
      { methodCalls: [['Email/changes', { accountId: 'a1', sinceState: 'e1', maxChanges: 50 }, 'c0']] },
      { methodCalls: [['Email/changes', { accountId: 'a1', sinceState: 'e2', maxChanges: 50 }, 'c1']] },
    ]);
  });

  it('fetches the objects in the same request via back-references', async () => {
    const server = fakeFetch(
      jmapResponse(
        's1',
        [
          'Mailbox/changes',
          { ...page('b1', 'b2', false, { c: ['m3'], u: ['m1'] }), updatedProperties: ['unreadEmails'] },
          'c0',
        ],
        ['Mailbox/get', { accountId: 'a1', state: 'b2', list: [{ id: 'm3', name: 'New' }], notFound: [] }, 'c1'],
        ['Mailbox/get', { accountId: 'a1', state: 'b2', list: [{ id: 'm1', unreadEmails: 4 }], notFound: [] }, 'c2'],
      ),
    );
    const result = await changes(testClient(server.fetch), 'Mailbox', {
      accountId: 'a1',
      sinceState: 'b1',
      fetch: true,
      properties: ['id', 'name', 'unreadEmails'],
    });

    expect(result.reset).toBe(false);
    if (result.reset) return;
    expect(result.updatedProperties).toEqual(['unreadEmails']);
    expect(result.objects.get('m3')?.name).toBe('New');
    expect(result.objects.get('m1')?.unreadEmails).toBe(4);
    const props = ['id', 'name', 'unreadEmails'];
    expect(bodyOf(server.seen[0])).toMatchObject({
      methodCalls: [
        ['Mailbox/changes', { accountId: 'a1', sinceState: 'b1', maxChanges: 100 }, 'c0'],
        [
          'Mailbox/get',
          { '#ids': { resultOf: 'c0', name: 'Mailbox/changes', path: '/created' }, properties: props },
          'c1',
        ],
        [
          'Mailbox/get',
          { '#ids': { resultOf: 'c0', name: 'Mailbox/changes', path: '/updated' }, properties: props },
          'c2',
        ],
      ],
    });
  });

  it('reports reset when the server cannot calculate the changes', async () => {
    const server = fakeFetch(jmapResponse('s1', ['error', { type: 'cannotCalculateChanges' }, 'c0']));
    expect(await changes(testClient(server.fetch), 'Thread', { accountId: 'a1', sinceState: 'old' })).toEqual({
      reset: true,
    });
  });

  it('aborts when a page makes no progress', async () => {
    const server = fakeFetch(jmapResponse('s1', ['Email/changes', page('e1', 'e1', true, {}), 'c0']));
    await expect(
      changes(testClient(server.fetch), 'Email', { accountId: 'a1', sinceState: 'e1' }),
    ).rejects.toMatchObject({
      kind: 'invalidResponse',
    });
    expect(server.seen).toHaveLength(1);
  });

  it('passes other method errors on', async () => {
    const server = fakeFetch(jmapResponse('s1', ['error', { type: 'accountNotFound' }, 'c0']));
    await expect(changes(testClient(server.fetch), 'Email', { accountId: 'x', sinceState: 's' })).rejects.toMatchObject(
      {
        type: 'accountNotFound',
      },
    );
  });
});

describe('queryChanges', () => {
  it('returns the query changes or reset', async () => {
    const response = {
      accountId: 'a1',
      oldQueryState: 'q1',
      newQueryState: 'q2',
      removed: ['e1'],
      added: [{ id: 'e9', index: 0 }],
    };
    const server = fakeFetch(
      jmapResponse('s1', ['Email/queryChanges', response, 'c0']),
      jmapResponse('s1', ['error', { type: 'tooManyChanges' }, 'c1']),
      jmapResponse('s1', ['error', { type: 'cannotCalculateChanges' }, 'c2']),
    );
    const client = testClient(server.fetch);
    const args = {
      accountId: 'a1',
      filter: { inMailbox: 'inbox' },
      sort: [{ property: 'receivedAt' as const, isAscending: false }],
      sinceQueryState: 'q1',
      collapseThreads: true,
    };
    expect(await queryChanges(client, 'Email/queryChanges', args)).toEqual({ ...response, reset: false });
    expect(await queryChanges(client, 'Email/queryChanges', args)).toEqual({ reset: true });
    expect(await queryChanges(client, 'Email/queryChanges', args)).toEqual({ reset: true });
    expect(bodyOf(server.seen[0])).toMatchObject({ methodCalls: [['Email/queryChanges', args, 'c0']] });
  });
});

describe('applyQueryChanges', () => {
  it('removes first and then inserts by ascending index (RFC 8620, 5.6)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const changed = applyQueryChanges(ids, {
      removed: ['b', 'd', 'x'],
      added: [
        { id: 'f', index: 3 },
        { id: 'd', index: 0 },
      ],
    });
    expect(changed).toEqual(['d', 'a', 'c', 'f', 'e']);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops insertions past the known start', () => {
    expect(applyQueryChanges(['a', 'b'], { removed: [], added: [{ id: 'z', index: 7 }] })).toEqual(['a', 'b']);
  });
});
