/**
 * Minimal JMAP client for the browser: session, requests with
 * several calls and back-references (RFC 8620, 3), blobs (RFC 8620, 6) and
 * push via EventSource (`stream.ts`). Every request fetches its token from the
 * provider; if the mail server rejects it with 401, a new one once.
 */

import {
  CORE,
  MAIL,
  type Id,
  type Invocation,
  type JmapRequest,
  type JmapResponse,
  type ResultReference,
  type Session,
} from './core.ts';
import { JmapError, MethodError, isRecord, responseError } from './errors.ts';
import { capabilityOf, type ArgsOf, type MethodName, type ResponseOf } from './methods.ts';
import { coreCapability, expandTemplate, parseSession, primaryAccount, resolveSameOrigin } from './session.ts';
import { runEvents, type EventsOptions } from './stream.ts';
import { abortable, type TokenProvider } from './token.ts';

export interface ClientOptions {
  /** URL of the mail server; the session comes from `<url>/.well-known/jmap`. */
  url: string;
  tokens: TokenProvider;
  /** Already known session, e.g. `session` from the token broker's response. */
  session?: unknown;
  /** After every session load, including when `sessionState` has changed. */
  onSession?: (session: Session) => void;
  /** Timeout of a request to `apiUrl` in ms (default 60 s), then `unreachable` with `detail: 'timeout'`. */
  timeout?: number;
  fetch?: typeof fetch;
}

/** How long the client keeps working with the previous session after a failed reload (ms). */
const RELOAD_PAUSE = 60_000;

/** Arguments with back-references: `#ids` instead of `ids` (RFC 8620, 3.7). */
export type WithRefs<A> = A & { [K in keyof A & string as `#${K}`]?: ResultReference };

/** Response of a call; the raw arguments without types in `Methods`. */
export type ResponseFor<M extends string> = M extends MethodName ? ResponseOf<M> : Record<string, unknown>;

export type CallResult<M extends string> = { ok: true; value: ResponseFor<M> } | { ok: false; error: MethodError };

/** Options of a request. */
export interface SendOptions {
  /**
   * The request survives closing the page (`fetch` with `keepalive`), e.g.
   * for a pending action when leaving the page. It does not wait behind
   * others for a slot (`maxConcurrentRequests`), because the page is about to
   * go away. The browser limits the bodies of such requests to 64 KiB in
   * total.
   */
  keepalive?: boolean;
}

/** Response to a blob upload (RFC 8620, 6.1). */
export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}

export interface BlobRef {
  accountId: Id;
  blobId: Id;
  /** File name for the URL (`{name}`), default `download`. */
  name?: string;
  /** Content type of the response (`{type}`), default `application/octet-stream`. */
  type?: string;
}

/** One call in a request; `ref()` references its result. */
export class Call<M extends string = string> {
  readonly name: M;
  readonly id: string;

  constructor(name: M, id: string) {
    this.name = name;
    this.id = id;
  }

  /** Back-reference to part of the result (JSON Pointer, `*` for all elements of a list). */
  ref(path: string): ResultReference {
    return { resultOf: this.id, name: this.name, path };
  }
}

/** Several calls in one request; the server executes them in order. */
export class Batch {
  readonly #client: JmapClient;
  readonly #calls: Invocation[] = [];
  readonly #names = new Map<string, string>();
  readonly #using = new Set<string>([CORE]);

  constructor(client: JmapClient) {
    this.#client = client;
  }

  get size(): number {
    return this.#calls.length;
  }

  /** Capabilities for `using` that do not follow from the method names. */
  use(...capabilities: string[]): this {
    for (const capability of capabilities) this.#using.add(capability);
    return this;
  }

  call<M extends MethodName>(name: M, args: WithRefs<ArgsOf<M>>): Call<M> {
    return this.invoke(name, args);
  }

  /** Untyped call, for methods outside `Methods`. */
  invoke<M extends string>(name: M, args: Record<string, unknown>): Call<M> {
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith('#')) continue;
      if (Object.hasOwn(args, key.slice(1)))
        throw new TypeError(`${name}: ${key} and ${key.slice(1)} at the same time`);
      if (!isReference(value) || this.#names.get(value.resultOf) !== value.name) {
        throw new TypeError(`${name}: ${key} does not reference an earlier call of this request`);
      }
    }
    const capability = capabilityOf(name);
    if (capability) this.#using.add(capability);
    const call = new Call(name, this.#client.nextCallId());
    this.#calls.push([name, args, call.id]);
    this.#names.set(call.id, name);
    return call;
  }

  async send(signal?: AbortSignal, options: SendOptions = {}): Promise<BatchResponse> {
    if (this.#calls.length === 0) throw new TypeError('request without calls');
    return this.#client.send({ using: [...this.#using], methodCalls: this.#calls }, signal, options);
  }
}

