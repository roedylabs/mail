<!--
  "No connection" of the setup wizard (`Reconnect`): the screen behind blurs
  softly, the message sits centred in front of it and covers everything, so
  nothing behind it takes input. Calm, not alarming: a neutral tile inside a
  ring that runs empty towards the next attempt and spins while checking; a
  chip says nothing entered is lost; "Try now" attempts at once. The focus
  moves to the button and Tab stays on it; closing puts it back.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import type { Reconnect } from '#lib/no-connection.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { waitText } from '#lib/wait.ts';

  let { net, box = $bindable() }: { net: Reconnect; box?: HTMLDivElement | undefined } = $props();

  let button: HTMLButtonElement | undefined = $state();

  /** Circumference of the ring (r = 42). */
  const C = 2 * Math.PI * 42;
  const busy = $derived(net.busy);
  const dash = $derived(busy ? `${(C * 0.22).toFixed(1)} ${C.toFixed(1)}` : `${C.toFixed(1)} ${C.toFixed(1)}`);
  const dashOff = $derived(busy ? '0' : (C * (1 - net.left / net.total)).toFixed(1));
  const ringTr = $derived(busy || net.left >= net.total || !prefs.motion ? 'none' : 'stroke-dashoffset 1s linear');
  const status = $derived(busy ? m.setup_net_checking() : m.setup_net_next({ time: waitText(Math.max(1, net.left)) }));

  onMount(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => button?.focus({ preventScroll: true }));
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  });

  /** Keys never reach the step behind it (its Enter); Tab stays on "Try now". */
  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      button?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the layer only keeps the keys and the focus inside) -->
<div class="layer" onkeydown={onKey}>
  <div
    bind:this={box}
    class="box"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="su-net-t"
    aria-describedby="su-net-d"
  >
    <div class="ring" aria-hidden="true">
      <svg viewBox="0 0 96 96" width="96" height="96" class:spin={busy}>
        <circle cx="48" cy="48" r="42" class="track"></circle>
        <circle
          cx="48"
          cy="48"
          r="42"
          transform="rotate(-90 48 48)"
          class="arc"
          stroke-dasharray={dash}
          stroke-dashoffset={dashOff}
          style:transition={ringTr}
        ></circle>
      </svg>
      <span class="tile"><Icon name="ti-wifi-off" /></span>
    </div>
    <h2 id="su-net-t">{m.setup_net_title()}</h2>
    <p id="su-net-d">{m.setup_net_text()} <span class="sr-only">{m.setup_net_kept()}</span></p>
    <span class="kept" aria-hidden="true"><Icon name="ti-circle-check" />{m.setup_net_kept()}</span>
    <span class="status">{status}</span>
    <button
      bind:this={button}
      type="button"
      class="retry"
      aria-disabled={busy ? 'true' : 'false'}
      aria-busy={busy ? 'true' : 'false'}
      onclick={() => void net.attempt(true)}
    >
      <span class="bi"><Icon name="ti-refresh" /></span><span>{m.setup_net_retry()}</span>
    </button>
  </div>
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: color-mix(in oklab, var(--cnv) 30%, transparent);
    -webkit-backdrop-filter: blur(5px);
    backdrop-filter: blur(5px);
    animation: suFade 280ms ease-out;
  }

  .box {
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 30px 26px 22px;
    border-radius: 32px;
    background: var(--surface);
    color: var(--fg);
    font-family: var(--font-sans);
    box-shadow: var(--sh3);
    animation: suPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .ring {
    position: relative;
    width: 96px;
    height: 96px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  svg {
    position: absolute;
    inset: 0;
    overflow: visible;
  }

  svg.spin {
    animation: suSpin 900ms linear infinite;
  }

  .track {
    fill: none;
    stroke: var(--sunken);
    stroke-width: 5;
  }

  .arc {
    fill: none;
    stroke: var(--acc);
    stroke-width: 5;
    stroke-linecap: round;
  }

  .tile {
    width: 60px;
    height: 60px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    background: var(--surface2);
    color: var(--fg);
    font-size: 28px;
    transform: rotate(-6deg);
    box-shadow: var(--sh-edge), var(--sh1);
  }

  h2 {
    margin: 16px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 26px;
    line-height: 1.15;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  p {
    margin: 6px 0 0;
    font-size: 15px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .kept {
    margin-top: 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px 5px 8px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 13px;
    font-weight: 800;
    line-height: 1.3;
  }

  .kept :global(svg) {
    font-size: 16px;
  }

  .status {
    margin-top: 22px;
    min-height: 18px;
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
  }

  .retry {
    margin-top: 12px;
    width: 100%;
    height: 52px;
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
      background-color 300ms,
      opacity 220ms;
  }

  .retry[aria-busy='true'] {
    opacity: 0.6;
    cursor: default;
  }

  @media (hover: hover) and (pointer: fine) {
    .retry:not([aria-busy='true']):hover {
      transform: translateY(-2px);
      box-shadow:
        inset 0 -3px 0 rgba(0, 0, 0, 0.08),
        var(--sh2);
    }
  }

  .retry:not([aria-busy='true']):active {
    transform: scale(0.98);
  }

  .bi {
    display: grid;
    font-size: 19px;
  }

  @keyframes suFade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
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
