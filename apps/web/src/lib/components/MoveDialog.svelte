<!--
  Move dialog: targets for moving the conversation, Inbox and the account's
  folder tree with check marks where the emails already are (those targets
  have no effect). Values `mvp` from `moveValues()` (`#lib/message-view.ts`).
  On desktop the component draws the backdrop and dialog above the shell (a
  click on the backdrop closes), on mobile only the content sits in the
  layout's sheet, from "More actions" with back (`mvp.hasBack`). Escape
  closes (layout).
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { MoveValues, ReadMoveOption } from '#lib/message-view.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { overlayClose } from '#lib/shell.ts';

  interface Props {
    mvp: MoveValues;
    isMobile: boolean;
    /**
     * Choose a target (`mvp.opts[].onClick`), also one in which the emails
     * already are (`aria-disabled`); the route skips those.
     */
    onPick: (opt: ReadMoveOption) => void;
    /** Close (`mvp.close`, on mobile `closeSheet`; on desktop also the backdrop, `mvp.overlay`). */
    onClose: () => void;
    /** Back to "More actions" (`mvp.back`, only with `mvp.hasBack`). */
    onBack: () => void;
    /**
     * On desktop focus the first selectable target; otherwise the dialog itself,
     * e.g. after the swipe gesture (touch), so that no focus ring appears (Tab
     * leads to the targets).
     */
    focusFirst?: boolean;
  }

  let { mvp, isMobile, onPick, onClose, onBack, focusFirst = true }: Props = $props();

  const uid = $props.id();
  const overlay = $derived(overlayClose(onClose));
  let list: HTMLDivElement | undefined = $state();
  let dialog: HTMLDivElement | undefined = $state();

  // On desktop to the first selectable target (or the dialog); on close back to where focus was.
  $effect(() => {
    const before = document.activeElement;
    if (!isMobile && !focusFirst) dialog?.focus();
    else if (!isMobile) {
      const items = list ? [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
      (items.find((el) => el.getAttribute('aria-disabled') !== 'true') ?? items[0])?.focus();
    }
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

{#snippet options(mobile: boolean)}
  {#each mvp.opts as o (o.id)}
    {#if o.sep}<div class="sep" class:m={mobile} role="separator"></div>{/if}
    <button
      role="menuitem"
      class="opt"
      class:m={mobile}
      aria-disabled={o.dis}
      style:padding-left={o.pl}
      style:color={o.color}
      style:cursor={o.cursor}
      onclick={() => onPick(o)}
      ><span class="o-i"><Icon name={o.icon} /></span><span class="o-l">{o.label}</span><span
        class="o-ck"
        style:opacity={o.ckOp}><Icon name="ti-check" /></span
      ></button
    >
  {/each}
{/snippet}

{#if !isMobile}
  <div class="scrim" role="presentation" onmousedown={overlay}>
    <div
      bind:this={dialog}
      class="dialog"
      data-pop="1"
      role="dialog"
      aria-modal="true"
      use:focustrap
      aria-labelledby="{uid}-t"
      tabindex="-1"
    >
      <div class="head">
        <div class="head-text">
          <div id="{uid}-t" class="title">{m.read_move_title()}</div>
          <div class="sub">{mvp.sub}</div>
        </div>
        <button class="close" aria-label={m.shell_close()} use:tooltip={m.read_source_close_tip()} onclick={onClose}
          ><Icon name="ti-x" /></button
        >
      </div>
      <div class="list" role="menu" aria-label={m.read_move_title()} bind:this={list}>
        {@render options(false)}
      </div>
    </div>
  </div>
{:else}
  <div class="m-head">
    {#if mvp.hasBack}
      <button class="m-btn back" aria-label={m.read_back()} onclick={onBack}><Icon name="ti-chevron-left" /></button>
    {/if}
    {#if mvp.noBack}<span class="m-gap"></span>{/if}
    <div class="m-title">{m.read_move_title()}</div>
    <button class="m-btn close-m" aria-label={m.shell_close()} onclick={onClose}><Icon name="ti-x" /></button>
  </div>
  <div class="m-list" role="menu" aria-label={m.read_move_title()}>
    {@render options(true)}
  </div>
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
    padding: 32px;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    outline: none;
    width: 100%;
    max-width: 420px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 22px 16px 12px 26px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
  }

  .sub {
    margin-top: 4px;
    font-size: 13.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 10px 14px;
  }

  .sep {
    height: 1px;
    margin: 6px 14px;
    background: var(--bd);
  }

  .sep.m {
    margin: 6px 16px;
  }

  /* Target: indent (`pl`), color and cursor from the values */
  .opt {
    width: 100%;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    border-radius: 15px;
    text-align: left;
    font-size: 15px;
    font-weight: 600;
    transition: background-color var(--dur, 220ms);
  }

  .opt:hover {
    background: var(--hov);
  }

  .opt.m {
    width: auto;
    height: auto;
    min-height: 52px;
    gap: 14px;
    padding-right: 16px;
    border-radius: 18px;
    font-size: 15.5px;
    transition: none;
  }

  .opt.m:hover {
    background: none;
  }

  .opt.m:active {
    background: var(--hov);
  }

  .o-i {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    color: var(--mfg);
  }

  .opt.m .o-i {
    font-size: 19px;
  }

  .o-l {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .o-ck {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    color: var(--deep);
  }

  .opt.m .o-ck {
    font-size: 18px;
  }

  /* Mobile in the sheet */
  .m-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px 10px 0;
  }

  .m-gap {
    width: 4px;
    flex-shrink: 0;
  }

  .m-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-serif);
    font-size: 20px;
  }

  .m-btn {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
  }

  .m-btn:active {
    background: var(--hov);
  }

  .back {
    font-size: 22px;
  }

  .close-m {
    font-size: 19px;
    color: var(--mfg);
  }

  .m-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