/** Response to a request; errors of individual calls only surface on `get`. */
export class BatchResponse {
  readonly response: JmapResponse;

  constructor(response: JmapResponse) {
    this.response = response;
  }

  /** Response of a call; if the server reports an error, throws `MethodError`. */
  get<M extends string>(call: Call<M>): ResponseFor<M> {
    const result = this.result(call);
    if (!result.ok) throw result.error;
    return result.value;
  }

  result<M extends string>(call: Call<M>): CallResult<M> {
    // A call can trigger further responses with the same id (RFC 8620, 3.4),
    // e.g. `Email/set` after `EmailSubmission/set`; the one with its name counts.
    for (const [name, args, id] of this.response.methodResponses) {
      if (id !== call.id) continue;
      if (name === 'error') return { ok: false, error: new MethodError(call.name, id, args) };
      if (name === call.name) return { ok: true, value: args as ResponseFor<M> };
    }
    throw new JmapError('invalidResponse', { detail: `no response to ${call.name}` });
  }

  /**
   * Further response under the id of a call (RFC 8620, 3.4), e.g. the
   * implicit `Email/set` after `EmailSubmission/set` with `onSuccessUpdateEmail`
   * (RFC 8621, 7.5); `null` when the server did not send one.
   */
  implicit<M extends MethodName>(call: Call<string>, name: M): ResponseOf<M> | null {
    for (const [n, args, id] of this.response.methodResponses) {
      if (id === call.id && n === name) return args;
    }
    return null;
  }
}

export class JmapClient {
  /** URL of the mail server; tokens only go to this origin. */
  readonly url: string;
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #onSession: ((session: Session) => void) | undefined;
  readonly #timeout: number;
  #session: Session | null = null;
  /** `sessionState` of the last response. */
  #seenState: string | null = null;
  /** No reload of a known session before this time (ms since 1970). */
  #reloadAt = 0;
  #loading: Promise<Session> | null = null;
  #requests: Limiter | null = null;
  #uploads: Limiter | null = null;
  #callIds = 0;

  constructor(options: ClientOptions) {
    this.url = new URL(options.url).href;
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#onSession = options.onSession;
    this.#timeout = options.timeout ?? 60_000;
    // Path-relative URLs depend on the session URL after the redirect, which is
    // unknown here: then rather load from the server.
    if (options.session !== undefined && !hasPathRelativeUrl(options.session)) {
      try {
        this.#session = parseSession(options.session, this.url);
      } catch {
        // Unusable: then `session()` loads it from the server.
      }
    }
  }

  /** Last loaded session without network, otherwise `null`. */
  get currentSession(): Session | null {
    return this.#session;
  }

