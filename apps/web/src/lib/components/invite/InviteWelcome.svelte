<!--
  "Welcome, ‹first name›" after "Activate account", with the bar until the
  start page opens. Its previous content inside the shell's frame
  (`LegacyFrame`), without step bars.
-->
<script lang="ts">
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
    <span class="big-tile"><Icon name="ti-check" /></span>
    <h1 class="tile-title wrap">{m.invite_welcome({ name: flow.firstName })}</h1>
    <p class="intro">{m.invite_redirect({ app: session.appName })}</p>
    <div class="progress"><span></span></div>
  </div>
</LegacyFrame>
