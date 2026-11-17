<!--
  Filter panel of the search, desktop only: status, period as steps, account
  (only with several), folders with custom folders to expand, tags with
  subtags, sender with suggestions from the contacts and "Search in". The chips
  come from `panelGroups()` (`#lib/search-filter-options.ts`). With room
  (`search.dock`) docked next to the results, otherwise overlaid with a
  backdrop and "Show ‹n› results". Sits directly in the results' container
  (`position: relative`, row).
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { untrack } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { panelGroups, type FilterOption } from '#lib/search-filter-options.ts';
  import { SF0 } from '#lib/search-filter.ts';
  import { contacts } from '#lib/state/contacts.svelte.ts';
  import { search } from '#lib/state/search.svelte.ts';

  interface Props {
    /** Set filters without the scopes (`rf.n`: `rp.chips.length`). */
    count: number;
    /** Neither search term nor filter (`rp.idle`). */
    idle: boolean;
    /** Total hits (`rp.total`). */
    total: number;
  }

  let { count, idle, total }: Props = $props();

  const show = $derived(search.panelShown);
  /** Overlaid instead of docked (`rf.over`). */
  const over = $derived(search.panelOverlaid);

  const g = $derived(
    panelGroups({ sf: search.sf, env: search.env, senders: contacts.list, set: (patch) => search.set(patch) }),
  );

  /**
   * Custom folders and subtags expanded: when opening the search, if
   * something is selected there; hiding and showing the panel leaves them as
   * they are, and so does "Reset" (only the mobile filter sheet collapses
   * everything).
   */
  let customOpen = $state(untrack(() => g.customButton.on));
  let subOpen = $state(untrack(() => g.subButton.on));

  // Suggestions for the sender come from the contacts.
  $effect(() => {
    if (show) void contacts.ensure();
  });

  /** "Reset" (`rf.reset`): all filters except the scopes, which the pills show. */
  function reset() {
    if (!count) return;
    search.set((x) => ({ ...SF0, cats: x.cats }));
  }

  const cta = $derived(
    idle
      ? m.search_panel_done()
      : total === 0
        ? m.search_panel_none()
        : total === 1
          ? m.search_panel_show_one()
          : m.search_panel_show({ n: total }),
  );
  const closeTip = $derived(search.dock ? m.search_panel_hide() : m.search_panel_close());
  /** Period "Any time": steps and fill gray instead of the accent color. */
  const timeDef = $derived(search.sf.time === 'any');
</script>