  /**
   * Session; loads it when it is missing or the `sessionState` of the last
   * response differs – a known one at most once per minute. If the reload
   * fails, the previous one stays valid.
   */
  session(signal?: AbortSignal): Promise<Session> {
    const known = this.#session;
    const stale = this.#seenState !== null && this.#seenState !== known?.state;
    if (known && (!stale || Date.now() < this.#reloadAt)) return Promise.resolve(known);
    this.#loading ??= this.#loadSession().finally(() => {
      this.#loading = null;
    });
    return abortable(known ? this.#loading.catch(() => known) : this.#loading, signal);
  }

  /** Primary account of a capability (default Mail). */
  async accountId(capability = MAIL, signal?: AbortSignal): Promise<Id> {
    return primaryAccount(await this.session(signal), capability);
  }

  batch(): Batch {
    return new Batch(this);
  }

  /** A single call; method errors as `MethodError`. */
  async call<M extends MethodName>(name: M, args: WithRefs<ArgsOf<M>>, signal?: AbortSignal): Promise<ResponseOf<M>> {
    const batch = this.batch();
    const call = batch.call(name, args);
    return (await batch.send(signal)).get(call);
  }

  /** Unique per client so that back-references to other requests stand out. */
  nextCallId(): string {
    return `c${this.#callIds++}`;
  }

  /** Sends a request to `apiUrl` (at most `maxConcurrentRequests` at a time). */
  async send(request: JmapRequest, signal?: AbortSignal, options: SendOptions = {}): Promise<BatchResponse> {
    const session = await this.session(signal);
    for (const capability of request.using) {
      if (!(capability in session.capabilities)) throw new JmapError('unsupported', { capability });
    }
    const core = coreCapability(session);
    if (request.methodCalls.length > core.maxCallsInRequest) {
      throw new JmapError('request', { type: 'limit', limit: 'maxCallsInRequest' });
    }
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).length > core.maxSizeRequest) {
      throw new JmapError('request', { type: 'limit', limit: 'maxSizeRequest' });
    }
    this.#requests ??= new Limiter(core.maxConcurrentRequests);
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      ...(options.keepalive ? { keepalive: true } : {}),
    };
    const send = () => this.#authorized(session.apiUrl, init, signal, this.#timeout, readOkJson);
    const json = await (options.keepalive ? send() : this.#requests.run(send, signal));
    const response = parseResponse(json);
    this.#seenState = response.sessionState;
    return new BatchResponse(response);
  }

  /**
   * Downloads a blob, e.g. an attachment or the source of a message (`blobId`
   * of the Email). The timeout applies until the response, not to the content
   * (attachments can be large). Bypasses the HTTP cache (`no-store`): whatever
   * the server's headers say, attachments must not stay in the browser after
   * sign-out.
   */
  async download(blob: BlobRef, signal?: AbortSignal): Promise<Blob> {
    const session = await this.session(signal);
    if (!session.downloadUrl) throw new JmapError('unsupported', { capability: 'downloadUrl' });
    const url = expandTemplate(session.downloadUrl, {
      accountId: blob.accountId,
      blobId: blob.blobId,
      name: blob.name ?? 'download',
      type: blob.type ?? 'application/octet-stream',
    });
    const res = await this.#authorized(url, { cache: 'no-store' }, signal, this.#timeout, (r) => Promise.resolve(r));
    if (!res.ok) throw await responseError(res);
    return readBody(() => res.blob(), signal);
  }

  /**
   * Uploads data as a blob (at most `maxConcurrentUpload` at a time, up to
   * `maxSizeUpload`); the timeout grows with the size (at least 16 kB/s).
   */
  async upload(
    accountId: Id,
    data: Blob | BufferSource | string,
    type?: string,
    signal?: AbortSignal,
  ): Promise<UploadResponse> {
    const session = await this.session(signal);
    if (!session.uploadUrl) throw new JmapError('unsupported', { capability: 'uploadUrl' });
    const core = coreCapability(session);
    const size =
      typeof data === 'string'
        ? new TextEncoder().encode(data).length
        : data instanceof Blob
          ? data.size
          : data.byteLength;
    if (size > core.maxSizeUpload) throw new JmapError('request', { type: 'limit', limit: 'maxSizeUpload' });
    const contentType = type ?? (data instanceof Blob && data.type ? data.type : 'application/octet-stream');
    const url = expandTemplate(session.uploadUrl, { accountId });
    const init = { method: 'POST', headers: { 'Content-Type': contentType }, body: data };
    this.#uploads ??= new Limiter(core.maxConcurrentUpload);
    const json = await this.#uploads.run(
      () => this.#authorized(url, init, signal, this.#timeout + Math.ceil(size / 16), readOkJson),
      signal,
    );
    if (
      !isRecord(json) ||
      typeof json.accountId !== 'string' ||
      typeof json.blobId !== 'string' ||
      typeof json.type !== 'string' ||
      typeof json.size !== 'number'
    ) {
      throw new JmapError('invalidResponse', { detail: 'upload' });
    }
    return { accountId: json.accountId, blobId: json.blobId, type: json.type, size: json.size };
  }

  /**
   * Push via EventSource (RFC 8620, 7.3), read via `fetch` because
   * `EventSource` has no Authorization header. Runs with reconnect until
   * `signal` aborts; without `eventSourceUrl` immediately `unsupported`.
   */
  events(options: EventsOptions): Promise<void> {
    return runEvents(
      {
        session: (signal) => this.session(signal),
        authFetch: (url, init, signal) => this.authFetch(url, init, signal),
        retryAt: () => this.#tokens.retryAt?.() ?? 0,
      },
      options,
    );
  }

  /**
   * `fetch` with bearer to a URL on the mail server's origin; on 401 once more
   * with a new token. Responses with other statuses are returned; no timeout
   * (the push stream stays open).
   */
  authFetch(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    return this.#authorized(url, init, signal, undefined, (res) => Promise.resolve(res));
  }

  /**
   * Common path of all requests: fetch the token, send, on 401 once more with a
   * new token. `timeout` applies per attempt from sending until the end of
   * `read` – waiting for the token does not count, the provider's errors stay
   * its own.
   */
  async #authorized<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeout: number | undefined,
    read: (res: Response, signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const target = resolveSameOrigin(url, this.url);
    let token = await this.#tokens.token(signal ? { signal } : {});
    for (let retried = false; ; retried = true) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      const deadline = timeout === undefined ? null : new Deadline(timeout, signal);
      const limited = deadline?.signal ?? signal;
      try {
        const res = await this.#send(target, { ...init, headers, ...(limited ? { signal: limited } : {}) });
        if (res.status !== 401 || retried) return await read(res, limited);
        await res.body?.cancel();
      } finally {
        deadline?.clear();
      }
      token = await this.#tokens.token(signal ? { rejected: token, signal } : { rejected: token });
    }
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      init.signal?.throwIfAborted();
      throw new JmapError('unreachable', {}, { cause: error });
    }
  }

  async #loadSession(): Promise<Session> {
    const url = new URL('/.well-known/jmap', this.url).href;
    try {
      return await this.#authorized(
        url,
        { headers: { Accept: 'application/json' }, cache: 'no-store' },
        undefined,
        this.#timeout,
        async (res, signal) => {
          // `fetch` follows redirects (Stalwart: `/jmap/session`); in the browser
          // without the Authorization header when the target is another origin.
          const base = res.url ? resolveSameOrigin(res.url, this.url) : url;
          const session = parseSession(await readOkJson(res, signal), base);
          this.#session = session;
          this.#onSession?.(session);
          return session;
        },
      );
    } finally {
      this.#reloadAt = Date.now() + RELOAD_PAUSE;
    }
  }
}

