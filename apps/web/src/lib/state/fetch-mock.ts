import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Answer = { status?: number; body?: unknown };
type Reply = Answer | ((call: Call) => Answer | Promise<Answer>);

/**
 * Replaces `fetch` for the API: responses per `METHOD path` (e.g. `GET settings`)
 * as a queue, as a function also delayed (Promise); recorded
 * calls in `calls`.
 */
export function mockApi(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetch = vi.fn((input: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const path = input.replace(/^\/api\/v1\//, '');
    const call: Call = {
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const queue = routes[`${method} ${path}`];
    const next = queue?.shift();
    if (!next) return Promise.reject(new Error(`no response for ${method} ${path}`));
    return Promise.resolve(typeof next === 'function' ? next(call) : next).then(
      (reply) =>
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { calls };
}
