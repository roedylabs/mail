<!--
  Hello: after a successful sign-in. One centred column at every width: the
  check tile on its rings, "Hello, ‹first name›", what "Stay signed in" chose
  as a chip (at every level), and a bar that fills once while the page
  redirects (`DONE_MS`: settings and account load after 2.7 s). "Back to
  sign-in" signs the new session out again (`LoginFlow.reset`). The focus
  goes to the heading on entering.
-->
<script lang="ts">
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import type { LoginFlow } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: LoginFlow; targets: SignInTargets; hidden?: boolean } = $props();

  /** The bar is full shortly before the redirect starts (`DONE_MS`). */
  const BAR_MS = 2600;
</script>

<AuthResult
  docTitle={m.login_doc_title({ screen: m.login_doc_hello(), app: session.appName })}
  title={m.login_hello({ name: flow.greetName })}
  themeToggle
  {hidden}
  reg={targets.reg}
  icon="ti-check"
  chips={{
    items: [
      flow.remember
        ? { icon: 'ti-device-desktop', text: m.login_hello_stay() }
        : { icon: 'ti-clock', text: m.login_hello_session() },
    ],
    always: true,
  }}
  progress={{ text: m.login_redirect({ app: session.appName }), ms: BAR_MS, width: 240 }}
  quiet={{ label: m.login_back(), icon: 'ti-arrow-left', onclick: () => flow.reset() }}
/>
