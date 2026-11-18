<!--
  Folder tab when the first load of the mailboxes failed for every account of
  the view: one row button (`role="alert"` around it) with the tile
  `ti-cloud-off` in `--danger`, "Couldn’t load folders" and below "Try again"
  in `--deep`; a click shows the placeholder rows and loads again. Collapsed
  (`lblOp` 0) only the tile, with the tooltip "Couldn’t load folders. Try again".
-->
<script lang="ts">
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    /** Opacity of the labels: 0 in the collapsed sidebar. */
    lblOp: number;
    onRetry: () => void;
  }

  let { lblOp, onRetry }: Props = $props();
</script>

<div class="fail" role="alert">
  <button
    type="button"
    class:collapsed={lblOp === 0}
    onclick={onRetry}
    use:tooltip={{ text: lblOp === 0 ? m.folders_load_failed_tip() : undefined, side: 'right' }}
  >
    <span class="tile" aria-hidden="true"><Icon name="ti-cloud-off" /></span>
    <span class="body" style:opacity={lblOp}>
      <span class="title">{m.folders_load_failed()}</span>
      <span class="retry"><Icon name="ti-refresh" size={15} />{m.error_retry()}</span>
    </span>
  </button>
</div>

<style>
  .fail {
    display: flex;
    flex-direction: column;
  }

  button {
    width: 100%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 6px 7px;
    border-radius: 14px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  button:hover {
    background: var(--hov);
  }

  .tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface2);
    display: grid;
    place-items: center;
    font-size: 18px;
    color: var(--danger);
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transition: opacity var(--dur, 220ms);
  }

  /* Collapsed only the tile: the hidden labels keep one line instead of wrapping into the narrow rail. */
  .collapsed .body {
    white-space: nowrap;
    overflow: hidden;
  }

  .title,
  .retry {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
  }

  .title {
    color: var(--fg);
    text-wrap: pretty;
  }

  .retry {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--deep);
  }
</style>
