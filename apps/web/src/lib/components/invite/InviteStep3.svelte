<!--
  Step 3 of the invitation: QR code and key for the authenticator app, the
  six-digit code; "Confirm" creates the account (`POST invites/:token/accept`).
  Its previous content inside the shell's frame (`LegacyFrame`).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import CodeBoxes from '#lib/components/CodeBoxes.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { inviteFrame, type LegacyValues } from '#lib/components/invite/frame.ts';
  import LegacyFrame from '#lib/components/invite/LegacyFrame.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import type { IconName } from '#lib/icons.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  let active = $state(false);

  // "Copied" for two seconds, only if it worked.
  const copied = new Copied<'key'>();
  onDestroy(() => copied.stop());

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void flow.submitOtp();
  }

  const contentKey = $derived([flow.otpErr, flow.codeLocked, flow.maint !== null, copied.key === null].join('|'));
</script>

{#snippet alert(icon: IconName, title: string, text: string)}
  <div class="alert" role="alert" id="in-code-alert">
    <span class="alert-icon"><Icon name={icon} /></span>
    <div class="alert-text"><strong>{title}</strong> {text}</div>
  </div>
{/snippet}

<LegacyFrame
  docTitle={m.invite_doc_title({ step: m.invite_step_mfa() })}
  bars={inviteFrame(flow, 3).bars}
  {targets}
  {hidden}
  {contentKey}
>
  {#snippet children(F: LegacyValues)}
    <div class="steps" style:margin="0 0 12px">
      <div class="steps-start">
        <button type="button" class="back" disabled={flow.busy} onclick={() => flow.back()}>
          <Icon name="ti-arrow-left" /><span>{m.invite_back()}</span>
        </button>
      </div>
    </div>
    <form class="step" onsubmit={submit} novalidate>
      <h1>{m.invite_mfa_title()}</h1>
      <p class="intro">{m.invite_mfa_intro()}</p>
      <div class="mfa gap-m">
        <span class="qr" style:width={F.qr} style:height={F.qr}>
          {#if flow.qr}
            <svg
              viewBox="0 0 {flow.qr.size} {flow.qr.size}"
              shape-rendering="crispEdges"
              aria-label={m.invite_qr_label()}
              role="img"
            >
              <path d={flow.qr.d} />
            </svg>
          {/if}
        </span>
        <div class="key">
          <span class="key-label">{m.invite_key_manual()}</span>
          <span class="key-value">{flow.secretLabel}</span>
          <button type="button" class="copy key-copy" onclick={() => void copied.copy(flow.secret, 'key')}>
            <Icon name={copied.key === 'key' ? 'ti-check' : 'ti-copy'} />
            <span>{copied.key === 'key' ? m.invite_copied() : m.invite_key_copy()}</span>
          </button>
        </div>
      </div>

      {#if flow.maint}
        <div class="maint" role="status">
          <span class="maint-icon"><Icon name="ti-tool" /></span>
          <span class="maint-text">{flow.maint.message ?? m.login_maint_default()}</span>
        </div>
      {/if}

      <div class="code gap-m">
        <label for="in-otp">{m.invite_otp_label()}</label>
        <CodeBoxes
          id="in-otp"
          kind="otp"
          bind:input={() => targets.input('otp'), (el: HTMLInputElement | undefined) => targets.put('otp', el)}
          value={flow.otp}
          oninput={(v: string) => flow.editOtp(v)}
          active={active && !flow.otpLoading}
          bad={!!flow.otpErr}
          locked={flow.codeLocked}
          fadeLocked={false}
          describedby={flow.otpShort ? 'in-otp-err' : flow.otpBad || flow.codeLocked ? 'in-code-alert' : undefined}
          gap={F.otpGap}
          height={F.otpBoxH}
          onfocus={() => (active = true)}
          onblur={() => (active = false)}
        />
        {#if flow.otpShort}
          <div class="field-err" id="in-otp-err">
            <span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{m.invite_otp_short()}</span>
          </div>
        {/if}
        <!-- Wrong code and lock: under the code boxes, like the setup token's messages; the maintenance notice stays above -->
        {#if flow.otpBad}
          <div class="alert-under">
            {@render alert('ti-shield-x', m.invite_code_bad_title(), m.invite_code_bad_text())}
          </div>
        {/if}
        {#if flow.codeLocked}
          <div class="alert-under">{@render alert('ti-lock', m.login_code_locked_title(), flow.codeLockText)}</div>
        {/if}
      </div>

      <button
        type="submit"
        class="primary"
        disabled={flow.otpDis}
        aria-busy={flow.otpLoading ? 'true' : 'false'}
        style:opacity={flow.codeLocked ? 0.55 : 1}
      >
        {#if flow.otpLoading}
          <span class="spin"><Icon name="ti-loader-2" /></span><span>{m.invite_checking()}</span>
        {:else if flow.otpReady || !flow.codeLockBtn}
          <span>{m.invite_confirm()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
        {:else}
          <span class="bi"><Icon name="ti-lock" /></span><span class="clock">{flow.codeLockBtn}</span>
        {/if}
      </button>
    </form>
  {/snippet}
</LegacyFrame>
