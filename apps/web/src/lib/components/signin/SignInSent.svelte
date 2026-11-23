<!--
  Check your inbox: after "Send link", still on `/password/forgot`. One
  centred column at every width: the mail tile on its rings, the address in
  bold (it may break anywhere), what the link allows as chips (hidden at the
  denser levels), "Back to sign-in" (signed in: "Back to ‹app name›", to the
  start page) and under it "Resend". The page never says a mail went out:
  the answer is the same whether or not an account exists. "Resend" counts
  down 30 s after each send; after a 429 it counts down to `retry_after` with
  a red line under it. The focus goes to the heading on entering.
-->
<script lang="ts">
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import type { LoginFlow, LoginPageValues } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let {
    flow,
    values,
    targets,
    hidden = false,
  }: { flow: LoginFlow; values: LoginPageValues; targets: SignInTargets; hidden?: boolean } = $props();

  const back = () => flow.fgBack(values.fgAuthed);
</script>

{#snippet text()}
  {m.login_sent_before()}<strong>{flow.sentTo}</strong>{m.login_sent_after()}
{/snippet}

{#snippet extra()}
  <div class="resend">
    <span>{m.login_no_mail()}</span>
    <button
      type="button"
      class="rs"
      disabled={flow.resendBlocked}
      aria-busy={flow.resending ? 'true' : 'false'}
      onclick={() => void flow.resend()}
    >
      {#if flow.resending}<span class="spin" aria-hidden="true"><Icon name="ti-loader-2" /></span>{/if}
      <span>{flow.resendLabel}</span>
    </button>
  </div>
  {#if flow.resendLimited}
    <div class="limit" role="alert">
      <span class="limit-icon" aria-hidden="true"><Icon name="ti-lock" /></span>
      <span class="limit-text"><strong>{m.login_requests_title()}</strong> {flow.resendLimitText}</span>
    </div>
  {/if}
{/snippet}

<AuthResult
  docTitle={m.login_doc_title({ screen: m.login_sent_title(), app: session.appName })}
  title={m.login_sent_title()}
  themeToggle
  {hidden}
  reg={targets.reg}
  contentKey={[values.fgAuthed ? 'a' : '', flow.resendLimited ? 'l' : ''].join('|')}
  icon="ti-mail-check"
  {text}
  chips={{
    label: m.login_link_about(),
    items: [
      { icon: 'ti-clock', text: m.login_link_valid() },
      { icon: 'ti-circle-check', text: m.login_link_once() },
    ],
  }}
  primary={{ label: values.fgBackLabel, icon: 'ti-arrow-left', iconLeft: true, onclick: back }}
  swipeBack={back}
  actionsTop="gap"
  {extra}
/>

<style>
  .resend {
    max-width: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0 4px;
    font-size: 14px;
    color: var(--mfg);
  }

  /* A quiet text button; counting down or running it is disabled and in the muted ink */
  .rs {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 800;
    color: var(--deep);
    font-variant-numeric: tabular-nums;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .rs:disabled {
    color: var(--mfg);
  }

  :global([data-input='mouse']) .rs:hover,
  .rs:active {
    background: var(--hov);
  }

  .spin {
    display: grid;
    font-size: 16px;
    animation: rsSpin 800ms linear infinite;
  }

  /* After a 429: a small red line under "Resend" while its countdown runs */
  .limit {
    max-width: 100%;
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px 6px 6px;
    border-radius: 9999px;
    background: var(--errsoft);
    color: var(--errfg);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    animation: rsPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .limit-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--errfg);
    color: var(--errsoft);
    font-size: 14px;
    transform: rotate(-6deg);
  }

  .limit-text {
    min-width: 0;
    text-align: left;
    text-wrap: pretty;
  }

  .limit-text strong {
    font-weight: 800;
  }

  @keyframes rsSpin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes rsPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
