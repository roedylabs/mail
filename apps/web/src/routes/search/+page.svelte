<!--
  Results of the search across messages and attachments from the mail server
  (`search`, `Email/query`) and the app's local areas (`searchCandidates`),
  grouped by area with pills and "Show all ‹n›". Desktop without a search
  field of its own (the header's), mobile with the page's search field and
  "Recent searches" when idle. If only messages are shown and the server has
  more, an invisible sentinel at the end of the list loads more. Until the
  server's first response is there, the skeleton shows (`srch`). Filters
  (`#lib/search-filter.ts`): chips of all filters, on mobile quick filters
  (`resQF`) and, when idle, the "Quick access" tiles with counters. Desktop
  with filter button and filter panel (`FilterPanel`): docked next to the
  results where there is room (`search.dock`), otherwise overlaid; chips only
  without panel. On mobile the filter button in the search field opens the
  search filters sheet (`SearchFilters` via `ui.pageDialog`). Offline or with
  hits from storage (`srOff`) a notice sits above the hits, without hits an
  empty text of its own; when the network returns, the server answers.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { blurOnDrag } from '#lib/swipe.ts';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import FilterPanel from '#lib/components/FilterPanel.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SearchFilters from '#lib/components/SearchFilters.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { mobileChips, quickFilters, TILES } from '#lib/search-filter.ts';
  import { SearchView } from '#lib/search-view.svelte.ts';
  import { RECENT_SHOWN, search } from '#lib/state/search.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const isMobile = $derived(ui.isMobile);

  /**
   * Hits of all areas and values of the results, shared with the search suggestions.
   * An opened hit remembers the way back: "Search results" on desktop, "Search" on mobile.
   */
  const view = new SearchView(undefined, () => (ui.isMobile ? 'search' : 'results'));
  const srOff = $derived(view.srOff);
  const rp = $derived(view.rp);

  onMount(() => {
    // Mobile: opening the search (tab, palette, contact, back from a hit) focuses its field after 30 ms, the keyboard opens.
    const focusTimer = ui.isMobile ? setTimeout(() => field?.focus(), 30) : undefined;
    // Leaving the results closes them (`closeResultsState`): area, filters and overlay reset, the text stays.
    return () => {
      clearTimeout(focusTimer);
      search.leave();
    };
  });

  /** Empty text (`rp.emptyText`): offline, "no results" only says something about the storage. */
  const emptyText = $derived(srOff ? m.search_off_empty() : rp.emptyText);

  /** Mobile: quick filters (`resQF`) and "Quick access" tiles (`mf.tiles`). */
  const quick = $derived(quickFilters(search.sf, (patch) => search.set(patch)));
  const mChips = $derived(mobileChips(search.chips));
  const tiles = $derived(
    TILES.map((t, i) => {
      const n = search.tileCounts?.[i];
      return {
        key: t.key,
        label: t.label(),
        icon: t.icon,
        bg: t.bg,
        ink: t.ink,
        // Until the counters are there (or no account answers) a dash instead of a wrong zero.
        n: n == null ? '–' : String(n),
        onClick: () => search.set(t.patch),
      };
    }),
  );
  $effect(() => {
    if (isMobile && rp.idle) void search.loadTiles();
  });

  /** Load more messages at the end (only the messages area, the server has more). */
  const canLoad = $derived(rp.groups.some((g) => g.canLoad));

  // --- Desktop: filter button and filter panel (`rf`) ---

  /** Set filters without the areas (`rf.n`). */
  const filterN = $derived(rp.chips.length);
  /** Filter button highlighted (`act`): panel open or a filter set. */
  const filterAct = $derived(search.panelShown || filterN > 0);

  /** "Close search results": back to where the search came from, otherwise to the start page. */
  function closeResults() {
    const back = search.close();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the return path is an address of the app
    void goto(back ?? resolve('/start'));
  }

  // --- Mobile: the page's search field and "Recent searches" ---

  let field = $state<HTMLInputElement>();
  const hasSearch = $derived(search.q.length > 0);
  const recent = $derived(search.recent.slice(0, RECENT_SHOWN));

  function onSearchKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key !== 'Enter' || event.isComposing) return;
    search.remember(search.q);
    event.currentTarget.blur();
  }

  function clearSearch() {
    search.q = '';
    field?.focus();
  }

  /** "Search filters" sheet open (`menu === 'sfilter'`). */
  let sfOpen = $state(false);
  /** All set filters including areas (`nF`), for the button in the search field. */
  const nF = $derived(search.chips.length);
  /** Button highlighted (`act` in `sfBtn`): sheet open or a filter set. */
  const sfAct = $derived(sfOpen || nF > 0);

  // The layout shows the sheet (`ui.pageDialog`); it needs the page's hit count.
  $effect(() => {
    ui.pageDialog = () =>
      sfOpen && isMobile
        ? { title: m.search_sheet_title(), close: () => (sfOpen = false), content: filterSheet }
        : null;
    return () => {
      ui.pageDialog = null;
    };
  });

  /**
   * Sentinel at the end of the list: visible in the scrolling container (`data-scroll`)
   * → more messages. New hits (`seen`) observe it again so that a short list keeps
   * loading while it stays visible.
   */
  function loadMore(node: HTMLElement, seen: number) {
    void seen;
    // Without IntersectionObserver (tests) nothing loads by itself.
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void search.more();
      },
      { root: node.closest('[data-scroll]'), rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(node);
    return {
      update() {
        observer.unobserve(node);
        observer.observe(node);
      },
      destroy: () => observer.disconnect(),
    };
  }
