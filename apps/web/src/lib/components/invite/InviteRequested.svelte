<!--
  A new invitation was requested: who was notified and "Go to sign-in". Its
  previous content inside the shell's frame (`LegacyFrame`), without step
  bars.
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

<LegacyFrame docTitle={m.invite_title({ app: session.appName })} {targets} {hidden}>
  <div class="tile-view" role="status">
    <span class="big-tile"><Icon name="ti-mail-check" /></span>
    <h1 class="tile-title">{m.invite_requested_title()}</h1>
    <p class="tile-text">
      {m.invite_requested_before({ from: flow.inviteFromSubject })}<strong class="addr">{flow.inviteEmail}</strong
      >{m.invite_requested_after()}
    </p>
    <button type="button" class="quiet" onclick={() => void goto(resolve('/(auth)/login'))}>
      <Icon name="ti-arrow-left" /><span>{m.invite_to_login()}</span>
    </button>
  </div>
</LegacyFrame>
