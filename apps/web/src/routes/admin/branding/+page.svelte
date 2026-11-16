<!--
  Administration › Branding: preview (header, app icon), name, logo (kind,
  initial, icon, image with upload, size, plate, tilt), brand colour, login
  page, "Restore defaults" and the "Unsaved changes" bar (`DirtyBar`). Flow,
  checking and reading the file, toasts in `#lib/branding.svelte.ts`. The page
  holds the file field and the drop zone's events; it derives the style
  classes (segments, switches, icon grid, colour dots, drop zone) from `on`,
  `pressed` and the drag state.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import type { SegOption } from '#lib/appearance.ts';
  import type { Toggle } from '#lib/banner.svelte.ts';
  import { BRANDING_MAX, BrandingPage, brandingValues, type BrandingSection } from '#lib/branding.svelte.ts';
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  /** Formats of the file field's `accept` (`readBrandFile` checks them again). */
  const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

  let root: HTMLElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  const ctx = {
    scrollTo: (section: BrandingSection) => scrollToSection(root, section, prefs.motion),
  };
  const p = new BrandingPage(ctx);
  const v = $derived(brandingValues(p, ctx));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/branding'));

  /** Opens the file picker. */
  function pick(): void {
    fileInput?.click();
  }

  /** Takes over the file and clears the field so the same file can be chosen again. */
  function onFile(e: Event & { currentTarget: HTMLInputElement }): void {
    v.onBrFile(e.currentTarget.files?.[0]);
    e.currentTarget.value = '';
  }

  /** Allows dropping and highlights the zone. */
  function dragOver(e: DragEvent): void {
    e.preventDefault();
    if (!v.brDrag) v.onBrDrag(true);
  }

  /** Drag leaves the zone; moving onto a child of the zone does not count. */
  function dragLeave(e: DragEvent & { currentTarget: HTMLElement }): void {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    v.onBrDrag(false);
  }

  /** File dropped onto the zone. */
  function drop(e: DragEvent): void {
    e.preventDefault();
    v.onBrDrag(false);
    v.onBrFile(e.dataTransfer?.files[0]);
  }

  /**
   * The browser would open a file dropped next to the drop zone in the tab and
   * the unsaved draft would be gone: dropping files outside the zone is blocked
   * (dragging text into the input fields still works).
   */
  function guard(e: DragEvent): void {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  }

  onMount(() => {
    void p.load();
    return () => p.dispose();
  });
</script>

