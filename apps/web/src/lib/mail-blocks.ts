/**
 * Process emails of one or more mailboxes in blocks: "Empty Trash" and
 * deleting folders.
 */
import { coreCapability, type EmailFilter, type Filter, type Id, type JmapClient, type SetError } from '@roedy/jmap';

/** At most this many emails per block (and per `Email/set`, otherwise `maxObjectsInSet`). */
export const BLOCK = 500;

/** Rejected, except what no longer exists (deleted elsewhere: the goal is reached or moot). */
export function rejected(...maps: (Record<Id, SetError> | null | undefined)[]): [Id, SetError][] {
  return maps.flatMap((x) => Object.entries(x ?? {})).filter(([, e]) => e.type !== 'notFound');
}

/** Email of a block with its mailboxes. */
export interface BlockEmail {
  id: Id;
  mailboxIds: Id[];
}

/** Filter for emails in one of the mailboxes. */
export function inMailboxes(ids: readonly Id[]): Filter<EmailFilter> {
  return ids.length === 1
    ? { inMailbox: ids[0] as Id }
    : { operator: 'OR', conditions: ids.map((inMailbox) => ({ inMailbox })) };
}

/**
 * Calls `apply` per block of the emails in the mailboxes `boxes`:
 * `Email/query` and `Email/get` (`mailboxIds`) in one request (back-reference).
 * `apply` takes the emails out of the mailboxes and returns how many it
 * managed; it ends after a block below the limit or without progress
 * (otherwise the same emails would come back forever).
 */
export async function eachBlock(
  client: JmapClient,
  boxes: readonly Id[],
  apply: (emails: BlockEmail[], accountId: Id) => Promise<number>,
): Promise<void> {
  const accountId = await client.accountId();
  const limit = Math.min(BLOCK, coreCapability(await client.session()).maxObjectsInSet);
  const filter = inMailboxes(boxes);
  for (;;) {
    const b = client.batch();
    const query = b.call('Email/query', { accountId, filter, limit });
    const get = b.call('Email/get', { accountId, '#ids': query.ref('/ids'), properties: ['id', 'mailboxIds'] });
    const found = await b.send();
    const ids = found.get(query).ids;
    if (!ids.length) return;
    const emails = found.get(get).list.map((e) => ({ id: e.id, mailboxIds: Object.keys(e.mailboxIds ?? {}) }));
    const done = await apply(emails, accountId);
    if (ids.length < limit || done === 0) return;
  }
}
