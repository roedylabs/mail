<!--
  Tag list: tags with color, indent and lines. Collapsed only the top-level
  tiles, with tooltips. Rows from `tagRows()` (#lib/shell.ts); one component
  for desktop and mobile, line and ring color from the background `sbBg`, tile
  and arc in the tag's color (`--tag-c`, `--tag-ink`).
-->
<script lang="ts">
  import type { TagListValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends TagListValues {
    /** Background below the list (sidebar or sheet) for rings and lines. */
    sbBg?: string;
  }

  let { tagRows, tNone, ftLblOp, tsShow, tsRow, sbBg = 'var(--cnv)' }: Props = $props();
</script>

<div class="tags" style:--lbl-op={ftLblOp} style:--sb-bg={sbBg}>
  <div class="list">
    {#each tagRows as r (r.key)}
      <div
        class="item"
        class:sub={r.sub}
        class:sel={r.sel}
        class:inside={r.inside}
        class:first={r.first}
        style:height={r.h}
        style:padding-left={r.bl}
        style:--tag-c={r.c}
        style:--tag-ink={r.ink}
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
            onclick={r.tileClick}
            aria-expanded={r.tileExp}
            aria-label={r.tileLabel}
            use:tooltip={{ text: r.tileTip, side: 'right' }}
          >
            <span class="mark" style:font-size={r.isz}><Icon name="ti-tag" /></span>
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
            aria-pressed={r.pressed}
            use:tooltip={{ text: r.tip, side: 'right' }}
          >
            <span class="label lbl">{r.label}</span>
            {#if r.warn}
              <!-- Only a hint, no button; with a counter without a right gap. -->
              <span
                class="warn lbl"
                class:cnt={r.hasCnt}
                role="img"
                aria-label={r.warnTip}
                use:tooltip={{ text: r.warnTip, side: 'top' }}><Icon name="ti-alert-triangle" /></span
              >
            {/if}
            {#if r.hasCnt}
              <span class="count lbl" aria-label={r.cntLabel}>
                <span class="unread" class:zero={r.cntU === '0'}>{r.cntU}</span><span class="total">/ {r.cntN}</span>
              </span>
            {/if}
          </button>
        </div>
      </div>
    {/each}
  </div>
  {#if tNone}
    <div class="none">{m.tags_none()}</div>
  {/if}
  {#if tsShow}
    <button
      class="fix"
      style:height={tsRow.h}
      style:border-radius={tsRow.rr}
      style:font-size={tsRow.fs}
      onclick={tsRow.open}
      aria-label={tsRow.aria}
      aria-haspopup="dialog"
      use:tooltip={{ text: tsRow.tip, side: 'right' }}
    >
      <span class="fix-tile"><Icon name="ti-alert-triangle" /></span>
      <span class="fix-label lbl">{m.tagfix_title()}</span>
      <span class="fix-n lbl" aria-hidden="true">{tsRow.n}</span>
    </button>
  {/if}
</div>

<style>
  .tags {
    --tree-c: color-mix(in oklab, var(--mfg) 46%, var(--sb-bg));
    display: flex;
    flex-direction: column;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lbl {
    opacity: var(--lbl-op);
    transition: opacity var(--dur, 220ms);
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
    border-color: var(--tag-c);
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
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sub .tile {
    border-radius: 8px;
  }

  .inside .tile {
    background: color-mix(in oklab, var(--tag-c) 34%, transparent);
  }

  .sel .tile {
    background: var(--tag-c);
    transform: rotate(-6deg);
  }

  .tile:active {
    transform: scale(0.9);
  }

  .mark {
    display: grid;
    color: var(--tag-c);
    transition: color var(--dur, 220ms);
  }

  .sel .mark {
    color: var(--tag-ink);
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

  .warn {
    flex-shrink: 0;
    margin-right: 10px;
    display: grid;
    place-items: center;
    color: var(--warn);
    font-size: 15px;
  }

  .warn.cnt {
    margin-right: 0;
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

  .fix {
    width: 100%;
    margin-top: 6px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
    color: var(--fg);
    font-weight: 700;
    white-space: nowrap;
    text-align: left;
  }

  .fix:hover {
    background: var(--hov);
  }

  .fix-tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--warn) 17%, transparent);
    color: var(--warn);
    font-size: 18px;
  }

  .fix-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fix-n {
    flex-shrink: 0;
    margin-right: 10px;
    font-size: 12.5px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
</style>
