/**
 * View of the message list derived from the address: kind, title
 * and, per account of the view, the mailboxes `threads` reads from –
 * mailbox via the role (`mailboxes.role()`), folder, tag with the
 * mailboxes of its subtags without trash and spam.
 */
import type { Id, Mailbox } from '@roedy/jmap';
import type { ListKind } from '#lib/mail-list.ts';
import { roleLabel } from '#lib/mailbox-nav.ts';
import { ALL_ACCOUNTS, type MailboxLocation, type RoleId } from '#lib/routes.ts';
import type { MailAccount } from '#lib/state/accounts.svelte.ts';
import type { AccountMailboxes } from '#lib/state/mailboxes.svelte.ts';
import type { Tag } from '#lib/state/tags.svelte.ts';
import type { ThreadSource } from '#lib/state/threads.svelte.ts';

export interface ListView {
  kind: ListKind;
  title: string;
  /** "All accounts" with more than one account. */
  multi: boolean;
  /** `null` while mailboxes or tags of the view are loading. */
  sources: ThreadSource[] | null;
  /** No account of the view reachable (sign-in required, mailboxes or tags failed): no empty state. */
  unavailable: boolean;
}

/** Mailboxes and tags as the view needs them. */
export interface ViewDeps {
  status: (account: string) => AccountMailboxes['status'] | undefined;
  role: (account: string, role: RoleId) => Mailbox | null;
  list: (account: string) => readonly Mailbox[];
  /** Tags of the user; `null` while unknown. */
  tags: readonly Tag[] | null;
  /** Loading the tags failed. */
  tagsFailed: boolean;
  /** Mailboxes of a tag's list (`tags.listBoxes()`). */
  tagBoxes: (tag: string, account: string) => Id[] | null;
  /** No access to the account: the view only reads the store. */
  frozen?: (account: string) => boolean;
}

/**
 * View of the address for the accounts of the view. An account whose
 * mailboxes do not load is missing from the list; one whose mailboxes are
 * still loading holds it back. If no account remains (or the tags fail),
 * the view is `unavailable`.
 */
export function listView(
  location: MailboxLocation,
  viewAccounts: readonly Pick<MailAccount, 'id'>[],
  all: boolean,
  deps: ViewDeps,
): ListView {
  const multi = all && viewAccounts.length > 1;
  const pending = (account: string) => {
    const s = deps.status(account);
    return s === undefined || s === 'loading';
  };
  const usable = viewAccounts.filter((a) => deps.status(a.id) !== 'error');
  /** Source of an account, marked `frozen` for an account without access. */
  const sourceOf = (account: string, boxes: Id[], exclude: Id[]): ThreadSource => ({
    account,
    boxes,
    exclude,
    ...(deps.frozen?.(account) ? { frozen: true } : {}),
  });
  const out = (kind: ListKind, title: string, sources: ThreadSource[] | null, unavailable = false): ListView => ({
    kind,
    title,
    multi,
    sources: unavailable ? [] : sources,
    unavailable,
  });
  if ('role' in location) {
    const kind = { role: location.role };
    const title = roleLabel(location.role);
    if (!usable.length) return out(kind, title, [], true);
    if (usable.some((a) => pending(a.id))) return out(kind, title, null);
    const sources = usable.flatMap((a): ThreadSource[] => {
      const box = deps.role(a.id, location.role);
      return box ? [sourceOf(a.id, [box.id], [])] : [];
    });
    return out(kind, title, sources);
  }
  if ('folder' in location) {
    const kind = { folder: true } as const;
    const owner = location.account === ALL_ACCOUNTS ? location.owner : location.account;
    const account = usable.find((a) => a.id === owner);
    if (!account) return out(kind, '', [], true);
    if (pending(account.id)) return out(kind, '', null);
    const box = deps.list(account.id).find((b) => b.id === location.folder);
    return out(kind, box?.name ?? '', box ? [sourceOf(account.id, [box.id], [])] : []);
  }
  const kind = { tag: true } as const;
  if (deps.tags === null) return out(kind, '', null, deps.tagsFailed || !usable.length);
  const tag = deps.tags.find((t) => t.id === location.tag);
  if (!tag) return out(kind, '', []);
  if (!usable.length) return out(kind, tag.name, [], true);
  if (usable.some((a) => pending(a.id))) return out(kind, tag.name, null);
  const sources = usable.flatMap((a): ThreadSource[] => {
    const boxes = deps.tagBoxes(tag.id, a.id) ?? [];
    const exclude = (['trash', 'spam'] as const).flatMap((r) => deps.role(a.id, r)?.id ?? []);
    return boxes.length ? [sourceOf(a.id, boxes, exclude)] : [];
  });
  return out(kind, tag.name, sources);
}
