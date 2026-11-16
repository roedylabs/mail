<!--
  Fix-tags dialog: tags that no longer match their mailboxes, per case with
  a primary and secondary action, loading state in the running button and a
  note below the actions. Values from `tagFixValues()` (#lib/tag-fix.ts).
  On desktop a dialog above the shell (Escape closes via the layout), on
  mobile only the content: the layout puts it in the level 2 sheet above
  the mailboxes sheet.
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import type { TagFixAction, TagFixValues } from '#lib/tag-fix.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends TagFixValues {
    isMobile: boolean;
    close: () => void;
    /** Click on the backdrop (desktop only). */
    overlay?: (event: MouseEvent) => void;
  }

  let { sub, groups, isMobile, close, overlay }: Props = $props();

  const uid = $props.id();
  let dialog: HTMLDivElement | undefined = $state();

  // On desktop focus into the dialog, on close back to where it was; on mobile the sheet takes over.
  $effect(() => {
    if (isMobile) return;
    const before = document.activeElement;
    dialog?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });

  // If a finished entry disappears with focus, it stays in the dialog instead of on `<body>`.
  $effect(() => {
    void groups;
    if (!isMobile && dialog && !dialog.contains(document.activeElement)) dialog.focus();
  });
</script>

{#snippet action(a: TagFixAction, primary: boolean, busy: boolean)}
  <!-- While an action of the entry runs, both are disabled (`dis`); the running one stays visible (`op`, `cur`). -->
  <button
    class="act"
    class:p={primary}
    class:s={!primary}
    class:spinning={a.spin}
    onclick={a.run}
    aria-disabled={busy}
    aria-busy={a.spin}
    aria-describedby={a.desc}
  >
    {#if a.spin}<span class="spin"><Icon name="ti-loader-2" /></span>{/if}
    <span>{a.label}</span>
  </button>
{/snippet}

{#snippet list()}
  <p class="intro">{m.tagfix_intro()}</p>
  {#each groups as g (g.key)}
    <div class="group">
      {#if g.head}
        <div class="g-head" style:margin-top={g.mt}>
          <span class="g-tile" style:background={g.aBg} style:color={g.aInk}>{g.letter}</span>
          <span class="g-email">{g.email}</span>
        </div>
      {/if}
      {#each g.items as it (it.key)}
        <div class="item" aria-busy={it.busy}>
          <span class="chip">
            {#if it.isTag}
              <span class="dot" style:background={it.dot}></span>
            {:else}
              <span class="folder"><Icon name="ti-folder" /></span>
            {/if}
            <span class="chip-text">{it.chip}</span>
          </span>
          <p class="text">{it.text}</p>
          <div class="acts" class:busy={it.busy}>
            {@render action(it.p, true, it.busy)}
            {#if it.s}{@render action(it.s, false, it.busy)}{/if}
          </div>
          {#if it.note}
            <p class="note" id={it.noteId}>{it.note}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
{/snippet}

{#if !isMobile}
  <div class="scrim" role="presentation" onmousedown={overlay}>
    <div
      bind:this={dialog}
      class="dialog"
      role="dialog"
      aria-modal="true"
      use:focustrap
      aria-labelledby="{uid}-t"
      tabindex="-1"
    >
      <div class="head">
        <span class="tile"><Icon name="ti-alert-triangle" /></span>
        <div class="head-text">
          <div id="{uid}-t" class="title">{m.tagfix_title()}</div>
          <div class="sub">{sub}</div>
        </div>
        <button class="close" aria-label={m.shell_close()} use:tooltip={m.shell_close()} onclick={close}
          ><Icon name="ti-x" /></button
        >
      </div>
      <div class="body">{@render list()}</div>
    </div>
  </div>
{:else}
  <div class="head m">
    <span class="tile"><Icon name="ti-alert-triangle" /></span>
    <div class="head-text">
      <div class="title">{m.tagfix_title()}</div>
      <div class="sub">{sub}</div>
    </div>
    <button class="close" aria-label={m.shell_close()} onclick={close}><Icon name="ti-x" /></button>
  </div>
  <div class="body m">{@render list()}</div>
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
    max-width: 520px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 32px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    outline: none;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 24px 18px 8px 26px;
  }

  .head.m {
    padding: 4px 2px 12px 8px;
  }

  .tile {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 16px;
    background: color-mix(in oklab, var(--warn) 17%, var(--pop));
    color: var(--warn);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 22px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 22px;
  }

  .m .title {
    font-size: 21px;
  }

  .sub {
    margin-top: 2px;
    font-size: 14px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m .close {
    width: 40px;
    height: 40px;
  }

  .m .close:hover {
    background: transparent;
    color: var(--mfg);
  }

  .m .close:active {
    background: var(--hov);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 12px 26px 26px;
  }

  .body.m {
    flex: none;
    min-height: auto;
    overflow: visible;
    gap: 14px;
    padding: 0 4px;
  }

  .intro {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m .intro {
    padding: 0 4px;
    font-size: 15px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .g-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 4px;
    color: var(--mfg);
  }

  .m .g-head {
    padding: 0 6px;
  }

  .g-tile {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 11px;
  }

  .m .g-tile {
    width: 22px;
    height: 22px;
    font-size: 12px;
  }

  .g-email {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 700;
  }

  .m .g-email {
    font-size: 13px;
  }

  .item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 14px 16px;
    border-radius: 22px;
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
  }

  .m .item {
    align-items: stretch;
    padding: 14px 14px 12px 16px;
    border-radius: 24px;
  }

  .chip {
    max-width: 100%;
    height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 10px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13.5px;
    font-weight: 800;
  }

  .m .chip {
    align-self: flex-start;
    height: 30px;
    font-size: 14px;
  }

  .dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 9999px;
  }

  .folder {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
    color: var(--mfg);
  }

  .m .folder {
    font-size: 16px;
  }

  .chip-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text {
    align-self: stretch;
    margin: 0;
    font-size: 14.5px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .m .text {
    font-size: 15px;
  }

  .acts {
    align-self: stretch;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .m .acts {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: stretch;
  }

  .acts.busy {
    pointer-events: none;
  }

  .act {
    height: 38px;
    display: flex;
    align-items: center;
    gap: 7px;
    border-radius: 9999px;
    font-size: 14px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      opacity var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .busy .act {
    cursor: default;
    opacity: 0.45;
  }

  .busy .act.spinning {
    cursor: progress;
    opacity: 1;
  }

  .act.p {
    padding: 0 18px;
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }

  .act.p:hover {
    transform: translateY(-1px);
  }

  .act.p:active {
    transform: scale(0.97);
  }

  .act.s {
    padding: 0 14px;
    font-weight: 700;
  }

  .act.s:hover {
    background: var(--hov);
  }

  .m .act {
    justify-content: center;
    gap: 8px;
    padding: 0 18px;
    font-size: 15px;
    transition:
      opacity var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .m .act.p {
    height: 48px;
  }

  .m .act.p:hover {
    transform: none;
  }

  .m .act.s {
    height: 46px;
  }

  .m .act.s:hover {
    background: transparent;
  }

  .m .act.p:active {
    transform: scale(0.97);
  }

  .m .act.s:active {
    background: var(--hov);
  }

  .spin {
    display: grid;
    font-size: 16px;
    animation: var(--spin, none);
  }

  .m .spin {
    font-size: 17px;
  }

  .note {
    align-self: stretch;
    margin: -2px 0 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m .note {
    margin: 0;
    padding: 0 2px;
    font-size: 13.5px;
    text-align: center;
  }
</style>
