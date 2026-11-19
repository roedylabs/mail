<!--
  Colour editor for a custom accent ("More colors", `#lib/color-editor.svelte.ts`),
  shared by the setup wizard and Settings › Appearance. Desktop: a popover at
  the swatch that opened it (`anchor`), placed inside its positioned
  container. Mobile (`sheet`): a bottom sheet above the
  on-screen keyboard (visual viewport) that closes when dragged down.

  A radio group of 18 preset colours (arrows move and select through six
  columns, Home and End jump to the ends), a field for any hex code with a
  message line of fixed height (invalid input, barely visible in a theme),
  "Cancel" and "Apply". Escape closes, Tab stays inside, the editor takes the
  focus when it opens.
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { accentInk, type HexColor } from '#lib/color.ts';
  import {
    ColorDraft,
    PRESETS,
    gridMove,
    placePopover,
    presetLabel,
    type Placement,
  } from '#lib/color-editor.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { dragSheet } from '#lib/swipe.ts';

  interface Props {
    /** Colour the editor starts with. */
    start: HexColor;
    /** Swatch that opened the editor: the desktop popover sits at it (without one: in the middle). */
    anchor?: HTMLElement | undefined;
    /** Mobile: bottom sheet instead of the popover. */
    sheet?: boolean;
    onapply: (hex: HexColor) => void;
    onclose: () => void;
  }

  let { start, anchor, sheet = false, onapply, onclose }: Props = $props();

  const id = $props.id();
  // The editor keeps its own draft; a new `start` needs a new editor.
  const draft = new ColorDraft(untrack(() => start));

  let pop: HTMLDivElement | undefined = $state();
  let body: HTMLDivElement | undefined = $state();
  let scrim: HTMLDivElement | undefined = $state();
  let field: HTMLInputElement | undefined = $state();

  /** Desktop placement; hidden until it is known. */
  let place = $state<Placement | null>(null);
  /** Height of the on-screen keyboard (mobile). */
  let kb = $state(0);

  /** The first preset is the tab stop when the colour is none of them. */
  const hit = $derived(PRESETS.some(([, x]) => x === draft.hex));
  const ink = $derived(accentInk(draft.hex));
  const cancelLight = $derived(sheet || ui.dark);

  /** The positioned container the popover is placed in. */
  function container(): Element | null {
    return pop ? (pop.offsetParent ?? pop.parentElement) : null;
  }

  function measure() {
    if (sheet || !pop) return;
    const box = container();
    if (!box) return;
    const d = box.getBoundingClientRect();
    const b = anchor?.getBoundingClientRect();
    let natural = 0;
    for (const child of pop.children) {
      natural += child === body ? child.scrollHeight : (child as HTMLElement).offsetHeight;
    }
    const p = placePopover(
      { width: d.width, height: d.height },
      b ? { top: b.top - d.top, bottom: b.bottom - d.top, right: b.right - d.left } : null,
      natural,
    );
    const o = place;
    if (!o || o.left !== p.left || o.top !== p.top || o.width !== p.width || o.maxHeight !== p.maxHeight) place = p;
  }

  $effect(() => {
    if (sheet) return;
    measure();
    const box = container();
    const ro = typeof ResizeObserver === 'function' && box ? new ResizeObserver(() => measure()) : null;
    if (ro && box) ro.observe(box);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  });

  // Phone: the on-screen keyboard covers the bottom of the layout; the sheet moves above it.
  $effect(() => {
    const vv = sheet ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  });

  onMount(() => {
    void tick().then(() => pop?.focus({ preventScroll: true }));
  });

  function apply() {
    const hex = draft.apply();
    if (hex) onapply(hex);
    else field?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onclose();
  }

  function gridKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
    const i = radios.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const j = gridMove(e.key, i, radios.length);
    if (j === null) return;
    e.preventDefault();
    radios[j]?.focus();
    radios[j]?.click();
  }

  function hexKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    apply();
  }

  const popStyle = $derived(
    sheet
      ? `bottom: calc(8px + ${kb}px); max-height: calc(100% - 24px - ${kb}px)`
      : place
        ? `left: ${place.left}px; top: ${place.top}px; width: ${place.width}px; max-height: ${place.maxHeight}px; transform-origin: ${place.origin}`
        : 'left: 0; top: 0; width: 340px; visibility: hidden',
  );
