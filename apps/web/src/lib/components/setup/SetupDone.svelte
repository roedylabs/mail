<!--
  Done screen: one centred column at every width, all step bars filled. A
  tilted check tile on two soft rings, the welcome with the first name,
  what the setup did as chips (hidden at the denser levels), then the
  sign-in: a bar that fills once and "Signing you in …". Afterwards the
  page opens Administration › Mail servers.

  Removes all `roedy-setup-*` session keys once it has read the first name
  (the chosen look stays applied in memory).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import AuthResult from '#lib/components/auth/AuthResult.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { STEPS, clearSession, type SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  // Read once: the name stays in memory, the session keys go.
  const firstName = untrack(() => flow.firstName);
  onMount(() => clearSession());
</script>

{#snippet text()}{m.setup_done_text({ app: session.appName })}{/snippet}

<!-- The bar is full shortly before the sign-in starts (`DONE_MS`); the page moves the focus to the heading (`entered`) -->
<AuthResult
  docTitle={m.setup_doc_title({ step: m.setup_step_done() })}
  title={m.setup_done_title({ name: firstName })}
  bars={{ n: STEPS, total: STEPS, label: m.setup_complete() }}
  {hidden}
  reg={targets.reg}
  icon="ti-check"
  {text}
  chips={{
    label: m.setup_done_label(),
    items: [
      { icon: 'ti-user-shield', text: m.setup_done_admin() },
      { icon: 'ti-shield-check', text: m.setup_done_mfa() },
      { icon: 'ti-key', text: m.setup_done_token() },
    ],
  }}
  progress={{ text: m.setup_done_signing(), ms: 2600 }}
  focusHeading={false}
/>
