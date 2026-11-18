/**
 * Access to the backend API (`/api/v1`). All requests carry the cookie and
 * `X-Requested-With` (CSRF protection of the backend); errors arrive as
 * `ApiError` with status and error code of the response (`error`).
 */
import { isInstalled } from '#lib/installed.ts';
import { appFetch } from '#lib/state/network.svelte.ts';

export const API_BASE = '/api/v1';

/** Error response of the backend: `{ "error": "<code>", … }` with further fields per code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Readonly<Record<string, unknown>>;

  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === 'string' ? body.error : 'unknown';
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** No response from the server (offline, network, aborted): `fetch` rejected. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('No connection', { cause });
    this.name = 'NetworkError';
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * `fetch` with `keepalive` only accepts bodies up to 64 KiB (Fetch Standard,
 * together with other pending ones), otherwise it fails at once. Larger ones –
 * such as a new logo in the branding – go without `keepalive`: when the
 * page is hidden they arrive, when the tab is closed they may get lost.
 */
export const KEEPALIVE_MAX = 60_000;

export interface ApiOptions {
  /** Request survives closing the page (deferred actions, `#lib/undo.ts`); only up to `KEEPALIVE_MAX`. */
  keepalive?: boolean;
  /** Further headers, e.g. `X-Setup-Token` of the setup. */
  headers?: Readonly<Record<string, string>>;
  /** Aborts the request, for example after a timeout. */
  signal?: AbortSignal;
}

/** Sends a request to `/api/v1/<path>` and returns the JSON response. */
export async function api<T>(method: Method, path: string, body?: unknown, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...options.headers,
    Accept: 'application/json',
    'X-Requested-With': 'roedy-mail',
    // The user agent does not reveal the installed app; the session remembers it at sign-in.
    ...(isInstalled() ? { 'X-Roedy-App': '1' } : {}),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // Characters instead of bytes: the large bodies (data URLs) are ASCII, the margin to 64 KiB covers the rest.
  const keepalive = options.keepalive === true && (payload?.length ?? 0) <= KEEPALIVE_MAX;
  let res: Response;
  try {
    res = await appFetch(`${API_BASE}/${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(payload === undefined ? {} : { body: payload }),
      ...(keepalive ? { keepalive: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new NetworkError(error);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    // The body broke off after the headers (connection lost, `signal` expired): no answer either.
    throw new NetworkError(error);
  }
  const data = parsed(text);
  if (!res.ok) {
    throw new ApiError(res.status, isRecord(data) ? data : {});
  }
  return data as T;
}

function parsed(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Like `api`, but returns the body as a file (export of the audit log). */
export async function apiBlob(method: Method, path: string): Promise<Blob> {
  try {
    const res = await appFetch(`${API_BASE}/${path}`, {
      method,
      headers: { 'X-Requested-With': 'roedy-mail' },
      credentials: 'same-origin',
    });
    if (res.ok) return await res.blob();
    const data = parsed(await res.text());
    throw new ApiError(res.status, isRecord(data) ? data : {});
  } catch (error) {
    throw error instanceof ApiError ? error : new NetworkError(error);
  }
}

/** Error response with this status and, if given, this error code. */
export function isApiError(error: unknown, status: number, code?: string): error is ApiError {
  return error instanceof ApiError && error.status === status && (code === undefined || error.code === code);
}

/** Custom notice from 503 `maintenance` (`message`), otherwise `null` (then `MAINT_MSG`). */
export function maintenanceMessage(error: ApiError): string | null {
  const message = error.body.message;
  return typeof message === 'string' && message ? message : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wait time of a lock (429 `rate_limited`, `retry_after` in seconds). */
export function retryAfter(error: ApiError, fallback = 30): number {
  const seconds = error.body.retry_after;
  return typeof seconds === 'number' && seconds > 0 ? seconds : fallback;
}

/** Details of a field from 422 `invalid` (`fields`): `code` and more depending on the error. */
export type FieldDetail = Readonly<Record<string, unknown>> & { readonly code: string };

/** Field errors from 422 `invalid` (`fields`): path → details with `code`. */
export function fieldsOf(error: ApiError): Record<string, FieldDetail> {
  const fields = error.body.fields;
  if (!isRecord(fields)) return {};
  const out: Record<string, FieldDetail> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isRecord(value) && typeof value.code === 'string') out[key] = { ...value, code: value.code };
  }
  return out;
}
