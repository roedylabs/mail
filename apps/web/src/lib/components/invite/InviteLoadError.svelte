<!--
  The invitation could not be loaded (500, or no answer at all): one centred
  column in a card of up to 520 px at every desktop width, centred in the
  panel on mobile. A muted tile on a soft ring (it is not the person's
  mistake), the heading, the text and "Try again", which loads again: the
  card stays and the button shows "Checking …" until the answer (it stays
  focusable, without the lift). "Try again" gets the focus on desktop; on
  mobile the focus stays where it is. No step bars.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import { INVITE_DESK, INVITE_FIT, INVITE_MOB } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { isMobileWidth, sharedLevel, stepLook, type Look } from '#lib/auth-layout.ts';
  import { ERRS } from '#lib/errors.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  const levels = (mobile: boolean): number => (mobile ? INVITE_MOB : INVITE_DESK).length;
  /** Texts of the error page: server error or no answer. */
  const page = $derived(ERRS[flow.offline ? 'offline' : '500']);
  const busy = $derived(flow.retrying);

  /** One column at every width (the step's levels, as the step would start), in a card of up to 520 px. */
  function lookOf(w: number, _two: boolean, level: number): Look {
    const look = stepLook(w, false, level, INVITE_DESK, INVITE_MOB);
    return look.mobile ? look : { ...look, cardMaxW: '520px' };
  }

  onMount(() => {
    if (isMobileWidth(ui.width)) return;
    void tick().then(() => targets.get('retry')?.focus({ preventScroll: true }));
  });

  function retry() {
    if (!busy) void flow.load();
  }
</script>

{#snippet content(look: Look)}
  <div class="fail" class:mobile={look.mobile} role="alert">
    <div class="ring" aria-hidden="true">
      <span class="halo"></span>
      <span class="tile"><Icon name={page.icon} /></span>
    </div>
    <h1 tabindex="-1" style:margin-top={look.gapL} style:font-size={look.h1} {@attach targets.reg('heading')}>
      {page.title()}
    </h1>
    <p style:margin={look.pm} style:font-size={look.pfs}>{page.text()}</p>
    <button
      type="button"
      class="retry"
      class:busy
      style:margin-top={look.gapL}
      style:height={look.ctl}
      aria-disabled={busy ? 'true' : 'false'}
      onclick={retry}
      {@attach targets.reg('retry')}
    >
      {#if busy}
        <span class="spin" aria-hidden="true"><Icon name="ti-loader-2" /></span><span>{m.invite_checking()}</span>
      {:else}
        <span class="bi" aria-hidden="true"><Icon name="ti-refresh" /></span><span>{m.error_retry()}</span>
      {/if}
    </button>
  </div>
{/snippet}

<AuthFrame
  docTitle={m.invite_title({ app: session.appName })}
  themeToggle
  {hidden}
  reg={targets.reg}
  {levels}
  columns
  start={(w: number, h: number, two: boolean) => sharedLevel(w, h, two, levels(isMobileWidth(w)), INVITE_FIT)}
  {lookOf}
  {content}
/>

<style>
  .fail {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0 4px;
    animation: ivPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* Mobile: centred in the panel */
  .fail.mobile {
    margin-block: auto;
    padding: 8px 0;
  }

  .ring {
    position: relative;
    width: 120px;
    height: 120px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .halo {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--surface2);
    opacity: 0.7;
  }

  .tile {
    position: relative;
    width: 74px;
    height: 74px;
    border-radius: 24px;
    display: grid;
    place-items: center;
    background: var(--surface2);
    color: var(--deep);
    box-shadow: var(--sh-edge), var(--sh1);
    font-size: 34px;
    rotate: -5deg;
  }

  .mobile .ring {
    width: 112px;
    height: 112px;
  }

  .mobile .tile {
    width: 68px;
    height: 68px;
    border-radius: 22px;
    font-size: 32px;
  }

  h1 {
    max-width: 100%;
    margin: 0;
    outline: none;
    font-family: var(--font-serif);
    font-weight: 400;
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  p {
    max-width: 380px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .retry {
    position: relative;
    width: 100%;
    max-width: 320px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--acc);
    color: var(--accink);
    font-size: 16px;
    font-weight: 800;
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 300ms;
  }

  .retry.busy {
    cursor: default;
  }

  .retry:not(.busy):active {
    transform: scale(0.98);
  }

  :global([data-input='mouse']) .retry:not(.busy):hover {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  /* The lifted button keeps its hit area down to where it was */
  :global([data-input='mouse']) .retry:not(.busy):hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
  }

  .bi {
    display: grid;
    font-size: 19px;
  }

  .spin {
    display: grid;
    font-size: 20px;
    animation: ivSpin 800ms linear infinite;
  }

  @keyframes ivPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes ivSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
