<!--
  Splash screen: logo tile, app name and loading bar until session and data are
  there. Fades out with `out`.
-->
<script lang="ts">
  import type { SplashValues } from '#lib/shell.ts';
  import LogoTile from '#lib/components/LogoTile.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { appName, logo, splash }: SplashValues = $props();
</script>

<div class="splash" class:out={splash === 'out'} role="status" aria-label={m.splash_loading({ app: appName })}>
  <LogoTile {logo} />
  <div class="text">
    <span class="name">{appName}</span>
    <span class="bar"><span></span></span>
  </div>
</div>

<style>
  .splash {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    background: var(--cnv);
    color: var(--fg);
    transition:
      opacity 380ms ease,
      transform 380ms ease;
    pointer-events: none;
  }

  .out {
    opacity: 0;
    transform: scale(1.03);
  }

  .text {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    animation: snFade 600ms ease-out 120ms both;
  }

  .name {
    font-family: var(--font-serif);
    font-size: 30px;
    line-height: 1;
  }

  .bar {
    position: relative;
    width: 120px;
    height: 4px;
    border-radius: 9999px;
    background: var(--bdhi);
    overflow: hidden;
  }

  .bar span {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 40%;
    border-radius: 9999px;
    background: var(--acc);
    animation: snBar 1.2s cubic-bezier(0.45, 0, 0.2, 1) infinite;
  }
</style>
