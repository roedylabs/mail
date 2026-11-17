<!--
  Confirmation before an action (`ui.ask()`), on desktop as
  a dialog in the center, on mobile as a sheet from the bottom; optionally with
  a word that must be typed to confirm. Escape cancels (layout).
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { dialogDrag } from '#lib/dialog-drag.ts';
  import type { ConfirmDialogValues } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let {
    isMobile,
    cf,
    confirmIn,
    onConfirmIn,
    confirmKey,
    confirmOk,
    confirmCancel,
    onConfirmOverlay,
  }: ConfirmDialogValues = $props();

  const uid = $props.id();
  let dialog: HTMLDivElement | undefined = $state();

  // Focus into the word field or onto the button; on close back to where it was.
  $effect(() => {
    const before = document.activeElement;
    const target =
      dialog?.querySelector<HTMLElement>('[data-cf-focus]') ?? dialog?.querySelector<HTMLElement>('[data-cf-ok]');
    target?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

<div class="scrim" class:mobile={isMobile} role="presentation" onmousedown={onConfirmOverlay}>
  <div
    bind:this={dialog}
    class="dialog"
    role="alertdialog"
    aria-modal="true"
    use:focustrap
    {@attach dialogDrag(() => cf.hasCancel)}
    aria-labelledby="{uid}-t"
    aria-describedby="{uid}-d"
  >
    {#if isMobile}<span class="grip" aria-hidden="true"></span>{/if}
    <span class="tile" class:danger={cf.danger}><Icon name={cf.icon} /></span>
    <div id="{uid}-t" class="title">{cf.title}</div>
    <div id="{uid}-d" class="text">{cf.text}</div>
    {#if cf.hasWord}
      <label class="word">
        <span>{m.confirm_word({ word: cf.word })}</span>
        <input
          data-cf-focus="1"
          value={confirmIn}
          oninput={onConfirmIn}
          onkeydown={confirmKey}
          autocomplete="off"
          spellcheck="false"
          aria-label={m.confirm_word_label()}
        />
      </label>
    {/if}
    <div class="buttons">
      {#if cf.hasCancel}<button class="cancel" onclick={confirmCancel}>{m.confirm_cancel()}</button>{/if}
      <button
        data-cf-ok="1"
        class="ok"
        class:danger={cf.danger}
        class:disabled={cf.okDis}
        aria-disabled={cf.okDis}
        onclick={confirmOk}
      >
        {cf.ok}
      </button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 98;
    background: var(--scrim);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 24px;
    animation: snFade 180ms ease-out;
  }

  .scrim.mobile {
    backdrop-filter: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 0 8px 8px;
  }

  .dialog {
    position: relative;
    width: 100%;
    max-width: 440px;
    border-radius: 32px;
    background: var(--pop);
    box-shadow: var(--sh3);
    padding: 26px 24px 22px;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .dialog {
    max-width: none;
    border-radius: 30px;
    padding: 30px 14px 14px;
    animation: snSheet 340ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .grip {
    position: absolute;
    top: 10px;
    left: 50%;
    width: 40px;
    height: 5px;
    margin-left: -20px;
    border-radius: 9999px;
    background: var(--bdhi);
  }

  .tile {
    width: 52px;
    height: 52px;
    border-radius: 18px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 25px;
    transform: rotate(-6deg);
  }

  .tile.danger {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    color: var(--danger);
  }

  .mobile .tile {
    margin-left: 4px;
  }

  .title {
    margin-top: 18px;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 23px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .text {
    margin-top: 8px;
    font-size: 15px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .mobile .title,
  .mobile .text {
    padding: 0 4px;
  }

  .mobile .title {
    font-size: 22px;
  }

  .mobile .text {
    font-size: 14.5px;
  }

  .word {
    display: block;
    margin-top: 18px;
  }

  .word span {
    display: block;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .mobile .word span {
    padding: 0 4px;
  }

  .word input {
    display: block;
    width: 100%;
    margin-top: 8px;
    height: 52px;
    padding: 0 18px;
    border-radius: 18px;
    border: 1px solid var(--bd);
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.06em;
    outline: none;
    transition:
      border-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .mobile .word input {
    height: 56px;
    border-radius: 20px;
    font-size: 16px;
  }

  .word input:focus {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--accsoft);
  }

  .buttons {
    margin-top: 22px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .cancel,
  .ok {
    height: 46px;
    border-radius: 9999px;
    font-size: 15px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .cancel {
    padding: 0 20px;
    font-weight: 700;
  }

  .cancel:hover {
    background: var(--hov);
  }

  .ok {
    padding: 0 22px;
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
    white-space: nowrap;
  }

  .ok.danger {
    background: var(--danger);
    color: var(--surface);
  }

  .ok.disabled {
    background: var(--sunken);
    color: var(--dim);
    cursor: default;
  }

  .mobile .buttons {
    justify-content: stretch;
  }

  .mobile .cancel,
  .mobile .ok {
    flex: 1;
    height: 50px;
    padding: 0;
  }

  .mobile .cancel {
    background: var(--surface2);
  }

  .mobile .cancel:hover {
    background: var(--hov);
  }
</style>
