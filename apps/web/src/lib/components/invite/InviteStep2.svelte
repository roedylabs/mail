<!--
  Step 2 of the invitation: name and password with the rule chips;
  "Continue" asks for the authenticator key (`POST invites/:token/totp`).
  Its previous content inside the shell's frame (`LegacyFrame`).
-->
<script lang="ts">
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { inviteFrame } from '#lib/components/invite/frame.ts';
  import LegacyFrame from '#lib/components/invite/LegacyFrame.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteField, InviteFlow } from '#lib/invite.svelte.ts';
  import { MAX_NAME } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  let focus = $state<InviteField | null>(null);
  let showPw = $state(false);
  let caps = $state(false);

  function onPwKey(event: KeyboardEvent) {
    caps = event.getModifierState('CapsLock');
  }
  function focusOn(field: InviteField) {
    return () => (focus = field);
  }
  function blur() {
    focus = null;
    caps = false;
  }
  /** A mouse click on "show" does not take the focus from the field (`keepFocus`). */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void flow.submitName();
  }

  const contentKey = $derived([flow.nmErr, flow.pwErr, flow.linkLocked].join('|'));
</script>

{#snippet alert(title: string, text: string)}
  <div class="alert" role="alert">
    <span class="alert-icon"><Icon name="ti-lock" /></span>
    <div class="alert-text"><strong>{title}</strong> {text}</div>
  </div>
{/snippet}

<LegacyFrame
  docTitle={m.invite_doc_title({ step: m.invite_setup_title() })}
  bars={inviteFrame(flow, 2).bars}
  {targets}
  {hidden}
  {contentKey}
>
  <div class="steps" style:margin="0 0 12px">
    <div class="steps-start">
      <button type="button" class="back" disabled={flow.busy} onclick={() => flow.back()}>
        <Icon name="ti-arrow-left" /><span>{m.invite_back()}</span>
      </button>
    </div>
  </div>
  <form class="step" onsubmit={submit} novalidate>
    <h1>{m.invite_setup_title()}</h1>
    <p class="intro">{m.invite_setup_intro()}</p>
    <div class="fields gap-l">
      <FormField
        id="in-name"
        bind:input={() => targets.input('name'), (el: HTMLInputElement | undefined) => targets.put('name', el)}
        label={m.invite_name_label()}
        icon="ti-user"
        type="text"
        name="name"
        autocomplete="name"
        maxlength={MAX_NAME}
        placeholder={m.invite_name_placeholder()}
        value={flow.name}
        oninput={(v: string) => flow.editName(v)}
        onfocus={focusOn('name')}
        onblur={blur}
        error={flow.nmErr}
      />
      <FormField
        id="in-pw"
        bind:input={() => targets.input('pw'), (el: HTMLInputElement | undefined) => targets.put('pw', el)}
        label={m.invite_pw_label()}
        icon="ti-lock"
        type={showPw ? 'text' : 'password'}
        name="new-password"
        autocomplete="new-password"
        placeholder={m.invite_pw_placeholder()}
        value={flow.pw}
        oninput={(v: string) => flow.editPw(v)}
        onkeydown={onPwKey}
        onkeyup={onPwKey}
        onfocus={focusOn('pw')}
        onblur={blur}
        error={flow.pwErr === 'rules' ? true : flow.pwText}
        describedby="in-pw-rules"
      >
        {#snippet trailing()}
          <button
            type="button"
            class="eye"
            onmousedown={keepFocus}
            onclick={() => (showPw = !showPw)}
            aria-label={showPw ? m.password_hide() : m.password_show()}
            title={showPw ? m.password_hide() : m.password_show()}
            aria-pressed={showPw ? 'true' : 'false'}
          >
            <Icon name={showPw ? 'ti-eye-off' : 'ti-eye'} />
          </button>
        {/snippet}
        {#if caps && focus === 'pw'}
          <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
        {/if}
        <ul id="in-pw-rules" class="rules" aria-label={m.password_rules()}>
          {#each flow.rules as rule (rule.id)}
            <li class="rule" class:ok={rule.ok} class:bad={rule.bad}>
              <span class="rule-dot"><Icon name="ti-check" /></span>
              <span>{rule.label}</span>
            </li>
          {/each}
        </ul>
      </FormField>
    </div>
    {#if flow.linkLocked}
      <div class="gap-m">{@render alert(m.login_requests_title(), flow.linkLockText)}</div>
    {/if}
    <button
      type="submit"
      class="primary"
      disabled={flow.loading || flow.linkLocked}
      aria-busy={flow.loading ? 'true' : 'false'}
      style:opacity={flow.linkLocked ? 0.55 : 1}
    >
      {#if flow.loading}
        <span class="spin"><Icon name="ti-loader-2" /></span><span>{m.invite_saving()}</span>
      {:else if !flow.linkLocked || !flow.s2LockBtn}
        <span>{m.invite_next()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
      {:else}
        <span class="bi"><Icon name="ti-lock" /></span><span class="clock">{flow.s2LockBtn}</span>
      {/if}
    </button>
  </form>
</LegacyFrame>
