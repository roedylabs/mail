<!--
  Sidebar: "New email", tabs Mailboxes/Folders/Tags, mailboxes of the active
  account and the account switch. Collapsed (82 px) only icons. Folder tree
  and tag list come as snippets, the popup "Switch account" as `switcher`.
  Tooltips only when collapsed or on the tabs not selected.
-->
<script lang="ts">
  import { sidebarDerived, type SidebarInput, type SidebarTab } from '#lib/shell.ts';
  import type { Snippet } from 'svelte';
  import { tablist } from '#lib/actions/tablist.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends SidebarInput {
    /** Sidebar collapsed (room 82 instead of 270 px). */
    collapsed: boolean;
    onCreate?: () => void;
    onTab?: (tab: SidebarTab) => void;
    addF?: () => void;
    addT?: () => void;
    toggleAcctSw?: () => void;
    folders?: Snippet;
    tags?: Snippet;
    /** Account switch popup, while `acctSwOpen`. */
    switcher?: Snippet;
  }

  let {
    wide,
    hidden,
    sbTab,
    inFolder = false,
    inTag = false,
    navRows,
    acctSw,
    acctSwOpen,
    allT2,
    addFShow,
    collapsed,
    onCreate,
    onTab,
    addF,
    addT,
    toggleAcctSw,
    folders,
    tags,
    switcher,
  }: Props = $props();

  const d = $derived(
    sidebarDerived(
      { wide, hidden, sbTab },
      { mail: m.sidebar_tab_mail(), folders: m.sidebar_tab_folders(), tags: m.sidebar_tab_tags() },
      { compose: m.sidebar_compose_key(), folder: m.sidebar_folder_new(), tag: m.sidebar_tag_new() },
    ),
  );
  const tabIndex = $derived(
    Math.max(
      0,
      d.rtTabs.findIndex((t) => t.on),
    ),
  );
  // Position of the indicator below the active tab: columns 4fr (active) and 1fr.
  const indLeft = $derived(`calc(4px + (100% - 8px - 2 * var(--sgap)) * ${tabIndex / 6} + ${tabIndex} * var(--sgap))`);
  const slotW = $derived(hidden ? '16px' : collapsed ? '82px' : '270px');
</script>

