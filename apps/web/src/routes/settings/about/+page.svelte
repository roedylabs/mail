<!--
  Settings › About: version with logo, build, date and browser, system
  information to copy, support, legal and licences as links, plus section
  tabs. Values in `#lib/about.ts`; support and legal appear only with details
  from the organization, the chip follows `update` from `public/config`. The
  last row of the licences opens the licences dialog (`LicensesDialog`) via
  `ui.pageDialog`: as a dialog on desktop, on mobile in the layout's sheet;
  Escape closes (layout), the focus returns to the row (`use:focustrap`).
-->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { aboutValues, type AboutContext, type AboutLink } from '#lib/about.ts';
  import { buildInfo } from '#lib/build-info.ts';
  import { copyText } from '#lib/clipboard.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import LicensesDialog from '#lib/components/LicensesDialog.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { LicenseDialogState } from '#lib/licenses.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { browserTimeZone, displayZone, prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();

  const licDialog = new LicenseDialogState();
  const ctx: AboutContext = {
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    copy: copyText,
    notify: (text) => ui.toasts.show(text),
    openLicenses: licDialog.show,
  };
  const v = $derived(
    aboutValues(
      {
        appName: session.appName,
        org: session.config?.org ?? null,
        update: session.config?.update ?? null,
        build: buildInfo,
        dateFmt: prefs.values.dateFmt,
        tz: displayZone(prefs.values, browserTimeZone()),
        userAgent: navigator.userAgent,
      },
      ctx,
    ),
  );
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/about'));
  /** Values of the licences dialog while it is open. */
  const lic = $derived(licDialog.open ? licDialog.values(session.appName) : null);

  onMount(() => {
    ui.pageDialog = () => (lic ? { title: lic.title, close: lic.close, content: licenses } : null);
    return () => {
      ui.pageDialog = null;
    };
  });
</script>

