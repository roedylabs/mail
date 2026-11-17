import { describe, expect, it, vi } from 'vitest';
import { BLOB, CONTACTS, CORE, MAIL, SUBMISSION } from './core.ts';
import { JmapError, MethodError, isJmapError } from './errors.ts';
import { capabilityOf } from './methods.ts';
import {
  SERVER,
  bodyOf,
  fakeFetch,
  jmapResponse,
  jsonResponse,
  sessionJson,
  staticTokens,
  testClient,
} from './testing.ts';

describe('Batch', () => {
  it('sends several calls with a back-reference and returns the response per call', async () => {
    const server = fakeFetch(
      jmapResponse(
        's1',
        [
          'Email/query',
          { accountId: 'a1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: ['e1'] },
          'c0',
        ],
        ['Email/get', { accountId: 'a1', state: 'm1', list: [{ id: 'e1', subject: 'Hello' }], notFound: [] }, 'c1'],
      ),
    );
    const client = testClient(server.fetch);
    const batch = client.batch();
    const query = batch.call('Email/query', { accountId: 'a1', filter: { inMailbox: 'inbox' }, limit: 20 });
    const get = batch.call('Email/get', { accountId: 'a1', '#ids': query.ref('/ids'), properties: ['id', 'subject'] });
    const response = await batch.send();

    expect(response.get(query).ids).toEqual(['e1']);
    expect(response.get(get).list[0]?.subject).toBe('Hello');
    const [seen] = server.seen;
    expect(seen?.url).toBe(`${SERVER}/jmap/`);
    expect(seen?.method).toBe('POST');
    expect(seen?.headers.get('Authorization')).toBe('Bearer t1');
    expect(bodyOf(seen)).toEqual({
      using: [CORE, MAIL],
      methodCalls: [
        ['Email/query', { accountId: 'a1', filter: { inMailbox: 'inbox' }, limit: 20 }, 'c0'],
        [
          'Email/get',
          {
            accountId: 'a1',
            '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
            properties: ['id', 'subject'],
          },
          'c1',
        ],
      ],
    });
  });

  it('sends with keepalive when requested', async () => {
    const reply = () => jmapResponse('s1', ['Email/set', { accountId: 'a1', oldState: 'm1', newState: 'm2' }, 'c0']);
    const server = fakeFetch(reply(), reply());
    const client = testClient(server.fetch);
    for (const keepalive of [true, false]) {
      const batch = client.batch();
      batch.call('Email/set', { accountId: 'a1', update: { e1: { 'keywords/$seen': true } } });
      await batch.send(undefined, { keepalive });
    }
    expect(server.seen.map((s) => s.keepalive)).toEqual([true, false]);
  });

  it('reports errors per method without losing the other responses', async () => {
    const server = fakeFetch(
      jmapResponse(
        's1',
        ['Mailbox/get', { accountId: 'a1', state: 'b1', list: [], notFound: [] }, 'c0'],
        ['error', { type: 'invalidResultReference', description: 'unknown path' }, 'c1'],
      ),
    );
    const client = testClient(server.fetch);
    const batch = client.batch();
    const mailboxes = batch.call('Mailbox/get', { accountId: 'a1' });
    const threads = batch.call('Thread/get', { accountId: 'a1', '#ids': mailboxes.ref('/list/*/id') });
    const response = await batch.send();

    expect(response.get(mailboxes).state).toBe('b1');
    const result = response.result(threads);
    expect(result.ok).toBe(false);
    expect(() => response.get(threads)).toThrow(MethodError);
    if (!result.ok) {
      expect(result.error.type).toBe('invalidResultReference');
      expect(result.error.method).toBe('Thread/get');
      expect(result.error.details.description).toBe('unknown path');
    }
  });

  it('takes the response with the call name when several share the same id', async () => {
    const server = fakeFetch(
      jmapResponse(
        's1',
        ['Email/set', { accountId: 'a1', newState: 'm2' }, 'c0'],
        ['Identity/get', { accountId: 'a1', state: 'i1', list: [], notFound: [] }, 'c0'],
      ),
    );
    const client = testClient(server.fetch, {
      session: sessionJson({ capabilities: { [CORE]: {}, [MAIL]: {}, [SUBMISSION]: {} } }),
    });
    const batch = client.batch();
    const call = batch.call('Identity/get', { accountId: 'a1' });
    expect((await batch.send()).get(call).state).toBe('i1');
  });

  it('returns implicit responses under the id of a call', async () => {
    const server = fakeFetch(
      jmapResponse(
        's1',
        ['EmailSubmission/set', { accountId: 'a1', newState: 's2', created: { sub: { id: 'S1' } } }, 'c0'],
        ['Email/set', { accountId: 'a1', newState: 'm2', updated: { E1: null } }, 'c0'],
      ),
    );
    const client = testClient(server.fetch, {
      session: sessionJson({ capabilities: { [CORE]: {}, [MAIL]: {}, [SUBMISSION]: {} } }),
    });
    const batch = client.batch();
    const call = batch.call('EmailSubmission/set', {
      accountId: 'a1',
      create: { sub: { identityId: 'I1', emailId: 'E1' } },
      onSuccessUpdateEmail: { '#sub': { 'keywords/$draft': null } },
    });
    const response = await batch.send();
    expect(response.get(call).created?.['sub']?.id).toBe('S1');
    expect(response.implicit(call, 'Email/set')?.updated).toEqual({ E1: null });
    expect(response.implicit(call, 'Mailbox/set')).toBeNull();
  });

  it('rejects back-references to other requests and duplicate arguments', () => {
    const client = testClient(fakeFetch().fetch);
    const first = client.batch().call('Email/query', { accountId: 'a1' });
    const batch = client.batch();
    expect(() => batch.call('Email/get', { accountId: 'a1', '#ids': first.ref('/ids') })).toThrow(TypeError);
    const query = batch.call('Email/query', { accountId: 'a1' });
    expect(() => batch.call('Email/get', { accountId: 'a1', ids: ['e1'], '#ids': query.ref('/ids') })).toThrow(
      TypeError,
    );
  });

  it('does not send when the server lacks a capability or limits are exceeded', async () => {
    const server = fakeFetch();
    const client = testClient(server.fetch);
    await expect(client.call('Identity/get', { accountId: 'a1' })).rejects.toMatchObject({
      kind: 'unsupported',
      details: { capability: SUBMISSION },
    });
    const batch = client.batch();
    for (let i = 0; i < 9; i++) batch.call('Core/echo', { i });
    await expect(batch.send()).rejects.toMatchObject({ kind: 'request', details: { limit: 'maxCallsInRequest' } });
    expect(server.seen).toHaveLength(0);
  });
});

describe('request errors', () => {
  it('fetches a new token once on 401 and repeats the request', async () => {
    const tokens = staticTokens();
    const server = fakeFetch(new Response(null, { status: 401 }), jmapResponse('s1', ['Core/echo', { x: 1 }, 'c0']));
    const client = testClient(server.fetch, { tokens });

    expect(await client.call('Core/echo', { x: 1 })).toEqual({ x: 1 });
    expect(tokens.requests.map((r) => r.rejected)).toEqual([undefined, 't1']);
    expect(server.seen.map((s) => s.headers.get('Authorization'))).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('reports 401 with the new token as auth, without further attempts', async () => {
    const server = fakeFetch(new Response(null, { status: 401 }), new Response(null, { status: 401 }));
    const client = testClient(server.fetch);
    await expect(client.call('Core/echo', {})).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(server.seen).toHaveLength(2);
  });

  it('passes token provider errors on unchanged', async () => {
    const failure = new Error('needs_reauth');
    const client = testClient(fakeFetch().fetch, { tokens: { token: () => Promise.reject(failure) } });
    await expect(client.call('Core/echo', {})).rejects.toBe(failure);
  });

  it('reads rejected requests as Problem Details (RFC 7807)', async () => {
    const server = fakeFetch(
      jsonResponse({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeRequest', status: 400 }, 400, {
        'Content-Type': 'application/problem+json',
      }),
    );
    const error: unknown = await testClient(server.fetch)
      .call('Core/echo', {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JmapError);
    expect(error).toMatchObject({ kind: 'request', details: { type: 'limit', limit: 'maxSizeRequest', status: 400 } });
  });

  it('reports 429 with Retry-After and other statuses', async () => {
    const server = fakeFetch(
      new Response(null, { status: 429, headers: { 'Retry-After': '7' } }),
      new Response('broken', { status: 503 }),
      new Response(null, { status: 403 }),
    );
    const client = testClient(server.fetch);
    await expect(client.call('Core/echo', {})).rejects.toMatchObject({ kind: 'throttled', retryAfter: 7 });
    await expect(client.call('Core/echo', {})).rejects.toMatchObject({ kind: 'status', status: 503 });
    await expect(client.call('Core/echo', {})).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('distinguishes network errors, aborts and unreadable responses', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const unreachable: unknown = await testClient(offline.fetch)
      .call('Core/echo', {})
      .catch((e: unknown) => e);
    expect(isJmapError(unreachable, 'unreachable')).toBe(true);
    expect((unreachable as Error).cause).toBeInstanceOf(TypeError);

    const controller = new AbortController();
    const hanging = fakeFetch(
      (seen) =>
        new Promise<Response>((_, reject) => {
          seen.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = testClient(hanging.fetch).call('Core/echo', {}, controller.signal);
    await vi.waitFor(() => expect(hanging.seen).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const slow = fakeFetch(
      (seen) =>
        new Promise<Response>((_, reject) => {
          seen.signal?.addEventListener('abort', () => reject(seen.signal?.reason as Error));
        }),
    );
    await expect(testClient(slow.fetch, { timeout: 20 }).call('Core/echo', {})).rejects.toMatchObject({
      kind: 'unreachable',
      details: { detail: 'timeout' },
    });

    const broken = fakeFetch(new Response('<html>', { status: 200 }), jsonResponse({ methodResponses: [['x']] }));
    await expect(testClient(broken.fetch).call('Core/echo', {})).rejects.toMatchObject({ kind: 'invalidResponse' });
    await expect(testClient(broken.fetch).call('Core/echo', {})).rejects.toMatchObject({ kind: 'invalidResponse' });
  });
});

describe('session', () => {
  it('reloads the session when sessionState differs', async () => {
    const onSession = vi.fn();
    const server = fakeFetch(
      jmapResponse('s2', ['Core/echo', {}, 'c0']),
      jsonResponse(sessionJson({ state: 's2', username: 'new@example.test' })),
      jmapResponse('s2', ['Core/echo', {}, 'c1']),
    );
    const client = testClient(server.fetch, { onSession });
    await client.call('Core/echo', {});
    await client.call('Core/echo', {});

    expect(server.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${SERVER}/jmap/`,
      `GET ${SERVER}/.well-known/jmap`,
      `POST ${SERVER}/jmap/`,
    ]);
    expect(server.seen[1]?.headers.get('Authorization')).toBe('Bearer t1');
    expect(onSession).toHaveBeenCalledOnce();
    expect(client.currentSession?.username).toBe('new@example.test');
  });

  it('keeps working with the previous session when the reload fails', async () => {
    const server = fakeFetch(
      jmapResponse('s2', ['Core/echo', {}, 'c0']),
      () => Promise.reject(new TypeError('CORS')),
      jmapResponse('s2', ['Core/echo', {}, 'c1']),
      jmapResponse('s2', ['Core/echo', {}, 'c2']),
    );
    const client = testClient(server.fetch);
    await client.call('Core/echo', {});
    await client.call('Core/echo', {});
    // No new attempt within a minute.
    await client.call('Core/echo', {});
    expect(server.seen.map((s) => s.method)).toEqual(['POST', 'GET', 'POST', 'POST']);
    expect(client.currentSession?.state).toBe('s1');
  });

  it('loads once without a known session, even with concurrent calls', async () => {
    const server = fakeFetch(jsonResponse(sessionJson()));
    const client = testClient(server.fetch, { session: { broken: true } });
    const [a, b] = await Promise.all([client.accountId(), client.accountId(MAIL)]);
    expect([a, b]).toEqual(['a1', 'a1']);
    expect(server.seen).toHaveLength(1);
    await expect(client.accountId(SUBMISSION)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('discards a broker session with path-relative URLs and loads it from the server', async () => {
    const server = fakeFetch(jsonResponse(sessionJson()), jmapResponse('s1', ['Core/echo', {}, 'c0']));
    const client = testClient(server.fetch, { session: sessionJson({ eventSourceUrl: 'eventsource/?types={types}' }) });
    await client.call('Core/echo', {});
    expect(server.seen.map((s) => s.method)).toEqual(['GET', 'POST']);
  });

  it('names the RFC 9404 capability for Blob methods except Blob/copy', () => {
    expect(capabilityOf('Blob/copy')).toBe(CORE);
    expect(capabilityOf('Blob/get')).toBe(BLOB);
    expect(capabilityOf('Foo/get')).toBeUndefined();
  });

  it('names the RFC 9610 capability for contact cards', () => {
    expect(capabilityOf('ContactCard/query')).toBe(CONTACTS);
  });

  it('does not follow a redirect to another origin', async () => {
    const redirected = jsonResponse(sessionJson());
    Object.defineProperty(redirected, 'url', { value: 'https://other.example.test/jmap/session' });
    const client = testClient(fakeFetch(redirected).fetch, { session: undefined });
    await expect(client.session()).rejects.toMatchObject({ kind: 'foreignOrigin' });
  });

  it('sends no token to another origin', async () => {
    const tokens = staticTokens();
    const server = fakeFetch();
    const client = testClient(server.fetch, { tokens });
    await expect(client.authFetch('https://other.example.test/x')).rejects.toMatchObject({ kind: 'foreignOrigin' });
    expect(tokens.requests).toHaveLength(0);
    expect(server.seen).toHaveLength(0);
  });
});

describe('timeout', () => {
  const hanging = () =>
    fakeFetch(
      (seen) =>
        new Promise<Response>((_, reject) => {
          seen.signal?.addEventListener('abort', () => reject(seen.signal?.reason as Error));
        }),
    );

  it('does not count the wait for the token', async () => {
    const server = fakeFetch(jmapResponse('s1', ['Core/echo', {}, 'c0']));
    const tokens = { token: () => new Promise<string>((resolve) => setTimeout(() => resolve('t1'), 60)) };
    expect(await testClient(server.fetch, { tokens, timeout: 30 }).call('Core/echo', {})).toEqual({});
  });

  it('also applies to loading the session', async () => {
    const client = testClient(hanging().fetch, { session: undefined, timeout: 20 });
    await expect(client.session()).rejects.toMatchObject({ kind: 'unreachable', details: { detail: 'timeout' } });
  });

  it('does not throw synchronously for an already aborted signal and leaves no unhandled rejection', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('offline')));
    const client = testClient(offline.fetch, { session: undefined });
    const controller = new AbortController();
    controller.abort();
    let pending: Promise<unknown> | undefined;
    expect(() => (pending = client.session(controller.signal))).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(offline.seen).toHaveLength(1));
  });
});

describe('concurrency limit', () => {
  it('drops an aborted call from the queue', async () => {
    let release: () => void = () => {};
    const server = fakeFetch(
      () => new Promise<Response>((resolve) => (release = () => resolve(jmapResponse('s1', ['Core/echo', {}, 'c0'])))),
      jmapResponse('s1', ['Core/echo', {}, 'c2']),
    );
    const capabilities = { [CORE]: { maxConcurrentRequests: 1 }, [MAIL]: {} };
    const client = testClient(server.fetch, { session: sessionJson({ capabilities }) });
    const first = client.call('Core/echo', {});
    const controller = new AbortController();
    const queued = client.call('Core/echo', {}, controller.signal);
    const third = client.call('Core/echo', {});
    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
    await third;
    expect(server.seen).toHaveLength(2);
  });

  it('sends at most maxConcurrentRequests at a time', async () => {
    const release: (() => void)[] = [];
    const later = (id: string) => () =>
      new Promise<Response>((resolve) => release.push(() => resolve(jmapResponse('s1', ['Core/echo', {}, id]))));
    const server = fakeFetch(later('c0'), later('c1'));
    const capabilities = { [CORE]: { maxConcurrentRequests: 1 }, [MAIL]: {} };
    const client = testClient(server.fetch, { session: sessionJson({ capabilities }) });

    const first = client.call('Core/echo', {});
    const second = client.call('Core/echo', {});
    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    await Promise.resolve();
    expect(server.seen).toHaveLength(1);
    release.shift()?.();
    await first;
    await vi.waitFor(() => expect(server.seen).toHaveLength(2));
    release.shift()?.();
    await second;
  });

  it('does not make a keepalive request wait', async () => {
    const release: (() => void)[] = [];
    const server = fakeFetch(
      () =>
        new Promise<Response>((resolve) => release.push(() => resolve(jmapResponse('s1', ['Core/echo', {}, 'c0'])))),
      jmapResponse('s1', ['Core/echo', {}, 'c1']),
    );
    const capabilities = { [CORE]: { maxConcurrentRequests: 1 }, [MAIL]: {} };
    const client = testClient(server.fetch, { session: sessionJson({ capabilities }) });

    const first = client.call('Core/echo', {});
    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    const batch = client.batch();
    batch.call('Core/echo', {});
    await batch.send(undefined, { keepalive: true });
    expect(server.seen.map((s) => s.keepalive)).toEqual([false, true]);
    release.shift()?.();
    await first;
  });
});

describe('Blobs', () => {
  it('downloads blobs via the template with encoded values', async () => {
    const server = fakeFetch(new Response('content', { status: 200 }));
    const blob = await testClient(server.fetch).download({
      accountId: 'a1',
      blobId: 'B/1',
      name: 'Résumé (draft).pdf',
      type: 'application/pdf',
    });
    expect(await blob.text()).toBe('content');
    expect(server.seen[0]?.url).toBe(
      `${SERVER}/jmap/download/a1/B%2F1/R%C3%A9sum%C3%A9%20%28draft%29.pdf?accept=application%2Fpdf`,
    );
    expect(server.seen[0]?.headers.get('Authorization')).toBe('Bearer t1');
  });

  it('keeps downloaded blobs out of the HTTP cache', async () => {
    const server = fakeFetch(new Response('content', { status: 200, headers: { 'Cache-Control': 'max-age=3600' } }));
    await testClient(server.fetch).download({ accountId: 'a1', blobId: 'b1' });
    expect(server.seen[0]?.cache).toBe('no-store');
  });

  it('reports a missing blob with its status', async () => {
    const server = fakeFetch(new Response(null, { status: 404 }));
    await expect(testClient(server.fetch).download({ accountId: 'a1', blobId: 'x' })).rejects.toMatchObject({
      kind: 'status',
      status: 404,
    });
  });

  it('uploads and checks the size beforehand', async () => {
    const server = fakeFetch(jsonResponse({ accountId: 'a1', blobId: 'b9', type: 'text/plain', size: 5 }, 201));
    const client = testClient(server.fetch);
    expect(await client.upload('a1', 'Hello', 'text/plain')).toEqual({
      accountId: 'a1',
      blobId: 'b9',
      type: 'text/plain',
      size: 5,
    });
    expect(server.seen[0]).toMatchObject({ url: `${SERVER}/jmap/upload/a1/`, method: 'POST', body: 'Hello' });
    expect(server.seen[0]?.headers.get('Content-Type')).toBe('text/plain');

    await expect(client.upload('a1', new Uint8Array(1001))).rejects.toMatchObject({
      kind: 'request',
      details: { limit: 'maxSizeUpload' },
    });
    expect(server.seen).toHaveLength(1);
  });

  it('reports missing session URLs as unsupported', async () => {
    const client = testClient(fakeFetch().fetch, { session: sessionJson({ uploadUrl: undefined }) });
    await expect(client.upload('a1', 'x')).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
