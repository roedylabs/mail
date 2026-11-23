<!--
  The invitation has expired (`GET invites/:token` says so, or `totp` or
  `accept` answered `422 invite_expired`): one centred column at every width
  without step bars, the light/dark button in the brand row. A muted clock
  tile on neutral rings (not the person's mistake), for which address and
  until when, who to ask; "Request a new invitation" (`POST …/request`;
  mobile: in the bottom bar) and "Already registered? Sign in". After a 429
  the lock message sits above the button, which stays greyed out until the
  lock runs out. The heading gets the focus on entering.
-->
<script lang="ts">
  import { resolve } from '$app/paths';
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { Look } from '#lib/auth-layout.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();
</script>

{#snippet text()}
  {m.invite_expired_before()}<strong>{flow.inviteEmail}</strong>{m.invite_expired_after({
    until: flow.untilLabel,
    from: flow.inviteFrom,
  })}
{/snippet}

<!-- 429: the time left as a bar running empty and m:ss, hidden from screen readers (the text names the wait) -->
{#snippet notice(look: Look)}
  {#if flow.linkLock}
    <div class="lock" style:margin-top={look.gapM}>
      <MessageBox
        id="iv-lock"
        role="alert"
        icon="ti-lock"
        title={m.login_requests_title()}
        text={flow.linkLockText}
        lock={flow.linkLock}
      />
    </div>
  {/if}
{/snippet}

{#snippet extra()}
  <p class="registered">
    {m.invite_registered()}
    <a class="login" href={resolve('/(auth)/login')}>{m.invite_login()}</a>
  </p>
{/snippet}

<AuthResult
  docTitle={m.invite_title({ app: session.appName })}
  title={m.invite_expired_title()}
  themeToggle
  {hidden}
  reg={targets.reg}
  contentKey={String(flow.linkLocked)}
  tone="muted"
  tileShadow="edge"
  icon="ti-clock-x"
  role={null}
  {text}
  {notice}
  primary={{
    label: m.invite_request(),
    icon: 'ti-send',
    iconLeft: true,
    busy: flow.reqLoading,
    busyLabel: m.invite_requesting(),
    disabled: flow.linkLocked,
    pad: { desk: '0 22px', mob: '0 22px' },
    onclick: () => void flow.request(),
  }}
  {extra}
  extraTop="14px"
  inside
/>

<style>
  .lock {
    width: 100%;
    text-align: left;
  }

  /* "Already registered? Sign in", as on step 1 */
  .registered {
    margin: 0;
    text-align: center;
    font-size: 14px;
    line-height: 1.45;
    color: var(--mfg);
  }

  .login {
    position: relative;
    font-weight: 800;
    color: var(--deep);
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--deep) 35%, transparent);
    text-underline-offset: 3px;
  }

  /* Touch target of at least 44 px around the short link */
  .login::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
  }
</style>
