/**
 * Client errors: `JmapError` for the transport and rejected requests
 * (RFC 8620, 3.6.1), `MethodError` for individual methods (RFC 8620, 3.6.2).
 * Errors from the token provider and aborts via `AbortSignal` are passed on
 * unchanged.
 */

export type JmapErrorKind =
  /** `fetch` rejected: offline, DNS, TLS or CORS – indistinguishable in the browser. */
  | 'unreachable'
  /** 401, even with a freshly fetched token. */
  | 'auth'
  /** 403: signed in, but not authorized. */
  | 'forbidden'
  /** 429: the server is throttling; `retryAfter` when the header is readable. */
  | 'throttled'
  /** Session URL or redirect to another origin; no token is sent there. */
  | 'foreignOrigin'
  /** Capability, primary account or URL is missing (`capability`). */
  | 'unsupported'
  /** Request rejected (`type`: `unknownCapability`, `notJSON`, `notRequest`, `limit` with `limit`). */
  | 'request'
  /** Other HTTP status. */
  | 'status'
  /** Response not readable or not per RFC 8620. */
  | 'invalidResponse';

export interface JmapErrorDetails {
  status?: number;
  /** Wait time in seconds from `Retry-After`. */
  retryAfter?: number;
  /** Error type without `urn:ietf:params:jmap:error:`. */
  type?: string;
  /** For `type` `limit`: the exceeded limit, e.g. `maxCallsInRequest`. */
  limit?: string;
  capability?: string;
  detail?: string;
}

export class JmapError extends Error {
  readonly kind: JmapErrorKind;
  readonly details: Readonly<JmapErrorDetails>;

  constructor(kind: JmapErrorKind, details: JmapErrorDetails = {}, options?: ErrorOptions) {
    const extra = details.type ?? details.capability ?? details.status;
    super(extra === undefined ? `JMAP: ${kind}` : `JMAP: ${kind} (${extra})`, options);
    this.name = 'JmapError';
    this.kind = kind;
    this.details = details;
  }

  get status(): number | undefined {
    return this.details.status;
  }

  get retryAfter(): number | undefined {
    return this.details.retryAfter;
  }
}

/** Error of a method call, e.g. `cannotCalculateChanges` or `accountNotFound`. */
export class MethodError extends Error {
  readonly type: string;
  readonly method: string;
  readonly callId: string;
  /** All fields of the error, e.g. `description`, `properties`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(method: string, callId: string, details: Record<string, unknown>) {
    const type = typeof details.type === 'string' ? details.type : 'serverFail';
    super(`${method}: ${type}`);
    this.name = 'MethodError';
    this.type = type;
    this.method = method;
    this.callId = callId;
    this.details = details;
  }
}

export function isMethodError(error: unknown, type?: string): error is MethodError {
  return error instanceof MethodError && (type === undefined || error.type === type);
}

export function isJmapError(error: unknown, kind?: JmapErrorKind): error is JmapError {
  return error instanceof JmapError && (kind === undefined || error.kind === kind);
}

const PROBLEM_PREFIX = 'urn:ietf:params:jmap:error:';

/** Error for a non-2xx response; reads the body (Problem Details, RFC 7807). */
export async function responseError(res: Response): Promise<JmapError> {
  const status = res.status;
  let problem: Record<string, unknown> | null = null;
  try {
    const body: unknown = JSON.parse(await res.text());
    if (isRecord(body)) problem = body;
  } catch {
    // Not JSON: then only the status counts.
  }
  const type = problem && typeof problem.type === 'string' ? problem.type : '';
  if (type.startsWith(PROBLEM_PREFIX)) {
    return new JmapError('request', {
      status,
      type: type.slice(PROBLEM_PREFIX.length),
      ...(typeof problem?.limit === 'string' ? { limit: problem.limit } : {}),
      ...(typeof problem?.detail === 'string' ? { detail: problem.detail } : {}),
    });
  }
  if (status === 401) return new JmapError('auth', { status });
  if (status === 403) return new JmapError('forbidden', { status });
  if (status === 429) {
    const retryAfter = retryAfterSeconds(res.headers.get('Retry-After'));
    return new JmapError('throttled', { status, ...(retryAfter === undefined ? {} : { retryAfter }) });
  }
  return new JmapError('status', { status });
}

/**
 * Wait time from `Retry-After` in seconds: whole seconds or an HTTP date
 * (RFC 9110, 10.2.3). Readable in the browser only when the server exposes the
 * header via `Access-Control-Expose-Headers`.
 */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
