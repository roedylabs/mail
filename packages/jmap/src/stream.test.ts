import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isJmapError } from './errors.ts';
import { EventStreamParser, type StateChange } from './stream.ts';
import { SERVER, fakeFetch, sessionJson, staticTokens, testClient, type Seen } from './testing.ts';

const STATE = 'event: state\ndata: {"@type":"StateChange","changed":{"a1":{"Email":"s2"}}}\n\n';

/** Response with an event stream; `open` keeps it open until the request aborts. */
function stream(chunks: (string | Uint8Array)[], open = false) {
  return (seen: Seen): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        if (!open) controller.close();
        else seen.signal?.addEventListener('abort', () => controller.error(seen.signal?.reason));
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}

describe('EventStreamParser', () => {
  it('assembles lines and events across chunks', () => {
    const parser = new EventStreamParser();
    const chunks = ['﻿event: sta', 'te\r', '\ndata: {"a":', '1}\r\n', '\r\n: comment\n', 'data:x\ndata: y\n\n'];
    const events = chunks.flatMap((chunk) => parser.push(chunk));
    expect(events).toEqual([
      { event: 'state', data: '{"a":1}', id: '' },
      { event: 'message', data: 'x\ny', id: '' },
    ]);
  });

  it('keeps CR and LF together across an empty chunk', () => {
    // `TextDecoder` returns an empty chunk for a read with only part of a character.
    const parser = new EventStreamParser();
    expect(['data: x\r', '', '\n', 'data: y\n\n'].flatMap((chunk) => parser.push(chunk))).toEqual([
      { event: 'message', data: 'x\ny', id: '' },
    ]);
  });

  it('handles CR as line end, id, retry and events without data', () => {
    const parser = new EventStreamParser();
    expect(parser.push('id: 7\rretry: 5000\revent: ping\r\rdata\r\r')).toEqual([
      { event: 'message', data: '', id: '7' },
    ]);
    expect(parser.retry).toBe(5000);
    expect(parser.push('retry: soon\nevent: empty\n\n')).toEqual([]);
    expect(parser.retry).toBe(5000);
    // An incomplete event at the end does not count.
    expect(parser.push('data: half')).toEqual([]);
  });
});

describe('events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads state changes from bytes, even with a split UTF-8 character', async () => {
    const bytes = new TextEncoder().encode(STATE.replace('s2', 'ä2'));
    const cut = bytes.indexOf(0xc3) + 1;
    const server = fakeFetch(stream([bytes.slice(0, 10), bytes.slice(10, cut), bytes.slice(cut)]));
    const controller = new AbortController();
    const changes: StateChange[] = [];
    const onOpen = vi.fn();
    await testClient(server.fetch).events({
      signal: controller.signal,
      onOpen,
      onState: (change) => {
        changes.push(change);
        controller.abort();
      },
    });

    expect(changes).toEqual([{ '@type': 'StateChange', changed: { a1: { Email: 'ä2' } } }]);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(server.seen[0]?.url).toBe(`${SERVER}/jmap/eventsource/?types=%2A&closeafter=state&ping=30`);
    expect(server.seen[0]?.headers.get('Accept')).toBe('text/event-stream');
    expect(server.seen[0]?.headers.get('Authorization')).toBe('Bearer t1');
  });

  it('reconnects immediately after closeafter=state, after errors with backoff and Retry-After', async () => {
    const server = fakeFetch(
      stream([STATE]),
      new Response(null, { status: 503 }),
      new Response(null, { status: 429, headers: { 'Retry-After': '20' } }),
      stream([STATE]),
    );
    const controller = new AbortController();
    const onState = vi.fn(() => {
      if (onState.mock.calls.length === 2) controller.abort();
    });
    const onError = vi.fn();
    const done = testClient(server.fetch).events({
      signal: controller.signal,
      onState,
      onError,
      types: ['Email', 'Mailbox'],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(server.seen).toHaveLength(2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'status', status: 503 }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.seen).toHaveLength(3);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'throttled' }), 20_000);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(server.seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(onState).toHaveBeenCalledTimes(2);
    expect(server.seen[0]?.url).toContain('types=Email%2CMailbox');
  });

  it('waits out the token provider lockout', async () => {
    const tokens = staticTokens(Date.now() + 45_000);
    const server = fakeFetch(() => Promise.reject(new TypeError('offline')), stream([STATE]));
    const controller = new AbortController();
    const onError = vi.fn();
    const done = testClient(server.fetch, { tokens }).events({
      signal: controller.signal,
      onError,
      onState: () => controller.abort(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreachable' }), 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await done;
    expect(server.seen).toHaveLength(2);
  });

  it('counts a stream without events as an error and follows retry after success', async () => {
    const server = fakeFetch(stream([]), stream(['retry: 5000\n', STATE]), stream([STATE]));
    const controller = new AbortController();
    const onState = vi.fn(() => {
      if (onState.mock.calls.length === 2) controller.abort();
    });
    const onError = vi.fn();
    const done = testClient(server.fetch).events({ signal: controller.signal, onState, onError });

    await vi.advanceTimersByTimeAsync(999);
    expect(server.seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(server.seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalidResponse', details: { detail: 'ended' } }),
      1000,
    );
  });

  it('closes the connection when onState throws', async () => {
    const server = fakeFetch(stream([STATE], true), stream([STATE]));
    const controller = new AbortController();
    const onError = vi.fn();
    let calls = 0;
    const done = testClient(server.fetch).events({
      signal: controller.signal,
      onError,
      onState: () => {
        if (++calls === 1) throw new Error('state broken');
        controller.abort();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'state broken' }), 1000);
    expect(server.seen[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
  });

  it('adjusts the watchdog to the interval the server states', async () => {
    const server = fakeFetch(stream(['event: ping\ndata: {"interval":10}\n\n'], true), stream([STATE]));
    const controller = new AbortController();
    const onError = vi.fn();
    const done = testClient(server.fetch).events({
      signal: controller.signal,
      ping: 1,
      onError,
      onState: () => controller.abort(),
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ details: { detail: 'ping' } }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
  });

  it('reconnects when ping stays away', async () => {
    const server = fakeFetch(stream([': open\n'], true), stream([STATE]));
    const controller = new AbortController();
    const onError = vi.fn();
    const done = testClient(server.fetch).events({
      signal: controller.signal,
      ping: 1,
      onError,
      onState: () => controller.abort(),
    });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unreachable', details: { detail: 'ping' } }),
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(server.seen[0]?.url).toContain('ping=1');
  });

  it('ends without an error when the signal aborts', async () => {
    const server = fakeFetch(stream([': open\n'], true));
    const controller = new AbortController();
    const onError = vi.fn();
    const done = testClient(server.fetch).events({ signal: controller.signal, onError, onState: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a server without eventSourceUrl as unsupported', async () => {
    const client = testClient(fakeFetch().fetch, { session: sessionJson({ eventSourceUrl: undefined }) });
    const error: unknown = await client
      .events({ signal: new AbortController().signal, onState: () => {} })
      .catch((e: unknown) => e);
    expect(isJmapError(error, 'unsupported')).toBe(true);
  });
});
