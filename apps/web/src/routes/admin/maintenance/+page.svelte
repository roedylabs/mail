<!--
  Administration › Maintenance: maintenance mode with notice, backups with
  schedule, storage with "Compact". Flow and values in
  `#lib/maintenance.svelte.ts`.

  - Until the first response only the header, after a short time the skeleton;
    on failure the card instead of tabs and sections.
  - **Download** is a link with `download`: the browser does the download,
    the session is in the cookie. On mobile the row has no download button,
    "Restore" is an icon there.
  - **Restore** only in maintenance mode: until then it is locked (on the
    desktop with a tooltip), and a notice above the list offers to turn
    maintenance mode on. An older backup without an authenticity value
    (`legacy`) stays locked with a tooltip of its own; its row says why.
  - The tile, button, switch and schedule styles are classes derived from
    `on` and the busy state of the respective button.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { timeZoneOf } from '#lib/errors.ts';
  import {
    MaintenancePage,
    maintenanceValues,
    type MaintenanceContext,
    type MtBusyButton,
    type MtSwitch,
  } from '#lib/maintenance.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  /** The backend's limit for the notice. */
  const MSG_MAX = 500;

  const p = new MaintenancePage();
  let root: HTMLElement | undefined = $state();

  const ctx: MaintenanceContext = {
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
  };

  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/maintenance'));
  const v = $derived(
    maintenanceValues(
      p,
      {
        now: Date.now(),
        tz: timeZoneOf(prefs.values),
        timeFmt: prefs.values.timeFmt,
        dateFmt: prefs.values.dateFmt,
      },
      ctx,
    ),
  );

  onMount(() => {
    void p.load();
    return () => p.dispose();
  });
</script>