</script>

<!-- Notice above the hits (`rp.offHint`, `srOff`) -->
{#snippet offHint()}
  <div role="status" class="off-hint">
    <span class="off-hint-i"><Icon name="ti-cloud-off" /></span><span class="off-hint-t">{m.search_off()}</span>
  </div>
{/snippet}

<!-- Only in the sheet (`content(true)`); on desktop the panel filters. -->
{#snippet filterSheet(inSheet: boolean)}
  {#if inSheet}<SearchFilters total={rp.total} idle={rp.idle} close={() => (sfOpen = false)} />{/if}
{/snippet}

{#if !isMobile}
  <!-- The panel sits next to the skeleton: changing filters does not make it disappear. -->
  <div class="res">
    {#if search.pending}
      <Skeleton kind="srch" />
    {:else}
      <div class="scroll no-scrollbar" data-scroll {@attach scrollbar}>
        <div class="pad">
          <div class="inner">
            <div class="head">
              <div class="head-text">
                <div class="kicker">{m.search_kicker()}</div>
                <h1 class="title">{rp.title}</h1>
                <p class="count">{rp.countText}</p>
                {#if srOff && rp.has}{@render offHint()}{/if}
              </div>
              <button
                class="close"
                onclick={closeResults}
                use:tooltip={m.search_close_tip()}
                aria-label={m.search_close()}><Icon name="ti-x" size={18} /></button
              >
            </div>

            <div class="pill-row">
              <div role="toolbar" aria-label={m.search_areas()} class="pills">
                {#each rp.pills as p (p.cat ?? '')}
                  <button class="pill" class:on={p.on} onclick={p.onClick} aria-pressed={p.on}
                    >{p.label}<span class="pill-n">{p.n}</span></button
                  >
                {/each}
              </div>
              {#if !(search.dock && search.panelShown)}
                <button
                  class="filter"
                  class:act={filterAct}
                  onclick={() => search.togglePanel()}
                  aria-expanded={search.panelShown}
                  aria-label={filterN ? m.search_filter_active({ n: filterN }) : m.shell_search_filter()}
                  ><Icon name="ti-adjustments-horizontal" size={18} />{m.shell_search_filter()}{#if filterN}<span
                      class="filter-n">{filterN}</span
                    >{/if}</button
                >
              {/if}
            </div>
            <!-- Chips only without panel (`rf.showChips`): otherwise it shows the filters itself. -->
            {#if rp.hasChips && !search.panelShown}
              <div class="chips">
                {#each rp.chips as f (f.label)}
                  <button class="chip" onclick={f.remove} aria-label={f.aria}
                    ><span class="chip-label">{f.label}</span><Icon name="ti-x" size={14} /></button
                  >
                {/each}
                <button class="chips-clear" onclick={rp.clearF}>{m.search_page_chips_clear()}</button>
              </div>
            {/if}

            {#if rp.empty}
              <div class="empty">
                <span class="empty-art"><Icon name="ti-search-off" size={30} /></span>
                <div class="empty-title">{m.search_empty_title()}</div>
                <div class="empty-text">{emptyText}</div>
                {#if rp.hasChips}
                  <button class="empty-reset" onclick={rp.clearF}>{m.search_clear_filters()}</button>
                {/if}
              </div>
            {/if}
            {#if rp.has}
              {#each rp.groups as g (g.cat)}
                <section class="group">
                  <div class="group-head">
                    <h2>{g.label}</h2>
                    <span class="group-n">{g.n}</span>
                  </div>
                  <div class="group-box">
                    {#each g.rows as r (r.key)}
                      <button class="row" onclick={r.run}>
                        <span class="tile" class:round={r.round} style:background={r.tileBg} style:color={r.tileInk}
                          >{#if r.hasAv}{r.av}{:else}<Icon name={r.icon} size={20} />{/if}</span
                        >
                        <span class="row-text">
                          <span class="row-label" style:font-weight={r.fw}
                            >{#each r.parts as p, i (i)}<span class="part" class:hl={p.hl}>{p.t}</span>{/each}</span
                          >
                          <span class="row-meta">{r.meta}</span>
                        </span>
                        {#if r.side}<span class="row-side">{r.side}</span>{/if}
                        {#if r.k}<span class="row-key">{r.k}</span>{/if}
                        <span class="row-chev"><Icon name="ti-chevron-right" size={18} /></span>
                      </button>
                    {/each}
                    {#if g.hasMore}
                      <button class="more" onclick={g.more}
                        >{g.moreLabel}<Icon name="ti-arrow-right" size={16} /></button
                      >
                    {/if}
                  </div>
                </section>
              {/each}
              {#if canLoad}<div class="sentinel" aria-hidden="true" use:loadMore={search.hits.length}></div>{/if}
            {/if}
          </div>
        </div>
      </div>
    {/if}
    <FilterPanel count={filterN} idle={rp.idle} total={rp.total} />
  </div>
{:else}
  <!-- On mobile the whole page as the main landmark, with a heading for screen readers only. -->
  <main class="m-search">
    <h1 class="sr-only">{m.shell_search()}</h1>
    <!-- A vertical drag in the field row, the quick filters or the results closes the keyboard (`blurOnDrag`). -->
    <div class="m-field" {@attach blurOnDrag}>
      <span class="m-field-icon"><Icon name="ti-search" size={19} /></span>
      <input
        bind:this={field}
        value={search.q}
        oninput={(e) => (search.q = e.currentTarget.value)}
        onkeydown={onSearchKey}
        enterkeyhint="search"
        aria-label={m.shell_search()}
        placeholder={m.shell_search_placeholder({ app: session.appName })}
        class:has-q={hasSearch}
      />
      {#if hasSearch}
        <button class="m-clear" onclick={clearSearch} aria-label={m.shell_search_clear()}
          ><Icon name="ti-x" size={17} /></button
        >
        <span class="m-divider" aria-hidden="true"></span>
      {/if}
      <button
        class="m-filter"
        class:act={sfAct}
        onclick={() => (sfOpen = !sfOpen)}
        aria-label={nF ? m.search_filter_active({ n: nF }) : m.shell_search_filter()}
        aria-expanded={sfOpen}
      >
        <Icon name="ti-adjustments-horizontal" size={20} />
        {#if nF > 0}<span class="m-filter-n" aria-hidden="true">{nF}</span>{/if}
      </button>
    </div>
    {#if rp.qfOn}
      <!-- Quick filters (`resQF`), then the remaining filters as chips (`mf.mChips`). -->
      <div class="m-qf no-scrollbar" role="group" {@attach blurOnDrag} aria-label={m.search_page_quick()}>
        {#each quick as c (c.key)}
          <button class="m-quick" class:on={c.on} onclick={c.onClick} aria-pressed={c.on}
            ><span class="m-quick-icon"><Icon name={c.icon} size={15} /></span>{c.label}</button
          >
        {/each}
        {#each mChips as f (f.key)}
          <button class="m-chip" onclick={f.remove} aria-label={f.aria}>{f.label}<Icon name="ti-x" size={14} /></button>
        {/each}
        <button class="m-reset" onclick={rp.clearF}><Icon name="ti-restore" size={15} />{m.search_page_reset()}</button>
      </div>
    {/if}
    {#if search.pending}
      <!-- The skeleton without a search field of its own: the real one stays and keeps the focus. -->
      <div class="m-skel"><Skeleton kind="srch" isMobile /></div>
    {:else}
      <div class="m-card no-scrollbar" data-scroll {@attach blurOnDrag}>
        {#if rp.idle}
          <div class="m-idle">
            <div class="m-qa">
              <div class="m-qa-title">{m.search_tiles_title()}</div>
              <div class="m-qa-grid">
                {#each tiles as c (c.key)}
                  <!-- Space between name and number: only for the button's name, no effect in the flex layout. -->
                  <button class="m-qa-tile" onclick={c.onClick}
                    ><span class="m-qa-icon" style:--tile-bg={c.bg} style:--tile-ink={c.ink}
                      ><Icon name={c.icon} size={18} /></span
                    ><span class="m-qa-foot"
                      ><span class="m-qa-label">{c.label}</span> <span class="m-qa-n">{c.n}</span></span
                    ></button
                  >
                {/each}
              </div>
            </div>
            {#if recent.length}
              <div class="m-recent">
                <div class="m-recent-title">{m.search_recent()}</div>
                {#each recent as q (q)}
                  <div class="m-recent-row">
                    <button class="m-recent-run" onclick={() => (search.q = q)}
                      ><span class="m-recent-icon"><Icon name="ti-history" size={19} /></span><span
                        class="m-recent-label">{q}</span
                      ></button
                    >
                    <button class="m-recent-rm" onclick={() => search.forget(q)} aria-label={m.search_recent_remove()}
                      ><Icon name="ti-x" size={16} /></button
                    >
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#if rp.active}
          {#if rp.empty}
            <div class="m-empty">
              <span class="m-empty-art"><Icon name="ti-search-off" size={26} /></span>
              <div class="m-empty-title">{m.search_empty_title()}</div>
              <div class="m-empty-text">{emptyText}</div>
              {#if rp.hasChips}
                <button class="m-empty-reset" onclick={rp.clearF}>{m.search_clear_filters()}</button>
              {/if}
            </div>
          {/if}
          {#if rp.has}
            <div class="m-res">
              <div class="m-res-head">
                <span class="m-res-title">{m.search_kicker()}</span><span class="m-res-n">{rp.countText}</span>
              </div>
              {#if srOff}{@render offHint()}{/if}
              {#each rp.groups as g (g.cat)}
                <div class="m-group-head">
                  <span class="m-group-label">{g.label}</span><span class="m-group-n">{g.n}</span>
                </div>
                <div class="m-group">
                  {#each g.rows as r (r.key)}
                    <button class="m-row" onclick={r.run}>
                      <span class="m-tile" class:round={r.round} style:background={r.tileBg} style:color={r.tileInk}
                        >{#if r.hasAv}{r.av}{:else}<Icon name={r.icon} size={19} />{/if}</span
                      >
                      <span class="m-row-text">
                        <span class="m-row-label" style:font-weight={r.fw}
                          >{#each r.parts as p, i (i)}<span class="part" class:hl={p.hl}>{p.t}</span>{/each}</span
                        >
                        <span class="m-row-meta">{r.meta}</span>
                      </span>
                      {#if r.side}<span class="m-row-side">{r.side}</span>{/if}
                    </button>
                  {/each}
                  {#if g.hasMore}
                    <button class="m-more" onclick={g.more}
                      >{g.moreLabel}<Icon name="ti-arrow-right" size={16} /></button
                    >
                  {/if}
                </div>
              {/each}
              {#if canLoad}<div class="sentinel" aria-hidden="true" use:loadMore={search.hits.length}></div>{/if}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </main>
{/if}

<style>
  /* --- Desktop --- */

  .res {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
  }

  .scroll {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }

  .pad {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 44px 40px 96px;
  }

  .inner {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 780px;
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .kicker {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .title {
    margin: 6px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .count {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
    text-wrap: pretty;
  }

  .off-hint {
    margin-top: 12px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 14px 9px 12px;
    border-radius: 16px;
    background: var(--surface2);
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.4;
    text-wrap: pretty;
  }

  .off-hint-i {
    flex-shrink: 0;
    font-size: 17px;
    line-height: 1.2;
    color: var(--mfg);
  }

  .off-hint-t {
    min-width: 0;
  }

  .m-res .off-hint {
    margin-top: 10px;
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

  .pill-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 24px;
  }

  .pills {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .pill {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 16px;
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

  .pill:hover {
    background: var(--sunken);
  }

  .pill.on {
    background: var(--ink);
    color: var(--inkfg);
  }

  .pill-n {
    min-width: 24px;
    height: 24px;
    padding: 0 7px;
    border-radius: 9999px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
  }

  .pill.on .pill-n {
    background: color-mix(in oklab, var(--inkfg) 18%, transparent);
  }

  /* Filter button (`rf.btn*`): highlighted while the panel is open or a filter is set. */
  .filter {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 13px;
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

  .filter:hover {
    background: var(--sunken);
  }

  .filter.act,
  .filter.act:hover {
    background: var(--accsoft);
    color: var(--deep);
  }

  .filter-n {
    min-width: 24px;
    height: 24px;
    margin-right: -8px;
    padding: 0 7px;
    border-radius: 9999px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
  }

  .chip {
    height: 32px;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 9px 0 13px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 13px;
    font-weight: 800;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .chip:hover {
    background: color-mix(in oklab, var(--accsoft) 78%, var(--acc));
  }

  .chip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chips-clear {
    height: 32px;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .chips-clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .empty {
    margin-top: 28px;
    padding: 48px 28px 44px;
    border-radius: 28px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .empty-art {
    width: 64px;
    height: 64px;
    border-radius: 22px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
  }

  .empty-title {
    margin-top: 18px;
    font-family: var(--font-serif);
    font-size: 24px;
    line-height: 1.2;
  }

  .empty-text {
    margin-top: 8px;
    max-width: 380px;
    font-size: 15px;
    line-height: 1.55;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .empty-reset {
    margin-top: 18px;
    height: 42px;
    padding: 0 20px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: var(--sh1);
    transition: transform var(--dur, 220ms);
  }

  .empty-reset:hover {
    transform: translateY(-1px);
  }

  .group {
    margin-top: 36px;
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .group-head h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .group-n {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .group-box {
    margin-top: 14px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 16px 10px 10px;
    border-radius: 20px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .row:hover {
    background: var(--surface);
  }

  .tile {
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 15px;
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 14px;
    font-weight: 800;
  }

  .tile.round,
  .m-tile.round {
    border-radius: 9999px;
  }

  .row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .row-label {
    font-size: 15.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .part {
    border-radius: 5px;
  }

  .part.hl {
    padding: 0 2px;
    margin: 0 -2px;
    background: var(--accsoft);
    color: var(--deep);
  }

  .row-meta {
    font-size: 13.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-side {
    flex-shrink: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
    white-space: nowrap;
  }

  .row-key {
    flex-shrink: 0;
    min-width: 28px;
    height: 28px;
    padding: 0 9px;
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 2px 0 var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
    white-space: nowrap;
  }

  .row-chev {
    flex-shrink: 0;
    display: grid;
    color: var(--mfg);
  }

  .more {
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 700;
    color: var(--deep);
    transition: background-color var(--dur, 220ms);
  }

  .more:hover {
    background: var(--surface);
  }

  .sentinel {
    height: 1px;
  }

  /* --- Mobile --- */

  .m-search {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .m-field {
    flex-shrink: 0;
    position: relative;
    display: flex;
    align-items: center;
    margin: 6px 16px 12px;
  }

  .m-field-icon {
    position: absolute;
    left: 18px;
    display: grid;
    color: var(--mfg);
    pointer-events: none;
  }

  .m-field input {
    width: 100%;
    height: 52px;
    border-radius: 9999px;
    border: 1px solid var(--bd);
    outline: none;
    /* Room on the right for the filter button, with text also for "Clear search" (`mSfPadR`). */
    padding: 0 56px 0 48px;
    font-size: 16px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition:
      box-shadow var(--dur, 220ms),
      border-color var(--dur, 220ms);
  }

  .m-field input.has-q {
    padding-right: 100px;
  }

  .m-field input:focus-visible {
    border-color: var(--acc);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .m-clear {
    position: absolute;
    right: 54px;
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .m-divider {
    position: absolute;
    right: 52px;
    width: 1px;
    height: 24px;
    background: var(--bd);
    pointer-events: none;
  }

  .m-filter {
    position: absolute;
    right: 6px;
    width: 44px;
    height: 44px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .m-filter.act {
    background: var(--accsoft);
    color: var(--deep);
  }

  .m-filter:active {
    background: var(--hov);
  }

  .m-filter-n {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 19px;
    height: 19px;
    padding: 0 5px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    box-shadow: 0 0 0 2.5px var(--surface);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
  }

  .m-qf {
    flex-shrink: 0;
    display: flex;
    gap: 6px;
    margin: 0 0 10px;
    padding: 0 16px;
    overflow-x: auto;
    transform-origin: top center;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .m-quick {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 11px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    color: var(--fg);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .m-quick-icon {
    display: grid;
    color: var(--mfg);
  }

  .m-quick.on {
    background: var(--ink);
    color: var(--inkfg);
  }

  .m-quick.on .m-quick-icon {
    color: var(--inkfg);
  }

  /* Hover; only with a pointer so that it does not stick after a tap. */
  @media (hover: hover) {
    .m-quick:hover {
      background: color-mix(in oklab, var(--fg) 12%, transparent);
    }

    .m-quick.on:hover {
      background: var(--ink);
    }
  }

  .m-chip {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 13px;
    border-radius: 12px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 13px;
    font-weight: 800;
    white-space: nowrap;
  }

  .m-reset {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border-radius: 12px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .m-skel {
    display: contents;
  }

  .m-skel :global(.m-srch-field) {
    display: none;
  }

  .m-card {
    flex: 1;
    min-height: 0;
    margin: 0 12px;
    touch-action: pan-y;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .m-idle {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 20px 16px 26px;
  }

  .m-qa {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .m-qa-title {
    padding: 0 4px;
    font-family: var(--font-serif);
    font-size: 18px;
  }

  .m-qa-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .m-qa-tile {
    min-height: 96px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    padding: 14px;
    border-radius: 22px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    text-align: left;
    transition: transform var(--dur, 220ms);
  }

  .m-qa-tile:active {
    transform: scale(0.97);
  }

  /* Fixed colours per tile (`TILES`). */
  .m-qa-icon {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--tile-bg);
    color: var(--tile-ink);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
  }

  .m-qa-foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
  }

  .m-qa-label {
    font-size: 14px;
    font-weight: 700;
  }

  .m-qa-n {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1;
  }

  .m-recent {
    display: flex;
    flex-direction: column;
  }

  .m-recent-title {
    padding: 0 4px 6px;
    font-family: var(--font-serif);
    font-size: 18px;
  }

  .m-recent-row {
    display: flex;
    align-items: center;
    margin: 0 -6px;
    border-radius: 16px;
  }

  .m-recent-run {
    flex: 1;
    min-width: 0;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 6px 0 10px;
    text-align: left;
    font-size: 15px;
    font-weight: 600;
    border-radius: 16px;
  }

  .m-recent-icon {
    display: grid;
    color: var(--mfg);
  }

  .m-recent-label {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-recent-rm {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .m-recent-run:active,
  .m-recent-rm:active,
  .m-row:active,
  .m-more:active {
    background: var(--hov);
  }

  .m-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px 28px;
  }

  .m-empty-art {
    width: 60px;
    height: 60px;
    border-radius: 20px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
  }

  .m-empty-title {
    margin-top: 18px;
    max-width: 100%;
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .m-empty-text {
    margin-top: 8px;
    font-size: 14.5px;
    line-height: 1.55;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m-empty-reset {
    margin-top: 18px;
    height: 46px;
    padding: 0 22px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    background: var(--ink);
    color: var(--inkfg);
  }

  .m-res {
    display: flex;
    flex-direction: column;
    padding: 18px 18px 24px;
  }

  .m-res-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 2px 2px 0;
  }

  .m-res-title {
    font-family: var(--font-serif);
    font-size: 21px;
  }

  .m-res-n {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .m-group-head {
    margin-top: 22px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 2px;
  }

  .m-group-label {
    font-family: var(--font-serif);
    font-size: 18px;
  }

  .m-group-n {
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .m-group {
    margin: 6px -6px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .m-row {
    min-height: 60px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: 18px;
    text-align: left;
  }

  .m-tile {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 15px;
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 13.5px;
    font-weight: 800;
  }

  .m-row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .m-row-label {
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-row-meta {
    font-size: 13px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-row-side {
    flex-shrink: 0;
    align-self: flex-start;
    margin-top: 4px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
    white-space: nowrap;
  }

  .m-more {
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 18px;
    font-size: 14px;
    font-weight: 700;
    color: var(--deep);
  }
</style>
