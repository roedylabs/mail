<!--
  Folder tree: folders of a mail account with indent and lines, in
  "All accounts" a header row and "New folder" per account. Collapsed
  (`ftLblOp` 0) only the top-level tiles, with tooltips and a dot for
  unread. Rows from `folderRows()` (#lib/shell.ts); one component for
  desktop and mobile, line and ring color from the background `sbBg`.
-->
<script lang="ts">
  import type { FolderTreeValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends FolderTreeValues {
    /** Background below the tree (sidebar or sheet) for rings and lines. */
    sbBg?: string;
  }

  let { fRows, fNone, ftLblOp, sbBg = 'var(--cnv)' }: Props = $props();
</script>

<div class="tree" style:--lbl-op={ftLblOp} style:--sb-bg={sbBg}>
  {#each fRows as r (r.key)}
    {#if r.head}
      <button
        class="head"
        style:margin-top={r.mt}
        onclick={r.toggle}
        aria-expanded={r.expanded}
        use:tooltip={{ text: r.tip, side: 'right' }}
      >
        <span class="letter" style:background={r.aBg} style:color={r.aInk}>{r.letter}</span>
        <span class="email lbl">{r.email}</span>
        <span class="chev lbl" style:transform={r.chevT}><Icon name="ti-chevron-down" /></span>
      </button>
    {:else if r.add}
      <button
        class="add"
        style:height={r.h}
        style:border-radius={r.rr}
        style:font-size={r.fs}
        onclick={r.onClick}
        use:tooltip={{ text: r.tip, side: 'right' }}
      >
        <span class="add-tile"><Icon name="ti-plus" /></span>
        <span class="lbl">{m.sidebar_folder_new()}</span>
      </button>
    {:else}
      <div
        class="item"
        class:sub={r.sub}
        class:sel={r.sel}
        class:inside={r.inside}
        class:first={r.first}
        style:height={r.h}
        style:padding-left={r.bl}
      >
        {#each r.lines as l (l.x)}
          <span class="line" style:left={l.x}></span>
        {/each}
        {#if r.cont}
          <span class="line cont" style:left={r.ex}></span>
        {/if}
        {#if r.sub}
          <span class="elbow" style:left={r.ex}></span>
        {/if}
        <div
          class="pill"
          style:gap={r.gap}
          style:padding-left={r.pl}
          style:border-radius={r.rr}
          style:--bg={r.bg}
          style:--hbg={r.hoverBg}
          style:box-shadow={r.sh}
        >
          <button
            class="tile"
            style:width={r.tw}
            style:height={r.tw}
            style:font-size={r.isz}
            onclick={r.tileClick}
            aria-expanded={r.tileExp}
            aria-label={r.tileLabel}
            use:tooltip={{ text: r.tileTip, side: 'right' }}
          >
            <Icon name={r.icon} />
            <span class="dot" class:on={r.dot}></span>
            {#if r.kids}
              <span class="badge" aria-hidden="true"><Icon name={r.bIcon} stroke={3} /></span>
            {/if}
          </button>
          <button
            class="name"
            style:border-radius={r.rr}
            style:font-size={r.fs}
            style:font-weight={r.fw}
            onclick={r.onClick}
            use:tooltip={{ text: r.tip, side: 'right' }}
          >
            <span class="label lbl">{r.label}</span>
            {#if r.hasCnt}
              <span class="count lbl" aria-label={r.cntLabel}>
                <span class="unread" class:zero={r.cntU === '0'}>{r.cntU}</span><span class="total">/ {r.cntN}</span>
              </span>
            {/if}
          </button>
        </div>
      </div>
    {/if}
  {/each}
  {#if fNone}
    <div class="none">{m.folders_none()}</div>
  {/if}
</div>

<style>
  .tree {
    --tree-c: color-mix(in oklab, var(--mfg) 46%, var(--sb-bg));
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lbl {
    opacity: var(--lbl-op);
    transition: opacity var(--dur, 220ms);
  }

  .head {
    height: 30px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 0 14px;
    border-radius: 10px;
    white-space: nowrap;
    text-align: left;
    color: var(--mfg);
    /* When collapsed the invisible arrow sticks out; the focus ring would enclose it otherwise. */
    overflow: hidden;
  }

  .head:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .letter {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 11px;
  }

  .email {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12.5px;
    font-weight: 700;
  }

  .chev {
    display: grid;
    flex-shrink: 0;
    font-size: 14px;
    transition:
      opacity var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .add {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
    color: var(--mfg);
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

  .item {
    position: relative;
    flex-shrink: 0;
    display: flex;
  }

  .line {
    position: absolute;
    top: -2px;
    bottom: 0;
    width: 1.5px;
    background: var(--tree-c);
  }

  .line.cont {
    top: 0;
  }

  .elbow {
    position: absolute;
    top: -2px;
    height: calc(50% + 2px);
    width: 11px;
    border-left: 1.5px solid var(--tree-c);
    border-bottom: 1.5px solid var(--tree-c);
    border-bottom-left-radius: 8px;
    transition: border-color var(--dur, 220ms);
  }

  .first .elbow {
    top: -4px;
    height: calc(50% + 4px);
  }

  .sel .elbow {
    border-color: var(--acc);
  }

  .pill {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    background: var(--bg);
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .sel .pill,
  .inside .pill {
    color: var(--fg);
  }

  .pill:hover {
    background: var(--hbg);
    color: var(--fg);
  }

  .tile {
    position: relative;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: transparent;
    color: inherit;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sub .tile {
    border-radius: 8px;
  }

  .inside .tile {
    background: var(--accsoft);
  }

  .sel .tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .tile:active {
    transform: scale(0.9);
  }

  .dot {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: var(--acc);
    box-shadow: 0 0 0 2px var(--sb-bg);
    opacity: 0;
    transition: opacity var(--dur, 220ms);
  }

  .dot.on {
    opacity: 1;
  }

  .badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 14px;
    height: 14px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--fg);
    color: var(--sb-bg);
    box-shadow: 0 0 0 2px var(--sb-bg);
    font-size: 10px;
    opacity: var(--lbl-op);
    transition: opacity var(--dur, 220ms);
  }

  .name {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    white-space: nowrap;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    flex-shrink: 0;
    margin-right: 10px;
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

  .none {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
    white-space: nowrap;
    opacity: var(--lbl-op);
  }
</style>
