/**
 * Reset at the end of a session (`forgetAccount` in `#lib/state/account.ts`)
 * for state modules that not every route loads (settings, account and
 * administration pages): they register themselves when loaded instead of
 * `account.ts` importing them and pulling them into the first load of every route
 * (JS budget of the mailbox route). A module that was not loaded has
 * nothing to reset; it may therefore only keep state in its own memory,
 * none in other modules, in IndexedDB or in caches.
 */

const resets = new Set<() => void>();

/** Registers `reset` for `forgetAccount()` (module-wide on load); the same function counts once. */
export function onForget(reset: () => void): void {
  resets.add(reset);
}

/** Resets all registered modules, synchronously and in registration order. */
export function forgetRegistered(): void {
  for (const reset of resets) reset();
}
