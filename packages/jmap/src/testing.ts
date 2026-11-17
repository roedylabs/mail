/** For tests only: fake mail server behind `fetch` and a fixed token provider. */

import { JmapClient, type ClientOptions } from './client.ts';
import { CORE, MAIL, type Invocation } from './core.ts';
import type { TokenProvider, TokenRequest } from './token.ts';

export const SERVER = 'https://mail.example.test';

/** A request as the fake server saw it. */
export interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
  keepalive: boolean;
  cache: RequestCache | null;
}

export type Reply = Response | ((seen: Seen) => Response | Promise<Response>);

/** `fetch` that returns the replies in order and records every request. */
export function fakeFetch(...replies: Reply[]): { fetch: typeof fetch; seen: Seen[]; queue: Reply[] } {
  const seen: Seen[] = [];
  const queue = [...replies];
  const fake = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const entry: Seen = {
      url: input instanceof Request ? input.url : String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body ?? null,
      signal: init.signal ?? null,
      keepalive: init.keepalive ?? false,
      cache: init.cache ?? null,
    };
    seen.push(entry);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request: ${entry.method} ${entry.url}`);
    return typeof reply === 'function' ? reply(entry) : reply;
  };
  return { fetch: fake, seen, queue };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Response to a request to `apiUrl`. */
export function jmapResponse(sessionState: string, ...methodResponses: Invocation[]): Response {
  return jsonResponse({ methodResponses, sessionState });
}

/** Body of a recorded request as JSON. */
export function bodyOf(seen: Seen | undefined): unknown {
  if (typeof seen?.body !== 'string') throw new Error('request without JSON body');
  return JSON.parse(seen.body);
}

export function sessionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: {
      [CORE]: {
        maxSizeUpload: 1000,
        maxConcurrentUpload: 2,
        maxSizeRequest: 100_000,
        maxConcurrentRequests: 4,
        maxCallsInRequest: 8,
        maxObjectsInGet: 100,
        maxObjectsInSet: 100,
        collationAlgorithms: ['i;unicode-casemap'],
      },
      [MAIL]: {},
    },
    accounts: { a1: { name: 'user@example.test', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    primaryAccounts: { [MAIL]: 'a1' },
    username: 'user@example.test',
    apiUrl: `${SERVER}/jmap/`,
    downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${SERVER}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 's1',
    ...overrides,
  };
}

/** Token `t1`, `t2` after a rejection; records the requests. */
export function staticTokens(retryAt = 0): TokenProvider & { requests: TokenRequest[] } {
  const requests: TokenRequest[] = [];
  return {
    requests,
    token(request: TokenRequest = {}): Promise<string> {
      requests.push(request);
      return Promise.resolve(request.rejected ? 't2' : 't1');
    },
    retryAt: () => retryAt,
  };
}

export function testClient(fetch: typeof globalThis.fetch, options: Partial<ClientOptions> = {}): JmapClient {
  return new JmapClient({ url: SERVER, tokens: staticTokens(), fetch, session: sessionJson(), ...options });
}
