<!--
  Administration › Updates: status with "Check now", source with access
  token, schedule and display. Flow and values in `#lib/updates.svelte.ts`.

  - Until the first response the skeleton below the header, on failure the
    card instead of tabs and sections.
  - **Time picker**: field with input and clock; on desktop a popover at the
    field while `ui.menu` is `time` (Escape and a click outside close via the
    layout, `data-pop`), on mobile the sheet via `ui.pageDialog`.
  - Card, tile, button, switch and schedule styles are classes derived from
    the status flags (`upBad`, `upBusy`, `upEvOff`), the token state
    (`pat.invalid`, `pat.saveOn`, `pat.saveBusy`) and `on`.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import { buildInfo } from '#lib/build-info.ts';
  import { copyText } from '#lib/clipboard.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import TimePicker from '#lib/components/TimePicker.svelte';
  import { timeZoneOf } from '#lib/errors.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import type { TimePickValues } from '#lib/time-picker.ts';
  import { UpdatesPage, updatesValues, type UpdatesContext, type UpSrcRow } from '#lib/updates.svelte.ts';

  const p = new UpdatesPage();
  let root: HTMLElement | undefined = $state();

  const ctx: UpdatesContext = {
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    copy: copyText,
    notify: (text) => ui.toasts.show(text),
  };

  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/updates'));
  const v = $derived(
    updatesValues(
      p,
      {
        now: Date.now(),
        tz: timeZoneOf(prefs.values),
        timeFmt: prefs.values.timeFmt,
        build: buildInfo.sha,
        isMobile,
      },
      ctx,
    ),
  );
  /** Time picker in the mobile sheet. */
  const sheetTime = $derived(isMobile && p.timeOpen ? v.upTimeSel : null);

  onMount(() => {
    void p.load();
    ui.pageDialog = () => (sheetTime ? { title: sheetTime.title, close: sheetTime.close, content: timeSheet } : null);
    return () => {
      p.dispose();
      ui.pageDialog = null;
      if (ui.menu === 'time') ui.closeMenu();
    };
  });

  // The open popover is the `time` menu: so Escape and a click outside close it via the layout.
  $effect(() => {
    const open = p.timeOpen && !ui.isMobile;
    untrack(() => {
      if (open) ui.menu = 'time';
      else if (ui.menu === 'time') ui.closeMenu();
    });
  });

  // If the layout closed the popover, the time picker counts as closed, also after switching to mobile.
  $effect(() => {
    if (!ui.isMobile && ui.menu !== 'time')
      untrack(() => {
        if (p.timeOpen) v.upTimeSel.close();
      });
  });

  function onTimeInput(t: TimePickValues, event: Event & { currentTarget: HTMLInputElement }) {
    const el = event.currentTarget;
    const text = t.onInput(el.value);
    if (el.value !== text) el.value = text;
  }

  function onTimeKey(t: TimePickValues, event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    const el = event.currentTarget;
    t.onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      preventDefault: () => event.preventDefault(),
      blur: () => el.blur(),
    });
  }
</script>