</script>

<!-- Next to the editor, hence `data-scrim`: the focus trap keeps it clickable; dragging the sheet down closes via it. -->
<div bind:this={scrim} class="scrim" class:sheet data-scrim role="presentation" onmousedown={onclose}></div>
<div
  bind:this={pop}
  class="editor"
  class:sheet
  class:placed={!!place}
  role="dialog"
  aria-modal="true"
  aria-labelledby="{id}-title"
  tabindex="-1"
  style={popStyle}
  use:focustrap
  {@attach dragSheet(() => (sheet ? { animations: prefs.motion, scrim: scrim ?? null } : null))}
  {onkeydown}
>
  {#if sheet}<div class="grip" aria-hidden="true"><span></span></div>{/if}
  <div class="head">
    <h2 id="{id}-title">{m.color_editor_title()}</h2>
    <button type="button" class="close" aria-label={m.color_editor_close()} onclick={onclose}>
      <Icon name="ti-x" />
    </button>
  </div>
  <div bind:this={body} class="body">
    <div role="radiogroup" aria-label={m.color_editor_title()} class="grid" tabindex="-1" onkeydown={gridKey}>
      {#each PRESETS as [name, hex], i (name)}
        {@const on = hex === draft.hex}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={presetLabel(name)}
          tabindex={on || (!hit && i === 0) ? 0 : -1}
          class="sw"
          style:--sw={hex}
          style:--swink={accentInk(hex)}
          onclick={() => draft.pick(hex)}
        >
          <Icon name="ti-check" />
        </button>
      {/each}
    </div>
    <div class="hex">
      <label for="{id}-hex">{m.color_editor_hex()}</label>
      <div class="hex-ctl">
        <span class="hex-sw" aria-hidden="true" style:background={draft.hex}></span>
        <input
          bind:this={field}
          id="{id}-hex"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="7"
          class:bad={draft.note === 'invalid'}
          value={draft.text}
          oninput={(e) => draft.input(e.currentTarget.value)}
          onblur={() => draft.blur()}
          onkeydown={hexKey}
          aria-invalid={draft.note === 'invalid'}
          aria-describedby="{id}-msg"
        />
      </div>
      <!-- One line of fixed height, so the editor never changes size while typing. -->
      <span id="{id}-msg" class="msg" class:bad={draft.note === 'invalid'} aria-live="polite">
        {#if draft.note === 'invalid'}
          <span class="msg-icon"><Icon name="ti-alert-circle" /></span>
          <span class="msg-text">{m.color_editor_hex_invalid()}</span>
        {:else if draft.note}
          <span class="msg-icon warn"><Icon name="ti-alert-triangle" /></span>
          <span class="msg-text">{draft.note === 'dark' ? m.color_editor_low_dark() : m.color_editor_low_light()}</span>
        {/if}
      </span>
    </div>
  </div>
  <div class="btns">
    <button type="button" class="cancel lift press" class:light={cancelLight} onclick={onclose}>
      <span class="bi"><Icon name="ti-x" /></span><span>{m.color_editor_cancel()}</span>
    </button>
    <button
      type="button"
      class="apply lift press"
      class:off={!draft.valid}
      aria-disabled={!draft.valid}
      style:background={draft.hex}
      style:color={ink}
      onclick={apply}
    >
      <span class="bi"><Icon name="ti-check" /></span><span class="ell">{m.color_editor_apply()}</span>
    </button>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
  }

  .scrim.sheet {
    background: var(--scrim);
    animation: snFade 200ms ease-out;
  }

  .editor {
    position: absolute;
    z-index: 91;
    display: flex;
    flex-direction: column;
    border-radius: 24px;
    background: var(--pop);
    color: var(--fg);
    box-shadow: var(--sh3);
    outline: none;
  }

  .editor.placed:not(.sheet) {
    animation: suPop 240ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* Mobile: bottom sheet above the on-screen keyboard */
  .editor.sheet {
    left: 8px;
    right: 8px;
    /* Vertical: the content scrolls first, then the sheet follows the finger (`dragSheet`) */
    touch-action: pan-y;
    border-radius: 30px;
    overflow: hidden;
    transform-origin: 50% 0;
    transition:
      bottom 320ms cubic-bezier(0.2, 0.9, 0.25, 1),
      max-height 320ms cubic-bezier(0.2, 0.9, 0.25, 1);
    animation: snSheet 420ms cubic-bezier(0.2, 1.1, 0.3, 1);
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

  .head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 10px 0 20px;
  }

  .sheet .head {
    padding: 0 8px 0 18px;
  }

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 20px;
    line-height: 1.2;
  }

  .close {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .close:active {
    background: var(--hov);
  }

  /* The space between title and colours sits in the scrolling body, so the ring of the selected colour and the focus outline are never clipped. */
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px 20px 4px;
  }

  .body::-webkit-scrollbar {
    display: none;
  }

  .sheet .body {
    padding: 8px 16px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    outline: none;
  }

  .sw {
    position: relative;
    min-width: 0;
    aspect-ratio: 1;
    border-radius: 14px;
    background: var(--sw);
    color: var(--swink);
    /* fixed value (tile edge) */
    box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.08);
    display: grid;
    place-items: center;
    font-size: 18px;
    transition:
      transform 220ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms;
  }

  .sw :global(svg) {
    opacity: 0;
    transition: opacity 150ms;
  }

  .sw[aria-checked='true'] {
    box-shadow:
      0 0 0 3px var(--pop),
      0 0 0 5px var(--sw);
  }

  .sw[aria-checked='true'] :global(svg) {
    opacity: 1;
  }

  .sw:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 4px;
  }

  .hex {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .hex-ctl {
    position: relative;
    display: flex;
    align-items: center;
  }

  .hex-sw {
    position: absolute;
    left: 11px;
    width: 32px;
    height: 32px;
    border-radius: 11px;
    /* fixed value (colour edge) */
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
    transition: background-color 150ms;
  }

  input {
    width: 100%;
    height: 52px;
    border-radius: 18px;
    border: 1.5px solid var(--bdhi);
    outline: none;
    padding: 0 16px 0 54px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg);
    background: var(--surface);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms;
  }

  input.bad {
    border-color: var(--err);
  }

  input:focus {
    border-color: var(--deep);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .msg {
    min-height: 18px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    line-height: 18px;
    font-weight: 500;
    color: var(--mfg);
  }

  .msg.bad {
    font-weight: 600;
    color: var(--errfg);
  }

  .msg-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
  }

  .msg-icon.warn {
    color: var(--warn);
  }

  .msg-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Edges in line with the fields; "Cancel" as wide as its label, "Apply" the rest */
  .btns {
    flex-shrink: 0;
    display: flex;
    gap: 10px;
    padding: 16px 20px 20px;
  }

  .sheet .btns {
    padding: 12px 16px 16px;
  }

  .cancel,
  .apply {
    height: 48px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    font-size: 16px;
    font-weight: 800;
  }

  .sheet .cancel,
  .sheet .apply {
    height: 52px;
  }

  .cancel {
    flex: 0 0 auto;
    gap: 6px;
    padding: 0 22px 0 18px;
    background: var(--surface2);
    color: var(--fg);
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .cancel.light {
    background: var(--surface);
  }

  .apply {
    flex: 1 1 0;
    min-width: 0;
    gap: 8px;
    padding: 0 22px;
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 150ms,
      color 150ms,
      opacity 200ms;
  }

  .apply.off {
    opacity: 0.55;
    cursor: default;
  }

  .bi {
    display: grid;
    flex-shrink: 0;
    font-size: 19px;
  }

  .ell {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Hover only with a mouse, so a tapped button does not stay lifted */
  @media (hover: hover) and (pointer: fine) {
    .close:hover {
      background: var(--hov);
      color: var(--fg);
    }

    .sw:hover {
      transform: translateY(-2px);
    }

    .lift {
      position: relative;
    }

    .lift:hover {
      transform: translateY(-2px);
    }

    /* The lifted button keeps its hit area down to where it was. */
    .lift:hover::after {
      content: '';
      position: absolute;
      inset: 0 0 -2px;
      border-radius: inherit;
    }
  }

  /* Pressed (after the hover lift, so it wins while a mouse holds it down) */
  .grid .sw:active {
    transform: scale(0.92);
  }

  .btns .press:active {
    transform: scale(0.98);
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
</style>
