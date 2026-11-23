<!--
  The invitation has expired: for which address, until when, and "Request a
  new invitation" (`POST invites/:token/request`). Its previous content
  inside the shell's frame (`LegacyFrame`), without step bars.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import Icon from '#lib/components/Icon.svelte';
  import LegacyFrame from '#lib/components/invite/LegacyFrame.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();
</script>

<LegacyFrame
  docTitle={m.invite_title({ app: session.appName })}
  {targets}
  {hidden}
  contentKey={String(flow.linkLocked)}
>
  <div class="tile-view">
    <span class="big-tile muted"><Icon name="ti-clock-x" /></span>
    <h1 class="tile-title">{m.invite_expired_title()}</h1>
    <p class="tile-text">
      {m.invite_expired_before()}<strong class="addr">{flow.inviteEmail}</strong>{m.invite_expired_after({
        until: flow.untilLabel,
        from: flow.inviteFrom,
      })}
    </p>
    {#if flow.linkLocked}
      <div class="alert gap-m" role="alert">
        <span class="alert-icon"><Icon name="ti-lock" /></span>
        <div class="alert-text"><strong>{m.login_requests_title()}</strong> {flow.linkLockText}</div>
      </div>
    {/if}
    <button
      type="button"
      class="primary wide"
      disabled={flow.reqLoading || flow.linkLocked}
      aria-busy={flow.reqLoading ? 'true' : 'false'}
      style:opacity={flow.linkLocked ? 0.55 : 1}
      onclick={() => void flow.request()}
    >
      {#if flow.reqLoading}
        <span class="spin"><Icon name="ti-loader-2" /></span><span>{m.invite_requesting()}</span>
      {:else if !flow.linkLocked || !flow.reqLockBtn}
        <span>{m.invite_request()}</span><span class="bi"><Icon name="ti-send" /></span>
      {:else}
        <span class="bi"><Icon name="ti-lock" /></span><span class="clock">{flow.reqLockBtn}</span>
      {/if}
    </button>
    <div class="aside">
      <span>{m.invite_registered()}</span>
      <button type="button" class="link" onclick={() => void goto(resolve('/(auth)/login'))}>{m.invite_login()}</button>
    </div>
  </div>
</LegacyFrame>
