<!--
  Mail server dialog: create or edit a mail server (label, base URL,
  domains, OAuth client automatically via DCR or manually with a secret,
  redirect URI to copy). Values from `dialogValues()` in
  `#lib/servers.svelte.ts`; the layout shows the dialog on desktop above the
  shell and on mobile in the sheet (then only the content). Escape closes
  (layout).
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { dialogDrag } from '#lib/dialog-drag.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { MAX_LABEL, type KeyInput, type ServerDialogValues } from '#lib/servers.svelte.ts';

  interface Props {
    sd: ServerDialogValues;
    isMobile: boolean;
  }

  let { sd, isMobile }: Props = $props();

  const uid = $props.id();
  let labelInput: HTMLInputElement | undefined = $state();

  // On desktop straight into the label (`autoFocus`); on close back to where focus was.
  $effect(() => {
    const before = document.activeElement;
    if (!isMobile) labelInput?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });

  const key = (handler: (e: KeyInput) => void) => (event: KeyboardEvent) => handler(event);
</script>

{#snippet errorLine(text: string, extra = '')}
  <div role="alert" class="field-err {extra}">
    {#if !isMobile}<Icon name="ti-alert-circle" />{/if}{text}
  </div>
{/snippet}

{#snippet note(text: string)}
  <div class="note"><Icon name="ti-info-circle" /><span>{text}</span></div>
{/snippet}

{#snippet plainNote()}
  <div class="plain"><Icon name="ti-lock-open" /><span>{m.server_plain()}</span></div>
{/snippet}

{#snippet domains()}
  <div class="doms" class:bad={sd.hasEDom}>
    {#each sd.doms as d (d.d)}
      <span class="dom">{d.d}<button aria-label={d.rmLabel} onclick={d.rm}><Icon name="ti-x" /></button></span>
    {/each}
    <input
      bind:value={() => sd.domIn, sd.onDomIn}
      onkeydown={key(sd.domKey)}
      onblur={sd.domBlur}
      placeholder={sd.domPh}
      aria-label={m.server_domain_add()}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      enterkeyhint="done"
    />
  </div>
{/snippet}

{#snippet oauth()}
  <div class="oauth">
    <div class="oa-head">
      <span class="oa-title">{m.server_oa_title()}</span>
      {#if !isMobile}{@render oaSwitch()}{/if}
    </div>
    {#if isMobile}{@render oaSwitch()}{/if}
    {#if sd.isAuto}
      {#if sd.aNotOk}
        <p class="oa-intro">{isMobile ? m.server_oa_intro_mobile() : m.server_oa_intro()}</p>
        <div class="pair">
          <input
            class="pill-input"
            bind:value={() => sd.au, sd.onAu}
            placeholder={m.server_oa_user()}
            aria-label={m.server_oa_user_label()}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <input
            class="pill-input"
            type="password"
            bind:value={() => sd.ap, sd.onAp}
            placeholder={m.server_oa_password()}
            aria-label={m.server_oa_password_label()}
            autocomplete="off"
          />
        </div>
        {#if sd.hasEAdm}{@render errorLine(sd.eAdm, 'adm')}{/if}
        {#if sd.aLocked}
          <div role="alert" class="locked">
            <span class="locked-icon"><Icon name="ti-lock" /></span>
            <span><strong>{m.limit_title()}</strong> {sd.aLockText}</span>
          </div>
        {/if}
        {#if sd.aThr}
          <div role="alert" class="locked">
            <span class="locked-icon"><Icon name="ti-clock" /></span>
            <span><strong>{m.reg_throttled_title()}</strong> {sd.aThrText}</span>
          </div>
        {/if}
        {#if sd.hasLinkHint}{@render note(sd.linkHint)}{/if}
        <button
          class="reg"
          class:busy={sd.aBusy}
          class:off={sd.aLocked || sd.aThr}
          aria-busy={sd.aBusy}
          aria-disabled={sd.regDis}
          onclick={sd.reg}
          ><span class="reg-icon" class:spin={sd.aBusy}><Icon name={sd.regIcon} /></span>{sd.regLabel}</button
        >
      {/if}
      {#if sd.aOk}
        <div role="status" class="done">
          <span class="done-tile"><Icon name="ti-key" /></span>
          <div class="done-text">
            <div class="done-title">{m.server_oa_done()}</div>
            <div class="done-sub">
              {isMobile ? m.server_oa_secret_kept({ note: sd.cidNote }) : m.server_oa_discarded({ note: sd.cidNote })}
            </div>
          </div>
          {#if isMobile}
            <button class="again-icon" aria-label={m.server_oa_again()} onclick={sd.regAgain}
              ><Icon name="ti-refresh" /></button
            >
          {:else}
            <button class="again" onclick={sd.regAgain}>{m.server_oa_again()}</button>
          {/if}
        </div>
      {/if}
    {/if}
    {#if sd.isManual}
      <div class="pair">
        <input
          class="pill-input"
          bind:value={() => sd.cid, sd.onCid}
          placeholder={m.server_cid()}
          aria-label={m.server_cid()}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <!-- On mobile `.pair` dissolves: the hint sits directly below the client ID there. -->
        {#if isMobile && sd.hasCidHint}{@render note(sd.cidHint)}{/if}
        <div class="secret">
          <input
            class="pill-input"
            type={sd.showSec ? 'text' : 'password'}
            bind:value={() => sd.csec, sd.onCsec}
            placeholder={m.server_secret()}
            aria-label={m.server_secret()}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button
            class="eye"
            aria-label={sd.secTip}
            use:tooltip={isMobile ? undefined : sd.secTip}
            onclick={sd.onSecEye}><Icon name={sd.secIcon} /></button
          >
        </div>
      </div>
      {#if !isMobile && sd.hasCidHint}{@render note(sd.cidHint)}{/if}
      {#if sd.hasECred}{@render errorLine(sd.eCred, isMobile ? 'cred m' : 'cred')}{/if}
      <span class="hint oa-hint">{isMobile || sd.secReg ? sd.secPh : m.server_secret_hint({ text: sd.secPh })}</span>
    {/if}
    <!-- Client ID or secret invalid (`eCred`) stays visible in the "Automatic" mode too -->
    {#if sd.hasECred && !sd.isManual}{@render errorLine(sd.eCred, isMobile ? 'cred m' : 'cred')}{/if}
    <div class="redirect">
      <div class="redirect-text">
        <span class="redirect-label">{m.server_redirect()}</span>
        <span class="mono">{sd.redirect}</span>
      </div>
      {#if isMobile}
        <button class="copy-icon" aria-label={m.server_redirect_copy()} onclick={sd.copyRedirect}
          ><Icon name="ti-copy" /></button
        >
      {:else}
        <button class="copy" onclick={sd.copyRedirect}><Icon name="ti-copy" />{m.server_copy()}</button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet oaSwitch()}
  <div role="radiogroup" use:radiogroup aria-label={m.server_oa_title()} class="seg">
    {#each sd.oaOpts as o (o.label)}
      <button role="radio" aria-checked={o.on} class:on={o.on} style:box-shadow={o.shadow} onclick={o.onClick}
        >{o.label}</button
      >
    {/each}
  </div>
{/snippet}

{#if !isMobile}
  <div class="scrim" role="presentation" onmousedown={sd.overlay}>
    <div class="dialog" role="dialog" aria-modal="true" use:focustrap {@attach dialogDrag()} aria-labelledby="{uid}-t">
      <div class="head">
        <span class="tile"><Icon name={sd.icon} /></span>
        <div class="head-text">
          <div id="{uid}-t" class="title">{sd.title}</div>
          <div class="sub">{sd.sub}</div>
        </div>
        <button class="close" aria-label={m.shell_close()} use:tooltip={m.shell_close()} onclick={sd.close}
          ><Icon name="ti-x" /></button
        >
      </div>
      <div class="body no-scrollbar">
        <div class="grid">
          <label class="field">
            <span class="field-label">{m.server_label()}</span>
            <input
              bind:this={labelInput}
              class="box-input"
              class:bad={sd.hasELabel}
              bind:value={() => sd.label, sd.onLabel}
              onkeydown={key(sd.key)}
              placeholder={m.server_label_placeholder()}
              maxlength={MAX_LABEL}
              autocomplete="off"
            />
          </label>
          <label class="field">
            <span class="field-label">{m.server_url()}</span>
            <input
              class="box-input url"
              class:bad={sd.hasEUrl}
              type="url"
              bind:value={() => sd.url, sd.onUrl}
              onkeydown={key(sd.key)}
              placeholder={m.server_url_placeholder()}
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
        {#if sd.hasELabel}{@render errorLine(sd.eLabel, 'pull')}{/if}
        {#if sd.hasEUrl}{@render errorLine(sd.eUrl, 'pull')}{/if}
        {#if sd.plain}<div class="pull">{@render plainNote()}</div>{/if}
        <div class="stack">
          <span class="field-label">{m.server_domains()}</span>
          {@render domains()}
          {#if sd.hasEDom}{@render errorLine(sd.eDom)}{/if}
          <span class="hint">{m.server_domains_hint()}</span>
        </div>
        {@render oauth()}
      </div>
      <div class="foot">
        <button class="cancel" onclick={sd.close}>{m.server_dlg_cancel()}</button>
        <button class="save" aria-busy={sd.saving} onclick={sd.save}><Icon name="ti-stethoscope" />{sd.btn}</button>
      </div>
    </div>
  </div>
{:else}
  <div class="m-head">
    <span class="tile"><Icon name={sd.icon} /></span>
    <div class="head-text">
      <div class="title m">{sd.title}</div>
      <div class="sub">{sd.sub}</div>
    </div>
    <button class="close m" aria-label={m.shell_close()} onclick={sd.close}><Icon name="ti-x" /></button>
  </div>
  <div class="m-body">
    <label class="field m">
      <span class="field-label">{m.server_label()}</span>
      <input
        class="box-input m"
        class:bad={sd.hasELabel}
        bind:value={() => sd.label, sd.onLabel}
        placeholder={m.server_label_placeholder()}
        maxlength={MAX_LABEL}
        autocomplete="off"
      />
    </label>
    {#if sd.hasELabel}{@render errorLine(sd.eLabel, 'm')}{/if}
    <label class="field m">
      <span class="field-label">{m.server_url()}</span>
      <input
        class="box-input m url"
        class:bad={sd.hasEUrl}
        type="url"
        bind:value={() => sd.url, sd.onUrl}
        placeholder={m.server_url_placeholder()}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>
    {#if sd.hasEUrl}{@render errorLine(sd.eUrl, 'm')}{/if}
    {#if sd.plain}<div class="m-pad">{@render plainNote()}</div>{/if}
    <div class="stack m">
      <span class="field-label">{m.server_domains()}</span>
      {@render domains()}
      {#if sd.hasEDom}{@render errorLine(sd.eDom, 'm')}{/if}
      <span class="hint">{m.server_domains_hint_mobile()}</span>
    </div>
    {@render oauth()}
  </div>
  <div class="m-foot">
    <button class="cancel" onclick={sd.close}>{m.server_dlg_cancel()}</button>
    <button class="save" aria-busy={sd.saving} onclick={sd.save}>{sd.btn}</button>
  </div>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
    background: var(--scrim);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 24px;
    overflow-y: auto;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 560px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 32px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 24px 18px 8px 26px;
  }

  .m-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 2px 14px 8px;
  }

  .tile {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 16px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 22px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 22px;
  }

  .title.m {
    font-size: 21px;
  }

  .sub {
    margin-top: 2px;
    font-size: 14px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .close.m {
    width: 44px;
    height: 44px;
  }

  .close.m:hover {
    background: none;
    color: var(--mfg);
  }

  .close.m:active {
    background: var(--hov);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 16px 26px 22px;
  }

  .m-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 0 4px;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .field.m {
    gap: 7px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .m .field-label,
  .stack.m > .field-label {
    padding: 0 4px;
  }

  .box-input {
    height: 50px;
    padding: 0 16px;
    border-radius: 18px;
    border: 1px solid var(--bd);
    background: var(--surface);
    box-shadow: var(--sh1);
    outline: none;
    font-size: 15px;
    font-weight: 700;
  }

  .box-input.url {
    font-weight: 600;
  }

  .box-input.m {
    height: 52px;
    font-size: 16px;
  }

  .box-input:focus {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--accsoft);
  }

  .box-input.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  .field-err {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--danger);
  }

  .field-err :global(svg) {
    flex-shrink: 0;
    font-size: 16px;
  }

  .field-err.pull {
    margin-top: -8px;
  }

  .field-err.m {
    padding: 0 4px;
  }

  .field-err.adm {
    align-items: flex-start;
    padding: 0 2px;
    line-height: 1.4;
  }

  .field-err.adm :global(svg) {
    margin-top: 1px;
  }

  /* Longer messages at the client ID field (`redirect_mismatch`) wrap. */
  .field-err.cred {
    align-items: flex-start;
    line-height: 1.4;
  }

  .field-err.cred :global(svg) {
    margin-top: 1px;
  }

  /* Hint about linked accounts (`linkHint`, `cidHint`). */
  .note {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 0 2px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.45;
    color: var(--mfg);
  }

  .note :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 15px;
  }

  .m-body .note {
    padding: 0 4px;
  }

  .pull {
    margin-top: -8px;
  }

  .m-pad {
    padding: 0 4px;
  }

  .plain {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.45;
    color: var(--mfg);
  }

  .plain :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 15px;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .stack.m {
    gap: 7px;
  }

  .doms {
    min-height: 50px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border-radius: 18px;
    border: 1px solid var(--bd);
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .m .doms,
  .m-body .doms {
    min-height: 52px;
  }

  .doms.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  .dom {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px 0 11px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13.5px;
    font-weight: 700;
  }

  .dom button {
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 13px;
  }

  .dom button:hover {
    background: var(--sunken);
    color: var(--fg);
  }

  .m-body .dom {
    height: 34px;
    gap: 2px;
    padding: 0 2px 0 12px;
    font-size: 14px;
  }

  .m-body .dom button {
    width: 30px;
    height: 30px;
    font-size: 14px;
  }

  .m-body .dom button:hover {
    background: none;
    color: var(--mfg);
  }

  .doms input {
    flex: 1 1 120px;
    min-width: 100px;
    height: 34px;
    padding: 0 6px;
    border: 0;
    background: transparent;
    outline: none;
    font-size: 14.5px;
    font-weight: 600;
  }

  .m-body .doms input {
    height: 36px;
    font-size: 16px;
  }

  .hint {
    font-size: 13px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m-body .hint {
    padding: 0 4px;
    text-wrap: wrap;
  }

  .oauth {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-radius: 22px;
    background: var(--surface2);
  }

  .m-body .oauth {
    padding: 12px;
  }

  .oa-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0 2px;
  }

  .m-body .oa-head {
    gap: 8px;
    flex-wrap: nowrap;
    padding: 0;
  }

  .oa-title {
    font-size: 14.5px;
    font-weight: 800;
  }

  .seg {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .seg button {
    height: 32px;
    padding: 0 14px;
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

  .seg button.on {
    background: var(--surface);
    color: var(--fg);
  }

  .m-body .seg button {
    flex: 1;
    min-width: 0;
    height: 38px;
    padding: 0;
    font-size: 14px;
  }

  .oa-intro {
    margin: 0;
    padding: 0 2px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .m-body .oa-intro {
    padding: 0 4px;
    text-wrap: wrap;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .m-body .pair {
    display: contents;
  }

  .pill-input {
    height: 46px;
    min-width: 0;
    padding: 0 16px;
    border-radius: 9999px;
    border: 0;
    background: var(--surface);
    box-shadow: var(--sh1);
    outline: none;
    font-size: 14.5px;
    font-weight: 600;
  }

  .m-body .pill-input {
    height: 48px;
    font-size: 16px;
  }

  .pill-input:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .secret {
    position: relative;
    min-width: 0;
  }

  .secret .pill-input {
    display: block;
    width: 100%;
    padding-right: 48px;
  }

  .m-body .secret .pill-input {
    padding-right: 52px;
  }

  .eye {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 36px;
    height: 36px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .eye:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m-body .eye {
    top: 2px;
    right: 2px;
    width: 44px;
    height: 44px;
    font-size: 18px;
  }

  .m-body .eye:hover {
    background: none;
    color: var(--mfg);
  }

  .oa-hint {
    padding: 0 2px;
  }

  .m-body .oa-hint {
    padding: 0 4px;
  }

  .reg {
    align-self: flex-start;
    height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .reg:hover {
    transform: translateY(-2px);
  }

  .reg.busy {
    cursor: progress;
  }

  .m-body .reg {
    align-self: stretch;
    height: 48px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .m-body .reg:hover {
    transform: none;
  }

  .reg-icon {
    display: grid;
    font-size: 17px;
  }

  .m-body .reg-icon {
    font-size: 18px;
  }

  .spin {
    animation: var(--spin, none);
  }

  .done {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: 18px;
    background: var(--surface);
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .m-body .done {
    animation: none;
  }

  .done-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 18px;
  }

  .done-text {
    flex: 1;
    min-width: 0;
  }

  .done-title {
    font-size: 14.5px;
    font-weight: 800;
  }

  /* Wraps instead of truncating, otherwise "Admin credentials discarded" would be missing. */
  .done-sub {
    margin-top: 1px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--mfg);
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .again {
    height: 34px;
    flex-shrink: 0;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .again:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .again-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
  }

  .redirect {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 14px;
    border-radius: 16px;
    background: var(--surface);
  }

  .m-body .redirect {
    gap: 8px;
    padding: 6px 4px 6px 14px;
  }

  .redirect-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .m-body .redirect-text {
    gap: 0;
  }

  .redirect-label {
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .mono {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m-body .mono {
    font-size: 12.5px;
  }

  .copy {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 11px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }

  .copy :global(svg) {
    font-size: 15px;
  }

  .copy:hover {
    background: var(--sunken);
  }

  .copy-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .foot {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 26px 24px;
  }

  .m-foot {
    display: flex;
    gap: 8px;
    margin-top: 18px;
  }

  .cancel {
    height: 46px;
    padding: 0 20px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 700;
  }

  .cancel:hover {
    background: var(--hov);
  }

  .m-foot .cancel {
    flex: 1;
    height: 52px;
    padding: 0;
    background: var(--surface2);
  }

  .save {
    height: 46px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 22px 0 18px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 800;
    white-space: nowrap;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms);
  }

  .save :global(svg) {
    font-size: 18px;
  }

  .save:hover {
    transform: translateY(-2px);
  }

  .save[aria-busy='true'] {
    cursor: progress;
  }

  .m-foot .save {
    flex: 1.4;
    height: 52px;
    justify-content: center;
    padding: 0;
    box-shadow: none;
  }

  .m-foot .save:hover {
    transform: none;
  }

  /* 429 on registration (`aLocked`) */
  .locked {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 14px 10px 10px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
    color: var(--danger);
    font-size: 13.5px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .locked strong {
    font-weight: 800;
  }

  .locked-icon {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 10px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 16px;
  }

  .reg.off {
    opacity: 0.55;
  }
</style>
