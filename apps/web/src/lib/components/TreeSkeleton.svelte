<!--
  Placeholder rows of the folder tree (4) or the tag list (3) until the first
  response: tile 34 px and a label bar per row in `--surface2` with `--shim`,
  rows like the tree rows (height `--rowh`, on mobile 6 px more). `role="status"`
  with `aria-busy`; the label bars fade with the sidebar labels (`lblOp`).
-->
<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    kind: 'folders' | 'tags';
    isMobile: boolean;
    /** Opacity of the label bars: 0 in the collapsed sidebar. */
    lblOp: number;
  }

  let { kind, isMobile, lblOp }: Props = $props();

  const WIDTHS = ['58%', '42%', '50%', '36%'];
  const rows = $derived(WIDTHS.slice(0, kind === 'folders' ? 4 : 3).map((w, i) => ({ w, d: `${i * 150}ms` })));
</script>

<div
  class="sk"
  class:mobile={isMobile}
  role="status"
  aria-busy="true"
  aria-label={kind === 'folders' ? m.folders_loading() : m.tags_loading()}
  style:--lbl-op={lblOp}
>
  {#each rows as r (r.w)}
    <div class="row" aria-hidden="true">
      <span class="tile" style:animation-delay={r.d}></span>
      <span class="bar" style:width={r.w} style:animation-delay={r.d}></span>
    </div>
  {/each}
</div>

<style>
  .sk {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    height: var(--rowh, 46px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 7px;
  }

  .mobile .row {
    height: calc(var(--rowh, 46px) + 6px);
  }

  .tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface2);
    animation: var(--shim, none);
  }

  .bar {
    height: 12px;
    border-radius: 9999px;
    background: var(--surface2);
    animation: var(--shim, none);
    opacity: var(--lbl-op);
    transition: opacity var(--dur, 220ms);
  }
</style>
