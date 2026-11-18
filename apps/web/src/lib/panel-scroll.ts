/**
 * Scroll position of the mobile panel (settings, account, administration): it starts at the top
 * after every switch between the area's list and a page and between two pages. Within the pages of
 * one email account (a link to another subpage, the account selection) and between its subpages'
 * list and the account selection the position stays.
 */
import { mailAccountRouteOf } from '#lib/mail-account.svelte.ts';

/** What the panel shows; the layout scrolls it to the top when the key changes. */
export function panelScrollKey(path: string, list: boolean): string {
  const view = mailAccountRouteOf(path) ? 'mail-account' : path;
  return `${list ? 'list' : 'page'} ${view}`;
}
