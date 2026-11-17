<!--
  Search suggestions: popup below the header's search field (desktop). When
  idle "Recent searches" and "Search operators", in filter mode
  (search scope "all" or without a scope of the view) also quick filters and
  "Browse"; with search text or filters the hits grouped and capped
  (`suggestGroups`), otherwise the empty state. The segment "Only in …" /
  "Everywhere" appears only in views with a scope (`search.context`). Arrow
  keys and Enter of the search field come in via `key()`; the component
  reports the marked row as `activeId` for `aria-activedescendant`.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { NARROW } from '@roedy/tokens';
  import { tick } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { quickFilters, searchOps, withOp } from '#lib/search-filter.ts';
  import { SearchView } from '#lib/search-view.svelte.ts';
  import { CAT_ICON, catLabel, searchCats, suggestGroups, type SearchCat } from '#lib/search.ts';
  import { RECENT_SHOWN, search } from '#lib/state/search.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    /** id of the list; the search field points to it with `aria-controls`. */
    listId: string;
    /** Search field of the header: focus after "Recent searches" and operators, blur after running. */
    input?: HTMLInputElement | undefined;
    /** "All results" (`resAll`): open the results for the search text. */
    onAll?: (() => void) | undefined;
    /** id of the marked row for the search field's `aria-activedescendant`. */
    activeId?: string | undefined;
  }

  let { listId, input, onAll, activeId = $bindable() }: Props = $props();

  // A row that was run closes the suggestions (menu closed, field blurred).
  const view = new SearchView(() => {
    ui.closeMenu();
    input?.blur();
  });
  const rp = $derived(view.rp);

  /** Marked row; -1 = none. */
  let idx = $state(-1);

  const ctx = $derived(search.context);
  /** Filter mode: everywhere instead of only in the view. */
  const allMode = $derived(search.scope === 'all' || !ctx);
  const chips = $derived(search.chips);
  const nF = $derived(chips.length);
  const groups = $derived(rp.idle ? [] : suggestGroups(rp.groups));
  /** First row per group in the flat list. */
  const starts = $derived.by(() => {
    let n = 0;
    return groups.map((g) => {
      const at = n;
      n += g.rows.length;
      return at;
    });
  });
  const recent = $derived(rp.idle ? search.recent.slice(0, RECENT_SHOWN) : []);
  /** Runnable rows in the order of the arrow keys. */
  const runs = $derived<(() => void)[]>(
    rp.idle ? recent.map((q) => () => runRecent(q)) : groups.flatMap((g) => g.rows.map((r) => r.run)),
  );
  // No empty state without a first response, so that it does not flash briefly.
  const empty = $derived(!rp.idle && !groups.length && !search.pending);
  const q = $derived(search.q.trim());
  const quick = $derived(allMode ? quickFilters(search.sf, (p) => search.set(p)) : []);
  const cats = $derived(allMode ? searchCats(session.isAdmin) : []);
  /** Search field narrower than the popup (on a portrait tablet): centered with a fixed width. */
  const narrow = $derived(ui.width < NARROW);

  const optId = (i: number) => `${listId}-${i}`;

  // Text, filter or scope changed: reset the mark.
  $effect.pre(() => {
    void [search.q, search.sf, search.scope];
    idx = -1;
  });

  $effect(() => {
    const next = idx >= 0 && idx < runs.length ? optId(idx) : undefined;
    if (activeId !== next) activeId = next;
  });

  // Keep the marked row visible.
  $effect(() => {
    if (idx < 0) return;
    document.getElementById(optId(idx))?.scrollIntoView?.({ block: 'nearest' });
  });

  /**
   * Keys of the search field (`onSearchKey`): arrows move cyclically over the
   * rows, Enter runs the marked one. `true` if the key was consumed.
   */
  export function key(event: KeyboardEvent): boolean {
    const n = runs.length;
    if (n && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const d = event.key === 'ArrowDown' ? 1 : -1;
      const c = idx < n ? idx : -1;
      idx = c < 0 ? (d > 0 ? 0 : n - 1) : (c + d + n) % n;
      return true;
    }
    if (event.key === 'Enter' && !event.isComposing && idx >= 0 && idx < n) {
      event.preventDefault();
      runs[idx]?.();
      return true;
    }
    return false;
  }

  function hover(i: number) {
    if (idx !== i) idx = i;
  }

  /** "Recent searches": take the text, suggestions stay open. */
  function runRecent(text: string) {
    search.q = text;
    idx = -1;
    input?.focus();
  }

  function forget(event: MouseEvent, text: string) {
    event.stopPropagation();
    search.forget(text);
    idx = -1;
  }

  /** Insert an operator, focus into the field and cursor to the end. */
  async function insertOp(op: string) {
    search.q = withOp(search.q, op);
    await tick();
    if (!input) return;
    input.focus();
    const n = input.value.length;
    input.setSelectionRange(n, n);
  }

  function toggleCat(cat: SearchCat) {
    search.set((x) => ({ cats: x.cats.includes(cat) ? x.cats.filter((c) => c !== cat) : [...x.cats, cat] }));
  }

  function all() {
    onAll?.();
    input?.blur();
  }
