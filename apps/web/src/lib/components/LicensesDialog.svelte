<!--
  Licenses dialog: all third-party packages from `licenses.json` with search,
  segment "Web app | Server" and expandable rows with the license texts.
  Values `lic` from `licenseValues()` in `#lib/licenses.svelte.ts`. The layout
  shows the dialog via `ui.pageDialog`: on desktop the component draws
  backdrop and dialog, on mobile the layout renders it in the sheet (then only
  the content). Escape closes (layout); the focus trap of the dialog or sheet
  handles returning to the row on close.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { onMount } from 'svelte';
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import type { LicenseValues } from '#lib/licenses.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    lic: LicenseValues;
    mobile: boolean;
  }

  let { lic, mobile }: Props = $props();

  const uid = $props.id();
  let dialog: HTMLDivElement | undefined = $state();
  let heading: HTMLHeadingElement | undefined = $state();
  let search: HTMLInputElement | undefined = $state();

  // On open: on desktop to the dialog, on mobile to the heading (no keyboard).
  onMount(() => {
    (mobile ? heading : dialog)?.focus({ preventScroll: true });
  });

  // On mobile focus stays on the heading after "Try again"; the button disappears while loading.
  function retry() {
    lic.retry();
    if (mobile) heading?.focus({ preventScroll: true });
  }

  // On desktop once into the search field as soon as the list is loaded – unless focus is already on an element in the dialog.
  let searched = false;
  $effect(() => {
    if (mobile || !search || searched) return;
    searched = true;
    const active = document.activeElement;
    if (!active || active === document.body || active === dialog) search.focus();
  });
</script>

