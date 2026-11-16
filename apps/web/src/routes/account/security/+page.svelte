<!--
  Account › Security: change the password, add and remove authenticator apps
  with a QR code, regenerate recovery codes, and signed-in devices with "Sign
  out" and "Sign out all others" (with undo). Flow and values in
  `#lib/security.svelte.ts`. App passwords and API keys are not offered.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { SecurityPage, securityValues, type PwFieldValues } from '#lib/security.svelte.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  /** Maximum length of an app's name as in the backend (`MAX_NAME` in `api::mfa`). */
  const MAX_APP_NAME = 64;

  const p = new SecurityPage();
  let root: HTMLElement | undefined = $state();
  const ctx = { scrollTo: (section: string) => scrollToSection(root, section, prefs.motion) };
  /** Clock for "Last active … ago" and "Last changed …" while the page is open. */
  let now = $state(Date.now());
  const v = $derived(securityValues(p, ctx, now));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/account/security'));
  type FieldEvent = Event & { currentTarget: HTMLInputElement };

  onMount(() => {
    void p.load();
    const clock = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(clock);
      p.dispose();
    };
  });
</script>

{#snippet pwField(f: PwFieldValues)}
  <input
    type={f.type}
    value={f.value}
    oninput={(e: FieldEvent) => f.onChange(e.currentTarget.value)}
    onkeydown={v.pwKey}
    inputmode={f.im}
    autocomplete={f.ac}
    aria-label={f.label}
  />
  {#if f.hasEye}
    <button
      type="button"
      class="eye"
      onclick={f.onEye}
      aria-label={f.eyeTip}
      use:tooltip={isMobile ? undefined : f.eyeTip}><Icon name={f.eyeIcon} /></button
    >
  {/if}
{/snippet}

{#snippet credentials(
  pw: string,
  code: string,
  onPw: (value: string) => void,
  onCode: (value: string) => void,
  key: (e: KeyboardEvent) => void,
)}
  <div class="pair">
    <input
      type="password"
      value={pw}
      oninput={(e: FieldEvent) => onPw(e.currentTarget.value)}
      onkeydown={key}
      placeholder={m.reauth_password_label()}
      aria-label={m.reauth_password_label()}
      autocomplete="current-password"
    />
    <input
      class="code"
      type="text"
      value={code}
      oninput={(e: FieldEvent) => onCode(e.currentTarget.value)}
      onkeydown={key}
      inputmode="numeric"
      autocomplete="one-time-code"
      placeholder={m.security_code_placeholder()}
      aria-label={m.reauth_code_label()}
    />
  </div>
{/snippet}

{#snippet qrTile()}
  <span class="qr">
    {#if v.totpQr}
      <svg
        viewBox="0 0 {v.totpQr.size} {v.totpQr.size}"
        shape-rendering="crispEdges"
        aria-label={m.security_qr_label()}
        role="img"
      >
        <path d={v.totpQr.d} />
      </svg>
    {:else}
      <span class="spin"><Icon name="ti-loader-2" /></span>
    {/if}
  </span>
{/snippet}

{#snippet secretRow()}
  <div class="secret">
    <code>{v.totpSecret}</code>
    <button
      type="button"
      class="icon-btn"
      onclick={v.copyTotp}
      aria-label={m.security_key_copy()}
      use:tooltip={isMobile ? undefined : m.security_key_copy()}><Icon name="ti-copy" /></button
    >
  </div>
{/snippet}

<!-- Adding or removing an app. -->
{#snippet totpPanel()}
  <div class="sep"></div>
  <div class="panel-in">
    {#if v.totpSetup}
      <label class="name-field">
        <span>{m.security_app_name()}</span>
        <input
          type="text"
          value={v.tNameVal}
          maxlength={MAX_APP_NAME}
          oninput={(e: FieldEvent) => v.onTName(e.currentTarget.value)}
          onkeydown={isMobile ? undefined : v.tKey}
          placeholder={m.security_app_name_placeholder()}
        />
        {#if v.hasTNameErr}<span role="alert" class="name-err"><Icon name="ti-alert-circle" />{v.tNameErr}</span>{/if}
      </label>
      {#if isMobile}
        <div class="step-head">
          <div class="step-title">{m.security_qr_title()}</div>
          <div class="step-text">{m.security_qr_text_mobile()}</div>
        </div>
        <div class="qr-center">{@render qrTile()}</div>
        {@render secretRow()}
        <div class="step-title confirm">{m.security_confirm_title()}</div>
      {:else}
        <div class="scan">
          {@render qrTile()}
          <div class="scan-text">
            <div class="step-title">{m.security_qr_title()}</div>
            <div class="step-text">{m.security_qr_text()}</div>
            {@render secretRow()}
          </div>
        </div>
        <div class="step-title">{m.security_confirm_title()}</div>
      {/if}
    {/if}
    <div class="intro">{v.totpIntro}</div>
    {@render credentials(v.tPwVal, v.tCodeVal, v.onTPw, v.onTCode, v.tKey)}
    {#if v.tStale}
      <div role="alert" class="stale" class:mobile={isMobile}>
        <Icon name="ti-refresh-alert" />
        <span>{m.security_app_stale()}</span>
        <button type="button" onclick={v.tRestart}><Icon name="ti-qrcode" />{m.security_app_restart()}</button>
      </div>
    {/if}
    {#if isMobile}
      {#if v.hasTErr}<div role="alert" class="err">{v.tErr}</div>{/if}
      <div class="acts">
        <button type="button" class="cancel" onclick={v.totpCancel}>{m.confirm_cancel()}</button>
        <button type="button" class="go" class:danger={!v.totpSetup} aria-disabled={v.totpBusy} onclick={v.totpGo}
          >{v.totpGoLabel}</button
        >
      </div>
    {:else}
      <div class="acts">
        <span role="alert" class="err">{v.tErr}</span>
        <button type="button" class="cancel" onclick={v.totpCancel}>{m.confirm_cancel()}</button>
        <button type="button" class="go" class:danger={!v.totpSetup} aria-disabled={v.totpBusy} onclick={v.totpGo}
          >{v.totpGoLabel}</button
        >
      </div>
    {/if}
  </div>
{/snippet}

<!-- Codes right after generating them. -->
{#snippet codesShown()}
  <div class="codes">
    <div class="codes-hint">
      <span class="hint-icon"><Icon name="ti-alert-circle" /></span><span>{m.security_rc_hint()}</span>
    </div>
    <ol aria-label={m.security_rc_title()}>
      {#each v.rcCodes as c (c.n)}
        <li><span class="n">{c.n}</span>{c.code}</li>
      {/each}
    </ol>
    <div class="codes-acts">
      <button type="button" class="soft" onclick={v.rcCopy}><Icon name="ti-copy" />{m.security_rc_copy()}</button>
      <button type="button" class="soft" onclick={v.rcDownload}
        ><Icon name="ti-download" />{isMobile ? m.security_rc_download_mobile() : m.security_rc_download()}</button
      >
      {#if !isMobile}<span class="grow"></span>{/if}
      <button type="button" class="done" onclick={v.rcDone}>{m.security_rc_done()}</button>
    </div>
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

  {#if p.status === 'failed'}
    <div class="failed"><ErrorView code={p.failure} retry={() => p.retry()} /></div>
  {:else if p.status === 'ready'}
    <div class="tabs no-scrollbar">
      {#each v.secTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
    </div>

    <section data-sec="password" class="sec">
      <h2>{m.security_pw_title()}</h2>
      <p class="sec-desc">{v.pwDesc}</p>
      <div class="box">
        {#each v.pwFields as f (f.label)}
          <div>
            {#if f.sep}<div class="sep"></div>{/if}
            <div class="field">
              <div class="field-text">
                <div class="field-label">{f.label}</div>
                <div class="field-desc">{f.desc}</div>
              </div>
              <div class="field-ctl">{@render pwField(f)}</div>
            </div>
          </div>
        {/each}
        {#if isMobile}
          <div class="pw-foot">
            {#if v.hasPwMsg}<div role="alert" class="err">{v.pwMsg}</div>{/if}
            <button
              type="button"
              class="pw-go"
              class:ready={!v.pwDis}
              aria-disabled={v.pwDis || v.pwBusy}
              onclick={v.pwSubmit}>{m.security_pw_submit()}</button
            >
            <div class="pw-note">{m.security_pw_note()}</div>
          </div>
        {:else}
          <div class="sep"></div>
          <div class="pw-foot">
            <div class="pw-msgs">
              <span role="alert" class="err">{v.pwMsg}</span>
              <span class="pw-note">{m.security_pw_note()}</span>
            </div>
            <button
              type="button"
              class="pw-go"
              class:ready={!v.pwDis}
              aria-disabled={v.pwDis || v.pwBusy}
              onclick={v.pwSubmit}>{m.security_pw_submit()}</button
            >
          </div>
        {/if}
      </div>
    </section>

    <section data-sec="2fa" class="sec">
      <h2>{m.security_mfa_title()}</h2>
      <p class="sec-desc">{isMobile ? m.security_mfa_desc_mobile() : m.security_mfa_desc()}</p>
      <div class="box">
        {#each v.tfaEntries as e (e.id)}
          <div>
            {#if e.sep}<div class="sep"></div>{/if}
            <div class="entry" class:selected={e.selected}>
              <span class="tile"><Icon name="ti-shield-lock" /></span>
              <span class="entry-text">
                <span class="entry-name">{e.name}</span>
                <span class="entry-sub">{e.sub}</span>
              </span>
              <button
                type="button"
                class="icon-btn trash"
                onclick={e.onRemove}
                aria-label={e.delLabel}
                use:tooltip={isMobile ? undefined : m.security_remove()}><Icon name="ti-trash" /></button
              >
            </div>
          </div>
        {/each}
        {#if v.tfaEmpty}<div class="empty">{m.security_mfa_empty()}</div>{/if}
        {#if v.totpPanel}{@render totpPanel()}{/if}
        {#if v.totpNoPanel}
          <button type="button" class="add" onclick={v.tfaAdd}><Icon name="ti-plus" />{m.security_add_app()}</button>
        {/if}
      </div>

      <div class="rc">
        <h3>{m.security_rc_title()}</h3>
        <p class="sec-desc">{m.security_rc_desc()}</p>
        {#if v.rcShow}{@render codesShown()}{/if}
        <div class="box rc-box">
          {#if v.rcOff}<div class="empty">{m.security_rc_off()}</div>{/if}
          {#if v.rcOn}
            <div class="entry rc-row">
              <span class="tile"><Icon name="ti-lifebuoy" /></span>
              <span class="entry-text">
                <span class="entry-name">{v.rcSum}</span>
                <span class="entry-sub">{v.rcSub}</span>
              </span>
              {#if v.rcNoForm && !isMobile}
                <button type="button" class="regen" onclick={v.rcRegen}
                  ><Icon name="ti-refresh" />{m.security_rc_regen()}</button
                >
              {/if}
            </div>
            {#if v.rcNoForm && isMobile}
              <button type="button" class="regen" onclick={v.rcRegen}
                ><Icon name="ti-refresh" />{m.security_rc_regen()}</button
              >
            {/if}
          {/if}
          {#if v.rcForm}
            <div class="sep"></div>
            <div class="panel-in">
              <div class="intro">{m.security_rc_form()}</div>
              {@render credentials(v.rcPwVal, v.rcCodeVal, v.onRcPw, v.onRcCode, v.rcKey)}
              {#if isMobile}
                {#if v.hasRcErr}<div role="alert" class="err">{v.rcErr}</div>{/if}
                <div class="acts">
                  <button type="button" class="cancel" onclick={v.rcCancel}>{m.confirm_cancel()}</button>
                  <button type="button" class="go" aria-disabled={v.rcBusy} onclick={v.rcGo}
                    >{m.security_rc_go_mobile()}</button
                  >
                </div>
              {:else}
                <div class="acts">
                  <span role="alert" class="err">{v.rcErr}</span>
                  <button type="button" class="cancel" onclick={v.rcCancel}>{m.confirm_cancel()}</button>
                  <button type="button" class="go" aria-disabled={v.rcBusy} onclick={v.rcGo}
                    >{m.security_rc_regen()}</button
                  >
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </section>

    <section data-sec="sessions" class="sec">
      <h2>{m.security_sessions_title()}</h2>
      <p class="sec-desc">{isMobile ? m.security_sessions_desc_mobile() : m.security_sessions_desc()}</p>
      <div class="box sessions">
        {#each v.sessList as d (d.id)}
          <div class="session">
            <span class="tile device"><Icon name={d.icon} /></span>
            <span class="entry-text">
              <span class="entry-name">{d.name}</span>
              <span class="entry-sub wrap">{d.sub}</span>
            </span>
            {#if d.current}<span class="this">{m.security_this_device()}</span>{/if}
            {#if d.notCurrent}
              {#if isMobile}
                <button type="button" class="icon-btn" onclick={d.onRevoke} aria-label={m.security_sign_out()}
                  ><Icon name="ti-logout" /></button
                >
              {:else}
                <button type="button" class="revoke" onclick={d.onRevoke}>{m.security_sign_out()}</button>
              {/if}
            {/if}
          </div>
        {/each}
        {#if v.hasOtherSess}
          <div class="sep sessions-sep"></div>
          <button type="button" class="others" onclick={v.revokeOthers}
            ><Icon name="ti-logout" />{isMobile
              ? m.security_sign_out_others_mobile()
              : m.security_sign_out_others()}</button
          >
        {/if}
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

  .failed {
    margin-top: 26px;
    display: flex;
    flex-direction: column;
  }

  .spin {
    display: grid;
    animation: var(--spin, none);
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

  h3 {
    margin: 0;
    font-size: 17px;
    font-weight: 800;
  }

  .mobile h3 {
    font-size: 16px;
  }

  .sec-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  h3 + .sec-desc {
    margin-top: 4px;
  }

  .mobile .sec-desc {
    margin-top: 5px;
    font-size: 14px;
  }

  .mobile h3 + .sec-desc {
    margin-top: 4px;
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

  input {
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border: 0;
    border-radius: 9999px;
    outline: none;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: box-shadow var(--dur, 220ms);
  }

  input:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile input {
    display: block;
    height: 46px;
    padding: 0 16px;
    font-size: 16px;
  }

  input.code {
    font-weight: 700;
    letter-spacing: 0.2em;
    font-variant-numeric: tabular-nums;
  }

  .err {
    font-size: 14px;
    font-weight: 700;
    color: var(--danger);
  }

  .name-err {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--danger);
  }

  .name-err :global(svg) {
    font-size: 16px;
    flex-shrink: 0;
  }

  /* Setup restarted in another window */
  .stale {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 12px 12px 14px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
    color: var(--danger);
  }

  .stale.mobile {
    margin-top: 10px;
  }

  .stale > :global(svg) {
    font-size: 19px;
    flex-shrink: 0;
  }

  .stale span {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .stale button {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 13px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
  }

  .stale button:hover {
    background: var(--sunken);
  }

  .stale button :global(svg) {
    font-size: 17px;
  }

  /* Password */
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    flex-wrap: wrap;
    padding: 16px 18px;
  }

  .mobile .field {
    display: block;
    padding: 14px 14px 12px;
  }

  .field-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .field-label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .field-label {
    font-size: 15px;
  }

  .field-desc {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .field-desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .field-ctl {
    position: relative;
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
  }

  .mobile .field-ctl {
    margin-top: 12px;
  }

  .field-ctl input {
    display: block;
    padding-right: 50px;
  }

  .mobile .field-ctl input {
    padding-right: 52px;
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
  }

  .mobile .eye:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .eye:active {
    background: var(--hov);
  }

  .pw-foot {
    display: flex;
    align-items: center;
    gap: 12px 16px;
    flex-wrap: wrap;
    padding: 14px 14px 14px 18px;
  }

  .mobile .pw-foot {
    display: block;
    padding: 6px 10px 10px;
  }

  .pw-msgs {
    flex: 1 1 220px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mobile .pw-foot .err {
    padding: 0 4px 10px;
  }

  .pw-note {
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .pw-note {
    padding: 10px 4px 0;
    font-size: 13px;
    text-align: center;
  }

  .pw-go {
    height: 44px;
    padding: 0 22px;
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

  .pw-go.ready {
    background: var(--acc);
    color: var(--accink);
    cursor: pointer;
  }

  .mobile .pw-go {
    width: 100%;
    height: 48px;
    font-size: 15px;
  }

  /* Authenticator apps and codes */
  .entry {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px;
    border-radius: 20px;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .entry.selected {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .mobile .entry {
    gap: 12px;
    padding: 8px 6px 8px 10px;
  }

  .rc-row {
    flex-wrap: wrap;
  }

  .mobile .rc-row {
    flex-wrap: nowrap;
    padding: 8px 10px;
  }

  .tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 20px;
  }

  .tile.device {
    font-size: 21px;
  }

  .mobile .tile {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 19px;
  }

  .mobile .tile.device {
    font-size: 20px;
  }

  .entry-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .rc-row .entry-text {
    flex: 1 1 180px;
  }

  .mobile .entry-text,
  .mobile .rc-row .entry-text {
    flex: 1;
    gap: 2px;
  }

  .entry-name {
    font-size: 15.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile .entry-name {
    font-size: 15px;
  }

  .entry-sub {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .entry-sub.wrap {
    overflow-wrap: break-word;
  }

  .mobile .entry-sub {
    font-size: 13px;
  }

  .mobile .entry-sub.wrap {
    line-height: 1.4;
  }

  .icon-btn {
    width: 40px;
    height: 40px;
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

  .icon-btn:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .icon-btn.trash:hover {
    color: var(--danger);
  }

  .mobile .icon-btn {
    width: 44px;
    height: 44px;
    font-size: 19px;
  }

  .mobile .icon-btn:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .icon-btn:active {
    background: var(--hov);
  }

  .mobile .icon-btn.trash:active {
    color: var(--danger);
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

  .add {
    width: 100%;
    margin-top: 4px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border-radius: 20px;
    border: 2px dashed var(--bdhi);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .add:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .add {
    height: 54px;
    font-size: 15px;
  }

  .mobile .add:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .add:active {
    background: var(--hov);
  }

  .panel-in {
    padding: 16px 18px 14px;
  }

  .mobile .panel-in {
    padding: 14px 10px 10px;
  }

  .name-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-width: 320px;
  }

  .mobile .name-field {
    max-width: none;
    padding: 0 4px;
  }

  .name-field span {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .scan {
    margin: 22px 0;
    display: flex;
    align-items: center;
    gap: 20px 24px;
    flex-wrap: wrap;
  }

  .scan-text {
    flex: 1 1 240px;
    min-width: 0;
  }

  /* white area and dark modules fixed as in the invitation so that every app reads the code */
  .qr {
    width: 160px;
    height: 160px;
    flex-shrink: 0;
    padding: 10px;
    border-radius: 20px;
    background: #fff;
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 24px;
    color: #74665a;
  }

  .qr svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .qr path {
    fill: #2b221c;
  }

  .qr-center {
    margin-top: 14px;
    display: flex;
    justify-content: center;
  }

  .step-head {
    margin-top: 20px;
    padding: 0 4px;
  }

  .step-title {
    font-size: 15px;
    font-weight: 700;
  }

  .step-title.confirm {
    margin-top: 20px;
    padding: 0 4px;
  }

  .step-text {
    margin-top: 3px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .step-text {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .secret {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile .secret {
    margin-top: 14px;
    gap: 6px;
    flex-wrap: nowrap;
  }

  .secret code {
    min-width: 0;
    min-height: 1em;
    padding: 10px 14px;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.04em;
    overflow-wrap: anywhere;
  }

  .mobile .secret code {
    flex: 1;
    padding: 11px 14px;
    font-size: 13.5px;
    letter-spacing: 0.03em;
    text-align: center;
  }

  .intro {
    margin-top: 3px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .intro {
    margin-top: 2px;
    padding: 0 4px;
    font-size: 13.5px;
    text-wrap: wrap;
  }

  .pair {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
  }

  .mobile .pair {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .acts {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .acts .err {
    flex: 1 1 200px;
    min-width: 0;
  }

  .mobile .acts {
    margin-top: 12px;
    flex-wrap: nowrap;
  }

  .mobile .panel-in > .err {
    margin-top: 10px;
    padding: 0 4px;
  }

  .cancel {
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .cancel:hover {
    background: var(--hov);
  }

  .go {
    height: 44px;
    padding: 0 22px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
  }

  .go.danger {
    background: var(--surface);
    color: var(--danger);
    box-shadow: var(--sh1);
  }

  .mobile .cancel,
  .mobile .go {
    flex: 1;
    height: 48px;
    font-size: 15px;
  }

  .mobile .cancel:hover {
    background: none;
  }

  .mobile .cancel:active {
    background: var(--hov);
  }

  .rc {
    margin-top: 28px;
  }

  .mobile .rc {
    margin-top: 24px;
  }

  .rc-box {
    margin-top: 14px;
  }

  .mobile .rc-box {
    margin-top: 12px;
  }

  .regen {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 12px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .regen:hover {
    transform: translateY(-2px);
  }

  .regen :global(svg) {
    width: 17px;
    height: 17px;
  }

  .mobile .regen {
    width: 100%;
    height: 50px;
    justify-content: center;
    gap: 9px;
    padding: 0;
    border-radius: 20px;
    background: none;
    box-shadow: none;
    font-size: 15px;
  }

  .mobile .regen :global(svg) {
    width: 19px;
    height: 19px;
  }

  .mobile .regen:hover {
    transform: none;
  }

  .mobile .regen:active {
    background: var(--hov);
  }

  .codes {
    margin-top: 14px;
    padding: 18px 18px 16px 20px;
    border-radius: 24px;
    background: var(--accsoft);
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .codes {
    margin-top: 12px;
    padding: 16px 14px 14px;
    border-radius: 22px;
  }

  .codes-hint {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .mobile .codes-hint {
    gap: 10px;
    padding: 0 2px;
    font-size: 14px;
    text-wrap: wrap;
  }

  .hint-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 22px;
    color: var(--deep);
  }

  .mobile .hint-icon {
    font-size: 21px;
  }

  ol {
    margin: 14px 0 0;
    padding: 10px 16px;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 2px 20px;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .mobile ol {
    margin-top: 12px;
    padding: 8px 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 12px;
    border-radius: 14px;
  }

  li {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
  }

  .mobile li {
    gap: 8px;
    font-size: 14px;
    letter-spacing: 0.04em;
  }

  .n {
    width: 18px;
    flex-shrink: 0;
    text-align: right;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0;
    color: var(--mfg);
  }

  .mobile .n {
    width: 16px;
    font-size: 11.5px;
  }

  .codes-acts {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile .codes-acts {
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .grow {
    flex: 1;
  }

  .soft {
    height: 42px;
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
  }

  .soft :global(svg) {
    width: 17px;
    height: 17px;
  }

  .mobile .soft {
    flex: 1;
    height: 46px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .mobile .soft :global(svg) {
    width: 18px;
    height: 18px;
  }

  .done {
    height: 42px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .done:hover {
    background: var(--hov);
  }

  .mobile .done {
    flex-basis: 100%;
    height: 46px;
    font-size: 15px;
  }

  .mobile .done:hover {
    background: none;
  }

  .mobile .done:active {
    background: var(--hov);
  }

  /* Signed-in devices */
  .sessions {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .session {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 12px 10px 10px;
  }

  .mobile .session {
    gap: 12px;
    padding: 8px 6px 8px 10px;
  }

  .this {
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

  .mobile .this {
    height: 26px;
    margin-right: 6px;
    padding: 0 10px;
    font-size: 12px;
  }

  .revoke {
    height: 38px;
    flex-shrink: 0;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .revoke:hover {
    transform: translateY(-2px);
  }

  .sessions-sep {
    margin: 4px 18px;
  }

  .mobile .sessions-sep {
    margin: 2px 14px;
  }

  .others {
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border-radius: 20px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--danger);
    transition: background-color var(--dur, 220ms);
  }

  .others :global(svg) {
    width: 18px;
    height: 18px;
  }

  .others:hover {
    background: var(--hov);
  }

  .mobile .others {
    height: 50px;
    font-size: 15px;
  }

  .mobile .others :global(svg) {
    width: 19px;
    height: 19px;
  }

  .mobile .others:hover {
    background: none;
  }

  .mobile .others:active {
    background: var(--hov);
  }
</style>
