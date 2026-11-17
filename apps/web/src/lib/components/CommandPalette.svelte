<!--
  Command palette (Cmd+K or Ctrl+K or a typed character, desktop only):
  search commands, choose with the arrow keys, run with Enter. Escape and a
  click on the backdrop close it (layout).
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { focustrap } from '#lib/actions/focustrap.ts';
  import type { CommandPaletteValues } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { palQ, palRows, palEmpty, onPalQ, onPalKey, onPalOverlay }: CommandPaletteValues = $props();

  let input: HTMLInputElement | undefined = $state();

  // Focus into the search field, cursor to the end (a typed character is already in it); back on close.
  $effect(() => {
    const before = document.activeElement;
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

<div class="scrim" role="presentation" onmousedown={onPalOverlay}>
  <div class="dialog" role="dialog" aria-modal="true" use:focustrap aria-label={m.palette_label()}>
    <div class="head">
      <span class="spark"><Icon name="ti-sparkles" /></span>
      <input
        bind:this={input}
        value={palQ}
        oninput={onPalQ}
        onkeydown={onPalKey}
        placeholder={m.palette_placeholder()}
        aria-label={m.palette_label()}
      />
      <span class="esc">{m.shortcuts_key_esc()}</span>
    </div>
    <div class="rows no-scrollbar" {@attach scrollbar}>
      {#each palRows as r, i (i)}
        <div>
          {#if r.hasHdr}<div class="group">{r.g}</div>{/if}
          <button class="row" class:sel={r.sel} onclick={r.run} onmousemove={r.hover}>
            <span class="tile"><Icon name={r.icon} /></span>
            <span class="label">{r.label}</span>
            {#if r.hasKey}<span class="key">{r.k}</span>{/if}
          </button>
        </div>
      {/each}
      {#if palEmpty}<div class="empty">{m.palette_empty()}</div>{/if}
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
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 96px 24px 24px;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 620px;
    max-height: min(540px, 80%);
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 18px 0 22px;
    height: 68px;
    flex-shrink: 0;
  }

  .spark {
    display: grid;
    font-size: 22px;
    color: var(--deep);
  }

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 18px;
    font-weight: 600;
  }

  .esc {
    height: 28px;
    padding: 0 10px;
    border-radius: 9px;
    background: var(--surface2);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
  }

  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 10px 10px;
  }

  .group {
    padding: 12px 14px 6px;
    font-family: var(--font-serif);
    font-size: 14px;
    color: var(--mfg);
  }

  .row {
    width: 100%;
    height: 50px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 8px;
    border-radius: 17px;
    text-align: left;
    font-size: 15px;
    font-weight: 600;
  }

  .row.sel {
    background: var(--surface2);
  }

  .tile {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    background: var(--surface2);
    color: var(--mfg);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    font-size: 18px;
    transition:
      transform 220ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 150ms;
  }

  .sel .tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .key {
    min-width: 28px;
    height: 28px;
    padding: 0 8px;
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 2px 0 var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
  }

  .empty {
    padding: 40px 16px;
    text-align: center;
    font-size: 15px;
    color: var(--mfg);
  }
</style>
