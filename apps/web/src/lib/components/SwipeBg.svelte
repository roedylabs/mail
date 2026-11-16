<!--
  Area behind a swipeable row (`data-sw-bg`) in the message lists
  (soft and compact): on the left the action to the right (`swR`, icon before
  the text), on the right the one to the left (`swL`, text before the icon).
  `swipeRow` (`#lib/swipe.ts`) sets color, clip and opacity during the
  gesture, only the resting values are here. The area inherits the radius from
  the wrapper (`data-sw`); the lists set gap, font and icon size with
  `--sw-pad`, `--sw-fs` and `--sw-icon` on the wrapper.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { SwipeAction } from '#lib/swipe.ts';

  interface Props {
    /** Swipe-left action (`swL`): right side of the area. */
    left: SwipeAction | null;
    /** Swipe-right action (`swR`): left side of the area. */
    right: SwipeAction | null;
  }

  let { left, right }: Props = $props();
</script>

<!-- Exactly two children: `swipeRow` shows one of them per direction. -->
<div class="bg" data-sw-bg aria-hidden="true">
  <span class="side r"
    >{#if right}<Icon name={right.icon} />{right.label}{/if}</span
  ><span class="side l"
    >{#if left}{left.label}<Icon name={left.icon} />{/if}</span
  >
</div>

<style>
  .bg {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sw-pad);
    font-size: var(--sw-fs);
    font-weight: 800;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
  }

  .side {
    display: flex;
    align-items: center;
    gap: 8px;
    opacity: 0;
    transform: scale(var(--sws, 1));
    transition: transform 220ms cubic-bezier(0.3, 1.6, 0.5, 1);
  }

  .side > :global(svg) {
    font-size: var(--sw-icon);
  }

  .r {
    transform-origin: left center;
  }

  .l {
    transform-origin: right center;
  }
</style>
