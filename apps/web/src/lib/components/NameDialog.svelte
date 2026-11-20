<!--
  Name dialog: name and location of a folder or of a tag with a color
  (`nameIsTag`, `nameSw`). Values from `folders.values()`
  (#lib/state/folders.svelte.ts); the style values (button opacity, picker
  group, `namePickOpts[].bg` …) follow here from `nameOk`, `namePickOpen`,
  `on` and `depth`. On desktop a dialog above the shell (Escape closes via
  the layout), on mobile only the content: the layout puts it in a sheet.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { dialogDrag } from '#lib/dialog-drag.ts';
  import { tick } from 'svelte';
  import type { NameDialogValues } from '#lib/state/folders.svelte.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends NameDialogValues {
    isMobile: boolean;
    /** Click on the backdrop (desktop only). */
    overlay?: (event: MouseEvent) => void;
  }

  let {
    nameIsTag,
    nameTitle,
    nameSub,
    nameIcon,
    nameTileBg,
    nameTileInk,
    nameVal,
    namePh,
    nameBtnLabel,
    nameOk,
    namePickOpts,
    namePickLabel,
    namePickIcon,
    namePickOpen,
    nameSw,
    namePickToggle,
    onNameInput,
    nameCommit,
    nameClose,
    isMobile,
    overlay,
  }: Props = $props();

  type FieldEvent = Event & { currentTarget: HTMLInputElement };

  const uid = $props.id();
  let field: HTMLInputElement | undefined = $state();

  // Focus into the name field, on desktop back to where it was on close.
  // On mobile the sheet focuses itself afterwards; so the field comes only after that pass.
  $effect(() => {
    const before = document.activeElement;
    if (isMobile) void tick().then(() => field?.focus());
    else field?.focus();
    return () => {
      if (!isMobile && before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });

  // Enter in the field confirms, not during IME composition.
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    nameCommit();
  }

  // Disabled without a name; not triggerable via keyboard either.
  function commit() {
    if (nameOk) nameCommit();
  }
</script>

{#snippet head()}
  <div class="head" class:m={isMobile}>
    <span class="tile" style:background={nameTileBg} style:color={nameTileInk}><Icon name={nameIcon} /></span>
    <div class="head-text">
      <div id="{uid}-t" class="title">{nameTitle}</div>
      <div class="sub">{nameSub}</div>
    </div>
    <button
      class="close"
      aria-label={m.shell_close()}
      use:tooltip={isMobile ? undefined : m.shell_close()}
      onclick={nameClose}><Icon name="ti-x" /></button
    >
  </div>
{/snippet}

{#snippet input()}
  <input
    bind:this={field}
    class="inp"
    class:m={isMobile}
    value={nameVal}
    oninput={(e: FieldEvent) => onNameInput(e.currentTarget.value)}
    {onkeydown}
    placeholder={namePh}
    maxlength="40"
    autocomplete="off"
    enterkeyhint={isMobile ? 'done' : undefined}
    aria-label={isMobile ? m.name_label() : undefined}
  />
{/snippet}

{#snippet picker()}
  <div class="pick" class:m={isMobile}>
    <button
      class="pick-btn"
      onclick={namePickToggle}
      aria-expanded={namePickOpen}
      aria-controls="{uid}-l"
      aria-labelledby="{uid}-pl {uid}-pv"
    >
      <span class="pick-ic"><Icon name={namePickIcon} /></span>
      {#if isMobile}
        <span class="pick-text">
          <span id="{uid}-pl" class="pick-lbl">{m.name_place()}</span>
          <span id="{uid}-pv" class="pick-val">{namePickLabel}</span>
        </span>
      {:else}
        <span id="{uid}-pv" class="pick-val">{namePickLabel}</span>
      {/if}
      <span class="chev" class:open={namePickOpen}><Icon name="ti-chevron-down" /></span>
    </button>
    <!-- When collapsed, the entries stay in the DOM for the animation, but outside the tab order. -->
    <div class="fold" class:open={namePickOpen} inert={!namePickOpen}>
      <div class="fold-in">
        <div id="{uid}-l" class="opts" class:no-scrollbar={isMobile} role="listbox" aria-label={m.name_place()}>
          {#each namePickOpts as o (o.key)}
            <button
              class="opt"
              class:on={o.on}
              role="option"
              aria-selected={o.on}
              onclick={o.onClick}
              style:padding-left="{12 + o.depth * 22}px"
            >
              {#if o.dot}
                <span class="o-dot" style:color={o.dot}><Icon name="ti-tag" /></span>
              {:else}
                <span class="o-ic"><Icon name={o.icon} /></span>
              {/if}
              <span class="o-label">{o.label}</span>
              <span class="o-ck"><Icon name="ti-check" /></span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/snippet}

{#snippet swatches()}
  <div class="sws" class:m={isMobile} role="radiogroup" use:radiogroup aria-label={m.name_color()}>
    {#each nameSw as c (c.label)}
      <button
        class="sw"
        class:on={c.on}
        role="radio"
        aria-checked={c.on}
        aria-label={c.label}
        use:tooltip={isMobile ? undefined : c.label}
        onclick={c.onClick}
        style:--sw={c.bg}
        style:color={c.ink}><span class="sw-ck"><Icon name="ti-check" /></span></button
      >
    {/each}
  </div>
{/snippet}

{#snippet foot()}
  <div class="foot" class:m={isMobile}>
    <button class="cancel" onclick={nameClose}>{m.name_cancel()}</button>
    <button class="ok" class:off={!nameOk} aria-disabled={!nameOk} onclick={commit}>{nameBtnLabel}</button>
  </div>
{/snippet}

{#if !isMobile}
  <div class="scrim" role="presentation" onmousedown={overlay}>
    <div class="dialog" role="dialog" aria-modal="true" use:focustrap {@attach dialogDrag()} aria-labelledby="{uid}-t">
      {@render head()}
      <div class="body">
        <label class="field">
          <span class="lbl">{m.name_label()}</span>
          {@render input()}
        </label>
        <div class="field">
          <span id="{uid}-pl" class="lbl">{m.name_place()}</span>
          {@render picker()}
        </div>
        {#if nameIsTag}
          <div class="field colors">
            <span class="lbl">{m.name_color()}</span>
            {@render swatches()}
          </div>
        {/if}
      </div>
      {@render foot()}
    </div>
  </div>
{:else}
  {@render head()}
  <div class="body m">
    {@render input()}
    {@render picker()}
    {#if nameIsTag}{@render swatches()}{/if}
  </div>
  {@render foot()}
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
    max-height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 32px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* Head */

  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 24px 18px 8px 26px;
  }

  .head.m {
    padding: 4px 2px 14px 8px;
  }

  .tile {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 16px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 22px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
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

  .dialog .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m .close {
    width: 40px;
    height: 40px;
  }

  .m .close:active {
    background: var(--hov);
  }

  /* Content */

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 16px 26px 22px;
  }

  .body.m {
    flex: none;
    min-height: auto;
    overflow: visible;
    padding: 0 4px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field.colors {
    gap: 10px;
  }

  .lbl {
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .inp {
    height: 52px;
    padding: 0 18px;
    border-radius: 18px;
    border: 1px solid var(--bd);
    background: var(--surface);
    box-shadow: var(--sh1);
    outline: none;
    font-size: 16px;
    font-weight: 700;
    transition:
      border-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .inp.m {
    height: 56px;
    border-radius: 20px;
    font-size: 17px;
  }

  .inp:focus-visible {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--accsoft);
  }

  /* Picker "Location" */

  .pick {
    border-radius: 18px;
    border: 1px solid var(--bd);
    background: var(--surface);
    box-shadow: var(--sh1);
    overflow: hidden;
  }

  .pick.m {
    border-radius: 20px;
  }

  .pick-btn {
    width: 100%;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px 0 12px;
    text-align: left;
    font-size: 15px;
    font-weight: 700;
  }

  .dialog .pick-btn:hover {
    background: var(--hov);
  }

  .m .pick-btn {
    height: 60px;
    font-size: inherit;
    font-weight: inherit;
  }

  .m .pick-btn:active {
    background: var(--hov);
  }

  .pick-ic {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--surface2);
    color: var(--mfg);
    font-size: 16px;
  }

  .m .pick-ic {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    font-size: 18px;
  }

  .pick-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .pick-lbl {
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
  }

  .pick-val {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m .pick-val {
    font-size: 15.5px;
    font-weight: 700;
  }

  .chev {
    display: grid;
    font-size: 17px;
    color: var(--mfg);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .m .chev {
    font-size: 18px;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .fold {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .fold.open {
    grid-template-rows: 1fr;
  }

  .fold-in {
    min-height: 0;
    overflow: hidden;
  }

  .opts {
    max-height: min(236px, 32vh);
    overflow-y: auto;
    overscroll-behavior: contain;
    border-top: 1px solid var(--bd);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .m .opts {
    max-height: 260px;
  }

  .opt {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 12px;
    border-radius: 12px;
    background: transparent;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
  }

  .opt.on {
    background: var(--accsoft);
    font-weight: 800;
  }

  .dialog .opt:hover {
    background: var(--hov);
  }

  .dialog .opt.on:hover {
    background: var(--accsoft);
  }

  .m .opt {
    height: 46px;
    gap: 11px;
    border-radius: 14px;
    font-size: 15px;
  }

  .m .opt:active {
    background: var(--hov);
  }

  .o-ic {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    color: var(--mfg);
  }

  .m .o-ic {
    font-size: 18px;
  }

  .o-dot {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
  }

  .o-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .o-ck {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
    color: var(--deep);
    opacity: 0;
  }

  .m .o-ck {
    font-size: 17px;
  }

  .opt.on .o-ck {
    opacity: 1;
  }

  /* Color (tags) */

  .sws {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .sws.m {
    flex-wrap: nowrap;
    justify-content: space-between;
    gap: 6px;
    padding: 0 4px;
  }

  .sw {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--sw);
    font-size: 18px;
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .m .sw {
    width: 44px;
    height: 44px;
    font-size: 20px;
  }

  .sw.on {
    box-shadow:
      0 0 0 3px var(--pop),
      0 0 0 5px var(--sw);
    transform: scale(1.06);
  }

  .sw:active,
  .sw.on:active {
    transform: scale(0.9);
  }

  .sw-ck {
    display: grid;
    opacity: 0;
    transition: opacity var(--dur, 220ms);
  }

  .sw.on .sw-ck {
    opacity: 1;
  }

  /* Actions */

  .foot {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 26px 24px;
  }

  .foot.m {
    justify-content: normal;
    margin-top: 20px;
    padding: 0;
  }

  .cancel {
    height: 46px;
    padding: 0 20px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 700;
  }

  .dialog .cancel:hover {
    background: var(--hov);
  }

  .m .cancel {
    flex: 1;
    height: 52px;
    background: var(--surface2);
  }

  .ok {
    height: 46px;
    padding: 0 24px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 800;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition:
      opacity var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .dialog .ok:hover {
    transform: translateY(-2px);
  }

  .ok.off {
    opacity: 0.4;
    pointer-events: none;
  }

  .m .ok {
    flex: 1;
    height: 52px;
    transition: opacity var(--dur, 220ms);
  }
</style>
