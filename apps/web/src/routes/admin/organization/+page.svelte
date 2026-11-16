<!--
  Administration › Organization: company, support, legal and source code with
  tabs, a pointer to Settings › About and the "Unsaved changes" bar. Flow and
  values in `#lib/org.svelte.ts`; the state API shows the "Changes saved"
  toast with undo. Field errors: red ring and text with `role="alert"` below
  the field, on desktop right-aligned below the row, on mobile directly below
  the field; the field names the text via `aria-describedby`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { OrgPage, orgValues, type OrgField, type OrgSection } from '#lib/org.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const ctx = {
    scrollTo: (section: OrgSection) => scrollToSection(root, section, prefs.motion),
    viewAbout: () => void goto(resolve('/settings/about')),
  };
  const p = new OrgPage(ctx);
  const uid = $props.id();
  const errId = (f: OrgField): string => `${uid}-${f.k}-err`;
  const v = $derived(orgValues(p, ctx));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/organization'));

  /** Sections in tab order; headings like the tabs. */
  const sections = $derived<{ key: OrgSection; title: string; desc: string; fields: OrgField[] }[]>([
    { key: 'firm', title: m.org_tab_firm(), desc: m.org_firm_desc(), fields: v.orgFirm },
    { key: 'support', title: m.org_tab_support(), desc: m.org_support_desc(), fields: v.orgSupport },
    { key: 'legal', title: m.org_tab_legal(), desc: m.org_legal_desc(), fields: v.orgLegal },
    { key: 'source', title: m.org_tab_source(), desc: m.org_source_desc(), fields: v.orgSource },
  ]);

  onMount(() => {
    void p.load();
    return () => p.dispose();
  });
</script>

{#snippet fieldError(f: OrgField)}
  <div role="alert" id={errId(f)} class="field-error"><Icon name="ti-alert-circle" />{f.err}</div>
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
    {#each v.orgTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <div class="info">
    <span class="info-icon"><Icon name="ti-info-circle" /></span>
    <span class="info-text">{m.org_info()}</span>
    <button type="button" class="view" onclick={v.viewAbout}>{m.org_view_about()}<Icon name="ti-arrow-right" /></button>
  </div>

  {#each sections as s (s.key)}
    <section data-sec={s.key} class="sec">
      <h2>{s.title}</h2>
      <p class="sec-desc">{s.desc}</p>
      <div class="box">
        {#each s.fields as f (f.k)}
          <div>
            {#if f.sep}<div class="sep"></div>{/if}
            <div class="row">
              <div class="row-text">
                <div class="label">{f.label}</div>
                <div class="desc">{f.desc}</div>
              </div>
              <input
                type={f.type}
                value={f.value}
                placeholder={f.ph}
                aria-label={f.label}
                aria-invalid={f.badA}
                aria-describedby={f.bad ? errId(f) : undefined}
                class:bad={f.bad}
                oninput={(e) => f.onChange(e.currentTarget.value)}
              />
              {#if f.bad && isMobile}{@render fieldError(f)}{/if}
            </div>
            {#if f.bad && !isMobile}{@render fieldError(f)}{/if}
          </div>
        {/each}
      </div>
    </section>
  {/each}

  {#if v.orgDirty}
    <DirtyBar onDiscard={v.orgDiscard} onSave={v.orgSave} {isMobile} />
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

  /* Pointer to Settings › About */
  .info {
    margin-top: 28px;
    display: flex;
    align-items: center;
    gap: 12px 16px;
    flex-wrap: wrap;
    padding: 14px 14px 14px 20px;
    border-radius: 24px;
    background: var(--accsoft);
  }

  .mobile .info {
    margin-top: 20px;
  }

  .info-icon {
    display: grid;
    font-size: 22px;
    color: var(--deep);
    flex-shrink: 0;
  }

  .info-text {
    flex: 1 1 240px;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .view {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .view :global(svg) {
    font-size: 16px;
  }

  .view:hover {
    transform: translateY(-2px);
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

  /* Fields: on desktop label left, field right; stacked on mobile */
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

  /* Field error: red ring as for the banner */
  input.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .field-error {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 18px 14px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    text-align: right;
    color: var(--danger);
  }

  .mobile .field-error {
    margin-top: 10px;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 0;
    font-size: 13.5px;
    text-align: left;
  }

  .field-error :global(svg) {
    flex-shrink: 0;
    font-size: 18px;
  }
</style>
