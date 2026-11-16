<!--
  App icon in four kinds (default mark, initial, Tabler icon, image). Fills
  the surrounding frame and inherits its colors from there.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import { isIconName } from '#lib/icons.ts';
  import type { LogoValues } from '#lib/logo.ts';

  let { logo = { isMark: true, text: 'R', fs: '50cqmin' } }: { logo?: LogoValues } = $props();

  const id = $props.id();
  const icon = $derived(logo.icon && isIconName(logo.icon) ? logo.icon : undefined);
</script>

<div class="logo">
  {#if logo.isMark}
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <mask id="{id}-a">
        <rect x="-12" y="-12" width="72" height="72" fill="#fff" />
        <path
          d="M10 17h22a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V21a4 4 0 0 1 4-4z"
          fill="#000"
          stroke="#000"
          stroke-width="3"
          stroke-linejoin="round"
        />
      </mask>
      <mask id="{id}-b">
        <rect x="-12" y="-12" width="72" height="72" fill="#fff" />
        <path
          d="M8.5 20 21 29.5 33.5 20"
          fill="none"
          stroke="#000"
          stroke-width="2.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </mask>
      <path
        d="M18 6h20a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z"
        mask="url(#{id}-a)"
        fill="currentColor"
        opacity=".55"
      />
      <path
        d="M10 17h22a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V21a4 4 0 0 1 4-4z"
        mask="url(#{id}-b)"
        fill="currentColor"
      />
    </svg>
  {/if}
  {#if logo.isInit}
    <span class="initial" style:font-size={logo.fs}>{logo.text}</span>
  {/if}
  {#if logo.isIcon && icon}
    <!-- Size via CSS: container units are not valid everywhere as an SVG attribute -->
    <span class="glyph"><Icon name={icon} size="100%" /></span>
  {/if}
  {#if logo.isFill}
    <img class="fill" src={logo.src} alt="" draggable="false" />
  {/if}
  {#if logo.isPad}
    <img class="pad" src={logo.src} alt="" draggable="false" />
  {/if}
</div>

<style>
  .logo {
    width: 100%;
    height: 100%;
    container-type: size;
    display: grid;
    place-items: center;
  }

  svg {
    display: block;
    width: 64%;
    height: 64%;
    overflow: visible;
  }

  .glyph {
    display: grid;
    width: 56cqmin;
    height: 56cqmin;
  }

  .initial {
    font-family: var(--font-serif);
    line-height: 1;
    white-space: nowrap;
  }

  img {
    display: block;
  }

  .fill {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .pad {
    width: 72%;
    height: 72%;
    object-fit: contain;
  }
</style>
