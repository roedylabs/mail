<!--
  Step 4: password and confirmation with the rule chips and the Caps Lock
  hint.
-->
<script lang="ts">
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { PW_RULES } from '#lib/password.ts';
  import { DESK_LEVELS, MOB_LEVELS } from '#lib/setup-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  let showPw = $state(false);
  let caps = $state(false);
  let pwFocus = $state(false);
  function onPwKey(event: KeyboardEvent) {
    caps = event.getModifierState('CapsLock');
  }

  /** A mouse click on "show" does not take the focus from the field. */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }
</script>

{#snippet intro()}
  {m.setup_pw_intro_before()}<strong class="who">{flow.email.trim()}</strong>{m.setup_pw_intro_after()}
{/snippet}

<SetupShell
  step={4}
  docTitle={m.setup_doc_title({ step: m.setup_step_password() })}
  title={m.setup_pw_title()}
  {intro}
  desk={DESK_LEVELS}
  mob={MOB_LEVELS}
  contentKey={[flow.err.pw === true ? 'rules' : !!flow.err.pw, !!flow.err.pw2].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.submitPw()}
  reg={targets.reg}
>
  {#snippet fields()}
    <div class="fields">
      <FormField
        id="su-pw"
        bind:input={() => targets.input('pw'), (el: HTMLInputElement | undefined) => targets.put('pw', el)}
        label={m.setup_pw_label()}
        icon="ti-lock"
        type={showPw ? 'text' : 'password'}
        name="new-password"
        autocomplete="new-password"
        placeholder={m.setup_pw_placeholder()}
        value={flow.pw}
        oninput={(v: string) => flow.edit('pw', v)}
        onkeydown={onPwKey}
        onkeyup={onPwKey}
        onfocus={() => (pwFocus = true)}
        onblur={() => {
          pwFocus = false;
          caps = false;
        }}
        error={flow.err.pw}
        describedby="su-pw-rules"
      >
        {#snippet trailing()}
          <button
            type="button"
            class="eye"
            onmousedown={keepFocus}
            onclick={() => (showPw = !showPw)}
            aria-label={showPw ? m.password_hide() : m.password_show()}
            title={showPw ? m.password_hide() : m.password_show()}
            aria-pressed={showPw ? 'true' : 'false'}
          >
            <Icon name={showPw ? 'ti-eye-off' : 'ti-eye'} />
          </button>
        {/snippet}
        {#if caps && pwFocus}
          <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
        {/if}
        <ul id="su-pw-rules" class="rules" aria-label={m.password_rules()}>
          {#each PW_RULES as rule (rule.id)}
            {@const ok = rule.test(flow.pw)}
            <li class="rule" class:ok class:bad={!ok && flow.err.pw === true}>
              <span class="rule-dot"><Icon name="ti-check" /></span>
              <span>{rule.label()}</span>
            </li>
          {/each}
        </ul>
      </FormField>
      <FormField
        id="su-pw2"
        bind:input={() => targets.input('pw2'), (el: HTMLInputElement | undefined) => targets.put('pw2', el)}
        label={m.setup_pw2_label()}
        icon="ti-lock-check"
        type={showPw ? 'text' : 'password'}
        name="confirm-password"
        autocomplete="new-password"
        placeholder={m.setup_pw2_placeholder()}
        value={flow.pw2}
        oninput={(v: string) => flow.edit('pw2', v)}
        error={flow.err.pw2}
      />
    </div>
  {/snippet}
</SetupShell>

<style>
  .who {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

  .eye {
    position: absolute;
    right: 8px;
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .eye:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .caps {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .rules {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  .rule {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px 0 5px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--mfg);
    font-size: 13px;
    font-weight: 700;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .rule.ok {
    color: var(--fg);
  }

  .rule.bad {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .rule-dot {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--bdhi);
    color: var(--accink);
    font-size: 13px;
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .rule-dot :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .rule.ok .rule-dot {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .rule.ok .rule-dot :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  .rule.bad .rule-dot {
    box-shadow: inset 0 0 0 1.5px var(--err);
  }
</style>
