<!--
  Mobile sheet of the shell (`M_SHEETS`): one component for all content
  (navigation "More", account, notifications, apps …). Closes on a click on
  the backdrop, with Escape and when dragged down (`dragSheet`); the tab bar
  finds it via `data-sheet` when pulling "More" up (`pullSheet`). A second sheet
  (`level` 2, e.g. "Switch account" above "Mailboxes") lies above it; the first
  then moves back (`behind`, `mSh1T`) and leaves Escape to it.
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { dragSheet } from '#lib/swipe.ts';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Label of the dialog for screen readers. */
    label: string;
    onclose: () => void;
    children: Snippet;
    /** 2 = above another sheet (`mSwSheet`). */
    level?: 1 | 2;
    /** A level 2 sheet lies above. */
    behind?: boolean;
  }

  let { label, onclose, children, level = 1, behind = false }: Props = $props();

  let panel: HTMLDivElement | undefined = $state();
  let scrim: HTMLDivElement | undefined = $state();

  // Focus into the sheet, also back when the sheet above closes – unless the
  // focus trap has already put it back on the opener inside. Without scrolling:
  // a sheet pulled up from the tab bar still lies below the edge (`pullSheet`).
  $effect(() => {
    if (!behind && panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  });

  function onkeydown(event: KeyboardEvent) {
    // Already handled, e.g. by the layout for the level 2 sheet above.
    if (event.key === 'Escape' && !behind && !event.defaultPrevented) {
      event.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- Next to the panel, hence `data-scrim`: the focus trap keeps it clickable. -->
<div bind:this={scrim} class="scrim" class:top={level === 2} role="presentation" data-scrim onmousedown={onclose}></div>
<!-- Behind a level 2 sheet neither operable nor visible to screen readers. -->
<div
  class="sheet"
  class:top={level === 2}
  class:behind
  inert={behind}
  role="dialog"
  aria-modal="true"
  data-sheet={level}
  use:focustrap
  {@attach dragSheet(() => ({ animations: prefs.motion, scrim: scrim ?? null }))}
  aria-label={label}
  tabindex="-1"
  bind:this={panel}
>
  <div class="grip"><span></span></div>
  <div class="body no-scrollbar">
    {@render children()}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
    background: var(--scrim);
    animation: snFade 200ms ease-out;
  }

  .scrim.top {
    z-index: 92;
  }

  .sheet {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 91;
    touch-action: pan-y;
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    transform-origin: 50% 0;
    outline: none;
    transition: transform 460ms cubic-bezier(0.2, 1.1, 0.3, 1);
    animation: snSheet 420ms cubic-bezier(0.2, 1.1, 0.3, 1);
  }

  .sheet.top {
    z-index: 93;
    max-height: calc(100% - 120px);
  }

  .sheet.behind {
    transform: translateY(-10px) scale(0.93);
  }

  .grip {
    height: 28px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    touch-action: none;
  }

  .grip span {
    width: 40px;
    height: 5px;
    border-radius: 9999px;
    background: var(--bdhi);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 12px 14px;
  }
</style>
