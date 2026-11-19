<!--
  Step 3: name and email address of the administrator.
-->
<script lang="ts">
  import FormField from '#lib/components/FormField.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type Look } from '#lib/setup-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Hints under the fields per level. */
  const DESK_HINT = [true, true, true, false, false, false, false];
  const MOB_HINT = [true, true, false, false];
</script>

{#snippet intro()}{m.setup_admin_intro()}{/snippet}

<SetupShell
  step={3}
  docTitle={m.setup_doc_title({ step: m.setup_step_admin() })}
  title={m.setup_admin_title()}
  {intro}
  desk={DESK_LEVELS}
  mob={MOB_LEVELS}
  contentKey={[!!flow.err.name, !!flow.err.email].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.submitAdmin()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const hint = (look.mobile ? MOB_HINT : DESK_HINT)[level] ?? false}
    <div class="fields" style:--f-hint={hint ? 'block' : 'none'}>
      <FormField
        id="su-name"
        bind:input={() => targets.input('name'), (el: HTMLInputElement | undefined) => targets.put('name', el)}
        label={m.setup_name_label()}
        icon="ti-user"
        type="text"
        name="name"
        autocomplete="name"
        maxlength={100}
        placeholder={m.setup_name_placeholder()}
        value={flow.name}
        oninput={(v: string) => flow.edit('name', v)}
        error={flow.err.name}
      />
      <FormField
        id="su-email"
        bind:input={() => targets.input('email'), (el: HTMLInputElement | undefined) => targets.put('email', el)}
        label={m.setup_email_label()}
        icon="ti-mail"
        type="email"
        inputmode="email"
        name="email"
        autocomplete="username"
        autocapitalize="none"
        spellcheck={false}
        placeholder={m.setup_email_placeholder()}
        value={flow.email}
        oninput={(v: string) => flow.edit('email', v)}
        error={flow.err.email}
        hint={m.setup_email_hint({ app: session.appName })}
      />
    </div>
  {/snippet}
</SetupShell>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }
</style>
