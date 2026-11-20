<!--
  Face of the accent tile that opens the colour editor ("More", setup step 1
  and Settings › Appearance): a ring of the palette's hues with a dot in the
  middle, in a custom colour (with its ink) or the surface while none is set.
  Fills the swatch it sits in (size, radius and selected ring stay the
  swatch's); decoration only, the button around it carries the name.
-->
<script lang="ts">
  import { accentInk, type HexColor } from '#lib/color.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';

  let { dot = null, icon }: { dot?: HexColor | null; icon: IconName } = $props();
</script>

<span class="ring" aria-hidden="true">
  <span class="cdot" style:background={dot ?? 'var(--surface)'} style:color={dot ? accentInk(dot) : 'var(--fg)'}>
    <Icon name={icon} />
  </span>
</span>

<style>
  .ring {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    display: grid;
    place-items: center;
    /* fixed values (the palette's hues, tile edge) */
    background: conic-gradient(from 210deg, #f5a06e, #f2c46b, #94c48d, #82bbec, #b0a2f2, #f097ad, #f5a06e);
    box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.08);
  }

  .cdot {
    height: 54%;
    aspect-ratio: 1;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 16px;
    /* fixed shadow (dot) */
    box-shadow:
      0 0 0 3px var(--surface),
      0 2px 6px -1px rgba(0, 0, 0, 0.3);
    transition: background-color 200ms;
  }
</style>
