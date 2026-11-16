<!--
  Time picker with the columns "Hour" and "Minute" (values from
  `timePickValues()` in `#lib/time-picker.ts`). On desktop the content of the
  popover at the field (the page draws frame and shadow), on mobile the content
  of the sheet with title, close and "Done". The chosen hour and minute sit in
  the center of their column: immediately on open, smoothly after a change
  (`timeSig`).
  Style values (`bg`, `color`, `hoverBg`, `hoverC`) are the class `on`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import type { TimeCell, TimePickValues } from '#lib/time-picker.ts';

  interface Props {
    timePick: TimePickValues;
    isMobile: boolean;
  }

  let { timePick, isMobile }: Props = $props();

  let hCol: HTMLElement | undefined = $state();
  let mCol: HTMLElement | undefined = $state();
  /** First alignment after opening: without animation. */
  const align = { fresh: true };

  /** Cell `index` (hour or minute) into the center of the column. */
  function center(col: HTMLElement | undefined, index: number, smooth: boolean) {
    const el = col?.children[index];
    if (!col || !(el instanceof HTMLElement)) return;
    const top = el.offsetTop - col.clientHeight / 2 + el.offsetHeight / 2;
    if (smooth) col.scrollTo({ top, behavior: 'smooth' });
    else col.scrollTop = top;
  }

  // Re-center only for a different time, not on every recomputation of the values (otherwise a column jumps back while scrolling).
  const hh = $derived(Number(timePick.hh));
  const mm = $derived(Number(timePick.mm));
  $effect(() => {
    const smooth = !align.fresh && untrack(() => prefs.motion);
    align.fresh = false;
    center(hCol, hh, smooth);
    center(mCol, mm, smooth);
  });
</script>

{#snippet column(name: string, cells: TimeCell[], kind: 'h' | 'm')}
  {#if kind === 'h'}
    <div data-tcol="h" role="listbox" aria-label={name} class="col no-scrollbar" bind:this={hCol}>
      {@render options(cells)}
    </div>
  {:else}
    <div data-tcol="m" role="listbox" aria-label={name} class="col no-scrollbar" bind:this={mCol}>
      {@render options(cells)}
    </div>
  {/if}
{/snippet}

{#snippet options(cells: TimeCell[])}
  {#each cells as o (o.label)}
    <button
      type="button"
      role="option"
      aria-selected={o.on}
      tabindex={isMobile ? undefined : -1}
      class="cell"
      class:on={o.on}
      style:font-weight={o.fw}
      onclick={o.onClick}>{o.label}</button
    >
  {/each}
{/snippet}

<div class="time-pick" class:mobile={isMobile}>
  {#if isMobile}
    <div class="head">
      <span class="title">{timePick.title}</span>
      <button type="button" class="close" aria-label={m.shell_close()} onclick={timePick.close}
        ><Icon name="ti-x" /></button
      >
    </div>
  {:else}
    <div class="heads">
      <span>{m.time_hour()}</span>
      <span class="gap"></span>
      <span>{m.time_minute()}</span>
    </div>
  {/if}
  <div class="cols">
    {@render column(m.time_hour(), timePick.hours, 'h')}
    <div aria-hidden="true" class="colon">:</div>
    {@render column(m.time_minute(), timePick.mins, 'm')}
  </div>
  {#if isMobile}
    <button type="button" class="done" onclick={timePick.close}>{m.time_done()}</button>
  {/if}
</div>

<style>
  .heads {
    display: flex;
    padding: 4px 4px 6px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
    text-align: center;
  }

  .heads span {
    flex: 1;
  }

  .heads .gap {
    flex: none;
    width: 13px;
  }

  .cols {
    position: relative;
    display: flex;
    gap: 4px;
  }

  .mobile .cols {
    gap: 8px;
    padding: 0 6px;
  }

  .col {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 232px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 96px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* fixed values (fade at top and bottom) */
    mask-image: linear-gradient(transparent, #000 22%, #000 78%, transparent);
  }

  .mobile .col {
    height: 276px;
    padding: 112px 0;
    mask-image: linear-gradient(transparent, #000 30%, #000 70%, transparent);
  }

  .colon {
    width: 5px;
    align-self: center;
    font-family: var(--font-serif);
    font-size: 18px;
    color: var(--mfg);
    text-align: center;
  }

  .mobile .colon {
    position: relative;
    width: auto;
    font-size: 26px;
  }

  .cell {
    flex-shrink: 0;
    height: 40px;
    border-radius: 14px;
    background: transparent;
    color: var(--mfg);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    transition:
      background-color 120ms,
      color 120ms;
  }

  .cell:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .cell.on,
  .cell.on:hover {
    background: var(--acc);
    color: var(--accink);
  }

  .mobile .cell {
    height: 52px;
    border-radius: 18px;
    font-size: 22px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .cell:not(.on):hover {
    background: transparent;
    color: var(--mfg);
  }

  /* Sheet: title and close */
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 2px 8px 10px;
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
    font-size: 19px;
    color: var(--mfg);
  }

  .close:active {
    background: var(--hov);
  }

  .done {
    width: 100%;
    height: 50px;
    margin-top: 14px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15.5px;
    font-weight: 800;
  }
</style>
