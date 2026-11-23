<!--
  A new invitation was requested: one centred column at every width without
  step bars, the light/dark button in the brand row. The accent mail tile on
  soft rings (`role="status"`), who was notified and where the new
  invitation goes (the administrators hear of it at most once a day; the
  page does not say so), then the quiet "Go to sign-in" (mobile: in the
  bottom bar). The heading gets the focus on entering.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();
</script>

{#snippet text()}
  {m.invite_requested_before({ from: flow.inviteFromSubject })}<strong>{flow.inviteEmail}</strong
  >{m.invite_requested_after()}
{/snippet}

<AuthResult
  docTitle={m.invite_title({ app: session.appName })}
  title={m.invite_requested_title()}
  themeToggle
  {hidden}
  reg={targets.reg}
  icon="ti-mail-check"
  {text}
  inside
  quiet={{
    label: m.invite_to_login(),
    icon: 'ti-arrow-left',
    look: 'button',
    onclick: () => void goto(resolve('/(auth)/login')),
  }}
/>