{#snippet rowText(label: string, desc: string | null)}
  <div class="row-text">
    <div class="row-label">{label}</div>
    {#if desc}<div class="row-desc">{desc}</div>{/if}
  </div>
{/snippet}

{#snippet switchButton(label: string, t: MtSwitch)}
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

<!-- Content of a button with "Running …". -->
{#snippet busyContent(b: MtBusyButton)}
  <span class="busy-icon" style:--rot="{b.rot}deg"><Icon name={b.icon} /></span>{b.label}
{/snippet}

{#snippet backupButton()}
  <button
    type="button"
    class="now"
    class:busy={v.bkB.busy}
    aria-disabled={v.bkB.busy}
    aria-busy={v.bkB.busy}
    onclick={v.bkNow}>{@render busyContent(v.bkB)}</button
  >
{/snippet}

<!-- Frequency and retention; without "Back up automatically" locked for the keyboard too. -->
{#snippet segment(
  label: string,
  options: { value: string | number; label: string; on: boolean; onClick: () => void }[],
)}
  <div role="group" aria-label={label} class="seg">
    {#each options as o (o.value)}
      <button type="button" class:on={o.on} aria-pressed={o.on} disabled={!v.tgBkAuto.on} onclick={o.onClick}
        >{o.label}</button
      >
    {/each}
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

  {#if v.skSet}<Skeleton kind="set" set="list" {isMobile} note={m.loading_data()} />{/if}

  {#if v.mtLoad.fail}
    <MailLoadCard
      icon="ti-cloud-off"
      title={m.maintenance_load_failed()}
      text={v.mtLoad.text}
      load={{
        text: v.mtLoad.text,
        retry: true,
        reauth: false,
        con: false,
        onRetry: v.mtLoad.onRetry,
        goCon: () => {},
      }}
    />
  {/if}

  {#if v.mtLoad.ok}
    <div class="tabs no-scrollbar">
      {#each v.mtTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
    </div>

    <section data-sec="mode" class="sec first">
      <h2 class="sec-title">{m.maintenance_tab_mode()}</h2>
      <p class="sec-desc">{isMobile ? m.maintenance_mode_desc_mobile() : m.maintenance_mode_desc()}</p>
      <div class="box">
        <div class="mode-row">
          <span class="tile" class:active={v.tgMaint.on}><Icon name="ti-tool" /></span>
          {@render rowText(m.maintenance_tab_mode(), v.maintStatus)}
          {@render switchButton(m.maintenance_tab_mode(), v.tgMaint)}
        </div>
        <div class="sep"></div>
        <div class="msg">
          {#if isMobile}
            <label for="mt-msg" class="row-label">{m.maintenance_msg_title()}</label>
            <div class="row-desc">{m.maintenance_msg_desc_mobile()}</div>
          {:else}
            <div class="msg-head">
              <div class="row-text">
                <label for="mt-msg" class="row-label">{m.maintenance_msg_title()}</label>
                <div class="row-desc">{m.maintenance_msg_desc()}</div>
              </div>
              {#if v.maintCustom}
                <button type="button" class="reset" onclick={v.maintReset}>{m.maintenance_msg_reset()}</button>
              {/if}
            </div>
          {/if}
          <textarea
            id="mt-msg"
            value={v.maintMsg}
            rows={3}
            maxlength={MSG_MAX}
            oninput={(event) => v.onMaintMsg(event.currentTarget.value)}></textarea>
          {#if isMobile && v.maintCustom}
            <button type="button" class="reset" onclick={v.maintReset}>{m.maintenance_msg_reset_mobile()}</button>
          {/if}
        </div>
      </div>
    </section>

    <section data-sec="backups" class="sec">
      <h2 class="sec-title">{m.maintenance_tab_backups()}</h2>
      <p class="sec-desc">{v.bkSum}</p>
      {#if isMobile}
        <div class="bk-now">{@render backupButton()}</div>
      {:else}
        <div class="box">
          <div class="row">
            {@render rowText(m.maintenance_bk_now(), m.maintenance_bk_now_desc())}
            {@render backupButton()}
          </div>
        </div>
      {/if}

      <div class="box next">
        {#if v.bkMaint}
          <div class="bk-maint">
            <div class="bk-maint-main">
              <span class="tile"><Icon name="ti-tool" /></span>
              <span class="item-text">
                <span class="item-title">{m.maintenance_bk_maint_title()}</span>
                <span class="item-sub bk-maint-desc">{m.maintenance_bk_maint_desc()}</span>
              </span>
              {#if !isMobile}
                <button type="button" class="restore" onclick={v.bkMaintOn}>{m.maintenance_bk_maint_on()}</button>
              {/if}
            </div>
            {#if isMobile}
              <button type="button" class="bk-maint-on" onclick={v.bkMaintOn}>{m.maintenance_bk_maint_on()}</button>
            {/if}
          </div>
          <div class="sep"></div>
        {/if}
        {#each v.bkRows as b (b.id)}
          <div>
            {#if b.sep}<div class="sep"></div>{/if}
            <div class="bk-row">
              <span class="tile"><Icon name={b.icon} /></span>
              <span class="item-text">
                <span class="item-title clip">{b.title}</span>
                <span class="item-sub">{b.sub}</span>
              </span>
              {#if isMobile}
                <button
                  type="button"
                  class="icon-btn"
                  class:locked={b.rs.dis}
                  aria-label={m.maintenance_bk_restore()}
                  aria-disabled={b.rs.dis}
                  onclick={b.onRestore}><Icon name="ti-history" /></button
                >
              {:else}
                <!-- eslint-disable svelte/no-navigation-without-resolve -- API path, not a route of the app -->
                <a
                  class="icon-btn"
                  href={b.href}
                  download
                  aria-label={m.maintenance_bk_download_label()}
                  use:tooltip={m.maintenance_bk_download_label()}
                  onclick={b.onDownload}><Icon name="ti-download" /></a
                >
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
                <button
                  type="button"
                  class="restore"
                  class:locked={b.rs.dis}
                  aria-disabled={b.rs.dis}
                  use:tooltip={b.rs.tip}
                  onclick={b.onRestore}>{m.maintenance_bk_restore()}</button
                >
              {/if}
              <button
                type="button"
                class="icon-btn remove"
                aria-label={m.maintenance_bk_remove()}
                use:tooltip={isMobile ? undefined : m.maintenance_bk_remove()}
                onclick={b.onRemove}><Icon name="ti-trash" /></button
              >
            </div>
          </div>
        {/each}
        {#if v.bkEmpty}<div class="empty">{m.maintenance_bk_none()}</div>{/if}
      </div>

      <div class="box next">
        <div class="row toggle">
          {@render rowText(m.maintenance_bk_auto_title(), v.bkNext)}
          {@render switchButton(m.maintenance_bk_auto_title(), v.tgBkAuto)}
        </div>
        <div class="sep"></div>
        <!-- Dimmed only while locked: the row carries `aria-disabled` so that title and
             description count as part of the inactive selection (WCAG 1.4.3; axe in the E2E suite). -->
        <div class="row" class:dim={!v.tgBkAuto.on} role="group" aria-disabled={!v.tgBkAuto.on || undefined}>
          {@render rowText(m.maintenance_bk_every_title(), isMobile ? null : m.maintenance_bk_every_desc())}
          {@render segment(m.maintenance_bk_every_title(), v.bkEveryOpts)}
        </div>
        <div class="sep"></div>
        <div class="row" class:dim={!v.tgBkAuto.on} role="group" aria-disabled={!v.tgBkAuto.on || undefined}>
          {@render rowText(m.maintenance_bk_keep_title(), m.maintenance_bk_keep_desc())}
          {@render segment(m.maintenance_bk_keep_title(), v.bkKeepOpts)}
        </div>
      </div>
    </section>

    <section data-sec="storage" class="sec">
      <h2 class="sec-title">{m.maintenance_tab_storage()}</h2>
      <p class="sec-desc">{m.maintenance_st_lead()}</p>
      <div class="box">
        {#each v.stRows as r (r.icon)}
          <div>
            {#if r.sep}<div class="sep"></div>{/if}
            <div class="st-row">
              <span class="tile st"><Icon name={r.icon} /></span>
              <span class="item-text st">
                <span class="item-title">{r.label}</span>
                <span class="item-sub clip">{r.sub}</span>
              </span>
              <span class="st-size">{r.size}</span>
            </div>
          </div>
        {/each}
        <div class="sep"></div>
        <div class="row compact-row">
          <div class="row-text">
            <div class="row-label">{m.maintenance_st_compact()}</div>
            <div class="row-desc">{v.stDesc}</div>
          </div>
          <button
            type="button"
            class="compact"
            class:busy={v.stB.busy}
            aria-disabled={v.stB.busy}
            aria-busy={v.stB.busy}
            onclick={v.stCompact}>{@render busyContent(v.stB)}</button
          >
        </div>
      </div>
    </section>
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
    transition: none;
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Sections */
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

  .box.next,
  .mobile .box.next {
    margin-top: 12px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  /* Rows: on desktop label left, control right; stacked on mobile */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
    transition: opacity var(--dur, 220ms);
  }

  .mobile .row {
    display: block;
    padding: 14px 14px 12px;
  }

  /* Dimmed while automatic backups are off */
  .row.dim {
    opacity: 0.5;
    pointer-events: none;
  }

  .mobile .row.toggle {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px;
  }

  .row-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .mobile .row.toggle .row-text,
  .mode-row .row-text {
    flex: 1;
  }

  .compact-row .row-text {
    flex-basis: 260px;
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

  .compact-row .row-desc {
    line-height: 1.5;
    text-wrap: pretty;
  }

  .mobile .compact-row .row-desc {
    text-wrap: wrap;
  }

  /* Tile of a row */
  .tile {
    position: relative;
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

  .tile.active {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .tile.st {
    font-size: 20px;
  }

  .mobile .tile {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 20px;
  }

  .mobile .tile.st {
    font-size: 19px;
  }

  /* Maintenance mode */
  .mode-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px 10px 10px;
  }

  .mobile .mode-row {
    gap: 12px;
    padding: 10px 12px 10px 10px;
  }

  .msg {
    padding: 16px 18px 18px;
  }

  .mobile .msg {
    padding: 14px 14px 12px;
  }

  .msg-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }

  .msg-head .row-text {
    flex: 1;
  }

  .reset {
    height: 34px;
    flex-shrink: 0;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .reset:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .reset {
    width: 100%;
    margin-top: 8px;
    height: 44px;
    padding: 0;
    font-size: 14.5px;
  }

  .mobile .reset:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .reset:active {
    background: var(--hov);
  }

  textarea {
    display: block;
    width: 100%;
    margin-top: 12px;
    padding: 14px 18px;
    border: 0;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14.5px;
    font-weight: 600;
    line-height: 1.5;
    resize: vertical;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  textarea:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile textarea {
    padding: 14px 16px;
    font-size: 16px;
  }

  /* Buttons with "Running …": `bkB.cur`, `stB.cur` */
  .now,
  .compact {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border-radius: 9999px;
    white-space: nowrap;
  }

  .now.busy,
  .compact.busy {
    cursor: progress;
  }

  .now {
    height: 44px;
    padding: 0 20px 0 16px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    /* Fixed shadow */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
  }

  .mobile .now {
    width: 100%;
    height: 48px;
    padding: 0;
    font-size: 15px;
  }

  .compact {
    height: 42px;
    padding: 0 18px 0 14px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
  }

  .mobile .compact {
    width: 100%;
    height: 46px;
    margin-top: 12px;
    padding: 0;
    font-size: 15px;
  }

  /* Rotates by `bkB.rot` or `stB.rot` degrees; without animations `--dur` is 0. */
  .busy-icon {
    display: grid;
    font-size: 18px;
    transform: rotate(var(--rot));
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  .bk-now {
    margin-top: 16px;
  }

  /* Rows of the backups and the storage */
  .bk-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px;
  }

  .mobile .bk-row {
    gap: 12px;
    padding: 8px 4px 8px 10px;
  }

  .st-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px 10px 10px;
  }

  .mobile .st-row {
    gap: 12px;
    padding: 8px 14px 8px 10px;
  }

  .item-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .mobile .item-text.st {
    gap: 2px;
  }

  .item-title {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .item-title {
    font-size: 15px;
  }

  .bk-row .item-title {
    font-variant-numeric: tabular-nums;
  }

  .item-sub {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .mobile .item-text.st .item-sub {
    font-size: 13px;
  }

  .clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .st-size {
    flex-shrink: 0;
    font-size: 15px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .mobile .st-size {
    font-size: 14.5px;
  }

  .icon-btn {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .icon-btn:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .icon-btn.remove:hover {
    color: var(--danger);
  }

  .mobile .icon-btn {
    width: 44px;
    height: 44px;
    font-size: 19px;
    transition: none;
  }

  .mobile .icon-btn:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .icon-btn:active {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .icon-btn.remove:active {
    color: var(--danger);
  }

  .restore {
    height: 38px;
    flex-shrink: 0;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      opacity var(--dur, 220ms);
  }

  .restore:hover {
    transform: translateY(-2px);
  }

  /* "Restore" outside maintenance mode: dimmed, without hover; on mobile not even tappable */
  .restore.locked {
    opacity: 0.5;
    cursor: default;
  }

  .restore.locked:hover {
    transform: none;
  }

  .mobile .icon-btn.locked {
    opacity: 0.5;
    pointer-events: none;
  }

  /* Notice above the list: restore only in maintenance mode */
  .bk-maint-main {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px;
  }

  .bk-maint-desc {
    text-wrap: pretty;
  }

  .mobile .bk-maint {
    padding: 8px 10px 12px;
  }

  .mobile .bk-maint-main {
    gap: 12px;
    padding: 0;
  }

  .mobile .bk-maint-desc {
    line-height: 1.5;
    text-wrap: wrap;
  }

  .bk-maint-on {
    width: 100%;
    margin-top: 12px;
    height: 46px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
  }

  .bk-maint-on:active {
    transform: scale(0.98);
  }

  .empty {
    padding: 16px 18px;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .empty {
    padding: 14px;
    font-size: 14px;
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

  /* Frequency and retention */
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
</style>
