<!--
  Leads to the inbox of the start view: "All accounts" if that is the
  default and there is more than one account, otherwise the default account
  or the first one. Until the mail accounts are there, the skeleton shows
  (`skHome`); if they cannot be loaded, the "Nothing here yet" empty state
  with the error as a toast; every further visit (logo) tries again. The
  redirect waits for the settings (default account). Without a mail account
  the layout redirects to the "no account" page. With "Open on startup: Last
  opened page" (`gStart`) the entry (not the logo) leads to the last opened
  page of this device (`#lib/last-page.ts`).
-->
<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { navigating } from '$app/state';
  import EmptyArt from '#lib/components/EmptyArt.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { failText } from '#lib/errors.ts';
  import { isEntry, lastPage } from '#lib/last-page.ts';
  import { sidebarScope } from '#lib/mailbox-nav.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { mailboxParams } from '#lib/routes.ts';
  import type { StartValues } from '#lib/shell.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const values: StartValues = { emptyArt };

  let failed = $state(false);
  /**
   * Visit on entry (without predecessor, from "/", after sign-in), not via the
   * logo; `null` until `arrive` knows the predecessor – before that the page does
   * not redirect (SvelteKit only reports it after mounting).
   */
  let entry = $state<boolean | null>(null);

  const home = $derived.by(() => {
    // Before the account's settings the default would apply (first instead of default account).
    if (entry === null || !prefs.loaded || !accounts.list?.length) return null;
    const last =
      entry && prefs.values.gStart === 'last' && session.user ? lastPage(session.user.id, session.isAdmin) : null;
    if (last) return last;
    const key = sidebarScope(accounts.list, prefs.values.defaultAccount, null).key;
    return key ? resolve('/mailbox/[account]/[...path]', mailboxParams(key, { role: 'inbox' })) : null;
  });

  /** On opening and on every further visit of the same address (logo), then again after an error. */
  function arrive(from: string | null) {
    entry = isEntry(from);
    failed = false;
    // At startup the layout reports the same error; the toast then only replaces its own.
    accounts.ensure().catch((error: unknown) => {
      failed = true;
      ui.toasts.error(failText(error));
    });
  }

  // At app startup `from.url` is `null` in the SPA, unlike in SvelteKit's type.
  afterNavigate(({ from }) => arrive(from?.url?.pathname ?? null));
  // After a full load the layout only mounts the page once the app is ready: startup is over by then
  // and no report follows. If nothing was reported without a running navigation, it is the entry.
  $effect(() => {
    if (entry === null && !navigating.to) arrive(null);
  });

  // The start page itself does not stay in the history: "Back" does not lead back here.
  $effect(() => {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- `home` is resolved with resolve()
    if (home) void goto(home, { replace: true });
  });
</script>

{#snippet emptyArt()}<EmptyArt logo={session.logo} />{/snippet}

{#if !failed || home}
  <Skeleton kind="home" isMobile={ui.isMobile} />
{:else}
  <div class="start no-scrollbar" class:mobile={ui.isMobile}>
    <div class="content">
      {#if ui.isMobile}
        <div class="art-frame"><div class="art">{@render values.emptyArt()}</div></div>
      {:else}
        {@render values.emptyArt()}
      {/if}
      <h1>{m.start_empty_title()}</h1>
      <p class="text">{m.start_empty_text()}</p>
    </div>
  </div>
{/if}

<style>
  .start {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .start.mobile {
    margin: 6px 12px 0;
    touch-action: pan-y;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    padding: 24px 20px;
  }

  .content {
    width: 100%;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .mobile .content {
    max-width: 320px;
  }

  .art-frame {
    position: relative;
    width: 224px;
    height: 152px;
    flex-shrink: 0;
  }

  .art {
    position: absolute;
    left: -28px;
    top: 0;
    transform: scale(0.8);
    transform-origin: top center;
  }

  h1 {
    margin: 26px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 27px;
    line-height: 1.2;
  }

  .mobile h1 {
    margin-top: 20px;
    font-size: 23px;
  }

  .text {
    margin: 10px 0 0;
    font-size: 15.5px;
    line-height: 1.6;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .text {
    margin-top: 8px;
    font-size: 14.5px;
    line-height: 1.55;
  }
</style>
