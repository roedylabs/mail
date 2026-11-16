<!--
  Compose page: `/compose/new` for a new email, `/compose/<account>%2F<id>`
  for a saved draft (like threads in "All accounts"). The state lives in
  `compose`; entry points (C, palette, "New email", drafts, `mailto:`) open
  it before navigating. Without an
  open compose (reloaded, direct address) the page opens it itself. After
  every save the address carries the new id so that reloading opens the draft
  again. Leaving without closing saves (`cmpPark`).
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import ComposeView from '#lib/components/ComposeView.svelte';
  import { timeZoneOf } from '#lib/errors.ts';
  import { mailboxPath } from '#lib/routes.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import {
    compose,
    NEW_DRAFT,
    parseDraftRef,
    parseMailto,
    type ComposeActions,
    type ComposeNav,
  } from '#lib/state/compose.svelte.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const ref = $derived(page.params.draft ?? NEW_DRAFT);
  const hrefOf = (r: string) => resolve('/compose/[draft]', { draft: encodeURIComponent(r) });

  function go(href: string, options: Parameters<typeof goto>[1] = {}) {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- return paths come from page.url or mailboxPath()
    void goto(href, options);
  }

  /**
   * Draft the address carries after the last shallow replace; `page.params` stays
   * unchanged by that, a real navigation resets it.
   */
  let shown: string | null = null;

  /** Address → compose: an open compose with this address stays, otherwise open or load. */
  async function enter(r: string) {
    if (compose.ref === r) return;
    const target = parseDraftRef(r);
    if (target === undefined) {
      go(hrefOf(NEW_DRAFT), { replace: true });
      return;
    }
    await accounts.ensure().catch(() => {});
    if (page.params.draft !== r || compose.ref === r) return;
    if (target === null) {
      // `mailto:` of the installed app: the system opens this address (manifest protocol handler).
      const init = parseMailto(page.url.searchParams.get('mailto') ?? '');
      if (!compose.start(init ?? {})) go(resolve('/start'), { replace: true });
      return;
    }
    // The draft no longer exists or does not load: to the account's drafts.
    if (!(await compose.openDraft(target.account, target.id)) && page.params.draft === r && !compose.current) {
      go(accounts.get(target.account) ? mailboxPath(target.account, { role: 'drafts' }) : resolve('/start'), {
        replace: true,
      });
    }
  }

  $effect(() => {
    const r = ref;
    untrack(() => {
      shown = null;
      void enter(r);
    });
  });

  // After saving the id changes: update the address shallowly without navigating (only `compose.ref` counts).
  $effect(() => {
    const r = compose.ref;
    untrack(() => {
      if (!r || r === NEW_DRAFT || r === (shown ?? ref)) return;
      shown = r;
      go(hrefOf(r), { replace: true, shallow: true, state: {} });
    });
  });

  onDestroy(() => compose.park());

  const nav: ComposeNav = {
    leave: (ret, replace = false) => go(ret.href, { replace }),
    reopen: () => go(hrefOf(compose.ref ?? NEW_DRAFT)),
  };

  const act: ComposeActions = {
    close: () => void compose.close(nav),
    discard: () => compose.discard(nav),
    send: () => compose.send(nav),
    addFiles: (files) => void compose.addFiles(files),
    removeAttachment: (key) => compose.removeAttachment(key),
    retryAttachment: (key) => compose.retryAttachment(key),
    later: () => compose.toggleLater(ui.isMobile),
    pickLater: (key) => void compose.plan(nav, key),
    setLater: (value) => compose.setLater(value),
    plan: () => void compose.plan(nav),
    toggleFrom: () => compose.toggleFrom(),
    closeMenu: () => compose.closeMenu(),
    pickFrom: (key) => compose.pickFrom(key),
    input: (field, value) => compose.input(field, value),
    commit: (field) => compose.commit(field),
    remove: (field, index) => compose.remove(field, index),
    removeLast: (field) => compose.removeLast(field),
    moveSuggestion: (field, step) => compose.moveSuggestion(field, step),
    pickSuggestion: (field, index) => compose.pickSuggestion(field, index),
    focus: (field) => compose.focus(field),
    blur: (field) => compose.blur(field),
    showCc: () => compose.showCc(),
    setSubject: (value) => compose.setSubject(value),
    setText: (value) => compose.setText(value),
    toggleSig: () => compose.toggleSig(),
    toggleQuote: () => compose.toggleQuote(),
  };

  const cm = $derived(compose.values({ tz: timeZoneOf(prefs.values), timeFmt: prefs.values.timeFmt }));
</script>

<!-- On mobile a background tab often ends without `pagehide`: send on hiding too (like `Toasts.attach`). -->
<svelte:window onpagehide={() => compose.flush()} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && compose.flush()} />

{#if cm}
  <ComposeView {cm} {act} isMobile={ui.isMobile} />
{/if}
