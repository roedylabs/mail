<!--
  Account › Profile: display name, username and email address of the app
  account. A new address requires the password and, with multi-factor, a code
  before the confirmation link is sent; until confirmed, "Confirmation
  pending" shows with "Resend link" and "Discard change". Flow and values in
  `#lib/profile.svelte.ts`. The number of linked mail accounts is shown as a
  subtitle.
-->
<script lang="ts">
  import { tooltip } from '#lib/actions/tooltip.ts';
  import { autofocus } from '#lib/actions/autofocus.ts';
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { MAX_NAME } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { ProfilePage, profileValues, type AcctRowValues } from '#lib/profile.svelte.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const p = new ProfilePage();
  const v = $derived(profileValues(p, accounts.count ?? 0));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/account/profile'));
  type FieldEvent = Event & { currentTarget: HTMLInputElement };
</script>

<!-- Identity check below the "Email" row (`acctRows[].auth`). -->
{#snippet auth()}
  <div role="group" aria-label={m.profile_ea_group()} class="auth">
    <div class="auth-intro">
      <span class="auth-icon"><Icon name="ti-shield-lock" /></span><span>{v.eaIntro}</span>
    </div>
    {#each v.eaFields as f (f.ac)}
      <div class="ea-field">
        {#if !isMobile}<div class="sep"></div>{/if}
        <div class="ea-row">
          <div class="row-text">
            <div class="row-label">{f.label}</div>
            <div class="row-desc">{f.desc}</div>
          </div>
          <div class="ea-ctl">
            <input
              type={f.type}
              value={f.value}
              use:autofocus={f.focus}
              oninput={(e: FieldEvent) => f.onChange(e.currentTarget.value)}
              onkeydown={v.eaKey}
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
          </div>
        </div>
      </div>
    {/each}
    {#if isMobile}
      {#if v.hasEaMsg}<div role="alert" class="ea-msg">{v.eaMsg}</div>{/if}
      <button type="button" class="ea-go" class:ready={!v.eaDis} aria-disabled={v.eaDis || v.eaBusy} onclick={v.eaGo}
        >{m.profile_ea_send()}</button
      >
      <button type="button" class="ea-cancel" onclick={v.eaCancel}>{m.confirm_cancel()}</button>
    {:else}
      <div class="sep"></div>
      <div class="ea-foot">
        <span role="alert" class="ea-msg">{v.eaMsg}</span>
        <button type="button" class="ea-cancel" onclick={v.eaCancel}>{m.confirm_cancel()}</button>
        <button type="button" class="ea-go" class:ready={!v.eaDis} aria-disabled={v.eaDis || v.eaBusy} onclick={v.eaGo}
          >{m.profile_ea_send()}</button
        >
      </div>
    {/if}
  </div>
{/snippet}

<!-- "Confirmation pending" (confirmation pending, `acctRows[].pend`). -->
{#snippet pending(r: AcctRowValues)}
  <div role="status" class="pend">
    <div class="pend-head">
      <span class="pend-tile"><Icon name="ti-mail-forward" /></span>
      <div class="pend-text">
        <div class="pend-title">{m.profile_pending_title()}</div>
        <div class="pend-desc">
          {m.profile_pending_before()}<strong>{r.pendEmail}</strong>{m.profile_pending_after()}
        </div>
      </div>
    </div>
    {#if r.hasPendErr}
      <div role="alert" class="pend-err">
        <span class="pend-err-icon"><Icon name="ti-alert-circle" /></span><span>{r.pendErr}</span>
      </div>
    {/if}
    <div class="pend-acts">
      <button type="button" class="pend-resend" aria-disabled={r.busy} onclick={r.resend}
        ><Icon name="ti-send" /><span>{m.profile_resend()}</span></button
      >
      <button type="button" class="pend-discard" aria-disabled={r.busy} onclick={r.discard}
        ><Icon name="ti-arrow-back-up" /><span>{m.profile_discard()}</span></button
      >
    </div>
  </div>
{/snippet}

{#snippet editButton(label: string, onclick: () => void)}
  <button type="button" class="edit" aria-label={label} use:tooltip={isMobile ? undefined : m.profile_edit()} {onclick}
    ><Icon name="ti-pencil" /></button
  >
{/snippet}

{#snippet rowInput(r: AcctRowValues)}
  <input
    class="row-input"
    class:bad={r.hasErr}
    type={r.type}
    value={r.val}
    use:autofocus
    oninput={(e: FieldEvent) => r.onChange(e.currentTarget.value)}
    onblur={r.onBlur}
    onkeydown={r.onKey}
    aria-label={r.k}
    aria-invalid={r.hasErr}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
  />
{/snippet}

{#snippet nameInput()}
  <input
    class="row-input"
    type="text"
    value={v.acctNameVal}
    maxlength={MAX_NAME}
    use:autofocus
    oninput={(e: FieldEvent) => v.onNameDraft(e.currentTarget.value)}
    onblur={v.onNameBlur}
    onkeydown={v.onAcctNameKey}
    placeholder={m.profile_name_placeholder()}
    aria-label={m.profile_display_name()}
  />
{/snippet}

<div class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <section data-sec="profile" class="sec">
    <div class="hero">
      <span class="avatar" style:background={v.acct.chip} style:color={v.acct.ink}>{v.acct.initials}</span>
      <div class="hero-text">
        <div class="hero-name">{v.acct.name}</div>
        <div class="hero-sub">{v.acct.sub}</div>
      </div>
    </div>

    <div class="box">
      <div class="row name-row">
        <div class="row-main">
          <div class="row-text">
            <div class="row-label">{m.profile_display_name()}</div>
            <div class="row-desc">{v.acct.nameDesc}</div>
          </div>
          {#if v.acctNameRead}
            <div class="row-val">
              <span class="val">{v.acct.name}</span>
              {@render editButton(m.profile_name_edit(), v.acctNameEdit)}
            </div>
          {/if}
          {#if v.acctNameEditing && !isMobile}{@render nameInput()}{/if}
        </div>
        {#if v.acctNameEditing && isMobile}{@render nameInput()}{/if}
      </div>

      {#each v.acctRows as r (r.k)}
        <div>
          <div class="sep"></div>
          <div class="row">
            <div class="row-main">
              <span class="row-k">{r.k}</span>
              {#if r.noEdit}
                <span class="val static">{r.v}</span>
              {:else if r.read}
                <div class="row-val">
                  <span class="val">{r.v}</span>
                  {@render editButton(r.editLabel, r.edit)}
                </div>
              {:else if r.editing && !isMobile}
                {@render rowInput(r)}
              {/if}
            </div>
            {#if r.editing && isMobile}{@render rowInput(r)}{/if}
            {#if r.hasErr}
              <div role="alert" class="row-err"><Icon name="ti-alert-circle" />{r.err}</div>
            {/if}
            {#if isMobile && r.auth}{@render auth()}{/if}
            {#if isMobile && r.pend}{@render pending(r)}{/if}
          </div>
          {#if !isMobile && r.auth}{@render auth()}{/if}
          {#if !isMobile && r.pend}{@render pending(r)}{/if}
        </div>
      {/each}
    </div>
  </section>

  {#if v.nameDirty}
    <DirtyBar onDiscard={v.acctDiscard} onSave={v.acctSave} {isMobile} />
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

  .sec {
    margin-top: 28px;
  }

  .mobile .sec {
    margin-top: 20px;
  }

  /* Header with initials */
  .hero {
    display: flex;
    align-items: center;
    gap: 18px 22px;
    flex-wrap: wrap;
    padding: 24px 26px;
    border-radius: 26px;
    background: var(--accsoft);
  }

  .mobile .hero {
    flex-direction: column;
    gap: 0;
    text-align: center;
    padding: 26px 18px 22px;
    border-radius: 24px;
  }

  .avatar {
    width: 80px;
    height: 80px;
    flex-shrink: 0;
    border-radius: 26px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 30px;
    box-shadow: var(--sh2);
    transform: rotate(-6deg);
  }

  .mobile .avatar {
    width: 72px;
    height: 72px;
    border-radius: 24px;
    font-size: 28px;
  }

  .hero-text {
    flex: 1 1 220px;
    min-width: 0;
  }

  .mobile .hero-text {
    flex: none;
    max-width: 100%;
    margin-top: 16px;
  }

  .hero-name {
    font-family: var(--font-serif);
    font-size: 28px;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .mobile .hero-name {
    font-size: 24px;
    line-height: 1.2;
  }

  .hero-sub {
    margin-top: 5px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--deep);
    overflow-wrap: anywhere;
  }

  .mobile .hero-sub {
    margin-top: 4px;
    font-size: 14px;
  }

  /* Rows */
  .box {
    margin-top: 12px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 10px;
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

  .row-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    flex-wrap: wrap;
    padding: 12px 10px 12px 18px;
    min-height: 60px;
  }

  .name-row .row-main {
    min-height: 72px;
  }

  .mobile .row {
    padding: 8px 6px 8px 14px;
  }

  .mobile .row-main {
    flex-wrap: nowrap;
    gap: 12px;
    padding: 0;
    min-height: 44px;
  }

  .row-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .mobile .row-text {
    flex: 1;
  }

  .row-label,
  .row-k {
    font-size: 15.5px;
    font-weight: 700;
  }

  .row-k {
    flex-shrink: 0;
  }

  .mobile .row-label,
  .mobile .row-k {
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

  .row-val {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .mobile .row-val {
    gap: 4px;
  }

  /* Mobile: name and pencil sit directly in the row (gap 12px); only the name is capped at 55 %. */
  .mobile .name-row .row-val {
    display: contents;
  }

  .mobile .name-row .val {
    max-width: 55%;
  }

  /* A long name never pushes the label narrower than its longest word; the name wraps instead. */
  .mobile .name-row .row-text {
    min-width: min-content;
  }

  .val {
    min-width: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--mfg);
    text-align: right;
    overflow-wrap: anywhere;
  }

  .val.static {
    padding-right: 8px;
  }

  .mobile .val {
    font-size: 14.5px;
  }

  .edit {
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

  .edit:hover,
  .edit:active {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .edit {
    width: 44px;
    height: 44px;
    font-size: 19px;
  }

  .mobile .edit:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .edit:active {
    background: var(--hov);
  }

  input {
    border: 0;
    outline: none;
    font: inherit;
    color: var(--fg);
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: box-shadow var(--dur, 220ms);
  }

  input:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  /* Mobile fields, the eye, "Cancel" and the pending actions change without a transition. */
  .mobile input,
  .mobile .eye,
  .mobile .ea-cancel,
  .mobile .pend-acts button {
    transition: none;
  }

  .row-input {
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    text-align: right;
    font-size: 14px;
    font-weight: 600;
  }

  .row-input.bad {
    box-shadow: 0 0 0 2px var(--danger);
  }

  .mobile .row-input {
    display: block;
    width: calc(100% - 8px);
    height: 46px;
    margin: 8px 0 6px;
    padding: 0 16px;
    font-size: 16px;
  }

  .row-err {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 18px 14px;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
  }

  .row-err :global(svg) {
    flex-shrink: 0;
    width: 17px;
    height: 17px;
  }

  .mobile .row-err {
    align-items: flex-start;
    justify-content: flex-start;
    margin: 4px 8px 6px 0;
    padding: 0;
    font-size: 13.5px;
    line-height: 1.4;
  }

  /* Identity check */
  .auth-intro {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 0 18px 14px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .auth-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    color: var(--deep);
  }

  .mobile .auth {
    margin: 4px 8px 6px 0;
  }

  .mobile .auth-intro {
    gap: 8px;
    padding: 0;
    font-size: 13.5px;
  }

  .mobile .auth-icon {
    font-size: 17px;
  }

  .ea-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    flex-wrap: wrap;
    padding: 16px 10px 16px 18px;
  }

  .mobile .ea-field {
    margin-top: 16px;
  }

  .mobile .ea-row {
    display: block;
    padding: 0;
  }

  .ea-ctl {
    position: relative;
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
  }

  .mobile .ea-ctl {
    margin-top: 10px;
  }

  .ea-ctl input {
    display: block;
    width: 100%;
    height: 44px;
    padding: 0 50px 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 600;
  }

  .mobile .ea-ctl input {
    height: 46px;
    padding: 0 52px 0 16px;
    font-size: 16px;
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

  .ea-foot {
    display: flex;
    align-items: center;
    gap: 12px 8px;
    flex-wrap: wrap;
    padding: 14px 10px 14px 18px;
  }

  .ea-msg {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--danger);
  }

  .mobile .ea-msg {
    margin-top: 12px;
    padding: 0 4px;
  }

  .ea-cancel {
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .ea-cancel:hover,
  .ea-cancel:active {
    background: var(--hov);
    color: var(--fg);
  }

  .ea-go {
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

  .ea-go.ready {
    background: var(--acc);
    color: var(--accink);
    cursor: pointer;
  }

  .mobile .ea-go {
    display: block;
    margin-top: 16px;
    width: 100%;
    height: 48px;
    font-size: 15px;
  }

  .mobile .ea-cancel {
    display: block;
    margin-top: 4px;
    width: 100%;
    font-size: 15px;
  }

  .mobile .ea-cancel:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .ea-cancel:active {
    background: var(--hov);
  }

  /* Confirmation pending */
  .pend {
    margin: 0 10px 12px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 16px 10px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .mobile .pend {
    margin: 6px 8px 6px 0;
    gap: 8px;
    padding: 14px 12px 6px 14px;
    border-radius: 18px;
  }

  .pend-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .mobile .pend-head {
    gap: 10px;
  }

  .pend-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .mobile .pend-tile {
    width: 32px;
    height: 32px;
    border-radius: 11px;
    font-size: 17px;
  }

  .pend-text {
    flex: 1;
    min-width: 0;
    padding-top: 1px;
  }

  .mobile .pend-text {
    padding-top: 0;
  }

  .pend-title {
    font-size: 14.5px;
    font-weight: 800;
  }

  .pend-desc {
    margin-top: 3px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .pend-desc {
    font-size: 13.5px;
  }

  .pend-desc strong {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .pend-err {
    margin-left: 48px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.45;
    color: var(--danger);
    text-wrap: pretty;
  }

  .mobile .pend-err {
    margin-left: 42px;
    font-size: 13.5px;
  }

  .pend-err-icon {
    display: grid;
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 17px;
  }

  .pend-acts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: 40px;
  }

  .mobile .pend-acts {
    gap: 2px;
    margin-left: -6px;
  }

  .pend-acts button {
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 8px;
    border-radius: 9999px;
    font-size: 14px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .pend-acts :global(svg) {
    width: 17px;
    height: 17px;
  }

  .mobile .pend-acts button {
    height: 44px;
  }

  .mobile .pend-acts :global(svg) {
    width: 18px;
    height: 18px;
  }

  .pend-resend {
    font-weight: 800;
    color: var(--deep);
  }

  .pend-discard {
    font-weight: 700;
    color: var(--mfg);
  }

  .pend-acts button:hover,
  .pend-acts button:active {
    background: var(--hov);
  }

  .pend-discard:hover {
    color: var(--fg);
  }

  .mobile .pend-acts button:hover {
    background: none;
  }

  .mobile .pend-acts button:active {
    background: var(--hov);
  }
</style>
