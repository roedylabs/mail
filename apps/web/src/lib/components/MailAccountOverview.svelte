<!--
  Email account › Overview: status with "Sign in again" or "Check
  connection", storage, color and default account. Presentational only;
  values from `overviewValues()` in `#lib/mail-account.svelte.ts`. The email
  account's layout shows the head (address, title, description), the
  component starts after it.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import { colorLabel } from '#lib/appearance.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { OverviewValues } from '#lib/mail-account.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let {
    kind,
    st,
    chip,
    chipInk,
    stSub,
    blocked,
    reauth,
    okAuth,
    asOf,
    busy,
    checkLabel,
    rot,
    check,
    goCon,
    storage,
    storageNote,
    colors,
    isDefault,
    notDefault,
    makeDefault,
    isMobile,
  }: OverviewValues & { isMobile: boolean } = $props();

  // One check at a time: the button stays focusable, but calls nothing.
  function onCheck() {
    if (!busy) check();
  }
</script>

<div class="status">
  <span class="chip" style:background={chip} style:color={chipInk}><Icon name="ti-mail" /></span>
  <div class="st-text">
    <div class="st" class:auth={kind === 'auth'} class:blocked={kind === 'blocked'} class:busy={kind === 'busy'}>
      <span class="dot"></span>{st}
    </div>
    <div class="last">{stSub}</div>
  </div>
  {#if blocked}
    <!-- Server blocked: to the connection page with `raBlocked` and "Remove account". -->
    <button type="button" class="to-con" onclick={goCon}
      >{m.mail_account_to_connection()}<Icon name="ti-arrow-right" /></button
    >
  {/if}
  {#if reauth}
    <button type="button" class="reauth" onclick={goCon}><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button>
  {/if}
  {#if okAuth}
    <button type="button" class="soft" class:busy aria-busy={busy} aria-disabled={busy} onclick={onCheck}
      ><span class="rot" style:transform="rotate({rot}deg)"><Icon name="ti-refresh" /></span>{checkLabel}</button
    >
  {/if}
</div>

<!-- Storage: with a limit numbers and bar, otherwise "No limit", "Checking …" or "Not checked yet". -->
{#if storage || storageNote}
  <section class="sec">
    <h2 class="h2">{m.mail_account_storage()}</h2>
    <div class="card store" aria-live="polite">
      {#if storage}
        <div class="store-head">
          <span class="used">{storage.usedT}</span><span class="free">{storage.freeT}</span>
        </div>
        <div
          class="bar"
          role="progressbar"
          aria-label={m.mail_account_storage()}
          aria-valuenow={storage.pctN}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div class="fill" class:full={storage.full} style:width={storage.quotaW}></div>
        </div>
        <div class="quota">{storage.quota} · {storage.pctT}</div>
      {:else if storageNote}
        <div class="note" aria-busy={storageNote.busy}>
          <div class="q-title" class:limit={storageNote.noLimit}>{storageNote.title}</div>
          {#if storageNote.busy}
            <div class="bar shim" role="progressbar" aria-label={m.mail_account_q_busy_label()}></div>
          {/if}
          <div class="q-text">{storageNote.text}</div>
        </div>
      {/if}
      {#if asOf}<div class="as-of">{asOf}</div>{/if}
    </div>
  </section>
{/if}

<section class="sec">
  <h2 class="h2">{m.mail_account_appearance()}</h2>
  <div class="card rows">
    <div class="row">
      <div class="row-text">
        <div class="row-title">{m.mail_account_color()}</div>
        <div class="row-desc">{m.mail_account_color_desc()}</div>
      </div>
      <div class="swatches" role="radiogroup" use:radiogroup aria-label={m.mail_account_color()}>
        {#each colors as c (c.name)}
          <button
            type="button"
            class="sw"
            class:on={c.on}
            role="radio"
            aria-checked={c.on}
            aria-label={colorLabel(c.name)}
            style:--sw-base={c.base}
            style:--sw-ink={c.ink}
            onclick={c.onClick}
            use:tooltip={isMobile ? undefined : colorLabel(c.name)}><Icon name="ti-check" /></button
          >
        {/each}
      </div>
    </div>
    <div class="sep"></div>
    <div class="row def">
      <div class="row-text">
        <div class="row-title">{m.mail_account_default_title()}</div>
        <div class="row-desc">{m.mail_accounts_default_tip()}</div>
      </div>
      {#if isDefault}
        <span class="badge"><Icon name="ti-star-filled" />{m.mail_accounts_default()}</span>
      {/if}
      {#if notDefault}
        <button type="button" class="soft" onclick={makeDefault}
          ><Icon name="ti-star" />{m.mail_accounts_make_default()}</button
        >
      {/if}
    </div>
  </div>
</section>

<style>
  /* Status: line, last check and tile in the account color */
  .status {
    margin-top: 28px;
    display: flex;
    align-items: center;
    gap: 16px 20px;
    flex-wrap: wrap;
    padding: 20px 22px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .chip {
    width: 56px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 19px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 26px;
  }

  .st-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .st {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15.5px;
    font-weight: 800;
    color: var(--fg);
  }

  .dot {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: #5fbf73;
  }

  .st.auth,
  .st.blocked {
    color: var(--danger);
  }

  .st.auth .dot,
  .st.blocked .dot {
    background: var(--danger);
  }

  .st.busy .dot {
    background: var(--acc);
  }

  .last {
    margin-top: 4px;
    font-size: 14px;
    color: var(--mfg);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  /* "Go to connection" with a blocked server */
  .to-con {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .to-con:hover {
    background: var(--sunken);
  }

  .to-con :global(svg) {
    width: 17px;
    height: 17px;
  }

  /* "As of the last check …" with a blocked server */
  .as-of {
    margin-top: 4px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  /* "Sign in again" (`goCon`) */
  .reauth {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    box-shadow: var(--sh1);
  }

  /* "Check connection" and "Set as default" */
  .soft {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .soft:hover {
    background: var(--sunken);
  }

  /* Progress cursor while checking */
  .soft.busy {
    cursor: progress;
  }

  .reauth :global(svg),
  .soft :global(svg) {
    font-size: 17px;
  }

  /* Refresh icon: two turns per check */
  .rot {
    display: grid;
    place-items: center;
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  /* Sections "Storage" and "Appearance" */
  .sec {
    margin-top: 36px;
  }

  .h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .card {
    margin-top: 14px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .store {
    padding: 20px 22px;
  }

  .store-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .used {
    font-family: var(--font-serif);
    font-size: 26px;
  }

  .free {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .bar {
    margin-top: 12px;
    height: 10px;
    border-radius: 9999px;
    background: var(--sunken);
    overflow: hidden;
  }

  /* Bar color: red from 90 % */
  .fill {
    height: 100%;
    border-radius: 9999px;
    background: var(--acc);
    transition: width 400ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .fill.full {
    background: var(--danger);
  }

  .quota {
    margin-top: 8px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  /* Without numbers: title, placeholder bar while checking, text */
  .note {
    animation: snFade 220ms ease-out;
  }

  .q-title {
    font-family: var(--font-serif);
    font-size: 26px;
    line-height: 1.25;
    color: var(--mfg);
  }

  .q-title.limit {
    color: var(--fg);
  }

  .bar.shim {
    animation: var(--shim, none);
  }

  .q-text {
    margin-top: 8px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .rows {
    padding: 6px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 14px 12px 14px 18px;
    flex-wrap: wrap;
  }

  .row.def {
    min-height: 72px;
  }

  .row-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .row-title {
    font-size: 15.5px;
    font-weight: 700;
  }

  .row-desc {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  /* Colors (ring and check mark on the selected one) */
  .swatches {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    padding: 5px;
  }

  .sw {
    width: 32px;
    height: 32px;
    border-radius: 9999px;
    background: var(--sw-base);
    box-shadow: none;
    display: grid;
    place-items: center;
    color: var(--sw-ink);
    font-size: 15px;
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sw:hover {
    transform: scale(1.1);
  }

  .sw.on {
    box-shadow:
      0 0 0 3px var(--surface),
      0 0 0 5px var(--sw-base);
  }

  .sw :global(svg) {
    opacity: 0;
  }

  .sw.on :global(svg) {
    opacity: 1;
  }

  /* "Default" */
  .badge {
    height: 32px;
    padding: 0 14px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13.5px;
    font-weight: 800;
  }

  .badge :global(svg) {
    font-size: 15px;
  }
</style>
