/** Sign-out from the account menu, command palette and "Session expired". */
import { hideTooltip } from '#lib/actions/tooltip.ts';
import { m } from '#lib/paraglide/messages.js';
import { signOut } from '#lib/state/account.ts';
import { search } from '#lib/state/search.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Send pending actions and settings, end the session, discard the state of the account. */
export async function logout(): Promise<void> {
  ui.closeMenu();
  hideTooltip();
  // If it fails on the network, the app stays signed in and shows the error.
  if (!(await signOut())) {
    ui.toasts.error(m.error_logout());
    return;
  }
  search.reset();
}
