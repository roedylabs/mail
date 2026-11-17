<!--
  Menu "More" of the mobile tab bar, shown in the sheet (settings,
  administration, apps).
-->
<script lang="ts">
  import type { NavMenuValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { mNavTitle, mExtraRows, closeSheet }: NavMenuValues = $props();
</script>

<div class="head">
  <span class="title">{mNavTitle}</span>
  <button class="close" onclick={closeSheet} use:tooltip={m.shell_close()} aria-label={m.shell_close()}
    ><Icon name="ti-x" /></button
  >
</div>
<div class="rows">
  {#each mExtraRows as r (r.label)}
    <button class="row" class:on={r.on} style:font-weight={r.fw} onclick={r.onClick}>
      <span class="tile"><Icon name={r.icon} /></span><span>{r.label}</span>
    </button>
  {/each}
</div>

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

  .rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .row {
    height: calc(var(--rowh, 46px) + 6px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 8px;
    border-radius: 18px;
    color: var(--mfg);
    font-size: 15.5px;
    text-align: left;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .row.on {
    background: var(--accsoft);
    color: var(--fg);
  }

  .tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .on .tile {
    background: var(--acc);
    color: var(--accink);
  }
</style>
