<!--
  Settings navigation: on desktop the bar left of the content card of
  settings, account and administration ("Back to …", groups, at the bottom
  "Advanced settings" and the app with version), collapsed only with tiles; on
  mobile the list of the area. In the email account (`ma` set) on desktop the
  account switch with the account picker (`ma.maSwOpen`) sits at the bottom
  instead of the card; on mobile the layout shows `MailAccountNav` there
  instead of this list.
-->
<script lang="ts">
  import { tooltip } from '#lib/actions/tooltip.ts';
  import AccountPicker from '#lib/components/AccountPicker.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import type { SettingsNavValues } from '#lib/settings-nav.ts';

  let {
    isMobile,
    appName,
    logo,
    version,
    collapsed,
    backLabel,
    backTip,
    panelBack,
    mPanelH,
    isAdminView,
    settingsGroups,
    noSettingsHits,
    tgAdv,
    ma,
  }: SettingsNavValues = $props();
</script>

{#snippet advanced(mobile: boolean)}
  <button
    class="switch"
    class:mobile
    class:on={tgAdv.on}
    role="switch"
    aria-checked={tgAdv.on}
    aria-label={m.nav_advanced()}
    onclick={tgAdv.onClick}><span class="knob"></span></button
  >
{/snippet}

{#if !isMobile}
  <aside class="nav" class:collapsed>
    <button class="back" onclick={panelBack} use:tooltip={{ text: backTip, side: 'right' }}>
      <span class="back-icon"><Icon name="ti-arrow-left" /></span>
      <span class="back-label label">{backLabel}</span>
    </button>
    <nav class="groups no-scrollbar" aria-label={mPanelH}>
      {#each settingsGroups as g, i (g.label || i)}
        <div class="group">
          {#if g.hasLabel}<div class="group-label label">{g.label}</div>{/if}
          {#each g.items as it (it.id)}
            <button
              class="item"
              class:on={it.on}
              style:font-weight={it.fw}
              aria-current={it.on ? 'page' : undefined}
              aria-label={collapsed ? it.label : undefined}
              onclick={it.onClick}
              use:tooltip={{ text: it.tip, side: 'right' }}
            >
              <span class="tile"><Icon name={it.icon} /></span>
              <span class="label">{it.label}</span>
            </button>
          {/each}
        </div>
      {/each}
      {#if noSettingsHits}<div class="none">{m.nav_no_hits()}</div>{/if}
    </nav>
    {#if ma}
      <!-- Name "Switch email account" with address and status, as visible (WCAG 2.5.3). -->
      <button
        class="ma-sw"
        class:open={ma.maSwOpen}
        data-pop="1"
        aria-haspopup="menu"
        aria-expanded={ma.maSwOpen}
        onclick={ma.toggleMaSw}
        use:tooltip={{ text: ma.maSwTip, side: 'right' }}
      >
        <span class="sr-only">{m.mail_account_switch()}</span>
        <span class="ma-chip" aria-hidden="true" style:background={ma.maCur.chip} style:color={ma.maCur.chipInk}
          >{ma.maCur.letter}{#if ma.maCur.needsAuth}<span class="ma-warn"></span>{/if}</span
        >
        <span class="ma-text label">
          <span class="ma-email">{ma.maCur.email}</span>
          <span class="ma-st {ma.maCur.kind}"
            ><span class="ma-dot"></span><span class="ma-st-text">{ma.maCur.st}</span></span
          >
        </span>
        <span class="ma-sel label"><Icon name="ti-selector" /></span>
      </button>
    {:else}
      <div class="card" aria-hidden={collapsed}>
        {#if isAdminView}
          <div class="adv">
            <span class="adv-label">{m.nav_advanced()}</span>
            {@render advanced(false)}
          </div>
        {/if}
        <div class="app">
          <span class="app-logo"><Logo {logo} /></span>
          <div class="app-text">
            <div class="app-name">{appName}</div>
            <div class="app-version">{version}</div>
          </div>
        </div>
      </div>
    {/if}
  </aside>
  {#if ma?.maSwOpen}<AccountPicker {...ma.picker} />{/if}
{:else}
  <h1 class="m-title">{mPanelH}</h1>
  {#each settingsGroups as g, i (g.label || i)}
    <div class="m-group">
      {#if g.hasLabel}<div class="m-group-label">{g.label}</div>{/if}
      <div class="m-list">
        {#each g.items as it (it.id)}
          <button class="m-item" onclick={it.onClick}>
            <span class="m-tile"><Icon name={it.icon} /></span>
            <span class="m-label">{it.label}</span>
            <span class="m-chev"><Icon name="ti-chevron-right" /></span>
          </button>
        {/each}
      </div>
    </div>
  {/each}
  {#if noSettingsHits}<div class="m-none">{m.nav_no_hits()}</div>{/if}
  {#if isAdminView}
    <div class="m-adv">
      <span class="m-adv-label">{m.nav_advanced()}</span>
      {@render advanced(true)}
    </div>
  {/if}
  <div class="m-app">
    <span class="m-app-logo"><Logo {logo} /></span>
    <span class="m-app-text">{appName} · {version}</span>
  </div>
{/if}

<style>
  .nav {
    position: relative;
    z-index: 30;
    width: 270px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    margin-bottom: 16px;
    padding: 0 14px 0 16px;
    border-radius: 0 28px 28px 0;
    background: var(--cnv);
    overflow: hidden;
    transition: width var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .nav.collapsed {
    width: 82px;
  }

  .label {
    opacity: 1;
    transition: opacity var(--dur, 220ms);
  }

  .collapsed .label {
    opacity: 0;
  }

  .back {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px 0 8px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 700;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    transition: background-color var(--dur, 220ms);
  }

  .back:hover {
    background: var(--hov);
  }

  .back-icon {
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    font-size: 18px;
  }

  .back-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .groups {
    flex: 1;
    min-height: 0;
    overflow: hidden auto;
    padding: 12px 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .group + .group {
    margin-top: 12px;
  }

  .group-label {
    height: 36px;
    padding: 0 14px 6px;
    display: flex;
    align-items: flex-end;
    overflow: hidden;
    white-space: nowrap;
    font-family: var(--font-serif);
    font-size: 15px;
    color: var(--mfg);
    transition:
      height var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  .collapsed .group-label {
    height: 8px;
  }

  .item {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 6px;
    border-radius: 16px;
    color: var(--mfg);
    font-size: 14.5px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    transition: background-color var(--dur, 220ms);
  }

  .item:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .item.on {
    background: var(--surface);
    box-shadow: var(--sh1);
    color: var(--fg);
  }

  .tile {
    width: 32px;
    height: 32px;
    border-radius: 11px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .on .tile {
    background: var(--acc);
    color: var(--accink);
  }

  .none {
    padding: 16px 14px;
    font-size: 14px;
    color: var(--mfg);
  }

  .card {
    width: 240px;
    flex-shrink: 0;
    border-radius: 22px;
    background: var(--surface);
    box-shadow: var(--sh1);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    opacity: 1;
    visibility: visible;
    transition:
      opacity var(--dur, 220ms),
      visibility var(--dur, 220ms);
  }

  .collapsed .card {
    opacity: 0;
    visibility: hidden;
  }

  .adv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .adv-label {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
  }

  .switch {
    width: 46px;
    height: 28px;
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
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 9999px;
    /* fixed values (toggle) */
    background: #fff;
    box-shadow: 0 2px 4px rgba(60, 35, 10, 0.25);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .switch.on .knob {
    transform: translateX(18px);
  }

  .switch.mobile {
    width: 52px;
    height: 32px;
  }

  .switch.mobile .knob {
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
  }

  .switch.mobile.on .knob {
    transform: translateX(20px);
  }

  .app {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .app-logo {
    overflow: hidden;
    width: 34px;
    height: 34px;
    border-radius: 12px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    flex-shrink: 0;
    transform: rotate(calc(var(--logo-tilt, 1) * -4deg));
  }

  .app-text {
    min-width: 0;
    flex: 1;
  }

  .app-name {
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-version {
    font-size: 12.5px;
    color: var(--mfg);
  }

  /* Account switch of the email account: expanded or open `maSwBg`/`maSwSh` var(--surface)/var(--sh1) */
  .ma-sw {
    height: 58px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 -2px;
    padding: 0 12px 0 10px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .collapsed .ma-sw:not(.open) {
    box-shadow: none;
  }

  .collapsed .ma-sw:not(.open):not(:hover) {
    background: transparent;
  }

  .ma-chip {
    position: relative;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 16px;
  }

  /* Sign-in required (`maSwWarn`) */
  .ma-warn {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: var(--danger);
    box-shadow: 0 0 0 2px var(--cnv);
  }

  .ma-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ma-email {
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Status (`maCur.stInk`, `maCur.stDot` from the shell's `MAS`) */
  .ma-st {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--fg);
  }

  .ma-st.auth,
  .ma-st.blocked {
    color: var(--danger);
  }

  .ma-st.none {
    color: var(--mfg);
  }

  .ma-dot {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 9999px;
    /* fixed value ("Connected") */
    background: #5fbf73;
  }

  .auth .ma-dot,
  .blocked .ma-dot {
    background: var(--danger);
  }

  .busy .ma-dot {
    background: var(--acc);
  }

  .none .ma-dot {
    background: transparent;
  }

  .ma-st-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ma-sel {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    color: var(--mfg);
  }

  .m-title {
    margin: 0 4px;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
  }

  .m-group {
    margin-top: 22px;
  }

  .m-group-label {
    padding: 0 8px 8px;
    font-family: var(--font-serif);
    font-size: 15px;
    color: var(--mfg);
  }

  .m-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 24px;
    background: var(--surface2);
    padding: 4px;
  }

  .m-item {
    height: 56px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 12px 0 10px;
    border-radius: 20px;
    font-size: 15.5px;
    font-weight: 700;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .m-item:hover {
    background: var(--hov);
  }

  .m-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 19px;
  }

  .m-label {
    flex: 1;
    min-width: 0;
  }

  .m-chev {
    font-size: 18px;
    color: var(--dim);
    display: grid;
  }

  .m-none {
    padding: 24px 8px;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .m-adv {
    margin-top: 22px;
    display: flex;
    align-items: center;
    gap: 14px;
    border-radius: 24px;
    background: var(--surface2);
    padding: 16px 16px 16px 18px;
  }

  .m-adv-label {
    flex: 1;
    font-size: 15px;
    font-weight: 700;
  }

  .m-app {
    margin-top: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .m-app-logo {
    overflow: hidden;
    width: 28px;
    height: 28px;
    border-radius: 10px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    transform: rotate(calc(var(--logo-tilt, 1) * -4deg));
  }

  .m-app-text {
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }
</style>
