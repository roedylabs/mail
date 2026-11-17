<!--
  Email account › Connection: the "Sign in again" box (`raShow`) with the hint
  `raIntro`, form `ra` or the hint `raBlocked`; below it the facts box with the
  row "Mail server" (`raServer`, warning icon with `raServerWarn`) and
  `maC.facts`, the button row with "Sign in again" (`raIdle`) and "Check
  connection" (`maC.check`) and the section "Remove account" (`maC.remove`;
  the state API handles confirmation and undo). The email account's layout
  shows the head (address, title, description), the app's layout leads an
  unknown account to the list. Flow and values in
  `#lib/mail-connection.svelte.ts`, the sign-in itself in
  `#lib/auth/mail-login.svelte.ts`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { MailConnectionPage, mailConnectionValues } from '#lib/mail-connection.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { id }: { id: string } = $props();

  // The route creates the page anew per account (`{#key}`).
  // svelte-ignore state_referenced_locally
  const p = new MailConnectionPage(id, {
    servers: () => void goto(resolve('/admin/mail-servers')),
  });
  p.start();
  const v = $derived(mailConnectionValues(p));
  const isMobile = $derived(ui.isMobile);
  type FieldEvent = Event & { currentTarget: HTMLInputElement };

  $effect(() => p.watchLock(p.flow.lockUntil));
  $effect(() => p.arm(p.own));
  $effect(() => p.report(p.own));

  onMount(() => () => p.dispose());
</script>

