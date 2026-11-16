<!--
  Filters of the search in the mobile sheet. The list shows status and period
  as chips and the narrowing filters as rows (`mRows`); each row opens a
  subpage with its options (`pg`). Only the content: the sheet shows the
  search page via `ui.pageDialog` and passes in the hit count and close.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { filterDims, SHEET_DIMS, type DimKey, type FilterOption } from '#lib/search-filter-options.ts';
  import { SF0 } from '#lib/search-filter.ts';
  import { contacts } from '#lib/state/contacts.svelte.ts';
  import { search } from '#lib/state/search.svelte.ts';

  interface Props {
    /** Hits of the search (`S.total`). */
    total: number;
    /** Nothing searched yet (`S.idle`). */
    idle: boolean;
    /** Close the sheet ("Show ‹n› results", `show`). */
    close: () => void;
  }

  let { total, idle, close }: Props = $props();

  /** Open subpage (`sfPage`); `null` = list. */
  let page = $state<DimKey | null>(null);

  onMount(() => {
    void contacts.ensure();
  });

  const dims = $derived(
    filterDims({ sf: search.sf, env: search.env, senders: contacts.list, set: (p) => search.set(p) }),
  );
  const rows = $derived(dims.filter((d) => SHEET_DIMS.includes(d.key)));
  // Status without "All messages"; the period in full.
  const states = $derived(dims.find((d) => d.key === 'st')?.opts.slice(1) ?? []);
  const times = $derived(dims.find((d) => d.key === 'time')?.opts ?? []);
  // If the filter goes away (e.g. "Account" with only one account left), back to the list.
  const pg = $derived(page ? (dims.find((d) => d.key === page) ?? null) : null);
  /** Set filters including scopes (`nF`). */
  const n = $derived(search.chips.length);
  const ok = $derived(!idle && total > 0);
  const cta = $derived(
    idle
      ? m.search_sheet_cta_idle()
      : total === 0
        ? m.search_count_none()
        : total === 1
          ? m.search_sheet_cta_one()
          : m.search_sheet_cta({ n: total }),
  );

  function reset() {
    if (n) search.set(SF0);
  }

  function show() {
    if (ok) close();
  }

  /** Single choice leads back to the list (`one()`). */
  function choose(o: FilterOption) {
    o.select();
    if (o.closes) page = null;
  }

  /** Indent: tags start 3 px further right than the other options. */
  const padL = (key: DimKey, o: FilterOption) => (key === 'tags' && o.dot ? 13 : 10) + 16 * o.depth;
</script>

