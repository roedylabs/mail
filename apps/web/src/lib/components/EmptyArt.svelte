<!--
  Artwork of empty views (e.g. no mail account yet): two floating tiles with
  placeholder lines and in the center the logo tile in the colors of the logo
  plate. 280 × 190 px; on mobile the page scales it down.
-->
<script lang="ts">
  import Logo from '#lib/components/Logo.svelte';
  import type { LogoValues } from '#lib/logo.ts';

  let { logo }: { logo: LogoValues } = $props();

  /** Initials larger than in the header logo (62 or 47 px). */
  const big = $derived<LogoValues>({ ...logo, fs: (logo.text ?? '').length > 1 ? '47px' : '62px' });
</script>

{#snippet lines(a: number, b: number)}
  <span class="line" style:width="{a}px"></span>
  <span class="line dim" style:width="{b}px"></span>
{/snippet}

<div class="empty-art" aria-hidden="true">
  <div class="fl" style:left="6px" style:top="44px" style:transform="rotate(-12deg)">
    <div class="tile side" style:animation-delay=".4s">
      <span class="dot sage"></span>
      {@render lines(54, 38)}
    </div>
  </div>
  <div class="fl" style:left="170px" style:top="34px" style:transform="rotate(10deg)">
    <div class="tile side" style:animation-delay="1.2s">
      <span class="dot lilac"></span>
      {@render lines(50, 34)}
    </div>
  </div>
  <div class="fl main" style:left="80px" style:top="14px" style:transform="rotate(-3deg)">
    <div class="tile logo"><Logo logo={big} /></div>
  </div>
</div>

<style>
  .empty-art {
    position: relative;
    width: 280px;
    height: 190px;
    flex-shrink: 0;
  }

  .fl {
    position: absolute;
    z-index: 0;
  }

  .fl.main {
    z-index: 2;
  }

  .tile {
    border-radius: 28px;
    overflow: hidden;
    box-shadow: var(--sh2);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 9px;
    animation: snFloat 6.5s ease-in-out infinite;
  }

  .side {
    width: 104px;
    height: 104px;
    background: var(--surface2);
  }

  .logo {
    width: 124px;
    height: 124px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
  }

  .dot {
    width: 28px;
    height: 28px;
    border-radius: 10px;
  }

  /* fixed colors (sage, lilac), not themed */
  .sage {
    background: #94c48d;
  }

  .lilac {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #b0a2f2;
  }

  .line {
    height: 8px;
    border-radius: 4px;
    background: var(--bdhi);
  }

  .line.dim {
    opacity: 0.7;
  }
</style>
