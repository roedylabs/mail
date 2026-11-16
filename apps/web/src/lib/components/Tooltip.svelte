<!--
  The app's one tooltip from `ui.tip` (`use:tooltip`, `#lib/actions/tooltip.ts`).
  First measure invisibly, then place next to the element in the window.
-->
<script lang="ts">
  import { placeTip, TIP_ID, tipValues, type TipState } from '#lib/actions/tooltip.ts';

  interface Props {
    tip: TipState;
    /** Report back the measured and placed position. */
    onplace: (tip: TipState) => void;
  }

  let { tip, onplace }: Props = $props();

  let box: HTMLDivElement | undefined = $state();
  const t = $derived(tipValues(tip));

  $effect(() => {
    if (tip.phase !== 'measure' || !box) return;
    const size = { w: box.offsetWidth, h: box.offsetHeight };
    const view = { w: window.innerWidth, h: window.innerHeight };
    onplace({ ...tip, ...placeTip(tip.anchor, size, view, tip.side), ...size, phase: 'show' });
  });
</script>

<div
  bind:this={box}
  id={TIP_ID}
  role="tooltip"
  class="tip"
  style:left="{t.x}px"
  style:top="{t.y}px"
  style:opacity={t.op}
  style:transform-origin={t.origin}
  style:animation={t.anim}
  style:transition={t.tr}
>
  <span class="arrow" style:left="{t.arL}px" style:top="{t.arT}px"></span>
  <div class="body" style:padding={t.pad}><span>{t.text}</span></div>
</div>

<style>
  .tip {
    position: fixed;
    z-index: 200;
    max-width: 240px;
    pointer-events: none;
  }

  .arrow {
    position: absolute;
    width: 10px;
    height: 10px;
    border-radius: 2.5px;
    background: var(--ink);
    transform: rotate(45deg);
  }

  .body {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 12px;
    background: var(--ink);
    color: var(--inkfg);
    /* fixed shadow of the tooltip */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.55);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
    text-wrap: pretty;
    -webkit-font-smoothing: antialiased;
  }

  .body span {
    min-width: 0;
  }
</style>
