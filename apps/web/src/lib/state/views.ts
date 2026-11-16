/**
 * `listView()` with the app's mailboxes and tags: for the mailbox page
 * and the way back from compose (`backLabel`), so both
 * show the same label.
 */
import { listView, type ListView } from '#lib/mail-view.ts';
import type { MailboxLocation } from '#lib/routes.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { tags } from '#lib/state/tags.svelte.ts';

/** Accounts the browser may reach; the sidebar shows "sign-in required" and blocked servers. */
export function reachable(list: readonly MailAccount[]): MailAccount[] {
  return list.filter(isReachable);
}

export const isReachable = (a: Pick<MailAccount, 'state' | 'blocked'>): boolean => a.state === 'ok' && !a.blocked;

/** View of the address for the accounts of the view (`listView()` with `mailboxes` and `tags`). */
export function appListView(location: MailboxLocation, viewAccounts: readonly MailAccount[], all: boolean): ListView {
  return listView(location, viewAccounts, all, {
    status: (a) => mailboxes.of(a)?.status,
    role: (a, r) => mailboxes.role(a, r),
    list: (a) => mailboxes.list(a),
    tags: tags.list,
    tagsFailed: tags.failed,
    tagBoxes: (t, a) => tags.listBoxes(t, a),
    frozen: (id) => {
      const account = accounts.get(id);
      return !!account && !isReachable(account);
    },
  });
}
