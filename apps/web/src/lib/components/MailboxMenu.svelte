<!--
  Mobile "Mailboxes" sheet with the tabs Mailboxes, Folders and Tags as in the
  sidebar (the same tab `sbTab`), the mailboxes of the account or of "All
  accounts" (`mFolderRows`), the folder tree and the tag list as snippets and
  at the bottom the account switch, which opens "Switch account" above the
  sheet (`toggleMSw`).
-->
<script lang="ts">
  import { sidebarDerived, type MailboxMenuValues } from '#lib/shell.ts';
  import type { Snippet } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { swipeTabs, tabPanelStyle } from '#lib/tab-swipe.ts';

  interface Props extends MailboxMenuValues {
    /** Folder tree in the "Folders" tab. */
    folders?: Snippet;
    /** Tag list in the "Tags" tab. */
    tags?: Snippet;
  }

  let {
    mFolderRows,
    sbTab,
    inFolder,
    inTag,
    acctSw,
    allT2,
    addFShow,
    onTab,
    addF,
    addT,
    toggleMSw,
    closeSheet,
    folders,
    tags,
  }: Props = $props();

  // In the sheet the tabs are always expanded (`full`).
  const d = $derived(
    sidebarDerived(
      { wide: true, hidden: false, sbTab },
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
  // On mobile the active tab is 2.4 times as wide as the others (`rtW`, `data-fr="2.4"`), on desktop 4 times.
  const FR = 2.4;
  const rtCols = $derived(d.rtTabs.map((t) => (t.on ? `minmax(0,${FR}fr)` : 'minmax(0,1fr)')).join(' '));
  // Position of the indicator (`rtInd`): columns 2.4fr (active) and 1fr, gap 4px.
  const indLeft = $derived(`calc(4px + (100% - 16px) * ${tabIndex / (FR + 2)} + ${tabIndex} * 4px)`);
  const indWidth = `calc((100% - 16px) * ${FR / (FR + 2)})`;
  const dotOp = (key: string, on: boolean) =>
    !on && ((key === 'folders' && inFolder) || (key === 'tags' && inTag)) ? 1 : 0;
</script>

<div class="head">
  <span class="title">{m.mailbox_menu_title()}</span>
  <button class="close" onclick={closeSheet} aria-label={m.shell_close()} use:tooltip={m.shell_close()}
    ><Icon name="ti-x" /></button
  >
</div>

<!-- Segment and panels; a horizontal swipe on the panels switches the tab (`swipeTabs`). -->
<div data-g-tabsw>
  <div
    class="tabs"
    role="tablist"
    aria-label={m.mailbox_menu_tabs()}
    style:grid-template-columns="var(--gcols, {rtCols})"
  >
    <span class="indicator" aria-hidden="true" style:left="var(--gil, {indLeft})" style:width="var(--giw, {indWidth})"
    ></span>
    {#each d.rtTabs as t, i (t.key)}
      <button
        role="tab"
        class="tab"
        class:on={t.on}
        aria-selected={t.on}
        aria-label={t.label}
        onclick={() => onTab(t.key)}
        style:color="var(--gt{i}c, {t.on ? 'var(--fg)' : 'var(--mfg)'})"
        style:gap="var(--gt{i}g, {t.gap})"
      >
        <span class="tab-icon">
          <Icon name={t.icon} />
          <span class="dot" style:opacity={dotOp(t.key, t.on)}></span>
        </span>
        <span
          class="tab-label"
          style:max-width="var(--gt{i}w, {t.on ? '120px' : '0px'})"
          style:opacity="var(--gt{i}o, {t.on ? 1 : 0})">{t.label}</span
        >
      </button>
    {/each}
  </div>

  <div
    class="panels"
    data-g-tabs
    {@attach swipeTabs(() =>
      ui.swipeOn
        ? {
            animations: prefs.motion,
            index: tabIndex,
            count: d.rtTabs.length,
            fr: FR,
            desk: false,
            select: (i) => onTab(d.rtTabs[i]?.key ?? sbTab),
          }
        : null,
    )}
  >
    <div class="track" style:transform="translateX(calc({-tabIndex * 100}% + var(--gdx, 0px)))">
      <div role="tabpanel" class="panel rows no-scrollbar" aria-hidden={d.rtPm.hidden} style={tabPanelStyle(0, d.rtPm)}>
        {#each mFolderRows as r (r.label)}
          <button class="row" class:on={r.on} style:font-weight={r.fw} onclick={r.onClick}>
            <span class="row-tile"><Icon name={r.icon} /></span><span>{r.label}</span>
          </button>
        {/each}
      </div>
      <div role="tabpanel" class="panel no-scrollbar" aria-hidden={d.rtPf.hidden} style={tabPanelStyle(1, d.rtPf)}>
        {@render folders?.()}
        {#if addFShow}
          <button class="add" onclick={addF}>
            <span class="add-tile"><Icon name="ti-plus" /></span>
            <span>{m.sidebar_folder_new()}</span>
          </button>
        {/if}
      </div>
      <div role="tabpanel" class="panel no-scrollbar" aria-hidden={d.rtPt.hidden} style={tabPanelStyle(2, d.rtPt)}>
        {@render tags?.()}
        <button class="add" onclick={addT}>
          <span class="add-tile"><Icon name="ti-plus" /></span>
          <span>{m.sidebar_tag_new()}</span>
        </button>
      </div>
    </div>
  </div>
</div>

<button class="acct" onclick={toggleMSw} aria-haspopup="dialog">
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
  <span class="acct-text">
    <span class="acct-email">{acctSw.email}</span>
    <span class="acct-sub">{m.switcher_title()}</span>
  </span>
  <span class="selector"><Icon name="ti-selector" /></span>
</button>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 2px 12px 10px;
  }

  .title {
    flex: 1;
    font-family: var(--font-serif);
    font-size: 20px;
  }

  .close {
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .tabs {
    position: relative;
    margin-bottom: 10px;
    display: grid;
    gap: 4px;
    padding: 4px;
    border-radius: 24px;
    background: var(--sunken);
    transition: grid-template-columns var(--gtd, calc(var(--dur, 220ms) * 1.4))
      var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1));
  }

  .indicator {
    position: absolute;
    top: 4px;
    bottom: 4px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    pointer-events: none;
    transition:
      left var(--gtd, calc(var(--dur, 220ms) * 1.4)) var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1)),
      width var(--gtd, calc(var(--dur, 220ms) * 1.4)) var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1));
  }

  .tab {
    position: relative;
    height: 44px;
    min-width: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    border-radius: 20px;
    background: transparent;
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    transition:
      color var(--gtd, var(--dur, 220ms)),
      gap var(--gtd, var(--dur, 220ms)),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tab:active {
    transform: scale(0.96);
  }

  .tab-icon {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .dot {
    position: absolute;
    top: -2px;
    right: -4px;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: var(--acc);
    box-shadow: 0 0 0 2px var(--sunken);
    transition: opacity var(--dur, 220ms);
  }

  .tab-label {
    min-width: 0;
    overflow: hidden;
    transition:
      max-width var(--gtd, calc(var(--dur, 220ms) * 1.4)) var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1)),
      opacity var(--gtd, var(--dur, 220ms));
  }

  .panels {
    position: relative;
    height: 352px;
    overflow: hidden;
    margin: 0 -12px;
    /* Scrolling stays with the browser, horizontal movement goes to the tab swipe. */
    touch-action: pan-y;
  }

  .track {
    height: 100%;
    display: flex;
    transition: transform var(--gtd, calc(var(--dur, 220ms) * 1.4)) var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1));
  }

  /* Panel: hidden opacity 0 and scale(.96), visibility delayed (`visDelay`) */
  .panel {
    flex: 0 0 100%;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 0 12px 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transform-origin: top center;
    transition:
      opacity var(--gtd, calc(var(--dur, 220ms) * 1.2)),
      transform var(--gtd, calc(var(--dur, 220ms) * 1.4)) var(--gte, cubic-bezier(0.3, 0.7, 0.2, 1)),
      visibility 0s linear var(--vis-delay);
  }

  .panel.rows {
    gap: 3px;
  }

  /* Row like `mrow()`: selected `bg` var(--accsoft), tile in accent color and rotated */
  .row {
    height: calc(var(--rowh, 46px) + 6px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 8px;
    border-radius: 18px;
    background: transparent;
    color: var(--mfg);
    font-size: 15.5px;
    text-align: left;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .row.on,
  .row.on:hover {
    background: var(--accsoft);
    color: var(--fg);
  }

  .row-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-size: 19px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .row.on .row-tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .add {
    height: calc(var(--rowh, 46px) + 6px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
    border-radius: 18px;
    color: var(--mfg);
    font-size: 15px;
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
    margin-top: 14px;
    width: 100%;
    height: 68px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 16px 0 12px;
    border-radius: 24px;
    background: var(--surface2);
    text-align: left;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .acct:active {
    transform: scale(0.98);
  }

  .acct-tile {
    position: relative;
    width: 42px;
    height: 42px;
    border-radius: 14px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 18px;
    transform: rotate(-6deg);
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
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    margin-left: -14px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 2px var(--surface2);
    font-family: var(--font-serif);
    font-size: 13px;
  }

  .warn {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: var(--danger);
    box-shadow: 0 0 0 2px var(--surface2);
  }

  .acct-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .acct-email {
    font-size: 15px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-sub {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
  }

  .selector {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: var(--sh1);
    color: var(--fg);
    font-size: 17px;
  }
</style>