/** Timeout that aborts together with `signal`; reason `unreachable` with `detail: 'timeout'`. */
class Deadline {
  readonly signal: AbortSignal;
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(ms: number, signal?: AbortSignal) {
    const controller = new AbortController();
    this.#timer = setTimeout(() => controller.abort(new JmapError('unreachable', { detail: 'timeout' })), ms);
    this.signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
}

/** At most `max` tasks at a time; the others wait in order until they abort. */
class Limiter {
  readonly #max: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#active < this.#max) this.#active++;
    else await this.#wait(signal);
    try {
      return await task();
    } finally {
      // The slot passes directly to the next one.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }

  #wait(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiting.indexOf(take);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal?.reason as Error);
      };
      const take = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waiting.push(take);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** URLs that are neither absolute nor root-relative. */
function hasPathRelativeUrl(json: unknown): boolean {
  if (!isRecord(json)) return false;
  return ['apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl'].some((key) => {
    const value = json[key];
    return typeof value === 'string' && value !== '' && !value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value);
  });
}

function isReference(value: unknown): value is ResultReference {
  return (
    isRecord(value) &&
    typeof value.resultOf === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string'
  );
}

function parseResponse(json: unknown): JmapResponse {
  if (!isRecord(json) || !Array.isArray(json.methodResponses) || typeof json.sessionState !== 'string') {
    throw new JmapError('invalidResponse');
  }
  const methodResponses: Invocation[] = [];
  for (const item of json.methodResponses as unknown[]) {
    if (!Array.isArray(item) || item.length !== 3) throw new JmapError('invalidResponse');
    const [name, args, id] = item as unknown[];
    if (typeof name !== 'string' || !isRecord(args) || typeof id !== 'string') throw new JmapError('invalidResponse');
    methodResponses.push([name, args, id]);
  }
  return {
    methodResponses,
    sessionState: json.sessionState,
    ...(isRecord(json.createdIds) ? { createdIds: json.createdIds as Record<Id, Id> } : {}),
  };
}

/** JSON of a 2xx response, otherwise the error for the status. */
async function readOkJson(res: Response, signal?: AbortSignal): Promise<unknown> {
  if (!res.ok) throw await responseError(res);
  return readJson(res, signal);
}

async function readJson(res: Response, signal?: AbortSignal): Promise<unknown> {
  const text = await readBody(() => res.text(), signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new JmapError('invalidResponse', {}, { cause: error });
  }
}

/** Reads the body; if the connection breaks, `unreachable` (or the abort itself). */
async function readBody<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await read();
  } catch (error) {
    signal?.throwIfAborted();
    throw new JmapError('unreachable', {}, { cause: error });
  }
}