</script>

<div class="pop" class:narrow data-pop="1" data-sfbox="1" role="dialog" aria-label={m.shell_search()}>
  <div class="head">
    <span class="title">{rp.idle ? m.shell_search() : m.search_kicker()}</span>
    {#if !rp.idle && rp.total > 0}<span class="count">{rp.countText}</span>{/if}
    <span class="grow"></span>
    <button class="close" onclick={() => ui.closeMenu()} aria-label={m.shell_close()} use:tooltip={m.shell_close()}>
      <Icon name="ti-x" size={18} />
    </button>
  </div>

  {#if ctx}
    <div class="scope" role="tablist" aria-label={m.search_scope_aria()}>
      <button
        class="seg"
        class:on={!allMode}
        role="tab"
        aria-selected={!allMode}
        onclick={() => (search.scope = 'here')}
      >
        <span class="seg-icon"><Icon name={ctx.icon} size={15} /></span>
        <span class="seg-label">{ctx.here}</span>
      </button>
      <button class="seg" class:on={allMode} role="tab" aria-selected={allMode} onclick={() => (search.scope = 'all')}>
        <Icon name="ti-world" size={15} />{m.search_scope_all()}
        {#if nF > 0}<span class="seg-n">{nF}</span>{/if}
      </button>
    </div>
  {/if}

  {#if nF > 0}
    <div class="chips">
      {#each chips as f (f.key)}
        <button class="chip" onclick={f.remove} aria-label={f.aria} use:tooltip={m.search_suggest_chip_tip()}>
          <span class="chip-label">{f.label}</span><Icon name="ti-x" size={13} />
        </button>
      {/each}
    </div>
  {/if}

  <div class="list no-scrollbar" {@attach scrollbar} id={listId} role="listbox" aria-label={m.search_kicker()}>
    {#if rp.idle}
      <div class="idle">
        {#if recent.length}
          <div class="recent">
            <div class="recent-title">{m.search_recent()}</div>
            {#each recent as text, i (text)}
              <!-- Marking via both buttons of the row (`r.hover` on the frame). -->
              <div class="recent-row" class:sel={i === idx}>
                <button
                  class="recent-run"
                  id={optId(i)}
                  role="option"
                  aria-selected={i === idx}
                  onclick={() => runRecent(text)}
                  onmousemove={() => hover(i)}
                >
                  <span class="recent-icon"><Icon name="ti-history" size={18} /></span>
                  <span class="ellipsis">{text}</span>
                </button>
                <button
                  class="recent-remove"
                  onclick={(e) => forget(e, text)}
                  onmousemove={() => hover(i)}
                  aria-label={m.search_recent_remove()}
                  use:tooltip={m.search_recent_remove()}
                >
                  <Icon name="ti-x" size={15} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        {#if allMode}
          <div class="section">
            <div class="section-title">{m.search_page_quick()}</div>
            <div class="toggles" role="group" aria-label={m.search_page_quick()}>
              {#each quick as c (c.key)}
                <button class="toggle" class:on={c.on} onclick={c.onClick} aria-pressed={c.on}>
                  <span class="toggle-icon"><Icon name={c.icon} size={15} /></span>{c.label}
                </button>
              {/each}
            </div>
          </div>
          <div class="section">
            <div class="section-title">{m.search_suggest_browse()}</div>
            <div class="toggles" role="group" aria-label={m.search_suggest_browse()}>
              {#each cats as c (c)}
                {@const on = search.sf.cats.includes(c)}
                <button class="toggle" class:on onclick={() => toggleCat(c)} aria-pressed={on}>
                  <span class="toggle-icon"><Icon name={CAT_ICON[c]} size={15} /></span>{catLabel(c)}
                </button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="ops">
          <span class="ops-label"><Icon name="ti-keyboard" size={16} />{m.search_suggest_ops()}</span>
          {#each searchOps() as op (op)}
            <button class="op" onclick={() => void insertOp(op)} use:tooltip={m.search_suggest_op_tip()}>{op}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if empty}
      <div class="empty">
        <span class="empty-tile"><Icon name="ti-search-off" size={26} /></span>
        <div class="empty-title">{q ? m.search_suggest_empty_q({ q }) : m.search_suggest_empty_filtered()}</div>
        <div class="empty-text">{view.srOff ? m.search_off_empty() : rp.emptyText}</div>
      </div>
    {/if}

    {#if groups.length}
      <div class="groups">
        {#each groups as g, gi (g.cat)}
          <div class="group" role="group" aria-label={g.label}>
            <div class="group-head"><span class="group-label">{g.label}</span><span class="group-n">{g.n}</span></div>
            {#each g.rows as r, ri (r.key)}
              {@const i = (starts[gi] ?? 0) + ri}
              <button
                class="row"
                class:sel={i === idx}
                id={optId(i)}
                role="option"
                aria-selected={i === idx}
                onclick={r.run}
                onmousemove={() => hover(i)}
              >
                <span
                  class="tile"
                  class:round={r.round}
                  class:plain={r.plain}
                  style:background={r.plain ? undefined : r.tileBg}
                  style:color={r.plain ? undefined : r.tileInk}
                  >{#if r.hasAv}{r.av}{:else}<Icon name={r.icon} size={18} />{/if}</span
                >
                <span class="text">
                  <span class="label" style:font-weight={r.fw}
                    >{#each r.parts as p, pi (pi)}<span class="part" class:hl={p.hl}>{p.t}</span>{/each}</span
                  >
                  {#if r.sub}<span class="sub">{r.sub}</span>{/if}
                </span>
                {#if r.side}<span class="side">{r.side}</span>{/if}
                {#if r.k}<span class="key">{r.k}</span>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if groups.length}
    <div class="foot">
      <button class="all" onclick={all}>{rp.total > 0 ? m.search_more({ n: rp.total }) : m.search_suggest_all()}</button
      >
    </div>
  {/if}
</div>

<style>
  .pop {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 10px);
    z-index: 60;
    max-height: max(360px, calc(78vh - 100px));
    display: flex;
    flex-direction: column;
    border-radius: 26px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    transform-origin: top center;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
    cursor: default;
  }

  /* Search field narrower than the popup (on a portrait tablet): centered, at most window width − 32 px. */
  .pop.narrow {
    left: calc(50% - min(280px, 50vw - 16px));
    right: auto;
    width: min(560px, calc(100vw - 32px));
  }

  .head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 14px 10px 22px;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 18px;
  }

  .count {
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .grow {
    flex: 1;
  }

  .close {
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .scope {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
    margin: 0 22px 12px;
    padding: 4px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
  }

  .seg {
    flex: 1 1 0;
    min-width: 0;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 12px;
    border-radius: 9999px;
    background: transparent;
    box-shadow: none;
    color: var(--mfg);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .seg:hover {
    background: var(--hov);
  }

  .seg.on {
    background: var(--surface);
    box-shadow: var(--sh1);
    color: var(--fg);
  }

  .seg-icon {
    flex-shrink: 0;
    display: grid;
  }

  .seg-label,
  .chip-label,
  .ellipsis {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seg-n {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
  }

  .chips {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 22px 12px;
  }

  .chip {
    height: 30px;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 12px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 12.5px;
    font-weight: 800;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .chip:hover {
    background: color-mix(in oklab, var(--accsoft) 78%, var(--acc));
  }

  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0 14px 8px;
  }

  .idle {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 8px 8px;
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 -8px;
  }

  .recent-title {
    padding: 0 8px 4px;
  }

  .recent-title,
  .section-title,
  .group-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .recent-row {
    display: flex;
    align-items: center;
    border-radius: 14px;
    background: transparent;
  }

  .recent-row.sel,
  .row.sel {
    background: var(--hov);
  }

  .recent-run {
    flex: 1;
    min-width: 0;
    height: 42px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 8px 0 10px;
    text-align: left;
    font-size: 14.5px;
    font-weight: 600;
  }

  .recent-icon {
    display: grid;
    color: var(--mfg);
  }

  .recent-remove {
    width: 32px;
    height: 32px;
    margin-right: 5px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
  }

  .recent-remove:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .toggle {
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 11px;
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

  .toggle:hover {
    background: color-mix(in oklab, var(--fg) 12%, transparent);
  }

  .toggle-icon {
    display: grid;
    color: var(--mfg);
  }

  .toggle.on,
  .toggle.on:hover {
    background: var(--ink);
    color: var(--inkfg);
  }

  .toggle.on .toggle-icon {
    color: var(--inkfg);
  }

  .ops {
    padding: 12px 14px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .ops-label {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-right: 4px;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .op {
    height: 28px;
    padding: 0 9px;
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 2px 0 var(--bdhi);
    font-size: 12.5px;
    font-weight: 800;
    color: var(--fg);
    white-space: nowrap;
    transition: transform var(--dur, 220ms);
  }

  .op:hover {
    transform: translateY(-1px);
  }

  .empty {
    margin: 0 8px 6px;
    padding: 26px 20px 22px;
    border-radius: 20px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .empty-tile {
    width: 56px;
    height: 56px;
    border-radius: 19px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
  }

  .empty-title {
    margin-top: 16px;
    max-width: 100%;
    font-family: var(--font-serif);
    font-size: 19px;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .empty-text {
    margin-top: 6px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 8px 4px;
  }

  .group-n {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--fg) 7%, transparent);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
    color: var(--mfg);
  }

  .row {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px 6px 8px;
    border-radius: 16px;
    background: transparent;
    text-align: left;
  }

  .tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
    transition: background-color 150ms;
  }

  .tile.round {
    border-radius: 9999px;
  }

  /* Without own colors: marked in the accent color. */
  .tile.plain {
    background: var(--surface2);
    color: var(--mfg);
  }

  .row.sel .tile.plain {
    background: var(--acc);
    color: var(--accink);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: 14.5px;
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

  .sub {
    font-size: 12.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .side {
    flex-shrink: 0;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
    white-space: nowrap;
  }

  .key {
    flex-shrink: 0;
    min-width: 26px;
    height: 26px;
    padding: 0 8px;
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

  .foot {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 10px 14px 14px 22px;
    border-top: 1px solid var(--bd);
  }

  .all {
    height: 40px;
    flex-shrink: 0;
    padding: 0 20px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: var(--sh1);
    white-space: nowrap;
    transition: transform var(--dur, 220ms);
  }

  .all:hover {
    transform: translateY(-1px);
  }
</style>
