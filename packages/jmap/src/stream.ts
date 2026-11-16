/**
 * Push via EventSource (RFC 8620, 7.3), read as a `fetch` stream so that the
 * request can carry an Authorization header (the browser's EventSource cannot
 * set headers): parser for the EventSource format
 * (HTML, "Server-sent events"), reconnect with backoff, `closeafter=state` and
 * a watchdog via `ping`.
 */

import type { Id, Session } from './core.ts';
import { JmapError, isJmapError, isRecord, responseError } from './errors.ts';
import { expandTemplate } from './session.ts';

/** New states per account and data type, e.g. `{ "a1": { "Email": "s42" } }`. */
export interface StateChange {
  '@type': 'StateChange';
  changed: Record<Id, Record<string, string>>;
}

export interface EventsOptions {
  /** Ends the stream; `events()` then returns without an error. */
  signal: AbortSignal;
  onState(change: StateChange): void;
  /**
   * After every connection setup. A change can be missed between two
   * connections – afterwards sync the state with `Foo/changes` (`changes()`).
   */
  onOpen?(): void;
  /** After an error (including a stream that ends without an event), with the wait time until the next attempt in ms. */
  onError?(error: unknown, retryIn: number): void;
  /** Data types (default all, `*`). */
  types?: readonly string[];
  /** `state`: the server closes after every change, the client reconnects immediately (default). */
  closeafter?: 'state' | 'no';
  /** Interval of the `ping` events in seconds (default 30, `0` off); without data after twice that, the client reconnects. */
  ping?: number;
}

/** What the stream needs from the client. */
export interface StreamHost {
  session(signal?: AbortSignal): Promise<Session>;
  authFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response>;
  /** Lockout of the token provider (ms since 1970), otherwise 0. */
  retryAt(): number;
}

const BACKOFF_FIRST = 1000;
const BACKOFF_MAX = 60_000;
/** Grace period for the `ping` watchdog (ms). */
const PING_GRACE = 10_000;

export async function runEvents(host: StreamHost, options: EventsOptions): Promise<void> {
  const { signal } = options;
  let failures = 0;
  let retry: number | undefined;
  while (!signal.aborted) {
    let delay: number;
    try {
      const result = await connect(host, options);
      retry = result.retry ?? retry;
      if (result.received) {
        failures = 0;
        delay = retry ?? 0;
      } else {
        // If nothing arrived (server or proxy closes immediately), it is an error.
        failures++;
        delay = backoff(failures, retry);
        options.onError?.(new JmapError('invalidResponse', { detail: 'ended' }), delay);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (isJmapError(error, 'unsupported') || isJmapError(error, 'foreignOrigin')) throw error;
      failures++;
      const throttled = isJmapError(error) && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
      delay = Math.max(backoff(failures, retry), throttled, host.retryAt() - Date.now());
      options.onError?.(error, delay);
    }
    await sleep(delay, signal);
  }
}

/** One connection until the end of the stream. */
async function connect(host: StreamHost, options: EventsOptions): Promise<{ received: boolean; retry?: number }> {
  const session = await host.session(options.signal);
  if (!session.eventSourceUrl) throw new JmapError('unsupported', { capability: 'eventSourceUrl' });
  const ping = options.ping ?? 30;
  const url = expandTemplate(session.eventSourceUrl, {
    types: (options.types ?? ['*']).join(','),
    closeafter: options.closeafter ?? 'state',
    ping: String(ping),
  });
  // Aborts the connection: after a missing `ping` and at the end (also after errors in `onState`).
  const connection = new AbortController();
  const signal = AbortSignal.any([options.signal, connection.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let limit = ping > 0 ? ping * 2000 + PING_GRACE : 0;
  const watch = (): void => {
    clearTimeout(timer);
    if (limit > 0) timer = setTimeout(() => connection.abort(new JmapError('unreachable', { detail: 'ping' })), limit);
  };
  try {
    watch();
    const res = await host.authFetch(url, { headers: { Accept: 'text/event-stream' }, cache: 'no-store' }, signal);
    if (!res.ok) throw await responseError(res);
    if (!res.body) throw new JmapError('invalidResponse', { detail: 'body' });
    options.onOpen?.();
    const parser = new EventStreamParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let received = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch();
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        received = true;
        if (event.event === 'ping') {
          // The server may change the interval (RFC 8620, 7.3) and states it in `interval`.
          const interval = pingInterval(event.data);
          if (interval !== undefined && limit > 0) {
            limit = interval * 2000 + PING_GRACE;
            watch();
          }
        }
        if (event.event !== 'state') continue;
        const change = parseStateChange(event.data);
        if (change) options.onState(change);
      }
    }
    return parser.retry === undefined ? { received } : { received, retry: parser.retry };
  } catch (error) {
    options.signal.throwIfAborted();
    connection.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    connection.abort();
  }
}

function pingInterval(data: string): number | undefined {
  try {
    const json: unknown = JSON.parse(data);
    return isRecord(json) && typeof json.interval === 'number' && json.interval > 0 ? json.interval : undefined;
  } catch {
    return undefined;
  }
}

function parseStateChange(data: string): StateChange | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  return isRecord(json) && json['@type'] === 'StateChange' && isRecord(json.changed)
    ? (json as unknown as StateChange)
    : null;
}

/** Wait time after the `failures`-th consecutive error: 1 s, 2 s, 4 s … up to 60 s, ±20 %. */
function backoff(failures: number, retry: number | undefined): number {
  const base = Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** (failures - 1));
  return Math.max(retry ?? 0, Math.round(base * (0.8 + Math.random() * 0.4)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One event of the stream; `event` defaults to `message`. */
export interface ServerEvent {
  event: string;
  data: string;
  /** Last `id` of the stream (not sent back as `Last-Event-ID`: CORS preflight). */
  id: string;
}

/**
 * Splits the stream's text into events, even when lines or `\r\n` arrive
 * split across chunks. Decode bytes beforehand with `TextDecoder` in `stream`
 * mode so that split UTF-8 characters stay whole.
 */
export class EventStreamParser {
  /** Wait time for the reconnect from `retry:` (ms). */
  retry: number | undefined;
  #line = '';
  #afterCR = false;
  #started = false;
  #event = '';
  #data: string[] = [];
  #id = '';

  push(chunk: string): ServerEvent[] {
    const events: ServerEvent[] = [];
    // An empty chunk (part of a UTF-8 character, an empty read) changes nothing; it must not
    // separate a `\r` from its `\n`.
    if (chunk === '') return events;
    let text = chunk;
    if (this.#afterCR && text.startsWith('\n')) text = text.slice(1);
    this.#afterCR = false;
    if (!this.#started && text !== '') {
      this.#started = true;
      if (text.startsWith('﻿')) text = text.slice(1);
    }
    const breaks = /\r\n|\r|\n/g;
    let start = 0;
    for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
      const line = this.#line + text.slice(start, match.index);
      this.#line = '';
      start = match.index + match[0].length;
      // `\r` at the end of the chunk: a `\n` at the start of the next one belongs to it.
      if (match[0] === '\r' && start === text.length) this.#afterCR = true;
      this.#field(line, events);
    }
    this.#line += text.slice(start);
    return events;
  }

  #field(line: string, events: ServerEvent[]): void {
    if (line === '') {
      if (this.#data.length > 0)
        events.push({ event: this.#event || 'message', data: this.#data.join('\n'), id: this.#id });
      this.#data = [];
      this.#event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') this.#event = value;
    else if (name === 'data') this.#data.push(value);
    else if (name === 'id' && !value.includes('\0')) this.#id = value;
    else if (name === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
  }
}
