<!--
  Administration › Audit log: search, export, filters with counts, entries by
  day and retention. Flow in `#lib/audit.svelte.ts`; the page derives the
  style classes (filter, segment, tile) from `on` and `warn`. Until the first
  response an empty frame the size of the empty state is shown, on failure
  per part the "Loading failed" card as on Account › Mail accounts ›
  Identities; further pages load via "Load more entries".
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import { AuditPage, auditValues, type AuditFailure } from '#lib/audit.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import { timeZoneOf } from '#lib/errors.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const p = new AuditPage();
  // `now` lives here so that "Today" and "Yesterday" are right for every new list.
  const v = $derived(auditValues(p, { now: Date.now(), tz: timeZoneOf(prefs.values), timeFmt: prefs.values.timeFmt }));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/audit-log'));
  let input: HTMLInputElement | undefined = $state();

  /** The button disappears with the text; the focus stays in the search. */
  function clear(): void {
    v.clearAQ();
    input?.focus();
  }

  onMount(() => {
    p.open();
    return () => p.dispose();
  });
</script>

{#snippet failure(title: string, load: AuditFailure)}
  <MailLoadCard
    icon="ti-cloud-off"
    {title}
    text={load.text}
    load={{ text: load.text, retry: true, reauth: false, con: false, onRetry: load.onRetry, goCon: () => {} }}
  />
{/snippet}

<div class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <div class="bar">
    <div class="search">
      <span class="search-icon"><Icon name="ti-search" /></span>
      <input
        bind:this={input}
        value={v.aQ}
        placeholder={m.audit_search_ph()}
        aria-label={m.audit_search_label()}
        oninput={(e) => v.onAQ(e.currentTarget.value)}
      />
      {#if v.aHasQ}
        <button
          type="button"
          class="clear"
          aria-label={m.shell_search_clear()}
          use:tooltip={isMobile ? undefined : m.shell_search_clear()}
          onclick={clear}><Icon name="ti-x" /></button
        >
      {/if}
    </div>
    <button type="button" class="export" aria-label={isMobile ? m.audit_export() : undefined} onclick={v.aExport}>
      <Icon name="ti-download" />{#if !isMobile}{m.audit_export()}{/if}
    </button>
  </div>

  <div role="group" class="pills no-scrollbar">
    {#each v.aPills as o (o.key)}
      <button type="button" class="pill" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>
        {o.label}<span class="n">{o.n}</span>
      </button>
    {/each}
  </div>

  <div aria-busy={v.aBusyAttr}>
    {#each v.aGroups as g (g.day)}
      <div class="day">
        <h2>{g.label}</h2>
        <div class="list">
          {#each g.rows as e (e.id)}
            <div>
              {#if e.sep}<div class="sep"></div>{/if}
              <div class="entry">
                <span class="tile" class:warn={e.warn}><Icon name={e.icon} /></span>
                <div class="body">
                  <div class="line"><span class="who">{e.who}</span>{e.act}</div>
                  <div class="meta">{isMobile ? e.mMeta : e.meta}</div>
                </div>
                {#if !isMobile}<span class="cat">{e.cat}</span>{/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/each}
    {#if v.aEmpty}
      <div class="empty"><div class="empty-text">{m.audit_empty()}</div></div>
    {/if}
    {#if v.aFirst}
      <div class="empty first" role="status" aria-busy="true" aria-label={m.audit_loading()}>
        <div class="empty-text">&nbsp;</div>
      </div>
    {/if}
    {#if v.aLoad.fail}
      <div class="load">{@render failure(m.audit_load_failed(), v.aLoad)}</div>
    {/if}
    {#if v.aMore.show}
      <div class="more">
        <button type="button" aria-busy={v.aMore.busy} class:busy={v.aMore.busy} onclick={v.aMore.onClick}>
          <Icon name={v.aMore.busy ? 'ti-loader-2' : 'ti-chevron-down'} />{v.aMore.label}
        </button>
      </div>
    {/if}
  </div>

  <section data-sec="keep" class="keep">
    <h2>{m.audit_keep_title()}</h2>
    <p class="keep-desc">{isMobile ? m.audit_keep_desc_mobile() : m.audit_keep_desc()}</p>
    {#if v.aKeepLoad.box}
      <div class="box" aria-busy={v.aKeepLoad.busy}>
        <div class="keep-row">
          <div class="keep-text">
            <div class="label">{m.audit_keep_row()}</div>
            <div class="desc">{v.aKeepSum || '\u00a0'}</div>
          </div>
          <div role="group" aria-label={m.audit_keep_row()} class="seg">
            {#each v.aKeepOpts as o (o.days)}
              <button
                type="button"
                class:on={o.on}
                class:dis={o.dis}
                aria-pressed={o.on}
                aria-disabled={o.dis}
                onclick={o.onClick}>{o.label}</button
              >
            {/each}
          </div>
        </div>
      </div>
    {/if}
    {#if v.aKeepLoad.fail}
      <div class="keep-load">{@render failure(m.audit_keep_load_failed(), v.aKeepLoad)}</div>
    {/if}
  </section>
</div>

<style>
  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
  }

  .lead {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
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

  /* Search and export */
  .bar {
    margin-top: 26px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .mobile .bar {
    margin-top: 20px;
    gap: 8px;
    flex-wrap: nowrap;
  }

  .search {
    position: relative;
    flex: 1 1 260px;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .mobile .search {
    flex: 1;
  }

  .search-icon {
    position: absolute;
    left: 17px;
    display: grid;
    font-size: 18px;
    color: var(--mfg);
    pointer-events: none;
  }

  .mobile .search-icon {
    left: 16px;
  }

  input {
    width: 100%;
    height: 46px;
    padding: 0 46px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14.5px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .mobile input {
    padding: 0 46px 0 44px;
    font-size: 16px;
    transition: none;
  }

  input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .clear {
    position: absolute;
    right: 6px;
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 16px;
  }

  .clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .clear {
    right: 2px;
    width: 42px;
    height: 42px;
    font-size: 17px;
  }

  .mobile .clear:hover {
    background: none;
    color: var(--mfg);
  }

  /* "Export as CSV" and "Load more entries" */
  .export,
  .more button {
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .export:hover,
  .more button:hover {
    transform: translateY(-2px);
  }

  .mobile .export,
  .mobile .more button {
    transition: none;
  }

  .mobile .export:hover,
  .mobile .more button:hover {
    transform: none;
  }

  .export {
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 18px 0 14px;
  }

  .export :global(svg) {
    font-size: 17px;
  }

  .mobile .export {
    width: 46px;
    flex-shrink: 0;
    padding: 0;
  }

  .mobile .export :global(svg) {
    font-size: 19px;
  }

  .more {
    margin-top: 16px;
    display: flex;
    justify-content: center;
  }

  .more button {
    height: 46px;
    min-width: 240px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 18px 0 14px;
  }

  .more button :global(svg) {
    display: block;
    font-size: 17px;
  }

  /* Loading more (`aMore.busy`): spinner, cursor `progress`, further clicks have no effect. */
  .more button.busy {
    cursor: progress;
  }

  .more button.busy :global(svg) {
    animation: var(--spin, none);
  }

  .mobile .more {
    margin-top: 14px;
  }

  .mobile .more button {
    flex: 1;
    min-width: 0;
  }

  .mobile .more button:active {
    background: var(--sunken);
  }

  /* Filter */
  .pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  .mobile .pills {
    flex-wrap: nowrap;
    margin: 14px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
  }

  .pill {
    height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 15px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--fg);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .pill.on {
    background: var(--ink);
    color: var(--inkfg);
  }

  .pill:not(.on):hover {
    background: var(--sunken);
  }

  .mobile .pill {
    flex-shrink: 0;
    padding: 0 6px 0 14px;
    font-size: 13.5px;
    transition: none;
  }

  .mobile .pill:not(.on):hover {
    background: var(--surface2);
  }

  .n {
    min-width: 26px;
    height: 26px;
    padding: 0 8px;
    border-radius: 9999px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .pill.on .n {
    background: color-mix(in oklab, var(--inkfg) 18%, transparent);
  }

  .mobile .n {
    font-variant-numeric: normal;
  }

  /* Days */
  .day {
    margin-top: 24px;
  }

  .mobile .day {
    margin-top: 20px;
  }

  /* Days are h2 below the page's h1 but look like h3. */
  .day h2 {
    margin: 0;
    padding: 0 6px 10px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .mobile .day h2 {
    padding: 0 8px 8px;
  }

  .list {
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .list {
    border-radius: 24px;
    padding: 4px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  .entry {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 14px 10px 10px;
  }

  .mobile .entry {
    gap: 12px;
    padding: 10px;
  }

  .tile {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 13px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .tile.warn {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    color: var(--danger);
  }

  .body {
    flex: 1;
    min-width: 0;
    padding-top: 1px;
  }

  .line {
    font-size: 14.5px;
    line-height: 1.45;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .mobile .line {
    font-size: 14px;
  }

  .who {
    font-weight: 800;
  }

  .meta {
    margin-top: 2px;
    font-size: 13px;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .cat {
    flex-shrink: 0;
    height: 26px;
    padding: 0 10px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    white-space: nowrap;
    margin-top: 7px;
  }

  /* Empty state, empty with shimmer at the same height during the first load */
  .empty {
    margin-top: 20px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .empty.first {
    animation: var(--shim, none);
  }

  .empty-text {
    padding: 30px 18px;
    text-align: center;
    font-size: 14.5px;
    color: var(--mfg);
  }

  /* "Loading failed" card in place of the list or the retention */
  .load {
    --load-card-top: 24px;
  }

  .mobile .load {
    --load-card-top: 20px;
  }

  .keep-load {
    --load-card-top: 18px;
  }

  .mobile .keep-load {
    --load-card-top: 16px;
  }

  /* Retention */
  .keep {
    margin-top: 44px;
  }

  .mobile .keep {
    margin-top: 34px;
  }

  .keep h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile .keep h2 {
    font-size: 22px;
  }

  .keep-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .keep-desc {
    margin-top: 5px;
    font-size: 14px;
    line-height: 1.5;
  }

  .box {
    margin-top: 18px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 16px;
    border-radius: 24px;
    padding: 4px;
  }

  .keep-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
  }

  .mobile .keep-row {
    display: block;
    padding: 14px 14px 12px;
  }

  .keep-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .label {
    font-size: 15px;
  }

  .desc {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .mobile .desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .seg {
    display: flex;
    padding: 4px;
    gap: 2px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .mobile .seg {
    margin-top: 12px;
  }

  .seg button {
    height: 36px;
    padding: 0 16px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .seg button:hover,
  .seg button.on {
    color: var(--fg);
  }

  .seg button.on {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  /* Without selection until the first response */
  .seg button.dis {
    cursor: default;
  }

  .mobile .seg button {
    flex: 1;
    min-width: 0;
    padding: 0;
    font-size: 13.5px;
  }

  .mobile .seg button:hover:not(.on) {
    color: var(--mfg);
  }
</style>
