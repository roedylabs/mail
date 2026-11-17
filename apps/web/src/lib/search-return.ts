/**
 * Return path to the search after opening a hit (`navRet`): a hit from the
 * results page or the mobile search remembers the search; the opened message
 * or page shows "Search results" or "Search" as its way back and returns
 * there. The state lives in `search` (`#lib/state/search.svelte.ts`); here
 * the addresses, texts and the navigation back.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { m } from '#lib/paraglide/messages.js';
import { parseMailboxPath, START_PATH } from '#lib/routes.ts';
import { search, type ReturnKind } from '#lib/state/search.svelte.ts';

/**
 * A target that keeps the return path (`navTarget`): an open message or a
 * page outside the mailbox lists; not a list, the start page or the search itself.
 */
export function returnable(path: string): boolean {
  const at = parseMailboxPath(path);
  if (at) return !!at.thread;
  return path !== resolve('/search') && path !== START_PATH && path !== resolve('/');
}

/** Short label (reading view, mobile back bar): "Search" or "Search results". */
export function returnLabel(kind: ReturnKind): string {
  return kind === 'results' ? m.search_kicker() : m.shell_search();
}

/** Back button of the settings navigation (desktop): "Back to search" or "Back to search results". */
export function returnBackLabel(kind: ReturnKind): string {
  return kind === 'results' ? m.search_back_results() : m.search_back_search();
}

/** Back to the search if a return path applies at `path` (`navBack()`); otherwise `false`. */
export function returnToSearch(path: string): boolean {
  if (!search.takeReturn(path)) return false;
  void goto(resolve('/search'));
  return true;
}
