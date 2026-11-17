/**
 * Search hits for the results page and the search suggestions: ready mail
 * accounts, clock, users of the administration, message context and the
 * scored hits of all categories with the values of the results
 * (`resultsValues`). Create in a component's script because the effects are
 * bound to it: the server query follows text, filters and accounts
 * (`search.sync()`), the server fetches hits from the cache again after the
 * network returns (`search.resume()`).
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import { untrack } from 'svelte';
import { api } from '#lib/api.ts';
import { timeZoneOf } from '#lib/errors.ts';
import { modKey } from '#lib/keys.ts';
import { roleLabel } from '#lib/mailbox-nav.ts';
import type { TimeContext } from '#lib/mail-list.ts';
import { openDraft } from '#lib/open-draft.ts';
import { ALL_ACCOUNTS, mailboxParams } from '#lib/routes.ts';
import { hitBox, notifItems, searchCandidates } from '#lib/search-items.ts';
import {
  mailItems,
  resultsValues,
  scoreAll,
  searchCats,
  type HitBox,
  type MailContext,
  type MailHit,
  type ResultsValues,
} from '#lib/search.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { contacts } from '#lib/state/contacts.svelte.ts';
import { listView } from '#lib/state/list-view.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { notifications } from '#lib/state/notifications.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { search, type ReturnKind } from '#lib/state/search.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { tags } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type { ListedUser } from '#lib/users.svelte.ts';

/**
 * Open a found email: thread in its folder. An email in the account's drafts
 * opens compose, back to "Drafts" (`select` + `pfOpen`); not after another
 * navigation meanwhile.
 */
export function openHit(hit: MailHit, box: HitBox): void {
  const drafts = mailboxes.role(hit.account, 'drafts')?.id;
  if (drafts && hit.mailboxIds[drafts]) {
    const list = mailboxParams(hit.account, { role: 'drafts' });
    const ret = { href: resolve('/mailbox/[account]/[...path]', list), label: roleLabel('drafts') };
    // Only once compose opens: otherwise no choice waits for "Drafts".
    void openDraft(hit.account, hit.id, ret).then((opened) => {
      if (opened) listView.choose(ret.href, page.url.pathname);
    });
    return;
  }
  const { account, path } = mailboxParams(hit.account, box.target);
  const to = resolve('/mailbox/[account]/[...path]', { account, path: `${path}/${encodeURIComponent(hit.threadId)}` });
  listView.choose(to, page.url.pathname);
  void goto(to);
}

export class SearchView {
  /** Key for shortcuts; per call so that the label follows the language. */
  get mod(): string {
    return modKey();
  }
  /** Ready mail accounts: signed in and not locked. */
  readonly ready = $derived((accounts.list ?? []).filter((a) => a.state === 'ok' && !a.blocked));
  readonly ids = $derived(this.ready.map((a) => a.id));
  /** Offline or hits from the cache: only stored messages, only subject, sender and preview. */
  readonly srOff = $derived(network.offline || search.local);
  /** Users of the administration for the category "Administration"; once per view from the first search on, errors stay silent. */
  users = $state.raw<ListedUser[]>([]);
  /** Clock for "Today", "Yesterday" and the times; renewed every minute. */
  now = $state(Date.now());

  readonly time: TimeContext = $derived({
    now: this.now,
    tz: timeZoneOf(prefs.values),
    timeFmt: prefs.values.timeFmt,
    weekStart: prefs.values.weekStart,
    dateFmt: prefs.values.dateFmt,
  });

