<!--
  Account › Email accounts: list of the mail accounts and "New email account".
  One component for `/account/mail-accounts` and `/account/mail-accounts/new`
  (`adding`: form open); flow and values in `#lib/mail-accounts.svelte.ts`,
  the sign-in itself in `#lib/auth/mail-login.svelte.ts`.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { autofocus } from '#lib/actions/autofocus.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { MailAccountsPage, mailAccountsValues, type ServerSelect } from '#lib/mail-accounts.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { pickPop, selIds, selKey } from '#lib/select.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { adding }: { adding: boolean } = $props();
  // Name of the server picker: label of the field and the chosen server.
  const uid = $props.id();
  const srvIds = selIds(uid, 'srv');

  // The routes fix `adding`; the page is created anew per route.
  // svelte-ignore state_referenced_locally
  const p = new MailAccountsPage(
    {
      add: () => void goto(resolve('/account/mail-accounts/new')),
      list: () => void goto(resolve('/account/mail-accounts')),
      account: (id) => {
        // On mobile first the list of subpages of the email account.
        const to = resolve('/account/mail-accounts/[id]/overview', { id });
        if (ui.isMobile) ui.panelList = to;
        void goto(to);
      },
      servers: () => void goto(resolve('/admin/mail-servers')),
    },
    adding,
  );
  p.start();
  const v = $derived(mailAccountsValues(p, { isMobile: ui.isMobile }));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/account/mail-accounts'));
  type FieldEvent = Event & { currentTarget: HTMLInputElement };

  $effect(() => p.watchLock(p.flow.lockUntil));
  $effect(() => p.arm(p.form));
  $effect(() => p.report(p.form));

  onMount(() => {
    p.load();
    // On mobile the layout shows the server picker as a sheet.
    ui.pick = () => v.af?.sel ?? { title: '', opts: [] };
    return () => {
      if (ui.menu === 'pick') ui.closeMenu();
      ui.pick = null;
      p.dispose();
    };
  });
</script>

