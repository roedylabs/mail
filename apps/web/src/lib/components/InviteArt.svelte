<!--
  Background of the invitation page from 1000 px width: floating tiles that
  follow the pointer (the page's `--px`/`--py`). The large tile in the accent
  color shows the icon of the state (`PHASE_ICON`), the pill at the bottom
  right the inviter's initials; the page makes the tile shake on an error
  (`tile`). With `mail` the variant for the email address confirmation: this
  icon in the tile, an @ in the pill and the colors of the two tiles swapped.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import type { InvitePhase } from '#lib/invite.svelte.ts';

  let {
    phase = 'idle',
    initials = '',
    mail,
    tile = $bindable(),
  }: {
    phase?: InvitePhase;
    initials?: string;
    /** Icon of the email confirmation (`ti-mail`, `ti-mail-check`, `ti-link-off`, `ti-circle-check`, on an error that of the card). */
    mail?: IconName | undefined;
    tile?: HTMLElement | undefined;
  } = $props();

  const PHASE_ICON: Record<InvitePhase, IconName> = {
    idle: 'ti-mail-opened',
    name: 'ti-user',
    pw: 'ti-lock',
    peek: 'ti-eye',
    mfa: 'ti-shield-lock',
    backup: 'ti-lifebuoy',
    loading: 'ti-loader-2',
    error: 'ti-alert-circle',
    success: 'ti-user-check',
    expired: 'ti-clock-x',
    requested: 'ti-send',
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
          <span class="dot sage"></span>
          {@render lines(54, 36)}
        </div>
      </div>
    </div>
  </div>
  <div class="fl" style:left="16%" style:top="40%" style:--d="36">
    <div class="move">
      <div style:transform="rotate(18deg)">
        <div class="tile honey" style:width="50px" style:height="50px" style:animation-delay="1.6s"></div>
      </div>
    </div>
  </div>
  <div class="fl main" style:left="8%" style:top="62%" style:--d="14">
    <div class="move">
      <div style:transform="rotate(-5deg)">
        <div bind:this={tile}>
          <div class="tile phase" style:width="140px" style:height="140px" style:animation-delay="0s">
            {#key mail ?? phase}
              <span class="glyph" class:spin={!mail && phase === 'loading'}
                ><Icon name={mail ?? PHASE_ICON[phase]} /></span
              >
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
          <span class="dot {mail ? 'lilac' : 'sky'}"></span>
          {@render lines(54, 36)}
        </div>
      </div>
    </div>
  </div>
  <div class="fl" style:left="72%" style:top="70%" style:--d="32">
    <div class="move">
      <div style:transform="rotate(4deg)">
        <div class="tile row" style:width="226px" style:height="68px" style:animation-delay=".8s">
          {#if mail}
            <span class="avatar at"><Icon name="ti-at" /></span>
          {:else}
            <span class="avatar">{initials}</span>
          {/if}
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
    animation: inFloat 7s ease-in-out infinite;
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

  /* fixed color (honey) */
  .honey {
    border-radius: 16px;
    background: #f2c46b;
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
    animation: inPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .glyph.spin {
    animation: inSpin 900ms linear infinite;
  }

  .dot {
    width: 28px;
    height: 28px;
    border-radius: 10px;
  }

  /* fixed colors (sage, sky, lilac) */
  .sage {
    background: #94c48d;
  }

  .sky {
    border-radius: 50%;
    background: #82bbec;
  }

  .lilac {
    border-radius: 50%;
    background: #b0a2f2;
  }

  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #b0a2f2;
    color: #21134d;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
  }

  /* fixed colors (sky) */
  .avatar.at {
    background: #82bbec;
    color: #0b2a47;
    font-size: 18px;
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

  .col-lines {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  @keyframes inFloat {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-9px);
    }
  }

  @keyframes inPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes inSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