{#snippet head(label: string, sec: { on: boolean; clear: () => void })}
  <div class="sec-head">
    <span class="sec-label">{label}</span>
    {#if sec.on}<span class="sec-dot" aria-hidden="true"></span>{/if}
    <span class="grow"></span>
    {#if sec.on}
      <!-- Visible text in the name (WCAG 2.5.3; axe in the E2E suite). -->
      <button class="sec-clear" onclick={sec.clear}
        >{m.search_panel_clear()}
        <span class="sr-only">{m.search_panel_clear_section({ section: label })}</span></button
      >
    {/if}
  </div>
{/snippet}

{#snippet chip(c: FilterOption, box = false)}
  <button class="chip" class:on={c.on} class:box onclick={c.select} aria-pressed={c.on} use:tooltip={c.tip}
    >{#if c.icon}<span class="chip-icon"><Icon name={c.icon} size={15} /></span>{/if}{#if c.dot}<span
        class="chip-dot"
        style:background={c.dot}
      ></span>{/if}<span class="chip-label">{c.label}</span></button
  >
{/snippet}

{#snippet expander(b: { label: string; on: boolean }, icon: IconName, open: boolean, toggle: () => void)}
  <button class="chip" class:on={b.on} onclick={toggle} aria-pressed={b.on} aria-expanded={open}
    ><span class="chip-icon"><Icon name={icon} size={15} /></span><span class="chip-label">{b.label}</span><span
      class="chev"
      class:open><Icon name="ti-chevron-down" size={14} /></span
    ></button
  >
{/snippet}

{#if over}
  <div class="scrim" role="presentation" onclick={() => search.closePanel()}></div>
{/if}
{#if show}
  <aside class="panel" class:over aria-label={m.search_panel_title()}>
    <div class="top">
      <span class="title">{m.search_panel_title()}</span>
      {#if count > 0}<span class="n">{count}</span>{/if}
      <span class="grow"></span>
      <button class="reset" class:dis={!count} onclick={reset} aria-disabled={!count}
        ><Icon name="ti-restore" size={16} />{m.search_panel_reset()}</button
      >
      <button class="close" onclick={() => search.closePanel()} use:tooltip={closeTip} aria-label={closeTip}
        ><Icon name={search.dock ? 'ti-layout-sidebar-right-collapse' : 'ti-x'} size={18} /></button
      >
    </div>

    <div class="body no-scrollbar" {@attach scrollbar}>
      <section class="sec first">
        {@render head(m.search_dim_st(), g.sections.st)}
        <div role="group" aria-label={m.search_dim_st()} class="states">
          {#each g.st as c (c.key)}
            <button class="state" class:on={c.on} onclick={c.select} aria-pressed={c.on}
              >{#if c.icon}<Icon name={c.icon} size={19} />{/if}<span class="state-label">{c.label}</span></button
            >
          {/each}
        </div>
      </section>

      <section class="sec">
        {@render head(m.search_dim_time(), g.sections.time)}
        <div
          role="radiogroup"
          use:radiogroup
          aria-label={m.search_dim_time()}
          class="time"
          class:def={timeDef}
          style:--fill="{g.timeIndex * 20}%"
        >
          <span class="track" aria-hidden="true"></span>
          <span class="fill" aria-hidden="true"></span>
          {#each g.time as t, i (t.key)}
            <button
              role="radio"
              aria-checked={t.on}
              class="stop"
              class:sel={i === g.timeIndex}
              class:before={i < g.timeIndex}
              onclick={t.select}
            >
              <span class="knob-box"><span class="knob"></span></span>
              <span class="stop-label">{t.label}</span>
            </button>
          {/each}
        </div>
      </section>

      {#if g.accounts}
        <section class="sec">
          {@render head(m.search_dim_account(), g.sections.account)}
          <div role="group" aria-label={m.search_dim_account()} class="chips">
            {#each g.accounts as c (c.key)}{@render chip(c)}{/each}
          </div>
        </section>
      {/if}

      <section class="sec">
        {@render head(m.search_dim_folder(), g.sections.folder)}
        <div role="group" aria-label={m.search_dim_folder()} class="chips">
          {#each g.sysFolders as c (c.key)}{@render chip(c)}{/each}
          {#if g.customFolders.length}
            {@render expander(g.customButton, 'ti-folders', customOpen, () => (customOpen = !customOpen))}
          {/if}
        </div>
        {#if customOpen && g.customFolders.length}
          <div class="more">
            {#each g.customFolders as c (c.key)}{@render chip(c, true)}{/each}
          </div>
        {/if}
      </section>

      <section class="sec">
        {@render head(m.search_dim_tags(), g.sections.tags)}
        <div role="group" aria-label={m.search_dim_tags()} class="chips">
          {#each g.tags as c (c.key)}{@render chip(c)}{/each}
          {#if g.subTags.length}
            {@render expander(g.subButton, 'ti-tags', subOpen, () => (subOpen = !subOpen))}
          {/if}
        </div>
        {#if subOpen && g.subTags.length}
          <div class="more">
            {#each g.subTags as c (c.key)}{@render chip(c, true)}{/each}
          </div>
        {/if}
      </section>

      <section class="sec">
        {@render head(m.search_dim_from(), g.sections.from)}
        <div class="from">
          <span class="from-icon"><Icon name="ti-at" size={16} /></span>
          <input
            value={search.sf.from}
            oninput={(e) => search.set({ from: e.currentTarget.value })}
            aria-label={m.search_dim_from()}
            placeholder={m.search_panel_from_placeholder()}
          />
          {#if search.sf.from}
            <button class="from-clear" onclick={() => search.set({ from: '' })} aria-label={m.search_panel_from_clear()}
              ><Icon name="ti-x" size={15} /></button
            >
          {/if}
        </div>
        {#if g.fromSuggestions.length}
          <div class="sugs">
            {#each g.fromSuggestions as p (p.key)}
              <button class="sug" onclick={p.select}>
                {#if p.avatar}
                  <span class="av" style:background={p.avatar.bg} style:color={p.avatar.ink}>{p.avatar.text}</span>
                {/if}
                <span class="sug-text"
                  ><span class="sug-label">{p.label}</span><span class="sug-email">{p.email}</span></span
                >
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="sec">
        {@render head(m.search_dim_fields(), g.sections.fields)}
        <div role="group" aria-label={m.search_dim_fields()} class="chips">
          {#each g.fields as c (c.key)}{@render chip(c)}{/each}
        </div>
      </section>
    </div>

    {#if over}
      <div class="foot">
        <button class="cta" onclick={() => search.closePanel()}>{cta}</button>
      </div>
    {/if}
  </aside>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 4;
    background: var(--scrim);
    animation: snFade 180ms ease-out;
  }

  /* Docked next to the results; overlaid on the right above them (`rf.pos`, `off`, `mg`). */
  .panel {
    --rf-bg: var(--surface2);
    position: relative;
    z-index: 5;
    width: 320px;
    max-width: calc(100% - 24px);
    flex-shrink: 0;
    margin: 12px 12px 12px 0;
    display: flex;
    flex-direction: column;
    border-radius: 24px;
    background: var(--rf-bg);
    overflow: hidden;
  }

  .panel.over {
    --rf-bg: var(--pop);
    position: absolute;
    top: 12px;
    right: 12px;
    bottom: 12px;
    margin: 0;
    box-shadow: var(--sh3);
    animation: snRdIn 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .top {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 12px 10px 20px;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 21px;
  }

  .n {
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
    height: 34px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
    transition: background-color var(--dur, 220ms);
  }

  .reset:hover {
    background: var(--hov);
  }

  .reset.dis {
    color: var(--dim);
    cursor: default;
  }

  .reset.dis:hover {
    background: transparent;
  }

  .close {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 14px 8px;
  }

  .sec {
    padding: 16px 6px 18px;
    border-top: 1px solid var(--bd);
  }

  .sec.first {
    padding-top: 8px;
    border-top: none;
  }

  .sec-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    margin-bottom: 10px;
  }

  .sec-label {
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .sec-dot {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--acc);
  }

  .sec-clear {
    height: 28px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .sec-clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  /* Status: three tiles. */
  .states {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .state {
    min-width: 0;
    height: 62px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    color: var(--fg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .state:hover {
    background: color-mix(in oklab, var(--fg) 12%, transparent);
  }

  .state:active {
    transform: scale(0.96);
  }

  .state.on,
  .state.on:hover {
    background: var(--ink);
    color: var(--inkfg);
  }

  .state-label {
    max-width: 100%;
    padding: 0 6px;
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    overflow-wrap: anywhere;
  }

  /* Period: steps on a bar, filled up to the selected one (`tStops`, `tFill`). */
  .time {
    --t-col: var(--acc);
    position: relative;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .time.def {
    --t-col: color-mix(in oklab, var(--fg) 24%, transparent);
  }

  .track,
  .fill {
    position: absolute;
    left: 10%;
    top: 12px;
    height: 6px;
    margin-top: -3px;
    border-radius: 9999px;
    pointer-events: none;
  }

  .track {
    right: 10%;
    background: color-mix(in oklab, var(--fg) 9%, transparent);
  }

  .fill {
    width: var(--fill);
    background: var(--t-col);
    transition:
      width 320ms cubic-bezier(0.2, 0.9, 0.3, 1),
      background-color var(--dur, 220ms);
  }

  .stop {
    position: relative;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 0 0 4px;
    border-radius: 12px;
  }

  .knob-box {
    height: 24px;
    display: grid;
    place-items: center;
  }

  .knob {
    width: 10px;
    height: 10px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--fg) 16%, transparent);
    transition:
      width 220ms cubic-bezier(0.2, 1.2, 0.3, 1),
      height 220ms cubic-bezier(0.2, 1.2, 0.3, 1),
      background-color var(--dur, 220ms);
  }

  .stop.before .knob {
    background: var(--t-col);
  }

  .stop.sel .knob {
    width: 20px;
    height: 20px;
    background: var(--acc);
    box-shadow:
      0 0 0 4px var(--rf-bg),
      var(--sh1);
  }

  .time.def .stop.sel .knob {
    background: var(--mfg);
  }

  .stop-label {
    max-width: 100%;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    color: var(--mfg);
    text-wrap: balance;
  }

  .stop.sel .stop-label {
    font-weight: 800;
    color: var(--fg);
  }

  /* Chips (`chip()` in `sfVals`); on `--surface` in the expanded boxes. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    height: 36px;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 12px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    color: var(--fg);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .chip.box {
    background: var(--surface);
  }

  .chip:hover {
    background: color-mix(in oklab, var(--fg) 12%, transparent);
  }

  .chip.on,
  .chip.on:hover {
    background: var(--ink);
    color: var(--inkfg);
  }

  .chip-icon {
    flex-shrink: 0;
    display: grid;
  }

  .chip-dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 9999px;
  }

  .chip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chev {
    flex-shrink: 0;
    display: grid;
    transition: transform var(--dur, 220ms);
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .more {
    margin-top: 8px;
    padding: 8px;
    border-radius: 20px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    transform-origin: top center;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* Sender */
  .from {
    position: relative;
    display: flex;
    align-items: center;
  }

  .from-icon {
    position: absolute;
    left: 14px;
    display: grid;
    color: var(--mfg);
    pointer-events: none;
  }

  .from input {
    width: 100%;
    height: 42px;
    border-radius: 9999px;
    border: 1px solid var(--bd);
    outline: none;
    padding: 0 42px 0 38px;
    font-size: 14px;
    background: var(--surface);
    color: var(--fg);
    transition:
      box-shadow var(--dur, 220ms),
      border-color var(--dur, 220ms);
  }

  .from input:focus-visible {
    border-color: var(--acc);
    box-shadow: 0 0 0 4px var(--accsoft);
  }

  .from-clear {
    position: absolute;
    right: 5px;
    width: 32px;
    height: 32px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .from-clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .sugs {
    margin: 6px -6px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sug {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px 6px 6px;
    border-radius: 16px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .sug:hover {
    background: var(--hov);
  }

  .av {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
  }

  .sug-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .sug-label {
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sug-email {
    font-size: 12px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .foot {
    flex-shrink: 0;
    padding: 12px 14px 14px;
    border-top: 1px solid var(--bd);
  }

  .cta {
    width: 100%;
    height: 48px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 800;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: var(--sh1);
    transition: transform var(--dur, 220ms);
  }

  .cta:active {
    transform: scale(0.98);
  }
</style>