<!-- Time picker in the mobile sheet. -->
{#snippet timeSheet(mobile: boolean)}
  {#if sheetTime}<TimePicker timePick={sheetTime} isMobile={mobile} />{/if}
{/snippet}

{#snippet rowText(label: string, desc: string)}
  <div class="row-text">
    <div class="row-label">{label}</div>
    <div class="row-desc">{desc}</div>
  </div>
{/snippet}

{#snippet toggle(label: string, desc: string, t: { on: boolean; onClick: () => void })}
  <div class="row toggle">
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

<!-- Value of a row under "Source"; the new-tab icon only on desktop. -->
{#snippet srcValue(r: UpSrcRow)}
  {#if r.isLink}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external links (repository, image) -->
    <a href={r.href} target="_blank" rel="noopener noreferrer" class="src-link"
      ><span>{r.v}</span>{#if !isMobile}<span class="ext"><Icon name="ti-external-link" /></span>{/if}</a
    >
  {/if}
  {#if r.noLink}<span class="src-plain">{r.v}</span>{/if}
{/snippet}

{#snippet copyButton(r: UpSrcRow)}
  <button
    type="button"
    class="round"
    aria-label={m.updates_copy_label({ label: r.k })}
    use:tooltip={isMobile ? undefined : m.updates_copy_tip()}
    onclick={() => void r.copy()}><Icon name="ti-copy" /></button
  >
{/snippet}

{#snippet removeButton()}
  <button
    type="button"
    class="round"
    aria-label={m.updates_pat_remove_label()}
    use:tooltip={isMobile ? undefined : m.updates_pat_remove_tip()}
    onclick={v.pat.remove}><Icon name="ti-trash" /></button
  >
{/snippet}

<!-- "Cancel" and "Verify and save"; the icon spins while the check runs. -->
{#snippet patButtons()}
  {#if v.pat.canCancel}
    <button type="button" class="pat-cancel" onclick={v.pat.cancel}>{m.updates_pat_cancel()}</button>
  {/if}
  <button
    type="button"
    class="pat-save"
    class:on={v.pat.saveOn}
    class:busy={v.pat.saveBusy}
    aria-disabled={v.pat.saveDis}
    aria-busy={v.pat.saveBusy}
    onclick={v.pat.save}><span class="pat-save-icon"><Icon name={v.pat.saveIcon} /></span>{v.pat.saveLbl}</button
  >
{/snippet}

{#snippet patError()}
  {#if v.pat.hasErr}
    <div role="alert" class="pat-err"><span class="pat-err-icon"><Icon name="ti-alert-circle" /></span>{v.pat.err}</div>
  {/if}
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

  {#if v.upLoad.fail}
    <MailLoadCard
      icon="ti-cloud-off"
      title={m.updates_load_failed()}
      text={v.upLoad.text}
      load={{
        text: v.upLoad.text,
        retry: true,
        reauth: false,
        con: false,
        onRetry: v.upLoad.onRetry,
        goCon: () => {},
      }}
    />
  {/if}

  {#if v.upLoad.ok}
    <div class="tabs no-scrollbar">
      {#each v.upTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
    </div>

    <section data-sec="status" class="sec first">
      <h2 class="sec-title">{m.updates_tab_status()}</h2>
      <div class="status" class:bad={v.upBad}>
        <span class="st-tile"><Icon name={v.upIcon} /></span>
        <div class="st-text">
          <div class="st-title">{v.upTitle}</div>
          <div class="st-sub">{v.upSub}</div>
        </div>
        <button
          type="button"
          class="check"
          class:busy={v.upBusy}
          aria-disabled={v.upBusy}
          aria-busy={v.upBusy}
          onclick={v.upCheck}
          ><span class="check-icon" style:--rot="{v.upRot}deg"><Icon name="ti-refresh" /></span>{v.upBtn}</button
        >
      </div>
      {#if v.upHasWarn}
        <div class="warn"><span class="warn-icon"><Icon name="ti-alert-circle" /></span>{v.upWarn}</div>
      {/if}
      <div class="box rows">
        {#each v.upRows as r (r.k)}
          <div>
            {#if r.sep}<div class="sep"></div>{/if}
            <div class="kv">
              <span class="kv-k">{r.k}</span>
              <span class="kv-v">{r.v}</span>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section data-sec="source" class="sec src">
      <h2 class="sec-title">{m.updates_tab_source()}</h2>
      <p class="sec-desc">{m.updates_source_desc()}</p>
      <div class="box">
        {#each v.upSrcRows as r (r.k)}
          <div>
            {#if r.sep}<div class="sep"></div>{/if}
            <div class="src-row">
              {#if !isMobile}
                <span class="src-key"><span class="src-icon"><Icon name={r.icon} /></span>{r.k}</span>
                <div class="src-actions">{@render srcValue(r)}{@render copyButton(r)}</div>
              {:else}
                <span class="src-icon"><Icon name={r.icon} /></span>
                <div class="src-body">
                  <div class="src-key">{r.k}</div>
                  {@render srcValue(r)}
                </div>
                {@render copyButton(r)}
              {/if}
            </div>
          </div>
        {/each}
        <div class="sep"></div>
        {#if v.pat.set}
          <div class="src-row">
            {#if !isMobile}
              <div class="pat-who">
                <span class="src-icon"><Icon name="ti-key" /></span>
                <div class="src-body">
                  <div class="src-key">{m.updates_pat_label()}</div>
                  <div class="pat-since">{v.pat.since}</div>
                </div>
              </div>
              <div class="src-actions wrap">
                <span class="pat-mask">{v.pat.masked}</span>
                <button type="button" class="pat-replace" onclick={v.pat.replace}>{m.updates_pat_replace()}</button>
                {@render removeButton()}
              </div>
            {:else}
              <span class="src-icon"><Icon name="ti-key" /></span>
              <div class="src-body">
                <div class="src-key">{m.updates_pat_label()}</div>
                <div class="pat-mask">{v.pat.masked}</div>
                <div class="pat-since">{v.pat.since}</div>
              </div>
              <button type="button" class="round" aria-label={m.updates_pat_replace_label()} onclick={v.pat.replace}
                ><Icon name="ti-pencil" /></button
              >
              {@render removeButton()}
            {/if}
          </div>
        {/if}
        {#if v.pat.edit}
          <div class="pat-edit">
            <div class="pat-head">
              <span class="src-icon"><Icon name="ti-key" /></span><span class="src-key">{m.updates_pat_label()}</span>
            </div>
            <div class="pat-hint">{m.updates_pat_hint()}</div>
            <div class="pat-line">
              <div class="pat-field">
                <input
                  type={v.pat.type}
                  class:bad={v.pat.invalid}
                  value={v.pat.value}
                  placeholder={m.updates_pat_placeholder()}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label={m.updates_pat_label()}
                  oninput={(e) => v.pat.onChange(e.currentTarget.value)}
                  onkeydown={v.pat.onKey}
                />
                <button
                  type="button"
                  class="eye"
                  aria-label={v.pat.eyeTip}
                  use:tooltip={isMobile ? undefined : v.pat.eyeTip}
                  onclick={v.pat.onEye}><Icon name={v.pat.eyeIcon} /></button
                >
              </div>
              {#if !isMobile}{@render patButtons()}{/if}
            </div>
            {@render patError()}
            {#if isMobile}<div class="pat-buttons">{@render patButtons()}</div>{/if}
          </div>
        {/if}
      </div>
    </section>

    <section data-sec="schedule" class="sec">
      <h2 class="sec-title">{m.updates_tab_schedule()}</h2>
      <p class="sec-desc">{m.updates_schedule_desc()}</p>
      <div class="box">
        {@render toggle(m.updates_auto_title(), m.updates_auto_desc(), v.tgUpAuto)}
        <div class="sep"></div>
        <div class="row" class:dim={v.upEvOff}>
          {@render rowText(m.updates_every_title(), m.updates_every_desc())}
          <div role="group" aria-label={m.updates_every_title()} class="seg">
            {#each v.upEveryOpts as o (o.value)}
              <button type="button" class:on={o.on} aria-pressed={o.on} disabled={v.upEvOff} onclick={o.onClick}
                >{o.label}</button
              >
            {/each}
          </div>
        </div>
        {#if v.upHasDay}
          <div class="sep"></div>
          <div class="row" class:dim={v.upEvOff}>
            {@render rowText(m.updates_day_title(), m.updates_day_desc())}
            <div role="group" aria-label={m.updates_day_title()} class="seg days">
              {#each v.upDayOpts as o (o.value)}
                <button type="button" class:on={o.on} aria-pressed={o.on} disabled={v.upEvOff} onclick={o.onClick}
                  >{o.label}</button
                >
              {/each}
            </div>
          </div>
        {/if}
        {#if v.upHasTime}
          {@const t = v.upTimeSel}
          <div class="sep"></div>
          <div class="row" class:dim={v.upEvOff}>
            {@render rowText(t.title, m.updates_time_desc())}
            <div class="time-pop" data-pop>
              <div class="field" class:open={t.open}>
                <input
                  type="text"
                  inputmode="numeric"
                  maxlength="5"
                  placeholder={m.time_placeholder()}
                  value={t.inputVal}
                  disabled={t.disabled}
                  aria-label={t.title}
                  oninput={(event) => onTimeInput(t, event)}
                  onfocus={(event) => {
                    event.currentTarget.select();
                    t.onFocus();
                  }}
                  onblur={t.onBlur}
                  onkeydown={(event) => onTimeKey(t, event)}
                />
                {#if m.time_uhr()}<span class="uhr">{m.time_uhr()}</span>{/if}
                <button
                  type="button"
                  class="clock"
                  aria-haspopup="dialog"
                  aria-expanded={isMobile ? undefined : t.open}
                  aria-label={m.time_open({ title: t.title })}
                  disabled={t.disabled}
                  onclick={t.toggle}><Icon name="ti-clock" /></button
                >
              </div>
              {#if t.open}
                <div role="dialog" aria-label={m.updates_time_pick()} class="time-popover">
                  <TimePicker timePick={t} isMobile={false} />
                </div>
              {/if}
            </div>
          </div>
        {/if}
        <div class="sep"></div>
        <div class="kv">
          <span class="kv-k">{m.updates_next_title()}</span>
          <span class="kv-v">{v.upNext}</span>
        </div>
      </div>
    </section>

    <section data-sec="display" class="sec">
      <h2 class="sec-title">{m.updates_tab_display()}</h2>
      <p class="sec-desc">{m.updates_display_desc()}</p>
      <div class="box">
        {@render toggle(m.updates_show_title(), m.updates_show_desc(), v.tgUpShow)}
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
  }

  .mobile .sec.src .sec-desc {
    margin-top: 6px;
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

  .mobile .sec.src .box {
    margin-top: 14px;
  }

  .box.rows {
    margin-top: 12px;
  }

  .mobile .box.rows {
    margin-top: 10px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  /* Status: card and tile colours */
  .status {
    --st-bg: var(--accsoft);
    --st-tile: var(--acc);
    --st-ink: var(--accink);
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 16px 18px;
    flex-wrap: wrap;
    padding: 20px 20px 20px 22px;
    border-radius: 26px;
    background: var(--st-bg);
  }

  .status.bad {
    --st-bg: var(--surface2);
    --st-tile: var(--surface);
    --st-ink: var(--danger);
  }

  .mobile .status {
    margin-top: 16px;
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 0;
    text-align: center;
    padding: 24px 16px 16px;
    border-radius: 24px;
  }

  .st-tile {
    width: 56px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 19px;
    background: var(--st-tile);
    color: var(--st-ink);
    display: grid;
    place-items: center;
    font-size: 28px;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
  }

  .st-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .mobile .st-text {
    flex: none;
  }

  .st-title {
    font-family: var(--font-serif);
    font-size: 24px;
    line-height: 1.2;
  }

  .mobile .st-title {
    margin-top: 14px;
    font-size: 22px;
  }

  .st-sub {
    margin-top: 4px;
    font-size: 14.5px;
    color: var(--fg);
  }

  .mobile .st-sub {
    font-size: 14px;
  }

  .check {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    /* Fixed shadow */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
  }

  .check.busy {
    cursor: progress;
  }

  .mobile .check {
    margin-top: 18px;
    align-self: stretch;
  }

  /* Rotates by the tile's tilt; without animations `--dur` is 0. */
  .check-icon {
    display: grid;
    font-size: 18px;
    transform: rotate(var(--rot));
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  /* New version known, last check failed */
  .warn {
    margin-top: 10px;
    padding: 0 6px;
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
    text-wrap: pretty;
  }

  .mobile .warn {
    padding: 0 4px;
    font-size: 13.5px;
  }

  .warn-icon {
    display: inline-flex;
    flex-shrink: 0;
    font-size: 17px;
    line-height: 1.3;
  }

  /* Rows of label and value */
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
  }

  .mobile .kv {
    gap: 16px;
    padding: 14px;
  }

  .kv-k {
    flex-shrink: 0;
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .kv-k {
    font-size: 15px;
  }

  .kv-v {
    min-width: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .mobile .kv-v {
    font-size: 14.5px;
  }

  /* Source */
  .src-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 24px;
    padding: 12px 10px 12px 18px;
    flex-wrap: wrap;
  }

  .mobile .src-row {
    justify-content: flex-start;
    gap: 12px;
    padding: 12px 6px 12px 14px;
    flex-wrap: nowrap;
  }

  .src-icon {
    display: inline-flex;
    flex-shrink: 0;
    font-size: 19px;
    color: var(--mfg);
  }

  .mobile .src-icon {
    font-size: 20px;
  }

  .src-key {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .src-key {
    font-size: 15px;
  }

  .src-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
  }

  .src-actions.wrap {
    flex-wrap: wrap;
  }

  .src-body {
    min-width: 0;
  }

  .mobile .src-body {
    flex: 1;
  }

  .src-link,
  .src-plain,
  .pat-mask {
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }

  .src-link {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg);
    text-decoration: none;
  }

  .src-link:hover {
    text-decoration: underline;
  }

  .ext {
    display: inline-flex;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--mfg);
  }

  .src-plain,
  .pat-mask {
    color: var(--mfg);
  }

  .pat-mask {
    margin-right: 6px;
  }

  .mobile .src-link,
  .mobile .src-plain,
  .mobile .pat-mask {
    display: block;
    margin: 2px 0 0;
    font-size: 13px;
  }

  .mobile .src-link {
    text-decoration: underline;
    text-decoration-color: var(--bd);
    text-underline-offset: 3px;
  }

  .round {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 17px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .round:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .round {
    width: 44px;
    height: 44px;
    font-size: 19px;
    transition: none;
  }

  .mobile .round:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .round:active {
    background: var(--hov);
  }

  /* Access token */
  .pat-who,
  .pat-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pat-who {
    min-width: 0;
  }

  .pat-since {
    margin-top: 2px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .pat-since {
    font-size: 13px;
  }

  .pat-replace {
    height: 36px;
    padding: 0 14px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .pat-replace:hover {
    background: var(--hov);
  }

  .pat-edit {
    padding: 16px 18px;
  }

  .mobile .pat-edit {
    padding: 14px 14px 12px;
  }

  .pat-hint {
    margin-top: 4px;
    font-size: 14px;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .pat-hint {
    font-size: 13.5px;
  }

  .pat-line {
    margin-top: 14px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile .pat-line {
    display: block;
    margin-top: 12px;
  }

  .pat-field {
    position: relative;
    flex: 1 1 280px;
    min-width: 0;
  }

  .pat-field input {
    display: block;
    width: 100%;
    height: 44px;
    padding: 0 50px 0 18px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .pat-field input.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  .pat-field input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile .pat-field input {
    height: 46px;
    padding: 0 52px 0 16px;
    font-size: 16px;
    transition: none;
  }

  .eye {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 36px;
    height: 36px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 18px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .eye:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .eye {
    top: 1px;
    right: 1px;
    width: 44px;
    height: 44px;
    font-size: 19px;
    transition: none;
  }

  .mobile .eye:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .eye:active {
    background: var(--hov);
  }

  .pat-cancel {
    height: 44px;
    padding: 0 16px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .pat-cancel:hover {
    background: var(--hov);
  }

  .mobile .pat-cancel {
    flex: 1;
    height: 46px;
    padding: 0;
    font-size: 15px;
    transition: none;
  }

  .mobile .pat-cancel:hover {
    background: none;
  }

  .mobile .pat-cancel:active {
    background: var(--hov);
  }

  .pat-save {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--dim);
    cursor: default;
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .pat-save.on {
    background: var(--acc);
    color: var(--accink);
    cursor: pointer;
  }

  .pat-save.busy {
    cursor: progress;
  }

  .mobile .pat-save {
    flex: 2;
    height: 46px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .pat-save-icon {
    display: inline-flex;
    font-size: 17px;
  }

  .pat-save.busy .pat-save-icon {
    animation: var(--spin);
  }

  .mobile .pat-save-icon {
    font-size: 18px;
  }

  .pat-buttons {
    margin-top: 12px;
    display: flex;
    gap: 6px;
  }

  .pat-err {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
  }

  .mobile .pat-err {
    font-size: 13.5px;
  }

  .pat-err-icon {
    display: inline-flex;
    flex-shrink: 0;
    font-size: 17px;
  }

  /* Schedule rows: on desktop label left, selection right; stacked on mobile */
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

  /* Dimmed while automatic checks are off */
  .row.dim {
    opacity: 0.5;
    pointer-events: none;
  }

  .row.toggle {
    gap: 24px;
    flex-wrap: nowrap;
  }

  .mobile .row.toggle {
    display: flex;
    gap: 16px;
    padding: 14px;
  }

  .row-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .row.toggle .row-text {
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

  /* Frequency and weekday */
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

  .seg.days button {
    min-width: 42px;
    padding: 0 10px;
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

  /* Time field */
  .time-pop {
    position: relative;
  }

  .field {
    width: 150px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 5px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: box-shadow var(--dur, 220ms);
  }

  .field.open {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .mobile .field {
    width: auto;
    height: 46px;
    margin-top: 12px;
    gap: 8px;
  }

  .field input {
    flex: 1;
    min-width: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    outline: none;
    color: inherit;
    font: inherit;
    font-size: 14.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .mobile .field input {
    font-size: 16px;
  }

  .uhr {
    font-size: 14px;
    font-weight: 600;
    color: var(--mfg);
  }

  .mobile .uhr {
    font-size: 15px;
  }

  .clock {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 18px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .clock:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .clock {
    width: 38px;
    height: 38px;
    font-size: 19px;
    transition: none;
  }

  .mobile .clock:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .clock:active {
    background: var(--hov);
  }

  .time-popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 30;
    width: 200px;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: top right;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }
</style>