{#snippet licenses(mobile: boolean)}
  {#if lic}<LicensesDialog {lic} {mobile} />{/if}
{/snippet}

{#snippet org()}
  <div class="org">
    {m.about_provided_by()}
    {#if v.orgHasLink}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- website of the organization -->
      <a href={v.orgHref} target="_blank" rel="noopener noreferrer" class="org-name">{v.orgName}</a>
    {/if}{#if v.orgNoLink}<span class="org-name">{v.orgName}</span>{/if}
  </div>
{/snippet}

{#snippet chip()}
  <span class="chip"><span class="chip-icon"><Icon name={v.upChipIcon} /></span>{v.upChipText}</span>
{/snippet}

{#snippet links(list: readonly AboutLink[], after?: Snippet)}
  <div class="links">
    {#each list as l (l.label)}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external links (organization, components) -->
      <a href={l.href} target="_blank" rel="noopener noreferrer" class="link">
        <span class="link-tile"><Icon name={l.icon} /></span>
        <span class="link-text">
          <span class="link-label">{l.label}</span>
          <span class="link-sub">{l.sub}</span>
        </span>
        {#if l.hasTag}<span class="tag">{l.tag}</span>{/if}
        <span class="arrow"><Icon name="ti-arrow-up-right" /></span>
      </a>
    {/each}
    {@render after?.()}
  </div>
{/snippet}

{#snippet licRow()}
  <button type="button" class="link lic-row" aria-haspopup="dialog" onclick={v.licRow.open}>
    <span class="link-tile"><Icon name="ti-list-details" /></span>
    <span class="link-text">
      <span class="link-label">{v.licRow.label}</span>
      <span class="lic-sub">{v.licRow.sub}</span>
    </span>
    <span class="arrow"><Icon name="ti-chevron-right" /></span>
  </button>
{/snippet}

{#snippet head(title: string, desc: string)}
  <h2>{title}</h2>
  <p class="sec-desc">{desc}</p>
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
    {#each v.aboutTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="version" class="sec">
    {@render head(m.about_version(), m.about_version_desc())}
    <div class="hero">
      <span class="logo-tile"><Logo logo={session.logo} /></span>
      {#if !isMobile}
        <div class="hero-text">
          <div class="app-name">{session.appName}</div>
          <div class="app-version">{m.nav_version({ version: v.appVersion })}</div>
          {#if v.hasOrg}{@render org()}{/if}
        </div>
        {#if v.upShowChip}{@render chip()}{/if}
      {:else}
        <div class="app-name">{session.appName}</div>
        <div class="app-version">{m.nav_version({ version: v.appVersion })}</div>
        <div class="m-org">
          {#if v.hasOrg}{@render org()}{/if}
        </div>
        <div class="m-chip">
          {#if v.upShowChip}{@render chip()}{/if}
        </div>
      {/if}
    </div>
    <div class="box">
      {#each v.aboutRows as r (r.k)}
        <div>
          {#if r.sep}<div class="sep"></div>{/if}
          <div class="row">
            <span class="row-k">{r.k}</span>
            <span class="row-v">{r.v}</span>
          </div>
        </div>
      {/each}
      <div class="sep"></div>
      <div class="sys">
        <div class="sys-text">
          <div class="sys-label">{m.about_sys()}</div>
          <div class="sys-desc">{isMobile ? m.about_sys_desc_short() : m.about_sys_desc()}</div>
        </div>
        <button type="button" class="copy" onclick={() => void v.copySys()}
          ><span class="copy-icon"><Icon name="ti-copy" /></span>{m.about_copy()}</button
        >
      </div>
    </div>
  </section>

  {#if v.hasSupport}
    <section data-sec="support" class="sec">
      {@render head(m.about_tab_support(), m.about_support_desc())}
      {@render links(v.supportLinks)}
    </section>
  {/if}

  {#if v.hasLegal}
    <section data-sec="legal" class="sec">
      {@render head(m.about_tab_legal(), m.about_legal_desc())}
      {@render links(v.legalLinks)}
    </section>
  {/if}

  <section data-sec="licenses" class="sec">
    {@render head(m.about_tab_licenses(), m.about_licenses_desc())}
    {@render links(v.licLinks, licRow)}
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

  /* Version: card with logo */
  .hero {
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 18px 22px;
    flex-wrap: wrap;
    padding: 24px 26px;
    border-radius: 26px;
    background: var(--accsoft);
  }

  .mobile .hero {
    margin-top: 16px;
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 0;
    text-align: center;
    padding: 26px 18px 22px;
    border-radius: 24px;
  }

  .logo-tile {
    overflow: hidden;
    width: 80px;
    height: 80px;
    flex-shrink: 0;
    border-radius: 26px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    box-shadow: var(--sh2);
    transform: rotate(calc(var(--logo-tilt, 1) * -6deg));
  }

  .mobile .logo-tile {
    width: 72px;
    height: 72px;
    border-radius: 24px;
  }

  .hero-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .app-name {
    font-family: var(--font-serif);
    font-size: 28px;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .mobile .app-name {
    margin-top: 16px;
    max-width: 100%;
    font-size: 24px;
    line-height: 1.2;
  }

  .app-version {
    margin-top: 5px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--deep);
  }

  .mobile .app-version {
    margin-top: 4px;
    font-size: 14px;
  }

  .m-org {
    max-width: 100%;
  }

  .org {
    margin-top: 3px;
    font-size: 14px;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .org-name {
    font-weight: 700;
  }

  .m-chip {
    margin-top: 14px;
    display: flex;
  }

  .chip {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 36px;
    padding: 0 15px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .chip-icon {
    display: grid;
    font-size: 18px;
    color: var(--deep);
  }

  /* Version, build, date, browser and system information */
  .box {
    margin-top: 12px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 10px;
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

  .mobile .row {
    gap: 16px;
    padding: 14px;
  }

  .row-k {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .row-k {
    font-size: 15px;
  }

  .row-v {
    font-size: 15px;
    font-weight: 600;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .mobile .row-v {
    font-size: 14.5px;
  }

  .sys {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 14px 14px 14px 18px;
    flex-wrap: wrap;
  }

  .mobile .sys {
    justify-content: normal;
    gap: 16px;
    padding: 12px 12px 12px 14px;
    flex-wrap: nowrap;
  }

  .sys-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .mobile .sys-text {
    flex: 1;
  }

  .sys-label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .sys-label {
    font-size: 15px;
  }

  .sys-desc {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .sys-desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .copy {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .copy:hover {
    transform: translateY(-2px);
  }

  .copy:active {
    transform: scale(0.96);
  }

  .copy-icon {
    display: grid;
    font-size: 17px;
  }

  /* Support, legal and licences */
  .links {
    margin-top: 18px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mobile .links {
    margin-top: 16px;
    border-radius: 24px;
    padding: 4px;
  }

  .link {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 16px 10px 10px;
    border-radius: 20px;
    color: var(--fg);
    text-decoration: none;
    transition: background-color var(--dur, 220ms);
  }

  .link:hover {
    background: var(--surface);
  }

  .mobile .link {
    gap: 13px;
    padding: 10px 12px 10px 10px;
    transition: none;
  }

  .mobile .link:hover {
    background: transparent;
  }

  .mobile .link:active {
    background: var(--hov);
  }

  .link-tile {
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 20px;
  }

  .mobile .link-tile {
    width: 38px;
    height: 38px;
    border-radius: 13px;
    font-size: 19px;
  }

  .link-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .mobile .link-text {
    gap: 2px;
  }

  .link-label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .link-label {
    font-size: 15px;
  }

  .link-sub {
    font-size: 13.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mobile .link-sub {
    font-size: 13px;
  }

  /* "All licenses": button in the style of the links, description without truncation. */
  .lic-row {
    width: 100%;
    text-align: left;
  }

  .lic-sub {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .mobile .lic-sub {
    font-size: 13px;
  }

  .tag {
    flex-shrink: 0;
    height: 28px;
    padding: 0 11px;
    border-radius: 9999px;
    background: var(--sunken);
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .arrow {
    display: grid;
    font-size: 18px;
    color: var(--mfg);
  }

  .mobile .arrow {
    font-size: 17px;
    color: var(--dim);
  }
</style>