{#snippet head()}
  <div class="head" class:m={mobile}>
    <div class="head-text">
      {#if mobile}
        <h2 class="title m" tabindex="-1" bind:this={heading}>{lic.title}</h2>
      {:else}
        <h2 id="{uid}-t" class="title">{lic.title}</h2>
      {/if}
      <div class="sub" class:m={mobile}>{lic.sub}</div>
    </div>
    {#if mobile}
      <button type="button" class="close m" aria-label={m.shell_close()} onclick={lic.close}
        ><Icon name="ti-x" /></button
      >
    {:else}
      <button
        type="button"
        class="close"
        aria-label={m.shell_close()}
        use:tooltip={m.lic_close_tip()}
        onclick={lic.close}><Icon name="ti-x" /></button
      >
    {/if}
  </div>
{/snippet}

{#snippet tools()}
  <div class="search" class:m={mobile}>
    <span class="search-icon"><Icon name="ti-search" /></span>
    <input
      bind:this={search}
      value={lic.q}
      oninput={(e) => lic.onQ(e.currentTarget.value)}
      placeholder={lic.ph}
      aria-label={lic.ph}
    />
  </div>
  <div class="segs" class:m={mobile} role="radiogroup" aria-label={m.lic_origin()} use:radiogroup>
    {#each lic.segs as g (g.id)}
      <button type="button" class="seg" class:on={g.on === 'true'} role="radio" aria-checked={g.on} onclick={g.onClick}
        >{g.label} <span class="n">{g.n}</span></button
      >
    {/each}
  </div>
{/snippet}

{#snippet card(alert: boolean, icon: IconName, title: string, text: string)}
  <div class="card" class:m={mobile} class:fail={alert} role={alert ? 'alert' : 'status'}>
    <span class="tile" aria-hidden="true"><Icon name={icon} /></span>
    <div class="card-title">{title}</div>
    <div class="card-text">{text}</div>
    {#if alert}
      <button type="button" class="retry" onclick={retry}><Icon name="ti-refresh" />{m.error_retry()}</button>
    {/if}
  </div>
{/snippet}

{#snippet body()}
  {#if lic.busy}
    <div class="sr-only" role="status">{lic.loading}</div>
    {#each lic.skel as k, i (i)}
      <div class="skel" aria-hidden="true">
        <span class="bar" style:width={k.w}></span>
        <span class="pill"></span>
      </div>
    {/each}
  {/if}
  {#if lic.fail}{@render card(true, 'ti-cloud-off', lic.failTitle, lic.failText)}{/if}
  {#if lic.note}{@render card(false, lic.noteIcon, lic.noteTitle, lic.noteText)}{/if}
  {#each lic.rows as r (r.key)}
    <div class="row" class:on={r.on}>
      <button type="button" class="toggle" aria-expanded={r.exp} onclick={r.toggle}>
        <span class="pkg"><span class="name">{r.name}</span> <span class="ver">{r.version}</span></span>
        <span class="tag">{r.lic}</span>
        <span class="chev"><Icon name="ti-chevron-down" /></span>
      </button>
      {#if r.on}
        <div class="detail">
          {#if r.hasUrl}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the package's project page -->
            <a class="site" href={r.url} target="_blank" rel="noopener noreferrer"
              >{r.site}<Icon name="ti-arrow-up-right" /></a
            >
          {/if}
          {#each r.texts as t, i (i)}
            <!-- Scrollable and reachable via Tab; `region`, because `aria-label` on `pre` (generic) is not allowed. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <pre class="text" role="region" tabindex="0" aria-label={t.label}>{t.t}</pre>
          {/each}
          {#if r.noText}<div class="no-text">{r.noTextLabel}</div>{/if}
        </div>
      {/if}
    </div>
  {/each}
{/snippet}

{#if !mobile}
  <div class="scrim" role="presentation" onmousedown={lic.overlay}>
    <div
      bind:this={dialog}
      class="dialog"
      role="dialog"
      aria-modal="true"
      use:focustrap
      aria-labelledby="{uid}-t"
      tabindex="-1"
    >
      {@render head()}
      {#if lic.ready}<div class="tools">{@render tools()}</div>{/if}
      <div class="scroll no-scrollbar" {@attach scrollbar} aria-busy={lic.busyAttr}>{@render body()}</div>
    </div>
  </div>
{:else}
  {@render head()}
  {#if lic.ready}{@render tools()}{/if}
  <div class="m-list" aria-busy={lic.busyAttr}>{@render body()}</div>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
    background: var(--scrim);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 32px;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    outline: none;
    width: 100%;
    max-width: 720px;
    height: 100%;
    max-height: 720px;
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* Head */
  .head {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 22px 16px 14px 26px;
  }

  .head.m {
    align-items: center;
    gap: 12px;
    padding: 4px 2px 12px 10px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.2;
  }

  .title.m {
    font-size: 20px;
    line-height: normal;
    outline: none;
  }

  .sub {
    margin-top: 4px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  .sub.m {
    margin-top: 2px;
    font-size: 13px;
  }

  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .close.m {
    width: 44px;
    height: 44px;
    transition: none;
  }

  .close.m:hover {
    background: none;
    color: var(--mfg);
  }

  .close.m:active {
    background: var(--hov);
  }

  /* Search and segment */
  .tools {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 12px;
  }

  .search {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 16px;
    display: grid;
    font-size: 18px;
    color: var(--mfg);
    pointer-events: none;
  }

  input {
    width: 100%;
    height: 44px;
    padding: 0 18px 0 44px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14.5px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .search.m input {
    height: 48px;
    font-size: 16px;
    transition: none;
  }

  input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .segs {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--sunken);
    flex-shrink: 0;
  }

  .segs.m {
    margin-top: 10px;
  }

  /* `lic.segs[].bg`, `.fg`, `.sh` from `on` */
  .seg {
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    box-shadow: none;
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .seg.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .segs.m .seg {
    flex: 1;
    min-width: 0;
    height: 38px;
    justify-content: center;
    padding: 0;
    font-size: 14px;
    transition: none;
  }

  .n {
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
  }

  .segs.m .n {
    font-size: 12.5px;
  }

  /* List */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 12px 16px;
  }

  .m-list {
    margin-top: 10px;
    padding-bottom: 6px;
  }

  .skel {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
  }

  .m-list .skel {
    height: 56px;
    padding: 0 12px;
  }

  .bar,
  .pill {
    border-radius: 9999px;
    background: var(--sunken);
    animation: var(--shim, none);
  }

  /* Width from `lic.skel[].w` */
  .bar {
    height: 12px;
  }

  .pill {
    margin-left: auto;
    width: 72px;
    height: 24px;
  }

  .m-list .pill {
    width: 64px;
  }

  /* Cards: failed (`lic.fail`) and hint (`lic.note`) */
  .card {
    margin: 4px 4px 0;
    padding: 34px 24px;
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .card.fail {
    padding: 40px 24px;
    animation: snFade 200ms ease-out;
  }

  .card.m {
    margin: 0;
    padding: 30px 20px;
    border-radius: 24px;
    animation: none;
  }

  .card.m.fail {
    padding: 34px 20px;
  }

  .tile {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 26px;
    color: var(--mfg);
  }

  .fail .tile {
    color: var(--danger);
  }

  .card.m .tile {
    width: 52px;
    height: 52px;
    border-radius: 17px;
    font-size: 24px;
  }

  .card-title {
    margin-top: 16px;
    font-family: var(--font-serif);
    font-size: 20px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .card.m .card-title {
    margin-top: 14px;
    font-size: 19px;
  }

  .card-text {
    margin-top: 6px;
    max-width: 440px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .fail .card-text {
    margin-top: 8px;
    font-size: 14.5px;
  }

  .card.m .card-text {
    max-width: none;
    font-size: 14px;
  }

  .retry {
    margin-top: 20px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .retry :global(svg) {
    font-size: 17px;
  }

  .retry:hover {
    background: var(--sunken);
  }

  .card.m .retry {
    margin-top: 18px;
    height: 48px;
    padding: 0 20px 0 16px;
    font-size: 15px;
    white-space: normal;
    transition: none;
  }

  .card.m .retry :global(svg) {
    font-size: 18px;
  }

  .card.m .retry:hover {
    background: var(--surface);
  }

  .card.m .retry:active {
    background: var(--sunken);
  }

  /* Rows; `lic.rows[].bg` and `.rot` from `on` */
  .row {
    border-radius: 18px;
    background: transparent;
    transition: background-color var(--dur, 220ms);
  }

  .row.on {
    background: var(--surface2);
  }

  .m-list .row {
    transition: none;
  }

  .toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 8px 12px 8px 16px;
    border-radius: 18px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .toggle:hover {
    background: var(--hov);
  }

  .m-list .toggle {
    gap: 10px;
    min-height: 56px;
    padding: 8px 8px 8px 12px;
    transition: none;
  }

  .m-list .toggle:hover {
    background: none;
  }

  .m-list .toggle:active {
    background: var(--hov);
  }

  .pkg {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    column-gap: 8px;
  }

  .m-list .pkg {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 2px;
  }

  .name {
    font-size: 14.5px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .m-list .name {
    font-size: 15px;
  }

  .ver {
    font-size: 12.5px;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
  }

  /* SPDX tag, truncated with ellipsis (line height of the pill, not 1). */
  .tag {
    flex-shrink: 0;
    max-width: 220px;
    height: 26px;
    padding: 0 10px;
    border-radius: 9999px;
    background: var(--sunken);
    display: block;
    font-size: 12px;
    font-weight: 800;
    line-height: 26px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-list .tag {
    max-width: 140px;
  }

  .chev {
    display: grid;
    font-size: 17px;
    color: var(--dim);
    transform: none;
    transition: transform var(--dur, 220ms);
  }

  .row.on .chev {
    transform: rotate(180deg);
  }

  .m-list .chev {
    transition: none;
  }

  .detail {
    padding: 0 12px 14px 16px;
  }

  .m-list .detail {
    padding: 0 10px 12px 12px;
  }

  .site {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 13px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
    text-decoration: none;
  }

  .site:hover {
    text-decoration: none;
  }

  .site :global(svg) {
    font-size: 15px;
    color: var(--mfg);
  }

  .m-list .site {
    height: 36px;
    padding: 0 14px 0 12px;
    font-size: 13.5px;
  }

  .text {
    margin: 10px 0 0;
    max-height: 260px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--surface);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    outline: none;
  }

  .text:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .m-list .text {
    max-height: 240px;
    padding: 12px 14px;
    font-size: 11.5px;
  }

  .no-text {
    margin-top: 10px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  .m-list .no-text {
    font-size: 14px;
  }
</style>
