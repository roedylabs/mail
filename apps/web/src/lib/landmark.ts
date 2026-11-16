/**
 * Main landmark: every route has exactly one `main`. On desktop the layout puts
 * the content into the content card `main`, on mobile only in settings, account
 * and administration; mailbox, reading view, search and composer set their own
 * on mobile. Pages that appear in both situations (error pages, "No account")
 * ask here whether their root itself must be `main`.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('in-main');

/** Layout: whether the content of the route is already inside `main` (a function so that it follows the state). */
export function setInMain(inMain: () => boolean): void {
  setContext(KEY, inMain);
}

/** Element of the root of a page: `main` as long as the layout puts none around it (also without a layout). */
export function rootTag(): () => 'main' | 'div' {
  const inMain = getContext<(() => boolean) | undefined>(KEY);
  return () => (inMain?.() ? 'div' : 'main');
}
