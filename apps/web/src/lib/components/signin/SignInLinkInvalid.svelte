<!--
  Link expired or invalid: "Save password" answered `422 invalid_token`
  (expired, used, replaced or unknown, without a difference), still on
  `/password/reset/‹token›`; the typed passwords are discarded. A dead end:
  the muted link-off tile on neutral rings, `role="alert"`. "Request a new
  link" opens "Reset password" with an empty field; "Back to sign-in" keeps
  the identifier. The focus goes to the heading on entering.
-->
<script lang="ts">
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import type { LoginFlow } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: LoginFlow; targets: SignInTargets; hidden?: boolean } = $props();
</script>

{#snippet text()}{m.login_link_bad_text()}{/snippet}

<AuthResult
  docTitle={m.login_doc_title({ screen: m.login_link_bad_title(), app: session.appName })}
  title={m.login_link_bad_title()}
  themeToggle
  {hidden}
  reg={targets.reg}
  tone="muted"
  icon="ti-link-off"
  role="alert"
  {text}
  primary={{ label: m.login_new_link(), icon: 'ti-send', onclick: () => flow.reqNewLink() }}
  quiet={{ label: m.login_back(), icon: 'ti-arrow-left', onclick: () => flow.backToLogin() }}
/>