{#if !pg}
  <div class="head">
    <span class="title">{m.search_sheet_title()}</span>
    {#if n > 0}<span class="badge">{n}</span>{/if}
    <span class="grow"></span>
    <button class="reset" class:off={!n} aria-disabled={!n} onclick={reset}
      ><Icon name="ti-restore" size={17} />{m.search_page_reset()}</button
    >
  </div>

  <div class="label">{m.search_dim_st()}</div>
  <div class="states" role="group" aria-label={m.search_dim_st()}>
    {#each states as c (c.key)}
      <button class="state" class:on={c.on} aria-pressed={c.on} onclick={c.select}>
        {#if c.icon}<Icon name={c.icon} size={19} />{/if}<span class="state-label">{c.label}</span>
      </button>
    {/each}
  </div>

  <div class="label gap">{m.search_dim_time()}</div>
  <div class="times no-scrollbar" role="radiogroup" use:radiogroup aria-label={m.search_dim_time()}>
    {#each times as c (c.key)}
      <button class="time" class:on={c.on} role="radio" aria-checked={c.on} onclick={c.select}>{c.label}</button>
    {/each}
  </div>

  <div class="label gap">{m.search_sheet_narrow()}</div>
  <div class="rows">
    {#each rows as r (r.key)}
      <button class="row" class:set={!r.def} onclick={() => (page = r.key)}>
        <span class="tile"><Icon name={r.icon} size={17} /></span>
        <span class="row-label">{r.label}</span>
        <span class="value">{r.value}</span>
        <span class="chev"><Icon name="ti-chevron-right" size={17} /></span>
      </button>
    {/each}
  </div>

  <div class="foot">
    <button class="cta" class:ok aria-disabled={!ok} onclick={show}>{cta}</button>
  </div>
{:else}
  <div class="sub">
    <div class="sub-head">
      <button class="back" aria-label={m.search_sheet_back()} onclick={() => (page = null)}
        ><Icon name="ti-arrow-left" size={20} /></button
      >
      <span class="sub-title">{pg.label}</span>
      {#if pg.multi}
        <button class="done" onclick={() => (page = null)}>{m.search_sheet_done()}</button>
      {/if}
    </div>
    {#if pg.key === 'from'}
      <div class="from">
        <span class="at"><Icon name="ti-at" size={17} /></span>
        <input
          value={search.sf.from}
          oninput={(e) => search.set({ from: e.currentTarget.value })}
          aria-label={m.search_dim_from()}
          placeholder={m.search_sheet_from_ph()}
        />
      </div>
    {/if}
    <div class="opts" role="listbox" aria-label={pg.label} aria-multiselectable={pg.multi}>
      {#each pg.opts as o (o.key)}
        <button
          class="opt"
          class:on={o.on}
          role="option"
          aria-selected={o.on}
          style:--pl="{padL(pg.key, o)}px"
          onclick={() => choose(o)}
        >
          {#if o.icon}<span class="opt-icon"><Icon name={o.icon} size={18} /></span>{/if}
          {#if o.dot}<span class="dot" style:--dot={o.dot}></span>{/if}
          {#if o.avatar}
            <span class="av" style:--av-bg={o.avatar.bg} style:--av-ink={o.avatar.ink}>{o.avatar.text}</span>
          {/if}
          <span class="opt-label">{o.label}</span>
          <span class="ck"><Icon name="ti-check" size={15} /></span>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 4px 6px 10px;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 21px;
  }

  .badge {
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
  }

  .grow {
    flex: 1;
  }

  .reset {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
  }

  .reset:active {
    background: var(--hov);
  }

  .reset.off {
    color: var(--dim);
    cursor: default;
  }

  .reset.off:active {
    background: transparent;
  }

  .label {
    padding: 10px 10px 8px;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .label.gap {
    padding-top: 16px;
  }

  .states {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 0 4px;
  }

  .state,
  .time {
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    color: var(--fg);
    font-weight: 700;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .state.on,
  .time.on {
    background: var(--ink);
    color: var(--inkfg);
  }

  .state {
    min-width: 0;
    height: 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border-radius: 18px;
    font-size: 13px;
  }

  .state:active {
    transform: scale(0.96);
  }

  .state-label {
    max-width: 100%;
    padding: 0 6px;
    font-size: 12.5px;
    line-height: 1.2;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .times {
    display: flex;
    gap: 6px;
    margin: 0 -12px;
    padding: 0 16px;
    overflow-x: auto;
  }

  .time {
    height: 40px;
    flex-shrink: 0;
    padding: 0 16px;
    border-radius: 9999px;
    font-size: 14px;
    white-space: nowrap;
  }

  .rows,
  .opts {
    margin: 0 4px;
    border-radius: 22px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
  }

  .rows {
    overflow: hidden;
  }

  .row {
    width: 100%;
    min-height: 54px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 10px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .row + .row {
    border-top: 1px solid var(--bd);
  }

  .row:active {
    background: var(--hov);
  }

  .tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 11px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    color: var(--mfg);
    display: grid;
    place-items: center;
  }

  .row-label {
    flex-shrink: 0;
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
  }

  .value {
    flex: 1;
    min-width: 0;
    text-align: right;
    font-size: 14px;
    font-weight: 600;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.set .tile {
    background: var(--accsoft);
    color: var(--deep);
  }

  .row.set .value {
    font-weight: 800;
    color: var(--deep);
  }

  .chev {
    flex-shrink: 0;
    display: grid;
    color: var(--mfg);
  }

  .foot {
    padding: 18px 4px 0;
  }

  .cta {
    width: 100%;
    height: 52px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 800;
    background: var(--sunken);
    color: var(--dim);
    cursor: default;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .cta.ok {
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: var(--sh1);
    cursor: pointer;
  }

  .cta.ok:active {
    transform: scale(0.98);
  }

  .sub {
    animation: snFromL 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .sub-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 8px 0;
  }

  .back {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
  }

  .back:active,
  .opt:active {
    background: var(--hov);
  }

  .sub-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-serif);
    font-size: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .done {
    height: 40px;
    flex-shrink: 0;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 800;
    background: var(--ink);
    color: var(--inkfg);
  }

  .from {
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 4px 10px;
  }

  .at {
    position: absolute;
    left: 16px;
    display: grid;
    color: var(--mfg);
    pointer-events: none;
  }

  .from input {
    width: 100%;
    height: 50px;
    border-radius: 9999px;
    border: 1px solid var(--bd);
    outline: none;
    padding: 0 16px 0 44px;
    font-size: 16px;
    background: var(--surface);
    transition:
      box-shadow var(--dur, 220ms),
      border-color var(--dur, 220ms);
  }

  .from input:focus-visible {
    border-color: var(--acc);
    box-shadow: 0 0 0 4px var(--accsoft);
  }

  .opts {
    padding: 4px;
  }

  .opt {
    width: 100%;
    min-height: 50px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 var(--pl, 10px);
    border-radius: 18px;
    text-align: left;
    font-size: 15px;
    font-weight: 600;
  }

  .opt.on {
    font-weight: 800;
  }

  .opt-icon {
    flex-shrink: 0;
    display: grid;
    color: var(--mfg);
  }

  .dot {
    width: 11px;
    height: 11px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--dot);
  }

  .av {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    margin-left: -4px;
    border-radius: 9999px;
    background: var(--av-bg);
    color: var(--av-ink);
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
  }

  .opt-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ck {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    opacity: 0;
    transition: opacity 150ms;
  }

  .opt.on .ck {
    opacity: 1;
  }
</style>
