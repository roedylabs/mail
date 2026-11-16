/**
 * Types of the JMAP core (RFC 8620): session, requests, standard methods
 * (`/get`, `/changes`, `/set`, `/copy`, `/query`, `/queryChanges`) and errors.
 */

/** Id of an object (RFC 8620, 1.2): 1–255 characters from `A-Za-z0-9_-`. */
export type Id = string;
/** Point in time in UTC per RFC 3339 with `Z`, e.g. `2026-10-27T12:00:00Z` (RFC 8620, 1.4). */
export type UTCDate = string;
/** Point in time per RFC 3339 with time zone, e.g. `2026-10-27T13:00:00+01:00`. */
export type JmapDate = string;

export const CORE = 'urn:ietf:params:jmap:core';
export const MAIL = 'urn:ietf:params:jmap:mail';
export const SUBMISSION = 'urn:ietf:params:jmap:submission';
export const VACATION = 'urn:ietf:params:jmap:vacationresponse';
export const BLOB = 'urn:ietf:params:jmap:blob';
export const QUOTA = 'urn:ietf:params:jmap:quota';
export const SIEVE = 'urn:ietf:params:jmap:sieve';
export const CONTACTS = 'urn:ietf:params:jmap:contacts';
/** RFC 9749: the server's key for Web Push. */
export const WEBPUSH_VAPID = 'urn:ietf:params:jmap:webpush-vapid';
/** draft-ietf-jmap-emailpush: `emailPush` in `PushSubscription`. */
export const EMAIL_PUSH = 'urn:ietf:params:jmap:emailpush';

/** Capability `urn:ietf:params:jmap:core` (RFC 8620, 2). */
export interface CoreCapability {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

/** Capability `urn:ietf:params:jmap:mail` of an account (RFC 8621, 1.3.1); so far only what the app needs. */
export interface MailCapability {
  /** Total size of an email's unencoded attachments; `null` when the server states no limit. */
  maxSizeAttachmentsPerEmail: number | null;
}

/** Capability `urn:ietf:params:jmap:submission` of an account (RFC 8621, 1.3.2); so far only what the app needs. */
export interface SubmissionCapability {
  /** Submit at most this many seconds in advance; 0 = no delayed sending, `null` when not stated. */
  maxDelayedSend: number | null;
}

/** Account of the session (RFC 8620, 2). */
export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

/**
 * JMAP session (RFC 8620, 2). `apiUrl` is absolute; `downloadUrl`,
 * `uploadUrl` and `eventSourceUrl` are templates (RFC 6570, level 1), empty
 * when the server does not provide them.
 */
export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

/** Reference to the result of an earlier call in the same request (RFC 8620, 3.7). */
export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}

/** Method call or response: name, arguments, call id (RFC 8620, 3.2). */
export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

/** Request an `apiUrl` (RFC 8620, 3.3). */
export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

/** Response to a request (RFC 8620, 3.4). */
export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

/** Error of an object in `notCreated`, `notUpdated`, `notDestroyed` (RFC 8620, 5.3). */
export interface SetError {
  type: string;
  description?: string;
  /** For `invalidProperties`: the affected properties. */
  properties?: string[];
  /** For `alreadyExists` (`/copy`, `Email/import`). */
  existingId?: Id;
  [key: string]: unknown;
}

/** Changes as JSON Pointer paths (RFC 8620, 5.3); `null` resets to the default value. */
export type PatchObject = Record<string, unknown>;

export interface GetArgs<T> {
  accountId: Id;
  /** `null` or omitted: all objects (as far as `maxObjectsInGet` allows). */
  ids?: Id[] | null;
  properties?: (keyof T & string)[] | null;
}

export interface GetResponse<T> {
  accountId: Id;
  state: string;
  /** With `properties`, only the requested properties and `id`. */
  list: T[];
  notFound: Id[];
}

export interface ChangesArgs {
  accountId: Id;
  sinceState: string;
  maxChanges?: number | null;
}

export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}

export interface SetArgs<T> {
  accountId: Id;
  ifInState?: string | null;
  /** The key is the creation id that other calls reference with `#<id>`. */
  create?: Record<Id, Partial<T>> | null;
  update?: Record<Id, PatchObject> | null;
  destroy?: Id[] | null;
}

export interface SetResponse<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  /** Creation id → properties the server has set (at least `id`). */
  created: Record<Id, Partial<T> & { id: Id }> | null;
  updated: Record<Id, Partial<T> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

export interface CopyArgs<T> {
  fromAccountId: Id;
  ifFromInState?: string | null;
  accountId: Id;
  ifInState?: string | null;
  create: Record<Id, Partial<T> & { id: Id }>;
  onSuccessDestroyOriginal?: boolean;
  destroyFromIfInState?: string | null;
}

export interface CopyResponse<T> {
  fromAccountId: Id;
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Partial<T> & { id: Id }> | null;
  notCreated: Record<Id, SetError> | null;
}

/** Filter of a query: condition or operator (RFC 8620, 5.5). */
export type Filter<C> = C | FilterOperator<C>;

export interface FilterOperator<C> {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: Filter<C>[];
}

/** Sort order (RFC 8620, 5.5); `keyword` only for the keyword properties of `Email/query` (RFC 8621, 4.4.2). */
export interface Comparator<P extends string = string> {
  property: P;
  isAscending?: boolean;
  collation?: string;
  keyword?: string;
}

export interface QueryArgs<C, P extends string = string> {
  accountId: Id;
  filter?: Filter<C> | null;
  sort?: Comparator<P>[] | null;
  position?: number;
  anchor?: Id | null;
  anchorOffset?: number;
  limit?: number | null;
  calculateTotal?: boolean;
}

export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface QueryChangesArgs<C, P extends string = string> {
  accountId: Id;
  filter?: Filter<C> | null;
  sort?: Comparator<P>[] | null;
  sinceQueryState: string;
  maxChanges?: number | null;
  upToId?: Id | null;
  calculateTotal?: boolean;
}

/** Inserted id with its position in the new list (RFC 8620, 5.6). */
export interface AddedItem {
  id: Id;
  index: number;
}

export interface QueryChangesResponse {
  accountId: Id;
  oldQueryState: string;
  newQueryState: string;
  total?: number;
  removed: Id[];
  added: AddedItem[];
}