  /** Folders and tags per ready account, once per change instead of per hit. */
  readonly #boxIndex = $derived(
    Object.fromEntries(
      this.ready.map((a) => {
        const byBox = tags.byMailbox(a.id);
        return [a.id, { boxes: mailboxes.list(a.id), tagOf: (id: string) => byBox.get(id) }] as const;
      }),
    ),
  );

  readonly mailCtx: MailContext = $derived({
    time: this.time,
    multi: this.ready.length > 1,
    email: (account: string) => accounts.get(account)?.email ?? '',
    box: (hit: MailHit) => {
      const c = this.#boxIndex[hit.account];
      return c ? hitBox(hit, c.boxes, c.tagOf) : null;
    },
    open: (hit: MailHit, box: HitBox | null) => {
      if (box) openHit(hit, box);
    },
  });

  readonly candidates = $derived.by(() => {
    const actions = search.actions;
    if (!actions) return [];
    return searchCandidates({
      isAdmin: session.isAdmin,
      isMobile: ui.isMobile,
      dark: ui.dark,
      advanced: prefs.values.advanced,
      mod: this.mod,
      accounts: this.ready.map((a) => ({ id: a.id, email: a.email })),
      mailboxes: (account) => mailboxes.list(account),
      tags: tags.tree(this.ids),
      tagAccount: this.ready.length > 1 ? ALL_ACCOUNTS : (this.ready[0]?.id ?? null),
      contacts: contacts.list,
      users: this.users,
      me: session.user?.id ?? null,
      actions,
    });
  });

  /** Notifications of the bell; apart from `candidates` because the time on the right follows the clock. */
  readonly notifs = $derived.by(() => {
    const actions = search.actions;
    return actions
      ? notifItems(notifications.list ?? [], this.time, actions.go, (id) => void notifications.read(id))
      : [];
  });

  /** Filters, category of the view and operators in the search text combined. */
  readonly eff = $derived(search.effective());

  readonly items = $derived([
    ...scoreAll(this.candidates, this.eff.terms.terms),
    ...scoreAll(this.notifs, this.eff.terms.terms),
    ...mailItems(
      search.hits,
      this.eff.terms,
      this.mailCtx,
      this.eff.terms.terms.length > 0 || this.eff.cats.includes('files'),
      this.eff.fields,
    ),
  ]);

  /** After `search.done()`, e.g. to close the search suggestions. */
  #done: () => void = () => {};
  /** Kind of return path a hit remembers; none without (search suggestions). */
  #returnKind: (() => ReturnKind) | null = null;

  /** Results; an executed row remembers the search and clears text and filters. */
  readonly rp: ResultsValues = $derived(
    resultsValues({
      q: search.q,
      terms: this.eff.terms,
      allowed: searchCats(session.isAdmin),
      cats: this.eff.cats,
      mailF: this.eff.mailF,
      chips: search.chips,
      items: this.items,
      mailTotal: search.mailTotal,
      setCats: (cats) => search.set({ cats }),
      clearFilters: () => search.clearFilters(),
      done: () => {
        // Before clearing: the hit's navigation takes the search along as the return path.
        if (this.#returnKind) search.expectReturn(this.#returnKind());
        search.done();
        this.#done();
      },
    }),
  );

  /**
   * `done` runs after a hit; `returnKind` makes a hit remember the search
   * as the way back (results page, mobile search), the search suggestions
   * remember none.
   */
  constructor(done?: () => void, returnKind?: () => ReturnKind) {
    if (done) this.#done = done;
    if (returnKind) this.#returnKind = returnKind;
    // Without the clock: the query follows text, filters and accounts, not every minute.
    $effect(() => search.sync());
    // Fetch hits from the cache from the server: after the network returns and when opening the view.
    $effect(() => {
      untrack(() => search.resume());
      return network.onReturn(() => search.resume());
    });
    // Only once there is a search: the suggestions remount on every focus and show no users when idle.
    let usersAsked = false;
    $effect(() => {
      if (!session.isAdmin || usersAsked || this.rp.idle) return;
      usersAsked = true;
      api<{ users: ListedUser[] }>('GET', 'users').then(
        (r) => (this.users = r.users),
        () => {},
      );
    });
    $effect(() => {
      untrack(() => {
        void contacts.ensure();
        // The bell loads on its own schedule; without a list yet (failed or pending first fetch) the search asks.
        if (notifications.list === null) void notifications.load();
      });
      const timer = setInterval(() => (this.now = Date.now()), 60_000);
      return () => clearInterval(timer);
    });
  }
}