<!-- Server picker (`af.sel`): on desktop a popover at the button, on mobile the button opens the layout's sheet.
     Name: label of the field and the chosen server (`srvIds`). -->
{#snippet serverSelect(sel: ServerSelect)}
  {#if isMobile}
    <button
      type="button"
      class="sel-btn"
      class:dis={sel.disabled}
      onclick={sel.toggle}
      aria-haspopup="listbox"
      aria-disabled={sel.disabled}
      aria-labelledby={srvIds.labelledby}
      ><Icon name="ti-server-2" /><span class="sel-label" id={srvIds.value}>{sel.label}</span><span class="chev"
        ><Icon name="ti-chevron-down" /></span
      ></button
    >
  {:else}
    <div class="sel" class:dis={sel.disabled} data-pop>
      <button
        type="button"
        class="sel-btn"
        class:open={sel.open}
        onclick={sel.toggle}
        onkeydown={selKey(sel.onKey)}
        onkeyup={sel.onKeyUp}
        role="combobox"
        aria-expanded={sel.open}
        aria-controls={sel.open ? srvIds.list : undefined}
        aria-activedescendant={sel.open && sel.opts[sel.active] ? srvIds.opt(sel.active) : undefined}
        aria-disabled={sel.disabled}
        aria-labelledby={srvIds.labelledby}
        ><Icon name="ti-server-2" /><span class="sel-label" id={srvIds.value}>{sel.label}</span><span class="chev"
          ><Icon name="ti-chevron-down" /></span
        ></button
      >
      {#if sel.open}
        <div
          role="listbox"
          id={srvIds.list}
          aria-label={sel.title}
          class="pick-pop no-scrollbar"
          use:pickPop
          {@attach scrollbar}
        >
          {#each sel.opts as o, i (i)}
            <button
              type="button"
              role="option"
              id={srvIds.opt(i)}
              aria-selected={o.on}
              tabindex="-1"
              class="pick-opt"
              class:hi={o.hi}
              class:on={o.on}
              onclick={o.onClick}
              onmousemove={o.hover}
            >
              <span class="pick-text">
                <span class="pick-label" style:font-weight={o.fw}>{o.label}</span>
                {#if o.hasSub}<span class="pick-sub">{o.sub}</span>{/if}
              </span>
              <span class="pick-check"><Icon name="ti-check" /></span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{m.mail_accounts_lead()}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <section data-sec="mail" class="sec">
    {#if isMobile}<p class="sec-lead">{m.mail_accounts_lead()}</p>{/if}
    <div class="box">
      {#if v.maAll.show}
        <!-- "All accounts" (`maAll`, `allT`): from two accounts on, selectable as the default at start. -->
        <div class="all">
          <span class="all-tiles"
            ><span class="all-stack"
              >{#each v.allT as x, i (i)}<span class="all-mini" style:background={x.bg} style:color={x.ink}
                  >{x.letter}</span
                >{/each}</span
            ></span
          >
          <span class="acct-text">
            <span class="acct-head"
              ><span class="all-name">{m.mail_accounts_all()}</span>{#if v.maAll.isDefault}<span
                  class="badge"
                  use:tooltip={isMobile ? undefined : m.mail_accounts_all_default_tip()}
                  >{m.mail_accounts_default()}</span
                >{/if}</span
            >
            <span class="acct-sub">{m.mail_accounts_all_sub()}</span>
          </span>
          {#if !v.maAll.isDefault}
            {#if isMobile}
              <button
                type="button"
                class="make-def"
                onclick={v.maAll.makeDefault}
                aria-label={m.mail_accounts_make_default()}><Icon name="ti-star" /></button
              >
            {:else}
              <button type="button" class="make-def" onclick={v.maAll.makeDefault}
                ><span class="make-def-icon"><Icon name="ti-star" /></span>{m.mail_accounts_make_default()}</button
              >
            {/if}
          {/if}
        </div>
      {/if}
      {#each v.maList as a (a.id)}
        <div class="acct">
          <button type="button" class="acct-btn" onclick={a.openAcct}>
            <span class="chip" style:background={a.chip} style:color={a.chipInk}><Icon name="ti-mail" /></span>
            <span class="acct-text">
              <span class="acct-head"
                ><span class="acct-email">{a.email}</span>{#if a.isDefault}<span
                    class="badge"
                    use:tooltip={isMobile ? undefined : m.mail_accounts_default_tip()}>{m.mail_accounts_default()}</span
                  >{/if}</span
              >
              {#if isMobile}
                <span
                  class="st"
                  class:auth={a.kind === 'auth'}
                  class:blocked={a.kind === 'blocked'}
                  class:busy={a.kind === 'busy'}><span class="dot"></span><span class="st-text">{a.st}</span></span
                >
              {:else}
                <span class="acct-sub">{a.sub}</span>
              {/if}
            </span>
            {#if !isMobile}
              <span class="acct-st">
                <span
                  class="st"
                  class:auth={a.kind === 'auth'}
                  class:blocked={a.kind === 'blocked'}
                  class:busy={a.kind === 'busy'}><span class="dot"></span><span class="st-text">{a.st}</span></span
                >
                <span class="last">{a.last}</span>
              </span>
            {/if}
            <span class="go-icon"><Icon name="ti-chevron-right" /></span>
          </button>
        </div>
      {/each}
      {#if v.maEmpty}<div class="empty">{m.mail_accounts_empty()}</div>{/if}

      {#if v.af}
        {@const af = v.af}
        <div class="form">
          {#if af.isCred}
            <div class="f-title">{m.mail_accounts_new()}</div>
            <div class="f-intro">{m.mail_accounts_new_intro()}</div>
            <div class="fields">
              <label class="field"
                ><span class="f-label">{m.mail_accounts_email()}</span><input
                  class="inp"
                  type="email"
                  value={af.email}
                  use:autofocus={!isMobile}
                  oninput={(e: FieldEvent) => af.onEmail(e.currentTarget.value)}
                  onkeydown={af.key}
                  placeholder={m.mail_accounts_email_placeholder()}
                  autocomplete="email"
                  autocapitalize="off"
                  spellcheck="false"
                /></label
              >
              <div class="field">
                <span class="f-label" id={srvIds.label}>{af.sel.title}</span>
                {@render serverSelect(af.sel)}
                {#if af.hintOk}
                  <span class="hint-ok"><Icon name="ti-circle-check" />{af.hint}</span>
                {/if}
                {#if af.hintWarn}
                  <span class="hint-warn"><Icon name="ti-info-circle" />{af.hint}</span>
                {/if}
              </div>
              {#if af.isOther}
                <label class="field"
                  ><span class="f-label">{m.mail_accounts_url()}</span><input
                    class="inp"
                    type="url"
                    value={af.url}
                    oninput={(e: FieldEvent) => af.onUrl(e.currentTarget.value)}
                    onkeydown={af.key}
                    placeholder={m.mail_accounts_url_placeholder()}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                  /></label
                >
              {/if}
              {#snippet authSeg()}
                <div role="radiogroup" use:radiogroup aria-label={m.mail_accounts_auth()} class="seg">
                  {#each af.authOpts as o (o.label)}
                    <button type="button" role="radio" aria-checked={o.on} class:on={o.on} onclick={o.onClick}
                      >{o.label}</button
                    >
                  {/each}
                </div>
              {/snippet}
              {#if isMobile}
                {@render authSeg()}
              {:else}
                <div class="field"><span class="f-label">{m.mail_accounts_auth()}</span>{@render authSeg()}</div>
              {/if}
              {#if af.isTok}
                <label class="field"
                  ><span class="f-label">{m.mail_accounts_token()}</span>
                  <span class="sec-wrap">
                    <input
                      class="inp sec-inp"
                      type={af.secType}
                      value={af.sec}
                      oninput={(e: FieldEvent) => af.onSec(e.currentTarget.value)}
                      onkeydown={af.key}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                    />
                    <button
                      type="button"
                      class="eye"
                      onclick={af.onEye}
                      aria-label={af.eyeTip}
                      use:tooltip={isMobile ? undefined : af.eyeTip}><Icon name={af.eyeIcon} /></button
                    >
                  </span>
                </label>
              {/if}
              {#if af.isPw && isMobile}
                <div class="pw-hint"><Icon name="ti-info-circle" /><span>{af.pwHint}</span></div>
              {/if}
            </div>
            {#if af.isPw && !isMobile}
              <div class="pw-hint"><Icon name="ti-info-circle" /><span>{af.pwHint}</span></div>
            {/if}
          {/if}

          {#if af.isRet}
            <div role="status" class="ret">
              <span class="ret-tile"><span class="spin"><Icon name="ti-loader-2" /></span></span>
              <div class="st-body">
                <div class="ret-title">{af.retTitle}</div>
                <div class="st-desc">{af.retText}</div>
              </div>
            </div>
          {/if}

          {#if af.isDone}
            <div role="status" class="done">
              <span class="done-tile"><Icon name="ti-circle-check" /></span>
              <div class="st-body">
                <div class="done-title">{af.doneTitle}</div>
                <div class="st-desc">{af.doneText}</div>
              </div>
              <button type="button" class="done-go" onclick={af.doneGo}>{m.mail_accounts_open_now()}</button>
            </div>
          {/if}

          {#if af.busy}
            <div role="status" class="busy">
              <span class="busy-tile"><span class="spin"><Icon name="ti-loader-2" /></span></span>{af.busyText}
            </div>
          {/if}

          {#if af.hasErr}
            <div role="alert" class="err">
              <span class="err-tile"><Icon name={af.eIcon} /></span>
              <div class="err-body">
                <div class="err-title">{af.eTitle}</div>
                <div class="err-text">{af.eText}</div>
                {#if af.eHasCode}<div class="err-code">{m.mail_accounts_server_code({ code: af.eCode })}</div>{/if}
                {#if af.eHasAct}
                  <button type="button" class="err-act" onclick={af.eFn}><Icon name="ti-arrow-right" />{af.eAct}</button
                  >
                {/if}
              </div>
            </div>
          {/if}

          {#if af.isCred}
            {#snippet submit()}
              <button
                type="button"
                class="submit"
                class:hot={af.hot}
                class:ready={af.ready}
                class:locked={af.locked}
                class:busy={af.busy}
                aria-disabled={af.btnDis}
                onclick={af.submit}
                ><span class="btn-icon" class:spin={af.btnSpin}><Icon name={af.btnIcon} /></span>{af.btnLabel}</button
              >
            {/snippet}
            <div class="acts">
              {#if isMobile}
                {@render submit()}
                <button type="button" class="cancel" onclick={af.cancel}>{m.mail_accounts_cancel()}</button>
              {:else}
                <span class="grow"></span>
                <button type="button" class="cancel" onclick={af.cancel}>{m.mail_accounts_cancel()}</button>
                {@render submit()}
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if v.afClosed}
        <button type="button" class="add" onclick={v.afStart}><Icon name="ti-plus" />{m.mail_accounts_add()}</button>
      {/if}
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
    text-wrap: pretty;
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

  .sec {
    margin-top: 28px;
  }

  .mobile .sec {
    margin-top: 20px;
  }

  .sec-lead {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
  }

  .box {
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mobile .box {
    margin-top: 16px;
    border-radius: 24px;
    padding: 4px;
  }

  /* Row "All accounts" (`maAll`) with the first three tiles (`allT`) */
  .all {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px;
    border-radius: 20px;
  }

  .mobile .all {
    min-height: 64px;
    gap: 12px;
    padding: 8px;
  }

  .all-tiles {
    min-width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .mobile .all-tiles {
    min-width: 42px;
    height: 42px;
  }

  .all-stack {
    display: flex;
    align-items: center;
    padding-left: 15px;
  }

  .mobile .all-stack {
    padding-left: 14px;
  }

  .all-mini {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    margin-left: -15px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 2.5px var(--surface2);
    font-family: var(--font-serif);
    font-size: 14px;
  }

  .mobile .all-mini {
    width: 32px;
    height: 32px;
    margin-left: -14px;
    border-radius: 11px;
    font-size: 13.5px;
  }

  .all-name {
    font-size: 15.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .mobile .all-name {
    font-size: 15px;
  }

  .mobile .all .acct-sub {
    font-size: 13px;
  }

  /* "Set as default": on desktop with text, on mobile only the star */
  .make-def {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 13px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .make-def:hover {
    background: var(--sunken);
  }

  .make-def-icon {
    display: grid;
    font-size: 17px;
  }

  .mobile .make-def {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    padding: 0;
    font-size: 19px;
    transition: none;
  }

  .mobile .make-def:hover {
    background: var(--surface);
  }

  .mobile .make-def:active {
    background: var(--sunken);
  }

  /* Row of an account (collapsed: transparent background, no shadow, no tile line) */
  .acct {
    border-radius: 20px;
    background: transparent;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .acct-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 16px 10px 10px;
    border-radius: 20px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .acct-btn:hover {
    background: var(--hov);
  }

  .mobile .acct-btn {
    min-height: 64px;
    gap: 12px;
    padding: 8px 12px 8px 8px;
    transition: none;
  }

  .mobile .acct-btn:hover {
    background: none;
  }

  .mobile .acct-btn:active {
    background: var(--hov);
  }

  .chip {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    display: grid;
    place-items: center;
    font-size: 20px;
    transition:
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color var(--dur, 220ms);
  }

  .mobile .chip {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 19px;
  }

  .acct-text {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .acct-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mobile .acct-head {
    gap: 6px;
  }

  .acct-email {
    font-size: 15.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile .acct-email {
    font-size: 15px;
  }

  .badge {
    flex-shrink: 0;
    height: 22px;
    padding: 0 8px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .acct-sub {
    font-size: 13.5px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-st {
    flex: 0 1 200px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  /* Status: "Sign-in required" in the error color, otherwise the dot fixed green */
  .st {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
  }

  .mobile .st {
    gap: 7px;
    font-size: 13px;
  }

  .st.auth,
  .st.blocked {
    color: var(--danger);
  }

  .dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: #5fbf73;
    transition: background-color var(--dur, 220ms);
  }

  .mobile .dot {
    width: 8px;
    height: 8px;
    transition: none;
  }

  .st.auth .dot,
  .st.blocked .dot {
    background: var(--danger);
  }

  /* "Checking …" (`MAS.busy`) */
  .st.busy .dot {
    background: var(--acc);
  }

  .st-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .last {
    padding-left: 17px;
    font-size: 13px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .go-icon {
    width: 18px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 18px;
    color: var(--mfg);
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

  /* New email account */
  .form {
    margin-top: 4px;
    padding: 18px 18px 16px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    animation: snFade 200ms ease-out;
  }

  .mobile .form {
    padding: 16px 12px 12px;
  }

  .f-title {
    font-size: 15.5px;
    font-weight: 800;
  }

  .mobile .f-title {
    padding: 0 4px;
    font-size: 15px;
  }

  .f-intro {
    margin-top: 3px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .f-intro {
    margin-top: 2px;
    padding: 0 4px;
    font-size: 13.5px;
  }

  .fields {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px 12px;
  }

  .mobile .fields {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }

  .mobile .field {
    padding: 0 2px;
  }

  .f-label {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .mobile .f-label {
    padding: 0 2px;
  }

  .inp {
    display: block;
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 14px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .inp:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile .inp {
    height: 46px;
    padding: 0 16px;
    font-size: 16px;
    transition: none;
  }

  .sec-wrap {
    position: relative;
    display: block;
  }

  .inp.sec-inp {
    padding: 0 50px 0 18px;
  }

  .mobile .inp.sec-inp {
    padding: 0 52px 0 16px;
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

  /* Server picker (`mkSel`): ring and chevron while open; disabled half transparent */
  .sel {
    position: relative;
    min-width: 0;
    transition: opacity var(--dur, 220ms);
  }

  .sel.dis,
  .sel-btn.dis {
    opacity: 0.5;
  }

  .sel-btn {
    width: 100%;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px 0 18px;
    border-radius: 9999px;
    background: var(--surface2);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    text-align: left;
    transition: box-shadow var(--dur, 220ms);
  }

  .sel-btn.open {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .sel.dis .sel-btn,
  .sel-btn.dis {
    cursor: default;
  }

  .sel-btn > :global(svg) {
    font-size: 17px;
    color: var(--mfg);
  }

  .sel-label {
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

  .sel-btn.open .chev {
    transform: rotate(180deg);
  }

  .mobile .sel-btn {
    height: 46px;
    padding: 0 14px 0 16px;
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 15px;
    transition: none;
  }

  .mobile .sel-btn > :global(svg) {
    font-size: 18px;
  }

  .mobile .chev {
    font-size: 17px;
  }

  .pick-pop {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 30;
    width: 100%;
    min-width: 260px;
    max-height: 300px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    color: var(--fg);
    box-shadow: var(--sh3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform-origin: top center;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .pick-opt {
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

  .pick-opt.hi {
    background: var(--hov);
  }

  .pick-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .pick-label {
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick-sub {
    font-size: 12.5px;
    color: var(--mfg);
  }

  .pick-check {
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

  .pick-check :global(svg) {
    opacity: 0;
  }

  .pick-opt.on .pick-check {
    background: var(--ink);
  }

  .pick-opt.on .pick-check :global(svg) {
    opacity: 1;
  }

  /* Hints below the server picker */
  .hint-ok {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
  }

  .hint-ok :global(svg) {
    font-size: 15px;
    color: #4fae64;
  }

  .hint-warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 0 6px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--mfg);
  }

  .hint-warn :global(svg) {
    font-size: 15px;
    margin-top: 1px;
  }

  /* Segment "Sign-in" (`authOpts`) */
  .seg {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .mobile .seg {
    margin: 0 2px;
  }

  .seg button {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    background: transparent;
    color: var(--mfg);
    box-shadow: none;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .seg button:hover {
    color: var(--fg);
  }

  .seg button.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .mobile .seg button {
    height: 38px;
    padding: 0;
    transition: none;
  }

  .mobile .seg button:hover {
    color: var(--mfg);
  }

  .mobile .seg button.on {
    color: var(--fg);
  }

  .pw-hint {
    margin-top: 14px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .pw-hint :global(svg) {
    font-size: 16px;
    margin-top: 1px;
  }

  .pw-hint span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .mobile .pw-hint {
    margin-top: 0;
    padding: 0 4px;
  }

  /* Return and success */
  .ret,
  .done {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .ret {
    animation: snFade 220ms ease-out;
  }

  .mobile .ret {
    padding: 0 2px;
  }

  .done {
    animation: snPop 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .done {
    flex-wrap: wrap;
  }

  .ret-tile,
  .done-tile {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    border-radius: 16px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
  }

  .ret-tile {
    background: var(--accsoft);
    color: var(--deep);
    font-size: 22px;
  }

  .done-tile {
    background: var(--acc);
    color: var(--accink);
    box-shadow: var(--sh1);
    font-size: 24px;
  }

  .st-body {
    flex: 1;
    min-width: 0;
  }

  .ret-title,
  .done-title {
    font-size: 15.5px;
    font-weight: 800;
    overflow-wrap: anywhere;
  }

  .ret-title {
    line-height: 1.35;
    text-wrap: pretty;
  }

  .st-desc {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .done-go {
    height: 40px;
    flex-shrink: 0;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
  }

  .mobile .done-go {
    width: 100%;
    height: 46px;
  }

  /* Spinner via `--spin` (off with animations=false) */
  .spin {
    display: grid;
    animation: var(--spin, none);
  }

  .busy {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 10px;
    border-radius: 16px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .busy-tile {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 10px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 16px;
  }

  /* Error box */
  .err {
    margin-top: 14px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px 12px 12px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--danger) 10%, var(--surface2));
    animation: snFade 200ms ease-out;
  }

  .err-tile {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    color: var(--danger);
    display: grid;
    place-items: center;
    font-size: 18px;
    transform: rotate(-6deg);
  }

  .err-body {
    flex: 1;
    min-width: 0;
    padding-top: 1px;
  }

  .err-title {
    font-size: 14.5px;
    font-weight: 800;
    color: var(--danger);
  }

  .err-text {
    margin-top: 2px;
    font-size: 14px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .err-code {
    margin-top: 6px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12.5px;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .err-act {
    margin-top: 10px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .err-act :global(svg) {
    font-size: 15px;
  }

  .mobile .err-act {
    height: 42px;
  }

  /* Buttons of the form */
  .acts {
    margin-top: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mobile .acts {
    margin-top: 14px;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  .grow {
    flex: 1;
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

  .mobile .cancel {
    width: 100%;
    font-size: 15px;
    transition: none;
  }

  .mobile .cancel:hover {
    background: none;
  }

  .mobile .cancel:active {
    background: var(--hov);
  }

  /* Submit: accent as soon as ready or while loading (`hot`); cursor by state */
  .submit {
    height: 44px;
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

  .submit.hot {
    background: var(--acc);
    color: var(--accink);
  }

  .submit.ready {
    cursor: pointer;
  }

  .submit.locked {
    cursor: not-allowed;
  }

  .submit.busy {
    cursor: progress;
  }

  .btn-icon {
    display: grid;
    font-size: 17px;
  }

  .mobile .submit {
    width: 100%;
    height: 48px;
    justify-content: center;
    padding: 0 16px;
    font-size: 15px;
  }

  .mobile .btn-icon {
    font-size: 18px;
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

  .add :global(svg) {
    font-size: 18px;
  }

  .add:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .add {
    height: 54px;
    font-size: 15px;
    transition: none;
  }

  .mobile .add :global(svg) {
    font-size: 19px;
  }

  .mobile .add:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .add:active {
    background: var(--hov);
  }
</style>
