<!--
  Settings › Language & region: language, region with country and time zone
  as pick lists and formats with preview and segments, plus section tabs.
  Values in `#lib/language.ts`; saved via `prefs.set()`. The pick lists are
  popovers at the button on desktop (`ui.menu = 'pick'`, Escape and a click
  outside close via the layout), on mobile the layout shows the pick list in
  the sheet (`ui.pick`). Card, ring, chevron and switch styles are classes
  derived from `on`, `open`, `disabled` and `hi`.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount } from 'svelte';
  import type { SegOption } from '#lib/appearance.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { languageValues, type LanguageContext, type SelectKey, type SelectValues } from '#lib/language.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pickPop, selIds, selKey, type SelIds } from '#lib/select.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { browserTimeZone, prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const uid = $props.id();
  /** Open pick list while `ui.menu` is `pick`. */
  let sel = $state<SelectKey | null>(null);
  /** Highlighted row of the open list. */
  let hi = $state<number | null>(null);
  /** Clock for preview, date formats and time zone abbreviations (day change, daylight saving time). */
  let now = $state(Date.now());

  const ctx: LanguageContext = {
    set: (patch) => prefs.set(patch),
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    show: (key) => {
      hi = null;
      if (key) {
        sel = key;
        ui.menu = 'pick';
      } else if (ui.menu === 'pick') ui.closeMenu();
    },
    mark: (i) => {
      hi = i;
    },
  };
  const v = $derived(
    languageValues(
      {
        values: prefs.values,
        browserLang: prefs.browserLang,
        appName: session.appName,
        now,
        deviceTz: browserTimeZone(),
        open: ui.menu === 'pick' ? sel : null,
        hi,
        isMobile: ui.isMobile,
      },
      ctx,
    ),
  );
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/language'));

  type SegKind = 'text' | 'date' | 'num';

  onMount(() => {
    const clock = setInterval(() => (now = Date.now()), 30_000);
    // On mobile the layout shows country or time zone as a sheet.
    ui.pick = () => (sel === 'tz' ? v.selTz : v.selRegion);
    return () => {
      clearInterval(clock);
      if (ui.menu === 'pick') ui.closeMenu();
      ui.pick = null;
    };
  });
</script>

