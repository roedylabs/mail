/**
 * Start and end of a session in the browser: load the account after sign-in or
 * accepting an invitation, sign out in the account menu, "Back to
 * sign-in" under "Hello", and a password that the link from the mail
 * has reset (then the server has already ended all sessions).
 */
import { ApiError, api } from '#lib/api.ts';
import { mailLogin } from '#lib/auth/mail-login.svelte.ts';
import { mailPush } from '#lib/mail-push.svelte.ts';
import { push } from '#lib/push.svelte.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { compose } from '#lib/state/compose.svelte.ts';
import { contacts } from '#lib/state/contacts.svelte.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { edits } from '#lib/state/edits.svelte.ts';
import { folders } from '#lib/state/folders.svelte.ts';
import { forgetRegistered } from '#lib/state/forget.ts';
import { live } from '#lib/state/live.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { message } from '#lib/state/message.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { notifications } from '#lib/state/notifications.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { scheduled } from '#lib/state/scheduled.svelte.ts';
import { sentReplies } from '#lib/state/sent-replies.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { tagEdit } from '#lib/state/tag-edit.svelte.ts';
import { tags } from '#lib/state/tags.svelte.ts';
import { threads } from '#lib/state/threads.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/**
 * After a new session (sign-in, invitation accepted): first the
 * settings (the account's theme), then the account. `false` if the account
 * is not signed in afterwards (cookie rejected, session ended in the meantime).
 */
export async function loadSignedIn(): Promise<boolean> {
  try {
    await prefs.load();
  } catch {
    // Without settings the defaults apply.
  }
  try {
    await session.refreshUser();
  } catch {
    return false;
  }
  // Push subscriptions end with the session: register this browser for the new one (silently subscribes with the channel on).
  if (session.authed) {
    void push.resume().then(() => mailPush.resume());
    session.announce();
  }
  return session.authed;
}

// The session ended without signing out in this tab, or another tab signed in a different account:
// mail accounts, tokens, mailboxes and queues of the previous one no longer apply.
session.onEnd((next) => {
  // The error message that revealed the end (e.g. 401 on save) stays on the sign-in page.
  const failure = ui.toast?.error ? ui.toast.text : null;
  forgetAccount();
  if (failure) ui.toasts.error(failure);
  // A different account: its settings and push as after sign-in.
  if (next) void loadSignedIn();
});

/** Discards the account's state: menus, dialogs (also the folder and tag name dialog) and toasts, settings, live sync, mail accounts with mailboxes, lists, conversations and own edits, contacts for suggestions, identities and vacation notices, push of this session, bell notifications, the draft of the disabled banner and the sign-in, account. `forgetRegistered()` resets the settings page modules if they are loaded. */
export function forgetAccount(): void {
  // Before `devLog.clear()`: a simulation without a shell could no longer be stopped; the log belongs to the account.
  network.simulate(false);
  devLog.clear();
  ui.reset();
  prefs.reset();
  live.reset();
  scheduled.reset();
  accounts.reset();
  mailboxes.reset();
  threads.reset();
  message.reset();
  edits.reset();
  tags.reset();
  folders.reset();
  compose.reset();
  sentReplies.reset();
  // Identities, vacation notices, rules, banner and branding register on load (`onForget`):
  // their pages load them only when needed, the mailbox not at all.
  forgetRegistered();
  contacts.reset();
  push.reset();
  mailPush.reset();
  notifications.reset();
  tagEdit.close();
  mailLogin.reset();
  session.user = null;
  // Otherwise the copy would stay until the server answers again (effect in the layout).
  session.fromCopy = false;
  // Other tabs of the same account ask the server and discard their state as well.
  session.announce();
}

/**
 * Sends pending actions and settings, signs out at the server and
 * discards the state. `false` if signing out failed (then everything
 * stays as it is); 401 means "already signed out".
 */
export async function signOut(): Promise<boolean> {
  await Promise.all([ui.toasts.flush(), prefs.settled()]);
  // Before signing out; afterwards there are no tokens any more.
  await mailPush.withdraw();
  try {
    await api('POST', 'auth/logout');
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) return false;
  }
  await mailPush.clearDevice();
  forgetAccount();
  return true;
}
