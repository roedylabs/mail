// Navigation of the reading view in the mailbox: open a thread, back to the list
// and the vanished thread. Pulled out of the page so that replacing the
// history entry is testable without the whole page.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { untrack } from 'svelte';
import { ALL_ACCOUNTS, mailboxParams, type MailboxLocation } from '#lib/routes.ts';

/** Account and thread of the shown conversation. */
export interface ShownThread {
  account: string;
  threadId: string;
}

/** What `followGone()` reads from the conversation (`Conversation` from `#lib/state/message.svelte.ts`). */
export interface GoneCheck extends ShownThread {
  status: string;
  movedTo: string | null;
}

/**
 * Open a thread in the view: in "All accounts" with its account
 * (`<account>/<thread>` as one segment). `replace` replaces the history
 * entry instead of adding a new one.
 */
export function openThread(location: MailboxLocation, account: string, threadId: string, replace = false): void {
  const params = mailboxParams(location.account, location);
  const thread = encodeURIComponent(location.account === ALL_ACCOUNTS ? `${account}/${threadId}` : threadId);
  void goto(resolve('/mailbox/[account]/[...path]', { ...params, path: `${params.path}/${thread}` }), { replace });
}

/** Back to the list of the view. */
export function openList(location: MailboxLocation, replace: boolean): void {
  void goto(resolve('/mailbox/[account]/[...path]', mailboxParams(location.account, location)), { replace });
}

/**
 * Thread vanished: after a merge continue in the new one (`'moved'`),
 * otherwise back to the list (`'gone'`, the caller shows the notice). Both
 * replace the entry of the vanished conversation so that "Back" does not
 * lead back to it. `null`: nothing to do.
 *
 * For `$effect`: state and target are tracked, the navigation and the view
 * `at()` are not.
 */
export function followGone(
  c: GoneCheck | null,
  opened: ShownThread | null,
  at: () => MailboxLocation | null,
): 'moved' | 'gone' | null {
  if (c?.status !== 'missing' || c.account !== opened?.account || c.threadId !== opened.threadId) return null;
  const moved = c.movedTo;
  return untrack(() => {
    const location = at();
    if (!location) return null;
    if (moved) {
      openThread(location, c.account, moved, true);
      return 'moved';
    }
    openList(location, true);
    return 'gone';
  });
}
