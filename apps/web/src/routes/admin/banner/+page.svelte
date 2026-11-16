<!--
  Administration › Banner: preview, display with switch and status, content
  (title, text, link with label), appearance (colour, icon) and the "Unsaved
  changes" bar (`DirtyBar`). Flow, confirmation and toasts in
  `#lib/banner.svelte.ts`; the page derives the style classes (switch, tile,
  rings, right padding of the preview) from `on`, `pressed` and `hasClose`.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import { BannerPage, bannerValues, type BannerSection, type Toggle } from '#lib/banner.svelte.ts';
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const ctx = {
    scrollTo: (section: BannerSection) => scrollToSection(root, section, prefs.motion),
  };
  const p = new BannerPage(ctx);
  const v = $derived(bannerValues(p, ctx));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/banner'));

  interface Field {
    key: string;
    label: string;
    hint: string;
    ph: string;
    value: string;
    onChange: (value: string) => void;
    type: 'text' | 'url';
    max?: number;
    /** Only the link: invalid address. */
    bad?: boolean;
  }

  /** Fields of the content section; "Label" only with a link. */
  const fields = $derived<Field[]>([
    {
      key: 'title',
      label: m.banner_field_title(),
      hint: m.banner_field_title_hint(),
      ph: m.banner_field_title_ph(),
      value: v.annTitle,
      onChange: v.onAnnTitle,
      type: 'text',
      max: 40,
    },
    {
      key: 'text',
      label: m.banner_field_text(),
      hint: m.banner_field_text_hint(),
      ph: m.banner_field_text_ph(),
      value: v.annText,
      onChange: v.onAnnText,
      type: 'text',
      max: 140,
    },
    {
      key: 'link',
      label: m.banner_field_link(),
      hint: m.banner_field_link_hint(),
      ph: m.banner_field_link_ph(),
      value: v.annLink,
      onChange: v.onAnnLink,
      type: 'url',
      bad: v.annLinkBad,
    },
    ...(v.annHasLink
      ? [
          {
            key: 'label',
            label: m.banner_field_label(),
            hint: m.banner_field_label_hint(),
            ph: m.banner_more(),
            value: v.annLinkLabel,
            onChange: v.onAnnLinkLabel,
            type: 'text' as const,
            max: 24,
          },
        ]
      : []),
  ]);

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

