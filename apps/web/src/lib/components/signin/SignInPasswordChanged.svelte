<!--
  Password changed: after "Save password", still on `/password/reset/‹token›`.
  One centred column at every width: the lock-check tile on its rings, the
  text, and when the reset ended sessions (`sessions_ended` > 0) the chip
  "You’ve been signed out on all devices" at every level. Nobody is signed in
  by the reset; the page already forgot a session of this browser
  (`LoginHooks.passwordReset`). "Go to sign-in" opens the sign-in with both
  fields empty. The focus goes to the heading on entering.
-->
<script lang="ts">
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import type { LoginFlow } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: LoginFlow; targets: SignInTargets; hidden?: boolean } = $props();
</script>

{#snippet text()}{m.login_done_text()}{/snippet}

<AuthResult
  docTitle={m.login_doc_title({ screen: m.login_done_title(), app: session.appName })}
  title={m.login_done_title()}
  themeToggle
  {hidden}
  reg={targets.reg}
  contentKey={flow.pwDoneEnded ? 'e' : ''}
  icon="ti-lock-check"
  {text}
  chips={flow.pwDoneEnded ? { items: [{ icon: 'ti-logout', text: m.login_done_ended() }], always: true } : undefined}
  primary={{ label: m.login_to_login(), icon: 'ti-arrow-right', onclick: () => flow.pwDoneLogin() }}
/>
