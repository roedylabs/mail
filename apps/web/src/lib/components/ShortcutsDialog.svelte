<!--
  List of the keyboard shortcuts (`?`, desktop only). Escape, "Close" and a
  click on the backdrop close it.
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { dialogDrag } from '#lib/dialog-drag.ts';
  import type { ShortcutsDialogValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { shortcuts, closeHelp, onHelpOverlay }: ShortcutsDialogValues = $props();

  let dialog: HTMLDivElement | undefined = $state();

  $effect(() => {
    const before = document.activeElement;
    dialog?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

<div class="scrim" role="presentation" onmousedown={onHelpOverlay}>
  <div
    bind:this={dialog}
    class="dialog"
    role="dialog"
    aria-modal="true"
    use:focustrap
    {@attach dialogDrag()}
    aria-label={m.shortcuts_title()}
    tabindex="-1"
  >
    <div class="head">
      <span class="title">{m.shortcuts_title()}</span>
      <button class="close" onclick={closeHelp} aria-label={m.shell_close()} use:tooltip={m.shell_close()}>
        <Icon name="ti-x" />
      </button>
    </div>
    <!-- Scroll area: reachable via Tab, so that arrow keys and scrolling move it, and named. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="list" role="region" aria-label={m.shortcuts_title()} tabindex="0">
      {#each shortcuts as s (s.d)}
        <div class="row">
          <span class="d">{s.d}</span>
          <span class="keys">
            {#each s.keys as x, i (i)}<kbd>{x.k}</kbd>{/each}
          </span>
        </div>
      {/each}
    </div>
  </div>
</div>

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
    animation: snFade 180ms ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 480px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    outline: none;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 22px 16px 10px 26px;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 22px;
  }

  .close {
    width: 38px;
    height: 38px;
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

  .list {
    min-height: 0;
    overflow-y: auto;
    padding: 4px 12px 16px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 10px 14px;
    border-radius: 16px;
  }

  .row:hover {
    background: var(--surface2);
  }

  .d {
    font-size: 15px;
    font-weight: 600;
  }

  .keys {
    display: flex;
    gap: 5px;
  }

  kbd {
    min-width: 30px;
    height: 30px;
    padding: 0 9px;
    border-radius: 10px;
    background: var(--surface2);
    box-shadow: 0 2px 0 var(--bdhi);
    display: grid;
    place-items: center;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 800;
  }
</style>