{#snippet linkError()}
  <div role="alert" class="link-error"><Icon name="ti-alert-circle" />{m.banner_field_link_error()}</div>
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
    {#each v.annTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <!-- Preview: looks like the banner of the notice bar, the buttons are display only. -->
  <div class="prev-box">
    <figure class="stage">
      <div class="prev" class:closable={v.annPrev.hasClose} style:background={v.annPrev.bg} style:color={v.annPrev.ink}>
        <span class="prev-icon"><Icon name={v.annPrev.icon} /></span>
        <span class="prev-title" style:opacity={v.annPrev.op}>{v.annPrev.title}</span>
        {#if !isMobile}<span class="prev-text" style:color={v.annPrev.sub}>{v.annPrev.text}</span>{/if}
        {#if v.annPrev.hasAct}<span class="prev-act" style:background={v.annPrev.actBg}>{v.annPrev.act}</span>{/if}
        {#if v.annPrev.hasClose}<span class="prev-close"><Icon name="ti-x" /></span>{/if}
      </div>
      <figcaption class="stage-label">{m.banner_preview()}</figcaption>
    </figure>
  </div>

  <section data-sec="status" class="sec">
    <h2>{m.banner_tab_status()}</h2>
    <p class="sec-desc">{m.banner_status_desc()}</p>
    <div class="box">
      <div class="status-row">
        <span class="tile" class:on={v.tgAnn.on}><Icon name="ti-speakerphone" /></span>
        <div class="grow">
          <div class="label">{m.banner_show()}</div>
          <div class="desc">{v.annStatus}</div>
        </div>
        {#if v.annHiddenMe && !isMobile}
          <button type="button" class="unhide" onclick={v.annUnhide}>{m.banner_unhide()}</button>
        {/if}
        {@render toggle(v.tgAnn, m.banner_show())}
      </div>
      {#if v.annHiddenMe && isMobile}
        <div class="m-unhide">
          <button type="button" onclick={v.annUnhide}>{m.banner_unhide_mobile()}</button>
        </div>
      {/if}
      <div class="sep"></div>
      <div class="switch-row">
        <div class="grow">
          <div class="label">{m.banner_closable()}</div>
          <div class="desc">{isMobile ? m.banner_closable_desc_mobile() : m.banner_closable_desc()}</div>
        </div>
        {@render toggle(v.tgAnnClose, m.banner_closable())}
      </div>
    </div>
  </section>

  <section data-sec="content" class="sec">
    <h2>{m.banner_tab_content()}</h2>
    <p class="sec-desc">{isMobile ? m.banner_content_desc_mobile() : m.banner_content_desc()}</p>
    <div class="box">
      {#each fields as f, i (f.key)}
        {#if i}<div class="sep"></div>{/if}
        <div class="row">
          <div class="row-text">
            <div class="label">{f.label}</div>
            <div class="desc">{f.hint}</div>
          </div>
          <input
            type={f.type}
            value={f.value}
            maxlength={f.max}
            placeholder={f.ph}
            aria-label={f.label}
            aria-invalid={f.type === 'url' ? !!f.bad : undefined}
            class:bad={f.bad}
            oninput={(e) => f.onChange(e.currentTarget.value)}
          />
          {#if f.bad && isMobile}{@render linkError()}{/if}
        </div>
        {#if f.bad && !isMobile}{@render linkError()}{/if}
      {/each}
    </div>
  </section>

  <section data-sec="look" class="sec">
    <h2>{m.banner_tab_look()}</h2>
    <p class="sec-desc">{m.banner_look_desc()}</p>
    <div class="box">
      <div class="pick">
        <div class="label">{m.banner_color()}</div>
        <div role="radiogroup" use:radiogroup aria-label={m.banner_color()} class="tones">
          {#each v.annTones as o (o.name)}
            <button
              type="button"
              role="radio"
              aria-checked={o.pressed}
              class="tone"
              class:on={o.pressed}
              style:background={o.bg}
              style:color={o.ink}
              onclick={o.onClick}><span class="tone-check"><Icon name="ti-check" /></span>{o.label}</button
            >
          {/each}
        </div>
      </div>
      <div class="sep"></div>
      <div class="pick">
        <div class="label">{m.banner_symbol()}</div>
        <div role="radiogroup" use:radiogroup aria-label={m.banner_symbol()} class="syms">
          {#each v.annIcons as b (b.icon)}
            <button
              type="button"
              role="radio"
              aria-checked={b.pressed}
              aria-label={b.label}
              class="sym"
              class:on={b.pressed}
              use:tooltip={isMobile ? undefined : b.label}
              onclick={b.onClick}><Icon name={b.icon} /></button
            >
          {/each}
        </div>
      </div>
    </div>
  </section>

  {#if v.annDirty}
    <DirtyBar text={v.annDirtyText} onDiscard={v.annDiscard} onSave={v.annSave} {isMobile} />
  {/if}
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
    padding: 6px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .mobile .prev-box {
    margin-top: 20px;
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
    padding: 0 14px 18px;
  }

  .prev {
    position: relative;
    width: 100%;
    max-width: 680px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
    border-radius: 12px;
    font-size: 13.5px;
    line-height: 1.3;
    box-shadow: var(--sh1);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .prev.closable {
    padding-right: 40px;
  }

  .mobile .prev {
    max-width: none;
    justify-content: flex-start;
    gap: 8px;
    padding: 0 6px 0 14px;
  }

  .prev-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
  }

  .prev-title {
    font-weight: 800;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .mobile .prev-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .prev-text {
    min-width: 0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .prev-act {
    height: 26px;
    flex-shrink: 0;
    margin-left: 4px;
    padding: 0 12px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    font-size: 12.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .mobile .prev-act {
    height: 28px;
    margin-left: 0;
  }

  .prev-close {
    position: absolute;
    right: 5px;
    top: 5px;
    width: 26px;
    height: 26px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 15px;
  }

  .mobile .prev-close {
    position: static;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
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
    line-height: 1.5;
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

  /* Display */
  .status-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px 10px 10px;
  }

  .mobile .status-row {
    gap: 12px;
    padding: 10px 12px 10px 10px;
  }

  .tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 21px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tile.on {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .mobile .tile {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 20px;
  }

  .unhide {
    height: 34px;
    flex-shrink: 0;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .unhide:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m-unhide {
    padding: 0 10px 10px;
  }

  .m-unhide button {
    width: 100%;
    height: 44px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14.5px;
    font-weight: 700;
  }

  .m-unhide button:active {
    background: var(--sunken);
  }

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

  /* Content: on desktop label left, field right; stacked on mobile */
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

  input {
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

  .mobile input {
    display: block;
    height: 46px;
    margin-top: 12px;
    padding: 0 16px;
    font-size: 16px;
    transition: none;
  }

  input.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .link-error {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 18px 14px;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
  }

  .mobile .link-error {
    margin-top: 10px;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 0;
    font-size: 13.5px;
    line-height: 1.4;
  }

  .link-error :global(svg) {
    font-size: 18px;
  }

  /* Appearance */
  .pick {
    padding: 16px 18px;
  }

  .mobile .pick {
    padding: 14px 14px 12px;
  }

  .tones {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
  }

  .mobile .tones {
    margin-top: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .tone {
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 14px;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    /* Fixed ring */
    box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.08);
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tone.on {
    box-shadow:
      0 0 0 3px var(--surface2),
      0 0 0 5px var(--fg);
  }

  .tone:hover {
    transform: translateY(-2px);
  }

  .mobile .tone {
    gap: 7px;
    padding: 0 10px;
    transition: box-shadow var(--dur, 220ms);
  }

  .mobile .tone:hover {
    transform: none;
  }

  .tone-check {
    display: grid;
    font-size: 17px;
    opacity: 0;
  }

  .tone.on .tone-check {
    opacity: 1;
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
</style>