<div class="slot" style:width={slotW}>
  <nav
    class="sidebar"
    class:hidden
    style:width={wide ? '270px' : '82px'}
    style:visibility={d.sbVis}
    style:--vis-delay={d.sbVisDelay}
    style:--label-op={d.labelOp}
  >
    <button
      class="compose"
      onclick={onCreate}
      use:tooltip={{ text: d.cmpTip, side: 'right' }}
      aria-label={m.sidebar_compose()}
    >
      <span class="compose-tile"><Icon name="ti-pencil-plus" /></span>
      <span class="label">{m.sidebar_compose()}</span>
    </button>

    <!-- One tab stop, ←/→ and Home/End (tabs pattern). -->
    <div class="tabs" role="tablist" aria-label={m.sidebar_tabs()} use:tablist style:grid-template-columns={d.rtCols}>
      <span
        class="indicator"
        aria-hidden="true"
        style:left={indLeft}
        style:width="calc((100% - 8px - 2 * var(--sgap)) * {4 / 6})"
        style:opacity={wide ? 1 : 0}
      ></span>
      {#each d.rtTabs as t (t.key)}
        <button
          role="tab"
          class="tab"
          class:on={t.on}
          class:seg={t.on && !wide}
          aria-selected={t.on}
          onclick={() => onTab?.(t.key)}
          use:tooltip={{ text: t.tip, side: 'right' }}
          style:gap={t.gap}
        >
          <span class="tab-icon">
            <Icon name={t.icon} />
            <span
              class="dot"
              style:opacity={!t.on && ((t.key === 'folders' && inFolder) || (t.key === 'tags' && inTag)) ? 1 : 0}
            ></span>
          </span>
          <span class="tab-label" class:shown={t.on && wide}>{t.label}</span>
        </button>
      {/each}
    </div>

    <div class="panels" data-g-tabs={d.rtG}>
      <div class="track" style:transform="translateX({-tabIndex * 100}%)">
        <div
          role="tabpanel"
          class="panel rows"
          aria-hidden={d.rtPm.hidden}
          style:visibility={d.rtPm.vis}
          style:--vis-delay={d.rtPm.visDelay}
        >
          {#each navRows as r (r.id)}
            <button
              class="row"
              class:on={r.on}
              style:font-weight={r.fw}
              style:box-shadow={r.shadow}
              onclick={r.onClick}
              use:tooltip={{ text: r.tip, side: 'right' }}
            >
              <span class="row-tile"><Icon name={r.icon} /></span>
              <span class="label grow">{r.label}</span>
              {#if r.hasCnt}
                <span class="count label" aria-label={r.cntLabel}>
                  <span class="unread" class:zero={r.cntU === '0'}>{r.cntU}</span><span class="total">/ {r.cntN}</span>
                </span>
              {/if}
            </button>
          {/each}
        </div>
        <div
          role="tabpanel"
          class="panel"
          aria-hidden={d.rtPf.hidden}
          style:visibility={d.rtPf.vis}
          style:--vis-delay={d.rtPf.visDelay}
        >
          {@render folders?.()}
          {#if addFShow}
            <button class="add" onclick={addF} use:tooltip={{ text: d.addFTip, side: 'right' }}>
              <span class="add-tile"><Icon name="ti-plus" /></span>
              <span class="label">{m.sidebar_folder_new()}</span>
            </button>
          {/if}
        </div>
        <div
          role="tabpanel"
          class="panel"
          aria-hidden={d.rtPt.hidden}
          style:visibility={d.rtPt.vis}
          style:--vis-delay={d.rtPt.visDelay}
        >
          {@render tags?.()}
          <button class="add" onclick={addT} use:tooltip={{ text: d.addTTip, side: 'right' }}>
            <span class="add-tile"><Icon name="ti-plus" /></span>
            <span class="label">{m.sidebar_tag_new()}</span>
          </button>
        </div>
      </div>
    </div>

    <button
      class="acct"
      class:wide
      class:open={acctSw.open}
      data-pop="1"
      onclick={toggleAcctSw}
      aria-haspopup="menu"
      aria-expanded={acctSw.open}
      use:tooltip={{ text: acctSw.tip, side: 'right' }}
    >
      <span class="acct-tile" style:background={acctSw.tileBg} style:color={acctSw.tileInk}>
        <span class="stack">{acctSw.letter}</span>
        {#if acctSw.isAll}
          <span class="stack all">
            {#each allT2 as x, i (i)}
              <span class="mini" style:background={x.bg} style:color={x.ink}>{x.letter}</span>
            {/each}
          </span>
        {/if}
        {#if acctSw.warn}<span class="warn"></span>{/if}
      </span>
      <span class="acct-text label"
        ><span class="acct-title">{acctSw.title}</span><span class="acct-sub">{acctSw.sub}</span></span
      >
      <span class="selector label"><Icon name="ti-selector" /></span>
    </button>
  </nav>
  {#if acctSwOpen}{@render switcher?.()}{/if}
</div>

<style>
  .slot {
    flex-shrink: 0;
    position: relative;
    transition: width calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .sidebar {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 16px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    padding: 4px 14px 0 16px;
    border-radius: 0 28px 28px 0;
    background: var(--cnv);
    overflow: hidden;
    transition:
      width var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1),
      transform calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1),
      opacity var(--dur, 220ms),
      visibility 0s linear var(--vis-delay),
      background-color var(--dur, 220ms);
  }

  .sidebar.hidden {
    transform: translateX(-105%);
    opacity: 0;
    pointer-events: none;
  }

  .label {
    opacity: var(--label-op);
    transition: opacity var(--dur, 220ms);
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .compose {
    height: 50px;
    flex-shrink: 0;
    margin: 2px 0 10px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 6px;
    border-radius: 18px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-align: left;
    box-shadow: 0 10px 24px -12px rgba(43, 34, 28, 0.55);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .compose:hover {
    transform: translateY(-1px);
  }

  .compose:active {
    transform: scale(0.97);
  }

  .compose .label {
    flex: 1;
    min-width: 0;
  }

  .compose-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--acc);
    color: var(--accink);
    font-size: 19px;
    transform: rotate(-6deg);
  }

  .tabs {
    --sgap: 3px;
    position: relative;
    flex-shrink: 0;
    margin: 2px 0 8px;
    display: grid;
    gap: var(--sgap);
    padding: 4px;
    border-radius: 21px;
    background: var(--sunken);
    transition: grid-template-columns calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .indicator {
    position: absolute;
    top: 4px;
    bottom: 4px;
    border-radius: 17px;
    background: var(--surface);
    box-shadow: var(--sh1);
    pointer-events: none;
    transition:
      left calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1),
      width calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1),
      opacity var(--dur, 220ms);
  }

  .tab {
    position: relative;
    height: 38px;
    min-width: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border-radius: 17px;
    color: var(--mfg);
    font-size: 13.5px;
    font-weight: 800;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms),
      color var(--dur, 220ms),
      gap var(--dur, 220ms);
  }

  .tab:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .tab.on {
    color: var(--fg);
  }

  .tab.on:hover {
    background: var(--surface);
  }

  .tab.seg {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .tab-icon {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .dot {
    position: absolute;
    top: -2px;
    right: -4px;
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--acc);
    box-shadow: 0 0 0 2px var(--sunken);
    transition: opacity var(--dur, 220ms);
  }

  .tab-label {
    min-width: 0;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition:
      max-width calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1),
      opacity var(--dur, 220ms);
  }

  .tab-label.shown {
    max-width: 120px;
    opacity: 1;
  }

  .panels {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    margin: 0 -6px;
  }

  .track {
    height: 100%;
    display: flex;
    transition: transform calc(var(--dur, 220ms) * 1.4) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .panel {
    flex: 0 0 100%;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    padding: 0 6px 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition:
      opacity calc(var(--dur, 220ms) * 1.2),
      visibility 0s linear var(--vis-delay);
  }

  .panel.rows {
    gap: 3px;
  }

  .row {
    height: var(--rowh, 46px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
    border-radius: 17px;
    color: var(--mfg);
    font-size: 15px;
    white-space: nowrap;
    text-align: left;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .row:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .row.on {
    background: var(--surface);
    color: var(--fg);
  }

  .row-tile {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .row.on .row-tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .count {
    flex-shrink: 0;
    margin-right: 6px;
    display: flex;
    align-items: baseline;
    gap: 3px;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  .unread {
    font-weight: 800;
    color: var(--fg);
  }

  .unread.zero {
    color: var(--mfg);
  }

  .total {
    font-weight: 600;
    color: var(--mfg);
  }

  .add {
    height: var(--rowh, 46px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
    border-radius: 17px;
    color: var(--mfg);
    font-size: 14.5px;
    font-weight: 700;
    white-space: nowrap;
    text-align: left;
  }

  .add:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .add-tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    border: 1.5px dashed var(--bdhi);
    font-size: 17px;
  }

  .acct {
    height: 52px;
    flex-shrink: 0;
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 7px;
    border-radius: 17px;
    white-space: nowrap;
    text-align: left;
    /* When collapsed the invisible labels stick out; the focus ring would enclose them otherwise. */
    overflow: hidden;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms),
      height var(--dur, 220ms),
      padding var(--dur, 220ms),
      border-radius var(--dur, 220ms);
  }

  .acct:hover {
    background: var(--hov);
  }

  .acct.wide,
  .acct.open {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .acct.wide {
    height: 64px;
    padding: 0 14px 0 16px;
    border-radius: 22px;
  }

  .acct.wide:hover {
    box-shadow: var(--sh2);
  }

  .acct-tile {
    position: relative;
    width: 34px;
    height: 34px;
    border-radius: 12px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 16px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .acct.wide .acct-tile {
    transform: rotate(-4deg);
  }

  .stack {
    grid-area: 1 / 1;
  }

  .all {
    display: flex;
    align-items: center;
    padding-left: 14px;
  }

  .mini {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    margin-left: -14px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 2px var(--cnv);
    font-family: var(--font-serif);
    font-size: 12px;
  }

  .acct.open .mini {
    box-shadow: 0 0 0 2px var(--surface);
  }

  .warn {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: var(--danger);
    box-shadow: 0 0 0 2px var(--cnv);
  }

  .acct-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .acct-title {
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .acct-sub {
    font-size: 12.5px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .selector {
    display: grid;
    font-size: 17px;
    flex-shrink: 0;
    color: var(--mfg);
  }
</style>
