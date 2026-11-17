<!--
  Set up push notifications on this device.
  States from `push.status` (ask, busy, denied, none, ios, active), values from
  `pushDialogValues()` in `#lib/push-dialog.ts`; actions go to the state
  module `push`, which also shows the toasts. The layout shows the dialog
  via `ui.pageDialog`: on desktop the component draws
  backdrop and dialog, on mobile the layout renders it in the sheet (then only
  the content). Escape closes (layout).
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { dialogDrag } from '#lib/dialog-drag.ts';
  import type { Snippet } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { mailPush } from '#lib/mail-push.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { pushDialogValues } from '#lib/push-dialog.ts';
  import { push } from '#lib/push.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  interface Props {
    mobile: boolean;
    onclose: () => void;
  }

  let { mobile, onclose }: Props = $props();

  const uid = $props.id();
  let dialog: HTMLDivElement | undefined = $state();

  const pu = $derived(
    pushDialogValues(
      { status: push.status, device: push.current?.device ?? null, appName: session.appName, host: location.host },
      {
        request: () => void push.request(),
        retry: () => push.retry(),
        test: () => void push.test(),
        off: () => {
          // New mails depend on this device's channel; the dialog does not wait for dead mail servers.
          void mailPush.pause();
          void push.off().then(onclose);
        },
        close: () => onclose(),
      },
    ),
  );

  // On desktop focus the dialog; on close back to where focus was.
  $effect(() => {
    const before = document.activeElement;
    if (!mobile) dialog?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

<!-- Desktop: secondary action left, main action right; mobile stacked, main action on top. -->
{#snippet pair(main: Snippet, side: Snippet)}
  {#if mobile}{@render main()}{@render side()}{:else}{@render side()}{@render main()}{/if}
{/snippet}

{#snippet later()}
  <button class="btn side" onclick={pu.close}>{m.push_later()}</button>
{/snippet}

{#snippet grant()}
  <button class="btn main acc" aria-busy={pu.isBusy} aria-disabled={pu.isBusy} onclick={pu.request}
    ><span class="btn-icon" class:spin={pu.isBusy}><Icon name={pu.btnIcon} /></span>{pu.btn}</button
  >
{/snippet}

{#snippet closeBtn()}
  <button class="btn side" onclick={pu.close}>{m.shell_close()}</button>
{/snippet}

{#snippet retry()}
  <button class="btn main ink ic" onclick={pu.retry}><Icon name="ti-refresh" />{m.push_recheck()}</button>
{/snippet}

{#snippet off()}
  <button class="btn side danger" onclick={pu.off}>{m.push_off()}</button>
{/snippet}

{#snippet test()}
  <button class="btn main ink ic test" onclick={pu.test}><Icon name="ti-send" />{m.push_test()}</button>
{/snippet}

{#snippet body()}
  <div class="content" class:m={mobile}>
    <div class="head">
      <span
        class="tile"
        class:danger={pu.tileTone === 'danger'}
        class:accent={pu.tileTone === 'accent'}
        class:soft={pu.tileTone === 'soft'}><Icon name={pu.icon} /></span
      >
      {#if mobile}
        <button class="close" aria-label={m.shell_close()} onclick={pu.close}><Icon name="ti-x" /></button>
      {:else}
        <button class="close" aria-label={m.shell_close()} use:tooltip={m.shell_close()} onclick={pu.close}
          ><Icon name="ti-x" /></button
        >
      {/if}
    </div>
    <div id="{uid}-t" class="title">{pu.title}</div>
    <div class="text">{pu.text}</div>
    {#if pu.hasSteps}
      <ol class="steps">
        {#each pu.steps as x (x.n)}
          <li><span class="num">{x.n}</span><span class="step">{x.x}</span></li>
        {/each}
      </ol>
    {/if}
    {#if pu.iosNote}
      <div class="ios"><Icon name="ti-device-mobile" /><span>{pu.iosText}</span></div>
    {/if}
  </div>
  <div class="foot" class:m={mobile}>
    {#if pu.canAsk}
      {@render pair(grant, later)}
    {:else if pu.isDenied}
      {@render pair(retry, closeBtn)}
    {:else if pu.isNone || pu.isIos}
      <button class="btn main ink" onclick={pu.close}>{m.push_understood()}</button>
    {:else if pu.isActive}
      {@render pair(test, off)}
    {/if}
  </div>
{/snippet}

{#if !mobile}
  <div class="scrim" role="presentation" onmousedown={pu.overlay}>
    <div
      bind:this={dialog}
      class="dialog"
      role="dialog"
      aria-modal="true"
      use:focustrap
      {@attach dialogDrag()}
      aria-labelledby="{uid}-t"
      tabindex="-1"
    >
      {@render body()}
    </div>
  </div>
{:else}
  {@render body()}
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
    background: var(--scrim);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 24px;
    overflow-y: auto;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 460px;
    border-radius: 32px;
    background: var(--pop);
    box-shadow: var(--sh3);
    padding: 26px 24px 22px;
    outline: none;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .content.m {
    padding: 6px 6px 0;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .tile {
    width: 56px;
    height: 56px;
    border-radius: 19px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 27px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .m .tile {
    width: 54px;
    height: 54px;
    border-radius: 18px;
    font-size: 26px;
    transition: none;
  }

  /* `pu.tileBg`/`pu.tileInk` */
  .tile.soft {
    background: var(--accsoft);
    color: var(--deep);
  }

  .tile.accent {
    background: var(--acc);
    color: var(--accink);
  }

  .tile.danger {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    color: var(--danger);
  }

  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    margin: -6px -6px 0 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m .close {
    width: 44px;
    height: 44px;
    margin: 0;
  }

  .m .close:hover {
    background: none;
    color: var(--mfg);
  }

  .m .close:active {
    background: var(--hov);
  }

  .title {
    margin-top: 18px;
    font-family: var(--font-serif);
    font-size: 23px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .m .title {
    margin-top: 16px;
    font-size: 22px;
  }

  .text {
    margin-top: 8px;
    font-size: 15px;
    line-height: 1.55;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m .text {
    font-size: 14.5px;
  }

  .steps {
    margin: 16px 0 0;
    padding: 6px;
    list-style: none;
    border-radius: 20px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .m .steps {
    margin-top: 14px;
    padding: 4px;
  }

  .steps li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 9px 12px 9px 8px;
  }

  .m .steps li {
    padding: 10px 10px 10px 8px;
  }

  .num {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
  }

  .step {
    padding-top: 2px;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .ios {
    margin-top: 16px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 18px;
    background: var(--surface2);
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
  }

  .ios :global(svg) {
    font-size: 18px;
    margin-top: 1px;
  }

  .ios span {
    text-wrap: pretty;
  }

  .m .ios {
    margin-top: 14px;
  }

  .foot {
    margin-top: 22px;
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }

  .foot.m {
    margin-top: 20px;
    flex-direction: column;
    flex-wrap: nowrap;
    justify-content: flex-start;
  }

  .btn {
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 9999px;
    font-size: 15px;
    white-space: nowrap;
  }

  .btn :global(svg) {
    display: block;
    font-size: 18px;
  }

  .btn.test :global(svg) {
    font-size: 17px;
  }

  .btn-icon {
    display: block;
  }

  /* Spins while the browser asks; without animations it stands still (`--spin: none`). */
  .btn-icon.spin {
    animation: var(--spin, none);
  }

  .side {
    padding: 0 20px;
    font-weight: 700;
  }

  .side.danger {
    padding: 0 18px;
    color: var(--danger);
  }

  .foot:not(.m) .side:hover {
    background: var(--hov);
  }

  .foot:not(.m) .side.danger:hover {
    background: color-mix(in oklab, var(--danger) 10%, transparent);
  }

  .main {
    padding: 0 22px;
    font-weight: 800;
  }

  .main.ic {
    padding: 0 20px 0 16px;
  }

  .main.ink {
    background: var(--ink);
    color: var(--inkfg);
  }

  .main.acc {
    padding: 0 22px 0 18px;
    background: var(--acc);
    color: var(--accink);
    /* fixed shadow */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
  }

  .main.acc[aria-busy='true'] {
    cursor: progress;
  }

  .m .btn {
    padding: 0;
  }

  .m .side {
    height: 48px;
  }

  .m .side:active {
    background: var(--hov);
  }

  .m .main {
    height: 52px;
    font-size: 15.5px;
  }

  .m .main.acc {
    box-shadow: none;
  }

  .m .btn :global(svg) {
    font-size: 19px;
  }

  .m .btn.test :global(svg) {
    font-size: 18px;
  }
</style>