{#snippet toggle(t: Toggle, label: string)}
  <button
    type="button"
    role="switch"
    class="switch"
    class:on={t.on}
    aria-checked={t.on}
    aria-label={label}
    onclick={t.onClick}><span class="knob"></span></button
  >
{/snippet}

{#snippet switchRow(t: Toggle, label: string, desc: string)}
  <div class="switch-row">
    <div class="grow">
      <div class="label">{label}</div>
      <div class="desc">{desc}</div>
    </div>
    {@render toggle(t, label)}
  </div>
{/snippet}

{#snippet segRow(label: string, desc: string | null, opts: readonly SegOption<string>[])}
  <div class="row">
    <div class="row-text">
      <div class="label">{label}</div>
      {#if desc}<div class="desc">{desc}</div>{/if}
    </div>
    <div role="radiogroup" use:radiogroup aria-label={label} class="seg">
      {#each opts as o (o.value)}
        <button type="button" role="radio" aria-checked={o.on} class:on={o.on} onclick={o.onClick}>{o.label}</button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet field(label: string, hint: string, ph: string, value: string, max: number, onChange: (v: string) => void)}
  <div class="row">
    <div class="row-text">
      <div class="label">{label}</div>
      <div class="desc">{hint}</div>
    </div>
    <input
      type="text"
      class="text"
      {value}
      maxlength={max}
      placeholder={ph}
      aria-label={label}
      oninput={(e) => onChange(e.currentTarget.value)}
    />
  </div>
{/snippet}

<svelte:window ondragover={guard} ondrop={guard} />

<div bind:this={root} class="page" class:mobile={isMobile}>
  <input
    bind:this={fileInput}
    type="file"
    accept={ACCEPT}
    tabindex="-1"
    aria-hidden="true"
    class="file"
    onchange={onFile}
  />

  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <div class="tabs no-scrollbar">
    {#each v.brTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <!-- Preview: header and (desktop only) app icon. -->
  <div class="prev-box">
    <figure class="stage">
      <div class="brand">
        <span
          class="brand-tile"
          style:background={v.brPrev.bg}
          style:color={v.brPrev.ink}
          style:transform={v.brPrev.tilt}><Logo logo={v.brPrev.logo} /></span
        >
        <span class="brand-name">{v.brPrev.name}</span>
      </div>
      <figcaption class="stage-label">{m.branding_prev_header()}</figcaption>
    </figure>
    {#if !isMobile}
      <figure class="stage app">
        <span class="app-tile" style:background={v.brPrev.bg} style:color={v.brPrev.ink}
          ><Logo logo={v.brPrev.logo} /></span
        >
        <span class="app-name">{v.brPrev.name}</span>
        <figcaption class="stage-label">{m.branding_prev_icon()}</figcaption>
      </figure>
    {/if}
  </div>

  <section data-sec="name" class="sec">
    <h2>{m.branding_tab_name()}</h2>
    <p class="sec-desc">{m.branding_name_desc()}</p>
    <div class="box">
      {@render field(m.branding_name(), m.branding_name_hint(), m.app_name(), v.brName, BRANDING_MAX.name, v.onBrName)}
    </div>
  </section>

  <section data-sec="logo" class="sec">
    <h2>{m.branding_tab_logo()}</h2>
    <p class="sec-desc">{m.branding_logo_desc()}</p>
    <div class="box">
      {@render segRow(m.branding_kind(), isMobile ? null : m.branding_kind_desc(), v.brKindOpts)}
      {#if v.brKindExtra}<div class="sep"></div>{/if}

      {#if v.brIsInit}
        <div class="letter-row">
          <div class="row-text">
            <div class="label">{m.branding_letter()}</div>
            <div class="desc">{isMobile ? m.branding_letter_desc_mobile() : m.branding_letter_desc()}</div>
          </div>
          <input
            type="text"
            class="text letter"
            value={v.brLetter}
            maxlength={BRANDING_MAX.letter}
            placeholder={v.brLetterPh}
            aria-label={m.branding_letter()}
            oninput={(e) => v.onBrLetter(e.currentTarget.value)}
          />
        </div>
      {/if}

      {#if v.brIsIcon}
        <div class="pick">
          <div class="label">{m.branding_symbol()}</div>
          {#if !isMobile}<div class="desc">{m.branding_symbol_desc()}</div>{/if}
          <div role="radiogroup" use:radiogroup aria-label={m.branding_symbol()} class="syms">
            {#each v.brIcons as b (b.icon)}
              <button
                type="button"
                role="radio"
                aria-checked={b.pressed}
                aria-label={b.label}
                class="sym"
                class:on={b.pressed}
                onclick={b.onClick}><Icon name={b.icon} /></button
              >
            {/each}
          </div>
        </div>
      {/if}

      {#if v.brIsImg}
        <div class="pick">
          <div class="label">{m.branding_image()}</div>
          <div class="desc">{m.branding_image_desc()}</div>
          {#if v.brNoImg}
            <button
              type="button"
              class="drop"
              class:drag={v.brDrag}
              onclick={pick}
              ondragover={isMobile ? undefined : dragOver}
              ondragleave={isMobile ? undefined : dragLeave}
              ondrop={isMobile ? undefined : drop}
            >
              <span class="drop-icon"><Icon name="ti-upload" /></span>
              <span class="drop-text">{isMobile ? m.branding_drop_mobile() : m.branding_drop()}</span>
              <span class="drop-hint">{m.branding_drop_hint()}</span>
            </button>
          {/if}
          {#if v.brHasImg}
            <div
              class="img-card"
              class:drag={v.brDrag}
              role="group"
              aria-label={m.branding_image()}
              ondragover={isMobile ? undefined : dragOver}
              ondragleave={isMobile ? undefined : dragLeave}
              ondrop={isMobile ? undefined : drop}
            >
              <span class="img-tile" style:background={v.brPrev.bg} style:color={v.brPrev.ink}
                ><Logo logo={v.brPrev.logo} /></span
              >
              <div class="img-text">
                <div class="img-name">{v.brImgName}</div>
                <div class="img-meta">{v.brImgMeta}</div>
              </div>
              {#if !isMobile}
                <div class="img-actions">
                  <button type="button" class="replace" onclick={pick}>{m.branding_replace()}</button>
                  <button
                    type="button"
                    class="round remove"
                    aria-label={m.branding_remove()}
                    use:tooltip={m.branding_remove()}
                    onclick={v.brImgRemove}><Icon name="ti-trash" /></button
                  >
                </div>
              {:else}
                <button type="button" class="round" aria-label={m.branding_replace_label()} onclick={pick}
                  ><Icon name="ti-replace" /></button
                >
                <button type="button" class="round remove" aria-label={m.branding_remove()} onclick={v.brImgRemove}
                  ><Icon name="ti-trash" /></button
                >
              {/if}
            </div>
          {/if}
          {#if v.brHasErr}
            <div role="alert" class="img-error"><Icon name="ti-alert-circle" />{v.brErr}</div>
          {/if}
        </div>
        <div class="sep"></div>
        {@render segRow(m.branding_fit(), isMobile ? null : m.branding_fit_desc(), v.brFitOpts)}
      {/if}

      <div class="sep"></div>
      {@render segRow(m.branding_plate(), m.branding_plate_desc(), v.brPlateOpts)}
      <div class="sep"></div>
      {@render switchRow(
        v.tgBrTilt,
        m.branding_tilt(),
        isMobile ? m.branding_tilt_desc_mobile() : m.branding_tilt_desc(),
      )}
    </div>
  </section>

  <section data-sec="color" class="sec">
    <h2>{m.branding_tab_color()}</h2>
    <p class="sec-desc">{m.branding_color_desc()}</p>
    <div role="radiogroup" use:radiogroup aria-label={m.branding_tab_color()} class="colors">
      {#each v.brColors as a (a.name)}
        <button
          type="button"
          role="radio"
          aria-checked={a.on}
          class="color"
          class:on={a.on}
          style:--swatch={a.base}
          style:--swatch-ink={a.ink}
          onclick={a.onClick}
        >
          <span class="swatch"><Icon name="ti-check" /></span>
          <span class="color-label">{a.label}</span>
        </button>
      {/each}
    </div>
    <div class="box">
      {@render switchRow(v.tgBrUserAcc, m.branding_user_accent(), m.branding_user_accent_desc())}
    </div>
  </section>

  <section data-sec="login" class="sec">
    <h2>{m.branding_tab_login()}</h2>
    <p class="sec-desc">{m.branding_login_desc()}</p>
    <div class="box">
      {@render field(
        m.branding_login_title(),
        m.branding_login_title_hint(),
        m.branding_login_title_ph(),
        v.brLoginTitle,
        BRANDING_MAX.loginTitle,
        v.onBrLoginTitle,
      )}
      <div class="sep"></div>
      {@render field(
        m.branding_login_text(),
        m.branding_login_text_hint(),
        m.branding_login_text_ph(),
        v.brLoginText,
        BRANDING_MAX.loginText,
        v.onBrLoginText,
      )}
      <div class="sep"></div>
      {@render switchRow(
        v.tgBrLoginArt,
        m.branding_login_art(),
        isMobile ? m.branding_login_art_desc_mobile() : m.branding_login_art_desc(),
      )}
    </div>
  </section>

  {#if v.brNotDefault}
    <div class="reset-wrap">
      <button type="button" class="reset" onclick={v.brReset}><Icon name="ti-restore" />{m.branding_reset()}</button>
    </div>
  {/if}

  {#if v.brDirty}
    <DirtyBar onDiscard={v.brDiscard} onSave={v.brSave} {isMobile} />
  {/if}
</div>

<style>
  .file {
    display: none;
  }

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

  /* Section tabs */
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
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Preview */
  .prev-box {
    margin-top: 28px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 6px;
    padding: 6px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .mobile .prev-box {
    margin-top: 20px;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 4px;
    padding: 4px;
    border-radius: 24px;
  }

  .stage {
    position: relative;
    height: 148px;
    margin: 0;
    border-radius: 20px;
    background: var(--cnv);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 20px 20px;
    overflow: hidden;
  }

  .mobile .stage {
    height: 120px;
    padding: 0 18px 18px;
  }

  .stage.app {
    flex-direction: column;
    gap: 9px;
    overflow: visible;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    max-width: 100%;
  }

  .mobile .brand {
    gap: 11px;
  }

  .brand-tile,
  .app-tile,
  .img-tile {
    flex-shrink: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
    transition: background-color var(--dur, 220ms);
  }

  .brand-tile {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    /* Fixed shadow (logo tile) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color var(--dur, 220ms);
  }

  .mobile .brand-tile {
    width: 38px;
    height: 38px;
    border-radius: 13px;
  }

  .brand-name {
    min-width: 0;
    font-family: var(--font-serif);
    font-size: 21px;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mobile .brand-name {
    font-size: 20px;
  }

  .app-tile {
    width: 56px;
    height: 56px;
    border-radius: 19px;
    box-shadow: var(--sh1);
  }

  .app-name {
    max-width: 140px;
    font-size: 12.5px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stage-label {
    position: absolute;
    left: 18px;
    bottom: 14px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .mobile .stage-label {
    left: 16px;
    bottom: 12px;
    font-size: 12px;
  }

  /* Sections */
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
    margin-top: 5px;
    font-size: 14px;
  }

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
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  .label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .label {
    font-size: 15px;
  }

  .desc {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .mobile .desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  /* Rows: on desktop label left, field or segment right; stacked on mobile */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
  }

  .mobile .row {
    display: block;
    padding: 14px 14px 12px;
  }

  .row-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .text {
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .mobile .text {
    display: block;
    height: 46px;
    margin-top: 12px;
    padding: 0 16px;
    font-size: 16px;
    transition: none;
  }

  .text:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  /* Initial: field next to the label on mobile too */
  .letter-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
  }

  .mobile .letter-row {
    gap: 16px;
    padding: 14px;
    flex-wrap: nowrap;
  }

  .mobile .letter-row .row-text {
    flex: 1;
  }

  .text.letter {
    flex: 0 0 96px;
    width: 96px;
    padding: 0 12px;
    font-family: var(--font-serif);
    font-size: 19px;
    font-weight: 400;
    text-align: center;
  }

  .mobile .text.letter {
    flex: 0 0 84px;
    width: 84px;
    margin-top: 0;
    padding: 0 10px;
    font-size: 19px;
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

  /* Icon and image */
  .pick {
    padding: 16px 18px;
  }

  .mobile .pick {
    padding: 14px 14px 12px;
  }

  .syms {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
    gap: 8px;
  }

  .mobile .syms {
    margin-top: 12px;
    grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
    gap: 6px;
  }

  .sym {
    height: 52px;
    border-radius: 18px;
    display: grid;
    place-items: center;
    background: transparent;
    color: var(--mfg);
    font-size: 24px;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sym.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .sym:hover {
    transform: translateY(-2px);
  }

  .mobile .sym {
    height: 48px;
    border-radius: 16px;
    font-size: 22px;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .mobile .sym:hover {
    transform: none;
  }

  /* Drop zone (background and border follow the drag state) */
  .drop {
    margin-top: 14px;
    width: 100%;
    min-height: 148px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 22px;
    border-radius: 22px;
    border: 2px dashed var(--bdhi);
    background: var(--surface);
    text-align: center;
    transition:
      background-color var(--dur, 220ms),
      border-color var(--dur, 220ms);
  }

  .drop:hover,
  .drop.drag {
    border-color: var(--acc);
  }

  .drop.drag {
    background: var(--accsoft);
  }

  .mobile .drop {
    margin-top: 12px;
    min-height: 120px;
    gap: 5px;
    padding: 18px;
    border-radius: 20px;
    transition: none;
  }

  .mobile .drop:hover {
    border-color: var(--bdhi);
  }

  .mobile .drop:active {
    background: var(--accsoft);
  }

  .drop-icon {
    width: 46px;
    height: 46px;
    margin-bottom: 6px;
    border-radius: 16px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 22px;
  }

  .mobile .drop-icon {
    width: 44px;
    height: 44px;
    border-radius: 15px;
    font-size: 21px;
  }

  .drop-text {
    font-size: 15px;
    font-weight: 700;
  }

  .drop-hint {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .mobile .drop-hint {
    font-size: 13px;
  }

  .img-card {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 12px 14px;
    flex-wrap: wrap;
    padding: 10px;
    border-radius: 22px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .img-card.drag {
    background: var(--accsoft);
  }

  .mobile .img-card {
    margin-top: 12px;
    gap: 12px;
    flex-wrap: nowrap;
    padding: 8px;
    border-radius: 20px;
    background: var(--surface);
  }

  .img-tile {
    width: 56px;
    height: 56px;
    border-radius: 18px;
  }

  .mobile .img-tile {
    width: 52px;
    height: 52px;
    border-radius: 17px;
  }

  .img-text {
    flex: 1 1 140px;
    min-width: 0;
  }

  .mobile .img-text {
    flex: 1;
  }

  .img-name {
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mobile .img-name {
    font-size: 14.5px;
  }

  .img-meta {
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  .mobile .img-meta {
    font-size: 13px;
  }

  .img-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .replace {
    height: 40px;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .replace:hover {
    background: var(--sunken);
  }

  .round {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--fg);
    font-size: 18px;
    transition: background-color var(--dur, 220ms);
  }

  .round.remove {
    color: var(--danger);
  }

  .round:hover {
    background: var(--hov);
  }

  .mobile .round {
    width: 44px;
    height: 44px;
    font-size: 19px;
    transition: none;
  }

  .mobile .round:hover {
    background: none;
  }

  .mobile .round:active {
    background: var(--hov);
  }

  .img-error {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
  }

  .img-error :global(svg) {
    flex-shrink: 0;
    font-size: 18px;
  }

  .mobile .img-error {
    margin-top: 10px;
    align-items: flex-start;
    font-size: 13.5px;
    line-height: 1.4;
  }

  /* Switch */
  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
  }

  .mobile .switch-row {
    gap: 16px;
    padding: 14px;
  }

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

  /* Brand colour */
  .colors {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 18px;
  }

  .mobile .colors {
    justify-content: space-between;
    gap: 4px;
    flex-wrap: nowrap;
    margin-top: 16px;
  }

  .color {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 8px 6px;
    border-radius: 20px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .color:hover {
    transform: translateY(-3px);
  }

  .mobile .color {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    transition: none;
  }

  .mobile .color:hover {
    transform: none;
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

  .swatch :global(svg) {
    opacity: 0;
  }

  .color.on .swatch {
    box-shadow:
      0 0 0 4px var(--surface),
      0 0 0 6px var(--swatch),
      0 12px 24px -8px var(--swatch);
    transform: rotate(-8deg) scale(1.05);
  }

  .color.on .swatch :global(svg) {
    opacity: 1;
  }

  .mobile .swatch {
    width: 50px;
    height: 50px;
    border-radius: 18px;
    font-size: 20px;
  }

  .color-label {
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .color.on .color-label {
    color: var(--fg);
  }

  .mobile .color-label {
    font-size: 12px;
  }

  /* Restore default */
  .reset-wrap {
    margin-top: 32px;
    display: flex;
    justify-content: center;
  }

  .mobile .reset-wrap {
    margin-top: 24px;
  }

  .reset {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .reset :global(svg) {
    font-size: 18px;
  }

  .reset:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .reset {
    width: 100%;
    height: 50px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
    transition: none;
  }

  .mobile .reset:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .reset:active {
    background: var(--hov);
  }
</style>
