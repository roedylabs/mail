<!--
  Settings › Appearance: colour scheme, accent colour (five named ones and
  "More" for a custom colour from the shared colour editor; locked if the
  branding sets it), text and animation (font size, density, animations) and layout
  (sidebar only on desktop, message list) with section tabs. Values in
  `#lib/appearance.ts`; saved via `prefs.set()`, the sidebar is
  `ui.collapsed`. Card, ring and switch styles are classes, the fixed preview
  colours of the modes and accents come via `style:`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { appearanceValues, type AppearanceContext, type SegOption } from '#lib/appearance.ts';
  import type { HexColor } from '#lib/color.ts';
  import { customName, editorStart, presetOf } from '#lib/color-editor.svelte.ts';
  import AccentRing from '#lib/components/AccentRing.svelte';
  import ColorEditor from '#lib/components/ColorEditor.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const ctx: AppearanceContext = {
    set: (patch) => prefs.set(patch),
    setCollapsed: (collapsed) => {
      ui.collapsed = collapsed;
    },
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
  };
  const v = $derived(appearanceValues({ values: prefs.values, brand: session.branding, collapsed: ui.collapsed }, ctx));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/appearance'));

  // ---- Colour editor of the sixth accent tile ----

  let editing = $state(false);
  const more = $derived(v.accentMore);
  /**
   * Active custom accent: the preset's name, otherwise "Custom" with the code in the accessible name only
   * ("Custom #3A7BD5", which contains the visible text); without one "More".
   */
  const moreLabel = $derived(
    more.hex ? (presetOf(more.hex) ? customName(more.hex) : m.appearance_accent_custom()) : m.appearance_accent_more(),
  );
  const moreName = $derived(more.hex && !presetOf(more.hex) ? customName(more.hex) : undefined);
  let moreBtn: HTMLButtonElement | undefined = $state();

  /** Cancel, Escape, Close and Apply: the focus goes back to the tile. */
  function closeEditor() {
    editing = false;
    setTimeout(() => moreBtn?.focus({ preventScroll: true }), 0);
  }

  function applyMore(hex: HexColor) {
    more.apply(hex);
    closeEditor();
  }

  onMount(() => {
    // The layout shows it above the page: a popover at the tile (desktop) or its own bottom sheet (mobile).
    ui.pageDialog = () =>
      editing ? { title: m.color_editor_title(), close: closeEditor, content: editor, bare: true } : null;
    return () => {
      ui.pageDialog = null;
    };
  });
</script>