<div class="page" class:mobile={isMobile}>
  {#if v}
    {@const ra = v.ra}
    {@const maC = v.maC}
    {#if v.raShow}
      <div class="box">
        {#if v.raNeeds}
          <div class="needs"><Icon name="ti-alert-triangle" /><span class="needs-text">{v.raIntro}</span></div>
        {/if}
        {#if v.raFree}<div class="f-title">{m.mail_connection_reauth()}</div>{/if}

        {#if v.raForm}
          {#if ra.isCred}
            {#if ra.isPw}
              <div class="pw-hint"><Icon name="ti-info-circle" /><span>{ra.pwHint}</span></div>
            {/if}
            {#if ra.isTok}
              <!-- Desktop with the label above the field, mobile as a placeholder. -->
              {#snippet secField()}
                <span class="sec-wrap">
                  <input
                    class="inp"
                    type={ra.secType}
                    value={ra.sec}
                    placeholder={isMobile ? m.mail_accounts_token() : undefined}
                    aria-label={isMobile ? m.mail_accounts_token() : undefined}
                    oninput={(e: FieldEvent) => ra.onSec(e.currentTarget.value)}
                    onkeydown={ra.key}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                  />
                  <button
                    type="button"
                    class="eye"
                    onclick={ra.onEye}
                    aria-label={ra.eyeTip}
                    use:tooltip={isMobile ? undefined : ra.eyeTip}><Icon name={ra.eyeIcon} /></button
                  >
                </span>
              {/snippet}
              {#if isMobile}
                {@render secField()}
              {:else}
                <label class="field"><span class="f-label">{m.mail_accounts_token()}</span>{@render secField()}</label>
              {/if}
            {/if}
          {/if}

          {#if ra.isRet}
            <div role="status" class="ret">
              <span class="ret-tile"><span class="spin"><Icon name="ti-loader-2" /></span></span>
              <div class="st-body">
                <div class="ret-title">{ra.retTitle}</div>
                <div class="st-desc">{ra.retText}</div>
              </div>
            </div>
          {/if}

          {#if ra.isDone}
            <div role="status" class="done">
              <span class="done-tile"><Icon name="ti-circle-check" /></span>
              <div class="st-body">
                <div class="done-title">{ra.doneTitle}</div>
                <div class="st-desc">{ra.doneText}</div>
              </div>
            </div>
          {/if}

          {#if ra.busy}
            <div role="status" class="busy-row">
              <span class="busy-tile"><span class="spin"><Icon name="ti-loader-2" /></span></span>{ra.busyText}
            </div>
          {/if}

          {#if ra.hasErr}
            <div role="alert" class="err">
              <span class="err-tile"><Icon name={ra.eIcon} /></span>
              <div class="err-body">
                <div class="err-title">{ra.eTitle}</div>
                <div class="err-text">{ra.eText}</div>
                {#if ra.eHasCode}<div class="err-code">{m.mail_accounts_server_code({ code: ra.eCode })}</div>{/if}
                {#if ra.eHasAct}
                  <button type="button" class="err-act" onclick={ra.eFn}><Icon name="ti-arrow-right" />{ra.eAct}</button
                  >
                {/if}
              </div>
            </div>
          {/if}

          {#if ra.isCred}
            {#snippet submit()}
              <button
                type="button"
                class="submit"
                class:hot={ra.hot}
                class:ready={ra.ready}
                class:locked={ra.locked}
                class:busy={ra.busy}
                aria-disabled={ra.btnDis}
                onclick={ra.submit}
                ><span class="btn-icon" class:spin={ra.btnSpin}><Icon name={ra.btnIcon} /></span>{ra.btnLabel}</button
              >
            {/snippet}
            <div class="acts">
              {#if isMobile}
                {@render submit()}
                {#if v.raFree}
                  <button type="button" class="cancel" onclick={ra.cancel}>{m.mail_accounts_cancel()}</button>
                {/if}
              {:else}
                <span class="grow"></span>
                {#if v.raFree}
                  <button type="button" class="cancel" onclick={ra.cancel}>{m.mail_accounts_cancel()}</button>
                {/if}
                {@render submit()}
              {/if}
            </div>
          {/if}
        {/if}

        {#if v.raBlocked}
          <div class="blocked"><Icon name="ti-server-off" /><span class="blocked-text">{v.raBlockText}</span></div>
          {#if v.raBlockAdm}
            <button type="button" class="block-go" onclick={v.raBlockGo}
              ><Icon name="ti-arrow-right" />{m.mail_login_check_servers()}</button
            >
          {/if}
        {/if}
      </div>
    {/if}

    <div class="facts">
      <div class="fact">
        <span class="fact-k">{m.mail_connection_server()}</span>
        <span class="fact-v server"
          >{#if v.raServerWarn}<span class="warn" use:tooltip={m.mail_connection_server_warn()}
              ><Icon name="ti-alert-triangle" label={m.mail_connection_server_warn()} /></span
            >{/if}{v.raServer}</span
        >
      </div>
      {#each maC.facts as f (f.k)}
        <div class="fact">
          <span class="fact-k">{f.k}</span>
          <span class="fact-v">{f.v}</span>
        </div>
      {/each}
    </div>

    <div class="row">
      {#if v.raIdle}
        <button type="button" class="soft" onclick={v.raStart}
          ><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button
        >
      {/if}
      <!-- One check at a time: the button stays focusable, `mailCheck` calls nothing meanwhile. -->
      <button
        type="button"
        class="soft"
        class:busy={maC.busy}
        aria-busy={maC.busy}
        aria-disabled={maC.busy}
        onclick={maC.check}
        ><span class="rot" style:transform="rotate({maC.rot}deg)"><Icon name="ti-refresh" /></span
        >{maC.checkLabel}</button
      >
    </div>

    <section class="remove">
      <h2 class="h2">{m.mail_connection_remove_head()}</h2>
      <div class="remove-box">
        <div class="remove-lead">{m.mail_connection_remove_lead({ app: session.appName })}</div>
        <button type="button" class="remove-btn" onclick={maC.remove}
          ><Icon name="ti-mail-off" />{m.mail_connection_remove()}</button
        >
      </div>
    </section>
  {/if}
</div>

<style>
  /* Box "Sign in again" (`raShow`) */
  .box {
    margin-top: 28px;
    padding: 18px 18px 16px 20px;
    border-radius: 26px;
    background: var(--surface2);
    animation: snFade 200ms ease-out;
  }

  .mobile .box {
    margin-top: 22px;
    padding: 16px 12px 12px;
    border-radius: 24px;
    animation: none;
  }

  .needs {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 14px;
  }

  .needs :global(svg) {
    font-size: 20px;
    color: var(--danger);
  }

  .mobile .needs {
    margin: 0 2px 14px;
  }

  .mobile .needs :global(svg) {
    font-size: 19px;
  }

  .needs-text {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .mobile .needs-text {
    font-size: 14px;
    text-wrap: wrap;
  }

  .f-title {
    margin-bottom: 14px;
    font-size: 15.5px;
    font-weight: 800;
  }

  .mobile .f-title {
    margin: 0 4px 12px;
    font-size: 15px;
  }

  .pw-hint {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .pw-hint :global(svg) {
    font-size: 16px;
    margin-top: 2px;
  }

  .pw-hint span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .mobile .pw-hint {
    padding: 0 2px;
    font-size: 13.5px;
  }

  /* Access token with eye */
  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-width: 420px;
  }

  .f-label {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .sec-wrap {
    position: relative;
    display: block;
  }

  .inp {
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
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .inp:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile .inp {
    height: 48px;
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
  }

  .eye:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .eye {
    top: 2px;
    right: 2px;
    width: 44px;
    height: 44px;
    font-size: 19px;
  }

  .mobile .eye:hover {
    background: none;
    color: var(--mfg);
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
    box-shadow: var(--sh1);
  }

  .ret-tile {
    background: var(--surface);
    color: var(--deep);
    font-size: 22px;
  }

  .done-tile {
    background: var(--acc);
    color: var(--accink);
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

  /* Spinner via `--spin` (off with animations=false) */
  .spin {
    display: grid;
    animation: var(--spin, none);
  }

  /* Status line `ra.busyText`; not `.busy`, the buttons carry that while loading. */
  .busy-row {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 10px;
    border-radius: 16px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .busy-tile {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 10px;
    background: var(--surface2);
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
    background: color-mix(in oklab, var(--danger) 10%, var(--surface));
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
  }

  .cancel:hover {
    background: var(--hov);
  }

  .mobile .cancel {
    width: 100%;
    font-size: 15px;
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
    transition: none;
  }

  .mobile .btn-icon {
    font-size: 18px;
  }

  /* Server no longer allowed (`raBlocked`) */
  .blocked {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .blocked :global(svg) {
    font-size: 19px;
    margin-top: 1px;
    color: var(--mfg);
  }

  .blocked-text {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .mobile .blocked-text {
    font-size: 14px;
  }

  .block-go {
    margin: 12px 0 0 29px;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 16px 0 12px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
  }

  .block-go :global(svg) {
    font-size: 16px;
  }

  .mobile .block-go {
    margin: 12px 0 0;
    height: 44px;
  }

  /* Facts box: row "Mail server" and `maC.facts` */
  .facts {
    margin-top: 28px;
    padding: 6px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .fact {
    min-height: 58px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 24px;
    padding: 12px 18px;
  }

  .fact + .fact {
    margin-top: -1px;
    border-top: 1px solid var(--bd);
  }

  .fact-k {
    flex-shrink: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .fact-v {
    min-width: 0;
    font-size: 14.5px;
    font-weight: 600;
    color: var(--mfg);
    text-align: right;
    overflow-wrap: anywhere;
  }

  .server {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* `raServerWarn` */
  .warn {
    display: grid;
    font-size: 16px;
    color: var(--danger);
  }

  /* Button row: "Sign in again" (`raIdle`) and "Check connection" */
  .row {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .soft {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .soft :global(svg) {
    font-size: 17px;
  }

  .soft:hover {
    background: var(--sunken);
  }

  /* `maC.checkCur` */
  .soft.busy {
    cursor: progress;
  }

  /* `maC.rot`: two turns per check */
  .rot {
    display: grid;
    place-items: center;
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  /* Section "Remove account" */
  .remove {
    margin-top: 44px;
  }

  .h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .remove-box {
    margin-top: 14px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px 20px;
    padding: 18px 18px 18px 22px;
    border-radius: 26px;
    background: color-mix(in oklab, var(--danger) 8%, var(--surface));
  }

  .remove-lead {
    flex: 1 1 240px;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .remove-btn {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--danger);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .remove-btn :global(svg) {
    font-size: 17px;
  }

  .remove-btn:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
  }
</style>
