<!--
  Administration › Email: system mail with status and "Test connection",
  connection (server from the registry, sign-in with password or token),
  sender, sending, test email and the "Unsaved changes" bar. Flow and values
  in `#lib/system-mail.svelte.ts`; the state API shows the "Changes saved"
  toast with undo. The "Templates" section shows the preview rendered by the
  backend (`#lib/mail-preview.svelte.ts`), the HTML in the sandboxed iframe
  (`TemplateFrame`). The "Mail server" and "Variant" pick lists are a popover
  at the button on desktop (`ui.menu = 'pick'`), on mobile the layout shows
  the pick list in the sheet (`ui.pick`). The status, tile, cursor, ring and
  switch styles are classes derived from `v.mSt.key`, `busy`, `on` and `open`.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { tablist } from '#lib/actions/tablist.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import FirstLoad from '#lib/components/FirstLoad.svelte';
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import TemplateFrame from '#lib/components/TemplateFrame.svelte';
  import { MailPreview, mailPreviewValues } from '#lib/mail-preview.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { pickPop, selIds, selKey, type SelectValues } from '#lib/select.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { SystemMailPage, systemMailValues, type MailPick, type SystemMailContext } from '#lib/system-mail.svelte.ts';

  const p = new SystemMailPage();
  const preview = new MailPreview();
  let root: HTMLElement | undefined = $state();
  const uid = $props.id();
  // Name of the pick lists: label of the row or the "Variant" prefix and value.
  const srvIds = selIds(uid, 'srv');
  const varIds = selIds(uid, 'var');
  /** Open pick list while `ui.menu` is `pick`. */
  let sel = $state<MailPick | null>(null);
  /** Highlighted row of the open list. */
  let hi = $state<number | null>(null);

  const ctx: SystemMailContext = {
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    goServers: () => void goto(resolve('/admin/mail-servers')),
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
  const pickState = $derived({ open: ui.menu === 'pick' ? sel : null, hi, isMobile: ui.isMobile });
  const v = $derived(systemMailValues(p, pickState, ctx));
  const mv = $derived(mailPreviewValues(preview, pickState, ctx));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/email'));

  // The preview loads as soon as the account is loaded, and again when the server confirms a new
  // state (save, new identities): the backend builds "From" from it. A language
  // switch loads it in the new language.
  $effect(() => {
    void p.confirmed;
    void prefs.lang;
    if (p.status === 'ready') untrack(() => void preview.load());
  });

  onMount(() => {
    void p.load();
    // On mobile the layout shows the open pick list as a sheet.
    ui.pick = () => (sel === 'mvvar' && mv.mvVarSel ? mv.mvVarSel : v.selMailSrv);
    return () => {
      p.dispose();
      preview.dispose();
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

<!-- Pick list: "Mail server" with server icon, "Variant" of the templates (`prefix`) with the label before the value; select-only combobox on desktop, button for the sheet on mobile. -->
{#snippet select(s: SelectValues, prefix?: string)}
  {@const ids = prefix === undefined ? srvIds : varIds}
  <div class="pick" class:var={prefix !== undefined} data-pop>
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
      aria-labelledby={ids.labelledby}
    >
      {#if prefix === undefined}
        <span class="pick-icon"><Icon name="ti-server-2" /></span>
      {:else}
        <span class="pick-prefix" id={ids.label}>{prefix}</span>
      {/if}
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
        {#each s.opts as o, i (i)}
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

<div bind:this={root} class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <FirstLoad
    status={p.status}
    slow={p.loading.slow}
    title={m.system_mail_load_failed()}
    text={p.failure}
    onRetry={() => void p.retry()}
    {isMobile}
  >
    <div class="tabs no-scrollbar">
      {#each v.mailTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
    </div>

    <section data-sec="status" class="sec first">
      <h2 class="sec-title">{m.system_mail_status_title()}</h2>
      <div class="status st-{v.mSt.key}">
        <span class="st-tile"><Icon name={v.mSt.icon} /></span>
        <div class="st-text">
          <div class="st-title">{v.mSt.title}</div>
          <div class="st-sub">{v.mSt.sub}</div>
        </div>
        <button
          type="button"
          class="test"
          class:busy={v.mailBusy}
          aria-disabled={v.mailBusy}
          aria-busy={v.mailBusy}
          onclick={v.mailTest}
          ><span class="test-icon" style:--rot="{v.mailRot}deg"><Icon name="ti-refresh" /></span>{v.mailBtn}</button
        >
      </div>
      {#if v.mailOk}
        <div class="box rows">
          {#each v.mailRows as r (r.k)}
            <div>
              {#if r.sep}<div class="sep"></div>{/if}
              <div class="kv">
                <span class="kv-k">{r.k}</span>
                <span class="kv-v">{r.v}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section data-sec="conn" class="sec">
      <h2 class="sec-title">{m.system_mail_tab_conn()}</h2>
      <p class="sec-desc">{m.system_mail_conn_desc()}</p>
      <div class="box">
        <div class="row">
          {@render rowText(m.system_mail_srv_title(), v.mailSrvSub, srvIds.label)}
          <div class="srv">
            {#if v.mailSrvHas}{@render select(v.selMailSrv)}{/if}
            <button type="button" class="srv-go" onclick={v.mailSrvGo}
              >{#if v.mailSrvNone && !isMobile}<Icon name="ti-plus" />{/if}{m.system_mail_srv_manage()}<Icon
                name="ti-arrow-right"
              /></button
            >
          </div>
        </div>
        <div class="sep"></div>
        <div class="row">
          {@render rowText(m.system_mail_auth_label(), m.system_mail_auth_desc())}
          <div role="group" aria-label={m.system_mail_auth_label()} class="seg">
            {#each v.mailAuthOpts as o (o.value)}
              <button type="button" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>{o.label}</button>
            {/each}
          </div>
        </div>
        {#if v.mailIsPw}
          <div class="sep"></div>
          <div class="row">
            {@render rowText(m.system_mail_user_label(), m.system_mail_user_desc())}
            <input
              type="text"
              value={v.mailF.user}
              placeholder={m.system_mail_user_ph()}
              aria-label={m.system_mail_user_label()}
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
              oninput={(e) => v.mailOn.user(e.currentTarget.value)}
            />
          </div>
        {/if}
        <div class="sep"></div>
        <div class="row">
          {@render rowText(v.mailSecret.label, v.mailSecret.desc)}
          <div class="secret">
            <input
              type={v.mailSecret.type}
              value={v.mailSecret.value}
              placeholder={v.mailSecret.ph}
              autocomplete={v.mailSecret.ac}
              aria-label={v.mailSecret.label}
              autocapitalize="off"
              spellcheck="false"
              oninput={(e) => v.mailSecret.onChange(e.currentTarget.value)}
            />
            <button
              type="button"
              class="eye"
              aria-label={v.mailSecret.eyeTip}
              use:tooltip={isMobile ? undefined : v.mailSecret.eyeTip}
              onclick={v.mailSecret.onEye}><Icon name={v.mailSecret.eyeIcon} /></button
            >
          </div>
        </div>
      </div>
    </section>

    <section data-sec="sender" class="sec">
      <h2 class="sec-title">{m.system_mail_tab_sender()}</h2>
      <p class="sec-desc">{m.system_mail_sender_desc()}</p>
      <div class="box">
        <div class="row">
          {@render rowText(m.system_mail_name_label(), m.system_mail_name_desc())}
          <input
            type="text"
            value={v.mailF.name}
            placeholder={v.mailNamePh}
            aria-label={m.system_mail_name_label()}
            oninput={(e) => v.mailOn.name(e.currentTarget.value)}
          />
        </div>
        <div class="sep"></div>
        <div class="row">
          {@render rowText(m.system_mail_reply_label(), m.system_mail_reply_desc())}
          <input
            type="email"
            value={v.mailF.replyTo}
            placeholder={m.system_mail_reply_ph()}
            aria-label={m.system_mail_reply_label()}
            autocapitalize="off"
            spellcheck="false"
            oninput={(e) => v.mailOn.replyTo(e.currentTarget.value)}
          />
        </div>
        <div class="sep"></div>
        <div class="preview">
          <span class="row-label">{m.system_mail_preview()}</span>
          <span class="preview-from">{v.mailFrom}</span>
        </div>
      </div>
    </section>

    <section data-sec="delivery" class="sec">
      <h2 class="sec-title">{m.system_mail_tab_delivery()}</h2>
      <p class="sec-desc">{m.system_mail_delivery_desc()}</p>
      <div class="box">
        <div class="row toggle">
          {@render rowText(m.system_mail_keep_sent(), m.system_mail_keep_sent_desc())}
          <button
            type="button"
            role="switch"
            class="switch"
            class:on={v.tgMailSent.on}
            aria-checked={v.tgMailSent.on}
            aria-label={m.system_mail_keep_sent()}
            onclick={v.tgMailSent.onClick}><span class="knob"></span></button
          >
        </div>
      </div>
    </section>

    <section data-sec="test" class="sec">
      <h2 class="sec-title">{m.system_mail_test_title()}</h2>
      <p class="sec-desc">{m.system_mail_test_desc()}</p>
      <div class="box">
        <div class="row">
          {@render rowText(m.system_mail_to_label(), m.system_mail_to_desc())}
          <div class="to">
            <input
              type="email"
              value={v.mailToVal}
              aria-label={m.system_mail_to_label()}
              autocapitalize="off"
              spellcheck="false"
              oninput={(e) => v.onMailTo(e.currentTarget.value)}
              onkeydown={v.mailToKey}
            />
            {#if !isMobile}
              <button
                type="button"
                class="send"
                class:on={!v.mailSendDis}
                aria-disabled={v.mailSendDis}
                onclick={v.mailSend}><Icon name="ti-send" />{v.mailSendLabel}</button
              >
            {/if}
          </div>
        </div>
        {#if !isMobile}
          {#if v.mailNotOk}
            <div class="sep"></div>
            <div class="hint"><Icon name="ti-info-circle" />{m.system_mail_send_hint()}</div>
          {/if}
        {:else}
          <div class="m-send">
            {#if v.mailNotOk}<div class="hint"><Icon name="ti-info-circle" />{m.system_mail_send_hint()}</div>{/if}
            <button
              type="button"
              class="send"
              class:on={!v.mailSendDis}
              aria-disabled={v.mailSendDis}
              onclick={v.mailSend}><Icon name="ti-send" />{v.mailSendLabel}</button
            >
          </div>
        {/if}
      </div>
    </section>

    <section data-sec="tpl" class="sec">
      <h2 class="sec-title">{m.system_mail_tpl_title()}</h2>
      <p class="sec-desc tpl-lead">{isMobile ? m.system_mail_tpl_lead_mobile() : m.system_mail_tpl_lead()}</p>
      <div role="tablist" aria-label={m.system_mail_tpl_title()} class="tpl-tabs no-scrollbar" use:tablist>
        {#each mv.mvTabs as t (t.key)}
          <button
            type="button"
            role="tab"
            id="tpl-tab-{t.key}"
            aria-selected={t.on}
            aria-controls="tpl-panel"
            tabindex={t.on ? 0 : -1}
            class="tpl-tab"
            class:on={t.on}
            onclick={t.onClick}>{t.label}</button
          >
        {/each}
      </div>
      <div class="tpl-ctrl">
        {#if mv.mvVarSeg}
          <div role="group" aria-label={m.system_mail_tpl_variant()} class="tseg var-seg no-scrollbar">
            {#each mv.mvVarOpts as o (o.value)}
              <button type="button" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>{o.label}</button>
            {/each}
          </div>
        {/if}
        {#if mv.mvVarList && mv.mvVarSel}{@render select(mv.mvVarSel, m.system_mail_tpl_variant())}{/if}
        {#if !isMobile}<span class="spacer"></span>{/if}
        <div class="tpl-fmt">
          <div role="group" class="tseg">
            {#each mv.mvModeOpts as o (o.value)}
              <button type="button" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>{o.label}</button>
            {/each}
          </div>
          {#if mv.mvThemeOn}
            <div role="group" class="tseg">
              {#each mv.mvThemeOpts as o (o.value)}
                <button type="button" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}>{o.label}</button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div role="tabpanel" id="tpl-panel" aria-labelledby="tpl-tab-{mv.mvTabs.find((t) => t.on)?.key}">
        {#if mv.mvLoad.fail}
          <div class="tpl-load">
            <MailLoadCard
              icon="ti-cloud-off"
              title={mv.mvLoad.title}
              text={mv.mvLoad.text}
              load={{
                text: mv.mvLoad.text,
                retry: true,
                reauth: false,
                con: false,
                onRetry: mv.mvLoad.onRetry,
                goCon: () => {},
              }}
            />
          </div>
        {/if}
        {#if mv.mvLoad.show}
          <div class="box tpl-box" aria-busy={mv.mvLoad.busy}>
            <div class="tpl-head">
              <div class="tpl-kv">
                <span class="tpl-k">{m.system_mail_tpl_from()}</span>
                {#if mv.mvFromOk}<span class="tpl-v">{mv.mvFrom}</span>{/if}
                {#if mv.mvFromNo}
                  <span class="tpl-v from-none"><Icon name="ti-info-circle" /><span>{mv.mvFromHint}</span></span>
                {/if}
              </div>
              <div class="tpl-kv">
                <span class="tpl-k">{m.system_mail_tpl_to()}</span>
                {#if mv.mvLoad.ok}<span class="tpl-v">{mv.mvTo}</span>{/if}
              </div>
              <div class="tpl-kv">
                <span class="tpl-k">{m.system_mail_tpl_subject()}</span>
                {#if mv.mvLoad.ok}<span class="tpl-v subj">{mv.mvSubj}</span>{/if}
              </div>
            </div>
            <div class="tpl-stage">
              {#if mv.mvLoad.spin}
                <!-- Announced like the frame of the audit log (`role="status"`), not only `aria-busy` on the box -->
                <span class="tpl-pill" role="status"><Icon name="ti-loader-2" />{m.system_mail_tpl_loading()}</span>
              {/if}
              {#if mv.mvLoad.first}<div class="tpl-empty"></div>{/if}
              {#if mv.mvLoad.ok}
                <!-- Text in `--surface`, HTML in the mail's fixed page colour (`CL.page`) per theme; the loading state as `dim`. -->
                <div
                  class="tpl-frame"
                  class:text={mv.mvText !== null}
                  class:dark={mv.mvText === null && mv.mvScheme === 'dark'}
                  class:dim={mv.mvLoad.dim}
                >
                  <div class="tpl-scroll no-scrollbar">
                    {#if mv.mvDoc !== null}
                      <TemplateFrame doc={mv.mvDoc} title={mv.mvSubj} scheme={mv.mvScheme} />
                    {:else if mv.mvText !== null}
                      <pre class="tpl-text">{mv.mvText}</pre>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </section>

    {#if v.mailDirty}
      <DirtyBar onDiscard={v.mailDiscard} onSave={v.mailSave} {isMobile} />
    {/if}
  </FirstLoad>
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

  /* Status: colours per state (`mSt.bg`, `mSt.tile`, `mSt.ink`) */
  .status {
    --st-bg: var(--surface2);
    --st-tile: var(--surface);
    --st-ink: var(--fg);
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 16px 18px;
    flex-wrap: wrap;
    padding: 20px 20px 20px 22px;
    border-radius: 26px;
    background: var(--st-bg);
    transition: background-color var(--dur, 220ms);
  }

  .status.st-busy,
  .status.st-ok {
    --st-bg: var(--accsoft);
    --st-tile: var(--acc);
    --st-ink: var(--accink);
  }

  .status.st-err {
    --st-bg: color-mix(in oklab, var(--danger) 13%, var(--surface));
    --st-tile: var(--danger);
    --st-ink: var(--surface);
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
    transition: background-color var(--dur, 220ms);
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
    text-wrap: pretty;
  }

  .mobile .st-sub {
    font-size: 14px;
  }

  .test {
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

  .test.busy {
    cursor: progress;
  }

  .mobile .test {
    margin-top: 18px;
    align-self: stretch;
  }

  /* Rotates by the tile's tilt; without animations `--dur` is 0. */
  .test-icon {
    display: grid;
    font-size: 18px;
    transform: rotate(var(--rot));
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  /* Rows session, account, last checked */
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
    flex: 1 1 200px;
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
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .mobile .row-desc {
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

  input:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  /* Mail server: selection and "Manage mail servers" */
  .srv {
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }

  .mobile .srv {
    display: block;
  }

  .srv-go {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 700;
    color: var(--deep);
  }

  .srv-go :global(svg) {
    font-size: 14px;
  }

  .srv-go:hover {
    background: var(--hov);
  }

  .mobile .srv-go {
    margin-top: 8px;
    height: 40px;
    gap: 6px;
    padding: 0 8px;
    font-size: 14px;
  }

  .mobile .srv-go :global(svg) {
    font-size: 15px;
  }

  .mobile .srv-go:hover {
    background: none;
  }

  /* Pick list (mkSel) */
  .pick {
    position: relative;
    width: 100%;
    min-width: 0;
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
    padding: 0 14px 0 16px;
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

  .mobile .pick-btn {
    height: 46px;
    font-size: 15px;
    transition: none;
  }

  .pick-icon {
    display: grid;
    font-size: 17px;
    color: var(--mfg);
  }

  .mobile .pick-icon {
    font-size: 18px;
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
    min-height: 48px;
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

  /* "Sign-in" segment */
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
    height: 38px;
    padding: 0;
  }

  .mobile .seg button:hover:not(.on) {
    color: var(--mfg);
  }

  /* Password or access token with "Show" */
  .secret {
    position: relative;
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
  }

  .mobile .secret {
    margin-top: 12px;
  }

  .secret input {
    display: block;
    padding-right: 50px;
  }

  .mobile .secret input {
    margin-top: 0;
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
    transition: none;
  }

  .mobile .eye:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .eye:active {
    background: var(--hov);
  }

  /* Sender preview */
  .preview {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
  }

  .mobile .preview {
    display: block;
    padding: 14px;
  }

  .preview-from {
    min-width: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .mobile .preview-from {
    display: block;
    margin-top: 4px;
    font-size: 14.5px;
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

  /* Test email */
  .to {
    flex: 0 1 420px;
    min-width: 0;
    width: 100%;
    display: flex;
    gap: 8px;
  }

  .to input {
    flex: 1;
  }

  .mobile .to {
    display: block;
  }

  .send {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 0 16px;
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

  .send :global(svg) {
    font-size: 17px;
  }

  .send.on {
    background: var(--acc);
    color: var(--accink);
    cursor: pointer;
  }

  .mobile .send {
    width: 100%;
    height: 48px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .mobile .send :global(svg) {
    font-size: 18px;
  }

  .m-send {
    padding: 0 10px 10px;
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    font-size: 14px;
    color: var(--mfg);
  }

  .hint :global(svg) {
    font-size: 18px;
    flex-shrink: 0;
  }

  .mobile .hint {
    gap: 8px;
    padding: 2px 4px 12px;
  }

  .mobile .hint :global(svg) {
    font-size: 17px;
  }

  /* Templates */
  .tpl-lead {
    text-wrap: pretty;
  }

  .mobile .tpl-lead {
    line-height: 1.5;
  }

  /* Template tabs (active state as class `on`) */
  .tpl-tabs {
    margin-top: 18px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mobile .tpl-tabs {
    flex-wrap: nowrap;
    margin: 16px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
  }

  .tpl-tab {
    height: 38px;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .tpl-tab:hover {
    background: var(--sunken);
  }

  .tpl-tab.on {
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: none;
  }

  .mobile .tpl-tab {
    flex-shrink: 0;
    padding: 0 15px;
    font-size: 13.5px;
    transition: none;
  }

  .mobile .tpl-tab:hover:not(.on) {
    background: var(--surface);
  }

  /* Variant, HTML/text, light/dark */
  .tpl-ctrl {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile .tpl-ctrl {
    margin-top: 10px;
    flex-direction: column;
    align-items: stretch;
    flex-wrap: nowrap;
  }

  .spacer {
    flex: 1;
  }

  /* On desktop the segments sit directly in the row, on mobile side by side below the variant. */
  .tpl-fmt {
    display: contents;
  }

  .mobile .tpl-fmt {
    display: flex;
    gap: 8px;
  }

  .tseg {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .tseg button {
    height: 32px;
    padding: 0 13px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .tseg button.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .mobile .tseg button {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
  }

  .mobile .var-seg {
    overflow-x: auto;
  }

  .mobile .var-seg button {
    flex: 1 0 auto;
  }

  /* "Variant" pick list */
  .pick.var {
    width: 300px;
    max-width: 100%;
  }

  .mobile .pick.var {
    width: 100%;
    margin-top: 0;
  }

  .pick.var .pick-btn {
    height: 38px;
    gap: 8px;
    padding: 0 12px 0 16px;
    font-size: 13.5px;
  }

  .mobile .pick.var .pick-btn {
    height: 44px;
    padding: 0 14px 0 16px;
    font-size: 14px;
  }

  .pick-prefix {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--mfg);
  }

  .pick.var .pick-pop {
    left: 0;
    right: auto;
    min-width: 260px;
    max-height: 380px;
  }

  .pick.var .opt {
    min-height: 42px;
    padding: 6px 10px 6px 14px;
  }

  .pick.var .opt-label {
    font-size: 14px;
  }

  /* Header and preview */
  .box.tpl-box {
    margin-top: 12px;
  }

  .mobile .box.tpl-box {
    margin-top: 10px;
  }

  .tpl-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 16px 14px;
    font-size: 13.5px;
  }

  .mobile .tpl-head {
    padding: 10px 12px 12px;
    font-size: 13px;
  }

  .tpl-kv {
    display: flex;
    gap: 10px;
    min-width: 0;
  }

  .tpl-k {
    width: 64px;
    flex-shrink: 0;
    font-weight: 700;
    color: var(--mfg);
  }

  .mobile .tpl-k {
    width: 52px;
  }

  .tpl-v {
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .tpl-v.subj {
    font-weight: 800;
  }

  /* "From" without sender: muted notice with ti-info-circle */
  .tpl-v.from-none {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-weight: 400;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .from-none :global(svg) {
    display: block;
    flex-shrink: 0;
    width: 15px;
    height: 1lh;
  }

  .from-none > span {
    min-width: 0;
  }

  /* "Loading failed" card instead of header and frame */
  .tpl-load {
    --load-card-top: 12px;
  }

  .mobile .tpl-load {
    --load-card-top: 10px;
  }

  .mobile .tpl-load :global(.card) {
    border-radius: 24px;
  }

  /* Frame with the "Loading preview …" pill (`mvLoad.spin`) */
  .tpl-stage {
    position: relative;
  }

  .tpl-pill {
    position: absolute;
    top: 14px;
    left: 50%;
    z-index: 1;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh2);
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
    animation: snFade 200ms ease-out;
  }

  .tpl-pill :global(svg) {
    display: block;
    font-size: 15px;
    color: var(--mfg);
    animation: var(--spin, none);
  }

  /* Fixed page colours of the mail (`CL.page`), text in `--surface` */
  .tpl-frame {
    position: relative;
    border-radius: 20px;
    overflow: hidden;
    background: #f3eee7;
    transition: opacity var(--dur, 220ms);
  }

  /* Previous preview while the new one loads (`mvLoad.op`) */
  .tpl-frame.dim {
    opacity: 0.55;
  }

  .tpl-frame.dark {
    background: #181411;
  }

  .tpl-frame.text {
    background: var(--surface);
  }

  /* Border above the iframe; an inset box-shadow on the iframe itself would be hidden by it. */
  .tpl-frame::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--bd);
    pointer-events: none;
  }

  .tpl-scroll {
    overflow-x: auto;
  }

  .tpl-text {
    margin: 0;
    padding: 22px 24px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 1.65;
    color: var(--fg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Until the first response an empty frame at the height of the preview. */
  .tpl-empty {
    height: 560px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--bd);
    animation: var(--shim, none);
  }
</style>
