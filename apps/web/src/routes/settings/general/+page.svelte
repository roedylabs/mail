<!--
  Settings › General: start with "Open on startup", behaviour (confirmations,
  undo notice, keyboard shortcuts only on desktop), swipe gestures, external
  content, data (export, delete local data) and delete account, plus section
  tabs. Values and actions in `#lib/general.svelte.ts`; "External content"
  with values and undo from `#lib/mail/remote-content.ts`. The pick lists
  are popovers at the button on desktop (`ui.menu = 'pick'`), on mobile the
  layout shows the pick list in the sheet (`ui.pick`). The layout shows the
  "Permanently delete account?" or "Clear local data?" dialog (`ui.ask`).
  Ring, chevron, cursor and switch styles are classes derived from `open`,
  `on`, `hi`, `busy`, `locked` and `dim`.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import {
    general,
    generalValues,
    type BusyButton,
    type GeneralContext,
    type GeneralSelect,
  } from '#lib/general.svelte.ts';
  import { EXT_MODES, extListNote, extModeLabel, extSummary, removeSender } from '#lib/mail/remote-content.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pickPop, selIds, selKey, type SelIds, type SelectValues } from '#lib/select.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const uid = $props.id();
  /** Open pick list while `ui.menu` is `pick`. */
  let sel = $state<GeneralSelect | null>(null);
  /** Highlighted row of the open list. */
  let hi = $state<number | null>(null);

  const ctx: GeneralContext = {
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
    generalValues(
      {
        values: prefs.values,
        soleAdmin: session.user?.sole_admin ?? false,
        localBytes: general.localBytes,
        clearing: general.clearing,
        deleting: general.deleting,
        open: ui.menu === 'pick' ? sel : null,
        hi,
        isMobile: ui.isMobile,
      },
      ctx,
    ),
  );
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/general'));
  const userEmail = $derived(session.user?.email ?? '');

  const extMode = $derived(prefs.values.extMode);
  const extSum = $derived(extSummary(extMode));
  const extOpts = $derived(
    EXT_MODES.map((mode) => {
      const on = mode === extMode;
      return {
        mode,
        label: extModeLabel(mode),
        on,
        shadow: on ? 'var(--sh1)' : 'none',
        onClick: () => prefs.set({ extMode: mode }),
      };
    }),
  );
  const extListNoteText = $derived(extListNote(extMode));
  /** The list only applies with "Ask". */
  const extListDim = $derived(extMode !== 'ask');
  const extRows = $derived(
    prefs.values.extAllow.map((email) => ({
      email,
      ini: (email[0] ?? '?').toUpperCase(),
      rmLabel: m.ext_remove_label({ email }),
      rm: () => removeSender(email),
    })),
  );
  const extEmpty = $derived(extRows.length === 0);

  onMount(() => {
    // Storage on the device for "Clear local data", `sole_admin` fresh from `auth/me`.
    void general.open();
    // On mobile the layout shows the open pick list as a sheet.
    ui.pick = () => (sel === 'swL' ? v.selSwL : sel === 'swR' ? v.selSwR : v.selStart);
    return () => {
      if (ui.menu === 'pick') ui.closeMenu();
      ui.pick = null;
    };
  });
</script>

