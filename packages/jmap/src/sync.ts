/**
 * Sync with the server (RFC 8620, 5.2 and 5.6): changes since a state with
 * `Foo/changes` (across several pages, optionally with the objects in the
 * same request) and changes of a query with `Foo/queryChanges`. If the server
 * cannot calculate them, that means `reset`: reload everything.
 */

import type { JmapClient } from './client.ts';
import type { AddedItem, ChangesResponse, GetResponse, Id, QueryChangesResponse } from './core.ts';
import { JmapError, isMethodError } from './errors.ts';
import type { ArgsOf, MethodName, ResponseOf } from './methods.ts';
import { coreCapability } from './session.ts';

/** Data types with `/changes` and `/get`, e.g. `Mailbox`, `Email`, `Thread`. */
export type ChangesType = {
  [M in MethodName]: M extends `${infer T}/changes` ? (`${T}/get` extends MethodName ? T : never) : never;
}[MethodName];

/** Object of a data type as `Foo/get` returns it. */
export type ObjectOf<T extends ChangesType> = ResponseOf<`${T}/get`> extends GetResponse<infer O> ? O : never;

export interface ChangesOptions<T extends ChangesType> {
  accountId: Id;
  sinceState: string;
  /** At most this many ids per page; with `fetch` the default is `maxObjectsInGet`. */
  maxChanges?: number;
  /** Also fetch new and changed objects in the same request (`Foo/get` with `#ids`). */
  fetch?: boolean;
  /** With `fetch`: only these properties. */
  properties?: (keyof ObjectOf<T> & string)[];
  signal?: AbortSignal;
}

export interface ChangeSet<O> {
  reset: false;
  oldState: string;
  newState: string;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
  /** `Mailbox/changes`: only these properties changed (counters), `null` = any. */
  updatedProperties: string[] | null;
  /** With `fetch`: current objects for `created` and `updated`. */
  objects: Map<Id, O>;
}

export type ChangesResult<O> = ChangeSet<O> | { reset: true };

/**
 * All changes since `sinceState`, page by page until
 * `hasMoreChanges: false`. Whatever was destroyed in a later page is missing
 * from `created`/`updated`; newly created objects stay `created`.
 */
export async function changes<T extends ChangesType>(
  client: JmapClient,
  type: T,
  options: ChangesOptions<T>,
): Promise<ChangesResult<ObjectOf<T>>> {
  const { accountId, signal } = options;
  let maxChanges = options.maxChanges;
  if (options.fetch && maxChanges === undefined)
    maxChanges = coreCapability(await client.session(signal)).maxObjectsInGet;
  const created = new Set<Id>();
  const updated = new Set<Id>();
  const destroyed = new Set<Id>();
  const objects = new Map<Id, ObjectOf<T>>();
  let props: Set<string> | null = new Set();
  let oldState: string | undefined;
  let sinceState = options.sinceState;
  for (;;) {
    const batch = client.batch();
    const call = batch.invoke(`${type}/changes`, { accountId, sinceState, ...(maxChanges ? { maxChanges } : {}) });
    const gets = options.fetch
      ? ['/created', '/updated'].map((path) =>
          batch.invoke(`${type}/get`, {
            accountId,
            '#ids': call.ref(path),
            ...(options.properties ? { properties: options.properties } : {}),
          }),
        )
      : [];
    const response = await batch.send(signal);
    let page: ChangesResponse & { updatedProperties?: string[] | null };
    try {
      page = response.get(call);
    } catch (error) {
      if (isMethodError(error, 'cannotCalculateChanges')) return { reset: true };
      throw error;
    }
    oldState ??= page.oldState;
    for (const id of page.created) created.add(id);
    for (const id of page.updated) if (!created.has(id)) updated.add(id);
    for (const id of page.destroyed) {
      objects.delete(id);
      updated.delete(id);
      // Created and destroyed again: the client never knew it.
      if (!created.delete(id)) destroyed.add(id);
    }
    if (page.updated.length > 0) {
      if (props && Array.isArray(page.updatedProperties)) for (const p of page.updatedProperties) props.add(p);
      else props = null;
    }
    for (const get of gets) {
      const { list } = response.get(get) as unknown as GetResponse<ObjectOf<T> & { id: Id }>;
      for (const object of list) if (!destroyed.has(object.id)) objects.set(object.id, object);
    }
    if (!page.hasMoreChanges) {
      sinceState = page.newState;
      break;
    }
    // Without a new state the loop would run forever.
    if (page.newState === sinceState)
      throw new JmapError('invalidResponse', { detail: `${type}/changes without progress` });
    sinceState = page.newState;
  }
  return {
    reset: false,
    oldState: oldState ?? options.sinceState,
    newState: sinceState,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
    updatedProperties: props && updated.size > 0 ? [...props] : null,
    objects,
  };
}

export type QueryChangesMethod = Extract<MethodName, `${string}/queryChanges`>;

export type QueryChangesResult = (QueryChangesResponse & { reset: false }) | { reset: true };

/**
 * Changes of a query since `sinceQueryState` (RFC 8620, 5.6), e.g.
 * `Email/queryChanges` with filter and sort of the original query.
 * `cannotCalculateChanges` and `tooManyChanges` mean `reset`.
 */
export async function queryChanges<M extends QueryChangesMethod>(
  client: JmapClient,
  method: M,
  args: ArgsOf<M>,
  signal?: AbortSignal,
): Promise<QueryChangesResult> {
  try {
    const response = (await client.call(method, args, signal)) as QueryChangesResponse;
    return { ...response, reset: false };
  } catch (error) {
    if (isMethodError(error, 'cannotCalculateChanges') || isMethodError(error, 'tooManyChanges'))
      return { reset: true };
    throw error;
  }
}

/**
 * Applies the changes of a query to the known ids (RFC 8620, 5.6): first
 * remove `removed`, then insert `added` by ascending `index`. `ids` is the
 * start of the result list (position 0); insertions past its end are dropped –
 * with `upToId` = last known id, the server only reports what affects this
 * start.
 */
export function applyQueryChanges(
  ids: readonly Id[],
  changes: { removed: readonly Id[]; added: readonly AddedItem[] },
): Id[] {
  const removed = new Set(changes.removed);
  const out = ids.filter((id) => !removed.has(id));
  for (const item of [...changes.added].sort((a, b) => a.index - b.index)) {
    if (item.index <= out.length) out.splice(item.index, 0, item.id);
  }
  return out;
}
