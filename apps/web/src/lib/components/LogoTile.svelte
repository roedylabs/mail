<!--
  Large logo tile of the splash screen (96 px, tilted, floating), also on
  the preliminary start page.
-->
<script lang="ts">
  import Logo from '#lib/components/Logo.svelte';
  import type { LogoValues } from '#lib/logo.ts';

  let { logo }: { logo: LogoValues } = $props();
</script>

<span class="tile"><span class="float"><Logo {logo} /></span></span>

<style>
  .tile {
    width: 96px;
    height: 96px;
    border-radius: 32px;
    overflow: hidden;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    /* fixed value (edge of the tile) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh3);
    transform: rotate(calc(var(--logo-tilt, 1) * -5deg));
    animation: snPop 520ms cubic-bezier(0.2, 1.3, 0.3, 1);
  }

  .float {
    display: block;
    width: 100%;
    height: 100%;
    animation: snFloat 3.2s ease-in-out 520ms infinite;
  }
</style>
