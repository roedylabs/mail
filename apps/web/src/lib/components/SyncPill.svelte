<!--
  Sync pill: bottom left on desktop; on mobile top center in the page area,
  8 px below the 60 px high top bar (header, head of the reading view, back
  bar), below the notice bar and sheets.
-->
<script lang="ts">
  import type { SyncPillValues } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';

  let { isMobile, syncText, syncSub }: SyncPillValues = $props();
</script>

{#if isMobile}
  <div class="pill mobile" role="status">
    <span class="spin"><Icon name="ti-refresh" /></span><span class="text">{syncText}</span>
  </div>
{:else}
  <div class="pill desk" role="status">
    <span class="tile"><span class="spin"><Icon name="ti-refresh" /></span></span>
    <span class="lines"><span class="text">{syncText}</span><span class="sub">{syncSub}</span></span>
  </div>
{/if}

<style>
  .pill {
    position: absolute;
    z-index: 70;
    display: flex;
    align-items: center;
    border-radius: 9999px;
    background: var(--pop);
    box-shadow: var(--sh2);
    pointer-events: none;
  }

  .desk {
    left: 24px;
    bottom: 24px;
    gap: 10px;
    padding: 8px 16px 8px 8px;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile {
    left: 50%;
    top: 68px;
    transform: translateX(-50%);
    gap: 8px;
    padding: 6px 14px 6px 8px;
    animation: snFade 240ms ease-out;
  }

  .tile {
    width: 30px;
    height: 30px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 16px;
  }

  .spin {
    display: grid;
    animation: var(--spin, none);
  }

  .mobile .spin {
    font-size: 15px;
    color: var(--deep);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .text {
    font-size: 13.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .mobile .text {
    font-size: 13px;
  }

  .sub {
    font-size: 12px;
    color: var(--mfg);
    white-space: nowrap;
  }
</style>
