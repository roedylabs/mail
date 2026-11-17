/**
 * Segment (`pfFilter`) and sorting of the "Compact" form (`pfSort`, `pfDir`)
 * of the mailbox list. Both last until the app is reloaded, also while other
 * pages are open in between (search, compose, settings) and across the switch
 * between the layout's desktop and mobile branch, which recreates the page.
 *
 * Every choice of a mailbox, folder, tag or account (`select`, `swPick`:
 * sidebar, "Mailboxes" sheet, account switch, keys 1–6, palette, search hits)
 * starts its list with the segment "All" and without selection and focus, the
 * same list again too. The sorting stays. Other ways to a list (back and
 * forward, the logo, leaving a deleted folder or tag) keep the segment as long
 * as the list has it.
 */
import { DEFAULT_SORT, type ListSort, type Segment } from '#lib/mail-list.ts';

export class ListView {
  /** Selected segment; a list without it shows "All". */
  segment = $state<Segment>('all');
  sort = $state<ListSort>(DEFAULT_SORT);
  /** Number of completed choices: selection and focus start anew with each, also in the same list. */
  chosen = $state(0);
  /** Address of the chosen list while the navigation there is still running. */
  #to = $state<string | null>(null);

  /**
   * A mailbox, folder, tag or account was chosen, its list or one of its
   * threads at the address `to`; `here` is the open address. At once if both
   * are the same, otherwise once the page shows `to` (`reached`): the previous
   * list does not reload in "All" meanwhile.
   */
  choose(to: string, here: string): void {
    if (to === here) this.#complete();
    else this.#to = to;
  }

  /** Segment of the list at `pathname`: "All" as soon as a choice of it is on the way. */
  segmentAt(pathname: string): Segment {
    return this.#to === pathname ? 'all' : this.segment;
  }

  /** The page shows `pathname`: completes a choice on the way there. */
  reached(pathname: string): void {
    if (this.#to === pathname) this.#complete();
  }

  #complete(): void {
    this.#to = null;
    this.segment = 'all';
    this.chosen += 1;
  }
}

export const listView = new ListView();
