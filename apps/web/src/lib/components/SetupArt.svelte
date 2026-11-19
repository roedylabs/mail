<!--
  Background of the setup page from 1000 px width: floating tiles that follow
  the pointer (the page's `--px`/`--py`), in the large tile the icon of the
  state (`PHASE_ICON`). The page makes the tile (`tile`) shake on an error.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import type { Phase } from '#lib/setup.svelte.ts';

  let { phase, tile = $bindable() }: { phase: Phase; tile?: HTMLElement | undefined } = $props();

  const PHASE_ICON: Record<Phase, IconName> = {
    token: 'ti-key',
    admin: 'ti-user-shield',
    password: 'ti-lock',
    review: 'ti-list-check',
    loading: 'ti-loader-2',
    error: 'ti-alert-circle',
    locked: 'ti-lock',
    success: 'ti-rocket',
  };
</script>

{#snippet lines(a: number, b: number)}
  <span class="line" style:width="{a}px"></span>
  <span class="line dim" style:width="{b}px"></span>
{/snippet}

<div class="art" aria-hidden="true">
  <div class="fl" style:left="7%" style:top="14%" style:--d="26">
    <div class="move">
      <div style:transform="rotate(-12deg)">
        <div class="tile col" style:width="120px" style:height="120px" style:animation-delay=".4s">
          <span class="dot"><Icon name="ti-terminal-2" /></span>
          {@render lines(54, 36)}
        </div>
      </div>
    </div>
  </div>
  <div class="fl" style:left="16%" style:top="40%" style:--d="36">
    <div class="move">
      <div style:transform="rotate(18deg)">
        <div class="tile green" style:width="50px" style:height="50px" style:animation-delay="1.6s"></div>
      </div>
    </div>
  </div>
  <div class="fl main" style:left="8%" style:top="62%" style:--d="14">
    <div class="move">
      <div style:transform="rotate(-5deg)">
        <div bind:this={tile}>
          <div class="tile phase" style:width="140px" style:height="140px" style:animation-delay="0s">
            {#key phase}
              <span class="glyph" class:spin={phase === 'loading'}><Icon name={PHASE_ICON[phase]} /></span>
            {/key}
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="fl" style:left="82%" style:top="16%" style:--d="24">
    <div class="move">
      <div style:transform="rotate(10deg)">
        <div class="tile col" style:width="112px" style:height="112px" style:animation-delay="1.2s">
          <span class="dot"><Icon name="ti-server" /></span>
          {@render lines(54, 36)}
        </div>
      </div>
    </div>
  </div>
  <div class="fl" style:left="72%" style:top="70%" style:--d="32">
    <div class="move">
      <div style:transform="rotate(4deg)">
        <div class="tile row" style:width="226px" style:height="68px" style:animation-delay=".8s">
          <span class="docker"><Icon name="ti-brand-docker" /></span>
          <span class="col-lines">{@render lines(110, 70)}</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .art {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .fl {
    position: absolute;
    z-index: 0;
  }

  .fl.main {
    z-index: 2;
  }

  .move {
    transform: translate(calc(var(--px, 0) * var(--d) * 1px), calc(var(--py, 0) * var(--d) * 1px));
    transition: transform 900ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .tile {
    border-radius: 28px;
    background: var(--surface);
    box-shadow: var(--sh2);
    display: flex;
    justify-content: center;
    align-items: center;
    transition: background-color 300ms;
    animation: suFloat 7s ease-in-out infinite;
  }

  .col {
    flex-direction: column;
    gap: 9px;
  }

  .row {
    flex-direction: row;
    gap: 12px;
    padding: 0 18px;
    border-radius: 9999px;
  }

  /* fixed color (sage) */
  .green {
    border-radius: 16px;
    background: #94c48d;
    box-shadow: var(--sh1);
  }

  .phase {
    border-radius: 40px;
    background: var(--acc);
    color: var(--accink);
    /* fixed value (edge of the tile) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh3);
  }

  .glyph {
    display: grid;
    font-size: 66px;
    line-height: 1;
    animation: suPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .glyph.spin {
    animation: suSpin 900ms linear infinite;
  }

  .dot {
    width: 30px;
    height: 30px;
    border-radius: 10px;
    background: var(--surface2);
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .line {
    height: 8px;
    border-radius: 4px;
    background: var(--bdhi);
    flex-shrink: 0;
  }

  .line.dim {
    opacity: 0.7;
  }

  /* fixed colors (sky) */
  .docker {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #82bbec;
    color: #0b2a47;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .col-lines {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  @keyframes suFloat {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-9px);
    }
  }

  @keyframes suPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes suSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