<!-- Date and numbers with equal-width digits, the date slightly smaller on mobile. -->
{#snippet segment(label: string, opts: readonly SegOption<string>[], kind: SegKind)}
  <div
    role="radiogroup"
    use:radiogroup
    aria-label={label}
    class="seg"
    class:num={kind !== 'text'}
    class:date={kind === 'date'}
  >
    {#each opts as o (o.value)}
      <button type="button" role="radio" aria-checked={o.on} class:on={o.on} onclick={o.onClick}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet segRow(label: string, desc: string, opts: readonly SegOption<string>[], kind: SegKind = 'text')}
  <div class="row wrap">
    <div class="row-text">
      <div class="row-label">{label}</div>
      <div class="row-desc">{desc}</div>
    </div>
    {@render segment(label, opts, kind)}
  </div>
{/snippet}

<!-- Name of the button: label of the row and selected value; select-only combobox on desktop, button for the sheet on mobile. -->
{#snippet select(s: SelectValues, ids: SelIds)}
  <div class="pick" class:disabled={s.disabled} data-pop>
    <button
      type="button"
      class="pick-btn"
      class:open={s.open}
      onclick={s.toggle}
      onkeydown={selKey(s.onKey)}
      onkeyup={(event) => s.onKeyUp(event)}
      role={isMobile ? undefined : 'combobox'}
      aria-haspopup={isMobile ? 'dialog' : undefined}
      aria-expanded={isMobile ? undefined : s.open}
      aria-controls={s.open ? ids.list : undefined}
      aria-activedescendant={s.open && s.opts[s.active] ? ids.opt(s.active) : undefined}
      aria-disabled={s.disabled}
      aria-labelledby={ids.labelledby}
    >
      <span class="pick-label" id={ids.value}>{s.label}</span>
      <span class="chev"><Icon name="ti-chevron-down" /></span>
    </button>
    {#if s.open}
      <div
        role="listbox"
        id={ids.list}
        aria-label={s.title}
        class="pick-pop no-scrollbar"
        use:pickPop
        {@attach scrollbar}
      >
        {#each s.opts as o, i (o.label)}
          <button
            type="button"
            role="option"
            id={ids.opt(i)}
            aria-selected={o.on}
            tabindex="-1"
            class="opt"
            class:hi={o.hi}
            class:on={o.on}
            onclick={o.onClick}
            onmousemove={o.hover}
          >
            <span class="opt-text">
              <span class="opt-label" style:font-weight={o.fw}>{o.label}</span>
              {#if o.hasSub}<span class="opt-sub">{o.sub}</span>{/if}
            </span>
            <span class="opt-check"><Icon name="ti-check" /></span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet selectRow(label: string, desc: string, s: SelectValues, key: string)}
  {@const ids = selIds(uid, key)}
  <div class="row wrap">
    <div class="row-text">
      <div class="row-label" id={ids.label}>{label}</div>
      <div class="row-desc">{desc}</div>
    </div>
    {@render select(s, ids)}
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
    {#each v.langTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="lang" class="sec">
    <h2>{m.region_tab_lang()}</h2>
    <p class="sec-desc">{m.region_lang_desc()}</p>
    <div role="radiogroup" aria-label={m.region_tab_lang()} use:radiogroup={{ select: false }} class="langs">
      {#each v.langOpts as l (l.id)}
        <button type="button" role="radio" aria-checked={l.on} class="lang" class:on={l.on} onclick={l.onClick}>
          <span class="tile" class:icon={!l.code}
            >{#if l.code}{l.code}{:else}<Icon name="ti-world" />{/if}</span
          >
          <span class="lang-text">
            <!-- "System" is a word of the interface, the languages are named in themselves (WCAG 3.1.2). -->
            <span class="lang-name" lang={l.code ? l.id : undefined}>{l.name}</span>
            {#if l.hasSub}<span class="lang-sub">{l.sub}</span>{/if}
          </span>
          <span class="check"><Icon name="ti-check" /></span>
        </button>
      {/each}
    </div>
    {#if v.systemNote}<p class="lang-note">{v.systemNote}</p>{/if}
  </section>

  <section data-sec="region" class="sec">
    <h2>{m.region_tab_region()}</h2>
    <p class="sec-desc">{m.region_region_desc()}</p>
    <div class="box">
      {@render selectRow(m.region_country_title(), m.region_country_desc(), v.selRegion, 'region')}
      <div class="sep"></div>
      <div class="row toggle">
        <div class="row-text">
          <div class="row-label">{m.region_tz_auto()}</div>
          <div class="row-desc">{m.region_tz_auto_desc()}</div>
        </div>
        <button
          type="button"
          role="switch"
          class="switch"
          class:on={v.tgTzAuto.on}
          aria-checked={v.tgTzAuto.on}
          aria-label={m.region_tz_auto()}
          onclick={v.tgTzAuto.onClick}><span class="knob"></span></button
        >
      </div>
      <div class="sep"></div>
      {@render selectRow(m.region_tz_title(), m.region_tz_desc(), v.selTz, 'tz')}
    </div>
  </section>

  <section data-sec="formats" class="sec">
    <h2>{m.region_tab_formats()}</h2>
    <p class="sec-desc">{m.region_formats_desc()}</p>
    <div class="preview">
      {#each v.fmtPreview as p (p.k)}
        <div class="pv">
          <div class="pv-k">{p.k}</div>
          <div class="pv-v">{p.v}</div>
        </div>
      {/each}
    </div>
    <div class="box fmt-box">
      {@render segRow(m.region_date_fmt(), m.region_date_fmt_desc(), v.dateOpts, 'date')}
      <div class="sep"></div>
      {@render segRow(m.region_time_fmt(), m.region_time_fmt_desc(), v.timeOpts)}
      <div class="sep"></div>
      {@render segRow(m.region_week_start(), m.region_week_start_desc(), v.weekOpts)}
      <div class="sep"></div>
      {@render segRow(m.region_num_fmt(), m.region_num_fmt_desc(), v.numOpts, 'num')}
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

  /* Language */
  .langs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-top: 18px;
  }

  .mobile .langs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .lang {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 64px;
    padding: 10px 14px 10px 10px;
    border-radius: 22px;
    background: var(--surface2);
    text-align: left;
    transition:
      box-shadow var(--dur, 220ms),
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .lang.on {
    background: var(--surface);
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh2);
  }

  .page:not(.mobile) .lang:hover {
    transform: translateY(-3px);
  }

  .mobile .lang {
    min-height: 60px;
    padding: 8px 16px 8px 8px;
    transition:
      box-shadow var(--dur, 220ms),
      background-color var(--dur, 220ms);
  }

  .tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    color: var(--fg);
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 15px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tile.icon {
    font-size: 20px;
  }

  .lang.on .tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .lang-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lang-name {
    font-size: 15.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lang-sub {
    font-size: 13px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile .lang-name,
  .mobile .lang-sub {
    overflow: visible;
    white-space: normal;
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

  .lang.on .check {
    background: var(--ink);
    border: 0;
  }

  .lang.on .check :global(svg) {
    opacity: 1;
  }

  .lang-note {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--mfg);
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

  .box.fmt-box {
    margin-top: 12px;
  }

  .mobile .box.fmt-box {
    margin-top: 10px;
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

  .mobile .row.toggle {
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

  /* Pick list (mkSel) */
  .pick {
    position: relative;
    flex: 0 1 280px;
    min-width: 0;
    transition: opacity var(--dur, 220ms);
  }

  .pick.disabled {
    opacity: 0.5;
  }

  .mobile .pick {
    margin-top: 12px;
  }

  .pick-btn {
    width: 100%;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    text-align: left;
    transition: box-shadow var(--dur, 220ms);
  }

  .pick-btn.open {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .pick.disabled .pick-btn {
    cursor: default;
  }

  .mobile .pick-btn {
    height: 46px;
    padding: 0 14px 0 16px;
    font-size: 14.5px;
  }

  .pick-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chev {
    display: grid;
    font-size: 16px;
    color: var(--mfg);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .pick-btn.open .chev {
    transform: rotate(180deg);
  }

  .pick-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 30;
    width: 100%;
    min-width: 260px;
    max-height: 300px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    box-shadow: var(--sh3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform-origin: top center;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .opt {
    flex-shrink: 0;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 10px 7px 14px;
    border-radius: 15px;
    text-align: left;
    transition: background-color 120ms;
  }

  .opt.hi {
    background: var(--hov);
  }

  .opt-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .opt-label {
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .opt-sub {
    font-size: 12.5px;
    color: var(--mfg);
  }

  .opt-check {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 13px;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .opt-check :global(svg) {
    opacity: 0;
  }

  .opt.on .opt-check {
    background: var(--ink);
  }

  .opt.on .opt-check :global(svg) {
    opacity: 1;
  }

  /* Preview of the formats */
  .preview {
    margin-top: 18px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px 20px;
    padding: 20px 24px;
    border-radius: 26px;
    background: var(--accsoft);
  }

  .mobile .preview {
    display: block;
    margin-top: 16px;
    padding: 6px 18px;
    border-radius: 24px;
  }

  .pv {
    min-width: 0;
  }

  .mobile .pv {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 11px 0;
  }

  .pv-k {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--deep);
  }

  .mobile .pv-k {
    font-size: 13px;
  }

  .pv-v {
    margin-top: 4px;
    font-family: var(--font-serif);
    font-size: 24px;
    line-height: 1.2;
    white-space: nowrap;
  }

  .mobile .pv-v {
    margin-top: 0;
    font-size: 19px;
    line-height: normal;
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

  .seg.num button {
    font-variant-numeric: tabular-nums;
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

  .mobile .seg.date button {
    font-size: 13px;
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
