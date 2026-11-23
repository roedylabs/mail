<!--
  "Welcome, ‹first name›" after "Activate account", as the setup's done
  screen: one centred column at every width without step bars, the light/
  dark button in the brand row. A tilted check tile on two soft rings, the
  welcome, "Your account is set up.", what was set up as chips (hidden at
  the denser levels), then a bar that fills once and "Redirecting you to
  ‹app› …". Afterwards the page loads the signed-in account and opens the
  start page (`DONE_MS`). The heading gets the focus on entering. Mobile:
  no bottom bar, only 10 px under the panel.
-->
<script lang="ts">
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();
</script>

{#snippet text()}{m.invite_done_text()}{/snippet}

<AuthResult
  docTitle={m.invite_title({ app: session.appName })}
  title={m.invite_welcome({ name: flow.firstName })}
  themeToggle
  {hidden}
  reg={targets.reg}
  icon="ti-check"
  {text}
  chips={{
    label: m.setup_done_label(),
    items: [
      { icon: 'ti-user-check', text: m.invite_done_account() },
      { icon: 'ti-shield-lock', text: m.invite_done_mfa() },
      { icon: 'ti-lifebuoy', text: m.invite_done_codes() },
    ],
  }}
  progress={{ text: m.login_redirect({ app: session.appName }), ms: 2600 }}
  endGap={10}
/>