{#snippet rowText(label: string, desc: string, id?: string)}
  <div class="row-text">
    <div class="row-label" {id}>{label}</div>
    <div class="row-desc">{desc}</div>
  </div>
{/snippet}

{#snippet toggleRow(label: string, desc: string, t: { on: boolean; onClick: () => void })}
  <div class="row wrap toggle">
    {@render rowText(label, desc)}
    <button
      type="button"
      role="switch"
      class="switch"
      class:on={t.on}
      aria-checked={t.on}
      aria-label={label}
      onclick={t.onClick}><span class="knob"></span></button
    >
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
      <div role="listbox" id={ids.list} aria-label={s.title} class="pick-pop no-scrollbar" use:pickPop>
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
    {@render rowText(label, desc, ids.label)}
    {@render select(s, ids)}
  </div>
{/snippet}

<!-- Button with an icon that spins during the operation (`bz`: `ti-loader-2`, cursor `progress`). -->
{#snippet busyRow(label: string, desc: string, b: BusyButton, onclick: () => void, dim = false)}
  <div class="row wrap">
    {@render rowText(label, desc)}
    <button type="button" class="act" class:busy={b.busy} class:dim aria-disabled={b.busy} aria-busy={b.busy} {onclick}
      ><span class="act-icon" class:spin={b.busy}><Icon name={b.icon} /></span>{b.label}</button
    >
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
    {#each v.genTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="start" class="sec first">
    <h2 class="sec-title">{m.general_tab_start()}</h2>
    <p class="sec-desc">{m.general_start_desc()}</p>
    <div class="box">
      {@render selectRow(m.general_start_title(), m.general_start_row_desc(), v.selStart, 'start')}
    </div>
  </section>

  <section data-sec="behavior" class="sec">
    <h2 class="sec-title">{m.general_tab_behavior()}</h2>
    <p class="sec-desc">{m.general_behavior_desc()}</p>
    <div class="box">
      {@render toggleRow(
        m.general_confirm(),
        isMobile ? m.general_confirm_desc_mobile() : m.general_confirm_desc(),
        v.tgConfirm,
      )}
      <div class="sep"></div>
      <div class="row wrap">
        {@render rowText(m.general_undo(), m.general_undo_desc())}
        <div role="radiogroup" use:radiogroup aria-label={m.general_undo()} class="seg undo">
          {#each v.undoOpts as o (o.value)}
            <button type="button" role="radio" aria-checked={o.on} class:on={o.on} onclick={o.onClick}>{o.label}</button
            >
          {/each}
        </div>
      </div>
      {#if !isMobile}
        <!-- Single keys do not exist on mobile: the row is missing there. -->
        <div class="sep"></div>
        {@render toggleRow(m.general_keys(), m.general_keys_desc(), v.tgKeys)}
      {/if}
    </div>
  </section>

  <section data-sec="swipe" class="sec">
    <h2 class="sec-title">{m.general_tab_swipe()}</h2>
    <p class="sec-desc">{isMobile ? m.general_swipe_desc_mobile() : m.general_swipe_desc()}</p>
    <div class="box">
      {@render selectRow(
        m.general_swipe_left(),
        isMobile ? m.general_swipe_left_desc_mobile() : m.general_swipe_left_desc(),
        v.selSwL,
        'swL',
      )}
      <div class="sep"></div>
      {@render selectRow(
        m.general_swipe_right(),
        isMobile ? m.general_swipe_right_desc_mobile() : m.general_swipe_right_desc(),
        v.selSwR,
        'swR',
      )}
    </div>
  </section>

  <section data-sec="ext" class="sec">
    <h2 class="sec-title">{m.ext_title()}</h2>
    <p class="sec-desc">{isMobile ? m.ext_desc_mobile() : m.ext_desc()}</p>
    <div class="box">
      <div class="mode-row">
        <div class="row-text">
          <div class="row-label">{m.ext_setting()}</div>
          <div class="row-desc sum">{extSum}</div>
        </div>
        <div role="radiogroup" use:radiogroup aria-label={m.ext_setting()} class="seg">
          {#each extOpts as o (o.mode)}
            <button
              type="button"
              role="radio"
              aria-checked={o.on}
              class:on={o.on}
              style:box-shadow={o.shadow}
              onclick={o.onClick}>{o.label}</button
            >
          {/each}
        </div>
      </div>
      <div class="sep"></div>
      <div class="list-head" class:dim={extListDim}>
        <div class="row-label">{m.ext_list()}</div>
        <div class="list-note">{extListNoteText}</div>
      </div>
      <div class="list" class:dim={extListDim}>
        {#each extRows as r (r.email)}
          <div class="ext-row">
            <span class="ini">{r.ini}</span>
            <span class="email">{r.email}</span>
            <button
              type="button"
              class="rm"
              aria-label={r.rmLabel}
              use:tooltip={isMobile ? undefined : m.ext_remove()}
              onclick={r.rm}><Icon name="ti-x" /></button
            >
          </div>
        {/each}
        {#if extEmpty}
          <div class="empty">{isMobile ? m.ext_empty_mobile() : m.ext_empty()}</div>
        {/if}
      </div>
    </div>
  </section>

  <section data-sec="data" class="sec">
    <h2 class="sec-title">{m.general_tab_data()}</h2>
    <p class="sec-desc">{m.general_data_desc()}</p>
    <div class="box">
      {@render busyRow(m.general_export_title(), m.general_export_desc(), v.exportB, () => general.doExport())}
      <div class="sep"></div>
      {@render busyRow(m.general_local_title(), v.localSum, v.localB, () => general.clearLocal(), v.localDim)}
    </div>
  </section>

  <section data-sec="danger" class="sec">
    <h2 class="sec-title">{m.general_tab_danger()}</h2>
    <p class="sec-desc">{m.general_danger_desc()}</p>
    <div class="danger">
      <div class="danger-text">
        <div class="danger-email">{userEmail}</div>
        <div class="danger-sub">{v.delSub}</div>
        {#if v.soleAdm}
          <a class="users" href={resolve('/admin/users')}>{m.general_delete_users()}<Icon name="ti-arrow-right" /></a>
        {/if}
      </div>
      <button
        type="button"
        class="del"
        class:locked={v.soleAdm}
        class:busy={v.delB.busy}
        aria-disabled={v.delB.dis}
        aria-busy={v.delB.busy}
        use:tooltip={v.delTip}
        onclick={() => general.deleteAccount()}>{v.delB.label}</button
      >
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

  .sec.first {
    margin-top: 36px;
  }

  .mobile .sec {
    margin-top: 34px;
  }

  .mobile .sec.first {
    margin-top: 28px;
  }

  .sec-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile .sec-title {
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
    margin: 0 18px;
    background: var(--bd);
  }

  .mobile .sep {
    margin: 0 14px;
  }

  /* Row with label and control */
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

  .mobile .row.wrap {
    display: block;
    padding: 14px 14px 12px;
  }

  .mobile .row.toggle {
    display: flex;
    flex-wrap: nowrap;
    justify-content: flex-start;
    gap: 16px;
    padding: 14px;
  }

  .row-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .mobile .row.toggle .row-text {
    flex: 1;
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

  .row-desc.sum {
    text-wrap: pretty;
  }

  .mobile .row-desc.sum {
    line-height: 1.45;
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
    font-size: 15px;
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

  .mobile .chev {
    font-size: 17px;
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
    min-width: 240px;
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

  /* Setting with segment (external content) */
  .mode-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    flex-wrap: wrap;
    padding: 16px 18px;
  }

  .mobile .mode-row {
    display: block;
    padding: 14px 14px 12px;
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
  }

  .seg.undo button.on {
    box-shadow: var(--sh1);
  }

  .mobile .seg button {
    flex: 1;
    min-width: 0;
    height: 38px;
    padding: 0;
    font-size: 13.5px;
    transition: none;
  }

  .mobile .seg.undo button {
    height: 36px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .seg button:hover:not(.on) {
    color: var(--mfg);
  }

  /* Allowed senders */
  .list-head,
  .list {
    transition: opacity var(--dur, 220ms);
  }

  .mobile .list-head,
  .mobile .list {
    transition: none;
  }

  .dim {
    opacity: 0.5;
  }

  .list-head {
    padding: 16px 18px 8px;
  }

  .mobile .list-head {
    padding: 14px 14px 6px;
  }

  .list-note {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .list-note {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .list {
    padding: 0 6px 6px;
  }

  .mobile .list {
    padding: 0 4px 4px;
  }

  .ext-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 6px 8px 12px;
    border-radius: 16px;
  }

  .ext-row:hover {
    background: var(--hov);
  }

  .mobile .ext-row {
    padding: 6px 2px 6px 10px;
    border-radius: 0;
  }

  .mobile .ext-row:hover {
    background: none;
  }

  .ini {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 800;
  }

  .email {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rm {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 17px;
    color: var(--mfg);
  }

  .rm:hover {
    background: var(--hov);
    color: var(--danger);
  }

  .mobile .rm {
    width: 44px;
    height: 44px;
    font-size: 18px;
  }

  .mobile .rm:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .rm:active {
    background: var(--hov);
  }

  .empty {
    padding: 6px 12px 10px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .empty {
    padding: 6px 10px 10px;
    font-size: 13.5px;
    line-height: 1.45;
  }

  /* Data: buttons with icon */
  .act {
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
  }

  .act.busy {
    cursor: progress;
  }

  .mobile .act {
    width: 100%;
    height: 46px;
    margin-top: 12px;
    padding: 0;
    font-size: 15px;
  }

  .act-icon {
    display: grid;
    font-size: 18px;
  }

  /* Spins while the operation runs; without animations it stands still (`--spin: none`). */
  .act-icon.spin {
    animation: var(--spin, none);
  }

  /* Delete account */
  .danger {
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 12px 18px;
    flex-wrap: wrap;
    padding: 18px 18px 18px 22px;
    border-radius: 26px;
    background: color-mix(in oklab, var(--danger) 9%, var(--surface2));
  }

  .mobile .danger {
    display: block;
    margin-top: 16px;
    padding: 16px;
    border-radius: 24px;
  }

  .danger-text {
    flex: 1 1 260px;
    min-width: 0;
  }

  .danger-email {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .danger-email {
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  .danger-sub {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .danger-sub {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .users {
    margin-top: 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .users :global(svg) {
    font-size: 15px;
  }

  .mobile .users {
    min-height: 44px;
    margin-top: 2px;
    font-size: 14.5px;
  }

  .mobile .users :global(svg) {
    font-size: 16px;
  }

  .del {
    height: 44px;
    padding: 0 20px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--danger);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    transition:
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      opacity var(--dur, 220ms);
  }

  .page:not(.mobile) .del:not(.locked, .busy):hover {
    transform: translateY(-2px);
  }

  .del.locked {
    opacity: 0.5;
    cursor: default;
  }

  .del.busy {
    cursor: progress;
  }

  .mobile .del {
    width: 100%;
    margin-top: 14px;
    height: 46px;
    padding: 0;
    font-size: 15px;
    transition: none;
  }
</style>
