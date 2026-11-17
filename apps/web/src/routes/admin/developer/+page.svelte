<!--
  Administration › Developer: diagnostics with debug mode and log level, log,
  testing (error pages, offline simulation, session expiry, test error) and
  environment. A pure browser diagnostic without backend; values and actions
  in `#lib/developer.ts`.

  - The switch and level styles are classes derived from `on`.
  - On mobile the log count sits as a description below "Log", on desktop in
    the header row of the list.
  - There is no beta switch.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { developerValues, type DeveloperContext, type DevToggle } from '#lib/developer.ts';
  import { currentEnv } from '#lib/environment.ts';
  import type { IconName } from '#lib/icons.ts';
  import { logout } from '#lib/logout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();

  const ctx: DeveloperContext = {
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    openError: (code) => void goto(resolve('/error/[code]', { code })),
    logout: () => void logout(),
  };

  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/developer'));
  const v = $derived(developerValues({ env: currentEnv(page.url.pathname), appName: session.appName }, ctx));
</script>

{#snippet rowText(label: string, desc: string)}
  <div class="row-text">
    <div class="row-label">{label}</div>
    <div class="row-desc">{desc}</div>
  </div>
{/snippet}

{#snippet switchButton(label: string, t: DevToggle)}
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

{#snippet action(icon: IconName, label: string, onClick: () => void)}
  <button type="button" class="act" onclick={onClick}><span class="act-icon"><Icon name={icon} /></span>{label}</button>
{/snippet}

{#snippet logTool(icon: IconName, label: string, onClick: () => void)}
  <button type="button" class="tool" onclick={onClick}
    ><span class="tool-icon"><Icon name={icon} /></span>{label}</button
  >
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
    {#each v.devTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="diag" class="sec first">
    <h2 class="sec-title">{m.dev_tab_diag()}</h2>
    <p class="sec-desc">{m.dev_diag_desc()}</p>
    <div class="box">
      <div class="row toggle">
        {@render rowText(m.dev_debug_title(), isMobile ? m.dev_debug_desc_mobile() : m.dev_debug_desc())}
        {@render switchButton(m.dev_debug_title(), v.tgDebug)}
      </div>
      <div class="sep"></div>
      <div class="row">
        {@render rowText(m.dev_level_title(), m.dev_level_desc())}
        <div role="group" aria-label={m.dev_level_title()} class="seg">
          {#each v.devLevelOpts as o (o.value)}
            <button type="button" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>{o.label}</button>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <section data-sec="log" class="sec">
    <h2 class="sec-title">{m.dev_tab_log()}</h2>
    <p class="sec-desc">{isMobile ? v.devLogCount : m.dev_log_desc()}</p>
    <div class="box">
      <div class="log-head">
        {#if !isMobile}<span class="log-count">{v.devLogCount}</span>{/if}
        {@render logTool('ti-copy', m.dev_log_copy(), v.devLogCopy)}
        {@render logTool('ti-eraser', m.dev_log_clear(), v.devLogClear)}
      </div>
      <div role="log" aria-label={m.dev_tab_log()} class="log no-scrollbar" {@attach scrollbar}>
        {#each v.devLogRows as e (e.id)}
          <div class="log-row">
            <span class="log-time">{e.time}</span>
            <span class="log-level" style:color={e.color}>{e.lv}</span>
            <span class="log-msg">{e.msg}</span>
          </div>
        {/each}
        {#if v.devLogEmpty}<div class="log-empty">{m.dev_log_empty()}</div>{/if}
      </div>
    </div>
  </section>

  <section data-sec="test" class="sec">
    <h2 class="sec-title">{m.dev_tab_test()}</h2>
    <p class="sec-desc">{m.dev_test_desc()}</p>
    <div class="box">
      <div class="row">
        {@render rowText(m.dev_pages_title(), isMobile ? m.dev_pages_desc_mobile() : m.dev_pages_desc())}
        <div class="errs">
          {#each v.errBtns as b (b.code)}
            <button
              type="button"
              class="err"
              aria-label={isMobile ? undefined : b.label}
              use:tooltip={isMobile ? undefined : b.label}
              onclick={b.onClick}
            >
              <span class="err-code">{b.code}</span>
              {#if isMobile}<span class="err-label">{b.label}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="sep"></div>
      <div class="row toggle">
        {@render rowText(m.dev_offline_title(), isMobile ? m.dev_offline_desc_mobile() : m.dev_offline_desc())}
        {@render switchButton(m.dev_offline_title(), v.tgOffline)}
      </div>
      <div class="sep"></div>
      <div class="row">
        {@render rowText(m.dev_session_title(), isMobile ? m.dev_session_desc_mobile() : m.dev_session_desc())}
        {@render action('ti-clock-off', m.dev_trigger(), v.simExpire)}
      </div>
      <div class="sep"></div>
      <div class="row">
        {@render rowText(m.dev_logerr_title(), isMobile ? m.dev_logerr_desc_mobile() : m.dev_logerr_desc())}
        {@render action('ti-bug', m.dev_trigger(), v.simError)}
      </div>
    </div>
  </section>

  <section data-sec="env" class="sec">
    <h2 class="sec-title">{m.dev_tab_env()}</h2>
    <p class="sec-desc">{m.dev_env_desc()}</p>
    <div class="box">
      {#each v.envRows as r (r.k)}
        <div>
          {#if r.sep}<div class="sep"></div>{/if}
          <div class="env-row">
            <span class="env-key">{r.k}</span>
            <span class="env-value">{r.v}</span>
          </div>
        </div>
      {/each}
      {#if !isMobile}<div class="sep"></div>{/if}
      <div class="env-foot">{@render action('ti-copy', m.dev_env_copy(), v.copyEnv)}</div>
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
  }

  .mobile .row {
    display: block;
    padding: 14px 14px 12px;
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

  /* Log level */
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

  /* Log */
  .log-head {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    padding: 4px 4px 8px;
  }

  .log-count {
    flex: 1;
    padding-left: 12px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .tool {
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .tool:hover {
    background: var(--hov);
  }

  .tool-icon {
    display: grid;
    font-size: 16px;
  }

  .log {
    max-height: 340px;
    overflow-y: auto;
    border-radius: 22px;
    background: var(--surface);
    box-shadow: var(--sh1);
    padding: 8px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .mobile .log {
    max-height: 280px;
    border-radius: 20px;
  }

  .log-row {
    display: grid;
    grid-template-columns: 70px 66px minmax(0, 1fr);
    gap: 10px;
    padding: 4px 16px;
  }

  /* Mobile: time and level side by side, the message below */
  .mobile .log-row {
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0 10px;
    padding: 6px 14px;
  }

  .mobile .log-msg {
    grid-column: 1 / -1;
  }

  .log-time {
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
  }

  .log-level {
    font-weight: 700;
  }

  .log-msg {
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .log-empty {
    padding: 26px 16px;
    text-align: center;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--mfg);
  }

  /* Error pages */
  .errs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mobile .errs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 12px;
  }

  .err {
    height: 38px;
    padding: 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .err:hover {
    transform: translateY(-2px);
  }

  .mobile .err {
    height: auto;
    min-height: 52px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    padding: 8px 14px;
    border-radius: 18px;
    text-align: left;
    white-space: normal;
    transition: none;
  }

  .mobile .err:hover {
    transform: none;
  }

  .err-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 700;
  }

  .err-label {
    font-size: 12.5px;
    color: var(--mfg);
  }

  /* "Trigger" and "Copy" buttons */
  .act {
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
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

  .act:hover {
    transform: translateY(-2px);
  }

  .act-icon {
    display: grid;
    font-size: 17px;
  }

  .mobile .act {
    width: 100%;
    height: 46px;
    padding: 0;
    font-size: 15px;
    transition: none;
  }

  .mobile .row .act {
    margin-top: 12px;
  }

  .mobile .act:hover {
    transform: none;
  }

  .mobile .act-icon {
    font-size: 18px;
  }

  /* Environment */
  .env-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
  }

  .mobile .env-row {
    gap: 16px;
    padding: 14px;
  }

  .env-key {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .env-key {
    font-size: 15px;
  }

  .env-value {
    font-size: 15px;
    font-weight: 600;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .mobile .env-value {
    min-width: 0;
    font-size: 14.5px;
  }

  .env-foot {
    display: flex;
    justify-content: flex-end;
    padding: 10px;
  }

  .mobile .env-foot {
    display: block;
    padding: 6px 10px 10px;
  }
</style>
