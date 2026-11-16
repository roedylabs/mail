<!--
  Picker list: on mobile it fills the sheet (values `pick`, built like the
  shell's `mkSel`); on desktop the pages show the same list as a popover.
  Used for changing a user's role, and for country and time zone in language
  and region settings.
-->
<script lang="ts">
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import type { PickerListValues } from '#lib/shell.ts';

  let { pick, closeSheet }: PickerListValues = $props();
</script>

<div class="head">
  <span class="title">{pick.title}</span>
  <button class="close" onclick={closeSheet} use:tooltip={m.shell_close()} aria-label={m.shell_close()}
    ><Icon name="ti-x" /></button
  >
</div>
<div role="listbox" aria-label={pick.title} class="opts">
  {#each pick.opts as o (o.label)}
    <button role="option" aria-selected={o.on} class="opt" class:on={o.on} onclick={o.onClick}>
      <span class="text">
        <span class="label" style:font-weight={o.fw}>{o.label}</span>
        {#if o.hasSub}<span class="sub">{o.sub}</span>{/if}
      </span>
      <span class="check"><Icon name="ti-check" /></span>
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

  .opts {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .opt {
    min-height: 54px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 12px 8px 16px;
    border-radius: 18px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .opt.on {
    background: var(--accsoft);
  }

  .opt:active {
    background: var(--hov);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: 15.5px;
  }

  .sub {
    font-size: 13px;
    color: var(--mfg);
  }

  .check {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 2px solid var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 14px;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .check :global(svg) {
    opacity: 0;
  }

  .on .check {
    border: 0;
    background: var(--ink);
  }

  .on .check :global(svg) {
    opacity: 1;
  }
</style>
