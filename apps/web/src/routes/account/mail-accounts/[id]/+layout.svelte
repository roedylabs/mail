<!--
  Mail account: header of the subpages – on desktop address, title and
  description, on mobile title and description. The list of subpages shows
  the app layout instead of the page on mobile; it also leads an unknown
  account to the list.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { mailAccountPageOf, mailAccountRouteOf } from '#lib/mail-account.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { children }: { children: Snippet } = $props();

  const route = $derived(mailAccountRouteOf(page.url.pathname));
  const account = $derived(route ? accounts.get(route.id) : undefined);
  const info = $derived(route ? mailAccountPageOf(route.slug) : null);
</script>

{#if info}
  {#if !ui.isMobile}
    <div class="addr">{account?.email ?? ''}</div>
    <h1 class="title">{info.label}</h1>
    <p class="lead">{info.desc}</p>
  {:else}
    <h1 class="m-title">{info.label}</h1>
    <p class="m-lead">{info.desc}</p>
  {/if}
{/if}
{@render children()}

<style>
  .addr {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .title {
    margin: 6px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
  }

  .lead {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
    text-wrap: pretty;
  }

  .m-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
  }

  .m-lead {
    margin: 8px 0 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--mfg);
  }
</style>