{#snippet editor(mobile: boolean)}
  <ColorEditor
    start={editorStart(more.accent)}
    anchor={moreBtn}
    sheet={mobile}
    onapply={applyMore}
    onclose={closeEditor}
  />
{/snippet}

{#snippet segment(label: string, opts: readonly SegOption<string>[])}
  <div role="radiogroup" use:radiogroup aria-label={label} class="seg">
    {#each opts as o (o.value)}
      <button type="button" role="radio" aria-checked={o.on} class:on={o.on} onclick={o.onClick}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet segRow(label: string, desc: string, opts: readonly SegOption<string>[])}
  <div class="row wrap">
    <div class="row-text">
      <div class="row-label">{label}</div>
      <div class="row-desc">{desc}</div>
    </div>
    {@render segment(label, opts)}
  </div>
{/snippet}

<div bind:this={root} class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <div class="tabs no-scrollbar">
    {#each v.tabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="mode" class="sec">
    <h2>{m.appearance_tab_mode()}</h2>
    <p class="sec-desc">{m.appearance_mode_desc()}</p>
    <div role="radiogroup" use:radiogroup aria-label={m.appearance_tab_mode()} class="modes">
      {#each v.modeCards as c (c.name)}
        <button type="button" role="radio" aria-checked={c.on} class="mode" class:on={c.on} onclick={c.onClick}>
          {#if !isMobile}
            <span class="prev" style:background={c.bg}>
              <span class="prev-side">
                <span class="bar-ink" style:background={c.inkc}></span>
                <span class="bar-acc"></span>
                <span class="bar-line w80" style:background={c.line}></span>
                <span class="bar-line w65" style:background={c.line}></span>
              </span>
              <span class="prev-panel" style:background={c.panel}>
                <span class="bar-head" style:background={c.line}></span>
                <span class="grow"></span>
                <span class="dot"></span>
                <span class="grow"></span>
              </span>
            </span>
          {:else}
            <span class="m-prev" style:background={c.bg}>
              <span class="m-bar" style:background={c.inkc}></span>
              <span class="m-panel" style:background={c.panel}><span class="m-dot"></span></span>
            </span>
          {/if}
          <span class="mode-foot">
            <span class="mode-label"><span class="mode-icon"><Icon name={c.icon} /></span>{c.label}</span>
            <span class="check"><Icon name="ti-check" /></span>
          </span>
        </button>
      {/each}
    </div>
  </section>

  <section data-sec="accent" class="sec">
    <h2>{m.appearance_tab_accent()}</h2>
    <p class="sec-desc">{m.appearance_accent_desc()}</p>
    {#if v.accLocked}
      <div class="locked-note"><Icon name="ti-lock" />{m.appearance_accent_locked()}</div>
    {/if}
    <div class="acc-wrap">
      <div
        role="radiogroup"
        use:radiogroup
        aria-label={m.appearance_tab_accent()}
        aria-disabled={v.accLocked}
        class="accents"
        class:locked={v.accLocked}
      >
        {#each v.accentOpts as a (a.name)}
          <button
            type="button"
            role="radio"
            aria-checked={a.on}
            disabled={v.accLocked}
            class="accent"
            class:on={a.on}
            style:--swatch={a.base}
            style:--swatch-ink={a.ink}
            onclick={a.onClick}
          >
            <span class="swatch"><Icon name="ti-check" /></span>
            <span class="accent-label">{a.label}</span>
          </button>
        {/each}
        <!-- Sixth tile: opens the colour editor (arrow keys only move here, Enter and Space open it). -->
        <button
          bind:this={moreBtn}
          type="button"
          role="radio"
          aria-checked={more.on}
          aria-label={moreName}
          data-opens-dialog
          disabled={v.accLocked}
          class="accent"
          class:on={more.on}
          style:--swatch={more.hex}
          style:--swatch-ink={more.ink}
          onclick={() => (editing = !v.accLocked)}
        >
          <span class="swatch">
            {#if more.hex}<Icon name="ti-check" />{:else}<AccentRing icon="ti-plus" />{/if}
          </span>
          <span class="accent-label">{moreLabel}</span>
        </button>
      </div>
    </div>
  </section>

  <section data-sec="text" class="sec">
    <h2>{m.appearance_tab_text()}</h2>
    <div class="box">
      {@render segRow(m.appearance_font_size(), m.appearance_font_size_desc(), v.fontOpts)}
      <div class="sep"></div>
      <div class="row anim">
        <div class="row-text">
          <div class="row-label">{m.appearance_animations()}</div>
          <div class="row-desc">{m.appearance_animations_desc()}</div>
        </div>
        <button
          type="button"
          role="switch"
          class="switch"
          class:on={v.tgAnim.on}
          aria-checked={v.tgAnim.on}
          aria-label={m.appearance_animations()}
          onclick={v.tgAnim.onClick}><span class="knob"></span></button
        >
      </div>
    </div>
  </section>

  <section data-sec="layout" class="sec">
    <h2>{m.appearance_tab_layout()}</h2>
    <div class="box">
      {@render segRow(m.appearance_density(), m.appearance_density_desc(), v.densityOpts)}
      <div class="sep"></div>
      {#if !isMobile}
        {@render segRow(m.appearance_sidebar(), m.appearance_sidebar_desc(), v.sidebarOpts)}
        <div class="sep"></div>
      {/if}
      {@render segRow(m.appearance_list(), m.appearance_list_desc(), v.pfDesignOpts)}
    </div>
  </section>
</div>

<style>
  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
  }

  .lead {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
  }

  .m-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
  }

  .m-lead {
    margin: 8px 0 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--mfg);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  .mobile .tabs {
    flex-wrap: nowrap;
    margin: 20px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
  }

  .tab {
    height: 40px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .tab:hover {
    background: var(--sunken);
  }

  .mobile .tab {
    height: 38px;
    flex-shrink: 0;
    padding: 0 16px;
    font-size: 13.5px;
    transition: none;
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Section */
  .sec {
    margin-top: 44px;
  }

  .mobile .sec {
    margin-top: 34px;
  }

  h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile h2 {
    font-size: 22px;
  }

  .sec-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .sec-desc {
    margin: 5px 0 0;
    font-size: 14px;
  }

  /* Colour scheme */
  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 16px;
    margin-top: 18px;
  }

  .mobile .modes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .mode {
    text-align: left;
    padding: 10px;
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .mode.on {
    background: var(--surface);
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh2);
  }

  .page:not(.mobile) .mode:hover {
    transform: translateY(-3px);
  }

  .mobile .mode {
    flex-direction: row;
    align-items: center;
    gap: 14px;
    padding: 8px 16px 8px 8px;
    border-radius: 22px;
    transition:
      box-shadow var(--dur, 220ms),
      background-color var(--dur, 220ms);
  }

  .prev {
    height: 110px;
    border-radius: 18px;
    position: relative;
    overflow: hidden;
    display: flex;
    gap: 7px;
    padding: 10px;
  }

  .prev-side {
    width: 28%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
  }

  .bar-ink {
    height: 12px;
    border-radius: 5px;
  }

  .bar-acc {
    height: 10px;
    border-radius: 5px;
    background: var(--acc);
  }

  .bar-line {
    height: 6px;
    border-radius: 3px;
  }

  .w80 {
    width: 80%;
  }

  .w65 {
    width: 65%;
  }

  .prev-panel {
    flex: 1;
    border-radius: 12px;
    /* fixed shadow (preview) */
    box-shadow: 0 4px 10px -4px rgba(60, 35, 10, 0.2);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bar-head {
    height: 9px;
    width: 55%;
    border-radius: 4px;
  }

  .grow {
    flex: 1;
  }

  .dot {
    height: 22px;
    width: 22px;
    border-radius: 8px;
    align-self: center;
    background: var(--acc);
    transform: rotate(-8deg);
  }

  .m-prev {
    width: 76px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 15px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 8px 0;
  }

  .m-bar {
    height: 5px;
    width: 46%;
    border-radius: 3px;
  }

  .m-panel {
    flex: 1;
    border-radius: 8px 8px 0 0;
    /* fixed shadow (preview) */
    box-shadow: 0 3px 8px -4px rgba(60, 35, 10, 0.2);
    display: grid;
    place-items: center;
  }

  .m-dot {
    width: 13px;
    height: 13px;
    border-radius: 5px;
    background: var(--acc);
    transform: rotate(-8deg);
  }

  .mode-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px 4px;
  }

  .mobile .mode-foot {
    flex: 1;
    min-width: 0;
    gap: 14px;
    padding: 0;
  }

  .mode-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
  }

  .mobile .mode-label {
    flex: 1;
    min-width: 0;
    font-size: 15.5px;
  }

  .mode-icon {
    display: grid;
    font-size: 18px;
    color: var(--mfg);
  }

  .check {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: transparent;
    border: 2px solid var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 14px;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .check :global(svg) {
    opacity: 0;
  }

  .mode.on .check {
    background: var(--ink);
    border: 0;
  }

  .mode.on .check :global(svg) {
    opacity: 1;
  }

  /* Accent colour */
  .locked-note {
    margin-top: 14px;
    width: fit-content;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .locked-note :global(svg) {
    font-size: 16px;
  }

  .mobile .locked-note {
    margin-top: 12px;
  }

  .accents {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 18px;
  }

  .accents.locked {
    opacity: 0.5;
    pointer-events: none;
  }

  /* Mobile: six columns spread over the row; where they do not fit with their names, two rows of three.
     338 px: six 50 px tiles with gap 4 and the longest name on the sixth (a preset like "Cornflower"). */
  .acc-wrap {
    container-type: inline-size;
  }

  .mobile .accents {
    display: grid;
    grid-template-columns: repeat(6, auto);
    justify-content: space-between;
    gap: 12px 4px;
    margin-top: 16px;
  }

  @container (max-width: 337.98px) {
    .mobile .accents {
      grid-template-columns: repeat(3, auto);
    }
  }

  .accent {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 8px 6px;
    border-radius: 20px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .page:not(.mobile) .accent:hover {
    transform: translateY(-3px);
  }

  .mobile .accent {
    padding: 6px 0;
    transition: none;
  }

  .swatch {
    width: 56px;
    height: 56px;
    border-radius: 20px;
    background: var(--swatch);
    /* fixed values (colour dots) */
    box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.08);
    display: grid;
    place-items: center;
    font-size: 22px;
    color: var(--swatch-ink);
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .swatch > :global(svg) {
    opacity: 0;
  }

  .accent.on .swatch {
    box-shadow:
      0 0 0 4px var(--surface),
      0 0 0 6px var(--swatch),
      0 12px 24px -8px var(--swatch);
    transform: rotate(-8deg) scale(1.05);
  }

  .accent.on .swatch > :global(svg) {
    opacity: 1;
  }

  .mobile .swatch {
    width: 50px;
    height: 50px;
    border-radius: 18px;
    font-size: 20px;
  }

  .accent-label {
    white-space: nowrap;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .accent.on .accent-label {
    color: var(--fg);
  }

  .mobile .accent-label {
    font-size: 12px;
  }

  /* Box with settings */
  .box {
    margin-top: 18px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 16px;
    border-radius: 24px;
    padding: 4px;
  }

  .sep {
    height: 1px;
    margin: 0 18px;
    background: var(--bd);
  }

  .mobile .sep {
    margin: 0 14px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
  }

  .row.wrap {
    gap: 12px 24px;
    flex-wrap: wrap;
  }

  .row.wrap .row-text {
    flex: 1 1 220px;
  }

  .mobile .row.wrap {
    display: block;
    padding: 14px 14px 12px;
  }

  .mobile .row.anim {
    justify-content: flex-start;
    gap: 16px;
    padding: 14px;
  }

  .row-text {
    flex: 1;
    min-width: 0;
  }

  .row-label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .row-label {
    font-size: 15px;
  }

  .row-desc {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .row-desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  /* Segment */
  .seg {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .mobile .seg {
    margin-top: 12px;
  }

  .seg button {
    height: 36px;
    padding: 0 16px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .seg button:hover,
  .seg button.on {
    color: var(--fg);
  }

  .seg button.on {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .mobile .seg button {
    flex: 1;
    min-width: 0;
    padding: 0;
    font-size: 13.5px;
  }

  .mobile .seg button:hover:not(.on) {
    color: var(--mfg);
  }

  /* Switch */
  .switch {
    width: 52px;
    height: 32px;
    border-radius: 9999px;
    background: var(--sunken);
    position: relative;
    flex-shrink: 0;
    transition: background-color var(--dur, 220ms);
  }

  .switch.on {
    background: var(--acc);
  }

  .knob {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    /* fixed values (switch) */
    background: #fff;
    box-shadow: 0 2px 4px rgba(60, 35, 10, 0.25);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .switch.on .knob {
    transform: translateX(20px);
  }
</style>
